import { scrypt } from 'node:crypto';
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
const activeSessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const token = 'valid_token_value_12345678901234567890';
const credentialContext = { requestId: 'req-credentials', shopDomain: 'tomatonofood.com' };

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
    const auditCalls = harness.tx.dsvAuditEvent.create.mock.calls as unknown as Array<[{ data: Record<string, unknown> }]>;
    expect(auditCalls[0]?.[0].data).toMatchObject({
      actorId: accountId,
      entityId: 'invite-1',
      eventType: 'DSV_ADMIN_ACCOUNT_INVITATION_CREATED',
      requestId: 'req-invite',
      shopId,
    });
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
    const auditCalls = harness.tx.dsvAuditEvent.create.mock.calls as unknown as Array<[{ data: Record<string, unknown> }]>;
    expect(auditCalls.at(-1)?.[0].data).toMatchObject({ eventType: 'DSV_ADMIN_ACCOUNT_INVITATION_DELIVERY_FAILED' });
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
    const auditCalls = harness.tx.dsvAuditEvent.create.mock.calls as unknown as Array<[{ data: Record<string, unknown> }]>;
    expect(auditCalls.at(-1)?.[0].data).toMatchObject({
      actorId: accountId,
      entityId: accountId,
      eventType: 'DSV_ADMIN_ACCOUNT_ACTIVATED',
      requestId: 'req-complete',
      shopId,
    });
  });

  test('updates credentials only after current password verification and rotates the active session ID', async () => {
    const harness = createHarness();
    harness.prisma.dsvAdminAccount.findFirst.mockResolvedValueOnce(null);

    await expect(harness.service.updateCredentials({
      accountId,
      currentPassword: 'wrong-password',
      loginId: 'operator-new',
      ...credentialContext,
    })).rejects.toMatchObject({ code: 'CURRENT_PASSWORD_INVALID' });

    const previousPasswordSalt = 'previous-salt';
    const previousPasswordHash = await hashPassword('PreviousStrongPassw0rd!', previousPasswordSalt);
    const existing = account({
      passwordHash: 'u8cQd0OCZBOk6AIvkd2Yhdo-y2lZ_TINAqO12jhqiVRlNq3PraljjgTaSYKPmlr5y4XedfYMh98iADbAbdwlcw',
      passwordSalt: 'known-salt',
      previousPasswordHash,
      previousPasswordSalt,
      scopes: dsvAdminScopes,
    });
    harness.prisma.dsvAdminAccount.findFirst.mockResolvedValueOnce(existing);
    await expect(harness.service.updateCredentials({
      accountId,
      currentPassword: 'KnownStrongPassw0rd!',
      password: 'KnownStrongPassw0rd!',
      ...credentialContext,
    })).rejects.toMatchObject({ code: 'PASSWORD_REUSED' });

    harness.prisma.dsvAdminAccount.findFirst.mockResolvedValueOnce(existing);
    await expect(harness.service.updateCredentials({
      accountId,
      currentPassword: 'KnownStrongPassw0rd!',
      password: 'PreviousStrongPassw0rd!',
      ...credentialContext,
    })).rejects.toMatchObject({ code: 'PASSWORD_REUSED' });

    harness.prisma.dsvAdminAccount.findFirst.mockResolvedValueOnce(account({ ...existing, mustChangePassword: true }));
    await expect(harness.service.updateCredentials({
      accountId,
      currentPassword: 'KnownStrongPassw0rd!',
      loginId: 'operator-new',
      ...credentialContext,
    })).rejects.toMatchObject({ code: 'PASSWORD_CHANGE_REQUIRED' });

    harness.prisma.dsvAdminAccount.findFirst.mockResolvedValueOnce(existing);
    await expect(harness.service.updateCredentials({
      accountId,
      currentPassword: 'KnownStrongPassw0rd!',
      loginId: existing.loginId,
      ...credentialContext,
    })).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    harness.prisma.dsvAdminAccount.findFirst.mockResolvedValueOnce(existing);
    harness.prisma.dsvAdminAccount.findUnique.mockResolvedValueOnce(null);
    harness.prisma.dsvAdminAccount.update.mockResolvedValueOnce(account({ activeSessionId, loginId: 'operator-new', scopes: dsvAdminScopes }));

    await expect(harness.service.updateCredentials({
      accountId,
      currentPassword: 'KnownStrongPassw0rd!',
      loginId: 'operator-new',
      password: 'NewStrongPassw0rd!',
      ...credentialContext,
    })).resolves.toMatchObject({ activeSessionId, loginId: 'operator-new', scopes: dsvAdminScopes });
    const updateCalls = harness.prisma.dsvAdminAccount.update.mock.calls as unknown as Array<[{
      data: {
        activeSessionId: string;
        passwordHash?: string;
        passwordSalt?: string;
        mustChangePassword?: boolean;
        previousPasswordHash?: string;
        previousPasswordSalt?: string;
      };
    }]>;
    expect(updateCalls[0]?.[0].data.activeSessionId).toEqual(expect.any(String));
    expect(updateCalls[0]?.[0].data.passwordHash).toEqual(expect.any(String));
    expect(updateCalls[0]?.[0].data.passwordSalt).toEqual(expect.any(String));
    expect(updateCalls.at(-1)?.[0].data.mustChangePassword).toBe(false);
    expect(updateCalls[0]?.[0].data.previousPasswordHash).toBe(existing.passwordHash);
    expect(updateCalls[0]?.[0].data.previousPasswordSalt).toBe(existing.passwordSalt);
    const auditCalls = harness.tx.dsvAuditEvent.create.mock.calls as unknown as Array<[{ data: Record<string, unknown> }]>;
    expect(auditCalls.at(-1)?.[0].data).toMatchObject({
      actorId: accountId,
      entityId: accountId,
      eventType: 'DSV_ADMIN_ACCOUNT_CREDENTIALS_UPDATED',
      redactedDiff: {
        loginIdChanged: true,
        passwordChanged: true,
        sessionRotated: true,
      },
      requestId: credentialContext.requestId,
      shopId,
    });
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
      ...credentialContext,
    })).rejects.toMatchObject({ code: 'LOGIN_ID_EXISTS' });
  });
});

