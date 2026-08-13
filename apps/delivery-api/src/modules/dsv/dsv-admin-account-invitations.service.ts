import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';

import { appScopedShopWhere } from '../shopify/shopify-app-scope.js';
import type { AdminStoreSettings } from '../commerce/admin-store-settings.service.js';
import { normalizeDsvOperationalSettings } from './dsv-operational-settings.js';
import type { DsvManualEmailService } from './dsv-manual-email.service.js';
import { dsvOperatorScopes, normalizeDsvScopes, type DsvScope } from './dsv-principal.js';

export type DsvAdminOperatorInviteMetadata = {
  createdAt: Date;
  displayName: string | null;
  email: string;
  expiresAt: Date;
  id: string;
  revokedAt: Date | null;
};

export type DsvAdminOperatorInviteValidation = {
  displayName: string | null;
  email: string;
  expiresAt: Date;
};

export type DsvAdminOperatorAccountMetadata = {
  activeSessionId: string;
  createdAt: Date;
  displayName: string | null;
  email: string | null;
  id: string;
  lastAuthenticatedAt: Date | null;
  loginId: string;
  mustChangePassword: boolean;
  scopes: readonly DsvScope[];
  status: 'ACTIVE' | 'DISABLED';
  updatedAt: Date;
};

export type DsvAdminOperatorInvitationService = {
  complete(input: { loginId: string; password: string; requestId: string; shopDomain: string; token: string }): Promise<DsvAdminOperatorAccountMetadata>;
  createInvitation(input: { actorId: string | null; displayName?: string; email: string; message?: string; requestId: string; shopDomain: string }): Promise<DsvAdminOperatorInviteMetadata>;
  updateCredentials(input: { accountId: string; currentPassword: string; loginId?: string; password?: string; requestId: string; shopDomain: string }): Promise<DsvAdminOperatorAccountMetadata>;
  validateInvitation(input: { shopDomain: string; token: string }): Promise<DsvAdminOperatorInviteValidation | null>;
};

export type DsvAdminOperatorInvitationPrisma = Pick<
  PrismaClient,
  '$transaction' | 'dsvAdminAccount' | 'dsvAdminAccountInvite' | 'dsvAuditEvent' | 'shop'
>;

export type DsvAdminOperatorInvitationSettingsService = Pick<{
  getSettings(input: { shopDomain: string }): Promise<AdminStoreSettings | null>;
}, 'getSettings'>;

const inviteTtlMs = 48 * 60 * 60 * 1000;
const minPasswordBytes = 12;
const dummyPasswordSalt = 'dsv-admin-operator-account-missing';
const dummyPasswordHash = '1nIKJFpoHOlQG07624Wzp3QKFBESdYrwtBAhDdVnhw0H8UJm6Rw1hhc1kf7sd0qFnfAyKnAHN9Ffi-rXB-pBoA';

export class PrismaDsvAdminOperatorInvitationService implements DsvAdminOperatorInvitationService {
  constructor(
    private readonly prisma: DsvAdminOperatorInvitationPrisma,
    private readonly dependencies: {
      manualEmailService: DsvManualEmailService;
      settingsService: DsvAdminOperatorInvitationSettingsService;
      webPublicOrigin?: string;
    },
  ) {}

