import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test, vi } from 'vitest';
import { Prisma } from '@prisma/client';

import {
  buildRouteTrackingGeometryDocument,
  type RouteTrackingGeometryPositionInput,
} from '../src/modules/route-tracking/route-tracking.geometry.js';
import type { RouteTrackingRoadMatchClassifyingProvider } from '../src/modules/route-tracking/route-tracking.road-match.js';
import {
  assertAppendOnlySourcePrefix,
  assertCurrentDerivedPreservationState,
  assertUnmeasuredAccuracyInferenceGain,
  assertCurrentDerivedRestoreState,
  buildHistoricalRebuildJobSettlement,
  buildPreservedRouteTrackingRoadMatchWrite,
  buildRestoredRoadMatchJobSettlement,
  digestRouteTrackingSource,
  executeRouteTrackingQualityRebuild,
  lockRoutePlanThenTrackingAdvisory,
  parseRebuildRouteTrackingQualityArgs,
  reconcileRestoredRoadMatchJob,
  restoredRoadMatchCacheIsUsable,
  routeTrackingDerivedMatches,
  routeTrackingDerivedStateHash,
  settleHistoricalRebuildJob,
  type RouteTrackingQualityRebuildStore,
} from '../src/scripts/rebuild-route-tracking-quality.js';

const scope = {
  appId: 'clever-route-kfood',
  routePlanId: '00630d18-a4a2-4cc1-8b3b-50a66fc6e2c1',
  shopDomain: 'example.myshopify.com',
};

