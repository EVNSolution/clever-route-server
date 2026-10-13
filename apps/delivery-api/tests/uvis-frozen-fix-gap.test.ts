import { readFileSync } from 'node:fs';

import { describe, expect, test, vi } from 'vitest';

import { findTunnelSignature } from '../src/modules/uvis/uvis-tunnel-bridge.js';
import { buildUvisVehicleDailyRoute } from '../src/modules/uvis/uvis-vehicle-daily-route.js';
import { PrismaUvisVehicleTrailMaterializationRepository } from '../src/modules/uvis/uvis-vehicle-trail-materializer.js';
import { foldFrozenFixRuns } from '../src/modules/uvis/uvis-vehicle-trail-evidence.js';

type FixtureSample = {
  ignitionOn: boolean;
  latitude: number;
  longitude: number;
  observedAt: string;
  speedKph: number;
  staleAfter: string;
};

// 경기83사7311 (ebe9167c), service day 2026-10-13 KST. The unit repeats one coordinate at speed 0 with the
// ignition on for 4-10 minutes, then jumps 3.6-5.3 km in the next 60 s poll. Pulled read-only from production.
const FIXTURE = JSON.parse(
  readFileSync(new URL('./fixtures/uvis-gyeonggi83sa7311-frozen-speed0-20261013.json', import.meta.url), 'utf8'),
) as { samples: FixtureSample[] };
const FIRST_GAP = { from: '2026-10-12T22:18:04.000Z', to: '2026-10-12T22:23:04.000Z' };
const SECOND_GAP = { from: '2026-10-12T22:29:04.000Z', to: '2026-10-12T22:39:04.000Z' };

function straightRoute(from: [number, number], to: [number, number], points = 8) {
  return {
    coordinates: Array.from({ length: points }, (_, index): [number, number] => {
      const ratio = index / (points - 1);
      return [from[0] + (to[0] - from[0]) * ratio, from[1] + (to[1] - from[1]) * ratio];
    }),
    distanceMeters: 0,
  };
}

function repositoryFor(samples: FixtureSample[], seed: unknown = null) {
  const rows = samples.map((sample, index) => ({
    distanceTodayKm: null,
    id: `sample-${index}`,
    ignitionOn: sample.ignitionOn,
    latitude: sample.latitude.toFixed(7),
    longitude: sample.longitude.toFixed(7),
    observedAt: new Date(sample.observedAt),
    speedKph: sample.speedKph.toFixed(2),
    staleAfter: new Date(sample.staleAfter),
  }));
  let stored: unknown = seed;
  const prisma = {
    uvisVehicleTelemetrySample: { findMany: vi.fn(() => Promise.resolve(rows)) },
    uvisVehicleTrailMaterialization: {
      findUnique: vi.fn(() => Promise.resolve(stored === null ? null : { document: stored })),
      upsert: vi.fn((input: { create: { document: unknown } }) => {
        stored = input.create.document;
        return Promise.resolve(input);
      }),
    },
  };
  const routeBetween = vi.fn((from: { coordinate: [number, number] }, to: { coordinate: [number, number] }) =>
    Promise.resolve(straightRoute(from.coordinate, to.coordinate)));
  const roadMatchProvider = { match: vi.fn().mockResolvedValue(null), routeBetween };
  return {
    input: { roadMatchProvider, serviceDate: '2026-10-13', shopId: 'shop-a', vehicleId: 'vehicle-a' },
    repository: new PrismaUvisVehicleTrailMaterializationRepository(prisma as never),
    routeBetween,
  };
}

// A vehicle that really stopped: the same coordinate repeats and the next fix is still near it.
function stoppedThenMoved(nextLatitude: number, overrides: Partial<FixtureSample> = {}): FixtureSample[] {
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 13, 1, minute, 0)).toISOString();
  const staleAt = (minute: number) => new Date(Date.UTC(2026, 9, 13, 1, minute + 2, 0)).toISOString();
  const fix = (minute: number, latitude: number, extra: Partial<FixtureSample> = {}): FixtureSample => ({
    ignitionOn: true, latitude, longitude: 127, observedAt: at(minute), speedKph: 0, staleAfter: staleAt(minute), ...extra,
  });
  return [
    fix(0, 37.5, { speedKph: 30 }),
    fix(1, 37.51),
    fix(2, 37.51, overrides),
    fix(3, 37.51),
    fix(4, 37.51),
    fix(5, nextLatitude, { speedKph: 30 }),
    fix(6, nextLatitude + 0.001, { speedKph: 30 }),
  ];
}

