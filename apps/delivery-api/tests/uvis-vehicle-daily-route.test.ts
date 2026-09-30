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

  test('offers a separate inferred line only across the reviewed, unbranched eastbound tunnel corridor', () => {
    const before: [number, number] = [126.9527800, 37.5961700];
    const frozen: [number, number] = [126.9562500, 37.5958300];
    const exit: [number, number] = [126.9956200, 37.6097700];
    const after: [number, number] = [127.0065000, 37.6067500];
    const beforeAnchor: [number, number] = [126.9527560, 37.5961346];
    const frozenAnchor: [number, number] = [126.9562349, 37.5958118];
    const exitAnchor: [number, number] = [126.9956786, 37.6097365];
    const afterAnchor: [number, number] = [127.0064424, 37.6068035];
    const times = Array.from({ length: 9 }, (_, index) =>
      new Date(Date.parse('2026-09-29T22:37:58.000Z') + index * 60_000).toISOString()
    );
    const samples = [before, frozen, frozen, frozen, frozen, frozen, frozen, exit, after]
      .map(([longitude, latitude], index) => ({
        ...sample(times[index]!, latitude, longitude),
        ignitionOn: true,
        speedKph: index > 1 && index < 7 ? 255 : 40,
      }));
    const document = trailDocument(samples, [[beforeAnchor, frozenAnchor], [exitAnchor, afterAnchor]], samples.map((item, index) => ({
      observedAt: item.observedAt,
      lineIndex: index < 7 ? 0 : 1,
      coordinateIndex: index === 0 || index === 7 ? 0 : 1,
    })));

    const route = buildUvisVehicleDailyRoute(samples, document);
    const bridge = route?.bridges.find((item) => item.reason === 'IMPLAUSIBLE_JUMP');

    expect(bridge).toMatchObject({
      fromObservedAt: times[6],
      toObservedAt: times[7],
      inferredTunnel: {
        corridorId: 'seoul-hongjimun-jeongneung-eastbound',
        fromObservedAt: times[1],
        source: 'CURATED_OSM_TUNNEL_CORRIDOR',
        toObservedAt: times[7],
        type: 'LineString',
      },
    });
    expect(bridge?.inferredTunnel?.coordinates).toContainEqual([126.9721756, 37.6058116]);
    expect(bridge?.inferredTunnel?.coordinates).toContainEqual([126.9921619, 37.6096480]);
    expect(route?.coordinates).not.toContainEqual([126.9721756, 37.6058116]);

    const afterAt120Seconds = samples.map((item, index) => index === 7
      ? { ...item, staleAfter: new Date(Date.parse(item.observedAt) + 120_000).toISOString() }
      : index === 8 ? { ...item, observedAt: new Date(Date.parse(item.observedAt) + 60_000).toISOString() }
        : item);
    const afterAt120SecondsDocument = trailDocument(afterAt120Seconds, [
      [beforeAnchor, frozenAnchor], [exitAnchor, afterAnchor],
    ], afterAt120Seconds.map((item, index) => ({
      observedAt: item.observedAt,
      lineIndex: index < 7 ? 0 : 1,
      coordinateIndex: index === 0 || index === 7 ? 0 : 1,
    })));
    expect(buildUvisVehicleDailyRoute(afterAt120Seconds, afterAt120SecondsDocument)?.bridges.find((item) =>
      item.fromObservedAt === times[6]
    )?.inferredTunnel?.corridorId).toBe('seoul-hongjimun-jeongneung-eastbound');

    const stationary = samples.map((item, index) => ({ ...item, speedKph: index > 1 && index < 7 ? 0 : item.speedKph }));
    expect(buildUvisVehicleDailyRoute(stationary, document)?.bridges.find((item) =>
      item.reason === 'IMPLAUSIBLE_JUMP'
    )?.inferredTunnel).toBeUndefined();

    const ignitionOff = samples.map((item, index) => ({ ...item, ignitionOn: index === 4 ? false : item.ignitionOn }));
    expect(buildUvisVehicleDailyRoute(ignitionOff, document)?.bridges.find((item) =>
      item.reason === 'IMPLAUSIBLE_JUMP'
    )?.inferredTunnel).toBeUndefined();

    const stale = samples.map((item, index) => index === 6 ? { ...item, staleAfter: item.observedAt } : item);
    expect(buildUvisVehicleDailyRoute(stale, document)?.bridges.find((item) =>
      item.fromObservedAt === times[6]
    )).toMatchObject({ reason: 'GPS_GAP' });
    expect(buildUvisVehicleDailyRoute(stale, document)?.bridges.find((item) =>
      item.fromObservedAt === times[6]
    )?.inferredTunnel).toBeUndefined();

    const longGap = samples.map((item, index) => index < 7 ? item : {
      ...item,
      observedAt: new Date(Date.parse(item.observedAt) + 4 * 60_000).toISOString(),
    });
    expect(buildUvisVehicleDailyRoute(longGap, document)?.bridges.find((item) =>
      item.fromObservedAt === times[6]
    )?.inferredTunnel).toBeUndefined();

    const parallelDocument = trailDocument(samples, [[beforeAnchor, frozenAnchor], [
      [exitAnchor[0], exitAnchor[1] + 0.0004],
      [afterAnchor[0], afterAnchor[1] + 0.0004],
    ]], document.segments[0]!.roadMatchedGeometry!.anchors!);
    expect(buildUvisVehicleDailyRoute(samples, parallelDocument)?.bridges.find((item) =>
      item.reason === 'IMPLAUSIBLE_JUMP'
    )?.inferredTunnel).toBeUndefined();

    const beyondReviewedExit: [number, number] = [126.9978655, 37.6090448];
    const beyondReviewedAfter: [number, number] = [127.0002551, 37.6082390];
    const beyondReviewed = samples.map((item, index) => index === 7
      ? { ...item, longitude: beyondReviewedExit[0], latitude: beyondReviewedExit[1] }
      : index === 8 ? { ...item, longitude: beyondReviewedAfter[0], latitude: beyondReviewedAfter[1] } : item);
    const beyondReviewedDocument = trailDocument(beyondReviewed, [[beforeAnchor, frozenAnchor], [
      beyondReviewedExit, beyondReviewedAfter,
    ]], document.segments[0]!.roadMatchedGeometry!.anchors!);
    expect(buildUvisVehicleDailyRoute(beyondReviewed, beyondReviewedDocument)?.bridges.find((item) =>
      item.reason === 'IMPLAUSIBLE_JUMP'
    )?.inferredTunnel).toBeUndefined();

    const offCorridor = samples.map((item, index) => index < 7 ? item : { ...item, latitude: item.latitude + 0.005 });
    const offCorridorDocument = trailDocument(offCorridor, [[beforeAnchor, frozenAnchor], [
      [exit[0], exit[1] + 0.005],
      [after[0], after[1] + 0.005],
    ]], document.segments[0]!.roadMatchedGeometry!.anchors!);
    expect(buildUvisVehicleDailyRoute(offCorridor, offCorridorDocument)?.bridges.find((item) =>
      item.reason === 'IMPLAUSIBLE_JUMP'
    )?.inferredTunnel).toBeUndefined();
  });

  test('waits for a later mainline witness before inferring the reviewed Suam–Suri tunnel gap', () => {
    const before: [number, number] = [126.8718553, 37.3684129];
    const frozen: [number, number] = [126.88213, 37.36940];
    const exit: [number, number] = [126.93495, 37.37628];
    const witness: [number, number] = [126.964, 37.38165];
    const exitAnchor: [number, number] = [126.9355957, 37.3763828];
    const times = Array.from({ length: 8 }, (_, index) =>
      new Date(Date.parse('2026-09-30T01:46:54.000Z') + index * 60_000).toISOString()
    );
    const samples = [before, frozen, frozen, frozen, frozen, exit, exit, witness]
      .map(([longitude, latitude], index) => ({
        ...sample(times[index]!, latitude, longitude),
        ignitionOn: true,
        speedKph: index === 6 || (index >= 2 && index <= 4) ? 255 : 70,
      }));
    const anchors = [0, 1, 5, 6, 7].map((index) => ({
      observedAt: times[index]!,
      lineIndex: index < 5 ? 0 : 1,
      coordinateIndex: index === 0 || index === 5 || index === 6 ? 0 : 1,
    }));
    const document = trailDocument(samples, [
      [before, [126.8820994, 37.3693881]],
      [exitAnchor, witness],
    ], anchors);
    const tunnelBridge = (source = samples, trail = document) =>
      buildUvisVehicleDailyRoute(source, trail)?.bridges.find((item) => item.fromObservedAt === times[4]);

    expect(tunnelBridge(samples.slice(0, 6))?.inferredTunnel).toBeUndefined();
    expect(tunnelBridge(samples.slice(0, 7))?.inferredTunnel).toBeUndefined();
    expect(tunnelBridge()).toMatchObject({
      reason: 'IMPLAUSIBLE_JUMP',
      inferredTunnel: {
        confirmedByObservedAt: times[7],
        corridorId: 'seoul-suam-suri-eastbound',
        fromObservedAt: times[1],
        toObservedAt: times[5],
      },
    });
    expect(tunnelBridge()?.inferredTunnel?.coordinates).toContainEqual([126.8998493, 37.3716324]);
    expect(tunnelBridge()?.inferredTunnel?.coordinates).toContainEqual([126.9264516, 37.3751596]);
    expect(buildUvisVehicleDailyRoute(samples, document)?.coordinates).not.toContainEqual([126.8998493, 37.3716324]);

    const stopped = samples.map((item, index) => ({ ...item, speedKph: index >= 2 && index <= 4 ? 0 : item.speedKph }));
    expect(tunnelBridge(stopped)?.inferredTunnel).toBeUndefined();
    const ignitionOff = samples.map((item, index) => ({ ...item, ignitionOn: index === 3 ? false : item.ignitionOn }));
    expect(tunnelBridge(ignitionOff)?.inferredTunnel).toBeUndefined();
    const noRepeatSignal = samples.map((item, index) => ({ ...item, speedKph: index === 6 ? 0 : item.speedKph }));
    expect(tunnelBridge(noRepeatSignal)?.inferredTunnel).toBeUndefined();
    const staleAfterExit = samples.map((item, index) => index === 5
      ? { ...item, staleAfter: item.observedAt } : item);
    expect(tunnelBridge(staleAfterExit)?.inferredTunnel).toBeUndefined();
    const staleBeforeEntry = samples.map((item, index) => index === 0
      ? { ...item, staleAfter: item.observedAt } : item);
    expect(tunnelBridge(staleBeforeEntry)?.inferredTunnel).toBeUndefined();
    const staleFrozenHeartbeat = samples.map((item, index) => index === 2
      ? { ...item, staleAfter: item.observedAt } : item);
    expect(tunnelBridge(staleFrozenHeartbeat)?.inferredTunnel).toBeUndefined();
    const invalidMovingWitness = samples.map((item, index) => index === 7
      ? { ...item, speedKph: 255 } : item);
    expect(tunnelBridge(invalidMovingWitness)?.inferredTunnel).toBeUndefined();

    const slowFrozenHeartbeat = samples.map((item, index) => index === 2
      ? { ...item, staleAfter: new Date(Date.parse(item.observedAt) + 120_000).toISOString() }
      : index >= 3 ? {
        ...item,
        observedAt: new Date(Date.parse(item.observedAt) + 60_000).toISOString(),
        staleAfter: new Date(Date.parse(item.staleAfter) + 60_000).toISOString(),
      } : item);
    const slowHeartbeatDocument = trailDocument(slowFrozenHeartbeat, [
      [before, [126.8820994, 37.3693881]], [exitAnchor, witness],
    ], anchors.map((anchor, index) => ({ ...anchor, observedAt: slowFrozenHeartbeat[[0, 1, 5, 6, 7][index]!]!.observedAt })));
    expect(buildUvisVehicleDailyRoute(slowFrozenHeartbeat, slowHeartbeatDocument)?.bridges.find((item) =>
      item.reason === 'IMPLAUSIBLE_JUMP'
    )?.inferredTunnel).toBeUndefined();

    const nearWitness: [number, number] = [126.93565, 37.3764];
    const nearAnchor: [number, number] = [126.9356057, 37.3763838];
    const adjacentAnchorSamples = samples.map((item, index) => index === 7
      ? { ...item, longitude: nearWitness[0], latitude: nearWitness[1] } : item);
    const adjacentAnchorDocument = trailDocument(adjacentAnchorSamples, [
      [before, [126.8820994, 37.3693881]], [exitAnchor, nearAnchor],
    ], anchors);
    expect(tunnelBridge(adjacentAnchorSamples, adjacentAnchorDocument)?.inferredTunnel).toBeUndefined();

    const beforeDecision: [number, number] = [126.9303258, 37.3756666];
    const branchSamples = samples.map((item, index) => index === 5 || index === 6
      ? { ...item, longitude: beforeDecision[0], latitude: beforeDecision[1] } : item);
    const branchDocument = trailDocument(branchSamples, [
      [before, [126.8820994, 37.3693881]], [beforeDecision, witness],
    ], anchors);
    expect(tunnelBridge(branchSamples, branchDocument)?.inferredTunnel).toBeUndefined();

    const distantAnchor: [number, number] = [126.9361, 37.3765];
    const distantDocument = trailDocument(samples, [
      [before, [126.8820994, 37.3693881]], [distantAnchor, witness],
    ], anchors);
    expect(tunnelBridge(samples, distantDocument)?.inferredTunnel).toBeUndefined();

    const stale = samples.map((item, index) => index === 4 ? { ...item, staleAfter: item.observedAt } : item);
    expect(tunnelBridge(stale)?.reason).toBe('GPS_GAP');
    expect(tunnelBridge(stale)?.inferredTunnel).toBeUndefined();
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