  async createInvitation(input: { actorId: string | null; displayName?: string; email: string; message?: string; requestId: string; shopDomain: string }): Promise<DsvAdminOperatorInviteMetadata> {
    const email = normalizeEmail(input.email);
    if (email === null) throw new DsvAdminOperatorInvitationError('BAD_REQUEST', 'Operator account email is required');
    const displayName = normalizeDisplayName(input.displayName);
    const shop = await this.findShop(input.shopDomain);
    if (shop === null) throw new DsvAdminOperatorInvitationError('NOT_FOUND', 'Customer workspace not found');
    const existingAccount = await this.prisma.dsvAdminAccount.findUnique({ select: { id: true }, where: { email } });
    if (existingAccount !== null) throw new DsvAdminOperatorInvitationError('ACCOUNT_EXISTS', 'An operator account already uses this email');

    const token = randomBytes(32).toString('base64url');
    const tokenHash = hashToken(token);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + inviteTtlMs);
    const invite = await this.prisma.$transaction(async (tx) => {
      await tx.dsvAdminAccountInvite.updateMany({
        data: { revokedAt: now },
        where: {
          consumedAt: null,
          email,
          revokedAt: null,
          shopId: shop.id,
        },
      });
      const created = await tx.dsvAdminAccountInvite.create({
        data: {
          createdBy: input.actorId,
          displayName,
          email,
          expiresAt,
          shopId: shop.id,
          tokenHash,
        },
      });
      await createAdminSecurityAudit(tx, {
        actorId: input.actorId,
        entityId: created.id,
        entityType: 'DSV_ADMIN_ACCOUNT_INVITE',
        eventType: 'DSV_ADMIN_ACCOUNT_INVITATION_CREATED',
        redactedDiff: { expiresAt: expiresAt.toISOString() },
        requestId: input.requestId,
        shopId: shop.id,
      });
      return created;
    });
    try {
      await this.sendInviteEmail({
        displayName,
        email,
        ...(input.message === undefined ? {} : { message: input.message }),
        requestId: input.requestId,
        shopDomain: input.shopDomain,
        token,
      });
    } catch (error) {
      await this.prisma.$transaction(async (tx) => {
        await tx.dsvAdminAccountInvite.updateMany({
          data: { revokedAt: new Date() },
          where: {
            consumedAt: null,
            id: invite.id,
            revokedAt: null,
          },
        });
        await createAdminSecurityAudit(tx, {
          actorId: input.actorId,
          entityId: invite.id,
          entityType: 'DSV_ADMIN_ACCOUNT_INVITE',
          eventType: 'DSV_ADMIN_ACCOUNT_INVITATION_DELIVERY_FAILED',
          requestId: input.requestId,
          shopId: shop.id,
        });
      });
      throw error;
    }
    return inviteMetadata(invite);
  }

  async validateInvitation(input: { shopDomain: string; token: string }): Promise<DsvAdminOperatorInviteValidation | null> {
    const invite = await this.findValidInvite(input);
    if (invite === null) return null;
    return {
      displayName: invite.displayName,
      email: invite.email,
      expiresAt: invite.expiresAt,
    };
  }

  async complete(input: { loginId: string; password: string; requestId: string; shopDomain: string; token: string }): Promise<DsvAdminOperatorAccountMetadata> {
    const invite = await this.findValidInvite({ shopDomain: input.shopDomain, token: input.token });
    const loginId = normalizeLoginId(input.loginId);
    await constantTimePasswordCheck(input.password);
    if (invite === null) throw new DsvAdminOperatorInvitationError('INVALID_TOKEN', 'Invitation token is invalid');
    if (loginId === null) throw new DsvAdminOperatorInvitationError('BAD_REQUEST', 'loginId is invalid');
    if (!isStrongPassword(input.password)) throw new DsvAdminOperatorInvitationError('WEAK_PASSWORD', 'Password does not meet strength requirements');
    const passwordSalt = randomBytes(16).toString('base64url');
    const passwordHash = await hashPassword(input.password, passwordSalt);
    const now = new Date();
    const account = await this.prisma.$transaction(async (tx) => {
      const consumed = await tx.dsvAdminAccountInvite.updateMany({
        data: { consumedAt: now },
        where: {
          consumedAt: null,
          expiresAt: { gt: now },
          id: invite.id,
          revokedAt: null,
          shopId: invite.shopId,
        },
      });
      if (consumed.count !== 1) throw new DsvAdminOperatorInvitationError('INVALID_TOKEN', 'Invitation token is invalid');
      await assertLoginIdAvailable(tx, loginId);
      await assertEmailAvailable(tx, invite.email);
      const created = await tx.dsvAdminAccount.create({
        data: {
          activeSessionId: randomUUID(),
          displayName: invite.displayName,
          email: invite.email,
          lastAuthenticatedAt: now,
          loginId,
          passwordHash,
          passwordSalt,
          scopes: [...dsvOperatorScopes],
          status: 'ACTIVE',
        },
      });
      await createAdminSecurityAudit(tx, {
        actorId: created.id,
        entityId: created.id,
        entityType: 'DSV_ADMIN_ACCOUNT',
        eventType: 'DSV_ADMIN_ACCOUNT_ACTIVATED',
        redactedDiff: { invitationId: invite.id },
        requestId: input.requestId,
        shopId: invite.shopId,
      });
      return created;
    }).catch((error: unknown) => {
      throw mapUniqueConflict(error);
    });
    return accountMetadata(account);
  }

  async updateCredentials(input: { accountId: string; currentPassword: string; loginId?: string; password?: string; requestId: string; shopDomain: string }): Promise<DsvAdminOperatorAccountMetadata> {
    const loginId = input.loginId === undefined ? undefined : normalizeLoginId(input.loginId);
    if (loginId === null) throw new DsvAdminOperatorInvitationError('BAD_REQUEST', 'loginId is invalid');
    if (input.loginId === undefined && input.password === undefined) {
      throw new DsvAdminOperatorInvitationError('BAD_REQUEST', 'A new loginId or password is required');
    }
    if (input.password !== undefined && !isStrongPassword(input.password)) {
      await constantTimePasswordCheck(input.currentPassword);
      throw new DsvAdminOperatorInvitationError('WEAK_PASSWORD', 'Password does not meet strength requirements');
    }
    const shop = await this.findShop(input.shopDomain);
    if (shop === null) throw new DsvAdminOperatorInvitationError('NOT_FOUND', 'Customer workspace not found');
    const existing = await this.prisma.dsvAdminAccount.findFirst({
      where: { id: input.accountId, status: 'ACTIVE' },
    });
    const currentPasswordMatches = existing === null
      ? await verifyPassword(input.currentPassword, dummyPasswordSalt, dummyPasswordHash)
      : await verifyPassword(input.currentPassword, existing.passwordSalt, existing.passwordHash);
    if (existing === null || !currentPasswordMatches) {
      throw new DsvAdminOperatorInvitationError('CURRENT_PASSWORD_INVALID', 'Current password is invalid');
    }
    if (input.password !== undefined && (
      await verifyPassword(input.password, existing.passwordSalt, existing.passwordHash)
      || (existing.previousPasswordHash !== null
        && existing.previousPasswordSalt !== null
        && await verifyPassword(input.password, existing.previousPasswordSalt, existing.previousPasswordHash))
    )) {
      throw new DsvAdminOperatorInvitationError('PASSWORD_REUSED', '현재 비밀번호와 직전 비밀번호는 다시 사용할 수 없습니다');
    }
    if (existing.mustChangePassword && input.password === undefined) {
      throw new DsvAdminOperatorInvitationError('PASSWORD_CHANGE_REQUIRED', '새 비밀번호를 설정해야 합니다');
    }
    if (loginId !== undefined && loginId !== existing.loginId) {
      const loginAccount = await this.prisma.dsvAdminAccount.findUnique({ select: { id: true }, where: { loginId } });
      if (loginAccount !== null && loginAccount.id !== existing.id) {
        throw new DsvAdminOperatorInvitationError('LOGIN_ID_EXISTS', 'loginId is already in use');
      }
    }
    const passwordCredentials: {
      passwordHash?: string;
      passwordSalt?: string;
      previousPasswordHash?: string;
      previousPasswordSalt?: string;
    } = {};
    if (input.password !== undefined) {
      passwordCredentials.previousPasswordHash = existing.passwordHash;
      passwordCredentials.previousPasswordSalt = existing.passwordSalt;
      passwordCredentials.passwordSalt = randomBytes(16).toString('base64url');
      passwordCredentials.passwordHash = await hashPassword(input.password, passwordCredentials.passwordSalt);
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      const account = await tx.dsvAdminAccount.update({
        data: {
          activeSessionId: randomUUID(),
          failedLoginAttempts: 0,
          lockedUntil: null,
          ...(loginId === undefined ? {} : { loginId }),
          ...passwordCredentials,
          ...(input.password === undefined ? {} : { mustChangePassword: false }),
        },
        where: { id: existing.id },
      });
      await createAdminSecurityAudit(tx, {
        actorId: existing.id,
        entityId: existing.id,
        entityType: 'DSV_ADMIN_ACCOUNT',
        eventType: 'DSV_ADMIN_ACCOUNT_CREDENTIALS_UPDATED',
        redactedDiff: {
          loginIdChanged: loginId !== undefined && loginId !== existing.loginId,
          passwordChanged: input.password !== undefined,
          sessionRotated: true,
        },
        requestId: input.requestId,
        shopId: shop.id,
      });
      return account;
    }).catch((error: unknown) => {
      throw mapUniqueConflict(error);
    });
    return accountMetadata(updated);
  }

  private async sendInviteEmail(input: { displayName: string | null; email: string; message?: string; requestId: string; shopDomain: string; token: string }): Promise<void> {
    if (this.dependencies.webPublicOrigin === undefined) {
      throw new DsvAdminOperatorInvitationError('INVITATION_LINK_NOT_CONFIGURED', 'CLEVER_DSV_WEB_PUBLIC_URL is required for admin account invitation links');
    }
    const settings = await this.dependencies.settingsService.getSettings({ shopDomain: input.shopDomain });
    if (settings === null) throw new DsvAdminOperatorInvitationError('NOT_FOUND', 'Customer workspace not found');
    const operationSettings = normalizeDsvOperationalSettings(settings.dsvOperationalSettings);
    if (operationSettings.manualEmailSenderEmail === null) {
      throw new DsvAdminOperatorInvitationError('EMAIL_NOT_CONFIGURED', 'DSV manual email sender is not configured');
    }
    const setupUrl = new URL('/admin/account/setup', this.dependencies.webPublicOrigin);
    setupUrl.hash = `token=${encodeURIComponent(input.token)}`;
    const loginUrl = new URL('/login', this.dependencies.webPublicOrigin);
    const greeting = input.displayName ?? '운영자';
    const message = input.message?.trim();
    const introduction = message === undefined || message === '' ? 'CLEVER DSV 운영자 계정 초대 링크입니다.' : message;
    const body = `안녕하세요 ${greeting}님.\n\n${introduction}\n\n48시간 안에 아래 일회용 링크로 접속해 로그인 ID와 비밀번호를 설정해 주세요.\n\n${setupUrl.toString()}\n\n초대 링크는 한 번만 사용할 수 있습니다.\n설정 후에는 아래 주소에서 계속 로그인할 수 있습니다.\n${loginUrl.toString()}`;
    await this.dependencies.manualEmailService.send({
      commandId: input.requestId,
      recipients: [input.email],
      senderEmail: operationSettings.manualEmailSenderEmail,
      subject: `${subjectPrefix(operationSettings.manualEmailSubject)}운영자 계정 초대`,
      textContent: body,
    });
  }

  private async findValidInvite(input: { shopDomain: string; token: string }) {
    const token = normalizeToken(input.token);
    if (token === null) return null;
    const invite = await this.prisma.dsvAdminAccountInvite.findUnique({
      include: { shop: { select: { id: true, shopDomain: true } } },
      where: { tokenHash: hashToken(token) },
    });
    const now = new Date();
    if (
      invite === null
      || invite.shop.shopDomain !== input.shopDomain
      || invite.consumedAt !== null
      || invite.revokedAt !== null
      || invite.expiresAt.getTime() <= now.getTime()
    ) {
      return null;
    }
    return invite;
  }

  private async findShop(shopDomain: string): Promise<{ id: string; shopDomain: string } | null> {
    return this.prisma.shop.findUnique({
      select: { id: true, shopDomain: true },
      where: appScopedShopWhere({ shopDomain }),
    });
  }
}

