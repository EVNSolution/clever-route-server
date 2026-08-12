import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

import {
  dsvAdminScopes,
  dsvOperatorScopes,
  normalizeDsvScopes,
  type DsvScope,
} from './dsv-principal.js';

export type DsvAdminAccountPrismaClient = Pick<PrismaClient, 'dsvAdminAccount'>;

export type DsvAdminAccountIdentity = {
  accountId: string;
  displayName?: string;
  scopes: readonly DsvScope[];
  tokenVersion: number;
};

export type DsvAdminAccountAuthenticator = {
  authenticate(input: { loginId: string; password: string }): Promise<DsvAdminAccountIdentity | null>;
  invalidateSession(input: { accountId: string; tokenVersion: number }): Promise<void>;
  resolveSession(input: { accountId: string; tokenVersion: number }): Promise<DsvAdminAccountIdentity | null>;
};

export type DsvAdminAccountStatus = 'ACTIVE' | 'DISABLED';

export type DsvAdminAccountSummary = {
  createdAt: Date;
  displayName: string | null;
  failedLoginAttempts: number;
  id: string;
  lastAuthenticatedAt: Date | null;
  lockedUntil: Date | null;
  loginId: string;
  scopes: readonly DsvScope[];
  status: DsvAdminAccountStatus;
  updatedAt: Date;
};

export type DsvAdminAccountManager = {
  create(input: { displayName?: string; loginId: string }): Promise<{ account: DsvAdminAccountSummary; temporaryPassword: string }>;
  delete(input: { accountId: string }): Promise<void>;
  list(): Promise<DsvAdminAccountSummary[]>;
  resetPassword(input: { accountId: string }): Promise<{ account: DsvAdminAccountSummary; temporaryPassword: string }>;
  setStatus(input: { accountId: string; status: DsvAdminAccountStatus }): Promise<DsvAdminAccountSummary>;
};

export class DsvAdminAccountManagementError extends Error {
  constructor(
    readonly code: 'ADMIN_ACCOUNT_DELETE_REQUIRES_DISABLED' | 'ADMIN_ACCOUNT_LOGIN_ID_EXISTS' | 'ADMIN_ACCOUNT_NOT_FOUND',
  ) {
    super(code);
    this.name = 'DsvAdminAccountManagementError';
  }
}

export type BootstrapDsvAdminAccountInput = {
  displayName?: string;
  loginId: string;
  password: string;
  resetExisting?: boolean;
};

const MAX_FAILED_LOGIN_ATTEMPTS = 5;
const LOGIN_LOCK_MINUTES = 15;
const MIN_PASSWORD_BYTES = 12;
const DUMMY_PASSWORD_SALT = 'dsv-admin-account-missing';
const DUMMY_PASSWORD_HASH = 'fctD1mMtIPLH2KO09Wl6iVCExhzIHvfJS7L3nbm4Z5DKcnH24ZylNUQOqrwy__cgKsNaBiA7-QWvE7N0lJQfDw';

export class PrismaDsvAdminAccountRepository implements DsvAdminAccountAuthenticator, DsvAdminAccountManager {
  constructor(private readonly prisma: DsvAdminAccountPrismaClient) {}

  async authenticate(input: { loginId: string; password: string }): Promise<DsvAdminAccountIdentity | null> {
    const loginId = normalizeLoginId(input.loginId);
    const account = loginId === null
      ? null
      : await this.prisma.dsvAdminAccount.findUnique({ where: { loginId } });
    const passwordMatches = account === null
      ? await verifyPassword(input.password, DUMMY_PASSWORD_SALT, DUMMY_PASSWORD_HASH)
      : await verifyPassword(input.password, account.passwordSalt, account.passwordHash);
    const now = new Date();
    const isLocked = account?.lockedUntil instanceof Date && account.lockedUntil.getTime() > now.getTime();

    if (account === null || account.status !== 'ACTIVE' || isLocked || !passwordMatches) {
      if (account !== null && account.status === 'ACTIVE' && !isLocked && !passwordMatches) {
        const failedAttempt = await this.prisma.dsvAdminAccount.update({
          data: { failedLoginAttempts: { increment: 1 } },
          select: { failedLoginAttempts: true },
          where: { id: account.id },
        });
        if (failedAttempt.failedLoginAttempts >= MAX_FAILED_LOGIN_ATTEMPTS) {
          await this.prisma.dsvAdminAccount.update({
            data: { lockedUntil: new Date(now.getTime() + LOGIN_LOCK_MINUTES * 60 * 1000) },
            where: { id: account.id },
          });
        }
      }
      return null;
    }

    const scopes = normalizeDsvScopes(account.scopes);
    if (scopes === null || !scopes.includes('dsv:session:read')) return null;

    const updated = await this.prisma.dsvAdminAccount.update({
      data: {
        failedLoginAttempts: 0,
        lastAuthenticatedAt: now,
        lockedUntil: null,
        tokenVersion: { increment: 1 },
      },
      where: { id: account.id },
    });
    return identity(updated, scopes);
  }