describe('frozen fix folding', () => {
  test('folds each exact repeat run of the speed-0 fixture into its first fix, marked as a gap', () => {
    const folded = foldFrozenFixRuns(FIXTURE.samples);
    expect(folded).toHaveLength(FIXTURE.samples.length - 4 - 9);
    const marked = folded.filter((sample) => sample.frozenGap !== undefined);
    expect(marked.map((sample) => sample.observedAt)).toEqual([FIRST_GAP.from, SECOND_GAP.from]);
    expect(marked[0]!.frozenGap).toEqual({
      continuous: true,
      lastObservedAt: '2026-10-12T22:22:04.000Z',
      lastStaleAfter: '2026-10-12T22:24:04.000Z',
      noFixRepeats: 0,
      repeats: 5,
    });
    expect(marked[1]!.frozenGap).toMatchObject({ lastObservedAt: '2026-10-12T22:38:04.000Z', repeats: 10 });
    // The input rows are not touched and a second fold changes nothing.
    expect(FIXTURE.samples).toHaveLength(37);
    expect(foldFrozenFixRuns(folded)).toEqual(folded);
  });

  test('keeps a real stop: the same coordinate repeated, but the next fix is within 500 m', () => {
    // 0.004 degrees of latitude is about 445 m.
    const stopped = stoppedThenMoved(37.514);
    expect(foldFrozenFixRuns(stopped)).toHaveLength(stopped.length);
    expect(foldFrozenFixRuns(stopped).every((sample) => sample.frozenGap === undefined)).toBe(true);
    // 0.0046 degrees is a little over 500 m: the same run now folds.
    expect(foldFrozenFixRuns(stoppedThenMoved(37.5146))).toHaveLength(stopped.length - 3);
  });

  test('does not fold two repeats, a run with the ignition off, or near-identical coordinates', () => {
    const twoRepeats = stoppedThenMoved(37.53).filter((_, index) => index !== 3 && index !== 4);
    expect(foldFrozenFixRuns(twoRepeats)).toHaveLength(twoRepeats.length);
    const ignitionOff = stoppedThenMoved(37.53, { ignitionOn: false });
    expect(foldFrozenFixRuns(ignitionOff)).toHaveLength(ignitionOff.length);
    const jitter = stoppedThenMoved(37.53).map((sample, index) => (
      index === 3 ? { ...sample, latitude: sample.latitude + 0.000001 } : sample
    ));
    expect(foldFrozenFixRuns(jitter)).toHaveLength(jitter.length);
  });
});