describe('route tracking quality rebuild script', () => {
  test('passes the complete original GPS sequence to the historical road matcher', async () => {
    const store = new InMemoryStore();
    const matchWithStatus = vi.fn((document: Parameters<RouteTrackingRoadMatchClassifyingProvider['matchWithStatus']>[0]) =>
      Promise.resolve({ path: matchedPath(document), retryable: false }));
    await executeRouteTrackingQualityRebuild({
      args: parseRebuildRouteTrackingQualityArgs([
        '--app-id', scope.appId,
        '--shop-domain', scope.shopDomain,
        '--route-plan-id', scope.routePlanId,
      ]),
      roadMatchProvider: { ...roadMatchProvider, matchWithStatus },
      store,
    });

    expect(matchWithStatus).toHaveBeenCalledWith(expect.anything(), positions());
  });

  test('requires exact tenant identity and defaults to mutation-free dry-run', async () => {
    const store = new InMemoryStore();
    const args = parseRebuildRouteTrackingQualityArgs([
      '--app-id', scope.appId,
      '--shop-domain', scope.shopDomain,
      '--route-plan-id', scope.routePlanId,
    ]);
    const result = await executeRouteTrackingQualityRebuild({ args, roadMatchProvider, store });

    expect(result).toMatchObject({ mode: 'dry-run', mutationCount: 0, ...scope });
    expect(result.eventWindow).toEqual({
      anchorSource: 'PLAN_DATE',
      endExclusive: '2026-09-19T04:00:00.000Z',
      serviceDate: '2026-09-17',
      startInclusive: '2026-09-17T04:00:00.000Z',
      timezone: 'America/Toronto',
    });
    expect(result.after).toMatchObject({ inferredLineCount: 1 });
    expect(store.derivedMutationCount).toBe(0);
    expect(store.rawEventMutationCount).toBe(0);
    expect(store.routeStateMutationCount).toBe(0);

    const wrongTenant = new InMemoryStore({ identity: { ...identity(), shopDomain: 'other.myshopify.com' } });
    await expect(executeRouteTrackingQualityRebuild({ args, roadMatchProvider, store: wrongTenant }))
      .rejects.toThrow('Route identity does not match');
  });

  test('refuses apply when the reviewed plan hash does not match', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tracking-rebuild-'));
    const backupFile = join(directory, 'backup.json');
    const store = new InMemoryStore();
    const dryRunArgs = parseRebuildRouteTrackingQualityArgs([
      '--app-id', scope.appId,
      '--shop-domain', scope.shopDomain,
      '--route-plan-id', scope.routePlanId,
      '--backup-file', backupFile,
    ]);
    const dryRun = await executeRouteTrackingQualityRebuild({ args: dryRunArgs, roadMatchProvider, store });
    const backup = dryRun.backup as { sha256: string };
    const applyArgs = parseRebuildRouteTrackingQualityArgs([
      '--app-id', scope.appId,
      '--shop-domain', scope.shopDomain,
      '--route-plan-id', scope.routePlanId,
      '--backup-file', backupFile,
      '--backup-sha256', backup.sha256,
      '--plan-hash', 'f'.repeat(64),
      '--apply',
    ]);

    await expect(executeRouteTrackingQualityRebuild({ args: applyArgs, roadMatchProvider, store }))
      .rejects.toThrow('Reviewed plan hash does not match');
    expect(store.derivedMutationCount).toBe(0);
  });

  test('binds the explicit unmeasured-accuracy policy to the reviewed backup and apply', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tracking-rebuild-'));
    const backupFile = join(directory, 'backup.json');
    const store = new InMemoryStore();
    const baseArgs = [
      '--app-id', scope.appId,
      '--shop-domain', scope.shopDomain,
      '--route-plan-id', scope.routePlanId,
      '--backup-file', backupFile,
    ];
    const dryRun = await executeRouteTrackingQualityRebuild({
      args: parseRebuildRouteTrackingQualityArgs([...baseArgs, '--allow-unmeasured-accuracy-inference']),
      roadMatchProvider,
      store,
    });
    const backup = dryRun.backup as { sha256: string };
    expect(dryRun.allowUnmeasuredAccuracyInference).toBe(true);
    const reviewedArgs = [
      ...baseArgs,
      '--backup-sha256', backup.sha256,
      '--plan-hash', String(dryRun.planHash),
      '--apply',
    ];

    await expect(executeRouteTrackingQualityRebuild({
      args: parseRebuildRouteTrackingQualityArgs(reviewedArgs),
      roadMatchProvider,
      store,
    })).rejects.toThrow('inference policy does not match');
    expect(store.derivedMutationCount).toBe(0);

    const applied = await executeRouteTrackingQualityRebuild({
      args: parseRebuildRouteTrackingQualityArgs([...reviewedArgs, '--allow-unmeasured-accuracy-inference']),
      roadMatchProvider,
      store,
    });
    expect(applied).toMatchObject({ mode: 'apply', mutationCount: 1, allowUnmeasuredAccuracyInference: true });
  });

  test('rejects unmeasured-accuracy pilots that would replace an existing road line or add no inferred line', async () => {
    const args = parseRebuildRouteTrackingQualityArgs([
      '--app-id', scope.appId,
      '--shop-domain', scope.shopDomain,
      '--route-plan-id', scope.routePlanId,
      '--backup-file', join(await mkdtemp(join(tmpdir(), 'tracking-rebuild-')), 'backup.json'),
      '--allow-unmeasured-accuracy-inference',
    ]);
    const accepted = new InMemoryStore({ currentDerived: {
      roadMatchedGeometry: { coordinates: [[[-79.4, 43.6], [-79.38, 43.65]]], type: 'MultiLineString' },
      roadMatchedPointCount: 2,
    } });
    await expect(executeRouteTrackingQualityRebuild({ args, roadMatchProvider, store: accepted }))
      .rejects.toThrow('empty road cache');

    const existingInference = new InMemoryStore({ currentDerived: {
      roadMatchedGeometry: {
        coordinates: [],
        inferredGeometry: { coordinates: [[[-79.4, 43.6], [-79.38, 43.65]]], type: 'MultiLineString' },
        type: 'MultiLineString',
      },
      roadMatchedPointCount: 0,
    } });
    await expect(executeRouteTrackingQualityRebuild({ args, roadMatchProvider, store: existingInference }))
      .rejects.toThrow('empty road cache');

    const noGainProvider: RouteTrackingRoadMatchClassifyingProvider = {
      ...roadMatchProvider,
      matchWithStatus: (document) => Promise.resolve({
        path: { ...matchedPath(document), inferredGeometry: null, inferredRanges: [] },
        retryable: false,
      }),
    };
    await expect(executeRouteTrackingQualityRebuild({ args, roadMatchProvider: noGainProvider, store: new InMemoryStore() }))
      .rejects.toThrow('new inferred road line');
    const uncertainOnly = new InMemoryStore({ currentDerived: {
      roadMatchedGeometry: { coordinates: [], type: 'MultiLineString' },
      roadMatchedPointCount: 4,
      roadMatchedUncertainGeometry: { coordinates: [[[-79.4, 43.6], [-79.38, 43.65]]], type: 'MultiLineString' },
    } });
    const reviewed = await executeRouteTrackingQualityRebuild({ args, roadMatchProvider, store: uncertainOnly });
    expect(reviewed).toMatchObject({ mode: 'dry-run', after: { inferredLineCount: 1 } });
    expect(accepted.derivedMutationCount).toBe(0);
    expect(existingInference.derivedMutationCount).toBe(0);
  });

  test('rechecks the unmeasured-accuracy gain against transaction-time derived state', () => {
    const proposed = { roadMatchedGeometry: {
      coordinates: [],
      inferredGeometry: { coordinates: [[[-79.4, 43.6], [-79.38, 43.65]]], type: 'MultiLineString' },
      type: 'MultiLineString',
    }, roadMatchedPointCount: 0 };
    expect(() => assertUnmeasuredAccuracyInferenceGain(null, proposed)).not.toThrow();
    expect(() => assertUnmeasuredAccuracyInferenceGain({
      roadMatchedGeometry: { coordinates: [], type: 'MultiLineString' },
      roadMatchedPointCount: 4,
      roadMatchedUncertainGeometry: { coordinates: [[[-79.4, 43.6], [-79.38, 43.65]]], type: 'MultiLineString' },
    }, proposed)).not.toThrow();
    expect(() => assertUnmeasuredAccuracyInferenceGain({
      roadMatchedGeometry: { coordinates: [[[-79.4, 43.6], [-79.38, 43.65]]], type: 'MultiLineString' },
      roadMatchedPointCount: 2,
    }, proposed)).toThrow('empty road cache');
  });

  test('requires a private backup for unmeasured-accuracy inference', () => {
    expect(() => parseRebuildRouteTrackingQualityArgs([
      '--app-id', scope.appId,
      '--shop-domain', scope.shopDomain,
      '--route-plan-id', scope.routePlanId,
      '--allow-unmeasured-accuracy-inference',
    ])).toThrow('requires a private --backup-file');
  });

  test('requires a private backup and a distinct policy for preservation mode', () => {
    expect(() => parseRebuildRouteTrackingQualityArgs([
      '--app-id', scope.appId,
      '--shop-domain', scope.shopDomain,
      '--route-plan-id', scope.routePlanId,
      '--preserve-existing-road-cache',
    ])).toThrow('requires a private --backup-file');
    expect(() => parseRebuildRouteTrackingQualityArgs([
      '--app-id', scope.appId,
      '--shop-domain', scope.shopDomain,
      '--route-plan-id', scope.routePlanId,
      '--backup-file', '/tmp/private-backup.json',
      '--preserve-existing-road-cache',
      '--allow-unmeasured-accuracy-inference',
    ])).toThrow('cannot be combined');
  });

  test('preserves whole trusted lines and adds only non-overlapping Level 0/1 source edges', () => {
    const document = preservationDocument();
    const source = preservationSource();
    expect(document.samples.length).toBeLessThan(source.length);
    const current = preservationCache({
      inferred: [roadLine(3, 4, 1, [[-79.37, 43.63], [-79.36, 43.64]])],
      matched: [roadLine(0, 1, 0, [[-79.4, 43.6], [-79.39, 43.61]])],
    }, document);
    const proposed = preservationWrite({
      inferred: [roadLine(4, 5, 1, [[-79.36, 43.64], [-79.35, 43.65]])],
      matcherCountedInferred: 0,
      matched: [
        roadLine(0, 1, 0, [[-79.4, 43.6], [-79.39, 43.61]]),
        roadLine(1, 2, 0, [[-79.39, 43.61], [-79.38, 43.62]]),
      ],
      unmatched: [sourceDiagnostic(2, 3, 'LOW_ACCURACY')],
      uncertain: [roadLine(2, 3, 2, [[-79.38, 43.62], [-79.37, 43.63]])],
    }, document);

    const merged = buildPreservedRouteTrackingRoadMatchWrite(current, proposed as never, document, source);
    const matched = merged.roadMatchedGeometry as { coordinates: unknown[]; sourceRanges: Array<{ startSourceIndex: number; endSourceIndex: number }>; inferredGeometry: { coordinates: unknown[]; sourceRanges: unknown[] }; unmatchedRanges?: Array<{ reason: string; startSourceIndex: number; endSourceIndex: number }> };
    const uncertain = merged.roadMatchedUncertainGeometry as { coordinates: unknown[] };

    expect(matched.coordinates).toEqual([
      [[-79.4, 43.6], [-79.39, 43.61]],
      [[-79.39, 43.61], [-79.38, 43.62]],
    ]);
    expect(matched.sourceRanges.map(({ startSourceIndex, endSourceIndex }) => [startSourceIndex, endSourceIndex]))
      .toEqual([[0, 1], [1, 2]]);
    expect(matched.inferredGeometry.coordinates).toEqual([
      [[-79.37, 43.63], [-79.36, 43.64]],
      [[-79.36, 43.64], [-79.35, 43.65]],
    ]);
    expect(matched.unmatchedRanges).toEqual([expect.objectContaining({
      endSourceIndex: 3,
      reason: 'LOW_ACCURACY',
      startSourceIndex: 2,
    })]);
    expect(uncertain.coordinates).toEqual([
      [[-79.38, 43.62], [-79.37, 43.63]],
    ]);
    expect(merged).toMatchObject({
      // Existing matched + inferred (4), new OSRM Level 0 (2), and replacement
      // uncertain OSRM line (2). The supplemental inferred line is not counted.
      roadMatchedPointCount: 8,
      roadMatchedSourcePointCount: 6,
      roadMatchedSchemaVersion: 'route_tracking_road_match.v5',
    });
  });

  test('keeps matcher-counted inferred lines before nonmonotonic supplemental lines across repeated merges', () => {
    const source = Array.from({ length: 16 }, (_value, index) => ({
      ...position(index),
      latitude: 43.6 + index / 10_000,
      longitude: -79.4 + index / 10_000,
    }));
    const document = buildRouteTrackingGeometryDocument(source);
    const line = (startSourceIndex: number, endSourceIndex: number) => ({
      coordinates: [
        [source[startSourceIndex]!.longitude, source[startSourceIndex]!.latitude],
        [source[endSourceIndex]!.longitude, source[endSourceIndex]!.latitude],
      ] as Array<[number, number]>,
      range: {
        endEventId: source[endSourceIndex]!.eventId,
        endOccurredAt: source[endSourceIndex]!.occurredAt,
        endSourceIndex,
        interpolationLevel: 1 as const,
        startEventId: source[startSourceIndex]!.eventId,
        startOccurredAt: source[startSourceIndex]!.occurredAt,
        startSourceIndex,
      },
    });
    const current = preservationCache({
      inferred: [line(6, 7), line(8, 9), line(2, 3)],
      matcherCountedInferred: 2,
      matched: [roadLine(0, 1, 0)],
    }, document);
    const proposed = preservationWrite({
      inferred: [line(10, 11), line(4, 5)],
      matcherCountedInferred: 1,
    }, document);

    const first = buildPreservedRouteTrackingRoadMatchWrite(current, proposed as never, document, source);
    const firstGeometry = first.roadMatchedGeometry as {
      inferredGeometry: {
        coordinates: unknown[];
        sourceRanges: Array<{ startSourceIndex: number; endSourceIndex: number }>;
      };
    };
    expect(firstGeometry.inferredGeometry.sourceRanges.map((range) => [
      range.startSourceIndex,
      range.endSourceIndex,
    ])).toEqual([[6, 7], [8, 9], [10, 11], [2, 3], [4, 5]]);
    expect(firstGeometry.inferredGeometry.coordinates).toEqual([
      line(6, 7).coordinates,
      line(8, 9).coordinates,
      line(10, 11).coordinates,
      line(2, 3).coordinates,
      line(4, 5).coordinates,
    ]);
    expect(first.roadMatchedPointCount).toBe(8);

    const repeatedCurrent = {
      ...first,
      routePlanId: scope.routePlanId,
      sampleMetadata: document.samples,
      sourcePointCount: source.length,
    };
    const repeatedProposed = preservationWrite({
      inferred: [line(12, 13)],
      matcherCountedInferred: 1,
    }, document);
    const second = buildPreservedRouteTrackingRoadMatchWrite(
      repeatedCurrent,
      repeatedProposed as never,
      document,
      source,
    );
    const secondGeometry = second.roadMatchedGeometry as {
      inferredGeometry: {
        coordinates: unknown[];
        sourceRanges: Array<{ startSourceIndex: number; endSourceIndex: number }>;
      };
    };
    const secondRanges = secondGeometry.inferredGeometry.sourceRanges;
    expect(secondRanges.map((range) => [range.startSourceIndex, range.endSourceIndex]))
      .toEqual([[6, 7], [8, 9], [10, 11], [12, 13], [2, 3], [4, 5]]);
    expect(secondGeometry.inferredGeometry.coordinates).toEqual([
      line(6, 7).coordinates,
      line(8, 9).coordinates,
      line(10, 11).coordinates,
      line(12, 13).coordinates,
      line(2, 3).coordinates,
      line(4, 5).coordinates,
    ]);
    expect(second.roadMatchedPointCount).toBe(10);
    for (let left = 0; left < secondRanges.length; left += 1) {
      for (let right = left + 1; right < secondRanges.length; right += 1) {
        expect(Math.max(secondRanges[left]!.startSourceIndex, secondRanges[right]!.startSourceIndex))
          .toBeGreaterThanOrEqual(Math.min(secondRanges[left]!.endSourceIndex, secondRanges[right]!.endSourceIndex));
      }
    }
  });

  test('rejects nonmonotonic matcher-counted inferred prefixes in existing and proposed caches', () => {
    const document = preservationDocument();
    const source = preservationSource();
    const nonmonotonicCounted = [roadLine(4, 5, 1), roadLine(2, 3, 1)];
    const validProposed = preservationWrite({ matched: [roadLine(3, 4, 0)] }, document);
    const invalidExisting = preservationCache({
      inferred: nonmonotonicCounted,
      matcherCountedInferred: 2,
      matched: [roadLine(0, 1, 0)],
    }, document);
    expect(() => buildPreservedRouteTrackingRoadMatchWrite(
      invalidExisting,
      validProposed as never,
      document,
      source,
    )).toThrow('existing inferred matcher-counted source range endpoints are nonmonotonic');

    const validExisting = preservationCache({ matched: [roadLine(0, 1, 0)] }, document);
    const invalidProposed = preservationWrite({
      inferred: nonmonotonicCounted,
      matcherCountedInferred: 2,
    }, document);
    expect(() => buildPreservedRouteTrackingRoadMatchWrite(
      validExisting,
      invalidProposed as never,
      document,
      source,
    )).toThrow('proposed inferred matcher-counted source range endpoints are nonmonotonic');
  });

  test('rejects nonmonotonic inferred supplement suffixes in existing and proposed caches', () => {
    const document = preservationDocument();
    const source = preservationSource();
    const nonmonotonicSupplements = [roadLine(1, 2, 1), roadLine(4, 5, 1), roadLine(2, 3, 1)];
    const validProposed = preservationWrite({ matched: [roadLine(3, 4, 0)] }, document);
    const invalidExisting = preservationCache({
      inferred: nonmonotonicSupplements,
      matcherCountedInferred: 1,
      matched: [roadLine(0, 1, 0)],
    }, document);
    expect(() => buildPreservedRouteTrackingRoadMatchWrite(
      invalidExisting,
      validProposed as never,
      document,
      source,
    )).toThrow('existing inferred supplemental source range endpoints are nonmonotonic');

    const validExisting = preservationCache({ matched: [roadLine(0, 1, 0)] }, document);
    const invalidProposed = preservationWrite({
      inferred: nonmonotonicSupplements,
      matcherCountedInferred: 1,
    }, document);
    expect(() => buildPreservedRouteTrackingRoadMatchWrite(
      validExisting,
      invalidProposed as never,
      document,
      source,
    )).toThrow('proposed inferred supplemental source range endpoints are nonmonotonic');
  });

  test('still rejects overlapping inferred edges when inferred ranges are not source ordered', () => {
    const document = preservationDocument();
    const source = preservationSource();
    const current = preservationCache({
      inferred: [roadLine(3, 5, 1), roadLine(2, 4, 1)],
      matcherCountedInferred: 1,
      matched: [roadLine(0, 1, 0)],
    }, document);
    const proposed = preservationWrite({ matched: [roadLine(1, 2, 0)] }, document);

    expect(() => buildPreservedRouteTrackingRoadMatchWrite(current, proposed as never, document, source))
      .toThrow('existing trusted source edges overlap');
  });

  test('normalizes existing simplified-cache range indexes from unique raw event identities', () => {
    const document = preservationDocument();
    const source = preservationSource();
    const current = preservationCache({
      inferred: [roadLine(2, 3, 1, [[-79.38, 43.62], [-79.37, 43.63]])],
      matched: [roadLine(1, 2, 0, [[-79.39, 43.61], [-79.38, 43.62]])],
      unmatched: [sourceDiagnostic(3, 4, 'LOW_ACCURACY')],
      uncertain: [roadLine(4, 5, 2, [[-79.36, 43.64], [-79.35, 43.65]])],
    }, document) as Record<string, unknown>;
    const existingMatched = current.roadMatchedGeometry as {
      inferredGeometry: { sourceRanges: Array<Record<string, unknown>> };
      sourceRanges: Array<Record<string, unknown>>;
      unmatchedRanges: Array<Record<string, unknown>>;
    };
    const existingUncertain = current.roadMatchedUncertainGeometry as {
      sourceRanges: Array<Record<string, unknown>>;
    };
    current.sampleMetadata = source.slice(1).map(({ eventId, occurredAt }) => ({ eventId, occurredAt }));
    Object.assign(existingMatched.sourceRanges[0]!, { startSourceIndex: 0, endSourceIndex: 1 });
    Object.assign(existingMatched.inferredGeometry.sourceRanges[0]!, { startSourceIndex: 1, endSourceIndex: 2 });
    Object.assign(existingUncertain.sourceRanges[0]!, { startSourceIndex: 3, endSourceIndex: 4 });
    Object.assign(existingMatched.unmatchedRanges[0]!, { startSourceIndex: 2, endSourceIndex: 3 });
    const proposed = preservationWrite({
      matched: [roadLine(0, 1, 0, [[-79.4, 43.6], [-79.39, 43.61]])],
    }, document);

    const merged = buildPreservedRouteTrackingRoadMatchWrite(current, proposed as never, document, source);
    const matched = merged.roadMatchedGeometry as {
      coordinates: unknown[];
      inferredGeometry: { coordinates: unknown[]; sourceRanges: Array<Record<string, unknown>> };
      sourceRanges: Array<Record<string, unknown>>;
      unmatchedRanges: Array<Record<string, unknown>>;
    };

    expect(matched.coordinates).toEqual([
      [[-79.4, 43.6], [-79.39, 43.61]],
      [[-79.39, 43.61], [-79.38, 43.62]],
    ]);
    expect(matched.sourceRanges).toEqual([
      expect.objectContaining({ startSourceIndex: 0, endSourceIndex: 1 }),
      expect.objectContaining({ startSourceIndex: 1, endSourceIndex: 2 }),
    ]);
    expect(matched.inferredGeometry.coordinates).toEqual([
      [[-79.38, 43.62], [-79.37, 43.63]],
    ]);
    expect(matched.inferredGeometry.sourceRanges).toEqual([
      expect.objectContaining({ startSourceIndex: 2, endSourceIndex: 3 }),
    ]);
    expect(matched.unmatchedRanges).toContainEqual(expect.objectContaining({
      startSourceIndex: 3,
      reason: 'LOW_ACCURACY',
    }));
  });

  test('keeps proposed full-raw source indexes strict', () => {
    const document = preservationDocument();
    const source = preservationSource();
    const current = preservationCache({ matched: [roadLine(4, 5, 0)] }, document);
    const proposed = preservationWrite({ matched: [roadLine(0, 1, 0)] }, document) as Record<string, unknown>;
    const range = (proposed.roadMatchedGeometry as { sourceRanges: Array<Record<string, unknown>> }).sourceRanges[0]!;
    Object.assign(range, { startSourceIndex: 1, endSourceIndex: 2 });

    expect(() => buildPreservedRouteTrackingRoadMatchWrite(current, proposed as never, document, source))
      .toThrow('source identity does not match raw GPS');
  });

  test('rejects an existing remap without raw-index or legacy-sample provenance', () => {
    const document = preservationDocument();
    const source = preservationSource();
    const current = preservationCache({ matched: [roadLine(2, 3, 0)] }, document) as Record<string, unknown>;
    const range = (current.roadMatchedGeometry as { sourceRanges: Array<Record<string, unknown>> }).sourceRanges[0]!;
    Object.assign(range, { startSourceIndex: 0, endSourceIndex: 1 });
    const proposed = preservationWrite({ matched: [roadLine(4, 5, 0)] }, document);

    expect(() => buildPreservedRouteTrackingRoadMatchWrite(current, proposed as never, document, source))
      .toThrow('mix raw and legacy compact provenance');
  });

  test('rejects mixed raw and legacy indexing within one existing range', () => {
    const document = preservationDocument();
    const source = preservationSource();
    const current = preservationCache({ matched: [roadLine(0, 2, 0)] }, document) as Record<string, unknown>;
    const range = (current.roadMatchedGeometry as { sourceRanges: Array<Record<string, unknown>> }).sourceRanges[0]!;
    Object.assign(range, { startSourceIndex: 0, endSourceIndex: 1 });
    current.sampleMetadata = [
      { eventId: source[5]!.eventId, occurredAt: source[5]!.occurredAt },
      { eventId: source[2]!.eventId, occurredAt: source[2]!.occurredAt },
    ];
    const proposed = preservationWrite({ matched: [roadLine(3, 4, 0)] }, document);

    expect(() => buildPreservedRouteTrackingRoadMatchWrite(current, proposed as never, document, source))
      .toThrow('mix raw and legacy compact provenance');
  });

  test('rejects mixed raw and legacy indexing across existing ranges', () => {
    const document = preservationDocument();
    const source = preservationSource();
    const current = preservationCache({
      matched: [roadLine(0, 1, 0), roadLine(3, 4, 0)],
    }, document) as Record<string, unknown>;
    const ranges = (current.roadMatchedGeometry as { sourceRanges: Array<Record<string, unknown>> }).sourceRanges;
    Object.assign(ranges[1]!, { startSourceIndex: 2, endSourceIndex: 3 });
    current.sampleMetadata = [
      { eventId: source[5]!.eventId, occurredAt: source[5]!.occurredAt },
      { eventId: source[5]!.eventId, occurredAt: source[5]!.occurredAt },
      { eventId: source[3]!.eventId, occurredAt: source[3]!.occurredAt },
      { eventId: source[4]!.eventId, occurredAt: source[4]!.occurredAt },
    ];
    const proposed = preservationWrite({ matched: [roadLine(4, 5, 0)] }, document);

    expect(() => buildPreservedRouteTrackingRoadMatchWrite(current, proposed as never, document, source))
      .toThrow('mix raw and legacy compact provenance');
  });

  test('remaps a compact point diagnostic under the cache-wide legacy mode', () => {
    const document = preservationDocument();
    const source = preservationSource();
    const current = preservationCache({
      matched: [roadLine(1, 2, 0)],
      unmatched: [sourceDiagnostic(4, 4, 'LOW_ACCURACY')],
    }, document) as Record<string, unknown>;
    const geometry = current.roadMatchedGeometry as {
      sourceRanges: Array<Record<string, unknown>>;
      unmatchedRanges: Array<Record<string, unknown>>;
    };
    current.sampleMetadata = source.slice(1, 5).map(({ eventId, occurredAt }) => ({ eventId, occurredAt }));
    Object.assign(geometry.sourceRanges[0]!, { startSourceIndex: 0, endSourceIndex: 1 });
    Object.assign(geometry.unmatchedRanges[0]!, { startSourceIndex: 3, endSourceIndex: 3 });
    const proposed = preservationWrite({ matched: [roadLine(2, 3, 0)] }, document);

    const merged = buildPreservedRouteTrackingRoadMatchWrite(current, proposed as never, document, source);
    const matched = merged.roadMatchedGeometry as { unmatchedRanges: Array<Record<string, unknown>> };
    expect(matched.unmatchedRanges).toContainEqual(expect.objectContaining({
      reason: 'LOW_ACCURACY',
      startSourceIndex: 3,
      endSourceIndex: 5,
    }));
  });

  test('keeps proposed point diagnostics on strict full-raw indexes', () => {
    const document = preservationDocument();
    const source = preservationSource();
    const current = preservationCache({ matched: [roadLine(0, 1, 0)] }, document);
    const proposed = preservationWrite({
      matched: [roadLine(1, 2, 0)],
      unmatched: [sourceDiagnostic(4, 4, 'LOW_ACCURACY')],
    }, document) as Record<string, unknown>;
    const unmatched = (proposed.roadMatchedGeometry as { unmatchedRanges: Array<Record<string, unknown>> })
      .unmatchedRanges[0]!;
    Object.assign(unmatched, { startSourceIndex: 3, endSourceIndex: 3 });

    expect(() => buildPreservedRouteTrackingRoadMatchWrite(current, proposed as never, document, source))
      .toThrow('source identity does not match raw GPS');
  });

  test('rejects ambiguous, reversed, and nonmonotonic existing identity remaps', () => {
    const ambiguousSource = preservationSource();
    const ambiguousDocument = buildRouteTrackingGeometryDocument(ambiguousSource);
    ambiguousSource[2] = {
      ...ambiguousSource[2]!,
      eventId: ambiguousSource[1]!.eventId,
      occurredAt: ambiguousSource[1]!.occurredAt,
    };
    const ambiguous = preservationCache({ matched: [roadLine(0, 1, 0)] }, ambiguousDocument);
    const ambiguousProposed = preservationWrite({ matched: [roadLine(3, 4, 0)] }, ambiguousDocument);
    expect(() => buildPreservedRouteTrackingRoadMatchWrite(
      ambiguous, ambiguousProposed as never, ambiguousDocument, ambiguousSource,
    )).toThrow('source identity is ambiguous in raw GPS');

    const document = preservationDocument();
    const source = preservationSource();
    const reversed = preservationCache({ matched: [roadLine(2, 3, 0)] }, document) as Record<string, unknown>;
    const reversedRange = (reversed.roadMatchedGeometry as { sourceRanges: Array<Record<string, unknown>> })
      .sourceRanges[0]!;
    Object.assign(reversedRange, {
      startSourceIndex: 0,
      endSourceIndex: 1,
      startEventId: source[3]!.eventId,
      startOccurredAt: source[3]!.occurredAt,
      endEventId: source[2]!.eventId,
      endOccurredAt: source[2]!.occurredAt,
    });
    reversed.sampleMetadata = [
      { eventId: source[3]!.eventId, occurredAt: source[3]!.occurredAt },
      { eventId: source[2]!.eventId, occurredAt: source[2]!.occurredAt },
    ];
    const proposed = preservationWrite({ matched: [roadLine(4, 5, 0)] }, document);
    expect(() => buildPreservedRouteTrackingRoadMatchWrite(reversed, proposed as never, document, source))
      .toThrow('invalid after identity normalization');

    const nonmonotonic = preservationCache({
      matched: [roadLine(2, 3, 0), roadLine(0, 1, 0)],
    }, document);
    expect(() => buildPreservedRouteTrackingRoadMatchWrite(nonmonotonic, proposed as never, document, source))
      .toThrow('source range endpoints are nonmonotonic');
  });

  test('rejects overlapping trusted edges in the proposed full-raw cache', () => {
    const document = preservationDocument();
    const source = preservationSource();
    const current = preservationCache({ matched: [roadLine(4, 5, 0)] }, document);
    const proposed = preservationWrite({
      matched: [roadLine(0, 2, 0), roadLine(1, 3, 0)],
    }, document);

    expect(() => buildPreservedRouteTrackingRoadMatchWrite(current, proposed as never, document, source))
      .toThrow('proposed trusted source edges overlap');
  });

  test('remaps many consecutive compact uncertain ranges without changing their coordinates or point count', () => {
    const source = Array.from({ length: 118 }, (_value, index) => ({
      ...position(index, new Date(Date.parse('2026-09-17T13:00:00.000Z') + index * 1000).toISOString()),
      latitude: 43.6 + index / 10_000,
      longitude: -79.4 + index / 10_000,
    }));
    const document = buildRouteTrackingGeometryDocument(source);
    const line = (startSourceIndex: number, endSourceIndex: number, interpolationLevel: 0 | 1 | 2) => ({
      coordinates: [
        [source[startSourceIndex]!.longitude, source[startSourceIndex]!.latitude],
        [source[endSourceIndex]!.longitude, source[endSourceIndex]!.latitude],
      ] as Array<[number, number]>,
      range: {
        endEventId: source[endSourceIndex]!.eventId,
        endOccurredAt: source[endSourceIndex]!.occurredAt,
        endSourceIndex,
        interpolationLevel,
        startEventId: source[startSourceIndex]!.eventId,
        startOccurredAt: source[startSourceIndex]!.occurredAt,
        startSourceIndex,
      },
    });
    const existingUncertainLines = Array.from({ length: 57 }, (_value, index) => (
      line(index * 2 + 2, index * 2 + 4, 2)
    ));
    const current = preservationCache({
      matched: [line(0, 2, 0)],
      uncertain: existingUncertainLines,
    }, document) as Record<string, unknown>;
    current.sampleMetadata = Array.from({ length: 59 }, (_value, index) => ({
      eventId: source[index * 2]!.eventId,
      occurredAt: source[index * 2]!.occurredAt,
    }));
    const existingMatchedRanges = (current.roadMatchedGeometry as {
      sourceRanges: Array<Record<string, unknown>>;
    }).sourceRanges;
    const existingUncertain = current.roadMatchedUncertainGeometry as {
      coordinates: unknown[];
      sourceRanges: Array<Record<string, unknown>>;
    };
    Object.assign(existingMatchedRanges[0]!, { startSourceIndex: 0, endSourceIndex: 1 });
    existingUncertain.sourceRanges.forEach((range, index) => {
      Object.assign(range, { startSourceIndex: index + 1, endSourceIndex: index + 2 });
    });
    const proposedUncertainLines = Array.from({ length: 57 }, (_value, index) => (
      line(index * 2 + 2, index * 2 + 4, 2)
    ));
    const proposed = preservationWrite({
      matched: [line(116, 117, 0)],
      uncertain: proposedUncertainLines,
    }, document);

    const merged = buildPreservedRouteTrackingRoadMatchWrite(current, proposed as never, document, source);
    const mergedMatched = merged.roadMatchedGeometry as { coordinates: unknown[] };
    const mergedUncertain = merged.roadMatchedUncertainGeometry as {
      coordinates: unknown[];
      sourceRanges: Array<Record<string, unknown>>;
    };

    expect(mergedMatched.coordinates).toEqual([
      line(0, 2, 0).coordinates,
      line(116, 117, 0).coordinates,
    ]);
    expect(mergedUncertain.coordinates).toEqual(proposedUncertainLines.map((candidate) => candidate.coordinates));
    expect(mergedUncertain.sourceRanges).toHaveLength(57);
    expect(mergedUncertain.sourceRanges[0]).toEqual(expect.objectContaining({
      startSourceIndex: 2,
      endSourceIndex: 4,
    }));
    expect(mergedUncertain.sourceRanges.at(-1)).toEqual(expect.objectContaining({
      startSourceIndex: 114,
      endSourceIndex: 116,
    }));
    expect(merged.roadMatchedPointCount).toBe(118);
  });

  test('fails closed for malformed cache cardinality and raw-source identity mismatch', () => {
    const document = preservationDocument();
    const source = preservationSource();
    const malformed = preservationCache({ matched: [roadLine(0, 1, 0)] }, document) as Record<string, unknown>;
    const malformedGeometry = malformed.roadMatchedGeometry as { sourceRanges: unknown[] };
    malformedGeometry.sourceRanges = [];
    const proposed = preservationWrite({ matched: [roadLine(1, 2, 0)] }, document);
    expect(() => buildPreservedRouteTrackingRoadMatchWrite(malformed, proposed as never, document, source))
      .toThrow('line/range cardinality');

    const wrongIdentity = preservationCache({ matched: [roadLine(0, 1, 0)] }, document) as Record<string, unknown>;
    const range = (wrongIdentity.roadMatchedGeometry as { sourceRanges: Array<Record<string, unknown>> }).sourceRanges[0]!;
    range.endEventId = 'wrong-event';
    expect(() => buildPreservedRouteTrackingRoadMatchWrite(wrongIdentity, proposed as never, document, source))
      .toThrow('source identity');

    const inconsistentDiagnostics = preservationCache({
      matched: [roadLine(0, 1, 0)],
      unmatched: [sourceDiagnostic(2, 2, 'LOW_ACCURACY')],
    }, document) as Record<string, unknown>;
    const uncertain = inconsistentDiagnostics.roadMatchedUncertainGeometry as { unmatchedRanges: unknown[] };
    uncertain.unmatchedRanges = [sourceDiagnostic(2, 2, 'NO_MATCH')];
    expect(() => buildPreservedRouteTrackingRoadMatchWrite(inconsistentDiagnostics, proposed as never, document, source))
      .toThrow('unmatched range copies disagree');
  });

  test('rejects preservation plans with no additive trusted edge', () => {
    const document = preservationDocument();
    const source = preservationSource();
    const current = preservationCache({ matched: [roadLine(0, 3, 0)] }, document);
    const proposed = preservationWrite({
      matched: [roadLine(0, 3, 0)],
    }, document);
    expect(() => buildPreservedRouteTrackingRoadMatchWrite(current, proposed as never, document, source))
      .toThrow('no new non-overlapping Level 0/1 road line');
  });

  test('rejects road caches whose matcher point count splits an inferred line', () => {
    const document = preservationDocument();
    const source = preservationSource();
    const current = preservationCache({
      inferred: [roadLine(3, 4, 1)],
      matched: [roadLine(0, 1, 0)],
    }, document) as Record<string, unknown>;
    current.roadMatchedPointCount = Number(current.roadMatchedPointCount) - 1;
    const proposed = preservationWrite({ matched: [roadLine(1, 2, 0)] }, document);
    expect(() => buildPreservedRouteTrackingRoadMatchWrite(current, proposed as never, document, source))
      .toThrow('matched point count splits an inferred road line');
  });

  test('keeps the proposed last OSRM tracepoint when the latest line is uncertain', () => {
    const document = preservationDocument();
    const source = preservationSource();
    const current = preservationCache({ matched: [roadLine(0, 1, 0)] }, document);
    const proposed = preservationWrite({
      matched: [roadLine(1, 2, 0)],
      uncertain: [roadLine(4, 5, 2)],
    }, document);
    proposed.roadMatchedLastPosition = {
      latitude: 43.6005,
      longitude: -79.3995,
      occurredAt: source[5]!.occurredAt,
    };

    const merged = buildPreservedRouteTrackingRoadMatchWrite(current, proposed as never, document, source);

    expect(merged.roadMatchedLastPosition).toEqual(proposed.roadMatchedLastPosition);
    expect(merged.roadMatchedLastPosition).not.toEqual({
      latitude: roadLine(1, 2, 0).coordinates.at(-1)![1],
      longitude: roadLine(1, 2, 0).coordinates.at(-1)![0],
      occurredAt: source[2]!.occurredAt,
    });
  });

  test('protects preservation apply with the reviewed derived-state CAS hash', () => {
    const reviewed = preservationCache({ matched: [roadLine(0, 1, 0)] }, preservationDocument());
    const hash = routeTrackingDerivedStateHash(reviewed);
    expect(() => assertCurrentDerivedPreservationState(reviewed, hash)).not.toThrow();
    expect(() => assertCurrentDerivedPreservationState({ ...reviewed, roadMatchedWatermark: 'changed' }, hash))
      .toThrow('changed after review');
  });

  test('binds preservation dry-run review to apply and rejects changed derived state', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tracking-rebuild-'));
    const backupFile = join(directory, 'backup.json');
    const current = preservationCache({ matched: [roadLine(0, 1, 0)] }, preservationDocument());
    const store = new InMemoryStore({ currentDerived: current, source: preservationSource() });
    const args = [
      '--app-id', scope.appId,
      '--shop-domain', scope.shopDomain,
      '--route-plan-id', scope.routePlanId,
      '--backup-file', backupFile,
      '--preserve-existing-road-cache',
    ];
    const provider: RouteTrackingRoadMatchClassifyingProvider = {
      match: (document) => Promise.resolve(preservationPath(document)),
      matchWithStatus: (document) => Promise.resolve({ path: preservationPath(document), retryable: false }),
    };
    const dryRun = await executeRouteTrackingQualityRebuild({
      args: parseRebuildRouteTrackingQualityArgs(args),
      roadMatchProvider: provider,
      store,
    });
    const backup = dryRun.backup as { sha256: string };
    const applyArgs = parseRebuildRouteTrackingQualityArgs([
      ...args,
      '--backup-sha256', backup.sha256,
      '--plan-hash', String(dryRun.planHash),
      '--apply',
    ]);

    expect(dryRun).toMatchObject({ mode: 'dry-run', mutationCount: 0, preserveExistingRoadCache: true });
    store.setCurrentDerived({ ...current, roadMatchedWatermark: 'changed-after-review' });
    await expect(executeRouteTrackingQualityRebuild({ args: applyArgs, roadMatchProvider: provider, store }))
      .rejects.toThrow('changed after review');
    expect(store.derivedMutationCount).toBe(0);

    store.setCurrentDerived(current);
    const applied = await executeRouteTrackingQualityRebuild({ args: applyArgs, roadMatchProvider: provider, store });
    expect(applied).toMatchObject({ mode: 'apply', mutationCount: 1, preserveExistingRoadCache: true });
    expect(store.lastRoadMatchWrite?.roadMatchedGeometry).toMatchObject({
      sourceRanges: [expect.objectContaining({ startSourceIndex: 0 }), expect.objectContaining({ startSourceIndex: 1 })],
    });
  });

  test('refuses apply when eligible GPS was appended after dry-run review', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tracking-rebuild-'));
    const backupFile = join(directory, 'backup.json');
    const store = new InMemoryStore();
    const dryRun = await executeRouteTrackingQualityRebuild({
      args: parseRebuildRouteTrackingQualityArgs([
        '--app-id', scope.appId,
        '--shop-domain', scope.shopDomain,
        '--route-plan-id', scope.routePlanId,
        '--backup-file', backupFile,
      ]),
      roadMatchProvider,
      store,
    });
    const backup = dryRun.backup as { sha256: string };
    store.append(position(3));

    await expect(executeRouteTrackingQualityRebuild({
      args: parseRebuildRouteTrackingQualityArgs([
        '--app-id', scope.appId,
        '--shop-domain', scope.shopDomain,
        '--route-plan-id', scope.routePlanId,
        '--backup-file', backupFile,
        '--backup-sha256', backup.sha256,
        '--plan-hash', String(dryRun.planHash),
        '--apply',
      ]),
      roadMatchProvider,
      store,
    })).rejects.toThrow('run a new dry-run');
    expect(store.derivedMutationCount).toBe(0);
  });

  test('refuses apply when the route timezone changes after dry-run review', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tracking-rebuild-'));
    const backupFile = join(directory, 'backup.json');
    const store = new InMemoryStore();
    const dryRun = await executeRouteTrackingQualityRebuild({
      args: parseRebuildRouteTrackingQualityArgs([
        '--app-id', scope.appId,
        '--shop-domain', scope.shopDomain,
        '--route-plan-id', scope.routePlanId,
        '--backup-file', backupFile,
      ]),
      roadMatchProvider,
      store,
    });
    store.setEventWindow({
      anchorSource: 'PLAN_DATE',
      endExclusive: new Date('2026-09-19T00:00:00.000Z'),
      serviceDate: '2026-09-17',
      startInclusive: new Date('2026-09-17T00:00:00.000Z'),
      timezone: 'UTC',
    });
    const backup = dryRun.backup as { sha256: string };

    await expect(executeRouteTrackingQualityRebuild({
      args: parseRebuildRouteTrackingQualityArgs([
        '--app-id', scope.appId,
        '--shop-domain', scope.shopDomain,
        '--route-plan-id', scope.routePlanId,
        '--backup-file', backupFile,
        '--backup-sha256', backup.sha256,
        '--plan-hash', String(dryRun.planHash),
        '--apply',
      ]),
      roadMatchProvider,
      store,
    })).rejects.toThrow('event window or timezone changed');
    expect(store.derivedMutationCount).toBe(0);
  });

  test('refuses rollback that would restore derived GPS outside the current event window', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tracking-rebuild-'));
    const backupFile = join(directory, 'backup.json');
    const store = new InMemoryStore({
      currentDerived: {
        firstOccurredAt: '2026-09-17T13:00:01.000Z',
        lastOccurredAt: '2026-09-20T13:00:01.000Z',
        sampleMetadata: [{ occurredAt: '2026-09-20T13:00:01.000Z' }],
      },
    });
    const dryRun = await executeRouteTrackingQualityRebuild({
      args: parseRebuildRouteTrackingQualityArgs([
        '--app-id', scope.appId,
        '--shop-domain', scope.shopDomain,
        '--route-plan-id', scope.routePlanId,
        '--backup-file', backupFile,
      ]),
      roadMatchProvider,
      store,
    });
    const backup = dryRun.backup as { sha256: string };

    await expect(executeRouteTrackingQualityRebuild({
      args: parseRebuildRouteTrackingQualityArgs([
        '--app-id', scope.appId,
        '--shop-domain', scope.shopDomain,
        '--route-plan-id', scope.routePlanId,
        '--backup-file', backupFile,
        '--backup-sha256', backup.sha256,
        '--expected-current-derived-hash', 'a'.repeat(64),
        '--expected-current-watermark', 'reviewed-watermark',
        '--restore',
      ]),
      store,
    })).rejects.toThrow('outside the current route event window');
  });

  test('accepts only an unchanged prefix with a strictly append-only tail', () => {
    const prefix = positions();
    const digest = digestRouteTrackingSource(prefix);
    expect(() => assertAppendOnlySourcePrefix([...prefix, position(3)], prefix.length, digest)).not.toThrow();
    expect(() => assertAppendOnlySourcePrefix([prefix[0]!, position(9, '2026-09-17T13:00:03.000Z'), prefix[1]!], prefix.length, digest))
      .toThrow('prefix changed');
    expect(() => assertAppendOnlySourcePrefix(prefix.slice(0, 1), prefix.length, digest)).toThrow('prefix shrank');
  });

  test('binds the reviewed plan hash to the local service-date event window', async () => {
    const args = parseRebuildRouteTrackingQualityArgs([
      '--app-id', scope.appId,
      '--shop-domain', scope.shopDomain,
      '--route-plan-id', scope.routePlanId,
    ]);
    const baseline = await executeRouteTrackingQualityRebuild({
      args,
      roadMatchProvider,
      store: new InMemoryStore(),
    });
    const changedTimezone = await executeRouteTrackingQualityRebuild({
      args,
      roadMatchProvider,
      store: new InMemoryStore({
        eventWindow: {
          anchorSource: 'PLAN_DATE',
          endExclusive: new Date('2026-09-19T00:00:00.000Z'),
          serviceDate: '2026-09-17',
          startInclusive: new Date('2026-09-17T00:00:00.000Z'),
          timezone: 'UTC',
        },
      }),
    });

    expect(changedTimezone.planHash).not.toBe(baseline.planHash);
  });

  test('apply mutates only the derived tracking row and a repeat is a no-op', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tracking-rebuild-'));
    const backupFile = join(directory, 'backup.json');
    const store = new InMemoryStore();
    const dryRun = await executeRouteTrackingQualityRebuild({
      args: parseRebuildRouteTrackingQualityArgs([
        '--app-id', scope.appId,
        '--shop-domain', scope.shopDomain,
        '--route-plan-id', scope.routePlanId,
        '--backup-file', backupFile,
      ]),
      roadMatchProvider,
      store,
    });
    const backup = dryRun.backup as { sha256: string };
    const args = parseRebuildRouteTrackingQualityArgs([
      '--app-id', scope.appId,
      '--shop-domain', scope.shopDomain,
      '--route-plan-id', scope.routePlanId,
      '--backup-file', backupFile,
      '--backup-sha256', backup.sha256,
      '--plan-hash', String(dryRun.planHash),
      '--apply',
    ]);

    await expect(executeRouteTrackingQualityRebuild({ args, roadMatchProvider, store }))
      .resolves.toMatchObject({ mode: 'apply', mutationCount: 1 });
    await expect(executeRouteTrackingQualityRebuild({ args, roadMatchProvider, store }))
      .resolves.toMatchObject({ mode: 'apply', mutationCount: 0 });
    expect(store.derivedMutationCount).toBe(1);
    expect(store.rawEventMutationCount).toBe(0);
    expect(store.routeStateMutationCount).toBe(0);
  });

  test('production adapter mutates only tracking-derived state and its worker job', async () => {
    const source = await readFile(new URL('../src/scripts/rebuild-route-tracking-quality.ts', import.meta.url), 'utf8');
    expect(source).toContain('routeTrackingGeometry.upsert');
    expect(source).toContain('await settleHistoricalRebuildJob(tx, identity.routePlanId, document, new Date())');
    expect(source).toContain('routeTrackingRoadMatchJob.upsert(buildRestoredRoadMatchJobSettlement(');
    expect(source).toContain('routeTrackingRoadMatchJob.deleteMany');
    expect(source).toContain('enqueueRouteTrackingRoadMatch(tx, {');
    expect(source).not.toMatch(/driverEvent\.(?:create|delete|update|upsert)/u);
    expect(source).not.toMatch(/routePlan\.(?:create|delete|update|upsert)/u);
    expect(source).not.toMatch(/deliveryStop\.(?:create|delete|update|upsert)/u);
  });

  test('treats Prisma JSON-null writes and DB-shaped null reads as the same derived value', () => {
    expect(routeTrackingDerivedMatches({
      lastLatitude: '43.6500000',
      lastLongitude: '-79.3800000',
      roadMatchedGeometry: null,
      roadMatchedUncertainGeometry: null,
    }, {
      lastLatitude: 43.65,
      lastLongitude: -79.38,
      roadMatchedGeometry: Prisma.JsonNull,
      roadMatchedUncertainGeometry: Prisma.JsonNull,
    })).toBe(true);
  });

  test('rejects rollback when a new GPS tail changed derived state under the same watermark', () => {
    const applied = {
      ...derived(),
      lastEventId: 'event-2',
      lastOccurredAt: '2026-09-17T13:00:02.000Z',
      roadMatchedWatermark: 'stable-watermark',
    };
    const approvedHash = routeTrackingDerivedStateHash(applied);
    expect(() => assertCurrentDerivedRestoreState(applied, 'stable-watermark', approvedHash)).not.toThrow();
    expect(() => assertCurrentDerivedRestoreState({
      ...applied,
      lastEventId: 'event-3',
      lastOccurredAt: '2026-09-17T13:00:03.000Z',
      sourcePointCount: 3,
    }, 'stable-watermark', approvedHash)).toThrow('tracking state changed');
  });

  test('invalidates normal matcher leases at the exact reviewed derived input', () => {
    const document = buildRouteTrackingGeometryDocumentForTest();
    const now = new Date('2026-09-28T12:00:00.000Z');

    const settlement = buildHistoricalRebuildJobSettlement(scope.routePlanId, document, now);
    expect(settlement.data).toMatchObject({
      completedAt: now,
      leaseExpiresAt: null,
      leaseToken: null,
      nextAttemptAt: null,
      processingStartedAt: null,
      status: 'SUCCEEDED',
      targetLastInputOccurredAt: new Date('2026-09-17T13:00:02.000Z'),
      targetSourcePointCount: 2,
    });
    expect(settlement.where).toEqual({ routePlanId: scope.routePlanId });
  });

  test('aborts the historical derived transaction when its durable matcher job is missing', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const document = buildRouteTrackingGeometryDocumentForTest();

    await expect(settleHistoricalRebuildJob(
      { routeTrackingRoadMatchJob: { updateMany } } as never,
      scope.routePlanId,
      document,
      new Date('2026-09-28T12:00:00.000Z'),
    )).rejects.toThrow('road-match job is missing');
    expect(updateMany).toHaveBeenCalledOnce();
  });

  test('locks the exact route row before taking the tracking advisory lock', async () => {
    const sql: string[] = [];
    const tx = {
      $queryRaw: vi.fn((query: { strings: readonly string[] }) => {
        sql.push(query.strings.join(''));
        return Promise.resolve([]);
      }),
    };

    await lockRoutePlanThenTrackingAdvisory(tx as never, scope.routePlanId);

    expect(sql).toHaveLength(2);
    expect(sql[0]).toContain('FROM "route_plans"');
    expect(sql[0]).toContain('FOR UPDATE');
    expect(sql[1]).toContain('pg_advisory_xact_lock');
  });

  test('invalidates a stale matcher lease against restored derived coordinates', () => {
    const now = new Date('2026-09-28T12:00:00.000Z');
    const settlement = buildRestoredRoadMatchJobSettlement(scope.routePlanId, {
      lastOccurredAt: new Date('2026-09-17T13:00:02.000Z'),
      sourcePointCount: 2,
    }, now);

    expect(settlement.update).toMatchObject({
      completedAt: now,
      leaseToken: null,
      nextAttemptAt: null,
      status: 'SUCCEEDED',
      targetLastInputOccurredAt: new Date('2026-09-17T13:00:02.000Z'),
      targetSourcePointCount: 2,
    });
    expect(settlement.create).toMatchObject({ routePlanId: scope.routePlanId, status: 'SUCCEEDED' });
    expect(settlement.where).toEqual({ routePlanId: scope.routePlanId });
  });

  test('treats non-null but malformed restored road-match JSON as unusable', () => {
    expect(restoredRoadMatchCacheIsUsable({
      roadMatchedGeometry: { coordinates: [], type: 'MultiLineString' },
      roadMatchedSchemaVersion: 'route_tracking_road_match.v5',
    } as never)).toBe(false);
  });

  test('creates a fresh queued matcher job when malformed restored cache has no job row', async () => {
    const calls: string[] = [];
    const routeTrackingRoadMatchJob = {
      create: vi.fn(() => {
        calls.push('create');
        return Promise.resolve({});
      }),
      deleteMany: vi.fn(() => {
        calls.push('deleteMany');
        return Promise.resolve({ count: 0 });
      }),
      findUnique: vi.fn(() => {
        calls.push('findUnique');
        return Promise.resolve(null);
      }),
      update: vi.fn(),
      upsert: vi.fn(),
    };
    const now = new Date('2026-09-28T12:00:00.000Z');

    await reconcileRestoredRoadMatchJob({ routeTrackingRoadMatchJob } as never, scope.routePlanId, {
      lastOccurredAt: new Date('2026-09-17T13:00:02.000Z'),
      roadMatchedGeometry: { coordinates: [], type: 'MultiLineString' },
      roadMatchedSchemaVersion: 'route_tracking_road_match.v5',
      sourcePointCount: 2,
    } as never, now);

    expect(calls).toEqual(['deleteMany', 'findUnique', 'create']);
    expect(routeTrackingRoadMatchJob.create).toHaveBeenCalledWith({
      data: {
        nextAttemptAt: now,
        routePlanId: scope.routePlanId,
        targetLastInputOccurredAt: new Date('2026-09-17T13:00:02.000Z'),
        targetSourcePointCount: 2,
      },
    });
  });
});

