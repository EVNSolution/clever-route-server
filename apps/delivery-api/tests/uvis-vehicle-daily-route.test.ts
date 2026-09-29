import { describe, expect, test } from 'vitest';

import { buildUvisVehicleDailyRoute } from '../src/modules/uvis/uvis-vehicle-daily-route.js';
import type { UvisVehicleTrailDocumentV1 } from '../src/modules/uvis/uvis-vehicle-trail-materializer.js';

describe('buildUvisVehicleDailyRoute', () => {
  test('joins movement sessions and stale gaps into one continuous daily line', () => {
    const samples = [
      sample('2026-09-29T00:00:00.000Z', 37, 127, '2026-09-29T00:01:00.000Z'),
      sample('2026-09-29T00:01:00.000Z', 37.001, 127, '2026-09-29T00:02:00.000Z'),
      sample('2026-09-29T00:10:00.000Z', 37.01, 127, '2026-09-29T00:11:00.000Z'),
      sample('2026-09-29T00:11:00.000Z', 37.011, 127, '2026-09-29T00:12:00.000Z'),
    ];

    const route = buildUvisVehicleDailyRoute(samples, null);

    expect(route).toMatchObject({
      type: 'LineString',
      sourceSampleCount: 4,
      coordinates: [[127, 37], [127, 37.001], [127, 37.01], [127, 37.011]],
      bridges: [
        { fromObservedAt: samples[0]!.observedAt, toObservedAt: samples[1]!.observedAt, reason: 'NO_MATCH' },
        { fromObservedAt: samples[1]!.observedAt, toObservedAt: samples[2]!.observedAt, reason: 'GPS_GAP' },
        { fromObservedAt: samples[2]!.observedAt, toObservedAt: samples[3]!.observedAt, reason: 'NO_MATCH' },
      ],
    });
    expect(route?.anchors.map((anchor) => anchor.coordinateIndex)).toEqual([0, 1, 2, 3]);
  });

  test('retains trusted matched road vertices and shares an index for the same snapped coordinate', () => {
    const samples = [
      sample('2026-09-29T01:00:00.000Z', 37, 127),
      sample('2026-09-29T01:01:00.000Z', 37.001, 127),
      sample('2026-09-29T01:02:00.000Z', 37.002, 127),
    ];
    const document = trailDocument(samples, [[
      [127, 37],
      [127.0002, 37.0005],
      [127.0001, 37.001],
      [127, 37.002],
    ]], [
      { observedAt: samples[0]!.observedAt, lineIndex: 0, coordinateIndex: 0 },
      { observedAt: samples[1]!.observedAt, lineIndex: 0, coordinateIndex: 2 },
      { observedAt: samples[2]!.observedAt, lineIndex: 0, coordinateIndex: 2 },
    ]);

    const route = buildUvisVehicleDailyRoute(samples, document);

    expect(route?.coordinates).toEqual([
      [127, 37],
      [127.0002, 37.0005],
      [127.0001, 37.001],
    ]);
    expect(route?.bridges).toEqual([]);
    expect(route?.anchors).toEqual([
      { observedAt: samples[0]!.observedAt, coordinateIndex: 0 },
      { observedAt: samples[1]!.observedAt, coordinateIndex: 2 },
      { observedAt: samples[2]!.observedAt, coordinateIndex: 2 },
    ]);
  });

  test('does not promote an impossible frozen-position jump to a matched road', () => {
    const samples = [
      sample('2026-09-29T22:33:44.000Z', 37.285223, 126.949263),
      sample('2026-09-29T22:34:44.000Z', 37.243395, 126.950675),
    ];
    const roadVertex: [number, number] = [126.96, 37.26];
    const document = trailDocument(samples, [[
      [126.949263, 37.285223],
      roadVertex,
      [126.950675, 37.243395],
    ]], [
      { observedAt: samples[0]!.observedAt, lineIndex: 0, coordinateIndex: 0 },
      { observedAt: samples[1]!.observedAt, lineIndex: 0, coordinateIndex: 2 },
    ]);

    const route = buildUvisVehicleDailyRoute(samples, document);

    expect(route?.coordinates).toEqual([
      [126.949263, 37.285223],
      [126.950675, 37.243395],
    ]);
    expect(route?.coordinates).not.toContainEqual(roadVertex);
    expect(route?.bridges).toEqual([{
      fromObservedAt: samples[0]!.observedAt,
      toObservedAt: samples[1]!.observedAt,
      reason: 'IMPLAUSIBLE_JUMP',
    }]);
  });

  test('uses distinct raw endpoints when trusted anchors collapse the whole path to one point', () => {
    const samples = [
      sample('2026-09-29T01:10:00.000Z', 37, 127),
      sample('2026-09-29T01:11:00.000Z', 37.001, 127),
    ];
    const document = trailDocument(samples, [[
      [127, 37.0005],
      [127.0001, 37.0005],
    ]], [
      { observedAt: samples[0]!.observedAt, lineIndex: 0, coordinateIndex: 0 },
      { observedAt: samples[1]!.observedAt, lineIndex: 0, coordinateIndex: 0 },
    ]);

    const route = buildUvisVehicleDailyRoute(samples, document);

    expect(route?.coordinates).toEqual([[127, 37], [127, 37.001]]);
    expect(route?.bridges).toEqual([{
      fromObservedAt: samples[0]!.observedAt,
      toObservedAt: samples[1]!.observedAt,
      reason: 'NO_MATCH',
    }]);
  });

  test('falls back to raw GPS when a matched anchor is distant or invalid', () => {
    const samples = [
      sample('2026-09-29T02:00:00.000Z', 37, 127),
      sample('2026-09-29T02:01:00.000Z', 37.001, 127),
      sample('2026-09-29T02:02:00.000Z', 37.002, 127),
    ];
    const document = trailDocument(samples, [[
      [128, 38],
      [Number.NaN, 38.001],
      [128, 38.002],
    ]], [
      { observedAt: samples[0]!.observedAt, lineIndex: 0, coordinateIndex: 0 },
      { observedAt: samples[1]!.observedAt, lineIndex: 0, coordinateIndex: 1 },
      { observedAt: samples[2]!.observedAt, lineIndex: 0, coordinateIndex: 2 },
    ]);

    const route = buildUvisVehicleDailyRoute(samples, document);

    expect(route?.coordinates).toEqual([[127, 37], [127, 37.001], [127, 37.002]]);
    expect(route?.bridges).toHaveLength(2);
  });

  test('falls back to raw GPS when an otherwise trusted road range contains an invalid vertex', () => {
    const samples = [
      sample('2026-09-29T02:10:00.000Z', 37, 127),
      sample('2026-09-29T02:11:00.000Z', 37.001, 127),
    ];
    const document = trailDocument(samples, [[
      [127, 37],
      [Number.NaN, 37.0005],
      [127.0001, 37.001],
    ]], [
      { observedAt: samples[0]!.observedAt, lineIndex: 0, coordinateIndex: 0 },
      { observedAt: samples[1]!.observedAt, lineIndex: 0, coordinateIndex: 2 },
    ]);

    const route = buildUvisVehicleDailyRoute(samples, document);

    expect(route?.coordinates).toEqual([[127, 37], [127, 37.001]]);
    expect(route?.bridges).toEqual([{
      fromObservedAt: samples[0]!.observedAt,
      toObservedAt: samples[1]!.observedAt,
      reason: 'NO_MATCH',
    }]);
  });

  test('excludes an isolated impossible spike, same-second duplicate, and invalid coordinates without mutating input', () => {
    const samples = [
      sample('2026-09-29T03:00:00.000Z', 37, 127),
      sample('2026-09-29T03:00:00.500Z', 37.0001, 127),
      sample('2026-09-29T03:01:00.000Z', 38, 128),
      sample('2026-09-29T03:02:00.000Z', 37.002, 127),
      sample('2026-09-29T03:03:00.000Z', 95, 127),
    ];
    const before = structuredClone(samples);

    const route = buildUvisVehicleDailyRoute(samples, null);

    expect(route?.coordinates).toEqual([[127, 37], [127, 37.002]]);
    expect(route?.sourceSampleCount).toBe(2);
    expect(samples).toEqual(before);
  });

  test('returns null without at least two valid distinct coordinates', () => {
    expect(buildUvisVehicleDailyRoute([], null)).toBeNull();
    expect(buildUvisVehicleDailyRoute([sample('2026-09-29T04:00:00.000Z', 37, 127)], null)).toBeNull();
    expect(buildUvisVehicleDailyRoute([
      sample('2026-09-29T04:00:00.000Z', 37, 127),
      sample('2026-09-29T04:01:00.000Z', 37, 127),
    ], null)).toBeNull();
  });
});

