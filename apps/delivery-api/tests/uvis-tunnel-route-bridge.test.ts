import { readFileSync } from 'node:fs';

import { describe, expect, test, vi } from 'vitest';

import { OsrmRouteTrackingRoadMatchProvider } from '../src/modules/route-tracking/route-tracking.road-match.js';
import { findTunnelSignature, gapRouteWaypoints, inferRoutedGapBridge, inferRoutedTunnelBridge, tunnelRouteWaypoints } from '../src/modules/uvis/uvis-tunnel-bridge.js';
import { buildUvisVehicleDailyRoute } from '../src/modules/uvis/uvis-vehicle-daily-route.js';
import { PrismaUvisVehicleTrailMaterializationRepository } from '../src/modules/uvis/uvis-vehicle-trail-materializer.js';
import { foldFrozenFixRuns } from '../src/modules/uvis/uvis-vehicle-trail-evidence.js';

// Production pass of 서울86바3800 westbound through the Jeongneung/Hongjimun tunnels on 2026-10-12 03:43 KST.
// The telematics unit repeats the entry fix with speed 255 until the next fresh fix after the tunnels.
const PASS: Array<[string, number, number, number]> = [
  ['2026-10-11T18:38:47.000Z', 37.613212, 127.061296, 73],
  ['2026-10-11T18:39:47.000Z', 37.606364, 127.0484, 86],
  ['2026-10-11T18:40:47.000Z', 37.602928, 127.03364, 83],
  ['2026-10-11T18:41:47.000Z', 37.601736, 127.022616, 71],
  ['2026-10-11T18:42:47.000Z', 37.605172, 127.010368, 71],
  ['2026-10-11T18:43:47.000Z', 37.60876, 126.998984, 65],
  ['2026-10-11T18:44:47.000Z', 37.60876, 126.998984, 255],
  ['2026-10-11T18:45:47.000Z', 37.60876, 126.998984, 255],
  ['2026-10-11T18:46:47.000Z', 37.60876, 126.998984, 255],
  ['2026-10-11T18:47:47.000Z', 37.596296, 126.953088, 67],
  ['2026-10-11T18:48:47.000Z', 37.590968, 126.940552, 98],
  ['2026-10-11T18:49:47.000Z', 37.579532, 126.935056, 97],
  ['2026-10-11T18:50:47.000Z', 37.570708, 126.920136, 91],
];
const EXIT_INDEX = 9;
// Real Korea OSRM response for tunnel entry -> first fix after the exit, with travel bearings.
const ROUTE = JSON.parse(readFileSync(new URL('./fixtures/uvis-jeongneung-westbound-osrm-route.json', import.meta.url), 'utf8')) as {
  coordinates: Array<[number, number]>;
};

function samples() {
  return PASS.map(([observedAt, latitude, longitude, speedKph]) => ({
    ignitionOn: true,
    latitude,
    longitude,
    observedAt,
    observedAtMs: Date.parse(observedAt),
    speedKph,
    staleAfter: new Date(Date.parse(observedAt) + 120_000).toISOString(),
  }));
}