class InMemoryStore implements RouteTrackingQualityRebuildStore {
  derivedMutationCount = 0;
  lastRoadMatchWrite: Parameters<RouteTrackingQualityRebuildStore['applyDerived']>[0]['roadMatchWrite'] | null = null;
  rawEventMutationCount = 0;
  routeStateMutationCount = 0;
  private applied = false;
  private readonly currentIdentity: ReturnType<typeof identity>;
  private currentDerived: unknown;
  private eventWindow: ReturnType<typeof trackingEventWindow>;
  private readonly source: RouteTrackingGeometryPositionInput[];

  constructor(options: {
    currentDerived?: unknown;
    eventWindow?: ReturnType<typeof trackingEventWindow>;
    identity?: ReturnType<typeof identity>;
    source?: RouteTrackingGeometryPositionInput[];
  } = {}) {
    this.currentIdentity = options.identity ?? identity();
    this.currentDerived = options.currentDerived ?? null;
    this.eventWindow = options.eventWindow ?? trackingEventWindow();
    this.source = options.source ?? positions();
  }

  inspect(): Promise<{
    currentDerived: unknown;
    eventWindow: ReturnType<typeof trackingEventWindow>;
    identity: ReturnType<typeof identity>;
    source: RouteTrackingGeometryPositionInput[];
  }> {
    return Promise.resolve({
      currentDerived: this.applied ? derived() : this.currentDerived,
      eventWindow: this.eventWindow,
      identity: this.currentIdentity,
      source: this.source,
    });
  }

