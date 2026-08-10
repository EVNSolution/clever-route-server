import { describe, expect, test, vi } from 'vitest';

import {
  PrismaDsvAdminOperatorInvitationService,
} from '../src/modules/dsv/dsv-admin-account-invitations.service.js';
import { defaultDsvOperationalSettings } from '../src/modules/dsv/dsv-operational-settings.js';
import { dsvAdminScopes, dsvOperatorScopes } from '../src/modules/dsv/dsv-principal.js';
import { defaultRouteOpsUiSettings } from '../src/modules/route-ops/route-ops-ui-settings.js';
import { defaultRouteScopeConfig } from '../src/modules/route-ops/route-scope-config.js';

const shopId = '99999999-9999-4999-8999-999999999999';
const accountId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const token = 'valid_token_value_12345678901234567890';

describe('PrismaDsvAdminOperatorInvitationService', () => {
  test('creates operator invitations with hash-only tokens, revokes prior unused invites, and emails /login', async () => {
    const harness = createHarness();
    harness.prisma.shop.findUnique.mockResolvedValueOnce({ id: shopId, shopDomain: 'tomatonofood.com' });
    harness.prisma.dsvAdminAccount.findUnique.mockResolvedValueOnce(null);

    const result = await harness.service.createInvitation({
      actorId: accountId,
      displayName: 'DSV 운영자',
      email: 'Operator@Example.com',
      message: 'DSV 관제팀에서 사용할 계정입니다.',
      requestId: 'req-invite',
      shopDomain: 'tomatonofood.com',
    });

    const sendCalls = harness.manualEmailService.send.mock.calls as unknown as Array<[{ textContent: string }]>;
    const emailBody = sendCalls[0]?.[0].textContent ?? '';
    const tokenFromEmail = /#token=([A-Za-z0-9_-]+)/u.exec(emailBody)?.[1] ?? '';
    expect(tokenFromEmail).not.toBe('');
    expect(emailBody).toContain('https://dsv.example.com/admin/account/setup#token=');
    expect(emailBody).toContain('https://dsv.example.com/login');
    expect(emailBody).toContain('48시간');
    expect(emailBody).toContain('한 번만');
    expect(emailBody).toContain('DSV 관제팀에서 사용할 계정입니다.');
    expect(JSON.stringify(result)).not.toContain(tokenFromEmail);
    const revokeCalls = harness.tx.dsvAdminAccountInvite.updateMany.mock.calls as unknown as Array<[{
      data: { revokedAt?: unknown };
      where: { consumedAt?: unknown; email?: string; revokedAt?: unknown; shopId?: string };
    }]>;
    expect(revokeCalls[0]?.[0].data.revokedAt).toBeInstanceOf(Date);
    expect(revokeCalls[0]?.[0].where).toMatchObject({
      consumedAt: null,
      email: 'operator@example.com',
      revokedAt: null,
      shopId,
    });
    const createCalls = harness.tx.dsvAdminAccountInvite.create.mock.calls as unknown as Array<[{ data: { tokenHash: string } }]>;
    expect(createCalls[0]?.[0].data.tokenHash).not.toBe(tokenFromEmail);
    expect(createCalls[0]?.[0].data.tokenHash).toHaveLength(64);
  });

  test('revokes the freshly-created invite if email sending fails', async () => {
    const harness = createHarness();
    harness.prisma.shop.findUnique.mockResolvedValueOnce({ id: shopId, shopDomain: 'tomatonofood.com' });
    harness.prisma.dsvAdminAccount.findUnique.mockResolvedValueOnce(null);
    harness.manualEmailService.send.mockRejectedValueOnce(new Error('email failed'));

    await expect(harness.service.createInvitation({
      actorId: accountId,
      email: 'operator@example.com',
      requestId: 'req-send-fail',
      shopDomain: 'tomatonofood.com',
    })).rejects.toThrow(/email failed/u);

    const revokedAtMatcher: Date = expect.any(Date) as Date;
    expect(harness.prisma.dsvAdminAccountInvite.updateMany).toHaveBeenCalledWith({
      data: { revokedAt: revokedAtMatcher },
      where: {
        consumedAt: null,
        id: 'invite-1',
        revokedAt: null,
      },
    });
  });

  test('validates only unexpired unused tokens for the requested shop', async () => {
    const harness = createHarness();
    harness.prisma.dsvAdminAccountInvite.findUnique.mockResolvedValueOnce(null);
    await expect(harness.service.validateInvitation({ shopDomain: 'tomatonofood.com', token }))
      .resolves.toBeNull();

    harness.prisma.dsvAdminAccountInvite.findUnique.mockResolvedValueOnce(invite({ shop: { id: shopId, shopDomain: 'other.example.com' } }));
    await expect(harness.service.validateInvitation({ shopDomain: 'tomatonofood.com', token }))
      .resolves.toBeNull();

    harness.prisma.dsvAdminAccountInvite.findUnique.mockResolvedValueOnce(invite({ consumedAt: new Date() }));
    await expect(harness.service.validateInvitation({ shopDomain: 'tomatonofood.com', token }))
      .resolves.toBeNull();

    harness.prisma.dsvAdminAccountInvite.findUnique.mockResolvedValueOnce(invite());
    await expect(harness.service.validateInvitation({ shopDomain: 'tomatonofood.com', token }))
      .resolves.toMatchObject({ email: 'operator@example.com' });
  });

  test('consumes an invitation once and creates an ACTIVE DSV admin account with operator scopes only', async () => {
    const harness = createHarness();
    harness.prisma.dsvAdminAccountInvite.findUnique.mockResolvedValue(invite());
    harness.tx.dsvAdminAccountInvite.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(harness.service.complete({
      loginId: 'operator-login',
      password: 'StrongPassw0rd!',
      requestId: 'req-race',
      shopDomain: 'tomatonofood.com',
      token,
    })).rejects.toMatchObject({ code: 'INVALID_TOKEN' });

    harness.tx.dsvAdminAccountInvite.updateMany.mockResolvedValueOnce({ count: 1 });
    harness.tx.dsvAdminAccount.findUnique.mockResolvedValueOnce(null);
    harness.tx.dsvAdminAccount.findUnique.mockResolvedValueOnce(null);
    harness.tx.dsvAdminAccount.create.mockResolvedValueOnce(account());
    await expect(harness.service.complete({
      loginId: 'Operator-Login',
      password: 'StrongPassw0rd!',
      requestId: 'req-complete',
      shopDomain: 'tomatonofood.com',
      token,
    })).resolves.toMatchObject({
      email: 'operator@example.com',
      loginId: 'operator-login',
      scopes: dsvOperatorScopes,
      status: 'ACTIVE',
    });

    const createCalls = harness.tx.dsvAdminAccount.create.mock.calls as unknown as Array<[{ data: { scopes: string[]; status: string } }]>;
    expect(createCalls[0]?.[0].data.scopes).toEqual(dsvOperatorScopes);
    expect(createCalls[0]?.[0].data.status).toBe('ACTIVE');
  });

  test('updates credentials only after current password verification and increments tokenVersion', async () => {
    const harness = createHarness();
    harness.prisma.dsvAdminAccount.findFirst.mockResolvedValueOnce(null);

    await expect(harness.service.updateCredentials({
      accountId,
      currentPassword: 'wrong-password',
      loginId: 'operator-new',
    })).rejects.toMatchObject({ code: 'CURRENT_PASSWORD_INVALID' });

    const existing = account({ passwordHash: 'u8cQd0OCZBOk6AIvkd2Yhdo-y2lZ_TINAqO12jhqiVRlNq3PraljjgTaSYKPmlr5y4XedfYMh98iADbAbdwlcw', passwordSalt: 'known-salt', scopes: dsvAdminScopes });
    harness.prisma.dsvAdminAccount.findFirst.mockResolvedValueOnce(existing);
    harness.prisma.dsvAdminAccount.findUnique.mockResolvedValueOnce(null);
    harness.prisma.dsvAdminAccount.update.mockResolvedValueOnce(account({ loginId: 'operator-new', scopes: dsvAdminScopes, tokenVersion: 2 }));

    await expect(harness.service.updateCredentials({
      accountId,
      currentPassword: 'KnownStrongPassw0rd!',
      loginId: 'operator-new',
      password: 'NewStrongPassw0rd!',
    })).resolves.toMatchObject({ loginId: 'operator-new', scopes: dsvAdminScopes, tokenVersion: 2 });
    const updateCalls = harness.prisma.dsvAdminAccount.update.mock.calls as unknown as Array<[{
      data: { tokenVersion: { increment: number }; passwordHash?: string; passwordSalt?: string };
    }]>;
    expect(updateCalls[0]?.[0].data.tokenVersion).toEqual({ increment: 1 });
    expect(updateCalls[0]?.[0].data.passwordHash).toEqual(expect.any(String));
    expect(updateCalls[0]?.[0].data.passwordSalt).toEqual(expect.any(String));
  });

  test('maps unique races to public operator invitation errors', async () => {
    const harness = createHarness();
    harness.prisma.dsvAdminAccountInvite.findUnique.mockResolvedValue(invite());
    harness.tx.dsvAdminAccountInvite.updateMany.mockResolvedValueOnce({ count: 1 });
    harness.tx.dsvAdminAccount.findUnique.mockResolvedValueOnce(null);
    harness.tx.dsvAdminAccount.findUnique.mockResolvedValueOnce(null);
    harness.tx.dsvAdminAccount.create.mockRejectedValueOnce({ code: 'P2002', meta: { target: ['email'] } });

    await expect(harness.service.complete({
      loginId: 'operator-login',
      password: 'StrongPassw0rd!',
      requestId: 'req-race-email',
      shopDomain: 'tomatonofood.com',
      token,
    })).rejects.toMatchObject({ code: 'ACCOUNT_EXISTS' });

    const credentialsHarness = createHarness();
    credentialsHarness.prisma.dsvAdminAccount.findFirst.mockResolvedValueOnce(account({
      passwordHash: 'u8cQd0OCZBOk6AIvkd2Yhdo-y2lZ_TINAqO12jhqiVRlNq3PraljjgTaSYKPmlr5y4XedfYMh98iADbAbdwlcw',
      passwordSalt: 'known-salt',
    }));
    credentialsHarness.prisma.dsvAdminAccount.findUnique.mockResolvedValueOnce(null);
    credentialsHarness.prisma.dsvAdminAccount.update.mockRejectedValueOnce({ code: 'P2002', meta: { target: ['loginId'] } });
    await expect(credentialsHarness.service.updateCredentials({
      accountId,
      currentPassword: 'KnownStrongPassw0rd!',
      loginId: 'operator-new',
    })).rejects.toMatchObject({ code: 'LOGIN_ID_EXISTS' });
  });
});

