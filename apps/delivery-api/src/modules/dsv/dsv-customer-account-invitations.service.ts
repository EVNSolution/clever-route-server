import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';

import { appScopedShopWhere } from '../shopify/shopify-app-scope.js';
import type { AdminStoreSettings } from '../commerce/admin-store-settings.service.js';
import { normalizeDsvOperationalSettings } from './dsv-operational-settings.js';
import type { DsvManualEmailService } from './dsv-manual-email.service.js';
import { loadDsvWebPublicOrigin } from './dsv-web-public-origin.js';

export type DsvCustomerAccountInvitePurpose = 'SIGNUP' | 'PASSWORD_RESET';
export type DsvCustomerAccountApiStatus = 'INVITED' | 'ACTIVE' | 'DISABLED' | 'EXPIRED';

export type DsvCustomerAccountSummary = {
  displayName: string | null;
  email: string | null;
  id: string;
  invitedAt: Date | null;
  inviteExpiresAt: Date | null;
  lastAuthenticatedAt: Date | null;
  loginId: string | null;
  status: DsvCustomerAccountApiStatus;
};

export type DsvCustomerInviteMetadata = {
  customerName: string | null;
  displayName: string | null;
  email: string | null;
  expiresAt: Date;
  loginId: string | null;
  purpose: DsvCustomerAccountInvitePurpose;
};

export type DsvCustomerInvitationIssue = {
  account: DsvCustomerAccountSummary;
  invitation: {
    expiresAt: Date;
    setupUrl: string;
  };
};

export type DsvCustomerSessionIdentity = {
  accountId: string;
  activeSessionId: string;
  customerId: string;
  shopDomain: string;
  shopId: string;
};

export type DsvCustomerAccountService = {
  complete(input: { displayName?: string; loginId?: string; password: string; requestId: string; shopDomain: string; token: string }): Promise<DsvCustomerSessionIdentity>;
  createSignupInvitation(input: { actorId: string | null; customerId: string; requestId: string; shopDomain: string }): Promise<DsvCustomerInvitationIssue>;
  listAccounts(input: { customerId: string; shopDomain: string }): Promise<DsvCustomerAccountSummary[]>;
  login(input: { id: string; password: string; requestId: string; shopDomain: string }): Promise<DsvCustomerSessionIdentity | null>;
  reinvite(input: { accountId: string; actorId: string | null; requestId: string; shopDomain: string }): Promise<DsvCustomerInvitationIssue>;
  requestPasswordReset(input: { accountId: string; actorId: string | null; requestId: string; shopDomain: string }): Promise<{ account: DsvCustomerAccountSummary }>;
  setStatus(input: { accountId: string; actorId: string | null; requestId: string; shopDomain: string; status: 'ACTIVE' | 'DISABLED' }): Promise<{ account: DsvCustomerAccountSummary }>;
  validateInvitation(input: { shopDomain: string; token: string }): Promise<DsvCustomerInviteMetadata | null>;
};

export type DsvCustomerAccountServicePrisma = Pick<
  PrismaClient,
  '$transaction' | 'customerAccount' | 'dsvAuditEvent' | 'dsvCustomerAccountInvite' | 'shop'
>;

export type DsvCustomerAccountSettingsService = Pick<{
  getSettings(input: { shopDomain: string }): Promise<AdminStoreSettings | null>;
}, 'getSettings'>;

const issuer = 'CLEVER_DSV';
const inviteTtlMs = 48 * 60 * 60 * 1000;
const minPasswordBytes = 12;
const dummyPasswordSalt = 'dsv-customer-account-missing';
const dummyPasswordHash = 'Bxy2TBYWnB4QsjfC0w8g3umFTtFd1QS3qEfYzREwxlgzk5IcYlnHvMeG3FCSWxHgMF3TGxaDS01F7hKQA8cHRQ';