  applyDerived(input: Parameters<RouteTrackingQualityRebuildStore['applyDerived']>[0]) {
    assertAppendOnlySourcePrefix(this.source, input.expectedSourcePrefixPointCount, input.expectedSourcePrefixDigest);
    if (input.preserveExistingRoadCache) {
      if (input.expectedCurrentDerivedStateHash === undefined) throw new Error('Missing preservation CAS hash.');
      assertCurrentDerivedPreservationState(this.currentDerived, input.expectedCurrentDerivedStateHash);
    }
    this.lastRoadMatchWrite = input.roadMatchWrite;
    const mutated = !this.applied;
    if (mutated) {
      this.applied = true;
      this.derivedMutationCount += 1;
    }
    return Promise.resolve({
      before: derivedSummary(),
      after: derivedSummary(),
      derivedStateHash: routeTrackingDerivedStateHash(derived()),
      mutated,
      prewriteBackupFile: `${input.backupFile}.prewrite-test.json`,
    });
  }

  append(next: RouteTrackingGeometryPositionInput): void {
    this.source.push(next);
  }

  setEventWindow(next: ReturnType<typeof trackingEventWindow>): void {
    this.eventWindow = next;
  }

  setCurrentDerived(next: unknown): void {
    this.currentDerived = next;
  }