function sample(observedAt: string, latitude: number, longitude: number, staleAfter?: string) {
  return {
    latitude,
    longitude,
    observedAt,
    staleAfter: staleAfter ?? new Date(Date.parse(observedAt) + 60_000).toISOString(),
  };
}

function trailDocument(
  samples: ReturnType<typeof sample>[],
  coordinates: Array<Array<[number, number]>>,
  anchors: Array<{ coordinateIndex: number; lineIndex: number; observedAt: string }>,
): UvisVehicleTrailDocumentV1 {
  return {
    generatedAt: '2026-09-29T05:00:00.000Z',
    retryable: false,
    schemaVersion: 'uvis_vehicle_trail.v1',
    segments: [{
      endedAt: samples.at(-1)!.observedAt,
      roadMatchedGeometry: { type: 'MultiLineString', coordinates, anchors },
      samples: samples.map((item) => ({
        ...item,
        distanceTodayKm: null,
        ignitionOn: null,
        speedKph: null,
      })),
      startedAt: samples[0]!.observedAt,
      trailMarker: { kind: 'START', ...samples[0]! },
    }],
    serviceDate: '2026-09-29',
    sourceSampleCount: samples.length,
    sourceWatermark: samples.at(-1)!.observedAt,
    timezone: 'Asia/Seoul',
    vehicleId: 'vehicle-a',
  };
}