export class PrismaDsvCustomerAccountService implements DsvCustomerAccountService {
  constructor(
    private readonly prisma: DsvCustomerAccountServicePrisma,
    private readonly dependencies: {
      manualEmailService: DsvManualEmailService;
      settingsService: DsvCustomerAccountSettingsService;
      webPublicOrigin?: string;
    },
  ) {}

  async listAccounts(input: { customerId: string; shopDomain: string }): Promise<DsvCustomerAccountSummary[]> {
    const shop = await this.findShop(input.shopDomain);
    if (shop === null) return [];
    const accounts = await this.prisma.customerAccount.findMany({
      include: latestSignupInviteInclude,
      orderBy: [{ createdAt: 'asc' }],
      where: { customerId: input.customerId, issuer, shopId: shop.id },
    });
    return accounts.map((account) => accountSummary(account, new Date()));
  }

  async createSignupInvitation(input: { actorId: string | null; customerId: string; requestId: string; shopDomain: string }): Promise<DsvCustomerInvitationIssue> {
    this.requireWebPublicOrigin();
    const invitation = await this.createInvite({
      actorId: input.actorId,
      customerId: input.customerId,
      purpose: 'SIGNUP',
      requestId: input.requestId,
      shopDomain: input.shopDomain,
    });
    return this.invitationIssue(invitation);
  }

  async reinvite(input: { accountId: string; actorId: string | null; requestId: string; shopDomain: string }): Promise<DsvCustomerInvitationIssue> {
    this.requireWebPublicOrigin();
    const account = await this.findAccountForShop(input.accountId, input.shopDomain);
    if (account === null) throw new DsvCustomerAccountServiceError('NOT_FOUND', 'Customer account not found');
    if (account.passwordHash !== null) {
      throw new DsvCustomerAccountServiceError('BAD_REQUEST', 'Activated customer accounts must use password reset');
    }
    const invitation = await this.createInvite({
      accountId: account.id,
      actorId: input.actorId,
      customerId: account.customerId,
      purpose: 'SIGNUP',
      requestId: input.requestId,
      shopDomain: input.shopDomain,
    });
    return this.invitationIssue(invitation);
  }

  async requestPasswordReset(input: { accountId: string; actorId: string | null; requestId: string; shopDomain: string }): Promise<{ account: DsvCustomerAccountSummary }> {
    const account = await this.findAccountForShop(input.accountId, input.shopDomain);
    if (account === null) throw new DsvCustomerAccountServiceError('NOT_FOUND', 'Customer account not found');
    if (account.email === null || account.loginId === null || account.passwordHash === null || account.status !== 'ACTIVE') {
      throw new DsvCustomerAccountServiceError('BAD_REQUEST', 'Active customer account credentials are required');
    }
    const invitation = await this.createInvite({
      accountId: account.id,
      actorId: input.actorId,
      customerId: account.customerId,
      purpose: 'PASSWORD_RESET',
      requestId: input.requestId,
      shopDomain: input.shopDomain,
    });
    await this.sendPasswordResetEmail({
      customerName: invitation.customerName,
      displayName: account.displayName,
      email: account.email,
      requestId: input.requestId,
      shopDomain: input.shopDomain,
      token: invitation.token,
      loginId: account.loginId,
    });
    return { account: invitation.account };
  }

  async setStatus(input: { accountId: string; actorId: string | null; requestId: string; shopDomain: string; status: 'ACTIVE' | 'DISABLED' }): Promise<{ account: DsvCustomerAccountSummary }> {
    const account = await this.findAccountForShop(input.accountId, input.shopDomain);
    if (account === null) throw new DsvCustomerAccountServiceError('NOT_FOUND', 'Customer account not found');
    if (account.loginId === null || account.passwordHash === null || account.passwordSalt === null) {
      throw new DsvCustomerAccountServiceError('BAD_REQUEST', 'Only activated customer accounts can be enabled or disabled');
    }
    const status = input.status === 'ACTIVE' ? 'ACTIVE' : 'INACTIVE';
    const updated = await this.prisma.customerAccount.update({
      data: { activeSessionId: null, status },
      include: latestSignupInviteInclude,
      where: { id: account.id },
    });
    await this.audit({
      accountId: updated.id,
      actorId: input.actorId,
      customerId: updated.customerId,
      eventType: input.status === 'ACTIVE' ? 'CUSTOMER_ACCOUNT_ENABLED' : 'CUSTOMER_ACCOUNT_DISABLED',
      redactedDiff: { status: input.status },
      requestId: input.requestId,
      shopId: updated.shopId,
    });
    return { account: accountSummary(updated, new Date()) };
  }

