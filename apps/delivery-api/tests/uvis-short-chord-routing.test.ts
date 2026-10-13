import { readFileSync } from 'node:fs';

import { describe, expect, test, vi } from 'vitest';

import { ROUTED_GAP_MIN_METERS } from '../src/modules/uvis/uvis-tunnel-bridge.js';
import { buildUvisVehicleDailyRoute } from '../src/modules/uvis/uvis-vehicle-daily-route.js';
import { PrismaUvisVehicleTrailMaterializationRepository } from '../src/modules/uvis/uvis-vehicle-trail-materializer.js';

type FixtureSample = {
  ignitionOn: boolean;
  latitude: number;
  longitude: number;
  observedAt: string;
  speedKph: number;
  staleAfter: string;
};

// 서울86바3800, 2026-10-13 12:30-13:14 KST: a zigzag that loses its OSRM anchors (362 m, 336 m chords), a
// stop-and-go crawl on 도산대로 that never opens a session (75 m / 110 m hops between stops), and the stops
// themselves, whose fix wanders 4-15 m each poll.
const FIXTURE = JSON.parse(
  readFileSync(new URL('./fixtures/uvis-seoul86ba3800-urban-creep-20261013.json', import.meta.url), 'utf8'),
) as { samples: FixtureSample[] };
const at = (hhmm: string) => `2026-10-13T${hhmm}:03.000Z`;
const ZIGZAG = [[at('03:42'), at('03:43')], [at('03:44'), at('03:45')]] as const;
const CRAWL = [at('03:57'), at('03:58')] as const;
const LONG = [at('03:36'), at('03:37')] as const; // 515 m: the long-chord rule, unchanged

type Waypoint = { bearingDegrees?: number; coordinate: [number, number] };
type RouteBetween = (from: Waypoint, to: Waypoint) => Promise<ReturnType<typeof route>>;

function route(from: [number, number], to: [number, number], detour = 0, startOffset = 0) {
  const points = 8;
  return {
    coordinates: Array.from({ length: points }, (_, index): [number, number] => {
      const ratio = index / (points - 1);
      return [from[0] + (to[0] - from[0]) * ratio + detour * Math.sin(ratio * Math.PI) + (index === 0 ? startOffset : 0),
        from[1] + (to[1] - from[1]) * ratio];
    }),
    distanceMeters: 0,
  };
}

function repositoryFor(routeBetween: RouteBetween) {
  const rows = FIXTURE.samples.map((sample, index) => ({
    distanceTodayKm: null,
    id: `sample-${index}`,
    ignitionOn: sample.ignitionOn,
    latitude: sample.latitude.toFixed(7),
    longitude: sample.longitude.toFixed(7),
    observedAt: new Date(sample.observedAt),
    speedKph: sample.speedKph.toFixed(2),
    staleAfter: new Date(sample.staleAfter),
  }));
  let stored: unknown = null;
  const prisma = {
    uvisVehicleTelemetrySample: { findMany: vi.fn(() => Promise.resolve(rows)) },
    uvisVehicleTrailMaterialization: {
      findUnique: vi.fn(() => Promise.resolve(stored === null ? null : { document: stored })),
      upsert: vi.fn((input: { create: { document: unknown } }) => { stored = input.create.document; return Promise.resolve(input); }),
    },
  };
  const roadMatchProvider = { match: vi.fn().mockResolvedValue(null), routeBetween };
  return {
    input: { roadMatchProvider, serviceDate: '2026-10-13', shopId: 'shop-a', vehicleId: 'vehicle-a' },
    repository: new PrismaUvisVehicleTrailMaterializationRepository(prisma as never),
  };
}

const straight = () => vi.fn<RouteBetween>((from, to) => Promise.resolve(route(from.coordinate, to.coordinate)));
const key = (gap: { fromObservedAt: string; toObservedAt: string }) => `${gap.fromObservedAt}|${gap.toObservedAt}`;

