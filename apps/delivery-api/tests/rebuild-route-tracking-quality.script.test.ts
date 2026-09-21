import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';
import { Prisma } from '@prisma/client';

import type { RouteTrackingGeometryPositionInput } from '../src/modules/route-tracking/route-tracking.geometry.js';
import type { RouteTrackingRoadMatchClassifyingProvider } from '../src/modules/route-tracking/route-tracking.road-match.js';
import {
  assertAppendOnlySourcePrefix,
  assertCurrentDerivedRestoreState,
  digestRouteTrackingSource,
  executeRouteTrackingQualityRebuild,
  parseRebuildRouteTrackingQualityArgs,
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
  test('requires exact tenant identity and defaults to mutation-free dry-run', async () => {
    const store = new InMemoryStore();
    const args = parseRebuildRouteTrackingQualityArgs([
      '--app-id', scope.appId,
      '--shop-domain', scope.shopDomain,
      '--route-plan-id', scope.routePlanId,
    ]);
    const result = await executeRouteTrackingQualityRebuild({ args, roadMatchProvider, store });

    expect(result).toMatchObject({ mode: 'dry-run', mutationCount: 0, ...scope });
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
    store.append(position(3));
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

  test('accepts only an unchanged prefix with a strictly append-only tail', () => {
    const prefix = positions();
    const digest = digestRouteTrackingSource(prefix);
    expect(() => assertAppendOnlySourcePrefix([...prefix, position(3)], prefix.length, digest)).not.toThrow();
    expect(() => assertAppendOnlySourcePrefix([prefix[0]!, position(9, '2026-09-17T13:00:03.000Z'), prefix[1]!], prefix.length, digest))
      .toThrow('prefix changed');
    expect(() => assertAppendOnlySourcePrefix(prefix.slice(0, 1), prefix.length, digest)).toThrow('prefix shrank');
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
    store.append(position(3));
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

  test('production adapter has no mutation path outside the derived tracking row', async () => {
    const source = await readFile(new URL('../src/scripts/rebuild-route-tracking-quality.ts', import.meta.url), 'utf8');
    expect(source).toContain('routeTrackingGeometry.upsert');
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
});

class InMemoryStore implements RouteTrackingQualityRebuildStore {
  derivedMutationCount = 0;
  rawEventMutationCount = 0;
  routeStateMutationCount = 0;
  private applied = false;
  private readonly currentIdentity: ReturnType<typeof identity>;
  private readonly source = positions();

  constructor(options: { identity?: ReturnType<typeof identity> } = {}) {
    this.currentIdentity = options.identity ?? identity();
  }

  inspect(): Promise<{ currentDerived: unknown; identity: ReturnType<typeof identity>; source: RouteTrackingGeometryPositionInput[] }> {
    return Promise.resolve({
      currentDerived: this.applied ? derived() : null,
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

function positions(): RouteTrackingGeometryPositionInput[] {
  return [position(1), position(2)];
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
  return { firstOccurredAt: null, gapCount: 0, geometryPointCount: 2, lastOccurredAt: null, matchedPointCount: 2, sourcePointCount: 2, uncertainLineCount: 0 };
}
