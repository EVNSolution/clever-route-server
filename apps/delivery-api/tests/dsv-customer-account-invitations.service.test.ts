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
    harness.prisma.customerAccount.findUnique.mockResolvedValue(null);
    harness.tx.dsvCustomerAccountInvite.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(harness.service.complete({
      loginId: 'customer-login',
      password: 'StrongPassw0rd!',
      requestId: 'req-1',
      shopDomain: 'tomatonofood.com',
      token,
    })).rejects.toMatchObject({ code: 'INVALID_TOKEN' });

    harness.tx.dsvCustomerAccountInvite.updateMany.mockResolvedValueOnce({ count: 1 });
    harness.tx.customerAccount.update.mockResolvedValueOnce({
      customerId,
      id: accountId,
      scopeVersion: 2,
      shopId,
    });
    await expect(harness.service.complete({
      loginId: 'customer-login',
      password: 'StrongPassw0rd!',
      requestId: 'req-2',
      shopDomain: 'tomatonofood.com',
      token,
    })).resolves.toMatchObject({
      accountId,
      customerId,
      scopeVersion: 2,
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

  test('creates signup invites with fragment links, token hashes only in storage, and redacted audit', async () => {
    const harness = createHarness();
    harness.prisma.shop.findUnique.mockResolvedValueOnce({ id: shopId, shopDomain: 'tomatonofood.com' });
    harness.prisma.shop.findUnique.mockResolvedValueOnce({ customers: [{ displayName: '토마토물류', id: customerId }] });
    harness.tx.customerAccount.findFirst.mockResolvedValue(null);
    harness.tx.customerAccount.findUniqueOrThrow.mockResolvedValue(accountWithInvite());

    const result = await harness.service.createSignupInvitation({
      actorId: 'admin-1',
      customerId,
      displayName: '고객 운영자',
      email: 'Customer@Example.com',
      requestId: 'req-invite',
      shopDomain: 'tomatonofood.com',
    });

    const sendCalls = harness.manualEmailService.send.mock.calls as unknown as Array<[{ textContent: string }]>;
    const emailBody = sendCalls[0]?.[0].textContent ?? '';
    const token = /#token=([A-Za-z0-9_-]+)/u.exec(emailBody)?.[1] ?? '';
    expect(token).not.toBe('');
    expect(emailBody).toContain('https://dsv.example.com/customer/account/setup#token=');
    expect(JSON.stringify(result)).not.toContain(token);
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
      requestId: 'req-existing',
      shopDomain: 'tomatonofood.com',
    })).rejects.toMatchObject({ code: 'ACCOUNT_EXISTS' });

    expect(harness.tx.customerAccount.findFirst.mock.calls[0]?.[0]).toMatchObject({
      where: { issuer: 'CLEVER_DSV' },
    });
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
      loginId: null,
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

function accountWithInvite() {
  return {
    displayName: '고객 운영자',
    email: 'customer@example.com',
    id: accountId,
    invites: [{
      createdAt: new Date('2026-08-09T01:00:00.000Z'),
      expiresAt: new Date('2026-08-11T01:00:00.000Z'),
    }],
    lastAuthenticatedAt: null,
    loginId: null,
    passwordHash: null,
    status: 'INACTIVE',
  };
}