  async validateInvitation(input: { shopDomain: string; token: string }): Promise<DsvCustomerInviteMetadata | null> {
    const invite = await this.findValidInvite(input);
    if (invite === null) return null;
    return {
      customerName: invite.customer.displayName,
      displayName: invite.account.displayName,
      email: invite.account.email,
      expiresAt: invite.expiresAt,
      loginId: invite.account.loginId,
      purpose: invite.purpose,
    };
  }

  async complete(input: { displayName?: string; loginId?: string; password: string; requestId: string; shopDomain: string; token: string }): Promise<DsvCustomerSessionIdentity> {
    const invite = await this.findValidInvite({ shopDomain: input.shopDomain, token: input.token });
    await constantTimePasswordCheck(input.password);
    if (invite === null) throw new DsvCustomerAccountServiceError('INVALID_TOKEN', 'Invitation token is invalid');
    if (!isStrongPassword(input.password)) throw new DsvCustomerAccountServiceError('WEAK_PASSWORD', 'Password does not meet strength requirements');
    if (
      (invite.account.passwordHash !== null
        && invite.account.passwordSalt !== null
        && await verifyPassword(input.password, invite.account.passwordSalt, invite.account.passwordHash))
      || (invite.account.previousPasswordHash !== null
        && invite.account.previousPasswordSalt !== null
        && await verifyPassword(input.password, invite.account.previousPasswordSalt, invite.account.previousPasswordHash))
    ) {
      throw new DsvCustomerAccountServiceError('PASSWORD_REUSED', '현재 비밀번호와 직전 비밀번호는 다시 사용할 수 없습니다');
    }
    const displayName = invite.purpose === 'SIGNUP' ? normalizeDisplayName(input.displayName) : invite.account.displayName;
    const loginId = invite.purpose === 'SIGNUP' ? normalizeLoginId(input.loginId) : invite.account.loginId;
    if (invite.purpose === 'SIGNUP' && displayName === null) {
      throw new DsvCustomerAccountServiceError('BAD_REQUEST', 'displayName is required for signup');
    }
    if (loginId === null) throw new DsvCustomerAccountServiceError('LOGIN_ID_REQUIRED', 'loginId is required for signup');
    const passwordSalt = randomBytes(16).toString('base64url');
    const passwordHash = await hashPassword(input.password, passwordSalt);
    let updated;
    try {
      updated = await this.prisma.$transaction(async (tx) => {
        await lockCustomerAccount(tx, invite.accountId);
        const completedAt = new Date();
        if (invite.purpose === 'SIGNUP') await assertLoginIdAvailable(tx, loginId, invite.accountId);
        const consumed = await tx.dsvCustomerAccountInvite.updateMany({
          data: { consumedAt: completedAt },
          where: {
            consumedAt: null,
            expiresAt: { gt: completedAt },
            id: invite.id,
            revokedAt: null,
          },
        });
        if (consumed.count !== 1) {
          if (invite.expiresAt.getTime() <= completedAt.getTime()) throw invitationExpiredError();
          throw new DsvCustomerAccountServiceError('INVALID_TOKEN', 'Invitation token is invalid');
        }
        const account = await tx.customerAccount.update({
          data: {
            activeSessionId: randomUUID(),
            ...(invite.purpose === 'SIGNUP' ? { displayName } : {}),
            lastAuthenticatedAt: completedAt,
            loginId,
            passwordHash,
            passwordSalt,
            ...(invite.account.passwordHash === null || invite.account.passwordSalt === null ? {} : {
              previousPasswordHash: invite.account.passwordHash,
              previousPasswordSalt: invite.account.passwordSalt,
            }),
            status: 'ACTIVE',
          },
          where: { id: invite.accountId },
        });
        await createAudit(tx, {
          accountId: account.id,
          actorId: account.id,
          customerId: account.customerId,
          eventType: invite.purpose === 'SIGNUP' ? 'CUSTOMER_ACCOUNT_ACTIVATED' : 'CUSTOMER_ACCOUNT_PASSWORD_RESET_COMPLETED',
          principalType: 'CUSTOMER_USER',
          redactedDiff: { purpose: invite.purpose },
          requestId: input.requestId,
          shopId: account.shopId,
        });
        return account;
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new DsvCustomerAccountServiceError('LOGIN_ID_EXISTS', 'loginId is already in use');
      }
      throw error;
    }
    return {
      accountId: updated.id,
      activeSessionId: requireActiveSessionId(updated.activeSessionId),
      customerId: updated.customerId,
      shopDomain: invite.shop.shopDomain,
      shopId: updated.shopId,
    };
  }

  async login(input: { id: string; password: string; requestId: string; shopDomain: string }): Promise<DsvCustomerSessionIdentity | null> {
    const loginId = normalizeLoginIdentifier(input.id);
    const account = loginId === null
      ? null
      : await this.prisma.customerAccount.findUnique({
          include: { shop: { select: { id: true, shopDomain: true } } },
          where: { loginId },
        });
    const passwordMatches = account?.passwordHash === null || account?.passwordSalt === null || account === null
      ? await verifyPassword(input.password, dummyPasswordSalt, dummyPasswordHash)
      : await verifyPassword(input.password, account.passwordSalt, account.passwordHash);
    if (
      account === null
      || account.issuer !== issuer
      || account.status !== 'ACTIVE'
      || account.shop.shopDomain !== input.shopDomain
      || !passwordMatches
    ) {
      return null;
    }
    const updated = await this.prisma.customerAccount.update({
      data: {
        activeSessionId: randomUUID(),
        lastAuthenticatedAt: new Date(),
      },
      where: { id: account.id },
    });
    await this.audit({
      accountId: updated.id,
      actorId: updated.id,
      customerId: updated.customerId,
      eventType: 'CUSTOMER_ACCOUNT_LOGIN',
      principalType: 'CUSTOMER_USER',
      requestId: input.requestId,
      shopId: updated.shopId,
    });
    return {
      accountId: updated.id,
      activeSessionId: requireActiveSessionId(updated.activeSessionId),
      customerId: updated.customerId,
      shopDomain: account.shop.shopDomain,
      shopId: updated.shopId,
    };
  }

  private async createInvite(input: {
    accountId?: string;
    actorId: string | null;
    customerId: string;
    purpose: DsvCustomerAccountInvitePurpose;
    requestId: string;
    shopDomain: string;
  }): Promise<{ account: DsvCustomerAccountSummary; customerName: string | null; expiresAt: Date; token: string }> {
    const shop = await this.findShop(input.shopDomain);
    if (shop === null) throw new DsvCustomerAccountServiceError('NOT_FOUND', 'Customer workspace not found');
    const customer = await this.prisma.shop.findUnique({
      select: {
        customers: {
          select: { displayName: true, id: true },
          take: 1,
          where: { id: input.customerId },
        },
      },
      where: { id: shop.id },
    });
    const customerRow = customer?.customers[0] ?? null;
    if (customerRow === null) throw new DsvCustomerAccountServiceError('NOT_FOUND', 'Customer not found');
    const token = randomBytes(32).toString('base64url');
    const tokenHash = hashToken(token);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + inviteTtlMs);
    const account = await this.prisma.$transaction(async (tx) => {
      const localAccount = input.accountId === undefined
        ? await createUnclaimedAccount(tx, {
            customerId: input.customerId,
            shopId: shop.id,
          })
        : { created: false, id: input.accountId };
      const accountId = localAccount.id;
      await lockCustomerAccount(tx, accountId);
      if (input.accountId !== undefined) {
        const currentAccount = await tx.customerAccount.findUnique({
          select: { customerId: true, issuer: true, passwordHash: true, shopId: true },
          where: { id: accountId },
        });
        if (
          currentAccount === null
          || currentAccount.customerId !== input.customerId
          || currentAccount.issuer !== issuer
          || currentAccount.shopId !== shop.id
        ) {
          throw new DsvCustomerAccountServiceError('NOT_FOUND', 'Customer account not found');
        }
        if (input.purpose === 'SIGNUP' && currentAccount.passwordHash !== null) {
          throw new DsvCustomerAccountServiceError('BAD_REQUEST', 'Activated customer accounts must use password reset');
        }
      }
      await tx.dsvCustomerAccountInvite.updateMany({
        data: { revokedAt: now },
        where: {
          accountId,
          consumedAt: null,
          purpose: input.purpose,
          revokedAt: null,
        },
      });
      await tx.dsvCustomerAccountInvite.create({
        data: {
          accountId,
          customerId: input.customerId,
          expiresAt,
          purpose: input.purpose,
          shopId: shop.id,
          tokenHash,
        },
      });
      await createAudit(tx, {
        accountId,
        actorId: input.actorId,
        customerId: input.customerId,
        eventType: input.purpose === 'SIGNUP'
          ? (localAccount.created ? 'CUSTOMER_ACCOUNT_INVITED' : 'CUSTOMER_ACCOUNT_REINVITED')
          : 'CUSTOMER_ACCOUNT_PASSWORD_RESET_REQUESTED',
        principalType: 'DSV_ADMIN',
        redactedDiff: { purpose: input.purpose },
        requestId: input.requestId,
        shopId: shop.id,
      });
      return tx.customerAccount.findUniqueOrThrow({
        include: latestSignupInviteInclude,
        where: { id: accountId },
      });
    });
    return { account: accountSummary(account, now), customerName: customerRow.displayName, expiresAt, token };
  }

