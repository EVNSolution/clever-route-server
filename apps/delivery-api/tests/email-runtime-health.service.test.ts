import { describe, expect, test, vi } from 'vitest';
import { PrismaEmailRuntimeHealthService } from '../src/modules/customer-email/email-runtime-health.service.js';

describe('email runtime health', () => {
  test('rejects invalid runtime health thresholds', () => {
    const prisma = {};

    expect(() => new PrismaEmailRuntimeHealthService(prisma as never, {
      automaticSenderConfigured: true,
      automaticWorkerEnabled: true,
      manualBrevoConfigured: true,
      thresholds: { processingStaleAfterMs: 0 }
    })).toThrow('processingStaleAfterMs');
  });

  test('reports degraded when queued, retry, or processing work exceeds its threshold', async () => {
    const now = new Date('2026-08-24T08:00:00.000Z');
    const findFirst = vi.fn((input: { orderBy: Record<string, string>; where: { attemptCount?: unknown; status?: string } }) => {
      if ('sentAt' in input.orderBy) return Promise.resolve(null);
      if ('updatedAt' in input.orderBy && input.where.status === 'PROCESSING') {
        return Promise.resolve({ updatedAt: new Date('2026-08-24T07:54:59.000Z') });
      }
      if ('updatedAt' in input.orderBy) return Promise.resolve(null);
      if (input.where.attemptCount !== undefined) {
        return Promise.resolve({ occurredAt: new Date('2026-08-24T07:29:59.000Z') });
      }
      return Promise.resolve({ occurredAt: new Date('2026-08-24T07:44:59.000Z') });
    });
    const prisma = {
      customerRouteNotificationFact: {
        count: vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(1).mockResolvedValueOnce(1).mockResolvedValueOnce(0),
        findFirst
      },
      shop: { findUnique: vi.fn().mockResolvedValue({ id: 'shop-id' }) }
    };

    const result = await new PrismaEmailRuntimeHealthService(prisma as never, {
      automaticSenderConfigured: true,
      automaticWorkerEnabled: true,
      manualBrevoConfigured: true,
      thresholds: {
        processingStaleAfterMs: 5 * 60_000,
        queuedStaleAfterMs: 15 * 60_000,
        retryWaitStaleAfterMs: 30 * 60_000
      }
    }, undefined, () => now).get({ shopDomain: 'tenant-a.example.test' });

    expect(result.email.state).toBe('DEGRADED');
  });

  test('reports degraded for an unresolved last error and healthy after a later success', async () => {
    const now = new Date('2026-08-24T08:00:00.000Z');
    const buildPrisma = (successAt: Date | null) => ({
      customerRouteNotificationFact: {
        count: vi.fn().mockResolvedValue(0),
        findFirst: vi.fn((input: { orderBy: Record<string, string>; where: { status?: string } }) => {
          if ('sentAt' in input.orderBy) return Promise.resolve(successAt === null ? null : { sentAt: successAt });
          if (input.where.status === 'PROCESSING') return Promise.resolve(null);
          if ('updatedAt' in input.orderBy) {
            return Promise.resolve({ errorCode: 'PROVIDER_TIMEOUT', updatedAt: new Date('2026-08-24T07:50:00.000Z') });
          }
          return Promise.resolve(null);
        })
      },
      shop: { findUnique: vi.fn().mockResolvedValue({ id: 'shop-id' }) }
    });
    const config = {
      automaticSenderConfigured: true,
      automaticWorkerEnabled: true,
      manualBrevoConfigured: true
    };

    const degraded = await new PrismaEmailRuntimeHealthService(buildPrisma(null) as never, config, undefined, () => now)
      .get({ shopDomain: 'tenant-a.example.test' });
    const recovered = await new PrismaEmailRuntimeHealthService(
      buildPrisma(new Date('2026-08-24T07:55:00.000Z')) as never,
      config,
      undefined,
      () => now
    ).get({ shopDomain: 'tenant-a.example.test' });

    expect(degraded.email.state).toBe('DEGRADED');
    expect(recovered.email.state).toBe('HEALTHY');
  });

  test('reports healthy for fresh queued, retry, and processing work', async () => {
    const now = new Date('2026-08-24T08:00:00.000Z');
    const prisma = {
      customerRouteNotificationFact: {
        count: vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(1).mockResolvedValueOnce(1).mockResolvedValueOnce(0),
        findFirst: vi.fn((input: { orderBy: Record<string, string> }) => {
          if ('sentAt' in input.orderBy || ('updatedAt' in input.orderBy && !('status' in input))) return Promise.resolve(null);
          if ('updatedAt' in input.orderBy) return Promise.resolve({ updatedAt: new Date('2026-08-24T07:59:00.000Z') });
          return Promise.resolve({ occurredAt: new Date('2026-08-24T07:59:00.000Z') });
        })
      },
      shop: { findUnique: vi.fn().mockResolvedValue({ id: 'shop-id' }) }
    };

    const result = await new PrismaEmailRuntimeHealthService(prisma as never, {
      automaticSenderConfigured: true,
      automaticWorkerEnabled: true,
      manualBrevoConfigured: false
    }, undefined, () => now).get({ shopDomain: 'tenant-a.example.test' });

    expect(result.email.state).toBe('HEALTHY');
  });

  test('reports sanitized outbox evidence and opens a durable disabled-runtime alert', async () => {
    const findFirst = vi.fn((input: { orderBy: Record<string, string> }) => {
      if ('occurredAt' in input.orderBy) return Promise.resolve({ occurredAt: new Date('2026-08-24T07:00:00.000Z') });
      if ('sentAt' in input.orderBy) return Promise.resolve({ sentAt: new Date('2026-08-24T07:30:00.000Z') });
      return Promise.resolve({ errorCode: 'provider secret text' });
    });
    const prisma = {
      customerRouteNotificationFact: {
        count: vi.fn()
          .mockResolvedValueOnce(2)
          .mockResolvedValueOnce(1)
          .mockResolvedValueOnce(3)
          .mockResolvedValueOnce(4),
        findFirst
      },
      shop: { findUnique: vi.fn().mockResolvedValue({ id: 'shop-id' }) }
    };
    const alerts = {
      openOrObserve: vi.fn().mockResolvedValue({}),
      resolveByDedupeKey: vi.fn()
    };
    const now = new Date('2026-08-24T08:00:00.000Z');

    await expect(new PrismaEmailRuntimeHealthService(prisma as never, {
      automaticSenderConfigured: false,
      automaticWorkerEnabled: false,
      manualBrevoConfigured: true
    }, alerts as never, () => now).get({ shopDomain: 'tenant-a.example.test' })).resolves.toEqual({
      email: {
        automatic: { senderConfigured: false, workerEnabled: false },
        configured: false,
        manual: { brevoConfigured: true },
        outbox: {
          deadLetter: 4,
          lastErrorCode: 'UNSANITIZED_PROVIDER_ERROR',
          lastSuccessAt: '2026-08-24T07:30:00.000Z',
          oldestPendingAt: '2026-08-24T07:00:00.000Z',
          pending: 2,
          processing: 1,
          retryWait: 3
        },
        state: 'DISABLED'
      },
      observedAt: now.toISOString()
    });
    expect(alerts.openOrObserve).toHaveBeenCalledWith(expect.objectContaining({
      dedupeKey: 'EMAIL_RUNTIME_DISABLED',
      shopId: 'shop-id',
      type: 'EMAIL_RUNTIME_DISABLED'
    }));
    expect(prisma.customerRouteNotificationFact.count).toHaveBeenCalledTimes(4);
    expect(prisma.customerRouteNotificationFact.count).toHaveBeenNthCalledWith(1, { where: { attemptCount: 0, shopId: 'shop-id', status: 'QUEUED' } });
    expect(prisma.customerRouteNotificationFact.count).toHaveBeenNthCalledWith(4, { where: { shopId: 'shop-id', status: 'DEAD' } });
  });

  test('never reports a disabled automatic worker healthy when manual Brevo is configured', async () => {
    const prisma = {
      customerRouteNotificationFact: { count: vi.fn().mockResolvedValue(0), findFirst: vi.fn().mockResolvedValue(null) },
      shop: { findUnique: vi.fn().mockResolvedValue({ id: 'shop-id' }) }
    };
    const result = await new PrismaEmailRuntimeHealthService(prisma as never, {
      automaticSenderConfigured: false, automaticWorkerEnabled: false, manualBrevoConfigured: true
    }).get({ shopDomain: 'tenant-a.example.test' });
    expect(result.email.state).toBe('DISABLED');
    expect(result.email.manual.brevoConfigured).toBe(true);
  });
});