function createHarness(options: { webPublicOrigin?: string | undefined } = {}) {
  const dsvAdminAccount = {
    create: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(() => Promise.resolve(null)),
    update: vi.fn(),
  };
  const dsvAdminAccountInvite = {
    create: vi.fn(() => Promise.resolve(invite())),
    findUnique: vi.fn(),
    updateMany: vi.fn(() => Promise.resolve({ count: 1 })),
  };
  const dsvAuditEvent = { create: vi.fn(() => Promise.resolve({ id: 'audit-1' })) };
  const tx = {
    dsvAdminAccount,
    dsvAdminAccountInvite,
    dsvAuditEvent,
  };
  const prisma = {
    $transaction: vi.fn((callback: (transaction: typeof tx) => unknown) => callback(tx)),
    dsvAdminAccount,
    dsvAdminAccountInvite,
    dsvAuditEvent,
    shop: { findUnique: vi.fn(() => Promise.resolve({ id: shopId, shopDomain: 'tomatonofood.com' })) },
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
    activeSessionId,
    createdAt: new Date('2026-08-09T01:00:00.000Z'),
    displayName: 'DSV 운영자',
    email: 'operator@example.com',
    id: accountId,
    lastAuthenticatedAt: new Date('2026-08-09T01:00:00.000Z'),
    loginId: 'operator-login',
    mustChangePassword: false,
    passwordHash: 'hash',
    passwordSalt: 'salt',
    previousPasswordHash: null,
    previousPasswordSalt: null,
    scopes: dsvOperatorScopes,
    status: 'ACTIVE',
    updatedAt: new Date('2026-08-09T01:00:00.000Z'),
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
