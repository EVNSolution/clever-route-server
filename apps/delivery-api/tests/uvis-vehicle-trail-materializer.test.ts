import { describe, expect, test, vi } from 'vitest';

import {
  PrismaUvisVehicleTrailMaterializationRepository,
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
    expect(document.segments[0]?.roadMatchedGeometry).toBeNull();
    const upsertCalls = prisma.uvisVehicleTrailMaterialization.upsert.mock.calls as unknown as Array<[{
      create?: { finalizedAt?: Date | null };
      update?: { finalizedAt?: Date | null };
    }]>;
    const upsertInput = upsertCalls[0]?.[0];
    expect(upsertInput?.create?.finalizedAt).toBeInstanceOf(Date);
    expect(upsertInput?.update?.finalizedAt).toBeInstanceOf(Date);
  });

  test('keeps a null provider response retryable because it may be a transient OSRM failure', async () => {
    const prisma = prismaMock([
      gpsSample('sample-0', '2026-08-03T23:50:00.000Z', 37.0000, 127.0000),
      gpsSample('sample-1', '2026-08-03T23:51:00.000Z', 37.0010, 127.0000),
      gpsSample('sample-2', '2026-08-03T23:52:00.000Z', 37.0020, 127.0000),
    ]);
    const repository = new PrismaUvisVehicleTrailMaterializationRepository(prisma as never);

    const document = await repository.materializeVehicleDay({
      finalizing: true,
      roadMatchProvider: { match: vi.fn().mockResolvedValue(null) },
      serviceDate: '2026-08-04',
      shopId: 'shop-a',
      vehicleId: 'vehicle-a',
    });

    expect(document.retryable).toBe(true);
    expect(document.segments[0]?.roadMatchedGeometry).toBeNull();
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

function prismaMock(samples: unknown[]) {
  return {
    uvisVehicleTelemetrySample: {
      findMany: vi.fn(() => Promise.resolve(samples)),
    },
    uvisVehicleTrailMaterialization: {
      findUnique: vi.fn(() => Promise.resolve(null)),
      upsert: vi.fn(() => Promise.resolve({})),
    },
  };
}
