import { describe, expect, test, vi } from 'vitest';

import {
  DsvDriverAccountLinkCandidateError,
  PrismaDsvDriverAccountLinkService,
} from '../src/modules/dsv/dsv-driver-account-link.service.js';

describe('PrismaDsvDriverAccountLinkService', () => {
  test('lists only partial identity matches and masks both phone numbers', async () => {
    const prisma = {
      driver: {
        findMany: vi.fn(() => Promise.resolve([
          { createdAt: new Date('2026-08-26T01:00:00.000Z'), displayName: '정재연', id: 'driver-name-match', phone: '010-1111-2222' },
          { createdAt: new Date('2026-08-26T01:00:00.000Z'), displayName: '연락처 미등록', id: 'driver-no-phone', phone: null },
          { createdAt: new Date('2026-08-26T01:00:00.000Z'), displayName: '다른 배송원', id: 'driver-phone-match', phone: '010-9999-8888' },
          { createdAt: new Date('2026-08-26T01:00:00.000Z'), displayName: '무관 배송원', id: 'driver-unrelated', phone: '010-0000-0000' },
        ])),
      },
      driverAccount: {
        findMany: vi.fn(() => Promise.resolve([
          { createdAt: new Date('2026-08-26T02:00:00.000Z'), id: 'account-name-match', name: '정재연', phone: '01033334444' },
          { createdAt: new Date('2026-08-26T02:00:00.000Z'), id: 'account-no-driver-phone', name: '연락처 미등록', phone: '01055556666' },
          { createdAt: new Date('2026-08-26T02:00:00.000Z'), id: 'account-phone-match', name: '계정 이름', phone: '01099998888' },
          { createdAt: new Date('2026-08-26T02:00:00.000Z'), id: 'account-unrelated', name: '무관 계정', phone: '01077776666' },
        ])),
      },
      shop: { findUnique: vi.fn(() => Promise.resolve({ id: 'shop-id' })) },
    };
    const service = new PrismaDsvDriverAccountLinkService(prisma as never);

    const reviews = await service.listPending({ shopDomain: 'dsv.example' });
    expect(reviews).toHaveLength(3);
    expect(reviews).toEqual(expect.arrayContaining([
      {
        accountId: 'account-name-match',
        accountName: '정재연',
        accountPhoneLast4: '4444',
        createdAt: '2026-08-26T02:00:00.000Z',
        driverId: 'driver-name-match',
        driverName: '정재연',
        driverPhoneLast4: '2222',
        reason: 'PHONE_MISMATCH',
      },
      {
        accountId: 'account-no-driver-phone',
        accountName: '연락처 미등록',
        accountPhoneLast4: '6666',
        createdAt: '2026-08-26T02:00:00.000Z',
        driverId: 'driver-no-phone',
        driverName: '연락처 미등록',
        driverPhoneLast4: null,
        reason: 'PHONE_MISMATCH',
      },
      {
        accountId: 'account-phone-match',
        accountName: '계정 이름',
        accountPhoneLast4: '8888',
        createdAt: '2026-08-26T02:00:00.000Z',
        driverId: 'driver-phone-match',
        driverName: '다른 배송원',
        driverPhoneLast4: '8888',
        reason: 'NAME_MISMATCH',
      },
    ]));
  });

  test('approves one partial match without overwriting either identity and records a redacted audit', async () => {
    const driverUpdate = vi.fn(() => Promise.resolve({ count: 1 }));
    const auditCreate = vi.fn((input: unknown) => {
      void input;
      return Promise.resolve({ id: 'audit-id' });
    });
    const transaction = {
      driver: {
        findFirst: vi.fn(() => Promise.resolve({ accountId: null, displayName: '정재연', id: 'driver-id', phone: '01011112222', status: 'ACTIVE' })),
        updateMany: driverUpdate,
      },
      driverAccount: {
        findFirst: vi.fn(() => Promise.resolve({ id: 'account-id', name: '정재연', phone: '01033334444', status: 'ACTIVE' })),
      },
      dsvAuditEvent: { create: auditCreate },
    };
    const prisma = {
      $transaction: vi.fn((operation: (client: typeof transaction) => unknown) => operation(transaction)),
      shop: { findUnique: vi.fn(() => Promise.resolve({ id: 'shop-id' })) },
    };
    const service = new PrismaDsvDriverAccountLinkService(prisma as never);

    await expect(service.approve({
      accountId: 'account-id',
      actorId: 'admin-id',
      driverId: 'driver-id',
      requestId: 'request-id',
      shopDomain: 'dsv.example',
    })).resolves.toEqual({ accountId: 'account-id', driverId: 'driver-id' });
    expect(driverUpdate).toHaveBeenCalledWith({
      data: {
        accountId: 'account-id',
        authSubject: 'driver-driver-id',
        inviteCode: null,
        inviteCodeExpiresAt: null,
      },
      where: { accountId: null, id: 'driver-id', shopId: 'shop-id', status: 'ACTIVE' },
    });
    const auditInput = auditCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> } | undefined;
    expect(auditInput?.data).toMatchObject({
      actorId: 'admin-id',
      entityId: 'driver-id',
      eventType: 'DRIVER_ACCOUNT_LINK_APPROVED',
      redactedDiff: { accountLinked: true, matchBasis: 'NAME' },
      redactionClass: 'PII_REDACTED',
      requestId: 'request-id',
      shopId: 'shop-id',
    });
    expect(JSON.stringify(driverUpdate.mock.calls)).not.toContain('01011112222');
    expect(JSON.stringify(driverUpdate.mock.calls)).not.toContain('01033334444');
  });

  test('rejects an unrelated account and driver pair', async () => {
    const transaction = {
      driver: {
        findFirst: vi.fn(() => Promise.resolve({ accountId: null, displayName: '배송원', id: 'driver-id', phone: '01011112222', status: 'ACTIVE' })),
        updateMany: vi.fn(),
      },
      driverAccount: {
        findFirst: vi.fn(() => Promise.resolve({ id: 'account-id', name: '다른 계정', phone: '01033334444', status: 'ACTIVE' })),
      },
      dsvAuditEvent: { create: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn((operation: (client: typeof transaction) => unknown) => operation(transaction)),
      shop: { findUnique: vi.fn(() => Promise.resolve({ id: 'shop-id' })) },
    };
    const service = new PrismaDsvDriverAccountLinkService(prisma as never);

    await expect(service.approve({
      accountId: 'account-id',
      actorId: 'admin-id',
      driverId: 'driver-id',
      requestId: 'request-id',
      shopDomain: 'dsv.example',
    })).rejects.toBeInstanceOf(DsvDriverAccountLinkCandidateError);
    expect(transaction.driver.updateMany).not.toHaveBeenCalled();
  });
});
