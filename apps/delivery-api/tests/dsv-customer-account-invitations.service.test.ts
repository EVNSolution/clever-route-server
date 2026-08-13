import { scrypt } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';

import {
  DsvCustomerAccountServiceError,
  loadDsvCustomerAccountWebPublicOrigin,
  PrismaDsvCustomerAccountService,
} from '../src/modules/dsv/dsv-customer-account-invitations.service.js';
import { defaultDsvOperationalSettings } from '../src/modules/dsv/dsv-operational-settings.js';
import { defaultRouteOpsUiSettings } from '../src/modules/route-ops/route-ops-ui-settings.js';
import { defaultRouteScopeConfig } from '../src/modules/route-ops/route-scope-config.js';

const shopId = '99999999-9999-4999-8999-999999999999';
const customerId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const accountId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const activeSessionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const token = 'valid_token_value_12345678901234567890';

describe('PrismaDsvCustomerAccountService', () => {
  test('validates http(s) DSV web public origins only', () => {
    expect(loadDsvCustomerAccountWebPublicOrigin('https://dsv.example.com')).toBe('https://dsv.example.com');
    expect(loadDsvCustomerAccountWebPublicOrigin('')).toBeUndefined();
    expect(() => loadDsvCustomerAccountWebPublicOrigin('https://dsv.example.com/path')).toThrow(/origin/u);
    expect(() => loadDsvCustomerAccountWebPublicOrigin('javascript:alert(1)')).toThrow(/origin/u);
  });

  test('returns null for invalid, expired, consumed, and revoked invite tokens', async () => {
    const harness = createHarness();
    const service = harness.service;

    harness.prisma.dsvCustomerAccountInvite.findUnique.mockResolvedValueOnce(null);
    await expect(service.validateInvitation({ shopDomain: 'tomatonofood.com', token }))
      .resolves.toBeNull();

    harness.prisma.dsvCustomerAccountInvite.findUnique.mockResolvedValueOnce(invite({ expiresAt: new Date('2000-01-01T00:00:00.000Z') }));
    await expect(service.validateInvitation({ shopDomain: 'tomatonofood.com', token }))
      .resolves.toBeNull();

    harness.prisma.dsvCustomerAccountInvite.findUnique.mockResolvedValueOnce(invite({ consumedAt: new Date() }));
    await expect(service.validateInvitation({ shopDomain: 'tomatonofood.com', token }))
      .resolves.toBeNull();

    harness.prisma.dsvCustomerAccountInvite.findUnique.mockResolvedValueOnce(invite({ revokedAt: new Date() }));
    await expect(service.validateInvitation({ shopDomain: 'tomatonofood.com', token }))
      .resolves.toBeNull();
  });

  test('completes an invite once and rejects a consumed race', async () => {
    const harness = createHarness();
    harness.prisma.dsvCustomerAccountInvite.findUnique.mockResolvedValue(invite());
    harness.tx.dsvCustomerAccountInvite.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(harness.service.complete({
      password: 'StrongPassw0rd!',
      requestId: 'req-1',
      shopDomain: 'tomatonofood.com',
      token,
    })).rejects.toMatchObject({ code: 'INVALID_TOKEN' });

    harness.tx.dsvCustomerAccountInvite.updateMany.mockResolvedValueOnce({ count: 1 });
    harness.tx.customerAccount.update.mockResolvedValueOnce({
      activeSessionId,
      customerId,
      id: accountId,
      shopId,
    });
    await expect(harness.service.complete({
      password: 'StrongPassw0rd!',
      requestId: 'req-2',
      shopDomain: 'tomatonofood.com',
      token,
    })).resolves.toMatchObject({
      accountId,
      activeSessionId,
      customerId,
      shopDomain: 'tomatonofood.com',
      shopId,
    });
    const consumeCalls = harness.tx.dsvCustomerAccountInvite.updateMany.mock.calls as unknown as Array<[{
      data: { consumedAt?: unknown };
      where: { consumedAt?: unknown; id?: unknown; revokedAt?: unknown };
    }]>;
    expect(consumeCalls.at(-1)?.[0].data.consumedAt).toBeInstanceOf(Date);
    expect(consumeCalls.at(-1)?.[0].where).toMatchObject({ consumedAt: null, id: 'invite-1', revokedAt: null });
  });

  test('rejects the current and immediately previous passwords during password reset', async () => {
    const currentPassword = 'CurrentStrongPassw0rd!';
    const previousPassword = 'PreviousStrongPassw0rd!';
    const currentPasswordSalt = 'current-customer-salt';
    const previousPasswordSalt = 'previous-customer-salt';
    const resetInvite = invite({
      account: {
        displayName: '고객 운영자',
        email: 'customer@example.com',
        loginId: 'customer-login',
        passwordHash: await hashPassword(currentPassword, currentPasswordSalt),
        passwordSalt: currentPasswordSalt,
        previousPasswordHash: await hashPassword(previousPassword, previousPasswordSalt),
        previousPasswordSalt,
      },
      purpose: 'PASSWORD_RESET',
    });

    for (const password of [currentPassword, previousPassword]) {
      const harness = createHarness();
      harness.prisma.dsvCustomerAccountInvite.findUnique.mockResolvedValueOnce(resetInvite);
      await expect(harness.service.complete({
        password,
        requestId: 'req-reused-password',
        shopDomain: 'tomatonofood.com',
        token,
      })).rejects.toMatchObject({ code: 'PASSWORD_REUSED' });
      expect(harness.tx.dsvCustomerAccountInvite.updateMany).not.toHaveBeenCalled();
    }

    const harness = createHarness();
    harness.prisma.dsvCustomerAccountInvite.findUnique.mockResolvedValueOnce(resetInvite);
    harness.tx.customerAccount.update.mockResolvedValueOnce({ activeSessionId, customerId, id: accountId, shopId });
    await expect(harness.service.complete({
      password: 'FreshStrongPassw0rd!',
      requestId: 'req-fresh-password',
      shopDomain: 'tomatonofood.com',
      token,
    })).resolves.toMatchObject({ accountId, activeSessionId });
    const updateCalls = harness.tx.customerAccount.update.mock.calls as unknown as Array<[{
      data: { previousPasswordHash?: string; previousPasswordSalt?: string };
    }]>;
    expect(updateCalls[0]?.[0].data.previousPasswordHash).toBe(resetInvite.account.passwordHash);
    expect(updateCalls[0]?.[0].data.previousPasswordSalt).toBe(currentPasswordSalt);
  });

  test('rotates the active session ID on every successful customer login', async () => {
    const harness = createHarness();
    const password = 'StrongPassw0rd!';
    const passwordSalt = 'customer-login-salt';
    const passwordHash = await hashPassword(password, passwordSalt);
    harness.prisma.customerAccount.findUnique.mockResolvedValueOnce({
      customerId,
      id: accountId,
      issuer: 'CLEVER_DSV',
      passwordHash,
      passwordSalt,
      activeSessionId: null,
      shop: { id: shopId, shopDomain: 'tomatonofood.com' },
      shopId,
      status: 'ACTIVE',
    });
    harness.prisma.customerAccount.update.mockResolvedValueOnce({
      activeSessionId,
      customerId,
      id: accountId,
      shopId,
    });

    await expect(harness.service.login({
      id: 'customer-login',
      password,
      requestId: 'req-login',
      shopDomain: 'tomatonofood.com',
    })).resolves.toMatchObject({ accountId, activeSessionId });
    const updateCalls = harness.prisma.customerAccount.update.mock.calls as unknown as Array<[{
      data: { activeSessionId: string; lastAuthenticatedAt: unknown };
      where: { id: string };
    }]>;
    expect(updateCalls[0]?.[0].data.lastAuthenticatedAt).toBeInstanceOf(Date);
    expect(updateCalls[0]?.[0].data.activeSessionId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(updateCalls[0]?.[0].where).toEqual({ id: accountId });
  });

  test('creates signup invites with fragment links, token hashes only in storage, and redacted audit', async () => {
    const harness = createHarness();
    harness.prisma.shop.findUnique.mockResolvedValueOnce({ id: shopId, shopDomain: 'tomatonofood.com' });
    harness.prisma.shop.findUnique.mockResolvedValueOnce({ customers: [{ displayName: '토마토물류', id: customerId }] });
    harness.tx.customerAccount.findFirst.mockResolvedValue(null);
    harness.tx.customerAccount.findUniqueOrThrow.mockResolvedValue(accountWithInvite({ loginId: 'tomato-customer' }));

    const result = await harness.service.createSignupInvitation({
      actorId: 'admin-1',
      customerId,
      displayName: '고객 운영자',
      email: 'Customer@Example.com',
      loginId: 'tomato-customer',
      requestId: 'req-invite',
      shopDomain: 'tomatonofood.com',
    });

    const sendCalls = harness.manualEmailService.send.mock.calls as unknown as Array<[{ textContent: string }]>;
    const emailBody = sendCalls[0]?.[0].textContent ?? '';
    const token = /#token=([A-Za-z0-9_-]+)/u.exec(emailBody)?.[1] ?? '';
    expect(token).not.toBe('');
    expect(emailBody).toContain('https://dsv.example.com/customer/account/setup#token=');
    expect(emailBody).toContain('예약된 로그인 ID: tomato-customer');
    expect(emailBody).toContain('https://dsv.example.com/customer/login');
    expect(JSON.stringify(result)).not.toContain(token);
    expect(result.account.loginId).toBe('tomato-customer');
    const accountCreateCalls = harness.tx.customerAccount.create.mock.calls as unknown as Array<[{ data: { loginId: string } }]>;
    expect(accountCreateCalls[0]?.[0].data.loginId).toBe('tomato-customer');
    const inviteCreateCalls = harness.tx.dsvCustomerAccountInvite.create.mock.calls as unknown as Array<[{ data: { tokenHash: string } }]>;
    const auditCreateCalls = harness.tx.dsvAuditEvent.create.mock.calls as unknown as Array<[{ data: unknown }]>;
    expect(inviteCreateCalls[0]?.[0].data.tokenHash).not.toBe(token);
    expect(inviteCreateCalls[0]?.[0].data.tokenHash).toHaveLength(64);
    expect(JSON.stringify(auditCreateCalls[0]?.[0].data)).not.toContain(token);
    const revokeCalls = harness.tx.dsvCustomerAccountInvite.updateMany.mock.calls as unknown as Array<[{
      data: { revokedAt?: unknown };
      where: { consumedAt?: unknown; purpose?: unknown; revokedAt?: unknown };
    }]>;
    expect(revokeCalls[0]?.[0].data.revokedAt).toBeInstanceOf(Date);
    expect(revokeCalls[0]?.[0].where).toMatchObject({ consumedAt: null, purpose: 'SIGNUP', revokedAt: null });
  });

  test('requires configured web origin before sending invitation links', async () => {
    const harness = createHarness({ webPublicOrigin: undefined });
    harness.prisma.shop.findUnique.mockResolvedValueOnce({ id: shopId, shopDomain: 'tomatonofood.com' });
    harness.prisma.shop.findUnique.mockResolvedValueOnce({ customers: [{ displayName: '토마토물류', id: customerId }] });
    harness.tx.customerAccount.findFirst.mockResolvedValue(null);
    harness.tx.customerAccount.findUniqueOrThrow.mockResolvedValue(accountWithInvite());

    await expect(harness.service.createSignupInvitation({
      actorId: 'admin-1',
      customerId,
      email: 'customer@example.com',
      generateLoginId: true,
      requestId: 'req-invite',
      shopDomain: 'tomatonofood.com',
    })).rejects.toBeInstanceOf(DsvCustomerAccountServiceError);
    expect(harness.manualEmailService.send).not.toHaveBeenCalled();
  });

  test('does not reuse activated or external customer identities for signup invitations', async () => {
    const harness = createHarness();
    harness.prisma.shop.findUnique.mockResolvedValueOnce({ id: shopId, shopDomain: 'tomatonofood.com' });
    harness.prisma.shop.findUnique.mockResolvedValueOnce({ customers: [{ displayName: '토마토물류', id: customerId }] });
    harness.tx.customerAccount.findFirst.mockResolvedValueOnce({
      id: accountId,
      loginId: 'existing-login',
      passwordHash: 'existing-hash',
    });

    await expect(harness.service.createSignupInvitation({
      actorId: 'admin-1',
      customerId,
      email: 'customer@example.com',
      loginId: 'existing-login',
      requestId: 'req-existing',
      shopDomain: 'tomatonofood.com',
    })).rejects.toMatchObject({ code: 'ACCOUNT_EXISTS' });

    expect(harness.tx.customerAccount.findFirst.mock.calls[0]?.[0]).toMatchObject({
      where: { issuer: 'CLEVER_DSV' },
    });
    expect(harness.tx.dsvCustomerAccountInvite.create).not.toHaveBeenCalled();
    expect(harness.manualEmailService.send).not.toHaveBeenCalled();
  });

  test('generates a readable loginId before emailing signup invitations', async () => {
    const harness = createHarness();
    harness.prisma.shop.findUnique.mockResolvedValueOnce({ id: shopId, shopDomain: 'tomatonofood.com' });
    harness.prisma.shop.findUnique.mockResolvedValueOnce({ customers: [{ displayName: '토마토물류', id: customerId }] });
    harness.tx.customerAccount.findFirst.mockResolvedValue(null);
    harness.tx.customerAccount.findUnique.mockResolvedValueOnce(null);
    harness.tx.customerAccount.findUniqueOrThrow.mockResolvedValue(accountWithInvite({ loginId: 'customer' }));

    const result = await harness.service.createSignupInvitation({
      actorId: 'admin-1',
      customerId,
      displayName: '고객 운영자',
      email: 'Customer@Example.com',
      generateLoginId: true,
      requestId: 'req-generated',
      shopDomain: 'tomatonofood.com',
    });

    expect(result.account.loginId).toBe('customer');
    const accountCreateCalls = harness.tx.customerAccount.create.mock.calls as unknown as Array<[{ data: { loginId: string } }]>;
    expect(accountCreateCalls[0]?.[0].data.loginId).toBe('customer');
    const sendCalls = harness.manualEmailService.send.mock.calls as unknown as Array<[{ textContent: string }]>;
    const emailBody = sendCalls[0]?.[0].textContent ?? '';
    expect(emailBody).toContain('예약된 로그인 ID: customer');
  });

  test('rejects duplicate explicit loginIds before sending signup invitations', async () => {
    const harness = createHarness();
    harness.prisma.shop.findUnique.mockResolvedValueOnce({ id: shopId, shopDomain: 'tomatonofood.com' });
    harness.prisma.shop.findUnique.mockResolvedValueOnce({ customers: [{ displayName: '토마토물류', id: customerId }] });
    harness.tx.customerAccount.findFirst.mockResolvedValue(null);
    harness.tx.customerAccount.findUnique.mockResolvedValueOnce({ id: 'other-account' } as never);

    await expect(harness.service.createSignupInvitation({
      actorId: 'admin-1',
      customerId,
      email: 'customer@example.com',
      loginId: 'taken-login',
      requestId: 'req-duplicate-login',
      shopDomain: 'tomatonofood.com',
    })).rejects.toMatchObject({ code: 'LOGIN_ID_EXISTS' });
    expect(harness.tx.dsvCustomerAccountInvite.create).not.toHaveBeenCalled();
    expect(harness.manualEmailService.send).not.toHaveBeenCalled();
  });

  test('allows lifecycle controls only for local activated customer accounts', async () => {
    const harness = createHarness();
    harness.prisma.customerAccount.findFirst.mockResolvedValueOnce({
      customerId,
      email: 'customer@example.com',
      id: accountId,
      issuer: 'CLEVER_DSV',
      loginId: 'customer-login',
      passwordHash: 'password-hash',
      passwordSalt: 'password-salt',
      shop: { id: shopId, shopDomain: 'tomatonofood.com' },
      shopId,
      status: 'ACTIVE',
    });
    await expect(harness.service.reinvite({
      accountId,
      actorId: 'admin-1',
      requestId: 'req-reinvite-active',
      shopDomain: 'tomatonofood.com',
    })).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    harness.prisma.customerAccount.findFirst.mockResolvedValueOnce({
      customerId,
      email: 'customer@example.com',
      id: accountId,
      issuer: 'CLEVER_DSV',
      loginId: null,
      passwordHash: null,
      passwordSalt: null,
      shop: { id: shopId, shopDomain: 'tomatonofood.com' },
      shopId,
      status: 'INACTIVE',
    });
    await expect(harness.service.setStatus({
      accountId,
      actorId: 'admin-1',
      requestId: 'req-enable-unclaimed',
      shopDomain: 'tomatonofood.com',
      status: 'ACTIVE',
    })).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(harness.prisma.customerAccount.findFirst.mock.calls[1]?.[0]).toMatchObject({
      where: { issuer: 'CLEVER_DSV' },
    });
  });
});

function createHarness(options: { webPublicOrigin?: string | undefined } = {}) {
  const tx = {
    customerAccount: {
      create: vi.fn(() => Promise.resolve({ id: accountId })),
      findFirst: vi.fn(),
      findUnique: vi.fn(() => Promise.resolve(null)),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
    },
    dsvAuditEvent: { create: vi.fn(() => Promise.resolve({ id: 'audit-1' })) },
    dsvCustomerAccountInvite: {
      create: vi.fn(() => Promise.resolve({ id: 'invite-1' })),
      updateMany: vi.fn(() => Promise.resolve({ count: 1 })),
    },
  };
  const prisma = {
    $transaction: vi.fn((callback: (transaction: typeof tx) => unknown) => callback(tx)),
    customerAccount: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    dsvAuditEvent: { create: vi.fn() },
    dsvCustomerAccountInvite: { findUnique: vi.fn() },
    shop: { findUnique: vi.fn() },
  };
  const manualEmailService = {
    getConfig: vi.fn(),
    send: vi.fn(() => Promise.resolve({ messageId: 'message-1', recipientCount: 1, sentAt: '2026-08-09T01:00:00.000Z' })),
  };
  const settings = defaultDsvOperationalSettings();
  const settingsService = {
    getSettings: vi.fn(() => Promise.resolve({
      defaultDepotAddress: null,
      defaultDepotLatitude: null,
      defaultDepotLongitude: null,
      dsvOperationalSettings: {
        ...settings,
        manualEmailSenderEmail: 'sender@example.com',
        manualEmailSubject: '[CLEVER DSV] 기존 제목',
      },
      locale: 'ko-KR',
      routeOpsUiSettings: defaultRouteOpsUiSettings(),
      routeScopeConfig: defaultRouteScopeConfig(),
      shopDomain: 'tomatonofood.com',
    })),
  };
  return {
    manualEmailService,
    prisma,
    service: new PrismaDsvCustomerAccountService(prisma as never, {
      manualEmailService,
      settingsService,
      ...(options.webPublicOrigin === undefined && Object.hasOwn(options, 'webPublicOrigin')
        ? {}
        : { webPublicOrigin: options.webPublicOrigin ?? 'https://dsv.example.com' }),
    }),
    tx,
  };
}

function invite(overrides: Record<string, unknown> = {}) {
  return {
    account: {
      displayName: '고객 운영자',
      email: 'customer@example.com',
      loginId: 'customer-login',
      passwordHash: null,
      passwordSalt: null,
      previousPasswordHash: null,
      previousPasswordSalt: null,
    },
    accountId,
    consumedAt: null,
    customer: { displayName: '토마토물류', id: customerId },
    expiresAt: new Date(Date.now() + 60_000),
    id: 'invite-1',
    purpose: 'SIGNUP',
    revokedAt: null,
    shop: { id: shopId, shopDomain: 'tomatonofood.com' },
    ...overrides,
  };
}

function accountWithInvite(overrides: Record<string, unknown> = {}) {
  return {
    displayName: '고객 운영자',
    email: 'customer@example.com',
    id: accountId,
    invites: [{
      createdAt: new Date('2026-08-09T01:00:00.000Z'),
      expiresAt: new Date('2026-08-11T01:00:00.000Z'),
    }],
    lastAuthenticatedAt: null,
    loginId: 'customer-login',
    passwordHash: null,
    status: 'INACTIVE',
    ...overrides,
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
