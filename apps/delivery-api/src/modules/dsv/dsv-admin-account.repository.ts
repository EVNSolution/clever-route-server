import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

import {
  dsvAdminScopes,
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
  resolveSession(input: { accountId: string; tokenVersion: number }): Promise<DsvAdminAccountIdentity | null>;
};

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

export class PrismaDsvAdminAccountRepository implements DsvAdminAccountAuthenticator {
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

    await this.prisma.dsvAdminAccount.update({
      data: {
        failedLoginAttempts: 0,
        lastAuthenticatedAt: now,
        lockedUntil: null,
      },
      where: { id: account.id },
    });
    return identity(account, scopes);
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
        status: 'ACTIVE',
        tokenVersion: { increment: 1 },
      },
      where: { id: existing.id },
    });
    return { accountId: existing.id, created: false, reset: true };
  }
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
