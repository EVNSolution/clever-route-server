import { describe, expect, test, vi } from 'vitest';

import {
  enqueueRouteTrackingRoadMatch,
  PrismaRouteTrackingRoadMatchJobRepository,
} from '../src/modules/route-tracking/route-tracking-road-match-job.repository.js';

describe('route tracking road match job repository', () => {
  test('supersedes the target generation without releasing an active lease', async () => {
    const routeTrackingRoadMatchJob = {
      create: vi.fn(),
      findUnique: vi.fn(() => Promise.resolve({ id: 'job-1', status: 'PROCESSING' })),
      update: vi.fn(() => Promise.resolve({ id: 'job-1' })),
    };

    await enqueueRouteTrackingRoadMatch({ routeTrackingRoadMatchJob } as never, {
      lastInputOccurredAt: new Date('2026-09-17T12:01:00.000Z'),
      now: new Date('2026-09-17T12:01:01.000Z'),
      routePlanId: 'route-1',
      sourcePointCount: 13,
    });

    expect(routeTrackingRoadMatchJob.update).toHaveBeenCalledWith({
      data: {
        completedAt: null,
        errorCode: null,
        errorMessage: null,
        targetLastInputOccurredAt: new Date('2026-09-17T12:01:00.000Z'),
        targetSourcePointCount: 13,
      },
      where: { id: 'job-1' },
    });
    expect(routeTrackingRoadMatchJob.create).not.toHaveBeenCalled();
  });

  test('recovers a processing job after its lease expires', async () => {
    const expired = {
      attemptCount: 2,
      id: 'job-1',
      routePlanId: 'route-1',
      targetLastInputOccurredAt: new Date('2026-09-17T12:00:00.000Z'),
      targetSourcePointCount: 12,
    };
    const routeTrackingRoadMatchJob = {
      findFirst: vi.fn(() => Promise.resolve(expired)),
      updateMany: vi.fn(() => Promise.resolve({ count: 1 })),
    };
    const repository = new PrismaRouteTrackingRoadMatchJobRepository({ routeTrackingRoadMatchJob } as never);
    const now = new Date('2026-09-17T12:05:00.000Z');

    const job = await repository.claimNext({ leaseMs: 60_000, now });

    expect(job).toMatchObject({ attemptCount: 3, id: 'job-1', routePlanId: 'route-1' });
    expect(routeTrackingRoadMatchJob.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        OR: [
          { nextAttemptAt: { lte: now }, status: 'QUEUED' },
          { leaseExpiresAt: { lte: now }, status: 'PROCESSING' },
        ],
      },
    }));
    const expectedUpdateData: unknown = expect.objectContaining({
        attemptCount: { increment: 1 },
        leaseExpiresAt: new Date('2026-09-17T12:06:00.000Z'),
        status: 'PROCESSING',
    });
    expect(routeTrackingRoadMatchJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expectedUpdateData,
    }));
  });

  test('publishes only while both the lease and raw input version still match', async () => {
    const routeTrackingRoadMatchJob = {
      findUnique: vi.fn(() => Promise.resolve({
        id: 'job-1',
        leaseToken: 'lease-1',
        routePlanId: 'route-1',
        status: 'PROCESSING',
        targetLastInputOccurredAt: new Date('2026-09-17T12:00:00.000Z'),
        targetSourcePointCount: 12,
      })),
      updateMany: vi.fn(() => Promise.resolve({ count: 1 })),
    };
    const routeTrackingGeometry = { updateMany: vi.fn(() => Promise.resolve({ count: 0 })) };
    const transaction = {
      $queryRaw: vi.fn(() => Promise.resolve([{ locked: true }])),
      routeTrackingGeometry,
      routeTrackingRoadMatchJob,
    };
    const prisma = { $transaction: vi.fn((work: (tx: unknown) => unknown) => work(transaction)) };
    const repository = new PrismaRouteTrackingRoadMatchJobRepository(prisma as never);

    const published = await repository.publishMatchedPath({
      job: {
        attemptCount: 1,
        id: 'job-1',
        leaseToken: 'lease-1',
        routePlanId: 'route-1',
        targetLastInputOccurredAt: new Date('2026-09-17T12:00:00.000Z'),
        targetSourcePointCount: 12,
      },
      path: {
        coverage: 'ontario',
        inputPointCount: 12,
        lastInputOccurredAt: '2026-09-17T12:00:00.000Z',
        lastMatchedPosition: null,
        matchedGeometry: null,
        matchedPointCount: 0,
        schemaVersion: 'route_tracking_road_match.v1',
        uncertainGeometry: null,
        watermark: 'watermark-1',
      },
      now: new Date('2026-09-17T12:05:00.000Z'),
    });

    expect(published).toBe(false);
    expect(routeTrackingGeometry.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        lastOccurredAt: new Date('2026-09-17T12:00:00.000Z'),
        routePlanId: 'route-1',
        sourcePointCount: 12,
      },
    }));
    expect(routeTrackingRoadMatchJob.updateMany).not.toHaveBeenCalled();
  });
});
