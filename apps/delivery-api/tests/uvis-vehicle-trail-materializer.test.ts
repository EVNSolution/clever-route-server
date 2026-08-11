import { describe, expect, test, vi } from 'vitest';

import {
  PrismaUvisVehicleTrailMaterializationRepository,
  UvisVehicleTrailMaterializationQueue,
} from '../src/modules/uvis/uvis-vehicle-trail-materializer.js';

describe('PrismaUvisVehicleTrailMaterializationRepository', () => {
  test('detects UVIS moving sessions with hysteresis, stale-gap restart, and service-day clipping', async () => {
    const prisma = prismaMock([
      gpsSample('sample-0', '2026-08-03T23:50:00.000Z', 37.0000, 127.0000),
      gpsSample('sample-1', '2026-08-03T23:51:00.000Z', 37.0010, 127.0000),
      gpsSample('sample-2', '2026-08-03T23:52:00.000Z', 37.0010, 127.0000),
      gpsSample('sample-3', '2026-08-03T23:53:00.000Z', 37.0020, 127.0000),
      gpsSample('sample-4', '2026-08-03T23:54:00.000Z', 37.0020, 127.0000, { speedKph: '0.00' }),
      gpsSample('sample-5', '2026-08-03T23:55:00.000Z', 37.0020, 127.0000, { speedKph: '0.00' }),
      gpsSample('sample-6', '2026-08-03T23:56:00.000Z', 37.0020, 127.0000, { speedKph: '0.00' }),
      gpsSample('sample-7', '2026-08-03T23:57:00.000Z', 37.0020, 127.0000, { speedKph: '0.00' }),
      gpsSample('sample-8', '2026-08-03T23:58:00.000Z', 37.0020, 127.0000, { speedKph: '0.00' }),
      gpsSample('sample-gap-a', '2026-08-04T00:20:00.000Z', 37.0100, 127.0000, { staleAfter: '2026-08-04T00:21:00.000Z' }),
      gpsSample('sample-gap-b', '2026-08-04T00:23:00.000Z', 37.0110, 127.0000),
      gpsSample('sample-gap-c', '2026-08-04T00:24:00.000Z', 37.0120, 127.0000),
      gpsSample('sample-gap-d', '2026-08-04T00:25:00.000Z', 37.0130, 127.0000),
      gpsSample('next-day', '2026-08-04T15:01:00.000Z', 37.0200, 127.0000),
    ]);
    const repository = new PrismaUvisVehicleTrailMaterializationRepository(prisma as never);

    const document = await repository.materializeVehicleDay({
      serviceDate: '2026-08-04',
      shopId: 'shop-a',
      vehicleId: 'vehicle-a',
    });

    expect(prisma.uvisVehicleTelemetrySample.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        observedAt: { gte: new Date('2026-08-03T15:00:00.000Z'), lt: new Date('2026-08-04T15:00:00.000Z') },
        sourceKind: 'VEHICLE_GPS',
      }) as unknown,
    }));
    expect(document.segments).toHaveLength(2);
    expect(document.segments[0]).toMatchObject({
      startedAt: '2026-08-03T23:50:00.000Z',
      trailMarker: { kind: 'START', observedAt: '2026-08-03T23:50:00.000Z' },
    });
    expect(document.segments[0]?.samples.map((sample) => sample.observedAt)).toContain('2026-08-03T23:58:00.000Z');
    expect(document.segments[1]).toMatchObject({
      startedAt: '2026-08-04T00:23:00.000Z',
      trailMarker: { kind: 'RESTART', observedAt: '2026-08-04T00:23:00.000Z' },
    });
    expect(JSON.stringify(document)).not.toContain('next-day');
  });

  test('does not use distanceTodayKm as movement evidence', async () => {
    const prisma = prismaMock([
      gpsSample('sample-0', '2026-08-03T23:50:00.000Z', 37.0000, 127.0000, { distanceTodayKm: '1.00', speedKph: '0.00' }),
      gpsSample('sample-1', '2026-08-03T23:51:00.000Z', 37.0000, 127.0000, { distanceTodayKm: '100.00', speedKph: '0.00' }),
      gpsSample('sample-2', '2026-08-03T23:52:00.000Z', 37.0000, 127.0000, { distanceTodayKm: '200.00', speedKph: '0.00' }),
    ]);
    const repository = new PrismaUvisVehicleTrailMaterializationRepository(prisma as never);

    await expect(repository.materializeVehicleDay({
      serviceDate: '2026-08-04',
      shopId: 'shop-a',
      vehicleId: 'vehicle-a',
    })).resolves.toMatchObject({ segments: [] });
  });

  test('materializes a two-point moving session at the end of the service day', async () => {
    const prisma = prismaMock([
      gpsSample('sample-0', '2026-08-03T23:50:00.000Z', 37.0000, 127.0000),
      gpsSample('sample-1', '2026-08-03T23:51:00.000Z', 37.0010, 127.0000),
    ]);
    const repository = new PrismaUvisVehicleTrailMaterializationRepository(prisma as never);

    const document = await repository.materializeVehicleDay({
      serviceDate: '2026-08-04',
      shopId: 'shop-a',
      vehicleId: 'vehicle-a',
    });

    expect(document.segments).toHaveLength(1);
    expect(document.segments[0]?.samples.map((sample) => sample.observedAt)).toEqual([
      '2026-08-03T23:50:00.000Z',
      '2026-08-03T23:51:00.000Z',
    ]);
  });

  test('materializes a two-point moving session before a stale telemetry gap', async () => {
    const prisma = prismaMock([
      gpsSample('sample-0', '2026-08-03T23:50:00.000Z', 37.0000, 127.0000),
      gpsSample('sample-1', '2026-08-03T23:51:00.000Z', 37.0010, 127.0000),
      gpsSample('sample-2', '2026-08-03T23:55:00.000Z', 37.0010, 127.0000),
    ]);
    const repository = new PrismaUvisVehicleTrailMaterializationRepository(prisma as never);

    const document = await repository.materializeVehicleDay({
      serviceDate: '2026-08-04',
      shopId: 'shop-a',
      vehicleId: 'vehicle-a',
    });

    expect(document.segments).toHaveLength(1);
    expect(document.segments[0]?.samples.map((sample) => sample.observedAt)).toEqual([
      '2026-08-03T23:50:00.000Z',
      '2026-08-03T23:51:00.000Z',
    ]);
  });

  test('omits low-confidence road geometry without retrying a completed OSRM response forever', async () => {
    const prisma = prismaMock([
      gpsSample('sample-0', '2026-08-03T23:50:00.000Z', 37.0000, 127.0000),
      gpsSample('sample-1', '2026-08-03T23:51:00.000Z', 37.0010, 127.0000),
      gpsSample('sample-2', '2026-08-03T23:52:00.000Z', 37.0020, 127.0000),
    ]);
    const roadMatchProvider = {
      match: vi.fn().mockResolvedValue({
        matchedGeometry: null,
        uncertainGeometry: { type: 'MultiLineString', coordinates: [[[127, 37], [127, 37.001]]] },
      }),
    };
    const repository = new PrismaUvisVehicleTrailMaterializationRepository(prisma as never);

    const document = await repository.materializeVehicleDay({
      finalizing: true,
      roadMatchProvider,
      serviceDate: '2026-08-04',
      shopId: 'shop-a',
      vehicleId: 'vehicle-a',
    });

    expect(document.retryable).toBe(false);
    expect(document.segments[0]?.roadMatchFailureReason).toBe('LOW_CONFIDENCE');
    expect(document.segments[0]?.roadMatchedGeometry).toBeNull();
    const upsertCalls = prisma.uvisVehicleTrailMaterialization.upsert.mock.calls as unknown as Array<[{
      create?: { finalizedAt?: Date | null };
      update?: { finalizedAt?: Date | null };
    }]>;
    const upsertInput = upsertCalls[0]?.[0];
    expect(upsertInput?.create?.finalizedAt).toBeInstanceOf(Date);
    expect(upsertInput?.update?.finalizedAt).toBeInstanceOf(Date);
  });

  test('keeps a null provider response retryable without immediate retries', async () => {
    const prisma = prismaMock([
      gpsSample('sample-0', '2026-08-03T23:50:00.000Z', 37.0000, 127.0000),
      gpsSample('sample-1', '2026-08-03T23:51:00.000Z', 37.0010, 127.0000),
      gpsSample('sample-2', '2026-08-03T23:52:00.000Z', 37.0020, 127.0000),
    ]);
    const repository = new PrismaUvisVehicleTrailMaterializationRepository(prisma as never);

    const match = vi.fn().mockResolvedValue(null);
    const document = await repository.materializeVehicleDay({
      finalizing: true,
      roadMatchProvider: { match },
      serviceDate: '2026-08-04',
      shopId: 'shop-a',
      vehicleId: 'vehicle-a',
    });

    expect(document.retryable).toBe(true);
    expect(document.segments[0]?.roadMatchFailureReason).toBe('TRANSIENT_FAILURE');
    expect(document.segments[0]?.roadMatchedGeometry).toBeNull();
    expect(match).toHaveBeenCalledTimes(1);
  });

  test('recovers a UVIS road match on a later materialization attempt', async () => {
    const prisma = prismaMock([
      gpsSample('sample-0', '2026-08-03T23:50:00.000Z', 37.0000, 127.0000),
      gpsSample('sample-1', '2026-08-03T23:51:00.000Z', 37.0010, 127.0000),
      gpsSample('sample-2', '2026-08-03T23:52:00.000Z', 37.0020, 127.0000),
    ]);
    const matchedGeometry = { type: 'MultiLineString' as const, coordinates: [[[127, 37], [127, 37.001], [127, 37.002]]] };
    const match = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ matchedGeometry, uncertainGeometry: null });
    const repository = new PrismaUvisVehicleTrailMaterializationRepository(prisma as never);

    const firstDocument = await repository.materializeVehicleDay({
      finalizing: true,
      roadMatchProvider: { match },
      serviceDate: '2026-08-04',
      shopId: 'shop-a',
      vehicleId: 'vehicle-a',
    });
    const document = await repository.materializeVehicleDay({
      finalizing: true,
      roadMatchProvider: { match },
      serviceDate: '2026-08-04',
      shopId: 'shop-a',
      vehicleId: 'vehicle-a',
    });

    expect(firstDocument.retryable).toBe(true);
    expect(document.retryable).toBe(false);
    expect(document.segments[0]?.roadMatchedGeometry).toEqual({
      ...matchedGeometry,
      anchors: [
        { coordinateIndex: 0, lineIndex: 0, observedAt: '2026-08-03T23:50:00.000Z' },
        { coordinateIndex: 1, lineIndex: 0, observedAt: '2026-08-03T23:51:00.000Z' },
        { coordinateIndex: 2, lineIndex: 0, observedAt: '2026-08-03T23:52:00.000Z' },
      ],
    });
    expect(match).toHaveBeenCalledTimes(2);
  });

  test('reuses unchanged materialized road geometry instead of rematching the day', async () => {
    const samples = [
      gpsSample('sample-0', '2026-08-03T23:50:00.000Z', 37.0000, 127.0000),
      gpsSample('sample-1', '2026-08-03T23:51:00.000Z', 37.0010, 127.0000),
      gpsSample('sample-2', '2026-08-03T23:52:00.000Z', 37.0020, 127.0000),
    ];
    const reusedGeometry = {
      anchors: [{ coordinateIndex: 0, lineIndex: 0, observedAt: '2026-08-03T23:50:00.000Z' }],
      coordinates: [[[127, 37], [127, 37.001], [127, 37.002]]],
      type: 'MultiLineString' as const,
    };
    const prisma = prismaMock(samples, {
      generatedAt: '2026-08-04T01:00:00.000Z',
      retryable: false,
      schemaVersion: 'uvis_vehicle_trail.v1',
      segments: [{
        endedAt: '2026-08-03T23:52:00.000Z',
        roadMatchedGeometry: reusedGeometry,
        samples: samples.map((sample) => ({
          distanceTodayKm: null,
          ignitionOn: true,
          latitude: Number(sample.latitude),
          longitude: Number(sample.longitude),
          observedAt: sample.observedAt.toISOString(),
          speedKph: 0,
          staleAfter: sample.staleAfter.toISOString(),
        })),
        startedAt: '2026-08-03T23:50:00.000Z',
        trailMarker: { kind: 'START', latitude: 37, longitude: 127, observedAt: '2026-08-03T23:50:00.000Z' },
      }],
      serviceDate: '2026-08-04',
      sourceSampleCount: 3,
      sourceWatermark: 'sha256:old',
      timezone: 'Asia/Seoul',
      vehicleId: 'vehicle-a',
    });
    const match = vi.fn().mockResolvedValue(null);
    const repository = new PrismaUvisVehicleTrailMaterializationRepository(prisma as never);

    const document = await repository.materializeVehicleDay({
      roadMatchProvider: { match },
      serviceDate: '2026-08-04',
      shopId: 'shop-a',
      vehicleId: 'vehicle-a',
    });

    expect(document.retryable).toBe(false);
    expect(document.segments[0]?.roadMatchedGeometry).toEqual(reusedGeometry);
    expect(match).not.toHaveBeenCalled();
  });

  test('reuses unchanged completed null road-match segments even when the previous document was retryable', async () => {
    const samples = [
      gpsSample('sample-0', '2026-08-03T23:50:00.000Z', 37.0000, 127.0000),
      gpsSample('sample-1', '2026-08-03T23:51:00.000Z', 37.0010, 127.0000),
      gpsSample('sample-2', '2026-08-03T23:52:00.000Z', 37.0020, 127.0000),
    ];
    const prisma = prismaMock(samples, previousTrailDocument({
      retryable: true,
      roadMatchedGeometry: null,
      roadMatchRetryable: false,
      samples,
    }));
    const match = vi.fn().mockResolvedValue(null);
    const repository = new PrismaUvisVehicleTrailMaterializationRepository(prisma as never);

    const document = await repository.materializeVehicleDay({
      roadMatchProvider: { match },
      serviceDate: '2026-08-04',
      shopId: 'shop-a',
      vehicleId: 'vehicle-a',
    });

    expect(document.retryable).toBe(false);
    expect(document.segments[0]?.roadMatchedGeometry).toBeNull();
    expect(match).not.toHaveBeenCalled();
  });

  test('keeps successful partial road matches retryable for a later queue attempt', async () => {
    const prisma = prismaMock([
      gpsSample('sample-0', '2026-08-03T23:50:00.000Z', 37.0000, 127.0000),
      gpsSample('sample-1', '2026-08-03T23:51:00.000Z', 37.0010, 127.0000),
      gpsSample('sample-2', '2026-08-03T23:52:00.000Z', 37.0020, 127.0000),
    ]);
    const matchedGeometry = { type: 'MultiLineString' as const, coordinates: [[[127, 37], [127, 37.001]]] };
    const repository = new PrismaUvisVehicleTrailMaterializationRepository(prisma as never);

    const document = await repository.materializeVehicleDay({
      roadMatchProvider: {
        match: vi.fn(),
        matchWithStatus: vi.fn().mockResolvedValue({
          path: { matchedGeometry, uncertainGeometry: null },
          retryable: true,
        }),
      } as never,
      serviceDate: '2026-08-04',
      shopId: 'shop-a',
      vehicleId: 'vehicle-a',
    });

    expect(document.retryable).toBe(true);
    expect(document.segments[0]?.roadMatchFailureReason).toBe('PARTIAL_TRANSIENT_FAILURE');
    expect(document.segments[0]?.roadMatchRetryable).toBe(true);
    expect(document.segments[0]?.roadMatchedGeometry).toEqual({
      ...matchedGeometry,
      anchors: [
        { coordinateIndex: 0, lineIndex: 0, observedAt: '2026-08-03T23:50:00.000Z' },
        { coordinateIndex: 1, lineIndex: 0, observedAt: '2026-08-03T23:51:00.000Z' },
        { coordinateIndex: 1, lineIndex: 0, observedAt: '2026-08-03T23:52:00.000Z' },
      ],
    });
  });

  test('keeps replay anchors moving forward through a returning road geometry', async () => {
    const prisma = prismaMock([
      gpsSample('sample-0', '2026-08-03T23:50:00.000Z', 37.0000, 127.0000),
      gpsSample('sample-1', '2026-08-03T23:51:00.000Z', 37.0000, 127.0020),
      gpsSample('sample-2', '2026-08-03T23:52:00.000Z', 37.0000, 127.0010),
    ]);
    const matchedGeometry = {
      type: 'MultiLineString' as const,
      coordinates: [[
        [127.0000, 37.0000] as [number, number],
        [127.0010, 37.0000] as [number, number],
        [127.0020, 37.0000] as [number, number],
        [127.0010, 37.0000] as [number, number],
        [127.0000, 37.0000] as [number, number],
      ]],
    };
    const repository = new PrismaUvisVehicleTrailMaterializationRepository(prisma as never);

    const document = await repository.materializeVehicleDay({
      finalizing: true,
      roadMatchProvider: { match: vi.fn().mockResolvedValue({ matchedGeometry, uncertainGeometry: null }) },
      serviceDate: '2026-08-04',
      shopId: 'shop-a',
      vehicleId: 'vehicle-a',
    });

    expect(document.segments[0]?.roadMatchedGeometry?.anchors?.map((anchor) => anchor.coordinateIndex)).toEqual([0, 2, 3]);
  });

  test('sends chronological samples to OSRM when movement starts after a stationary interval', async () => {
    const prisma = prismaMock([
      gpsSample('sample-0', '2026-08-03T23:50:00.000Z', 37.0000, 127.0000),
      gpsSample('sample-1', '2026-08-03T23:51:00.000Z', 37.0000, 127.0000),
      gpsSample('sample-2', '2026-08-03T23:52:00.000Z', 37.0010, 127.0000),
      gpsSample('sample-3', '2026-08-03T23:53:00.000Z', 37.0020, 127.0000),
    ]);
    const match = vi.fn().mockResolvedValue(null);
    const repository = new PrismaUvisVehicleTrailMaterializationRepository(prisma as never);

    await repository.materializeVehicleDay({
      roadMatchProvider: { match },
      serviceDate: '2026-08-04',
      shopId: 'shop-a',
      vehicleId: 'vehicle-a',
    });

    const calls = match.mock.calls as unknown as Array<[{
      samples: Array<{ occurredAt: string }>;
    }]>;
    const occurredAt = calls[0]![0].samples.map((sample) => sample.occurredAt);
    expect(occurredAt).toEqual([...occurredAt].sort());
  });

  test('drops an isolated impossible GPS jump and connects the surrounding samples for OSRM', async () => {
    const prisma = prismaMock([
      gpsSample('sample-0', '2026-08-03T23:50:00.000Z', 37.5000, 126.9000),
      gpsSample('sample-1', '2026-08-03T23:51:00.000Z', 37.5010, 126.9010),
      gpsSample('jump', '2026-08-03T23:52:00.000Z', 35.1000, 129.0000),
      gpsSample('sample-2', '2026-08-03T23:53:00.000Z', 37.5020, 126.9020),
      gpsSample('sample-3', '2026-08-03T23:54:00.000Z', 37.5030, 126.9030),
    ]);
    const match = vi.fn().mockResolvedValue(null);
    const repository = new PrismaUvisVehicleTrailMaterializationRepository(prisma as never);

    await repository.materializeVehicleDay({
      roadMatchProvider: { match },
      serviceDate: '2026-08-04',
      shopId: 'shop-a',
      vehicleId: 'vehicle-a',
    });

    const calls = match.mock.calls as unknown as Array<[{
      samples: Array<{ eventId: string }>;
    }]>;
    expect(calls[0]![0].samples.map((sample) => sample.eventId)).not.toContain('jump');
  });

  test('preserves finalizedAt on non-finalizing refresh and rewrites it on re-finalization', async () => {
    const prisma = prismaMock([
      gpsSample('sample-0', '2026-08-03T23:50:00.000Z', 37.0000, 127.0000),
      gpsSample('sample-1', '2026-08-03T23:51:00.000Z', 37.0010, 127.0000),
      gpsSample('sample-2', '2026-08-03T23:52:00.000Z', 37.0020, 127.0000),
    ]);
    const repository = new PrismaUvisVehicleTrailMaterializationRepository(prisma as never);

    await repository.materializeVehicleDay({
      finalizing: false,
      serviceDate: '2026-08-04',
      shopId: 'shop-a',
      vehicleId: 'vehicle-a',
    });
    await repository.materializeVehicleDay({
      finalizing: true,
      now: new Date('2026-08-05T00:00:00.000Z'),
      serviceDate: '2026-08-04',
      shopId: 'shop-a',
      vehicleId: 'vehicle-a',
    });

    const upsertCalls = prisma.uvisVehicleTrailMaterialization.upsert.mock.calls as unknown as Array<[{
      update?: { finalizedAt?: Date | null };
    }]>;
    expect(upsertCalls[0]?.[0].update).not.toHaveProperty('finalizedAt');
    expect(upsertCalls[1]?.[0].update?.finalizedAt).toEqual(new Date('2026-08-05T00:00:00.000Z'));
  });
});

