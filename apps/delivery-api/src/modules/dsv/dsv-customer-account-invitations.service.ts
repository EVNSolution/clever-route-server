import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';

import { appScopedShopWhere } from '../shopify/shopify-app-scope.js';
import type { AdminStoreSettings } from '../commerce/admin-store-settings.service.js';
import { normalizeDsvOperationalSettings } from './dsv-operational-settings.js';
import type { DsvManualEmailService } from './dsv-manual-email.service.js';

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

export type DsvCustomerSessionIdentity = {
  accountId: string;
  activeSessionId: string;
  customerId: string;
  shopDomain: string;
  shopId: string;
};

export type DsvCustomerAccountService = {
  complete(input: { password: string; requestId: string; shopDomain: string; token: string }): Promise<DsvCustomerSessionIdentity>;
  createSignupInvitation(input: { actorId: string | null; customerId: string; displayName?: string; email: string; generateLoginId?: true; loginId?: string; requestId: string; shopDomain: string }): Promise<{ account: DsvCustomerAccountSummary }>;
  listAccounts(input: { customerId: string; shopDomain: string }): Promise<DsvCustomerAccountSummary[]>;
  login(input: { id: string; password: string; requestId: string; shopDomain: string }): Promise<DsvCustomerSessionIdentity | null>;
  reinvite(input: { accountId: string; actorId: string | null; requestId: string; shopDomain: string }): Promise<{ account: DsvCustomerAccountSummary }>;
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

  async createSignupInvitation(input: { actorId: string | null; customerId: string; displayName?: string; email: string; generateLoginId?: true; loginId?: string; requestId: string; shopDomain: string }): Promise<{ account: DsvCustomerAccountSummary }> {
    const email = normalizeEmail(input.email);
    if (email === null) throw new DsvCustomerAccountServiceError('BAD_REQUEST', 'Customer account email is required');
    if ((input.loginId === undefined) === (input.generateLoginId !== true)) {
      throw new DsvCustomerAccountServiceError('BAD_REQUEST', 'Specify loginId or generateLoginId=true');
    }
    const displayName = normalizeDisplayName(input.displayName);
    const requestedLoginId = input.loginId === undefined ? undefined : normalizeLoginId(input.loginId);
    if (input.loginId !== undefined && requestedLoginId === null) {
      throw new DsvCustomerAccountServiceError('BAD_REQUEST', 'loginId is invalid');
    }
    const explicitLoginId = requestedLoginId ?? undefined;
    const invitation = await this.createInvite({
      actorId: input.actorId,
      customerId: input.customerId,
      displayName,
      email,
      ...(explicitLoginId === undefined ? {} : { loginId: explicitLoginId }),
      purpose: 'SIGNUP',
      requestId: input.requestId,
      shopDomain: input.shopDomain,
    });
    await this.sendInviteEmail({
      customerName: invitation.customerName,
      displayName,
      email,
      purpose: 'SIGNUP',
      requestId: input.requestId,
      shopDomain: input.shopDomain,
      token: invitation.token,
      loginId: invitation.account.loginId,
    });
    return { account: invitation.account };
  }

  async reinvite(input: { accountId: string; actorId: string | null; requestId: string; shopDomain: string }): Promise<{ account: DsvCustomerAccountSummary }> {
    const account = await this.findAccountForShop(input.accountId, input.shopDomain);
    if (account === null) throw new DsvCustomerAccountServiceError('NOT_FOUND', 'Customer account not found');
    if (account.email === null) throw new DsvCustomerAccountServiceError('BAD_REQUEST', 'Customer account email is required');
    if (account.passwordHash !== null) {
      throw new DsvCustomerAccountServiceError('BAD_REQUEST', 'Activated customer accounts must use password reset');
    }
    const invitation = await this.createInvite({
      accountId: account.id,
      actorId: input.actorId,
      customerId: account.customerId,
      displayName: account.displayName,
      email: account.email,
      purpose: 'SIGNUP',
      requestId: input.requestId,
      shopDomain: input.shopDomain,
    });
    await this.sendInviteEmail({
      customerName: invitation.customerName,
      displayName: account.displayName,
      email: account.email,
      purpose: 'SIGNUP',
      requestId: input.requestId,
      shopDomain: input.shopDomain,
      token: invitation.token,
      loginId: invitation.account.loginId,
    });
    return { account: invitation.account };
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
      displayName: account.displayName,
      email: account.email,
      purpose: 'PASSWORD_RESET',
      requestId: input.requestId,
      shopDomain: input.shopDomain,
    });
    await this.sendInviteEmail({
      customerName: invitation.customerName,
      displayName: account.displayName,
      email: account.email,
      purpose: 'PASSWORD_RESET',
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

  async complete(input: { password: string; requestId: string; shopDomain: string; token: string }): Promise<DsvCustomerSessionIdentity> {
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
    const loginId = invite.account.loginId;
    if (loginId === null) throw new DsvCustomerAccountServiceError('LOGIN_ID_REQUIRED', 'loginId is required for signup');
    const passwordSalt = randomBytes(16).toString('base64url');
    const passwordHash = await hashPassword(input.password, passwordSalt);
    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      const consumed = await tx.dsvCustomerAccountInvite.updateMany({
        data: { consumedAt: now },
        where: {
          consumedAt: null,
          expiresAt: { gt: now },
          id: invite.id,
          revokedAt: null,
        },
      });
      if (consumed.count !== 1) throw new DsvCustomerAccountServiceError('INVALID_TOKEN', 'Invitation token is invalid');
      const account = await tx.customerAccount.update({
        data: {
          activeSessionId: randomUUID(),
          lastAuthenticatedAt: now,
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
    return {
      accountId: updated.id,
      activeSessionId: requireActiveSessionId(updated.activeSessionId),
      customerId: updated.customerId,
      shopDomain: invite.shop.shopDomain,
      shopId: updated.shopId,
    };
  }

  async login(input: { id: string; password: string; requestId: string; shopDomain: string }): Promise<DsvCustomerSessionIdentity | null> {
    const loginId = normalizeLoginId(input.id);
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
    displayName: string | null;
    email: string;
    loginId?: string;
    purpose: DsvCustomerAccountInvitePurpose;
    requestId: string;
    shopDomain: string;
  }): Promise<{ account: DsvCustomerAccountSummary; customerName: string | null; token: string }> {
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
        ? await findOrCreateAccount(tx, {
            customerId: input.customerId,
            displayName: input.displayName,
            email: input.email,
            ...(input.loginId === undefined ? {} : { loginId: input.loginId }),
            shopId: shop.id,
          })
        : { created: false, id: input.accountId };
      const accountId = localAccount.id;
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
        redactedDiff: { email: input.email, purpose: input.purpose },
        requestId: input.requestId,
        shopId: shop.id,
      });
      return tx.customerAccount.findUniqueOrThrow({
        include: latestSignupInviteInclude,
        where: { id: accountId },
      });
    });
    return { account: accountSummary(account, now), customerName: customerRow.displayName, token };
  }

  private async sendInviteEmail(input: {
    customerName: string | null;
    displayName: string | null;
    email: string;
    purpose: DsvCustomerAccountInvitePurpose;
    requestId: string;
    shopDomain: string;
    token: string;
    loginId: string | null;
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
    const subject = `${subjectPrefix(operationSettings.manualEmailSubject)}${input.purpose === 'SIGNUP' ? '고객사 계정 초대' : '고객사 계정 비밀번호 재설정'}`;
    const greeting = input.displayName ?? input.customerName ?? '고객';
    const body = input.purpose === 'SIGNUP'
      ? `안녕하세요 ${greeting}님.\n\nCLEVER DSV 고객사 배송조회 계정 초대 링크입니다.\n예약된 로그인 ID: ${input.loginId ?? ''}\n48시간 안에 아래 일회용 링크로 접속해 비밀번호를 설정해 주세요.\n\n${setupUrl.toString()}\n\n설정 후에는 아래 주소에서 계속 로그인할 수 있습니다.\n${loginUrl.toString()}`
      : `안녕하세요 ${greeting}님.\n\nCLEVER DSV 고객사 계정 비밀번호 재설정 링크입니다.\n로그인 ID: ${input.loginId ?? ''}\n48시간 안에 아래 일회용 링크로 접속해 새 비밀번호를 설정해 주세요.\n\n${setupUrl.toString()}\n\n이후 로그인 주소:\n${loginUrl.toString()}`;
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
        customer: { select: { displayName: true, id: true } },
        shop: { select: { id: true, shopDomain: true } },
      },
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
  const normalized = value?.trim();
  if (normalized === undefined || normalized === '') return undefined;
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error('CLEVER_DSV_WEB_PUBLIC_URL must be an http(s) origin');
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error('CLEVER_DSV_WEB_PUBLIC_URL must be an http(s) origin');
  }
  return url.origin;
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