async function createAdminSecurityAudit(
  tx: Pick<Prisma.TransactionClient, 'dsvAuditEvent'>,
  input: {
    actorId: string | null;
    entityId: string;
    entityType: 'DSV_ADMIN_ACCOUNT' | 'DSV_ADMIN_ACCOUNT_INVITE';
    eventType: string;
    redactedDiff?: Record<string, unknown>;
    requestId: string;
    shopId: string;
  },
): Promise<void> {
  await tx.dsvAuditEvent.create({
    data: {
      actorId: input.actorId,
      actorType: 'DSV_ADMIN',
      entityId: input.entityId,
      entityType: input.entityType,
      eventType: input.eventType,
      principalType: 'DSV_ADMIN',
      redactedDiff: (input.redactedDiff ?? {}) as Prisma.InputJsonObject,
      redactionClass: 'PII_REDACTED',
      requestId: input.requestId,
      shopId: input.shopId,
    },
  });
}

export class DsvAdminOperatorInvitationError extends Error {
  constructor(
    readonly code:
      | 'ACCOUNT_EXISTS'
      | 'BAD_REQUEST'
      | 'CURRENT_PASSWORD_INVALID'
      | 'EMAIL_NOT_CONFIGURED'
      | 'INVALID_TOKEN'
      | 'INVITATION_LINK_NOT_CONFIGURED'
      | 'LOGIN_ID_EXISTS'
      | 'NOT_FOUND'
      | 'PASSWORD_CHANGE_REQUIRED'
      | 'PASSWORD_REUSED'
      | 'WEAK_PASSWORD',
    message: string,
  ) {
    super(message);
    this.name = 'DsvAdminOperatorInvitationError';
  }
}