describe('UvisVehicleTrailMaterializationQueue', () => {
  test('retries retryable materializations after bounded backoff without new samples', async () => {
    vi.useFakeTimers();
    try {
      const repository = {
        materializeVehicleDay: vi.fn()
          .mockResolvedValueOnce({ retryable: true })
          .mockResolvedValueOnce({ retryable: false }),
      };
      const queue = new UvisVehicleTrailMaterializationQueue({
        repository: repository as never,
        retryDelaysMs: [100],
      });

      queue.enqueue({
        observedAt: new Date('2026-08-03T23:50:00.000Z'),
        shopId: 'shop-a',
        vehicleId: 'vehicle-a',
      });

      await vi.runOnlyPendingTimersAsync();
      expect(repository.materializeVehicleDay).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(99);
      expect(repository.materializeVehicleDay).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(repository.materializeVehicleDay).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

function gpsSample(
  id: string,
  observedAt: string,
  latitude: number,
  longitude: number,
  overrides: Partial<{ distanceTodayKm: string; speedKph: string; staleAfter: string }> = {},
) {
  return {
    distanceTodayKm: overrides.distanceTodayKm ?? null,
    id,
    ignitionOn: true,
    latitude: latitude.toFixed(7),
    longitude: longitude.toFixed(7),
    observedAt: new Date(observedAt),
    speedKph: overrides.speedKph ?? '0.00',
    staleAfter: new Date(overrides.staleAfter ?? new Date(new Date(observedAt).getTime() + 120_000).toISOString()),
  };
}

function previousTrailDocument(input: {
  retryable: boolean;
  roadMatchedGeometry: unknown;
  roadMatchRetryable: boolean;
  samples: ReturnType<typeof gpsSample>[];
}) {
  return {
    generatedAt: '2026-08-04T01:00:00.000Z',
    retryable: input.retryable,
    schemaVersion: 'uvis_vehicle_trail.v1',
    segments: [{
      endedAt: '2026-08-03T23:52:00.000Z',
      roadMatchedGeometry: input.roadMatchedGeometry,
      roadMatchRetryable: input.roadMatchRetryable,
      samples: input.samples.map((sample) => ({
        distanceTodayKm: null,
        ignitionOn: true,
        latitude: Number(sample.latitude),
        longitude: Number(sample.longitude),
        observedAt: sample.observedAt.toISOString(),
        speedKph: 0,
        staleAfter: sample.staleAfter.toISOString(),
      })),
      startedAt: '2026-08-03T23:50:00.000Z',
      trailMarker: { kind: 'START', latitude: 37, longitude: 127, observedAt: '2026-08-03T23:50:00.000Z' },
    }],
    serviceDate: '2026-08-04',
    sourceSampleCount: input.samples.length,
    sourceWatermark: 'sha256:old',
    timezone: 'Asia/Seoul',
    vehicleId: 'vehicle-a',
  };
}

function prismaMock(samples: unknown[], previousDocument: unknown = null) {
  return {
    uvisVehicleTelemetrySample: {
      findMany: vi.fn(() => Promise.resolve(samples)),
    },
    uvisVehicleTrailMaterialization: {
      findUnique: vi.fn(() => Promise.resolve(previousDocument === null ? null : { document: previousDocument })),
      upsert: vi.fn(() => Promise.resolve({})),
    },
  };
}
