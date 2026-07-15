import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';

export type DriverAuthPrismaClient = Pick<
  PrismaClient,
  'driver' | 'driverAccount' | 'driverAccountSession' | 'driverSession' | '$transaction'
>;
type DriverInviteRecord = Prisma.DriverGetPayload<{ include: { shop: { select: { shopDomain: true } } } }>;
type DriverRefreshSessionRecord = Prisma.DriverSessionGetPayload<{
  include: { driver: { include: { shop: { select: { shopDomain: true } } } } };
}>;
type DriverAccountRefreshSessionRecord = Prisma.DriverAccountSessionGetPayload<{
  include: { account: true };
}>;

export type VerifyInviteInput = {
  displayName?: string | null;
  phone: string;
  inviteCode: string;
  pin: string;
};

export type LoginWithPinInput = {
  phone: string;
  pin: string;
};

export type RefreshSessionInput = {
  refreshToken: string;
};

export type DriverAccountProfile = {
  name: string | null;
  phone: string;
};

export type DriverAccountProfileScope = {
  accountId: string;
  tokenVersion: number;
};

export type UpdateDriverAccountProfileInput = DriverAccountProfileScope & {
  name: string;
};

export type DriverSessionInfo = {
  driverId: string;
  shopDomain: string;
  refreshToken: string;
  expiresAt: Date;
  kind: 'driver';
  tokenVersion: number;
};

export type DriverAccountSessionInfo = {
  accountId: string;
  refreshToken: string;
  expiresAt: Date;
  kind: 'account';
  tokenVersion: number;
};

export type DriverAuthSessionInfo = DriverAccountSessionInfo | DriverSessionInfo;

const MAX_FAILED_PIN_ATTEMPTS = 5;
const PIN_LOCK_MINUTES = 15;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PIN_PATTERN = /^\d{6}$/u;
const DUMMY_PIN_SALT = 'driver-account-missing';
const DUMMY_PIN_HASH = 'CCrdwgxar5IhXbGpEZ_vYVcgujFSmiPgteYGuwjpGvDcRz9GD8gODaO3FeXnVwd-C0xvnFNf1NVmbU7DEdXPWA';

export class PrismaDriverAuthRepository {
  constructor(private readonly prisma: DriverAuthPrismaClient) {}

  async getAccountProfile(input: DriverAccountProfileScope): Promise<DriverAccountProfile | null> {
    return this.prisma.driverAccount.findFirst({
      select: { name: true, phone: true },
      where: { id: input.accountId, status: 'ACTIVE', tokenVersion: input.tokenVersion }
    });
  }

  async updateAccountProfile(input: UpdateDriverAccountProfileInput): Promise<DriverAccountProfile | null> {
    const updated = await this.prisma.driverAccount.updateMany({
      data: { name: input.name },
      where: { id: input.accountId, status: 'ACTIVE', tokenVersion: input.tokenVersion }
    });
    return updated.count === 1 ? this.getAccountProfile(input) : null;
  }

  async refreshSession(input: RefreshSessionInput): Promise<DriverAuthSessionInfo> {
    const refreshToken = input.refreshToken.trim();
    if (refreshToken.length === 0) {
      throw new Error('Invalid refresh token');
    }

    const refreshTokenHash = hashRefreshToken(refreshToken);
    const accountSession = await this.prisma.driverAccountSession.findUnique({
      where: { refreshTokenHash },
      include: { account: true }
    });
    if (isAccountRefreshSessionUsable(accountSession, new Date())) {
      await this.prisma.driverAccountSession.update({
        where: { id: accountSession.id },
        data: { lastUsedAt: new Date() }
      });
      return {
        accountId: accountSession.account.id,
        expiresAt: accountSession.expiresAt,
        kind: 'account',
        refreshToken,
        tokenVersion: accountSession.account.tokenVersion
      };
    }

    const session = await this.prisma.driverSession.findUnique({
      where: { refreshTokenHash },
      include: { driver: { include: { shop: { select: { shopDomain: true } } } } }
    });
    if (!isDriverRefreshSessionUsable(session, new Date())) {
      throw new Error('Invalid or expired refresh token');
    }

    await this.prisma.driverSession.update({
      where: { id: session.id },
      data: { lastUsedAt: new Date() }
    });
    return {
      driverId: session.driver.id,
      expiresAt: session.expiresAt,
      kind: 'driver',
      refreshToken,
      shopDomain: session.driver.shop.shopDomain,
      tokenVersion: session.driver.tokenVersion
    };
  }

  async loginWithPin(input: LoginWithPinInput): Promise<DriverAccountSessionInfo> {
    const now = new Date();
    const account = await this.prisma.driverAccount.findUnique({ where: { phone: input.phone } });
    const pinMatches = account === null
      ? await verifyPin(input.pin, DUMMY_PIN_SALT, DUMMY_PIN_HASH)
      : await verifyPin(input.pin, account.pinSalt, account.pinHash);
    const isLocked = account?.pinLockedUntil instanceof Date && account.pinLockedUntil.getTime() > now.getTime();

    if (
      account === null ||
      account.status !== 'ACTIVE' ||
      isLocked ||
      !pinMatches
    ) {
      if (account !== null && account.status === 'ACTIVE' && !isLocked && !pinMatches) {
        const failedAttempt = await this.prisma.driverAccount.update({
          where: { id: account.id },
          data: { failedPinAttempts: { increment: 1 } },
          select: { failedPinAttempts: true }
        });
        if (failedAttempt.failedPinAttempts >= MAX_FAILED_PIN_ATTEMPTS) {
          await this.prisma.driverAccount.update({
            where: { id: account.id },
            data: { pinLockedUntil: new Date(now.getTime() + PIN_LOCK_MINUTES * 60 * 1000) }
          });
        }
      }
      throw new Error('Invalid phone or PIN');
    }

    await this.prisma.driverAccount.update({
      where: { id: account.id },
      data: { failedPinAttempts: 0, pinLockedUntil: null }
    });
    return this.createAccountSession(account.id, account.tokenVersion);
  }