  restoreDerived(input: Parameters<RouteTrackingQualityRebuildStore['restoreDerived']>[0]) {
    void input;
    return Promise.resolve({ mutationCount: 1, preRestoreBackupFile: '/tmp/pre-restore.json' });
  }

}

const roadMatchProvider: RouteTrackingRoadMatchClassifyingProvider = {
  match: (document) => Promise.resolve(matchedPath(document)),
  matchWithStatus: (document) => Promise.resolve({ path: matchedPath(document), retryable: false }),
};

function matchedPath(document: Parameters<RouteTrackingRoadMatchClassifyingProvider['match']>[0]) {
  return {
    coverage: 'ontario' as const,
    inputPointCount: document.sourcePointCount,
    lastInputOccurredAt: document.samples.at(-1)!.occurredAt,
    lastMatchedPosition: { latitude: 43.65, longitude: -79.38, occurredAt: document.samples.at(-1)!.occurredAt },
    matchedGeometry: { coordinates: [[[-79.4, 43.6] as [number, number], [-79.38, 43.65] as [number, number]]], type: 'MultiLineString' as const },
    inferredGeometry: {
      coordinates: [[[-79.38, 43.65] as [number, number], [-79.37, 43.66] as [number, number]]],
      sourceRanges: [{
        endEventId: document.samples.at(-1)!.eventId,
        endOccurredAt: document.samples.at(-1)!.occurredAt,
        endSourceIndex: document.samples.at(-1)!.sourceIndex ?? document.sourcePointCount - 1,
        startEventId: document.samples[0]!.eventId,
        startOccurredAt: document.samples[0]!.occurredAt,
        startSourceIndex: document.samples[0]!.sourceIndex ?? 0,
      }],
      type: 'MultiLineString' as const,
    },
    inferredRanges: [{
      endEventId: document.samples.at(-1)!.eventId,
      endOccurredAt: document.samples.at(-1)!.occurredAt,
      endSourceIndex: document.samples.at(-1)!.sourceIndex ?? document.sourcePointCount - 1,
      startEventId: document.samples[0]!.eventId,
      startOccurredAt: document.samples[0]!.occurredAt,
      startSourceIndex: document.samples[0]!.sourceIndex ?? 0,
    }],
    matchedPointCount: 2,
    schemaVersion: 'route_tracking_road_match.v1' as const,
    uncertainGeometry: null,
    watermark: 'route_tracking_road_match.v1:ONTARIO:2:2:test',
  };
}

