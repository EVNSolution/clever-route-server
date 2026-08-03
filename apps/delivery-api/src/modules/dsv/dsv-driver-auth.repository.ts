import {
  createHash,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';

import {
  fingerprintResidentNumberFront,
  normalizeDsvDriverLoginId,
  normalizeDsvDriverPhone,
} from './dsv-driver-identity.js';

export type DsvDriverAccountView = {
  connectionStatus: 'LINKED' | 'UNLINKED';
  id: string;
  linkedDrivers: Array<{
    driverId: string;
    name: string;
    shopDomain: string;
  }>;
  loginId: string;
  name: string;
  phone: string;
};

export type DsvDriverAuthSession = {
  account: DsvDriverAccountView;
  accountId: string;
  expiresAt: Date;
  refreshToken: string;
  tokenVersion: number;
};

export type DsvDriverRegistrationInput = {
  loginId: string;
  name: string;
  password: string;
  phone: string;
  residentNumberFront: string;
};

export type DsvDriverLoginInput = {
  loginId: string;
  password: string;
};

export type DsvDriverRefreshInput = {
  refreshToken: string;
};

export type DsvDriverAuthRepository = {
  login(input: DsvDriverLoginInput): Promise<DsvDriverAuthSession>;
  refresh(input: DsvDriverRefreshInput): Promise<DsvDriverAuthSession>;
  register(input: DsvDriverRegistrationInput): Promise<DsvDriverAuthSession>;
};

export class DsvDriverAuthConflictError extends Error {
  constructor() {
    super('An account already exists for this login ID or phone number');
    this.name = 'DsvDriverAuthConflictError';
  }
}

export class DsvDriverAuthCredentialsError extends Error {
  constructor() {
    super('Invalid login ID or password');
    this.name = 'DsvDriverAuthCredentialsError';
  }
}

export class DsvDriverAuthRefreshError extends Error {
  constructor() {
    super('Invalid or expired refresh token');
    this.name = 'DsvDriverAuthRefreshError';
  }
}

const MAX_FAILED_PASSWORD_ATTEMPTS = 5;
const PASSWORD_LOCK_MINUTES = 15;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DUMMY_PASSWORD_SALT = 'dsv-driver-account-missing';
const DUMMY_PASSWORD_HASH = 'CCrdwgxar5IhXbGpEZ_vYVcgujFSmiPgteYGuwjpGvDcRz9GD8gODaO3FeXnVwd-C0xvnFNf1NVmbU7DEdXPWA';

type AccountWithDrivers = Prisma.DriverAccountGetPayload<{
  include: {
    drivers: {
      include: { shop: { select: { shopDomain: true } } };
    };
  };
}>;

type LinkedDriverRecord = {
  displayName: string;
  id: string;
  phone: string | null;
  shop: { shopDomain: string };
};

export class PrismaDsvDriverAuthRepository implements DsvDriverAuthRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly identityFingerprintSecret: string,
  ) {}

  async register(input: DsvDriverRegistrationInput): Promise<DsvDriverAuthSession> {
    const loginId = normalizeDsvDriverLoginId(input.loginId);
    const name = input.name.trim();
    const phone = normalizeDsvDriverPhone(input.phone);
    const residentNumberFrontFingerprint = fingerprintResidentNumberFront(
      input.residentNumberFront,
      this.identityFingerprintSecret,
    );
    const passwordSalt = randomBytes(16).toString('base64url');
    const passwordHash = await hashPassword(input.password, passwordSalt);
    const refreshToken = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

    try {
      return await this.prisma.$transaction(async (transaction) => {
        const account = await transaction.driverAccount.create({
          data: {
            loginId,
            name,
            passwordHash,
            passwordSalt,
            phone,
            residentNumberFrontFingerprint,
          },
        });
        const candidates = (await transaction.driver.findMany({
          include: { shop: { select: { shopDomain: true } } },
          where: {
            accountId: null,
            displayName: name,
            dsvProfile: { is: { residentNumberFrontFingerprint } },
            status: 'ACTIVE',
          },
        })).filter((candidate) => normalizeDsvDriverPhone(candidate.phone ?? '') === phone);
        const linkedDrivers: LinkedDriverRecord[] = [];
        for (const candidate of candidates) {
          const linked = await transaction.driver.updateMany({
            data: {
              accountId: account.id,
              authSubject: `driver-${candidate.id}`,
              inviteCode: null,
              inviteCodeExpiresAt: null,
            },
            where: { accountId: null, id: candidate.id },
          });
          if (linked.count === 1) linkedDrivers.push(candidate);
        }
        await transaction.driverAccountSession.create({
          data: {
            accountId: account.id,
            expiresAt,
            refreshTokenHash: hashRefreshToken(refreshToken),
          },
        });
        return {
          account: accountView(account, linkedDrivers),
          accountId: account.id,
          expiresAt,
          refreshToken,
          tokenVersion: account.tokenVersion,
        };
      });
    } catch (error) {
      if (isUniqueConflict(error)) throw new DsvDriverAuthConflictError();
      throw error;
    }
  }

  async login(input: DsvDriverLoginInput): Promise<DsvDriverAuthSession> {
    const loginId = normalizeDsvDriverLoginId(input.loginId);
    const now = new Date();
    const account = await this.prisma.driverAccount.findUnique({
      include: {
        drivers: {
          include: { shop: { select: { shopDomain: true } } },
          where: { dsvProfile: { isNot: null }, status: 'ACTIVE' },
        },
      },
      where: { loginId },
    });
    const passwordMatches = account?.passwordHash === null
      || account?.passwordHash === undefined
      || account.passwordSalt === null
      || account.passwordSalt === undefined
      ? await verifyPassword(input.password, DUMMY_PASSWORD_SALT, DUMMY_PASSWORD_HASH)
      : await verifyPassword(input.password, account.passwordSalt, account.passwordHash);
    const isLocked = account?.passwordLockedUntil instanceof Date
      && account.passwordLockedUntil.getTime() > now.getTime();

    if (account === null || account.status !== 'ACTIVE' || isLocked || !passwordMatches) {
      if (account !== null && account.status === 'ACTIVE' && !isLocked && !passwordMatches) {
        const failedAttempt = await this.prisma.driverAccount.update({
          data: { failedPasswordAttempts: { increment: 1 } },
          select: { failedPasswordAttempts: true },
          where: { id: account.id },
        });
        if (failedAttempt.failedPasswordAttempts >= MAX_FAILED_PASSWORD_ATTEMPTS) {
          await this.prisma.driverAccount.update({
            data: { passwordLockedUntil: new Date(now.getTime() + PASSWORD_LOCK_MINUTES * 60 * 1000) },
            where: { id: account.id },
          });
        }
      }
      throw new DsvDriverAuthCredentialsError();
    }

    await this.prisma.driverAccount.update({
      data: { failedPasswordAttempts: 0, passwordLockedUntil: null },
      where: { id: account.id },
    });
    return this.createSession(await this.linkMatchingDrivers(account));
  }

  async refresh(input: DsvDriverRefreshInput): Promise<DsvDriverAuthSession> {
    const refreshToken = input.refreshToken.trim();
    if (refreshToken.length === 0) throw new DsvDriverAuthRefreshError();

    const now = new Date();
    const session = await this.prisma.driverAccountSession.findUnique({
      include: {
        account: {
          include: {
            drivers: {
              include: { shop: { select: { shopDomain: true } } },
              where: { dsvProfile: { isNot: null }, status: 'ACTIVE' },
            },
          },
        },
      },
      where: { refreshTokenHash: hashRefreshToken(refreshToken) },
    });
    if (
      session === null
      || session.revokedAt !== null
      || session.expiresAt.getTime() <= now.getTime()
      || session.account.status !== 'ACTIVE'
    ) {
      throw new DsvDriverAuthRefreshError();
    }

    await this.prisma.driverAccountSession.update({
      data: { lastUsedAt: now },
      where: { id: session.id },
    });
    return {
      account: accountView(session.account, session.account.drivers),
      accountId: session.account.id,
      expiresAt: session.expiresAt,
      refreshToken,
      tokenVersion: session.account.tokenVersion,
    };
  }

  private async linkMatchingDrivers(account: AccountWithDrivers): Promise<AccountWithDrivers> {
    if (account.name === null || account.residentNumberFrontFingerprint === null) return account;
    const candidates = (await this.prisma.driver.findMany({
      select: { id: true, phone: true },
      where: {
        accountId: null,
        displayName: account.name,
        dsvProfile: { is: { residentNumberFrontFingerprint: account.residentNumberFrontFingerprint } },
        status: 'ACTIVE',
      },
    })).filter((candidate) => (
      normalizeDsvDriverPhone(candidate.phone ?? '') === normalizeDsvDriverPhone(account.phone)
    ));
    if (candidates.length === 0) return account;
    for (const candidate of candidates) {
      await this.prisma.driver.updateMany({
        data: {
          accountId: account.id,
          authSubject: `driver-${candidate.id}`,
          inviteCode: null,
          inviteCodeExpiresAt: null,
        },
        where: { accountId: null, id: candidate.id },
      });
    }
    return this.prisma.driverAccount.findUniqueOrThrow({
      include: {
        drivers: {
          include: { shop: { select: { shopDomain: true } } },
          where: { dsvProfile: { isNot: null }, status: 'ACTIVE' },
        },
      },
      where: { id: account.id },
    });
  }

  private async createSession(account: AccountWithDrivers): Promise<DsvDriverAuthSession> {
    const refreshToken = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await this.prisma.driverAccountSession.create({
      data: {
        accountId: account.id,
        expiresAt,
        refreshTokenHash: hashRefreshToken(refreshToken),
      },
    });
    return {
      account: accountView(account, account.drivers),
      accountId: account.id,
      expiresAt,
      refreshToken,
      tokenVersion: account.tokenVersion,
    };
  }
}

function accountView(
  account: {
    id: string;
    loginId: string | null;
    name: string | null;
    phone: string;
  },
  drivers: LinkedDriverRecord[],
): DsvDriverAccountView {
  if (account.loginId === null || account.name === null) {
    throw new Error('DSV driver account identity is incomplete');
  }
  const linkedDrivers = drivers.map((driver) => ({
    driverId: driver.id,
    name: driver.displayName,
    shopDomain: driver.shop.shopDomain,
  }));
  return {
    connectionStatus: linkedDrivers.length > 0 ? 'LINKED' : 'UNLINKED',
    id: account.id,
    linkedDrivers,
    loginId: account.loginId,
    name: account.name,
    phone: account.phone,
  };
}

function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
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
  const actualHash = await hashPassword(password, salt);
  const actual = Buffer.from(actualHash, 'base64url');
  const expected = Buffer.from(expectedHash, 'base64url');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function isUniqueConflict(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