describe('routed tunnel bridge', () => {
  test('recognizes the westbound pass that no curated corridor covers and accepts a plausible route', () => {
    const signature = findTunnelSignature(samples(), EXIT_INDEX);
    expect(signature).toMatchObject({
      elapsedMs: 240_000,
      entry: { observedAt: '2026-10-11T18:43:47.000Z' },
      exit: { observedAt: '2026-10-11T18:47:47.000Z' },
    });
    expect(inferRoutedTunnelBridge(signature!, ROUTE)).toMatchObject({
      corridorId: 'osrm-route',
      fromObservedAt: '2026-10-11T18:43:47.000Z',
      source: 'OSRM_TUNNEL_ROUTE',
      toObservedAt: '2026-10-11T18:47:47.000Z',
    });
  });

  test('folds the speed-255 run with the shared function and finds the same signature folded or raw', () => {
    const folded = foldFrozenFixRuns(samples());
    expect(folded).toHaveLength(PASS.length - 3);
    expect(folded.find((sample) => sample.frozenGap !== undefined)).toMatchObject({
      frozenGap: { continuous: true, lastObservedAt: '2026-10-11T18:46:47.000Z', noFixRepeats: 3, repeats: 4 },
      observedAt: '2026-10-11T18:43:47.000Z',
    });
    const foldedExitIndex = folded.findIndex((sample) => sample.observedAt === '2026-10-11T18:47:47.000Z');
    expect(findTunnelSignature(folded, foldedExitIndex)).toEqual(findTunnelSignature(samples(), EXIT_INDEX));
  });

  test('asks for the route with the bearings the vehicle was driving', () => {
    const [from, to] = tunnelRouteWaypoints(findTunnelSignature(samples(), EXIT_INDEX)!);
    expect(from.coordinate).toEqual([126.998984, 37.60876]);
    expect(to.coordinate).toEqual([126.940552, 37.590968]);
    expect(Math.round(from.bearingDegrees)).toBeGreaterThan(280);
    expect(Math.round(from.bearingDegrees)).toBeLessThan(300);
    expect(Math.round(to.bearingDegrees)).toBeGreaterThan(230);
    expect(Math.round(to.bearingDegrees)).toBeLessThan(250);
  });

  test('cuts the routed path at the exit fix', () => {
    const bridge = inferRoutedTunnelBridge(findTunnelSignature(samples(), EXIT_INDEX)!, ROUTE)!;
    expect(bridge.coordinates.at(-1)).toEqual([126.953088, 37.596296]);
    expect(bridge.coordinates).not.toContainEqual(ROUTE.coordinates.at(-1));
  });

  test.each([
    // The unbiased production route snapped the exit to a parallel road and detoured to 7.4 km.
    ['a route that never passes the exit fix', { coordinates: [[126.998996, 37.608783], [126.97, 37.62], [126.94, 37.6]] as Array<[number, number]> }],
    ['a route that starts away from the entry fix', { coordinates: [[127.01, 37.61], ...ROUTE.coordinates] }],
    ['a loop that reaches the exit only after a long detour', {
      coordinates: [ROUTE.coordinates[0]!, [127.05, 37.65], [127.05, 37.55], ...ROUTE.coordinates.slice(1)],
    }],
  ])('rejects %s', (_name, route) => {
    expect(inferRoutedTunnelBridge(
      findTunnelSignature(samples(), EXIT_INDEX)!,
      route as { coordinates: Array<[number, number]> },
    )).toBeNull();
  });

  test('rejects a pass that would need more than 35 m/s through the tunnel', () => {
    const signature = { ...findTunnelSignature(samples(), EXIT_INDEX)!, elapsedMs: 100_000 };
    expect(inferRoutedTunnelBridge(signature, ROUTE)).toBeNull();
  });

  test('is computed once at materialization, reused afterwards, and drawn by the daily route', async () => {
    const rows = PASS.map(([observedAt, latitude, longitude, speedKph], index) => ({
      distanceTodayKm: null,
      id: `sample-${index}`,
      ignitionOn: true,
      latitude: latitude.toFixed(7),
      longitude: longitude.toFixed(7),
      observedAt: new Date(observedAt),
      speedKph: speedKph.toFixed(2),
      staleAfter: new Date(Date.parse(observedAt) + 120_000),
    }));
    let stored: unknown = null;
    const prisma = {
      uvisVehicleTelemetrySample: { findMany: vi.fn(() => Promise.resolve(rows)) },
      uvisVehicleTrailMaterialization: {
        findUnique: vi.fn(() => Promise.resolve(stored === null ? null : { document: stored })),
        upsert: vi.fn((input: { create: { document: unknown } }) => { stored = input.create.document; return Promise.resolve(input); }),
      },
    };
    const routeBetween = vi.fn().mockResolvedValue(ROUTE);
    const roadMatchProvider = { match: vi.fn().mockResolvedValue(null), routeBetween };
    const repository = new PrismaUvisVehicleTrailMaterializationRepository(prisma as never);
    const input = { roadMatchProvider, serviceDate: '2026-10-12', shopId: 'shop-a', vehicleId: 'vehicle-a' };

    // Without any matched road every 1km chord is also a routed-gap candidate; count only the tunnel call.
    const tunnelCalls = () => routeBetween.mock.calls
      .filter((call) => (call[0] as { coordinate: [number, number] }).coordinate[0] === 126.998984).length;
    const first = await repository.materializeVehicleDay(input);
    expect(tunnelCalls()).toBe(1);
    expect(routeBetween).toHaveBeenCalledWith(
      expect.objectContaining({ coordinate: [126.998984, 37.60876] }),
      expect.objectContaining({ coordinate: [126.940552, 37.590968] }),
    );
    expect(first.tunnelBridges).toHaveLength(1);

    await repository.materializeVehicleDay(input);
    expect(tunnelCalls()).toBe(1);

    const route = buildUvisVehicleDailyRoute(samples(), first);
    const bridge = route?.bridges.find((item) => item.toObservedAt === '2026-10-11T18:47:47.000Z');
    expect(bridge).toMatchObject({ reason: 'IMPLAUSIBLE_JUMP', inferredTunnel: { source: 'OSRM_TUNNEL_ROUTE' } });
  });
});