  private async sendPasswordResetEmail(input: {
    customerName: string | null;
    displayName: string | null;
    email: string;
    requestId: string;
    shopDomain: string;
    token: string;
    loginId: string;
  }): Promise<void> {
    if (this.dependencies.webPublicOrigin === undefined) {
      throw new DsvCustomerAccountServiceError('INVITATION_LINK_NOT_CONFIGURED', 'CLEVER_DSV_WEB_PUBLIC_URL is required for customer account invitation links');
    }
    const settings = await this.dependencies.settingsService.getSettings({ shopDomain: input.shopDomain });
    if (settings === null) throw new DsvCustomerAccountServiceError('NOT_FOUND', 'Customer workspace not found');
    const operationSettings = normalizeDsvOperationalSettings(settings.dsvOperationalSettings);
    if (operationSettings.manualEmailSenderEmail === null) {
      throw new DsvCustomerAccountServiceError('EMAIL_NOT_CONFIGURED', 'DSV manual email sender is not configured');
    }
    const setupUrl = new URL('/customer/account/setup', this.dependencies.webPublicOrigin);
    setupUrl.hash = `token=${encodeURIComponent(input.token)}`;
    const loginUrl = new URL('/customer/login', this.dependencies.webPublicOrigin);
    const subject = `${subjectPrefix(operationSettings.manualEmailSubject)}고객사 계정 비밀번호 재설정`;
    const greeting = input.displayName ?? input.customerName ?? '고객';
    const body = `안녕하세요 ${greeting}님.\n\nCLEVER DSV 고객사 계정 비밀번호 재설정 링크입니다.\n로그인 ID: ${input.loginId}\n48시간 안에 아래 일회용 링크로 접속해 새 비밀번호를 설정해 주세요.\n\n${setupUrl.toString()}\n\n이후 로그인 주소:\n${loginUrl.toString()}`;
    await this.dependencies.manualEmailService.send({
      commandId: input.requestId,
      recipients: [input.email],
      senderEmail: operationSettings.manualEmailSenderEmail,
      subject,
      textContent: body,
    });
  }

