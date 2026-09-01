import { describe, expect, test, vi } from 'vitest';

import {
  DriverAccountDeletionActiveRouteError,
  DriverAccountDeletionProcessingError,
  PrismaDriverAccountDeletionService,
} from '../src/modules/driver/driver-account-deletion.service.js';

const now = new Date('2026-09-01T07:00:00.000Z');
const requestId = '11111111-1111-4111-8111-111111111111';
const accountId = '22222222-2222-4222-8222-222222222222';
const driverId = '33333333-3333-4333-8333-333333333333';

describe('PrismaDriverAccountDeletionService', () => {
  test('creates one verified external account-level request without copying account PII', async () => {
    const harness = createHarness();
    const service = new PrismaDriverAccountDeletionService(harness.prisma as never, { now: () => now });

    await expect(service.requestVerifiedExternal({
      accountId,
      processedBy: 'privacy-support',
      verificationMethod: 'OPERATOR_VERIFIED_CONTACT',
    })).resolves.toEqual({ duplicate: false, requestId, status: 'REQUESTED' });

    expect(harness.tx.driverAccountDeletionRequest.create).toHaveBeenCalledWith({
      // Vitest asymmetric matchers are intentionally untyped at this assertion boundary.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      data: expect.objectContaining({
        accountId,
        driverDisplayName: null,
        driverPhone: null,
        reason: null,
        requestChannel: 'EXTERNAL_SUPPORT',
        status: 'REQUESTED',
        verificationMethod: 'OPERATOR_VERIFIED_CONTACT',
      }),
      select: { id: true, status: true },
    });
  });

  test('keeps external request creation idempotent and blocks a new request during an active route', async () => {
    const existingHarness = createHarness({ existingRequest: { id: requestId, status: 'REQUESTED' } });
    const existingService = new PrismaDriverAccountDeletionService(existingHarness.prisma as never, { now: () => now });
    await expect(existingService.requestVerifiedExternal({
      accountId,
      processedBy: 'privacy-support',
      verificationMethod: 'OPERATOR_VERIFIED_CONTACT',
    })).resolves.toEqual({ duplicate: true, requestId, status: 'REQUESTED' });
    expect(existingHarness.tx.routePlan.findFirst).not.toHaveBeenCalled();

    const activeHarness = createHarness({ activeRoute: { id: 'active-route' } });
    const activeService = new PrismaDriverAccountDeletionService(activeHarness.prisma as never, { now: () => now });
    await expect(activeService.requestVerifiedExternal({
      accountId,
      processedBy: 'privacy-support',
      verificationMethod: 'OPERATOR_VERIFIED_CONTACT',
    })).rejects.toBeInstanceOf(DriverAccountDeletionActiveRouteError);
    expect(activeHarness.tx.driverAccountDeletionRequest.create).not.toHaveBeenCalled();
  });

  test('fulfills deletion atomically, revokes credentials, removes push tokens, and anonymizes PII', async () => {
    const harness = createHarness();
    const service = new PrismaDriverAccountDeletionService(harness.prisma as never, {
      now: () => now,
      processingKey: () => '44444444-4444-4444-8444-444444444444',
    });

    await expect(service.fulfill({ processedBy: 'privacy-ops', requestId })).resolves.toEqual(expect.objectContaining({
      duplicate: false,
      requestId,
      status: 'COMPLETED',
    }));

    expect(harness.tx.driverAccount.update).toHaveBeenCalledWith(expect.objectContaining({
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      data: expect.objectContaining({
        failedPasswordAttempts: 0,
        failedPinAttempts: 0,
        loginId: null,
        name: null,
        passwordHash: null,
        passwordSalt: null,
        phone: `deleted:${accountId}`,
        pinHash: null,
        pinSalt: null,
        residentNumberFrontFingerprint: null,
        status: 'INACTIVE',
        tokenVersion: { increment: 1 },
      }),
      where: { id: accountId },
    }));
    expect(harness.tx.driverAccountSession.updateMany).toHaveBeenCalled();
    expect(harness.tx.driverSession.updateMany).toHaveBeenCalled();
    expect(harness.tx.driverPushToken.deleteMany).toHaveBeenCalledWith({ where: { accountId } });
    expect(harness.tx.driver.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      data: expect.objectContaining({
        authSubject: null,
        displayName: 'Deleted driver',
        phone: null,
        status: 'INACTIVE',
        tokenVersion: { increment: 1 },
      }),
    }));
    expect(harness.tx.driverConsentRecord.updateMany).toHaveBeenCalled();
    expect(harness.tx.driverAccountDeletionRequest.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      data: expect.objectContaining({
        driverDisplayName: null,
        driverPhone: null,
        failureCode: null,
        processingKey: null,
        processingLeaseExpiresAt: null,
        reason: null,
        rejectionCode: null,
        status: 'COMPLETED',
      }),
    }));
  });

  test('defers an active route without mutating account records and can be retried later', async () => {
    const harness = createHarness({ activeRouteDuringFulfillment: { id: 'active-route' } });
    const service = new PrismaDriverAccountDeletionService(harness.prisma as never, { now: () => now });

    await expect(service.fulfill({ processedBy: 'privacy-ops', requestId })).resolves.toEqual(expect.objectContaining({
      duplicate: false,
      requestId,
      status: 'DEFERRED',
    }));
    expect(harness.tx.driverAccount.update).not.toHaveBeenCalled();
    expect(harness.tx.driverPushToken.deleteMany).not.toHaveBeenCalled();
  });

  test('records a sanitized FAILED state after a transactional failure and permits retry', async () => {
    const harness = createHarness({ failFulfillment: true });
    const service = new PrismaDriverAccountDeletionService(harness.prisma as never, { now: () => now });

    await expect(service.fulfill({ processedBy: 'privacy-ops', requestId })).rejects.toBeInstanceOf(
      DriverAccountDeletionProcessingError
    );
    expect(harness.prisma.driverAccountDeletionRequest.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      data: expect.objectContaining({
        failureCode: 'TRANSACTION_FAILED',
        processingKey: null,
        processingLeaseExpiresAt: null,
        status: 'FAILED',
      }),
    }));
  });

  test('returns completed requests idempotently and rejects unsafe rejection codes', async () => {
    const harness = createHarness({ claimCount: 0, existingRequest: { id: requestId, status: 'COMPLETED' } });
    const service = new PrismaDriverAccountDeletionService(harness.prisma as never, { now: () => now });
    await expect(service.fulfill({ processedBy: 'privacy-ops', requestId })).resolves.toEqual(expect.objectContaining({
      duplicate: true,
      requestId,
      status: 'COMPLETED',
    }));
    await expect(service.reject({
      processedBy: 'privacy-ops',
      reasonCode: 'contains free text and phone 010-1234-5678',
      requestId,
    })).rejects.toThrow('Invalid rejection reason code');
  });

  test('refuses to reject a request while a fulfillment lease owns it', async () => {
    const harness = createHarness({
      existingRequest: { id: requestId, status: 'PROCESSING' },
      rejectUpdateCount: 0,
    });
    const service = new PrismaDriverAccountDeletionService(harness.prisma as never, { now: () => now });

    await expect(service.reject({
      processedBy: 'privacy-ops',
      reasonCode: 'IDENTITY_NOT_VERIFIED',
      requestId,
    })).rejects.toBeInstanceOf(DriverAccountDeletionProcessingError);
    expect(harness.tx.driverAccountDeletionRequest.updateMany).not.toHaveBeenCalled();
  });
});

