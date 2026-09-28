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
  assertCurrentDerivedRestoreState,
  buildHistoricalRebuildJobSettlement,
  buildRestoredRoadMatchJobSettlement,
  digestRouteTrackingSource,
  executeRouteTrackingQualityRebuild,
  lockRoutePlanThenTrackingAdvisory,
  parseRebuildRouteTrackingQualityArgs,
  reconcileRestoredRoadMatchJob,
  restoredRoadMatchCacheIsUsable,
  routeTrackingDerivedMatches,
  routeTrackingDerivedStateHash,
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
    expect(source).toContain('routeTrackingRoadMatchJob.updateMany(buildHistoricalRebuildJobSettlement(');
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
  rawEventMutationCount = 0;
  routeStateMutationCount = 0;
  private applied = false;
  private readonly currentIdentity: ReturnType<typeof identity>;
  private readonly currentDerived: unknown;
  private eventWindow: ReturnType<typeof trackingEventWindow>;
  private readonly source = positions();

  constructor(options: {
    currentDerived?: unknown;
    eventWindow?: ReturnType<typeof trackingEventWindow>;
    identity?: ReturnType<typeof identity>;
  } = {}) {
    this.currentIdentity = options.identity ?? identity();
    this.currentDerived = options.currentDerived ?? null;
    this.eventWindow = options.eventWindow ?? trackingEventWindow();
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