  private async findValidInvite(input: { shopDomain: string; token: string }) {
    const token = normalizeToken(input.token);
    if (token === null) return null;
    const invite = await this.prisma.dsvCustomerAccountInvite.findUnique({
      include: {
        account: true,
        customer: { select: { displayName: true, id: true, shopId: true } },
        shop: { select: { id: true, shopDomain: true } },
      },
      where: { tokenHash: hashToken(token) },
    });
    const now = new Date();
    if (
      invite === null
      || invite.shop.shopDomain !== input.shopDomain
      || invite.account.customerId !== invite.customerId
      || invite.account.issuer !== issuer
      || invite.account.shopId !== invite.shopId
      || invite.customer.id !== invite.customerId
      || invite.customer.shopId !== invite.shopId
      || invite.consumedAt !== null
      || invite.revokedAt !== null
    ) {
      return null;
    }
    if (invite.expiresAt.getTime() <= now.getTime()) {
      throw invitationExpiredError();
    }
    return invite;
  }

  private invitationIssue(input: { account: DsvCustomerAccountSummary; expiresAt: Date; token: string }): DsvCustomerInvitationIssue {
    const setupUrl = new URL('/customer/account/setup', this.requireWebPublicOrigin());
    setupUrl.hash = `token=${encodeURIComponent(input.token)}`;
    return { account: input.account, invitation: { expiresAt: input.expiresAt, setupUrl: setupUrl.toString() } };
  }

