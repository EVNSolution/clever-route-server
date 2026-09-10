import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';

import { lockDsvDriverAccount } from './dsv-driver-account-lock.js';

export type DsvDriverPasswordResetLink = {
  expiresAt: Date;
  method: 'ADMIN_LINK';
  setupUrl: string;
};

export type DsvDriverPasswordResetService = {
  complete(input: { password: string; requestId: string; token: string }): Promise<void>;
  issueLink(input: { actorId: string | null; driverId: string; requestId: string; shopId: string }): Promise<DsvDriverPasswordResetLink | null>;
  validateLink(input: { token: string }): Promise<{ expiresAt: Date; method: 'ADMIN_LINK' } | null>;
};

const linkTtlMs = 30 * 60 * 1000;
const issueWindowMs = 15 * 60 * 1000;
const maxIssuesPerWindow = 3;
const minPasswordCharacters = 12;

export class PrismaDsvDriverPasswordResetService implements DsvDriverPasswordResetService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly options: {
      now?: () => Date;
      token?: () => string;
      webPublicOrigin: string;
    },
  ) {}

  async issueLink(input: { actorId: string | null; driverId: string; requestId: string; shopId: string }): Promise<DsvDriverPasswordResetLink | null> {
    const driver = await this.prisma.driver.findFirst({
      select: { accountId: true },
      where: {
        accountId: { not: null },
        dsvProfile: { isNot: null },
        id: input.driverId,
        shopId: input.shopId,
        status: 'ACTIVE',
      },
    });
    if (driver?.accountId === null || driver?.accountId === undefined) return null;
    const accountId = driver.accountId;

    const token = this.options.token?.() ?? randomBytes(32).toString('base64url');
    const tokenHash = hashToken(token);
    const now = this.now();
    const expiresAt = new Date(now.getTime() + linkTtlMs);
    const issued = await this.prisma.$transaction(async (tx) => {
      await lockDsvDriverAccount(tx, accountId);
      const account = await tx.driverAccount.findFirst({
        select: { id: true },
        where: {
          id: accountId,
          passwordHash: { not: null },
          passwordSalt: { not: null },
          status: 'ACTIVE',
          drivers: {
            some: {
              dsvProfile: { isNot: null },
              id: input.driverId,
              shopId: input.shopId,
              status: 'ACTIVE',
            },
          },
        },
      });
      if (account === null) return false;

      const recentIssueCount = await tx.driverAccountPasswordResetLink.count({
        where: {
          accountId: account.id,
          createdAt: { gte: new Date(now.getTime() - issueWindowMs) },
        },
      });
      if (recentIssueCount >= maxIssuesPerWindow) {
        throw new DsvDriverPasswordResetError('RATE_LIMITED', 'Too many password reset links were issued');
      }

      await tx.driverAccountPasswordResetLink.updateMany({
        data: { revokedAt: now },
        where: { accountId: account.id, consumedAt: null, revokedAt: null },
      });
      await tx.driverAccountPasswordResetLink.create({
        data: {
          accountId: account.id,
          createdBy: input.actorId,
          createdAt: now,
          expiresAt,
          shopId: input.shopId,
          tokenHash,
        },
      });
      await createAudit(tx, {
        accountId: account.id,
        actorId: input.actorId,
        eventType: 'DRIVER_ACCOUNT_PASSWORD_RESET_LINK_ISSUED',
        principalType: 'DSV_ADMIN',
        requestId: input.requestId,
        shopId: input.shopId,
      });
      return true;
    });
    if (!issued) return null;

    const setupUrl = new URL('/driver/password-reset', this.options.webPublicOrigin);
    setupUrl.hash = `token=${encodeURIComponent(token)}`;
    return { expiresAt, method: 'ADMIN_LINK', setupUrl: setupUrl.toString() };
  }

  async validateLink(input: { token: string }): Promise<{ expiresAt: Date; method: 'ADMIN_LINK' } | null> {
    const token = normalizeToken(input.token);
    if (token === null) return null;
    const link = await this.prisma.driverAccountPasswordResetLink.findUnique({
      include: { account: { select: { passwordHash: true, passwordSalt: true, status: true } } },
      where: { tokenHash: hashToken(token) },
    });
    const now = this.now();
    return link !== null
      && link.consumedAt === null
      && link.revokedAt === null
      && link.expiresAt.getTime() > now.getTime()
      && link.account.status === 'ACTIVE'
      && link.account.passwordHash !== null
      && link.account.passwordSalt !== null
      ? { expiresAt: link.expiresAt, method: 'ADMIN_LINK' }
      : null;
  }

  async complete(input: { password: string; requestId: string; token: string }): Promise<void> {
    if (!isStrongPassword(input.password)) {
      throw new DsvDriverPasswordResetError('WEAK_PASSWORD', 'Password does not meet strength requirements');
    }
    const token = normalizeToken(input.token);
    if (token === null) throw invalidTokenError();
    const tokenHash = hashToken(token);
    const candidate = await this.prisma.driverAccountPasswordResetLink.findUnique({
      select: { accountId: true },
      where: { tokenHash },
    });
    if (candidate === null) throw invalidTokenError();

    const passwordSalt = randomBytes(16).toString('base64url');
    const passwordHash = await hashPassword(input.password, passwordSalt);
    await this.prisma.$transaction(async (tx) => {
      await lockDsvDriverAccount(tx, candidate.accountId);
      const now = this.now();
      const link = await tx.driverAccountPasswordResetLink.findUnique({
        include: { account: true },
        where: { tokenHash },
      });
      if (
        link === null
        || link.accountId !== candidate.accountId
        || link.consumedAt !== null
        || link.revokedAt !== null
        || link.expiresAt.getTime() <= now.getTime()
        || link.account.status !== 'ACTIVE'
        || link.account.passwordHash === null
        || link.account.passwordSalt === null
      ) {
        throw invalidTokenError();
      }
      if (await verifyPassword(input.password, link.account.passwordSalt, link.account.passwordHash)) {
        throw new DsvDriverPasswordResetError('PASSWORD_REUSED', 'The current password cannot be reused');
      }

      const consumed = await tx.driverAccountPasswordResetLink.updateMany({
        data: { consumedAt: now },
        where: {
          consumedAt: null,
          expiresAt: { gt: now },
          id: link.id,
          revokedAt: null,
        },
      });
      if (consumed.count !== 1) throw invalidTokenError();

      await tx.driverAccount.update({
        data: {
          failedPasswordAttempts: 0,
          passwordHash,
          passwordLockedUntil: null,
          passwordSalt,
          tokenVersion: { increment: 1 },
        },
        where: { id: link.accountId },
      });
      const linkedDrivers = await tx.driver.findMany({
        select: { id: true },
        where: { accountId: link.accountId },
      });
      const linkedDriverIds = linkedDrivers.map(({ id }) => id);
      await tx.driverAccountSession.updateMany({
        data: { revokedAt: now },
        where: { accountId: link.accountId, revokedAt: null },
      });
      if (linkedDriverIds.length > 0) {
        await tx.driver.updateMany({
          data: { tokenVersion: { increment: 1 }, tokensInvalidatedAt: now },
          where: { id: { in: linkedDriverIds } },
        });
        await tx.driverSession.updateMany({
          data: { revokedAt: now },
          where: { driverId: { in: linkedDriverIds }, revokedAt: null },
        });
      }
      await createAudit(tx, {
        accountId: link.accountId,
        actorId: null,
        eventType: 'DRIVER_ACCOUNT_PASSWORD_RESET_COMPLETED',
        principalType: 'DRIVER',
        requestId: input.requestId,
        shopId: link.shopId,
      });
    });
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

export class DsvDriverPasswordResetError extends Error {
  constructor(
    readonly code: 'INVALID_TOKEN' | 'PASSWORD_REUSED' | 'RATE_LIMITED' | 'WEAK_PASSWORD',
    message: string,
  ) {
    super(message);
    this.name = 'DsvDriverPasswordResetError';
  }
}

async function createAudit(
  tx: Pick<Prisma.TransactionClient, 'dsvAuditEvent'>,
  input: {
    accountId: string;
    actorId: string | null;
    eventType: string;
    principalType: 'DRIVER' | 'DSV_ADMIN';
    requestId: string;
    shopId: string;
  },
): Promise<void> {
  await tx.dsvAuditEvent.create({
    data: {
      actorId: input.actorId,
      actorType: input.principalType === 'DSV_ADMIN' ? 'DSV_ADMIN' : 'PASSWORD_RESET_LINK',
      entityId: input.accountId,
      entityType: 'DRIVER_ACCOUNT',
      eventType: input.eventType,
      principalType: input.principalType,
      redactedDiff: { method: 'ADMIN_LINK' },
      redactionClass: 'PII_REDACTED',
      requestId: input.requestId,
      shopId: input.shopId,
    },
  });
}

function normalizeToken(value: string): string | null {
  const normalized = value.trim();
  return /^[A-Za-z0-9_-]{43}$/u.test(normalized) ? normalized : null;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function isStrongPassword(value: string): boolean {
  return value.length >= minPasswordCharacters
    && value.length <= 128
    && /[a-z]/u.test(value)
    && /[A-Z]/u.test(value)
    && /\d/u.test(value)
    && /[^A-Za-z0-9]/u.test(value);
}

function hashPassword(password: string, salt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey.toString('base64url'));
    });
  });
}

async function verifyPassword(password: string, salt: string, expectedHash: string): Promise<boolean> {
  const actual = Buffer.from(await hashPassword(password, salt), 'base64url');
  const expected = Buffer.from(expectedHash, 'base64url');
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

function invalidTokenError(): DsvDriverPasswordResetError {
  return new DsvDriverPasswordResetError('INVALID_TOKEN', 'Password reset link is invalid or expired');
}
