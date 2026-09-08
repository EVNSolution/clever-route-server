import { createHash, scrypt } from 'node:crypto';
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

  test('returns null for invalid, consumed, revoked, or cross-boundary invites and identifies expiration', async () => {
    const harness = createHarness();
    const service = harness.service;

    harness.prisma.dsvCustomerAccountInvite.findUnique.mockResolvedValueOnce(null);
    await expect(service.validateInvitation({ shopDomain: 'tomatonofood.com', token }))
      .resolves.toBeNull();

    harness.prisma.dsvCustomerAccountInvite.findUnique.mockResolvedValueOnce(invite({ expiresAt: new Date('2000-01-01T00:00:00.000Z') }));
    await expect(service.validateInvitation({ shopDomain: 'tomatonofood.com', token }))
      .rejects.toMatchObject({
        code: 'INVITATION_EXPIRED',
        message: '허용 시간이 초과된 링크입니다. 담당자에게 새 초대 링크를 요청해 주세요.',
      });

    harness.prisma.dsvCustomerAccountInvite.findUnique.mockResolvedValueOnce(invite({ consumedAt: new Date() }));
    await expect(service.validateInvitation({ shopDomain: 'tomatonofood.com', token }))
      .resolves.toBeNull();

    harness.prisma.dsvCustomerAccountInvite.findUnique.mockResolvedValueOnce(invite({ revokedAt: new Date() }));
    await expect(service.validateInvitation({ shopDomain: 'tomatonofood.com', token }))
      .resolves.toBeNull();

    harness.prisma.dsvCustomerAccountInvite.findUnique.mockResolvedValueOnce(invite({
      account: { ...invite().account, customerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    }));
    await expect(service.validateInvitation({ shopDomain: 'tomatonofood.com', token }))
      .resolves.toBeNull();
  });

  test('completes an invite once and rejects a consumed race', async () => {
    const harness = createHarness();
    harness.prisma.dsvCustomerAccountInvite.findUnique.mockResolvedValue(invite());
    harness.tx.dsvCustomerAccountInvite.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(harness.service.complete({
      displayName: '고객 운영자',
      loginId: 'customer-login',
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
      displayName: '고객 운영자',
      loginId: 'customer-login',
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

  test('keeps the explicit expiration result when hashing crosses the invite TTL', async () => {
    const harness = createHarness();
    const initialTime = Date.parse('2026-09-08T00:00:00.000Z');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(initialTime);
    try {
      harness.prisma.dsvCustomerAccountInvite.findUnique.mockResolvedValueOnce(invite({
        expiresAt: new Date(initialTime + 1_000),
      }));
      harness.prisma.$transaction.mockImplementationOnce((callback: (transaction: typeof harness.tx) => unknown) => {
        vi.setSystemTime(initialTime + 2_000);
        return callback(harness.tx);
      });
      harness.tx.dsvCustomerAccountInvite.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(harness.service.complete({
        displayName: '고객 운영자',
        loginId: 'customer-login',
        password: 'StrongPassw0rd!',
        requestId: 'req-expired-during-hash',
        shopDomain: 'tomatonofood.com',
        token,
      })).rejects.toMatchObject({
        code: 'INVITATION_EXPIRED',
        message: '허용 시간이 초과된 링크입니다. 담당자에게 새 초대 링크를 요청해 주세요.',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test('rejects the current and immediately previous passwords during password reset', async () => {
    const currentPassword = 'CurrentStrongPassw0rd!';
    const previousPassword = 'PreviousStrongPassw0rd!';
    const currentPasswordSalt = 'current-customer-salt';
    const previousPasswordSalt = 'previous-customer-salt';
    const resetInvite = invite({
      account: {
        customerId,
        displayName: '고객 운영자',
        email: 'customer@example.com',
        issuer: 'CLEVER_DSV',
        loginId: 'customer-login',
        passwordHash: await hashPassword(currentPassword, currentPasswordSalt),
        passwordSalt: currentPasswordSalt,
        previousPasswordHash: await hashPassword(previousPassword, previousPasswordSalt),
        previousPasswordSalt,
        shopId,
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

  test('keeps legacy email-shaped login IDs valid and rotates the active session ID', async () => {
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
      id: 'Customer.Operator@Example.com',
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
    expect(harness.prisma.customerAccount.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { loginId: 'customer.operator@example.com' },
    }));
  });

  test('creates signup invites with fragment links, token hashes only in storage, and redacted audit', async () => {
    const harness = createHarness();
    harness.prisma.shop.findUnique.mockResolvedValueOnce({ id: shopId, shopDomain: 'tomatonofood.com' });
    harness.prisma.shop.findUnique.mockResolvedValueOnce({ customers: [{ displayName: '토마토물류', id: customerId }] });
    harness.tx.customerAccount.findUniqueOrThrow.mockResolvedValue(accountWithInvite({ displayName: null, email: null, loginId: null }));

    const result = await harness.service.createSignupInvitation({
      actorId: 'admin-1',
      customerId,
      requestId: 'req-invite',
      shopDomain: 'tomatonofood.com',
    });

    const issuedToken = decodeURIComponent(new URL(result.invitation.setupUrl).hash.slice('#token='.length));
    expect(issuedToken).not.toBe('');
    expect(result.invitation.setupUrl).toContain('https://dsv.example.com/customer/account/setup#token=');
    expect(result.account).toMatchObject({ displayName: null, email: null, loginId: null });
    expect(harness.manualEmailService.send).not.toHaveBeenCalled();
    const accountCreateCalls = harness.tx.customerAccount.create.mock.calls as unknown as Array<[{ data: Record<string, unknown> }]>;
    expect(accountCreateCalls[0]?.[0].data).not.toHaveProperty('email');
    expect(accountCreateCalls[0]?.[0].data).not.toHaveProperty('loginId');
    const inviteCreateCalls = harness.tx.dsvCustomerAccountInvite.create.mock.calls as unknown as Array<[{ data: { tokenHash: string } }]>;
    const auditCreateCalls = harness.tx.dsvAuditEvent.create.mock.calls as unknown as Array<[{ data: unknown }]>;
    expect(inviteCreateCalls[0]?.[0].data.tokenHash).not.toBe(issuedToken);
    expect(inviteCreateCalls[0]?.[0].data.tokenHash).toHaveLength(64);
    expect(JSON.stringify(auditCreateCalls[0]?.[0].data)).not.toContain(issuedToken);
    expect(result.invitation.expiresAt.getTime() - Date.now()).toBeGreaterThan(47 * 60 * 60 * 1000);
    expect(result.invitation.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(48 * 60 * 60 * 1000);
    const revokeCalls = harness.tx.dsvCustomerAccountInvite.updateMany.mock.calls as unknown as Array<[{
      data: { revokedAt?: unknown };
      where: { consumedAt?: unknown; purpose?: unknown; revokedAt?: unknown };
    }]>;
    expect(revokeCalls[0]?.[0].data.revokedAt).toBeInstanceOf(Date);
    expect(revokeCalls[0]?.[0].where).toMatchObject({ consumedAt: null, purpose: 'SIGNUP', revokedAt: null });
  });

  test('requires configured web origin before returning invitation links', async () => {
    const harness = createHarness({ webPublicOrigin: undefined });
    harness.prisma.shop.findUnique.mockResolvedValueOnce({ id: shopId, shopDomain: 'tomatonofood.com' });
    harness.prisma.shop.findUnique.mockResolvedValueOnce({ customers: [{ displayName: '토마토물류', id: customerId }] });
    harness.tx.customerAccount.findUniqueOrThrow.mockResolvedValue(accountWithInvite());

    await expect(harness.service.createSignupInvitation({
      actorId: 'admin-1',
      customerId,
      requestId: 'req-invite',
      shopDomain: 'tomatonofood.com',
    })).rejects.toBeInstanceOf(DsvCustomerAccountServiceError);
    expect(harness.manualEmailService.send).not.toHaveBeenCalled();
  });

  test('leaves signup identity fields unclaimed until link completion', async () => {
    const harness = createHarness();
    harness.prisma.shop.findUnique.mockResolvedValueOnce({ id: shopId, shopDomain: 'tomatonofood.com' });
    harness.prisma.shop.findUnique.mockResolvedValueOnce({ customers: [{ displayName: '토마토물류', id: customerId }] });
    harness.tx.customerAccount.findUniqueOrThrow.mockResolvedValue(accountWithInvite({ displayName: null, email: null, loginId: null }));

    const result = await harness.service.createSignupInvitation({
      actorId: 'admin-1',
      customerId,
      requestId: 'req-generated',
      shopDomain: 'tomatonofood.com',
    });

    expect(result.account.loginId).toBeNull();
    const accountCreateCalls = harness.tx.customerAccount.create.mock.calls as unknown as Array<[{ data: { loginId: string } }]>;
    expect(accountCreateCalls[0]?.[0].data.loginId).toBeUndefined();
    const sendCalls = harness.manualEmailService.send.mock.calls as unknown as Array<[{ textContent: string }]>;
    const emailBody = sendCalls[0]?.[0].textContent ?? '';
    expect(emailBody).toBe('');
  });

  test('rejects a duplicate login ID while completing signup', async () => {
    const harness = createHarness();
    harness.prisma.dsvCustomerAccountInvite.findUnique.mockResolvedValueOnce(invite());
    harness.tx.customerAccount.findUnique.mockResolvedValueOnce({ id: 'other-account' });

    await expect(harness.service.complete({
      displayName: '고객 운영자',
      loginId: 'taken-login',
      password: 'StrongPassw0rd!',
      requestId: 'req-complete',
      shopDomain: 'tomatonofood.com',
      token,
    })).rejects.toMatchObject({ code: 'LOGIN_ID_EXISTS' });
    expect(harness.tx.dsvCustomerAccountInvite.updateMany).not.toHaveBeenCalled();
  });

  test('serializes reissue-reissue competition on the account before revoking the prior link', async () => {
    const harness = createHarness();
    const transactionLocks = installSerializedAccountTransactions(harness);
    const invitationState: Array<{ revokedAt: Date | null; tokenHash: string }> = [];
    harness.prisma.customerAccount.findFirst.mockResolvedValue({
      customerId,
      email: null,
      id: accountId,
      issuer: 'CLEVER_DSV',
      loginId: null,
      passwordHash: null,
      passwordSalt: null,
      shop: { id: shopId, shopDomain: 'tomatonofood.com' },
      shopId,
      status: 'INACTIVE',
    });
    harness.prisma.shop.findUnique
      .mockResolvedValueOnce({ id: shopId, shopDomain: 'tomatonofood.com' })
      .mockResolvedValueOnce({ id: shopId, shopDomain: 'tomatonofood.com' })
      .mockResolvedValueOnce({ customers: [{ displayName: '토마토물류', id: customerId }] })
      .mockResolvedValueOnce({ customers: [{ displayName: '토마토물류', id: customerId }] });
    harness.tx.customerAccount.findUnique.mockResolvedValue({ customerId, issuer: 'CLEVER_DSV', passwordHash: null, shopId });
    harness.tx.customerAccount.findUniqueOrThrow.mockResolvedValue(accountWithInvite({ displayName: null, email: null, loginId: null }));
    harness.tx.dsvCustomerAccountInvite.updateMany.mockImplementation((input: unknown) => {
      const revokedAt = (input as { data: { revokedAt: Date } }).data.revokedAt;
      for (const invitation of invitationState) {
        if (invitation.revokedAt === null) invitation.revokedAt = revokedAt;
      }
      return Promise.resolve({ count: invitationState.length });
    });
    harness.tx.dsvCustomerAccountInvite.create.mockImplementation((input: unknown) => {
      invitationState.push({ revokedAt: null, tokenHash: (input as { data: { tokenHash: string } }).data.tokenHash });
      return Promise.resolve({ id: `invite-${invitationState.length}` });
    });
    harness.prisma.dsvCustomerAccountInvite.findUnique.mockImplementation((input: unknown) => {
      const tokenHash = (input as { where: { tokenHash: string } }).where.tokenHash;
      const invitation = invitationState.find((candidate) => candidate.tokenHash === tokenHash);
      return Promise.resolve(invitation === undefined ? null : invite({ revokedAt: invitation.revokedAt }));
    });

    const results = await Promise.all(['req-reinvite-1', 'req-reinvite-2'].map((requestId) => harness.service.reinvite({
      accountId,
      actorId: 'admin-1',
      requestId,
      shopDomain: 'tomatonofood.com',
    })));
    expect(results.map((result) => result.account.id)).toEqual([accountId, accountId]);
    expect(results[0]?.invitation.setupUrl).not.toBe(results[1]?.invitation.setupUrl);
    expect(invitationState.filter((invitation) => invitation.revokedAt === null)).toHaveLength(1);
    const firstToken = decodeURIComponent(new URL(results[0]?.invitation.setupUrl ?? '').hash.slice('#token='.length));
    const secondToken = decodeURIComponent(new URL(results[1]?.invitation.setupUrl ?? '').hash.slice('#token='.length));
    await expect(harness.service.validateInvitation({ shopDomain: 'tomatonofood.com', token: firstToken })).resolves.toBeNull();
    await expect(harness.service.validateInvitation({ shopDomain: 'tomatonofood.com', token: secondToken })).resolves.toMatchObject({ purpose: 'SIGNUP' });
    expect(invitationState[0]?.tokenHash).toBe(createHash('sha256').update(firstToken).digest('hex'));
    expect(invitationState[1]?.tokenHash).toBe(createHash('sha256').update(secondToken).digest('hex'));
    expect(transactionLocks.lockQueries).toHaveLength(2);
    for (const lockQuery of transactionLocks.lockQueries) {
      expect(lockQuery.strings.join('?')).toContain('pg_advisory_xact_lock');
      expect(lockQuery.values).toContain(`dsv-customer-account:${accountId}`);
    }
  });

  test('rejects a reissue that loses the signup-complete race while waiting for the account lock', async () => {
    const harness = createHarness();
    const transactionLocks = installSerializedAccountTransactions(harness);
    let accountActivated = false;
    let inviteConsumed = false;
    let markShopLookupStarted: () => void = () => {};
    let allowShopLookup: () => void = () => {};
    const shopLookupStarted = new Promise<void>((resolve) => {
      markShopLookupStarted = resolve;
    });
    const shopLookupAllowed = new Promise<void>((resolve) => {
      allowShopLookup = resolve;
    });
    harness.prisma.customerAccount.findFirst.mockResolvedValueOnce({
      customerId,
      email: null,
      id: accountId,
      issuer: 'CLEVER_DSV',
      loginId: null,
      passwordHash: null,
      passwordSalt: null,
      shop: { id: shopId, shopDomain: 'tomatonofood.com' },
      shopId,
      status: 'INACTIVE',
    });
    harness.prisma.shop.findUnique.mockImplementation(async (input: unknown) => {
      if ('shopDomain' in ((input as { select?: Record<string, unknown> }).select ?? {})) {
        markShopLookupStarted();
        await shopLookupAllowed;
        return { id: shopId, shopDomain: 'tomatonofood.com' };
      }
      return { customers: [{ displayName: '토마토물류', id: customerId }] };
    });
    harness.prisma.dsvCustomerAccountInvite.findUnique.mockImplementation(() => Promise.resolve(invite({
      consumedAt: inviteConsumed ? new Date() : null,
    })));
    harness.tx.customerAccount.findUnique.mockImplementation((input: unknown) => {
      const where = (input as { where: Record<string, unknown> }).where;
      return Promise.resolve('loginId' in where
        ? null
        : { customerId, issuer: 'CLEVER_DSV', passwordHash: accountActivated ? 'activated-hash' : null, shopId });
    });
    harness.tx.dsvCustomerAccountInvite.updateMany.mockImplementation((input: unknown) => {
      const data = (input as { data: Record<string, unknown> }).data;
      if ('consumedAt' in data && !inviteConsumed) {
        inviteConsumed = true;
        return Promise.resolve({ count: 1 });
      }
      return Promise.resolve({ count: 0 });
    });
    harness.tx.customerAccount.update.mockImplementation(() => {
      accountActivated = true;
      return Promise.resolve({ activeSessionId, customerId, id: accountId, shopId });
    });

    const reinvitePromise = harness.service.reinvite({
      accountId,
      actorId: 'admin-1',
      requestId: 'req-race',
      shopDomain: 'tomatonofood.com',
    });
    await shopLookupStarted;
    const completeLockAcquired = transactionLocks.waitForNextLock();
    const completePromise = harness.service.complete({
      displayName: '고객 운영자',
      loginId: 'customer-login',
      password: 'StrongPassw0rd!',
      requestId: 'req-complete-race',
      shopDomain: 'tomatonofood.com',
      token,
    });
    await completeLockAcquired;
    allowShopLookup();

    await expect(completePromise).resolves.toMatchObject({ accountId, activeSessionId });
    await expect(reinvitePromise).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(harness.service.validateInvitation({ shopDomain: 'tomatonofood.com', token })).resolves.toBeNull();
    expect(accountActivated).toBe(true);
    expect(inviteConsumed).toBe(true);
    expect(harness.tx.dsvCustomerAccountInvite.create).not.toHaveBeenCalled();
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
    $queryRaw: vi.fn<(query: unknown) => Promise<Array<{ lock: string }>>>(() => Promise.resolve([{ lock: '' }])),
    customerAccount: {
      create: vi.fn(() => Promise.resolve({ id: accountId })),
      findFirst: vi.fn(),
      findUnique: vi.fn<(input: unknown) => Promise<unknown>>(() => Promise.resolve(null)),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
    },
    dsvAuditEvent: { create: vi.fn(() => Promise.resolve({ id: 'audit-1' })) },
    dsvCustomerAccountInvite: {
      create: vi.fn<(input: unknown) => Promise<{ id: string }>>(() => Promise.resolve({ id: 'invite-1' })),
      updateMany: vi.fn<(input: unknown) => Promise<{ count: number }>>(() => Promise.resolve({ count: 1 })),
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
    dsvCustomerAccountInvite: { findUnique: vi.fn<(input: unknown) => Promise<unknown>>() },
    shop: { findUnique: vi.fn<(input: unknown) => Promise<unknown>>() },
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

function installSerializedAccountTransactions(harness: ReturnType<typeof createHarness>) {
  const lockQueries: Array<{ strings: readonly string[]; values: readonly unknown[] }> = [];
  const lockWaiters: Array<() => void> = [];
  let transactionTail = Promise.resolve();
  harness.prisma.$transaction.mockImplementation(async (callback: (transaction: typeof harness.tx) => unknown) => {
    const previous = transactionTail;
    let release: () => void = () => {};
    transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    const localTransaction = {
      ...harness.tx,
      $queryRaw: vi.fn(async (query: unknown) => {
        await previous;
        lockQueries.push(query as { strings: readonly string[]; values: readonly unknown[] });
        lockWaiters.shift()?.();
        return [{ lock: '' }];
      }),
    };
    try {
      return await callback(localTransaction);
    } finally {
      release();
    }
  });
  return {
    lockQueries,
    waitForNextLock: () => new Promise<void>((resolve) => lockWaiters.push(resolve)),
  };
}

function invite(overrides: Record<string, unknown> = {}) {
  return {
    account: {
      customerId,
      displayName: '고객 운영자',
      email: 'customer@example.com',
      issuer: 'CLEVER_DSV',
      loginId: 'customer-login',
      passwordHash: null,
      passwordSalt: null,
      previousPasswordHash: null,
      previousPasswordSalt: null,
      shopId,
    },
    accountId,
    consumedAt: null,
    customer: { displayName: '토마토물류', id: customerId, shopId },
    customerId,
    expiresAt: new Date(Date.now() + 60_000),
    id: 'invite-1',
    purpose: 'SIGNUP',
    revokedAt: null,
    shop: { id: shopId, shopDomain: 'tomatonofood.com' },
    shopId,
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
