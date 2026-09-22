import { describe, expect, test, vi } from 'vitest';

import { RouteTrackingRoadMatchWorker } from '../src/modules/route-tracking/route-tracking-road-match.worker.js';

const claimedJob = {
  attemptCount: 1,
  id: 'job-1',
  leaseToken: 'lease-1',
  routePlanId: 'route-1',
  targetLastInputOccurredAt: new Date('2026-09-17T12:00:00.000Z'),
  targetSourcePointCount: 2,
};

const document = {
  coordinates: [[-79.4, 43.7], [-79.3, 43.8]] as Array<[number, number]>,
  samples: [
    { driverId: 'driver-1', eventId: 'event-1', occurredAt: '2026-09-17T11:59:00.000Z', receivedAt: '2026-09-17T11:59:01.000Z' },
    { driverId: 'driver-1', eventId: 'event-2', occurredAt: '2026-09-17T12:00:00.000Z', receivedAt: '2026-09-17T12:00:01.000Z' },
  ],
  sourcePointCount: 2,
};

describe('route tracking road match worker', () => {
  test('requeues the latest generation instead of killing a superseded lease', async () => {
    const repository = {
      claimNext: vi.fn().mockResolvedValueOnce(claimedJob).mockResolvedValueOnce(null),
      loadInput: vi.fn(() => Promise.resolve(null)),
      markDead: vi.fn(),
      markSucceededWithoutPath: vi.fn(),
      publishMatchedPath: vi.fn(),
      releaseForRetry: vi.fn(),
      renewLease: vi.fn(),
      requeueIfSuperseded: vi.fn(() => Promise.resolve(true)),
    };
    const worker = new RouteTrackingRoadMatchWorker(repository, { match: vi.fn() });
    const now = new Date('2026-09-17T12:05:00.000Z');

    expect(await worker.runDueBatch(now)).toBe(1);
    expect(repository.requeueIfSuperseded).toHaveBeenCalledWith({ job: claimedJob, now });
    expect(repository.markDead).not.toHaveBeenCalled();
  });

  test('does not publish a partial path when the provider says the outcome is retryable', async () => {
    const repository = {
      claimNext: vi.fn()
        .mockResolvedValueOnce(claimedJob)
        .mockResolvedValueOnce(null),
      loadInput: vi.fn(() => Promise.resolve(document)),
      markDead: vi.fn(),
      markSucceededWithoutPath: vi.fn(),
      publishMatchedPath: vi.fn(),
      releaseForRetry: vi.fn(() => Promise.resolve(true)),
    };
    const path = {
      coverage: 'ontario' as const,
      inputPointCount: 2,
      lastInputOccurredAt: '2026-09-17T12:00:00.000Z',
      lastMatchedPosition: null,
      matchedGeometry: null,
      matchedPointCount: 0,
      schemaVersion: 'route_tracking_road_match.v1' as const,
      uncertainGeometry: null,
      watermark: 'partial',
    };
    const provider = {
      match: vi.fn(() => Promise.resolve(path)),
      matchWithStatus: vi.fn(() => Promise.resolve({ path, retryable: true })),
    };
    const worker = new RouteTrackingRoadMatchWorker(repository as never, provider, {
      retryBaseDelayMs: 1_000,
      retryMaxDelayMs: 60_000,
    });
    const now = new Date('2026-09-17T12:05:00.000Z');

    expect(await worker.runDueBatch(now)).toBe(1);

    expect(repository.publishMatchedPath).not.toHaveBeenCalled();
    expect(repository.releaseForRetry).toHaveBeenCalledWith(expect.objectContaining({
      job: claimedJob,
      nextAttemptAt: new Date('2026-09-17T12:05:01.000Z'),
    }));
  });

  test('falls back to match and publishes a complete legacy-provider result', async () => {
    const repository = {
      claimNext: vi.fn()
        .mockResolvedValueOnce(claimedJob)
        .mockResolvedValueOnce(null),
      loadInput: vi.fn(() => Promise.resolve(document)),
      markDead: vi.fn(),
      markSucceededWithoutPath: vi.fn(),
      publishMatchedPath: vi.fn(() => Promise.resolve(true)),
      releaseForRetry: vi.fn(),
    };
    const path = {
      coverage: 'ontario' as const,
      inputPointCount: 2,
      lastInputOccurredAt: '2026-09-17T12:00:00.000Z',
      lastMatchedPosition: null,
      matchedGeometry: null,
      matchedPointCount: 0,
      schemaVersion: 'route_tracking_road_match.v1' as const,
      uncertainGeometry: null,
      watermark: 'complete',
    };
    const provider = { match: vi.fn(() => Promise.resolve(path)) };
    const worker = new RouteTrackingRoadMatchWorker(repository as never, provider);

    expect(await worker.runDueBatch(new Date('2026-09-17T12:05:00.000Z'))).toBe(1);
    expect(repository.publishMatchedPath).toHaveBeenCalledWith(expect.objectContaining({ job: claimedJob, path }));
  });

  test('bounds concurrent provider calls', async () => {
    let active = 0;
    let maximumActive = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const jobs = Array.from({ length: 4 }, (_, index) => ({ ...claimedJob, id: `job-${index}`, routePlanId: `route-${index}` }));
    const repository = {
      claimNext: vi.fn()
        .mockImplementation(() => Promise.resolve(jobs.shift() ?? null)),
      loadInput: vi.fn(() => Promise.resolve(document)),
      markDead: vi.fn(),
      markSucceededWithoutPath: vi.fn(() => Promise.resolve(true)),
      publishMatchedPath: vi.fn(),
      releaseForRetry: vi.fn(),
    };
    const provider = {
      match: vi.fn(async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await gate;
        active -= 1;
        return null;
      }),
    };
    const worker = new RouteTrackingRoadMatchWorker(repository as never, provider, { batchSize: 4, concurrency: 2 });

    const pending = worker.runDueBatch(new Date('2026-09-17T12:05:00.000Z'));
    await vi.waitFor(() => expect(provider.match).toHaveBeenCalledTimes(2));
    expect(maximumActive).toBe(2);
    release();
    expect(await pending).toBe(4);
    expect(maximumActive).toBe(2);
  });

  test('renews the lease while a long provider call remains active', async () => {
    vi.useFakeTimers();
    try {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const repository = {
        claimNext: vi.fn().mockResolvedValueOnce(claimedJob).mockResolvedValueOnce(null),
        loadInput: vi.fn(() => Promise.resolve(document)),
        markDead: vi.fn(),
        markSucceededWithoutPath: vi.fn(() => Promise.resolve(true)),
        publishMatchedPath: vi.fn(),
        releaseForRetry: vi.fn(),
        renewLease: vi.fn(() => Promise.resolve(true)),
        requeueIfSuperseded: vi.fn(),
      };
      const provider = { match: vi.fn(async () => { await gate; return null; }) };
      const worker = new RouteTrackingRoadMatchWorker(repository, provider, { leaseMs: 3_000 });
      const pending = worker.runDueBatch(new Date('2026-09-17T12:05:00.000Z'));
      await vi.advanceTimersByTimeAsync(1_001);

      expect(repository.renewLease).toHaveBeenCalledWith(expect.objectContaining({
        job: claimedJob,
        leaseMs: 3_000,
      }));
      release();
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });
});