  async invalidateSession(input: { accountId: string; tokenVersion: number }): Promise<void> {
    await this.prisma.dsvAdminAccount.updateMany({
      data: { tokenVersion: { increment: 1 } },
      where: {
        id: input.accountId,
        status: 'ACTIVE',
        tokenVersion: input.tokenVersion,
      },
    });
  }

  async resolveSession(input: { accountId: string; tokenVersion: number }): Promise<DsvAdminAccountIdentity | null> {
    const account = await this.prisma.dsvAdminAccount.findFirst({
      where: {
        id: input.accountId,
        status: 'ACTIVE',
        tokenVersion: input.tokenVersion,
      },
    });
    if (account === null) return null;
    const scopes = normalizeDsvScopes(account.scopes);
    return scopes === null || !scopes.includes('dsv:session:read') ? null : identity(account, scopes);
  }

  async bootstrap(input: BootstrapDsvAdminAccountInput): Promise<{ accountId: string; created: boolean; reset: boolean }> {
    const loginId = normalizeLoginId(input.loginId);
    if (loginId === null) throw new Error('DSV admin login ID is required');
    if (Buffer.byteLength(input.password, 'utf8') < MIN_PASSWORD_BYTES) {
      throw new Error(`DSV admin password must be at least ${MIN_PASSWORD_BYTES} bytes`);
    }
    const displayName = normalizeDisplayName(input.displayName);
    const existing = await this.prisma.dsvAdminAccount.findUnique({
      select: { id: true },
      where: { loginId },
    });
    if (existing !== null && input.resetExisting !== true) {
      return { accountId: existing.id, created: false, reset: false };
    }

    const passwordSalt = randomBytes(16).toString('base64url');
    const passwordHash = await hashPassword(input.password, passwordSalt);
    if (existing === null) {
      const created = await this.prisma.dsvAdminAccount.create({
        data: {
          ...(displayName === null ? {} : { displayName }),
          loginId,
          passwordHash,
          passwordSalt,
          scopes: [...dsvAdminScopes],
        },
        select: { id: true },
      });
      return { accountId: created.id, created: true, reset: false };
    }

    await this.prisma.dsvAdminAccount.update({
      data: {
        ...(displayName === null ? {} : { displayName }),
        failedLoginAttempts: 0,
        lockedUntil: null,
        passwordHash,
        passwordSalt,
        scopes: [...dsvAdminScopes],
        status: 'ACTIVE',
        tokenVersion: { increment: 1 },
      },
      where: { id: existing.id },
    });
    return { accountId: existing.id, created: false, reset: true };
  }

  async list(): Promise<DsvAdminAccountSummary[]> {
    const accounts = await this.prisma.dsvAdminAccount.findMany({
      orderBy: { loginId: 'asc' },
    });
    return accounts.map((account) => {
      const scopes = normalizeDsvScopes(account.scopes);
      if (scopes === null) throw new Error('DSV admin account contains unsupported scopes');
      return summary(account, scopes);
    });
  }

  async create(input: { displayName?: string; loginId: string }): Promise<{ account: DsvAdminAccountSummary; temporaryPassword: string }> {
    const loginId = normalizeLoginId(input.loginId);
    if (loginId === null) throw new Error('DSV admin login ID is required');
    const existing = await this.prisma.dsvAdminAccount.findUnique({ select: { id: true }, where: { loginId } });
    if (existing !== null) throw new DsvAdminAccountManagementError('ADMIN_ACCOUNT_LOGIN_ID_EXISTS');
    const temporaryPassword = generateTemporaryPassword();
    const passwordSalt = randomBytes(16).toString('base64url');
    const passwordHash = await hashPassword(temporaryPassword, passwordSalt);
    const displayName = normalizeDisplayName(input.displayName);
    const account = await this.prisma.dsvAdminAccount.create({
      data: {
        ...(displayName === null ? {} : { displayName }),
        loginId,
        passwordHash,
        passwordSalt,
        scopes: [...dsvOperatorScopes],
      },
    }).catch((error: unknown) => {
      if (isUniqueConflict(error)) throw new DsvAdminAccountManagementError('ADMIN_ACCOUNT_LOGIN_ID_EXISTS');
      throw error;
    });
    return { account: summary(account, dsvOperatorScopes), temporaryPassword };
  }