async function findOrCreateAccount(
  tx: Prisma.TransactionClient,
  input: { customerId: string; displayName: string | null; email: string; loginId?: string; shopId: string },
): Promise<{ created: boolean; id: string }> {
  const existing = await tx.customerAccount.findFirst({
    select: { id: true, loginId: true, passwordHash: true },
    where: { customerId: input.customerId, email: input.email, issuer, shopId: input.shopId },
  });
  if (existing !== null) {
    if (existing.passwordHash !== null) {
      throw new DsvCustomerAccountServiceError('ACCOUNT_EXISTS', 'An activated customer account already uses this email');
    }
    if (input.loginId !== undefined && existing.loginId !== input.loginId) {
      throw new DsvCustomerAccountServiceError('BAD_REQUEST', 'Customer account already has a reserved loginId');
    }
    if (existing.loginId === null) {
      const loginId = input.loginId ?? await generateReadableLoginId(tx, input.email);
      await assertLoginIdAvailable(tx, loginId);
      await tx.customerAccount.update({
        data: { loginId },
        where: { id: existing.id },
      });
    }
    return { created: false, id: existing.id };
  }
  const loginId = input.loginId ?? await generateReadableLoginId(tx, input.email);
  await assertLoginIdAvailable(tx, loginId);
  const id = randomUUID();
  await tx.customerAccount.create({
    data: {
      customerId: input.customerId,
      displayName: input.displayName,
      email: input.email,
      id,
      issuer,
      loginId,
      shopId: input.shopId,
      status: 'INACTIVE',
      subject: id,
    },
  });
  return { created: true, id };
}