function inviteMetadata(invite: {
  createdAt: Date;
  displayName: string | null;
  email: string;
  expiresAt: Date;
  id: string;
  revokedAt: Date | null;
}): DsvAdminOperatorInviteMetadata {
  return {
    createdAt: invite.createdAt,
    displayName: invite.displayName,
    email: invite.email,
    expiresAt: invite.expiresAt,
    id: invite.id,
    revokedAt: invite.revokedAt,
  };
}

function accountMetadata(account: {
  activeSessionId: string | null;
  createdAt: Date;
  displayName: string | null;
  email: string | null;
  id: string;
  lastAuthenticatedAt: Date | null;
  loginId: string;
  mustChangePassword: boolean;
  scopes: string[];
  status: 'ACTIVE' | 'DISABLED';
  updatedAt: Date;
}): DsvAdminOperatorAccountMetadata {
  const scopes = normalizeDsvScopes(account.scopes);
  if (scopes === null) throw new Error('DSV admin account contains unsupported scopes');
  if (account.activeSessionId === null) throw new Error('DSV admin account has no active session');
  return {
    activeSessionId: account.activeSessionId,
    createdAt: account.createdAt,
    displayName: account.displayName,
    email: account.email,
    id: account.id,
    lastAuthenticatedAt: account.lastAuthenticatedAt,
    loginId: account.loginId,
    mustChangePassword: account.mustChangePassword,
    scopes,
    status: account.status,
    updatedAt: account.updatedAt,
  };
}