function createHarness(options: { webPublicOrigin?: string | undefined } = {}) {
  const tx = {
    dsvAdminAccount: {
      create: vi.fn(),
      findUnique: vi.fn(() => Promise.resolve(null)),
    },
    dsvAdminAccountInvite: {
      create: vi.fn(() => Promise.resolve(invite())),
      updateMany: vi.fn(() => Promise.resolve({ count: 1 })),
    },
  };
  const prisma = {
    $transaction: vi.fn((callback: (transaction: typeof tx) => unknown) => callback(tx)),
    dsvAdminAccount: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    dsvAdminAccountInvite: {
      findUnique: vi.fn(),
      updateMany: vi.fn(() => Promise.resolve({ count: 1 })),
    },
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
    service: new PrismaDsvAdminOperatorInvitationService(prisma as never, {
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
    consumedAt: null,
    createdAt: new Date('2026-08-09T01:00:00.000Z'),
    createdBy: accountId,
    displayName: 'DSV 운영자',
    email: 'operator@example.com',
    expiresAt: new Date(Date.now() + 60_000),
    id: 'invite-1',
    revokedAt: null,
    shop: { id: shopId, shopDomain: 'tomatonofood.com' },
    shopId,
    tokenHash: 'hash',
    ...overrides,
  };
}

function account(overrides: Record<string, unknown> = {}) {
  return {
    createdAt: new Date('2026-08-09T01:00:00.000Z'),
    displayName: 'DSV 운영자',
    email: 'operator@example.com',
    id: accountId,
    lastAuthenticatedAt: new Date('2026-08-09T01:00:00.000Z'),
    loginId: 'operator-login',
    passwordHash: 'hash',
    passwordSalt: 'salt',
    scopes: dsvOperatorScopes,
    status: 'ACTIVE',
    tokenVersion: 1,
    updatedAt: new Date('2026-08-09T01:00:00.000Z'),
    ...overrides,
  };
}