function identity() {
  return {
    ...scope,
    assignmentGeneration: '1',
    driverId: 'driver-id',
    planDate: '2026-09-17',
    routeStatus: 'IN_PROGRESS',
    shopId: 'shop-id',
    stopStatuses: [{ deliveryStopId: 'stop-id', sequence: 1, status: 'PENDING' }],
  };
}

function trackingEventWindow() {
  return {
    anchorSource: 'PLAN_DATE' as const,
    endExclusive: new Date('2026-09-19T04:00:00.000Z'),
    serviceDate: '2026-09-17',
    startInclusive: new Date('2026-09-17T04:00:00.000Z'),
    timezone: 'America/Toronto',
  };
}

function positions(): RouteTrackingGeometryPositionInput[] {
  return [position(1), position(2)];
}

function buildRouteTrackingGeometryDocumentForTest() {
  return buildRouteTrackingGeometryDocument(positions());
}

function position(index: number, occurredAt = `2026-09-17T13:00:${String(index).padStart(2, '0')}.000Z`): RouteTrackingGeometryPositionInput {
  return {
    accuracyMeters: 8,
    driverId: 'driver-id',
    eventId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    latitude: 43.6 + index / 100,
    longitude: -79.4 + index / 100,
    occurredAt,
    receivedAt: occurredAt,
    routePlanId: scope.routePlanId,
  };
}