async function assertLoginIdAvailable(tx: Prisma.TransactionClient, loginId: string): Promise<void> {
  const existing = await tx.dsvAdminAccount.findUnique({
    select: { id: true },
    where: { loginId },
  });
  if (existing !== null) throw new DsvAdminOperatorInvitationError('LOGIN_ID_EXISTS', 'loginId is already in use');
}

async function assertEmailAvailable(tx: Prisma.TransactionClient, email: string): Promise<void> {
  const existing = await tx.dsvAdminAccount.findUnique({
    select: { id: true },
    where: { email },
  });
  if (existing !== null) throw new DsvAdminOperatorInvitationError('ACCOUNT_EXISTS', 'An operator account already uses this email');
}

function normalizeEmail(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized) ? normalized : null;
}

function normalizeDisplayName(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized === undefined || normalized === '' ? null : normalized;
}

function normalizeLoginId(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized === '') return null;
  return /^[a-z0-9][a-z0-9._-]{2,63}$/u.test(normalized) ? normalized : null;
}

function normalizeToken(value: string): string | null {
  const normalized = value.trim();
  return /^[A-Za-z0-9_-]{32,160}$/u.test(normalized) ? normalized : null;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function isStrongPassword(value: string): boolean {
  return Buffer.byteLength(value, 'utf8') >= minPasswordBytes
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

async function constantTimePasswordCheck(password: string): Promise<void> {
  await verifyPassword(password, dummyPasswordSalt, dummyPasswordHash);
}

function subjectPrefix(value: string): string {
  const match = /^\s*(\[[^\]]+\])\s*/u.exec(value);
  return match?.[1] === undefined ? '[CLEVER DSV] ' : `${match[1]} `;
}

function mapUniqueConflict(error: unknown): Error {
  if (!isUniqueConflict(error)) return error instanceof Error ? error : new Error('Unknown DSV admin operator invitation error');
  const targetValue = error.meta?.target;
  const target = Array.isArray(targetValue)
    ? targetValue.filter((value): value is string => typeof value === 'string').join(',')
    : typeof targetValue === 'string' ? targetValue : '';
  if (target.includes('email')) {
    return new DsvAdminOperatorInvitationError('ACCOUNT_EXISTS', 'An operator account already uses this email');
  }
  return new DsvAdminOperatorInvitationError('LOGIN_ID_EXISTS', 'loginId is already in use');
}

function isUniqueConflict(error: unknown): error is { code: 'P2002'; meta?: { target?: unknown } } {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}