  async resetPassword(input: { accountId: string }): Promise<{ account: DsvAdminAccountSummary; temporaryPassword: string }> {
    const existing = await this.prisma.dsvAdminAccount.findUnique({ where: { id: input.accountId } });
    if (existing === null) throw new DsvAdminAccountManagementError('ADMIN_ACCOUNT_NOT_FOUND');
    const temporaryPassword = generateTemporaryPassword();
    const passwordSalt = randomBytes(16).toString('base64url');
    const passwordHash = await hashPassword(temporaryPassword, passwordSalt);
    const account = await this.prisma.dsvAdminAccount.update({
      data: {
        failedLoginAttempts: 0,
        lockedUntil: null,
        passwordHash,
        passwordSalt,
        status: 'ACTIVE',
        tokenVersion: { increment: 1 },
      },
      where: { id: input.accountId },
    });
    const scopes = normalizeDsvScopes(account.scopes);
    if (scopes === null) throw new Error('DSV admin account contains unsupported scopes');
    return { account: summary(account, scopes), temporaryPassword };
  }

  async setStatus(input: { accountId: string; status: DsvAdminAccountStatus }): Promise<DsvAdminAccountSummary> {
    const existing = await this.prisma.dsvAdminAccount.findUnique({ where: { id: input.accountId } });
    if (existing === null) throw new DsvAdminAccountManagementError('ADMIN_ACCOUNT_NOT_FOUND');
    const account = await this.prisma.dsvAdminAccount.update({
      data: {
        failedLoginAttempts: 0,
        lockedUntil: null,
        status: input.status,
        tokenVersion: { increment: 1 },
      },
      where: { id: input.accountId },
    });
    const scopes = normalizeDsvScopes(account.scopes);
    if (scopes === null) throw new Error('DSV admin account contains unsupported scopes');
    return summary(account, scopes);
  }

  async delete(input: { accountId: string }): Promise<void> {
    const deleted = await this.prisma.dsvAdminAccount.deleteMany({
      where: { id: input.accountId, status: 'DISABLED' },
    });
    if (deleted.count === 1) return;
    const existing = await this.prisma.dsvAdminAccount.findUnique({ select: { id: true }, where: { id: input.accountId } });
    if (existing === null) throw new DsvAdminAccountManagementError('ADMIN_ACCOUNT_NOT_FOUND');
    throw new DsvAdminAccountManagementError('ADMIN_ACCOUNT_DELETE_REQUIRES_DISABLED');
  }
}

function generateTemporaryPassword(): string {
  return randomBytes(18).toString('base64url');
}

function identity(
  account: {
    displayName: string | null;
    id: string;
    tokenVersion: number;
  },
  scopes: readonly DsvScope[],
): DsvAdminAccountIdentity {
  return {
    accountId: account.id,
    ...(account.displayName === null ? {} : { displayName: account.displayName }),
    scopes,
    tokenVersion: account.tokenVersion,
  };
}

function summary(
  account: {
    createdAt: Date;
    displayName: string | null;
    failedLoginAttempts: number;
    id: string;
    lastAuthenticatedAt: Date | null;
    lockedUntil: Date | null;
    loginId: string;
    status: DsvAdminAccountStatus;
    updatedAt: Date;
  },
  scopes: readonly DsvScope[],
): DsvAdminAccountSummary {
  return {
    createdAt: account.createdAt,
    displayName: account.displayName,
    failedLoginAttempts: account.failedLoginAttempts,
    id: account.id,
    lastAuthenticatedAt: account.lastAuthenticatedAt,
    lockedUntil: account.lockedUntil,
    loginId: account.loginId,
    scopes,
    status: account.status,
    updatedAt: account.updatedAt,
  };
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

function normalizeLoginId(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return normalized === '' ? null : normalized;
}

function normalizeDisplayName(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized === undefined || normalized === '' ? null : normalized;
}

function isUniqueConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}