  private requireWebPublicOrigin(): string {
    if (this.dependencies.webPublicOrigin === undefined) {
      throw new DsvCustomerAccountServiceError('INVITATION_LINK_NOT_CONFIGURED', 'CLEVER_DSV_WEB_PUBLIC_URL is required for customer account invitation links');
    }
    return this.dependencies.webPublicOrigin;
  }

  private async findShop(shopDomain: string): Promise<{ id: string; shopDomain: string } | null> {
    return this.prisma.shop.findUnique({
      select: { id: true, shopDomain: true },
      where: appScopedShopWhere({ shopDomain }),
    });
  }

  private async findAccountForShop(accountId: string, shopDomain: string) {
    return this.prisma.customerAccount.findFirst({
      include: { shop: { select: { id: true, shopDomain: true } } },
      where: {
        id: accountId,
        issuer,
        shop: { appId: 'clever', shopDomain },
      },
    });
  }

  private async audit(input: AuditInput): Promise<void> {
    await createAudit(this.prisma, { principalType: 'DSV_ADMIN', ...input });
  }
}

export class DsvCustomerAccountServiceError extends Error {
  constructor(
    readonly code:
      | 'BAD_REQUEST'
      | 'ACCOUNT_EXISTS'
      | 'EMAIL_NOT_CONFIGURED'
      | 'INVITATION_EXPIRED'
      | 'INVALID_TOKEN'
      | 'INVITATION_LINK_NOT_CONFIGURED'
      | 'LOGIN_ID_EXISTS'
      | 'LOGIN_ID_REQUIRED'
      | 'NOT_FOUND'
      | 'PASSWORD_REUSED'
      | 'WEAK_PASSWORD',
    message: string,
  ) {
    super(message);
    this.name = 'DsvCustomerAccountServiceError';
  }
}

export function loadDsvCustomerAccountWebPublicOrigin(value: string | undefined): string | undefined {
  return loadDsvWebPublicOrigin(value);
}