describe('short raw chords are routed', () => {
  test('the floor is 100 m', () => {
    expect(ROUTED_GAP_MIN_METERS).toBe(100);
  });

  test('routes the zigzag and crawl chords, draws the road, and keeps no bridge for them', async () => {
    const { input, repository } = repositoryFor(straight());
    const document = await repository.materializeVehicleDay(input);
    const keys = (document.routedGaps ?? []).map(key);
    for (const [from, to] of [...ZIGZAG, CRAWL, LONG]) expect(keys).toContain(`${from}|${to}`);
    expect(document.routedGapMisses).toBeUndefined();

    const dailyRoute = buildUvisVehicleDailyRoute(FIXTURE.samples, document)!;
    for (const [from] of [...ZIGZAG, CRAWL]) {
      expect(dailyRoute.bridges.find((bridge) => bridge.fromObservedAt === from)).toBeUndefined();
    }
    const anchor = (observedAt: string) => dailyRoute.anchors.find((item) => item.observedAt === observedAt)!;
    expect(anchor(CRAWL[1]).coordinateIndex - anchor(CRAWL[0]).coordinateIndex).toBeGreaterThan(3);
    expect(dailyRoute.anchors).toHaveLength(dailyRoute.sourceSampleCount);
  });

  test('a detour over 1.3x + 50 m is refused under 500 m while the long-chord rule still accepts 1.45x', async () => {
    // 0.003 degrees of longitude bulges the midpoint by about 265 m: near 2x on a 350 m chord, 1.45x on 515 m.
    const detouring = vi.fn<RouteBetween>((from, to) => Promise.resolve(route(from.coordinate, to.coordinate, 0.003)));
    const { input, repository } = repositoryFor(detouring);
    const document = await repository.materializeVehicleDay(input);
    const keys = (document.routedGaps ?? []).map(key);
    for (const [from, to] of [...ZIGZAG, CRAWL]) {
      expect(keys).not.toContain(`${from}|${to}`);
      expect(document.routedGapMisses).toContain(`${from}|${to}`);
    }
    expect(keys).toContain(`${LONG[0]}|${LONG[1]}`);

    // A refused chord stays the raw straight line with its NO_MATCH bridge; nothing disappears.
    const dailyRoute = buildUvisVehicleDailyRoute(FIXTURE.samples, document)!;
    const anchor = (observedAt: string) => dailyRoute.anchors.find((item) => item.observedAt === observedAt)!;
    for (const [from, to] of ZIGZAG) {
      expect(dailyRoute.bridges).toContainEqual({ fromObservedAt: from, reason: 'NO_MATCH', toObservedAt: to });
      expect(anchor(to).coordinateIndex - anchor(from).coordinateIndex).toBe(1);
    }
  });

  test('a routed chord starts and ends on the road, not on the raw fixes', async () => {
    // The engine's first point sits 0.0002 degrees (about 18 m) east of the raw fix.
    const offset = vi.fn<RouteBetween>((from, to) => Promise.resolve(route(from.coordinate, to.coordinate, 0, 0.0002)));
    const { input, repository } = repositoryFor(offset);
    const document = await repository.materializeVehicleDay(input);
    const gap = document.routedGaps!.find((item) => item.fromObservedAt === ZIGZAG[0][0])!;
    // The chord was asked from the drawn start (03:42 is pinned to the 03:38 stop); the stored path
    // begins at the engine's first road point, offset from it, not at a raw fix.
    const asked = offset.mock.calls.find((call) => call[0].coordinate[1] === gap.coordinates[0]![1])!;
    expect(gap.coordinates[0]![0]).toBeCloseTo(asked[0].coordinate[0] + 0.0002, 6);

    const dailyRoute = buildUvisVehicleDailyRoute(FIXTURE.samples, document)!;
    const exit = dailyRoute.anchors.find((item) => item.observedAt === ZIGZAG[0][1])!;
    expect(dailyRoute.coordinates[exit.coordinateIndex]).toEqual(gap.coordinates.at(-1));
  });
});

describe('a stop is drawn as one point', () => {
  test('fixes that wander while stopped share the first drawn coordinate and report no bridge', () => {
    const dailyRoute = buildUvisVehicleDailyRoute(FIXTURE.samples, null)!;
    const anchor = (hhmm: string) => dailyRoute.anchors.find((item) => item.observedAt === at(hhmm))!;
    // 03:46 arrives at 2 km/h, so it is its own point; 03:47-03:51 are at rest within 30 m of it.
    for (const hhmm of ['03:47', '03:48', '03:49', '03:50', '03:51']) {
      expect(anchor(hhmm).coordinateIndex).toBe(anchor('03:46').coordinateIndex);
      expect(dailyRoute.bridges.find((bridge) => bridge.toObservedAt === at(hhmm))).toBeUndefined();
    }
    // 03:52 moves off at 10 km/h and gets its own point again.
    expect(anchor('03:52').coordinateIndex).toBeGreaterThan(anchor('03:51').coordinateIndex);
    expect(dailyRoute.anchors).toHaveLength(dailyRoute.sourceSampleCount);
    expect(dailyRoute.anchors.every((item, index, all) => index === 0 || item.coordinateIndex >= all[index - 1]!.coordinateIndex)).toBe(true);
  });

  test('a stale gap inside a stop is still a GPS_GAP bridge', () => {
    const samples = FIXTURE.samples.map((sample) => (
      sample.observedAt === at('03:48') ? { ...sample, staleAfter: sample.observedAt } : sample
    ));
    const dailyRoute = buildUvisVehicleDailyRoute(samples, null)!;
    expect(dailyRoute.bridges).toContainEqual({ fromObservedAt: at('03:48'), reason: 'GPS_GAP', toObservedAt: at('03:49') });
  });
});