// Production pass of 경기88바9580 northbound through the Seobu underground expressway on 2026-10-12 10:02 KST.
// The unit missed one 60-second poll (01:08:25Z) inside the frozen run, which is routine: that day had
// 45 missed polls. staleAfter is recordedAt + 2 polls, so a single missed poll is still a fresh sample.
const SEOBU_PASS: Array<[string, number, number, number]> = [
  ['2026-10-12T00:59:25.000Z', 37.4468, 126.89763, 9],
  ['2026-10-12T01:00:25.000Z', 37.45256, 126.89507, 58],
  ['2026-10-12T01:01:25.000Z', 37.45884, 126.89177, 51],
  ['2026-10-12T01:02:25.000Z', 37.46539, 126.8865, 47],
  ['2026-10-12T01:03:25.000Z', 37.46539, 126.8865, 255],
  ['2026-10-12T01:04:25.000Z', 37.46539, 126.8865, 255],
  ['2026-10-12T01:05:25.000Z', 37.46539, 126.8865, 255],
  ['2026-10-12T01:06:25.000Z', 37.46539, 126.8865, 255],
  ['2026-10-12T01:07:25.000Z', 37.46539, 126.8865, 255],
  ['2026-10-12T01:09:25.000Z', 37.46539, 126.8865, 255],
  ['2026-10-12T01:10:25.000Z', 37.54457, 126.88733, 36],
  ['2026-10-12T01:11:25.000Z', 37.54196, 126.89438, 50],
  ['2026-10-12T01:12:25.000Z', 37.53748, 126.90012, 37],
  ['2026-10-12T01:13:25.000Z', 37.54379, 126.90474, 56],
];
const SEOBU_EXIT_INDEX = 10;

function seobuSamples() {
  return SEOBU_PASS.map(([observedAt, latitude, longitude, speedKph]) => ({
    ignitionOn: true,
    latitude,
    longitude,
    observedAt,
    observedAtMs: Date.parse(observedAt),
    speedKph,
    staleAfter: new Date(Date.parse(observedAt) + 120_000).toISOString(),
  }));
}

describe('routed tunnel bridge with a missed poll inside the frozen run', () => {
  test('still recognizes the Seobu underground pass and accepts a plausible route', () => {
    const signature = findTunnelSignature(seobuSamples(), SEOBU_EXIT_INDEX);
    expect(signature).toMatchObject({
      elapsedMs: 480_000,
      entry: { observedAt: '2026-10-12T01:02:25.000Z' },
      exit: { observedAt: '2026-10-12T01:10:25.000Z' },
    });
    // A straight-line stand-in for the engine's underground route: same length as the direct distance.
    const entry: [number, number] = [126.8865, 37.46539];
    const exit: [number, number] = [126.88733, 37.54457];
    const route = {
      coordinates: Array.from({ length: 12 }, (_, index): [number, number] => [
        entry[0] + (exit[0] - entry[0]) * index / 11,
        entry[1] + (exit[1] - entry[1]) * index / 11,
      ]),
    };
    expect(inferRoutedTunnelBridge(signature!, route)).toMatchObject({
      fromObservedAt: '2026-10-12T01:02:25.000Z',
      source: 'OSRM_TUNNEL_ROUTE',
      toObservedAt: '2026-10-12T01:10:25.000Z',
    });
  });
});

// 경기88바9580 2026-10-12 03:16-03:21Z: six 60-second fixes on the expressway that road matching left as raw chords.
const CHORD_RUN: Array<[string, number, number, number]> = [
  ['2026-10-12T03:15:25.000Z', 37.4595, 127.1290, 52],
  ['2026-10-12T03:16:25.000Z', 37.4530, 127.1340, 75],
  ['2026-10-12T03:17:25.000Z', 37.4430, 127.1400, 76],
  ['2026-10-12T03:18:25.000Z', 37.4320, 127.1450, 85],
];

function chordSamples() {
  return CHORD_RUN.map(([observedAt, latitude, longitude, speedKph]) => ({
    ignitionOn: true,
    latitude,
    longitude,
    observedAt,
    observedAtMs: Date.parse(observedAt),
    speedKph,
    staleAfter: new Date(Date.parse(observedAt) + 120_000).toISOString(),
  }));
}