function createHarness(input: {
  activeRoute?: { id: string } | null;
  activeRouteDuringFulfillment?: { id: string } | null;
  claimCount?: number;
  existingRequest?: { id: string; status: string } | null;
  failFulfillment?: boolean;
  rejectUpdateCount?: number;
} = {}) {
  const request = {
    accountId,
    driverId: null,
    id: requestId,
    processingKey: '44444444-4444-4444-8444-444444444444',
    status: 'PROCESSING',
  };
  const tx = {
    driver: {
      findMany: vi.fn(() => Promise.resolve([{ id: driverId }])),
      updateMany: vi.fn(() => Promise.resolve({ count: 1 })),
    },
    driverAccount: {
      findUnique: vi.fn(() => Promise.resolve({ id: accountId, status: 'ACTIVE' })),
      update: vi.fn(() => Promise.resolve({ id: accountId })),
    },
    driverAccountDeletionRequest: {
      create: vi.fn(() => Promise.resolve({ id: requestId, status: 'REQUESTED' })),
      findFirst: vi.fn((args: { select?: { processingKey?: boolean } }) => Promise.resolve(
        args.select?.processingKey === true ? request : null
      )),
      findUnique: vi.fn(() => Promise.resolve(input.existingRequest ?? null)),
      update: vi.fn(() => Promise.resolve({ id: requestId, status: 'COMPLETED' })),
      updateMany: vi.fn(() => Promise.resolve({ count: input.rejectUpdateCount ?? 1 })),
    },
    driverAccountSession: { updateMany: vi.fn(() => Promise.resolve({ count: 1 })) },
    driverConsentRecord: { updateMany: vi.fn(() => Promise.resolve({ count: 1 })) },
    driverPushToken: { deleteMany: vi.fn(() => Promise.resolve({ count: 1 })) },
    driverRouteFeedback: { updateMany: vi.fn(() => Promise.resolve({ count: 1 })) },
    driverSession: { updateMany: vi.fn(() => Promise.resolve({ count: 1 })) },
    dsvDriverAccountSignupInvite: { updateMany: vi.fn(() => Promise.resolve({ count: 1 })) },
    routePlan: {
      findFirst: vi.fn((args: { where?: { driver?: unknown } }) => Promise.resolve(
        args.where?.driver === undefined ? input.activeRouteDuringFulfillment ?? null : input.activeRoute ?? null
      )),
    },
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => {
      const result = await callback(tx);
      if (input.failFulfillment === true && tx.driverAccountDeletionRequest.findFirst.mock.calls.length > 0) {
        throw new Error('synthetic database failure with private details');
      }
      return result;
    }),
    driverAccountDeletionRequest: {
      findUnique: vi.fn(() => Promise.resolve(input.existingRequest ?? { id: requestId, status: 'REQUESTED' })),
      updateMany: vi.fn(() => Promise.resolve({ count: input.claimCount ?? 1 })),
    },
  };
  return { prisma, tx };
}
