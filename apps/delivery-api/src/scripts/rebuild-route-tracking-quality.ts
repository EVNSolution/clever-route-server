import { createHash } from 'node:crypto';
import { lstat, open, readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import { Prisma, PrismaClient } from '@prisma/client';

import { readConfiguredCoverageBaseUrls, type RouteEngineRuntimeEnv } from '../modules/route-plans/route-engine-coverage.js';
import {
  buildRouteTrackingGeometryDocument,
  createRouteTrackingGeometryWrite,
  type RouteTrackingGeometryDocumentV1,
  type RouteTrackingGeometryPositionInput,
} from '../modules/route-tracking/route-tracking.geometry.js';
import {
  buildRouteTrackingRoadMatchCacheWrite,
  OsrmRouteTrackingRoadMatchProvider,
  type RouteTrackingRoadMatchClassifyingProvider,
} from '../modules/route-tracking/route-tracking.road-match.js';

type RebuildArgs = {
  appId: string;
  apply: boolean;
  backupFile?: string;
  backupSha256?: string;
  expectedCurrentDerivedHash?: string;
  expectedCurrentWatermark?: string;
  planHash?: string;
  restore: boolean;
  routePlanId: string;
  shopDomain: string;
};

type RouteIdentity = {
  appId: string;
  assignmentGeneration: string;
  driverId: string | null;
  planDate: string;
  routePlanId: string;
  routeStatus: string;
  shopDomain: string;
  shopId: string;
  stopStatuses: Array<{ deliveryStopId: string; sequence: number; status: string }>;
};

type RebuildInspection = {
  currentDerived: unknown;
  identity: RouteIdentity;
  source: RouteTrackingGeometryPositionInput[];
};

type RebuildPlan = {
  document: RouteTrackingGeometryDocumentV1;
  identity: RouteIdentity;
  planHash: string;
  roadMatchWrite: ReturnType<typeof buildRouteTrackingRoadMatchCacheWrite>;
  routeStateHash: string;
  sourcePrefixDigest: string;
  sourcePrefixLastKey: string;
  summary: TrackingSummary;
};

type TrackingSummary = {
  firstOccurredAt: string | null;
  gapCount: number;
  geometryPointCount: number;
  inferredLineCount: number;
  lastOccurredAt: string | null;
  matchedPointCount: number;
  sourcePointCount: number;
  uncertainLineCount: number;
};

type BackupEnvelope = {
  backupSchemaVersion: 'route_tracking_quality_rebuild_backup.v1';
  capturedAt: string;
  currentDerived: unknown;
  identity: RouteIdentity;
  planHash: string;
  routeStateHash: string;
  sourcePrefixDigest: string;
  sourcePrefixLastKey: string;
  sourcePrefixPointCount: number;
};

type ApplyResult = {
  after: TrackingSummary;
  before: TrackingSummary;
  derivedStateHash: string;
  mutated: boolean;
  prewriteBackupFile: string;
};

export interface RouteTrackingQualityRebuildStore {
  inspect(args: Pick<RebuildArgs, 'appId' | 'routePlanId' | 'shopDomain'>): Promise<RebuildInspection>;
  applyDerived(input: {
    backupFile: string;
    expectedIdentity: RouteIdentity;
    expectedRouteStateHash: string;
    expectedSourcePrefixDigest: string;
    expectedSourcePrefixPointCount: number;
    planHash: string;
    roadMatchWrite: RebuildPlan['roadMatchWrite'];
  }): Promise<ApplyResult>;
  restoreDerived(input: {
    backupFile: string;
    backupDerived: unknown;
    expectedCurrentDerivedHash: string;
    expectedCurrentWatermark: string;
    expectedIdentity: RouteIdentity;
    expectedRouteStateHash: string;
  }): Promise<{ mutationCount: number; preRestoreBackupFile: string }>;
}

export function parseRebuildRouteTrackingQualityArgs(argv: string[]): RebuildArgs {
  const values = new Map<string, string>();
  const valueFlags = new Set([
    '--app-id',
    '--backup-file',
    '--backup-sha256',
    '--expected-current-derived-hash',
    '--expected-current-watermark',
    '--plan-hash',
    '--route-plan-id',
    '--shop-domain',
  ]);
  let apply = false;
  let restore = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === '--apply') {
      if (apply) throw new Error('Duplicate --apply flag.');
      apply = true;
      continue;
    }
    if (arg === '--restore') {
      if (restore) throw new Error('Duplicate --restore flag.');
      restore = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') throw new UsageRequestedError();
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    if (!valueFlags.has(arg)) throw new Error(`Unknown flag: ${arg}`);
    if (values.has(arg)) throw new Error(`Duplicate singleton flag: ${arg}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    values.set(arg, value.trim());
    index += 1;
  }

  const backupFile = optional(values, '--backup-file');
  const backupSha256 = optional(values, '--backup-sha256');
  const expectedCurrentDerivedHash = optional(values, '--expected-current-derived-hash');
  const expectedCurrentWatermark = optional(values, '--expected-current-watermark');
  const planHash = optional(values, '--plan-hash');
  const result: RebuildArgs = {
    appId: required(values, '--app-id'),
    apply,
    restore,
    routePlanId: required(values, '--route-plan-id'),
    shopDomain: required(values, '--shop-domain'),
    ...(backupFile === undefined ? {} : { backupFile }),
    ...(backupSha256 === undefined ? {} : { backupSha256 }),
    ...(expectedCurrentDerivedHash === undefined ? {} : { expectedCurrentDerivedHash }),
    ...(expectedCurrentWatermark === undefined ? {} : { expectedCurrentWatermark }),
    ...(planHash === undefined ? {} : { planHash }),
  };
  if (result.backupFile !== undefined && !isAbsolute(result.backupFile)) {
    throw new Error('--backup-file must be an absolute path inside the runtime container.');
  }
  if (apply && restore) throw new Error('--apply and --restore are mutually exclusive.');
  if (apply) {
    if (result.backupFile === undefined || result.backupSha256 === undefined || result.planHash === undefined) {
      throw new Error('--apply requires --backup-file, --backup-sha256, and --plan-hash from a reviewed dry-run.');
    }
    if (!isSha256(result.backupSha256) || !isSha256(result.planHash)) {
      throw new Error('--backup-sha256 and --plan-hash must be lowercase SHA-256 values.');
    }
  } else if (restore) {
    if (result.backupFile === undefined || result.backupSha256 === undefined
      || result.expectedCurrentDerivedHash === undefined || result.expectedCurrentWatermark === undefined) {
      throw new Error('--restore requires --backup-file, --backup-sha256, --expected-current-derived-hash, and --expected-current-watermark.');
    }
    if (!isSha256(result.backupSha256) || !isSha256(result.expectedCurrentDerivedHash)) {
      throw new Error('--backup-sha256 and --expected-current-derived-hash must be lowercase SHA-256 values.');
    }
    if (result.planHash !== undefined) throw new Error('--plan-hash is not used with --restore.');
  } else if (result.backupSha256 !== undefined || result.planHash !== undefined
    || result.expectedCurrentDerivedHash !== undefined || result.expectedCurrentWatermark !== undefined) {
    throw new Error('--backup-sha256, --plan-hash, and --expected-current-watermark are apply/restore-only flags.');
  }
  return result;
}

export async function buildRouteTrackingQualityPlan(
  inspection: RebuildInspection,
  roadMatchProvider: RouteTrackingRoadMatchClassifyingProvider,
): Promise<RebuildPlan> {
  if (inspection.source.length === 0) throw new Error('No LOCATION_UPDATED source events were found for this route.');
  const document = buildRouteTrackingGeometryDocument(inspection.source);
  if (document.coordinates.length < 2) throw new Error('At least two valid tracking coordinates are required.');
  const outcome = await roadMatchProvider.matchWithStatus(document);
  if (outcome.retryable) throw new Error('OSRM route-tracking match was incomplete or retryable; rebuild aborted.');
  const path = outcome.path;
  if (path === null) throw new Error('OSRM did not produce a usable route-tracking match.');
  const roadMatchWrite = buildRouteTrackingRoadMatchCacheWrite(path);
  const routeStateHash = hashCanonical(inspection.identity);
  const sourcePrefixDigest = digestRouteTrackingSource(inspection.source);
  const sourcePrefixLastKey = sourceKey(inspection.source.at(-1)!);
  const planPayload = {
    identity: inspection.identity,
    proposedGeometry: createRouteTrackingGeometryWrite(inspection.identity.routePlanId, document),
    proposedRoadMatch: roadMatchWrite,
    routeStateHash,
    sourcePrefixDigest,
    sourcePrefixLastKey,
    sourcePrefixPointCount: inspection.source.length,
  };
  return {
    document,
    identity: inspection.identity,
    planHash: hashCanonical(planPayload),
    roadMatchWrite,
    routeStateHash,
    sourcePrefixDigest,
    sourcePrefixLastKey,
    summary: summarize(document, roadMatchWrite),
  };
}

export async function executeRouteTrackingQualityRebuild(input: {
  args: RebuildArgs;
  roadMatchProvider?: RouteTrackingRoadMatchClassifyingProvider;
  store: RouteTrackingQualityRebuildStore;
}): Promise<Record<string, unknown>> {
  const inspection = await input.store.inspect(input.args);
  assertIdentity(inspection.identity, input.args);
  const before = summarizeDerived(inspection.currentDerived);

  if (input.args.restore) {
    const reviewedBackup = await readReviewedBackup(input.args.backupFile!, input.args.backupSha256!);
    assertIdentity(reviewedBackup.identity, input.args);
    const restored = await input.store.restoreDerived({
      backupDerived: reviewedBackup.currentDerived,
      backupFile: input.args.backupFile!,
      expectedCurrentDerivedHash: input.args.expectedCurrentDerivedHash!,
      expectedCurrentWatermark: input.args.expectedCurrentWatermark!,
      expectedIdentity: reviewedBackup.identity,
      expectedRouteStateHash: reviewedBackup.routeStateHash,
    });
    return {
      ok: true,
      ...scopeOutput(input.args),
      mode: 'restore',
      mutationCount: restored.mutationCount,
      preRestoreBackupFile: restored.preRestoreBackupFile,
    };
  }

  if (input.roadMatchProvider === undefined) throw new Error('OSRM road-match provider is required.');

  if (!input.args.apply) {
    const plan = await buildRouteTrackingQualityPlan(inspection, input.roadMatchProvider);
    let backup: { path: string; sha256: string } | null = null;
    if (input.args.backupFile !== undefined) {
      backup = await writeBackupExclusive(input.args.backupFile, {
        backupSchemaVersion: 'route_tracking_quality_rebuild_backup.v1',
        capturedAt: new Date().toISOString(),
        currentDerived: inspection.currentDerived,
        identity: inspection.identity,
        planHash: plan.planHash,
        routeStateHash: plan.routeStateHash,
        sourcePrefixDigest: plan.sourcePrefixDigest,
        sourcePrefixLastKey: plan.sourcePrefixLastKey,
        sourcePrefixPointCount: inspection.source.length,
      });
    }
    return output(input.args, before, plan.summary, plan, { backup, mode: 'dry-run', mutationCount: 0 });
  }

  const backupFile = input.args.backupFile!;
  const reviewedBackup = await readReviewedBackup(backupFile, input.args.backupSha256!);
  assertIdentity(reviewedBackup.identity, input.args);
  if (hashCanonical(inspection.identity) !== reviewedBackup.routeStateHash) {
    throw new Error('Route identity, route status, assignment, or stop status changed after review.');
  }
  assertAppendOnlySourcePrefix(
    inspection.source,
    reviewedBackup.sourcePrefixPointCount,
    reviewedBackup.sourcePrefixDigest,
  );
  const approvedPrefix = inspection.source.slice(0, reviewedBackup.sourcePrefixPointCount);
  const plan = await buildRouteTrackingQualityPlan({
    ...inspection,
    identity: reviewedBackup.identity,
    source: approvedPrefix,
  }, input.roadMatchProvider);
  if (reviewedBackup.planHash !== input.args.planHash || reviewedBackup.planHash !== plan.planHash) {
    throw new Error('Reviewed plan hash does not match the current approved source prefix and proposed output.');
  }
  if (reviewedBackup.sourcePrefixDigest !== plan.sourcePrefixDigest
    || reviewedBackup.sourcePrefixPointCount !== approvedPrefix.length
    || reviewedBackup.sourcePrefixLastKey !== plan.sourcePrefixLastKey) {
    throw new Error('Reviewed source prefix no longer matches the planned source prefix.');
  }
  const applied = await input.store.applyDerived({
    backupFile,
    expectedIdentity: reviewedBackup.identity,
    expectedRouteStateHash: reviewedBackup.routeStateHash,
    expectedSourcePrefixDigest: reviewedBackup.sourcePrefixDigest,
    expectedSourcePrefixPointCount: reviewedBackup.sourcePrefixPointCount,
    planHash: reviewedBackup.planHash,
    roadMatchWrite: plan.roadMatchWrite,
  });
  return output(input.args, applied.before, applied.after, plan, {
    mode: 'apply',
    mutationCount: applied.mutated ? 1 : 0,
    appliedDerivedStateHash: applied.derivedStateHash,
    prewriteBackupFile: applied.prewriteBackupFile,
  });
}

export function assertAppendOnlySourcePrefix(
  current: RouteTrackingGeometryPositionInput[],
  expectedCount: number,
  expectedDigest: string,
): void {
  if (current.length < expectedCount) throw new Error('Source event prefix shrank after review.');
  const prefix = current.slice(0, expectedCount);
  if (digestRouteTrackingSource(prefix) !== expectedDigest) throw new Error('Source event prefix changed or received an out-of-order insertion after review.');
  const lastPrefixKey = prefix.length === 0 ? null : sourceKey(prefix.at(-1)!);
  if (lastPrefixKey !== null && current.slice(expectedCount).some((position) => sourceKey(position) <= lastPrefixKey)) {
    throw new Error('A source event was inserted into the reviewed prefix; apply aborted.');
  }
}

export class PrismaRouteTrackingQualityRebuildStore implements RouteTrackingQualityRebuildStore {
  constructor(private readonly prisma: PrismaClient) {}

  async inspect(args: Pick<RebuildArgs, 'appId' | 'routePlanId' | 'shopDomain'>): Promise<RebuildInspection> {
    const identity = await loadIdentity(this.prisma, args);
    if (identity === null) throw new Error('Route plan was not found for the exact app and shop identity.');
    const [source, currentDerived] = await Promise.all([
      loadSource(this.prisma, identity.routePlanId),
      this.prisma.routeTrackingGeometry.findUnique({ where: { routePlanId: identity.routePlanId } }),
    ]);
    return { currentDerived: jsonSafe(currentDerived), identity, source };
  }

  async applyDerived(input: {
    backupFile: string;
    expectedIdentity: RouteIdentity;
    expectedRouteStateHash: string;
    expectedSourcePrefixDigest: string;
    expectedSourcePrefixPointCount: number;
    planHash: string;
    roadMatchWrite: RebuildPlan['roadMatchWrite'];
  }): Promise<ApplyResult> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT TRUE AS "locked" FROM pg_advisory_xact_lock(hashtextextended(${input.expectedIdentity.routePlanId}, 0))`);
      const identity = await loadIdentity(tx, input.expectedIdentity);
      if (identity === null || hashCanonical(identity) !== input.expectedRouteStateHash) {
        throw new Error('Route identity, route status, assignment, or stop status changed after review.');
      }
      const source = await loadSource(tx, identity.routePlanId);
      assertAppendOnlySourcePrefix(source, input.expectedSourcePrefixPointCount, input.expectedSourcePrefixDigest);
      const document = buildRouteTrackingGeometryDocument(source);
      const geometryWrite = createRouteTrackingGeometryWrite(identity.routePlanId, document);
      const desired = { ...geometryWrite, ...input.roadMatchWrite };
      const current = await tx.routeTrackingGeometry.findUnique({ where: { routePlanId: identity.routePlanId } });
      const prewriteBackupFile = await writePrewriteBackup(input.backupFile, {
        backupSchemaVersion: 'route_tracking_quality_rebuild_backup.v1',
        capturedAt: new Date().toISOString(),
        currentDerived: jsonSafe(current),
        identity,
        planHash: input.planHash,
        routeStateHash: input.expectedRouteStateHash,
        sourcePrefixDigest: input.expectedSourcePrefixDigest,
        sourcePrefixLastKey: sourceKey(source[input.expectedSourcePrefixPointCount - 1]!),
        sourcePrefixPointCount: input.expectedSourcePrefixPointCount,
      });
      const mutated = !routeTrackingDerivedMatches(current, desired);
      if (mutated) {
        await tx.routeTrackingGeometry.upsert({
          create: desired,
          update: desired,
          where: { routePlanId: identity.routePlanId },
        });
      }
      return {
        after: summarize(document, input.roadMatchWrite),
        before: summarizeDerived(current),
        derivedStateHash: routeTrackingDerivedStateHash(desired),
        mutated,
        prewriteBackupFile,
      };
    }, { timeout: 60_000 });
  }

  async restoreDerived(input: {
    backupFile: string;
    backupDerived: unknown;
    expectedCurrentDerivedHash: string;
    expectedCurrentWatermark: string;
    expectedIdentity: RouteIdentity;
    expectedRouteStateHash: string;
  }): Promise<{ mutationCount: number; preRestoreBackupFile: string }> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT TRUE AS "locked" FROM pg_advisory_xact_lock(hashtextextended(${input.expectedIdentity.routePlanId}, 0))`);
      const identity = await loadIdentity(tx, input.expectedIdentity);
      if (identity === null || hashCanonical(identity) !== input.expectedRouteStateHash) {
        throw new Error('Route identity, route status, assignment, or stop status changed after backup.');
      }
      const current = await tx.routeTrackingGeometry.findUnique({ where: { routePlanId: identity.routePlanId } });
      assertCurrentDerivedRestoreState(current, input.expectedCurrentWatermark, input.expectedCurrentDerivedHash);
      const preRestoreBackupFile = await writePrewriteBackup(input.backupFile, {
        backupSchemaVersion: 'route_tracking_quality_rebuild_backup.v1',
        capturedAt: new Date().toISOString(),
        currentDerived: jsonSafe(current),
        identity,
        planHash: 'restore-prewrite',
        routeStateHash: input.expectedRouteStateHash,
        sourcePrefixDigest: 'restore-not-applicable',
        sourcePrefixLastKey: 'restore-not-applicable',
        sourcePrefixPointCount: 0,
      });
      if (input.backupDerived === null) {
        const deleted = await tx.routeTrackingGeometry.deleteMany({ where: { routePlanId: identity.routePlanId } });
        return { mutationCount: deleted.count, preRestoreBackupFile };
      }
      const restoreWrite = readDerivedRestoreWrite(input.backupDerived, identity.routePlanId);
      await tx.routeTrackingGeometry.upsert({
        create: restoreWrite,
        update: restoreWrite,
        where: { routePlanId: identity.routePlanId },
      });
      return { mutationCount: 1, preRestoreBackupFile };
    }, { timeout: 60_000 });
  }
}

function readDerivedRestoreWrite(value: unknown, routePlanId: string) {
  if (!isRecord(value) || value.routePlanId !== routePlanId) throw new Error('Backup derived row does not match the route plan.');
  return {
    expiresAt: requiredDate(value.expiresAt, 'expiresAt'),
    firstOccurredAt: requiredDate(value.firstOccurredAt, 'firstOccurredAt'),
    geometry: prismaJson(value.geometry),
    geometryPointCount: requiredInteger(value.geometryPointCount, 'geometryPointCount'),
    lastDriverId: nullableText(value.lastDriverId, 'lastDriverId'),
    lastEventId: requiredTextValue(value.lastEventId, 'lastEventId'),
    lastLatitude: requiredNumber(value.lastLatitude, 'lastLatitude'),
    lastLongitude: requiredNumber(value.lastLongitude, 'lastLongitude'),
    lastOccurredAt: requiredDate(value.lastOccurredAt, 'lastOccurredAt'),
    lastReceivedAt: requiredDate(value.lastReceivedAt, 'lastReceivedAt'),
    roadMatchedCoverage: nullableText(value.roadMatchedCoverage, 'roadMatchedCoverage'),
    roadMatchedGeometry: prismaJson(value.roadMatchedGeometry),
    roadMatchedLastInputOccurredAt: nullableDate(value.roadMatchedLastInputOccurredAt, 'roadMatchedLastInputOccurredAt'),
    roadMatchedLastPosition: prismaJson(value.roadMatchedLastPosition),
    roadMatchedPointCount: nullableInteger(value.roadMatchedPointCount, 'roadMatchedPointCount'),
    roadMatchedSchemaVersion: nullableText(value.roadMatchedSchemaVersion, 'roadMatchedSchemaVersion'),
    roadMatchedSourcePointCount: nullableInteger(value.roadMatchedSourcePointCount, 'roadMatchedSourcePointCount'),
    roadMatchedUncertainGeometry: prismaJson(value.roadMatchedUncertainGeometry),
    roadMatchedWatermark: nullableText(value.roadMatchedWatermark, 'roadMatchedWatermark'),
    routePlanId,
    sampleMetadata: prismaJson(value.sampleMetadata),
    sourcePointCount: requiredInteger(value.sourcePointCount, 'sourcePointCount'),
  };
}

async function loadIdentity(
  prisma: Pick<PrismaClient, 'routePlan'> | Prisma.TransactionClient,
  args: Pick<RebuildArgs, 'appId' | 'routePlanId' | 'shopDomain'>,
): Promise<RouteIdentity | null> {
  const route = await prisma.routePlan.findFirst({
    select: {
      assignmentGeneration: true,
      driverId: true,
      id: true,
      planDate: true,
      routeStops: {
        orderBy: { sequence: 'asc' },
        select: { deliveryStop: { select: { status: true } }, deliveryStopId: true, sequence: true },
      },
      shop: { select: { appId: true, id: true, shopDomain: true } },
      status: true,
    },
    where: { id: args.routePlanId, shop: { appId: args.appId, shopDomain: args.shopDomain } },
  });
  if (route === null) return null;
  return {
    appId: route.shop.appId,
    assignmentGeneration: route.assignmentGeneration.toString(),
    driverId: route.driverId,
    planDate: route.planDate.toISOString().slice(0, 10),
    routePlanId: route.id,
    routeStatus: route.status,
    shopDomain: route.shop.shopDomain,
    shopId: route.shop.id,
    stopStatuses: route.routeStops.map((stop) => ({
      deliveryStopId: stop.deliveryStopId,
      sequence: stop.sequence,
      status: stop.deliveryStop.status,
    })),
  };
}

async function loadSource(
  prisma: Pick<PrismaClient, 'driverEvent'> | Prisma.TransactionClient,
  routePlanId: string,
): Promise<RouteTrackingGeometryPositionInput[]> {
  const rows = await prisma.driverEvent.findMany({
    orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    select: { createdAt: true, driverId: true, id: true, latitude: true, longitude: true, occurredAt: true, payload: true, routePlanId: true },
    where: { eventType: 'LOCATION_UPDATED', latitude: { not: null }, longitude: { not: null }, routePlanId },
  });
  return rows.flatMap((row) => {
    const latitude = Number(row.latitude);
    const longitude = Number(row.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || row.routePlanId === null) return [];
    return [{
      accuracyMeters: readAccuracyMeters(row.payload),
      driverId: row.driverId,
      eventId: row.id,
      latitude,
      longitude,
      occurredAt: row.occurredAt.toISOString(),
      receivedAt: row.createdAt.toISOString(),
      routePlanId: row.routePlanId,
    }];
  });
}

function readAccuracyMeters(payload: unknown): number | null {
  if (!isRecord(payload)) return null;
  const location = isRecord(payload.location) ? payload.location : null;
  const value = payload.accuracyMeters ?? payload.accuracy ?? location?.accuracyMeters;
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 100) / 100 : null;
}

function assertIdentity(identity: RouteIdentity, args: Pick<RebuildArgs, 'appId' | 'routePlanId' | 'shopDomain'>): void {
  if (identity.appId !== args.appId || identity.shopDomain !== args.shopDomain || identity.routePlanId !== args.routePlanId) {
    throw new Error('Route identity does not match --app-id, --shop-domain, and --route-plan-id.');
  }
}

export function digestRouteTrackingSource(source: RouteTrackingGeometryPositionInput[]): string {
  return hashCanonical(source.map((position) => ({
    accuracyMeters: position.accuracyMeters ?? null,
    driverId: position.driverId,
    eventId: position.eventId,
    latitude: position.latitude,
    longitude: position.longitude,
    occurredAt: position.occurredAt,
    receivedAt: position.receivedAt,
    routePlanId: position.routePlanId,
  })));
}

function sourceKey(position: RouteTrackingGeometryPositionInput): string {
  return `${position.occurredAt}\u0000${position.receivedAt}\u0000${position.eventId}`;
}

function summarize(
  document: RouteTrackingGeometryDocumentV1,
  roadMatchWrite: RebuildPlan['roadMatchWrite'],
): TrackingSummary {
  const uncertain = jsonSafe(roadMatchWrite.roadMatchedUncertainGeometry) as { coordinates?: unknown[] } | null;
  const matched = jsonSafe(roadMatchWrite.roadMatchedGeometry);
  return {
    firstOccurredAt: document.samples[0]?.occurredAt ?? null,
    gapCount: document.samples.filter((sample) => sample.gapBefore).length,
    geometryPointCount: document.coordinates.length,
    inferredLineCount: readInferredLineCount(matched),
    lastOccurredAt: document.samples.at(-1)?.occurredAt ?? null,
    matchedPointCount: roadMatchWrite.roadMatchedPointCount,
    sourcePointCount: document.sourcePointCount,
    uncertainLineCount: Array.isArray(uncertain?.coordinates) ? uncertain.coordinates.length : 0,
  };
}

function summarizeDerived(value: unknown): TrackingSummary {
  if (!isRecord(value)) return emptySummary();
  const samples = Array.isArray(value.sampleMetadata) ? value.sampleMetadata : [];
  const uncertain = isRecord(value.roadMatchedUncertainGeometry) && Array.isArray(value.roadMatchedUncertainGeometry.coordinates)
    ? value.roadMatchedUncertainGeometry.coordinates.length
    : 0;
  return {
    firstOccurredAt: isoOrNull(value.firstOccurredAt),
    gapCount: samples.filter((sample) => isRecord(sample) && sample.gapBefore === true).length,
    geometryPointCount: integerOrZero(value.geometryPointCount),
    inferredLineCount: readInferredLineCount(value.roadMatchedGeometry),
    lastOccurredAt: isoOrNull(value.lastOccurredAt),
    matchedPointCount: integerOrZero(value.roadMatchedPointCount),
    sourcePointCount: integerOrZero(value.sourcePointCount),
    uncertainLineCount: uncertain,
  };
}

function emptySummary(): TrackingSummary {
  return { firstOccurredAt: null, gapCount: 0, geometryPointCount: 0, inferredLineCount: 0, lastOccurredAt: null, matchedPointCount: 0, sourcePointCount: 0, uncertainLineCount: 0 };
}

function readInferredLineCount(value: unknown): number {
  if (!isRecord(value) || !isRecord(value.inferredGeometry)) return 0;
  return Array.isArray(value.inferredGeometry.coordinates) ? value.inferredGeometry.coordinates.length : 0;
}

export function routeTrackingDerivedMatches(current: unknown, desired: Record<string, unknown>): boolean {
  if (!isRecord(current)) return false;
  const keys = Object.keys(desired);
  const currentComparable = Object.fromEntries(keys.map((key) => [key, normalizeDerivedField(key, current[key])]));
  const desiredComparable = Object.fromEntries(keys.map((key) => [key, normalizeDerivedField(key, desired[key])]));
  return hashCanonical(currentComparable) === hashCanonical(desiredComparable);
}

const DERIVED_STATE_FIELDS = [
  'expiresAt',
  'firstOccurredAt',
  'geometry',
  'geometryPointCount',
  'lastDriverId',
  'lastEventId',
  'lastLatitude',
  'lastLongitude',
  'lastOccurredAt',
  'lastReceivedAt',
  'roadMatchedCoverage',
  'roadMatchedGeometry',
  'roadMatchedLastInputOccurredAt',
  'roadMatchedLastPosition',
  'roadMatchedPointCount',
  'roadMatchedSchemaVersion',
  'roadMatchedSourcePointCount',
  'roadMatchedUncertainGeometry',
  'roadMatchedWatermark',
  'routePlanId',
  'sampleMetadata',
  'sourcePointCount',
] as const;

export function routeTrackingDerivedStateHash(value: unknown): string {
  if (!isRecord(value)) return hashCanonical(null);
  return hashCanonical(Object.fromEntries(
    DERIVED_STATE_FIELDS.map((key) => [key, normalizeDerivedField(key, value[key])]),
  ));
}

export function assertCurrentDerivedRestoreState(
  current: unknown,
  expectedWatermark: string,
  expectedDerivedStateHash: string,
): void {
  if (!isRecord(current) || current.roadMatchedWatermark !== expectedWatermark) {
    throw new Error('Current derived watermark does not match the explicitly approved rollback target.');
  }
  if (routeTrackingDerivedStateHash(current) !== expectedDerivedStateHash) {
    throw new Error('Current derived tracking state changed after apply; rollback aborted.');
  }
}

function normalizeDerivedField(key: string, value: unknown): unknown {
  if (key === 'lastLatitude' || key === 'lastLongitude') {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  return jsonSafe(value);
}

async function writeBackupExclusive(path: string, envelope: BackupEnvelope): Promise<{ path: string; sha256: string }> {
  const content = `${JSON.stringify(jsonSafe(envelope), null, 2)}\n`;
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { path, sha256: sha256(content) };
}

async function readReviewedBackup(path: string, expectedSha256: string): Promise<BackupEnvelope> {
  const stats = await lstat(path);
  if (!stats.isFile() || (stats.mode & 0o777) !== 0o600) throw new Error('Reviewed backup must be a regular file with mode 0600.');
  const content = await readFile(path, 'utf8');
  if (sha256(content) !== expectedSha256) throw new Error('Reviewed backup SHA-256 mismatch.');
  const value = JSON.parse(content) as unknown;
  if (!isBackupEnvelope(value)) throw new Error('Reviewed backup envelope is invalid.');
  return value;
}

async function writePrewriteBackup(basePath: string, envelope: BackupEnvelope): Promise<string> {
  const suffix = new Date().toISOString().replaceAll(':', '').replaceAll('.', '');
  const path = `${basePath}.prewrite-${suffix}.json`;
  await writeBackupExclusive(path, envelope);
  return path;
}

function isBackupEnvelope(value: unknown): value is BackupEnvelope {
  return isRecord(value)
    && value.backupSchemaVersion === 'route_tracking_quality_rebuild_backup.v1'
    && typeof value.planHash === 'string'
    && typeof value.routeStateHash === 'string'
    && typeof value.sourcePrefixDigest === 'string'
    && typeof value.sourcePrefixLastKey === 'string'
    && Number.isInteger(value.sourcePrefixPointCount)
    && isRecord(value.identity);
}

function output(
  args: RebuildArgs,
  before: TrackingSummary,
  after: TrackingSummary,
  plan: RebuildPlan,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ok: true,
    ...scopeOutput(args),
    planHash: plan.planHash,
    plannedRoadMatchedWatermark: plan.roadMatchWrite.roadMatchedWatermark,
    sourcePrefixDigest: plan.sourcePrefixDigest,
    before,
    after,
    ...extra,
  };
}

function scopeOutput(args: Pick<RebuildArgs, 'appId' | 'routePlanId' | 'shopDomain'>) {
  return { appId: args.appId, routePlanId: args.routePlanId, shopDomain: args.shopDomain };
}

function prismaJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return value === null || value === undefined ? Prisma.JsonNull : value;
}

function requiredDate(value: unknown, field: string): Date {
  const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
  if (date === null || !Number.isFinite(date.getTime())) throw new Error(`Backup derived ${field} is invalid.`);
  return date;
}

function nullableDate(value: unknown, field: string): Date | null {
  return value === null || value === undefined ? null : requiredDate(value, field);
}

function requiredInteger(value: unknown, field: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new Error(`Backup derived ${field} is invalid.`);
  return number;
}

function nullableInteger(value: unknown, field: string): number | null {
  return value === null || value === undefined ? null : requiredInteger(value, field);
}

function requiredNumber(value: unknown, field: string): number {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`Backup derived ${field} is invalid.`);
  return number;
}

function requiredTextValue(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(`Backup derived ${field} is invalid.`);
  return value;
}

function nullableText(value: unknown, field: string): string | null {
  return value === null || value === undefined ? null : requiredTextValue(value, field);
}

function hashCanonical(value: unknown): string {
  return sha256(canonicalJson(jsonSafe(value)));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}

function jsonSafe(value: unknown): unknown {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'bigint') return item.toString();
    if (item instanceof Prisma.NullTypes.JsonNull || item instanceof Prisma.NullTypes.DbNull) return null;
    return item;
  })) as unknown;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function integerOrZero(value: unknown): number {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}

function isoOrNull(value: unknown): string | null {
  const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
  return date !== null && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function required(values: Map<string, string>, key: string): string {
  const value = values.get(key);
  if (value === undefined || value === '') throw new Error(`Missing required argument: ${key}`);
  return value;
}

function optional(values: Map<string, string>, key: string): string | undefined {
  const value = values.get(key);
  return value === undefined || value === '' ? undefined : value;
}

function createRoadMatchProvider(env: RouteEngineRuntimeEnv & Partial<Record<'OSRM_TIMEOUT_MS', string>>): OsrmRouteTrackingRoadMatchProvider {
  const baseUrls = readConfiguredCoverageBaseUrls(env, 'OSRM');
  if (Object.keys(baseUrls).length === 0) throw new Error('An OSRM coverage URL is required for route-tracking rebuild.');
  const timeoutMs = Number.parseInt(env.OSRM_TIMEOUT_MS ?? '', 10);
  return new OsrmRouteTrackingRoadMatchProvider({
    baseUrls,
    ...(Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeoutMs } : {}),
  });
}

class UsageRequestedError extends Error {}

async function main(): Promise<void> {
  const args = parseRebuildRouteTrackingQualityArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  try {
    const result = await executeRouteTrackingQualityRebuild({
      args,
      ...(args.restore ? {} : { roadMatchProvider: createRoadMatchProvider(process.env) }),
      store: new PrismaRouteTrackingQualityRebuildStore(prisma),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

function printUsage(): void {
  process.stderr.write('Usage: node dist/scripts/rebuild-route-tracking-quality.js --app-id <app> --shop-domain <domain> --route-plan-id <uuid> [--backup-file <absolute-private-path>] [--apply --plan-hash <sha256> --backup-sha256 <sha256> | --restore --backup-sha256 <sha256> --expected-current-derived-hash <sha256> --expected-current-watermark <watermark>]\n');
}

function isMainModule(): boolean {
  return process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], 'file:').href;
}

if (isMainModule()) {
  main().catch((error: unknown) => {
    if (error instanceof UsageRequestedError) {
      printUsage();
      process.exitCode = 0;
      return;
    }
    process.stderr.write(`${JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown rebuild failure' })}\n`);
    process.exitCode = 1;
  });
}