function derived() {
  return { geometryPointCount: 2, roadMatchedPointCount: 2, sampleMetadata: [], sourcePointCount: 2 };
}

function derivedSummary() {
  return { firstOccurredAt: null, gapCount: 0, geometryPointCount: 2, inferredLineCount: 1, lastOccurredAt: null, matchedPointCount: 2, sourcePointCount: 2, uncertainLineCount: 0 };
}

function preservationDocument() {
  return buildRouteTrackingGeometryDocument(preservationSource());
}

function preservationSource() {
  return Array.from({ length: 6 }, (_value, index) => ({
    ...position(index),
    latitude: 43.6 + index / 10_000,
    longitude: -79.4 + index / 10_000,
  }));
}

function roadLine(
  startSourceIndex: number,
  endSourceIndex: number,
  interpolationLevel: 0 | 1 | 2,
  coordinates: Array<[number, number]> = [
    [-79.4 + startSourceIndex / 100, 43.6 + startSourceIndex / 100],
    [-79.4 + endSourceIndex / 100, 43.6 + endSourceIndex / 100],
  ],
) {
  const source = preservationSource();
  return {
    coordinates,
    range: {
      endEventId: source[endSourceIndex]!.eventId,
      endOccurredAt: source[endSourceIndex]!.occurredAt,
      endSourceIndex,
      interpolationLevel,
      startEventId: source[startSourceIndex]!.eventId,
      startOccurredAt: source[startSourceIndex]!.occurredAt,
      startSourceIndex,
    },
  };
}