  async verifyInvite(input: VerifyInviteInput): Promise<DriverAccountSessionInfo> {
    const now = new Date();
    const driver = await this.findInvite(input, now);
    if (!driver) {
      throw new Error('Invalid or expired invite code');
    }
    if (!PIN_PATTERN.test(input.pin)) {
      throw new Error('PIN must be exactly 6 digits');
    }

    const existingAccount = await this.prisma.driverAccount.findUnique({ where: { phone: input.phone } });
    if (existingAccount !== null) {
      throw new Error('Driver account is already registered');
    }

    const pinSalt = randomBytes(16).toString('base64url');
    const pinHash = await hashPin(input.pin, pinSalt);
    const displayName = normalizeDisplayName(input.displayName);
    const account = await this.prisma.$transaction(async (transaction) => {
      const created = await transaction.driverAccount.create({
        data: { phone: input.phone, pinHash, pinSalt }
      });
      const drivers = await transaction.driver.findMany({
        select: { id: true },
        where: { phone: input.phone, status: 'ACTIVE' }
      });
      await Promise.all(drivers.map((candidate) => transaction.driver.update({
        where: { id: candidate.id },
        data: {
          accountId: created.id,
          authSubject: `driver-${candidate.id}`,
          inviteCode: null,
          inviteCodeExpiresAt: null,
          phone: input.phone,
          ...(candidate.id === driver.id && displayName !== null ? { displayName } : {})
        }
      })));
      return created;
    });

    return this.createAccountSession(account.id, account.tokenVersion);
  }

  private async createAccountSession(accountId: string, tokenVersion: number): Promise<DriverAccountSessionInfo> {
    const refreshToken = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await this.prisma.driverAccountSession.create({
      data: {
        accountId,
        expiresAt,
        refreshTokenHash: hashRefreshToken(refreshToken)
      }
    });
    return { accountId, expiresAt, kind: 'account', refreshToken, tokenVersion };
  }

  private async findInvite(input: VerifyInviteInput, now: Date): Promise<DriverInviteRecord | null> {
    return await this.prisma.driver.findFirst({
      where: {
        phone: input.phone,
        inviteCode: input.inviteCode,
        status: 'ACTIVE',
        inviteCodeExpiresAt: { gt: now }
      },
      include: { shop: { select: { shopDomain: true } } }
    }) ?? this.findLegacyPhoneInvite(input, now);
  }

  private async findLegacyPhoneInvite(input: VerifyInviteInput, now: Date): Promise<DriverInviteRecord | null> {
    const canonicalInputPhone = normalizeLegacyDriverPhone(input.phone);
    if (canonicalInputPhone === null) return null;

    const candidates = await this.prisma.driver.findMany({
      where: {
        inviteCode: input.inviteCode,
        status: 'ACTIVE',
        inviteCodeExpiresAt: { gt: now }
      },
      include: { shop: { select: { shopDomain: true } } }
    });
    return candidates.find((candidate) => normalizeLegacyDriverPhone(candidate.phone) === canonicalInputPhone) ?? null;
  }
}

function isAccountRefreshSessionUsable(
  session: DriverAccountRefreshSessionRecord | null,
  now: Date
): session is DriverAccountRefreshSessionRecord {
  return session !== null &&
    session.revokedAt === null &&
    session.expiresAt.getTime() > now.getTime() &&
    session.account.status === 'ACTIVE';
}

function isDriverRefreshSessionUsable(
  session: DriverRefreshSessionRecord | null,
  now: Date
): session is DriverRefreshSessionRecord {
  return session !== null &&
    session.revokedAt === null &&
    session.expiresAt.getTime() > now.getTime() &&
    session.driver.status === 'ACTIVE';
}

function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function hashPin(pin: string, salt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    scrypt(pin, salt, 64, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey.toString('base64url'));
    });
  });
}

async function verifyPin(pin: string, salt: string, expectedHash: string): Promise<boolean> {
  const actual = Buffer.from(await hashPin(pin, salt), 'base64url');
  const expected = Buffer.from(expectedHash, 'base64url');
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

function normalizeDisplayName(displayName: string | null | undefined): string | null {
  if (typeof displayName !== 'string') return null;
  const normalizedDisplayName = displayName.trim();
  return normalizedDisplayName.length === 0 ? null : normalizedDisplayName;
}

function normalizeLegacyDriverPhone(phone: string | null | undefined): string | null {
  if (typeof phone !== 'string') return null;
  const trimmed = phone.trim();
  if (/^\+[1-9]\d{7,14}$/u.test(trimmed)) return trimmed;

  const digits = trimmed.replace(/\D/gu, '');
  if (digits.length === 0) return null;
  if (/^00[1-9]\d{7,14}$/u.test(digits)) return `+${digits.slice(2)}`;
  if (/^1[2-9]\d{9}$/u.test(digits)) return `+${digits}`;
  if (/^[2-9]\d{9}$/u.test(digits)) return `+1${digits}`;
  if (/^8210\d{8}$/u.test(digits)) return `+${digits}`;
  if (/^010\d{8}$/u.test(digits)) return `+82${digits.slice(1)}`;
  return null;
}