describe('speed-0 frozen fixes become one routed GPS gap', () => {
  test('routes 22:18Z->22:23Z and 22:29Z->22:39Z once, and the daily route has no impossible jump', async () => {
    const { input, repository, routeBetween } = repositoryFor(FIXTURE.samples);
    const document = await repository.materializeVehicleDay(input);

    const gaps = document.routedGaps ?? [];
    for (const gap of [FIRST_GAP, SECOND_GAP]) {
      expect(gaps.find((item) => item.fromObservedAt === gap.from && item.toObservedAt === gap.to))
        .toMatchObject({ source: 'OSRM_GAP_ROUTE', type: 'LineString' });
    }
    // Speed 0 is not the tunnel no-fix marker: no tunnel route is asked for or stored.
    expect(document.tunnelBridges).toBeUndefined();
    const firstGapCalls = routeBetween.mock.calls.filter((call) => (
      call[0].coordinate[0] === 126.920272 && call[0].coordinate[1] === 37.336115
    ));
    expect(firstGapCalls).toHaveLength(1);

    const route = buildUvisVehicleDailyRoute(FIXTURE.samples, document);
    expect(route).not.toBeNull();
    expect(route!.bridges.filter((bridge) => bridge.reason === 'IMPLAUSIBLE_JUMP')).toHaveLength(0);
    expect(route!.bridges.some((bridge) => bridge.fromObservedAt === FIRST_GAP.from)).toBe(false);
    expect(route!.bridges.some((bridge) => bridge.fromObservedAt === SECOND_GAP.from)).toBe(false);
    // The routed road is drawn between the first repeated fix and the recovery.
    const anchorAt = (observedAt: string) => route!.anchors.find((anchor) => anchor.observedAt === observedAt)!;
    expect(anchorAt(FIRST_GAP.to).coordinateIndex - anchorAt(FIRST_GAP.from).coordinateIndex).toBeGreaterThan(3);
    expect(anchorAt(SECOND_GAP.to).coordinateIndex - anchorAt(SECOND_GAP.from).coordinateIndex).toBeGreaterThan(3);

    // The consumer requires one anchor per source sample and bridges between adjacent anchors only.
    expect(route!.anchors).toHaveLength(route!.sourceSampleCount);
    expect(route!.sourceSampleCount).toBe(FIXTURE.samples.length - 4 - 9);
    const adjacent = new Set(route!.anchors.slice(1).map((anchor, index) => (
      `${route!.anchors[index]!.observedAt}|${anchor.observedAt}`
    )));
    expect(route!.bridges.every((bridge) => adjacent.has(`${bridge.fromObservedAt}|${bridge.toObservedAt}`))).toBe(true);
  });

  test('reuses the stored routes on the next run and shows an unrouted gap as GPS_GAP, not a jump', async () => {
    const { input, repository, routeBetween } = repositoryFor(FIXTURE.samples);
    await repository.materializeVehicleDay(input);
    const callsAfterFirst = routeBetween.mock.calls.length;
    await repository.materializeVehicleDay(input);
    expect(routeBetween).toHaveBeenCalledTimes(callsAfterFirst);

    const withoutRoutes = buildUvisVehicleDailyRoute(FIXTURE.samples, null);
    const gapBridges = withoutRoutes!.bridges.filter((bridge) => (
      bridge.fromObservedAt === FIRST_GAP.from || bridge.fromObservedAt === SECOND_GAP.from
    ));
    expect(gapBridges).toEqual([
      { fromObservedAt: FIRST_GAP.from, reason: 'GPS_GAP', toObservedAt: FIRST_GAP.to },
      { fromObservedAt: SECOND_GAP.from, reason: 'GPS_GAP', toObservedAt: SECOND_GAP.to },
    ]);
  });

  test('recomputes when the previous document keys the gap from the last repeated fix', async () => {
    const stale = {
      generatedAt: '2026-10-13T00:00:00.000Z',
      retryable: false,
      routedGapMisses: ['2026-10-12T22:38:04.000Z|2026-10-12T22:39:04.000Z'],
      routedGaps: [{
        coordinates: [[126.920272, 37.336115], [126.881535, 37.372052]],
        fromObservedAt: '2026-10-12T22:22:04.000Z',
        source: 'OSRM_GAP_ROUTE',
        toObservedAt: FIRST_GAP.to,
        type: 'LineString',
      }],
      schemaVersion: 'uvis_vehicle_trail.v1',
      segments: [],
      serviceDate: '2026-10-13',
      sourceSampleCount: 37,
      sourceWatermark: 'sha256:old',
      timezone: 'Asia/Seoul',
      vehicleId: 'vehicle-a',
    };
    const { input, repository } = repositoryFor(FIXTURE.samples, stale);
    const document = await repository.materializeVehicleDay(input);
    const keys = (document.routedGaps ?? []).map((gap) => `${gap.fromObservedAt}|${gap.toObservedAt}`);
    expect(keys).toContain(`${FIRST_GAP.from}|${FIRST_GAP.to}`);
    expect(keys).toContain(`${SECOND_GAP.from}|${SECOND_GAP.to}`);
    expect(keys).not.toContain('2026-10-12T22:22:04.000Z|2026-10-12T22:23:04.000Z');
    expect(document.routedGapMisses ?? []).not.toContain('2026-10-12T22:38:04.000Z|2026-10-12T22:39:04.000Z');
  });

  test('does not call a speed-0 run a tunnel', () => {
    const samples = FIXTURE.samples.map((sample) => ({ ...sample, observedAtMs: Date.parse(sample.observedAt) }));
    // Index 15 and 31 are the recovery fixes after each frozen run.
    expect(findTunnelSignature(samples, 15)).toBeNull();
    expect(findTunnelSignature(samples, 31)).toBeNull();
  });
});