export function createCustomerSessionSubject(input: { accountId: string; activeSessionId: string }): string {
  if (!uuidPattern.test(input.accountId) || !uuidPattern.test(input.activeSessionId)) {
    throw new Error('Invalid DSV customer session subject');
  }
  return `dsv-customer-account:${input.accountId}:${input.activeSessionId}`;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function requireActiveSessionId(value: string | null): string {
  if (value === null) throw new Error('DSV customer account has no active session');
  return value;
}

const latestSignupInviteInclude = {
  invites: {
    orderBy: { createdAt: 'desc' },
    take: 1,
    where: { consumedAt: null, purpose: 'SIGNUP', revokedAt: null },
  },
} satisfies Prisma.CustomerAccountInclude;

type AccountWithLatestSignupInvite = Prisma.CustomerAccountGetPayload<{ include: typeof latestSignupInviteInclude }>;

function accountSummary(account: AccountWithLatestSignupInvite, now: Date): DsvCustomerAccountSummary {
  const invite = account.invites[0] ?? null;
  return {
    displayName: account.displayName,
    email: account.email,
    id: account.id,
    invitedAt: invite?.createdAt ?? null,
    inviteExpiresAt: invite?.expiresAt ?? null,
    lastAuthenticatedAt: account.lastAuthenticatedAt,
    loginId: account.loginId,
    status: accountStatus(account, invite, now),
  };
}

function accountStatus(
  account: { passwordHash: string | null; status: string },
  invite: { expiresAt: Date } | null,
  now: Date,
): DsvCustomerAccountApiStatus {
  if (account.status !== 'ACTIVE') {
    if (invite !== null) return invite.expiresAt.getTime() > now.getTime() ? 'INVITED' : 'EXPIRED';
    return account.passwordHash === null ? 'EXPIRED' : 'DISABLED';
  }
  return account.passwordHash === null ? 'EXPIRED' : 'ACTIVE';
}

async function createUnclaimedAccount(
  tx: Prisma.TransactionClient,
  input: { customerId: string; shopId: string },
): Promise<{ created: true; id: string }> {
  const id = randomUUID();
  await tx.customerAccount.create({
    data: {
      customerId: input.customerId,
      id,
      issuer,
      shopId: input.shopId,
      status: 'INACTIVE',
      subject: id,
    },
  });
  return { created: true, id };
}

async function assertLoginIdAvailable(tx: Prisma.TransactionClient, loginId: string, accountId: string): Promise<void> {
  const existing = await tx.customerAccount.findUnique({
    select: { id: true },
    where: { loginId },
  });
  if (existing !== null && existing.id !== accountId) {
    throw new DsvCustomerAccountServiceError('LOGIN_ID_EXISTS', 'loginId is already in use');
  }
}

async function lockCustomerAccount(tx: Prisma.TransactionClient, accountId: string): Promise<void> {
  await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`dsv-customer-account:${accountId}`}, 0))::text AS "lock"`);
}

function invitationExpiredError(): DsvCustomerAccountServiceError {
  return new DsvCustomerAccountServiceError(
    'INVITATION_EXPIRED',
    '허용 시간이 초과된 링크입니다. 담당자에게 새 초대 링크를 요청해 주세요.',
  );
}

type AuditInput = {
  accountId: string;
  actorId: string | null;
  customerId: string;
  eventType: string;
  principalType?: 'DSV_ADMIN' | 'CUSTOMER_USER';
  redactedDiff?: Record<string, unknown>;
  requestId: string;
  shopId: string;
};

async function createAudit(tx: Pick<Prisma.TransactionClient, 'dsvAuditEvent'>, input: AuditInput): Promise<void> {
  await tx.dsvAuditEvent.create({
    data: {
      actorId: input.actorId,
      actorType: input.principalType ?? 'DSV_ADMIN',
      customerId: input.customerId,
      entityId: input.accountId,
      entityType: 'CUSTOMER_ACCOUNT',
      eventType: input.eventType,
      principalType: input.principalType ?? 'DSV_ADMIN',
      redactedDiff: (input.redactedDiff ?? {}) as Prisma.InputJsonObject,
      redactionClass: 'PII_REDACTED',
      requestId: input.requestId,
      shopId: input.shopId,
    },
  });
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

function normalizeLoginIdentifier(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized === '' || normalized.length > 128) return null;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized)) return normalized;
  return normalizeLoginId(normalized);
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
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