function straightRoute(from: [number, number], to: [number, number], points = 6, detour = 0) {
  return {
    coordinates: Array.from({ length: points }, (_, index): [number, number] => {
      const ratio = index / (points - 1);
      const bulge = detour * Math.sin(ratio * Math.PI);
      return [from[0] + (to[0] - from[0]) * ratio + bulge, from[1] + (to[1] - from[1]) * ratio];
    }),
  };
}

describe('routed gap bridge', () => {
  test('fills a long unmatched chord with a plausible engine route and keeps the travel bearings', () => {
    const samples = chordSamples();
    const signature = { after: samples[3], before: samples[0], from: samples[1]!, to: samples[2]! };
    const [entry, exit] = gapRouteWaypoints(signature);
    expect(entry.coordinate).toEqual([127.134, 37.453]);
    expect(exit.coordinate).toEqual([127.14, 37.443]);
    expect(entry.bearingDegrees).toBeGreaterThan(140);
    expect(entry.bearingDegrees).toBeLessThan(160);
    const bridge = inferRoutedGapBridge(signature, straightRoute(entry.coordinate, exit.coordinate));
    expect(bridge).toMatchObject({
      fromObservedAt: '2026-10-12T03:16:25.000Z',
      source: 'OSRM_GAP_ROUTE',
      toObservedAt: '2026-10-12T03:17:25.000Z',
    });
    expect(bridge!.coordinates[0]).toEqual([127.134, 37.453]);
    expect(bridge!.coordinates.at(-1)).toEqual([127.14, 37.443]);
    expect(bridge!.coordinates.length).toBeGreaterThan(4);
  });

  test('drops the travel bearings on request so a detoured bearing route can be retried', () => {
    const samples = chordSamples();
    const signature = { after: samples[3], before: samples[0], from: samples[1]!, to: samples[2]! };
    const [entry, exit] = gapRouteWaypoints(signature, { bearings: false });
    expect(entry).toEqual({ coordinate: [127.134, 37.453] });
    expect(exit).toEqual({ coordinate: [127.14, 37.443] });
  });

  test('rejects a detour, a route that starts away from the fix, and a short chord', () => {
    const samples = chordSamples();
    const signature = { after: samples[3], before: samples[0], from: samples[1]!, to: samples[2]! };
    const [entry, exit] = gapRouteWaypoints(signature);
    expect(inferRoutedGapBridge(signature, straightRoute(entry.coordinate, exit.coordinate, 20, 0.02))).toBeNull();
    expect(inferRoutedGapBridge(signature, straightRoute([entry.coordinate[0] + 0.002, entry.coordinate[1]], exit.coordinate))).toBeNull();
    // 0.0008 degrees of latitude is about 90 m: below the 100 m floor, a chord is stop jitter.
    const near = { ...samples[2]!, latitude: samples[1]!.latitude - 0.0008, longitude: samples[1]!.longitude };
    const short = { ...signature, to: near };
    expect(inferRoutedGapBridge(short, straightRoute(entry.coordinate, [near.longitude, near.latitude]))).toBeNull();
  });

  test('routes long raw chords once at materialization, reuses them, and the daily route draws the road', async () => {
    const rows = CHORD_RUN.map(([observedAt, latitude, longitude, speedKph], index) => ({
      distanceTodayKm: null,
      id: `chord-${index}`,
      ignitionOn: true,
      latitude: latitude.toFixed(7),
      longitude: longitude.toFixed(7),
      observedAt: new Date(observedAt),
      speedKph: speedKph.toFixed(2),
      staleAfter: new Date(Date.parse(observedAt) + 120_000),
    }));
    let stored: unknown = null;
    const prisma = {
      uvisVehicleTelemetrySample: { findMany: vi.fn(() => Promise.resolve(rows)) },
      uvisVehicleTrailMaterialization: {
        findUnique: vi.fn(() => Promise.resolve(stored === null ? null : { document: stored })),
        upsert: vi.fn((input: { create: { document: unknown } }) => { stored = input.create.document; return Promise.resolve(input); }),
      },
    };
    const routeBetween = vi.fn((from: { coordinate: [number, number] }, to: { coordinate: [number, number] }) =>
      Promise.resolve({ ...straightRoute(from.coordinate, to.coordinate), distanceMeters: 0 }));
    const roadMatchProvider = { match: vi.fn().mockResolvedValue(null), routeBetween };
    const repository = new PrismaUvisVehicleTrailMaterializationRepository(prisma as never);
    const input = { roadMatchProvider, serviceDate: '2026-10-12', shopId: 'shop-a', vehicleId: 'vehicle-a' };

    const first = await repository.materializeVehicleDay(input);
    expect(routeBetween).toHaveBeenCalledTimes(3);
    expect(routeBetween.mock.calls[0]?.[0]).toMatchObject({ bearingDegrees: expect.any(Number) as number });
    expect(first.routedGaps).toHaveLength(3);
    expect(first.routedGaps?.[0]).toMatchObject({ fromObservedAt: CHORD_RUN[0]![0], source: 'OSRM_GAP_ROUTE', toObservedAt: CHORD_RUN[1]![0] });

    await repository.materializeVehicleDay(input);
    expect(routeBetween).toHaveBeenCalledTimes(3);

    // A bearing route that detours is retried once without bearings and then accepted.
    stored = null;
    routeBetween.mockImplementation((from: { bearingDegrees?: number; coordinate: [number, number] }, to: { coordinate: [number, number] }) =>
      Promise.resolve({ ...straightRoute(from.coordinate, to.coordinate, 20, from.bearingDegrees === undefined ? 0 : 0.02), distanceMeters: 0 }));
    const retried = await repository.materializeVehicleDay(input);
    expect(routeBetween).toHaveBeenCalledTimes(9);
    expect(routeBetween.mock.calls[4]?.[0]).not.toHaveProperty('bearingDegrees');
    expect(retried.routedGaps).toHaveLength(3);

    // A route that detours either way is remembered as a miss and not asked again.
    stored = null;
    routeBetween.mockImplementation((from: { coordinate: [number, number] }, to: { coordinate: [number, number] }) =>
      Promise.resolve({ ...straightRoute(from.coordinate, to.coordinate, 20, 0.02), distanceMeters: 0 }));
    const rejected = await repository.materializeVehicleDay(input);
    expect(routeBetween).toHaveBeenCalledTimes(15);
    expect(rejected.routedGaps).toBeUndefined();
    expect(rejected.routedGapMisses).toHaveLength(3);
    await repository.materializeVehicleDay(input);
    expect(routeBetween).toHaveBeenCalledTimes(15);
    // No route at all is a miss too; the finalizing run asks once more.
    routeBetween.mockResolvedValue(null as never);
    stored = null;
    await repository.materializeVehicleDay(input);
    await repository.materializeVehicleDay(input);
    expect(routeBetween).toHaveBeenCalledTimes(18);
    await repository.materializeVehicleDay({ ...input, finalizing: true });
    expect(routeBetween).toHaveBeenCalledTimes(21);

    const route = buildUvisVehicleDailyRoute(chordSamples(), first);
    expect(route?.bridges).toEqual([]);
    expect(route?.coordinates.length).toBeGreaterThan(CHORD_RUN.length * 3);
    expect(route?.anchors.map((anchor) => anchor.observedAt)).toEqual(CHORD_RUN.map(([observedAt]) => observedAt));
  });
});