function sourceDiagnostic(
  startSourceIndex: number,
  endSourceIndex: number,
  reason: 'GPS_GAP' | 'IMPLAUSIBLE_JUMP' | 'LOW_ACCURACY' | 'NO_MATCH' | 'OUT_OF_COVERAGE',
) {
  const source = preservationSource();
  return {
    endEventId: source[endSourceIndex]!.eventId,
    endOccurredAt: source[endSourceIndex]!.occurredAt,
    endSourceIndex,
    interpolationLevel: 2 as const,
    reason,
    startEventId: source[startSourceIndex]!.eventId,
    startOccurredAt: source[startSourceIndex]!.occurredAt,
    startSourceIndex,
  };
}

function preservationCache(
  lines: {
    inferred?: ReturnType<typeof roadLine>[];
    matcherCountedInferred?: number;
    matched?: ReturnType<typeof roadLine>[];
    unmatched?: ReturnType<typeof sourceDiagnostic>[];
    uncertain?: ReturnType<typeof roadLine>[];
  },
  document: ReturnType<typeof preservationDocument>,
) {
  return {
    ...preservationWrite(lines, document),
    routePlanId: scope.routePlanId,
    sourcePointCount: document.sourcePointCount,
  };
}

function preservationWrite(
  lines: {
    inferred?: ReturnType<typeof roadLine>[];
    matcherCountedInferred?: number;
    matched?: ReturnType<typeof roadLine>[];
    unmatched?: ReturnType<typeof sourceDiagnostic>[];
    uncertain?: ReturnType<typeof roadLine>[];
  },
  document: ReturnType<typeof preservationDocument>,
) {
  const matched = testGeometry(lines.matched ?? []);
  const inferred = testGeometry(lines.inferred ?? []);
  const uncertain = testGeometry(lines.uncertain ?? []);
  const embed = (geometry: ReturnType<typeof testGeometry>) => ({
    ...(geometry ?? { coordinates: [], type: 'MultiLineString' }),
    ...(inferred === null ? {} : { inferredGeometry: inferred, inferredRanges: inferred.sourceRanges }),
    ...((lines.unmatched ?? []).length === 0 ? {} : { unmatchedRanges: lines.unmatched }),
  });
  return {
    roadMatchedCoverage: 'ontario',
    roadMatchedGeometry: embed(matched),
    roadMatchedLastInputOccurredAt: new Date(document.samples.at(-1)!.occurredAt),
    roadMatchedLastPosition: null as { latitude: number; longitude: number; occurredAt: string } | null,
    roadMatchedPointCount: [
      ...(lines.matched ?? []),
      ...(lines.inferred ?? []).slice(0, lines.matcherCountedInferred ?? lines.inferred?.length ?? 0),
      ...(lines.uncertain ?? []),
    ]
      .reduce((sum, line) => sum + line.coordinates.length, 0),
    roadMatchedSchemaVersion: 'route_tracking_road_match.v5',
    roadMatchedSourcePointCount: document.sourcePointCount,
    roadMatchedUncertainGeometry: embed(uncertain),
    roadMatchedWatermark: 'test-watermark',
  };
}

function preservationPath(document: ReturnType<typeof preservationDocument>) {
  const matched = testGeometry([roadLine(1, 2, 0)]);
  return {
    coverage: 'ontario' as const,
    inferredGeometry: null,
    inferredRanges: [],
    inputPointCount: document.sourcePointCount,
    lastInputOccurredAt: preservationSource().at(-1)!.occurredAt,
    lastMatchedPosition: {
      latitude: 43.6002,
      longitude: -79.3998,
      occurredAt: preservationSource()[2]!.occurredAt,
    },
    matchedGeometry: matched,
    matchedPointCount: 2,
    matchedRanges: matched?.sourceRanges ?? [],
    schemaVersion: 'route_tracking_road_match.v1' as const,
    uncertainGeometry: null,
    uncertainRanges: [],
    unmatchedRanges: [sourceDiagnostic(2, 5, 'NO_MATCH')],
    watermark: 'route_tracking_road_match.v1:ontario:6:2:test',
  };
}

function testGeometry(lines: ReturnType<typeof roadLine>[]) {
  return lines.length === 0 ? null : {
    coordinates: lines.map((line) => line.coordinates),
    sourceRanges: lines.map((line) => line.range),
    type: 'MultiLineString' as const,
  };
}