async function assertLoginIdAvailable(tx: Prisma.TransactionClient, loginId: string): Promise<void> {
  const existing = await tx.customerAccount.findUnique({
    select: { id: true },
    where: { loginId },
  });
  if (existing !== null) throw new DsvCustomerAccountServiceError('LOGIN_ID_EXISTS', 'loginId is already in use');
}

async function generateReadableLoginId(tx: Prisma.TransactionClient, email: string): Promise<string> {
  const base = loginIdBaseFromEmail(email);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const suffix = attempt === 0 ? '' : `-${randomBytes(2).toString('hex')}`;
    const candidate = `${base}${suffix}`.slice(0, 64);
    const existing = await tx.customerAccount.findUnique({
      select: { id: true },
      where: { loginId: candidate },
    });
    if (existing === null) return candidate;
  }
  throw new DsvCustomerAccountServiceError('LOGIN_ID_EXISTS', 'A unique loginId could not be generated');
}

function loginIdBaseFromEmail(email: string): string {
  const localPart = email.split('@')[0] ?? 'customer';
  const sanitized = localPart
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^[^a-z0-9]+/u, '')
    .replace(/[^a-z0-9]+$/u, '')
    .replace(/[._-]{2,}/gu, '-');
  if (sanitized.length >= 3 && /^[a-z0-9]/u.test(sanitized)) return sanitized.slice(0, 48);
  return `customer-${randomBytes(2).toString('hex')}`;
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