describe('OSRM routeBetween', () => {
  test('sends both travel bearings and returns the route geometry', async () => {
    const urls: string[] = [];
    const provider = new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { korea: 'http://osrm-korea:5000' },
      fetch: (url) => {
        urls.push(url);
        return Promise.resolve(new Response(JSON.stringify({
          code: 'Ok',
          routes: [{ distance: 5952, geometry: { coordinates: ROUTE.coordinates, type: 'LineString' } }],
        }), { status: 200 }));
      },
    });

    const line = await provider.routeBetween(
      { bearingDegrees: 291.4, coordinate: [126.998984, 37.60876] },
      { bearingDegrees: -119, coordinate: [126.940552, 37.590968] },
    );

    expect(line).toEqual({ coordinates: ROUTE.coordinates, distanceMeters: 5952 });
    const query = new URL(urls[0]!).searchParams;
    expect(urls[0]).toContain('/route/v1/driving/126.998984,37.60876;126.940552,37.590968?');
    expect(query.get('bearings')).toBe('291,60;241,60');
    expect(query.get('radiuses')).toBe('60;60');
  });

  test('returns null when the engine fails', async () => {
    const provider = new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { korea: 'http://osrm-korea:5000' },
      fetch: () => Promise.resolve(new Response('{}', { status: 503 })),
    });
    await expect(provider.routeBetween(
      { bearingDegrees: 0, coordinate: [126.998984, 37.60876] },
      { bearingDegrees: 0, coordinate: [126.940552, 37.590968] },
    )).resolves.toBeNull();
  });
});
