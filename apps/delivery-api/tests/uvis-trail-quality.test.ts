import { readFileSync } from 'node:fs';

import { describe, expect, test, vi } from 'vitest';

import { summarizeUvisTrailQuality } from '../src/modules/uvis/uvis-trail-quality.js';
import { PrismaUvisVehicleTrailMaterializationRepository } from '../src/modules/uvis/uvis-vehicle-trail-materializer.js';

type FixtureSample = {
  ignitionOn: boolean;
  latitude: number;
  longitude: number;
  observedAt: string;
  speedKph: number;
  staleAfter: string;
};

function fixture(name: string): FixtureSample[] {
  return (JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as { samples: FixtureSample[] }).samples;
}

const FROZEN = fixture('uvis-gyeonggi83sa7311-frozen-speed0-20261013.json');
const CREEP = fixture('uvis-seoul86ba3800-urban-creep-20261013.json');

// Regression baseline on raw production samples with no materialized document (no road match, no routing).
// When a trail fix changes what stays broken, update these snapshots on purpose and say why in the PR.
describe('summarizeUvisTrailQuality', () => {
  test('counts the frozen-fix jumps of 경기83사7311 as unresolved long chords without a document', () => {
    expect(summarizeUvisTrailQuality(FROZEN, null)).toMatchInlineSnapshot(`
      {
        "bridgesByReason": {
          "GPS_GAP": 2,
          "NO_MATCH": 17,
        },
        "routedGapMisses": 0,
        "routedGaps": 0,
        "tunnels": 0,
        "unresolvedByDistance": {
          "atLeast500": 9,
          "from200To500": 4,
          "from50To200": 6,
          "under50": 0,
        },
        "unresolvedMaxMeters": 5262,
        "unresolvedTotalMeters": 17177,
      }
    `);
  });

  test('counts the urban crawl chords of 서울86바3800 by distance band', () => {
    expect(summarizeUvisTrailQuality(CREEP, null)).toMatchInlineSnapshot(`
      {
        "bridgesByReason": {
          "NO_MATCH": 17,
        },
        "routedGapMisses": 0,
        "routedGaps": 0,
        "tunnels": 0,
        "unresolvedByDistance": {
          "atLeast500": 2,
          "from200To500": 4,
          "from50To200": 9,
          "under50": 2,
        },
        "unresolvedMaxMeters": 542,
        "unresolvedTotalMeters": 3108,
      }
    `);
  });

  test('takes a routed gap out of the unresolved chords', () => {
    // The frozen run folds to its first fix, so the gap runs 22:18:04 -> 22:23:04 (the 5,262 m jump).
    const [from, to] = [FROZEN[10]!, FROZEN[15]!];
    const document = {
      routedGapMisses: ['a|b'],
      routedGaps: [{
        coordinates: [[from.longitude, from.latitude], [to.longitude, to.latitude]] as Array<[number, number]>,
        fromObservedAt: from.observedAt,
        source: 'OSRM_GAP_ROUTE' as const,
        toObservedAt: to.observedAt,
        type: 'LineString' as const,
      }],
      schemaVersion: 1,
      segments: [],
    } as unknown as Parameters<typeof summarizeUvisTrailQuality>[1];
    const without = summarizeUvisTrailQuality(FROZEN, null);
    const withRoute = summarizeUvisTrailQuality(FROZEN, document);
    expect(withRoute.routedGaps).toBe(1);
    expect(withRoute.routedGapMisses).toBe(1);
    expect(withRoute.unresolvedByDistance.atLeast500).toBe(without.unresolvedByDistance.atLeast500 - 1);
    expect(withRoute.unresolvedTotalMeters).toBe(without.unresolvedTotalMeters - 5262);
    expect(withRoute.bridgesByReason.GPS_GAP).toBe(1);
  });
});

describe('UVIS trail quality log', () => {
  test('writes one line on the finalizing run only', async () => {
    const rows = CREEP.map((sample, index) => ({
      distanceTodayKm: null,
      id: `creep-${index}`,
      ignitionOn: sample.ignitionOn,
      latitude: sample.latitude.toFixed(7),
      longitude: sample.longitude.toFixed(7),
      observedAt: new Date(sample.observedAt),
      speedKph: sample.speedKph.toFixed(2),
      staleAfter: new Date(sample.staleAfter),
    }));
    const prisma = {
      uvisVehicleTelemetrySample: { findMany: vi.fn(() => Promise.resolve(rows)) },
      uvisVehicleTrailMaterialization: {
        findUnique: vi.fn(() => Promise.resolve(null)),
        upsert: vi.fn((input: unknown) => Promise.resolve(input)),
      },
    };
    const info = vi.fn();
    const repository = new PrismaUvisVehicleTrailMaterializationRepository(prisma as never, { info });
    const input = { serviceDate: '2026-10-13', shopId: 'shop-a', vehicleId: 'vehicle-a' };

    await repository.materializeVehicleDay(input);
    expect(info).not.toHaveBeenCalled();

    await repository.materializeVehicleDay({ ...input, finalizing: true });
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(expect.objectContaining({
      bridgesByReason: expect.any(Object) as unknown,
      serviceDate: '2026-10-13',
      unresolvedByDistance: expect.any(Object) as unknown,
      vehicleId: 'vehicle-a',
    }), 'UVIS trail quality');
  });
});
