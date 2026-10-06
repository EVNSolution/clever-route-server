import { createHash } from 'node:crypto';
import { lstat, open, readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import { Prisma, PrismaClient } from '@prisma/client';

import {
  buildRouteTrackingGeometryDocument,
  createRouteTrackingGeometryWrite,
  type RouteTrackingGeometryPositionInput,
} from '../modules/route-tracking/route-tracking.geometry.js';
import { enqueueRouteTrackingRoadMatch } from '../modules/route-tracking/route-tracking-road-match-job.repository.js';
import {
  loadRouteTrackingEventWindow,
  type RouteTrackingEventWindow,
} from '../modules/route-tracking/route-tracking.event-window.js';

const REDACTION_TRANSACTION_TIMEOUT_MS = 5 * 60_000;

type Args = {
  appId: string;
  apply: boolean;
  backupFile: string;
  backupSha256?: string;
  candidateDigest?: string;
  preRestoreBackupFile?: string;
  restore: boolean;
  routePlanId: string;
  shopDomain: string;
};

type Identity = {
  appId: string;
  assignmentGeneration: string;
  driverId: string | null;
  planDate: string;
  routePlanId: string;
  routeStatus: string;
  shopDomain: string;
  shopId: string;
};

type Candidate = {
  clientEventId: string | null;
  createdAt: string;
  driverId: string | null;
  id: string;
  latitude: string | null;
  longitude: string | null;
  occurredAt: string;
  payload: unknown;
};

type Inspection = {
  candidates: Candidate[];
  currentDerived: unknown;
  currentJob: unknown;
  identity: Identity;
  window: RouteTrackingEventWindow;
};

type Backup = {
  backupSchemaVersion: 'route_tracking_outside_window_redaction.v1';
  candidateDigest: string;
  candidates: Candidate[];
  capturedAt: string;
  currentDerived: unknown;
  currentJob: unknown;
  identity: Identity;
  routeStateHash: string;
  window: { anchorSource: 'PLAN_DATE' | 'ROUTE_STARTED'; endExclusive: string; serviceDate: string; startInclusive: string; timezone: string };
};

export interface RouteTrackingOutsideWindowRedactionStore {
  apply(input: { backup: Backup; candidateDigest: string }): Promise<{ mutationCount: number; remainingEligiblePointCount: number }>;
  inspect(args: Pick<Args, 'appId' | 'routePlanId' | 'shopDomain'>): Promise<Inspection>;
  restore(input: { backup: Backup; candidateDigest: string; preRestoreBackupFile: string }): Promise<{ mutationCount: number; preRestoreBackupFile: string; remainingEligiblePointCount: number }>;
}

export function parseRouteTrackingOutsideWindowRedactionArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  let apply = false;
  let restore = false;
  const allowed = new Set(['--app-id', '--backup-file', '--backup-sha256', '--candidate-digest', '--pre-restore-backup-file', '--route-plan-id', '--shop-domain']);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--apply') {
      if (apply) throw new Error('Duplicate --apply flag.');
      apply = true;
      continue;
    }
    if (flag === '--restore') {
      if (restore) throw new Error('Duplicate --restore flag.');
      restore = true;
      continue;
    }
    if (flag === undefined || !allowed.has(flag)) throw new Error(`Unknown argument: ${flag ?? ''}`);
    if (values.has(flag)) throw new Error(`Duplicate singleton flag: ${flag}`);
    const value = argv[index + 1]?.trim();
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    values.set(flag, value);
    index += 1;
  }
  const result: Args = {
    appId: required(values, '--app-id'),
    apply,
    backupFile: required(values, '--backup-file'),
    routePlanId: required(values, '--route-plan-id'),
    restore,
    shopDomain: required(values, '--shop-domain'),
    ...(values.has('--backup-sha256') ? { backupSha256: values.get('--backup-sha256')! } : {}),
    ...(values.has('--candidate-digest') ? { candidateDigest: values.get('--candidate-digest')! } : {}),
    ...(values.has('--pre-restore-backup-file') ? { preRestoreBackupFile: values.get('--pre-restore-backup-file')! } : {}),
  };
  if (!isAbsolute(result.backupFile)) throw new Error('--backup-file must be an absolute path.');
  if (result.preRestoreBackupFile !== undefined && !isAbsolute(result.preRestoreBackupFile)) throw new Error('--pre-restore-backup-file must be an absolute path.');
  if (apply && restore) throw new Error('--apply and --restore are mutually exclusive.');
  if ((apply || restore) && (!isSha256(result.backupSha256) || !isSha256(result.candidateDigest))) {
    throw new Error('--apply/--restore require lowercase SHA-256 --backup-sha256 and --candidate-digest values from dry-run.');
  }
  if (restore && result.preRestoreBackupFile === undefined) throw new Error('--restore requires --pre-restore-backup-file.');
  if (!apply && !restore && (result.backupSha256 !== undefined || result.candidateDigest !== undefined || result.preRestoreBackupFile !== undefined)) {
    throw new Error('--backup-sha256, --candidate-digest, and --pre-restore-backup-file are apply/restore-only flags.');
  }
  return result;
}

export async function executeRouteTrackingOutsideWindowRedaction(input: {
  args: Args;
  store: RouteTrackingOutsideWindowRedactionStore;
}): Promise<Record<string, unknown>> {
  if (!input.args.apply && !input.args.restore) {
    const inspection = await input.store.inspect(input.args);
    assertIdentity(inspection.identity, input.args);
    const backup = createBackup(inspection);
    const sha256 = await writeExclusivePrivateJson(input.args.backupFile, backup);
    return {
      mode: 'dry-run', mutationCount: 0, candidateCount: backup.candidates.length,
      candidateDigest: backup.candidateDigest, backup: { file: input.args.backupFile, sha256 },
      routePlanId: backup.identity.routePlanId, window: backup.window,
    };
  }

  const backup = await readReviewedBackup(input.args.backupFile, input.args.backupSha256!);
  assertIdentity(backup.identity, input.args);
  if (backup.candidateDigest !== input.args.candidateDigest) throw new Error('Reviewed candidate digest does not match --candidate-digest.');
  if (input.args.restore) {
    const result = await input.store.restore({
      backup, candidateDigest: input.args.candidateDigest, preRestoreBackupFile: input.args.preRestoreBackupFile!,
    });
    return {
      mode: 'restore', candidateCount: backup.candidates.length, candidateDigest: backup.candidateDigest,
      routePlanId: backup.identity.routePlanId, ...result,
    };
  }
  const result = await input.store.apply({ backup, candidateDigest: input.args.candidateDigest });
  return {
    mode: 'apply', candidateCount: backup.candidates.length, candidateDigest: backup.candidateDigest,
    routePlanId: backup.identity.routePlanId, ...result,
  };
}

export class PrismaRouteTrackingOutsideWindowRedactionStore implements RouteTrackingOutsideWindowRedactionStore {
  constructor(private readonly prisma: PrismaClient) {}

  async inspect(args: Pick<Args, 'appId' | 'routePlanId' | 'shopDomain'>): Promise<Inspection> {
    const identity = await loadIdentity(this.prisma, args);
    if (identity === null) throw new Error('Route plan was not found for the exact app and shop identity.');
    const window = await loadRouteTrackingEventWindow(this.prisma, identity.routePlanId);
    if (window === null) throw new Error('Route tracking event window could not be resolved.');
    const [candidates, currentDerived, currentJob] = await Promise.all([
      loadCandidates(this.prisma, identity.routePlanId, window),
      this.prisma.routeTrackingGeometry.findUnique({ where: { routePlanId: identity.routePlanId } }),
      this.prisma.routeTrackingRoadMatchJob.findUnique({ where: { routePlanId: identity.routePlanId } }),
    ]);
    return { candidates, currentDerived: jsonSafe(currentDerived), currentJob: jsonSafe(currentJob), identity, window };
  }

  async apply(input: { backup: Backup; candidateDigest: string }): Promise<{ mutationCount: number; remainingEligiblePointCount: number }> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "route_plans" WHERE "id" = ${input.backup.identity.routePlanId}::uuid FOR UPDATE`);
      await tx.$queryRaw(Prisma.sql`SELECT TRUE AS "locked" FROM pg_advisory_xact_lock(hashtextextended(${input.backup.identity.routePlanId}, 0))`);
      const identity = await loadIdentity(tx, input.backup.identity);
      if (identity === null || hashCanonical(identity) !== input.backup.routeStateHash) {
        throw new Error('Route identity or state changed after review.');
      }
      const window = await loadRouteTrackingEventWindow(tx, identity.routePlanId);
      if (window === null || hashCanonical(serializeWindow(window)) !== hashCanonical(input.backup.window)) {
        throw new Error('Route tracking event window changed after review.');
      }
      const candidates = await loadCandidates(tx, identity.routePlanId, window);
      let alreadyRedacted = false;
      if (candidates.length === 0 && input.backup.candidates.length > 0) {
        const reviewed = await tx.driverEvent.findMany({
          select: { clientEventId: true, createdAt: true, driverId: true, id: true, latitude: true, longitude: true, occurredAt: true, payload: true },
          where: { id: { in: input.backup.candidates.map((candidate) => candidate.id) }, routePlanId: identity.routePlanId },
        });
        alreadyRedacted = reviewedRowsMatchTombstones(reviewed, input.backup.candidates);
      }
      if (!alreadyRedacted && (digestCandidates(candidates) !== input.candidateDigest || digestCandidates(candidates) !== input.backup.candidateDigest)) {
        throw new Error('Out-of-window candidate set changed after review.');
      }
      let mutationCount = 0;
      for (let index = 0; !alreadyRedacted && index < candidates.length; index += 1_000) {
        const ids = candidates.slice(index, index + 1_000).map((candidate) => candidate.id);
        const updated = await tx.driverEvent.updateMany({
          data: { latitude: null, longitude: null, payload: Prisma.JsonNull },
          where: { eventType: 'LOCATION_UPDATED', id: { in: ids }, routePlanId: identity.routePlanId },
        });
        if (updated.count !== ids.length) throw new Error('Candidate redaction count did not match the reviewed set.');
        mutationCount += updated.count;
      }

      const eligible = await reconcileDerived(tx, identity.routePlanId, window);
      return { mutationCount, remainingEligiblePointCount: eligible.length };
    }, { timeout: REDACTION_TRANSACTION_TIMEOUT_MS });
  }

  async restore(input: { backup: Backup; candidateDigest: string; preRestoreBackupFile: string }): Promise<{ mutationCount: number; preRestoreBackupFile: string; remainingEligiblePointCount: number }> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "route_plans" WHERE "id" = ${input.backup.identity.routePlanId}::uuid FOR UPDATE`);
      await tx.$queryRaw(Prisma.sql`SELECT TRUE AS "locked" FROM pg_advisory_xact_lock(hashtextextended(${input.backup.identity.routePlanId}, 0))`);
      const identity = await loadIdentity(tx, input.backup.identity);
      if (identity === null || hashCanonical(identity) !== input.backup.routeStateHash) throw new Error('Route identity or state changed after review.');
      const window = await loadRouteTrackingEventWindow(tx, identity.routePlanId);
      if (window === null || hashCanonical(serializeWindow(window)) !== hashCanonical(input.backup.window)) throw new Error('Route tracking event window changed after review.');
      if (digestCandidates(input.backup.candidates) !== input.candidateDigest) throw new Error('Reviewed candidate digest is invalid.');

      const reviewed = await tx.driverEvent.findMany({
        select: { clientEventId: true, createdAt: true, driverId: true, id: true, latitude: true, longitude: true, occurredAt: true, payload: true },
        where: { id: { in: input.backup.candidates.map((candidate) => candidate.id) }, routePlanId: identity.routePlanId },
      });
      if (!reviewedRowsMatchTombstones(reviewed, input.backup.candidates)) throw new Error('Reviewed rows are not unchanged tombstones; restore aborted.');
      const [currentDerived, currentJob] = await Promise.all([
        tx.routeTrackingGeometry.findUnique({ where: { routePlanId: identity.routePlanId } }),
        tx.routeTrackingRoadMatchJob.findUnique({ where: { routePlanId: identity.routePlanId } }),
      ]);
      await writeExclusivePrivateJson(input.preRestoreBackupFile, {
        backupSchemaVersion: 'route_tracking_outside_window_pre_restore.v1', capturedAt: new Date().toISOString(),
        candidateDigest: input.candidateDigest, currentDerived: jsonSafe(currentDerived), currentJob: jsonSafe(currentJob),
        identity, reviewedRows: jsonSafe(reviewed), window: serializeWindow(window),
      });

      let mutationCount = 0;
      for (let index = 0; index < input.backup.candidates.length; index += 500) {
        const candidates = input.backup.candidates.slice(index, index + 500);
        const values = candidates.map((candidate) => Prisma.sql`(
          ${candidate.id}::uuid,
          ${candidate.latitude}::numeric,
          ${candidate.longitude}::numeric,
          ${JSON.stringify(candidate.payload)}::jsonb
        )`);
        const restored = await tx.$executeRaw(Prisma.sql`
          UPDATE "driver_events" AS event
          SET "latitude" = restored."latitude", "longitude" = restored."longitude", "payload" = restored."payload"
          FROM (VALUES ${Prisma.join(values)}) AS restored("id", "latitude", "longitude", "payload")
          WHERE event."id" = restored."id"
            AND event."routePlanId" = ${identity.routePlanId}::uuid
            AND event."eventType" = 'LOCATION_UPDATED'::"DriverEventType"
            AND event."latitude" IS NULL AND event."longitude" IS NULL AND event."payload" = 'null'::jsonb
        `);
        if (restored !== candidates.length) throw new Error('Candidate restore count did not match the reviewed set.');
        mutationCount += restored;
      }
      const eligible = await reconcileDerived(tx, identity.routePlanId, window);
      return { mutationCount, preRestoreBackupFile: input.preRestoreBackupFile, remainingEligiblePointCount: eligible.length };
    }, { timeout: REDACTION_TRANSACTION_TIMEOUT_MS });
  }
}

function createBackup(inspection: Inspection): Backup {
  return {
    backupSchemaVersion: 'route_tracking_outside_window_redaction.v1',
    candidateDigest: digestCandidates(inspection.candidates),
    candidates: inspection.candidates,
    capturedAt: new Date().toISOString(),
    currentDerived: inspection.currentDerived,
    currentJob: inspection.currentJob,
    identity: inspection.identity,
    routeStateHash: hashCanonical(inspection.identity),
    window: serializeWindow(inspection.window),
  };
}

async function loadIdentity(prisma: Pick<PrismaClient, 'routePlan'> | Prisma.TransactionClient, args: Pick<Args, 'appId' | 'routePlanId' | 'shopDomain'>): Promise<Identity | null> {
  const route = await prisma.routePlan.findFirst({
    select: { assignmentGeneration: true, driverId: true, id: true, planDate: true, shop: { select: { appId: true, id: true, shopDomain: true } }, status: true },
    where: { id: args.routePlanId, shop: { appId: args.appId, shopDomain: args.shopDomain } },
  });
  return route === null ? null : {
    appId: route.shop.appId, assignmentGeneration: route.assignmentGeneration.toString(), driverId: route.driverId,
    planDate: route.planDate.toISOString().slice(0, 10), routePlanId: route.id, routeStatus: route.status,
    shopDomain: route.shop.shopDomain, shopId: route.shop.id,
  };
}

async function loadCandidates(prisma: Pick<PrismaClient, 'driverEvent'> | Prisma.TransactionClient, routePlanId: string, window: RouteTrackingEventWindow): Promise<Candidate[]> {
  const rows = await prisma.driverEvent.findMany({
    orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    select: { clientEventId: true, createdAt: true, driverId: true, id: true, latitude: true, longitude: true, occurredAt: true, payload: true },
    where: {
      AND: [
        { OR: [{ latitude: { not: null } }, { longitude: { not: null } }] },
        { OR: [{ occurredAt: { lt: window.startInclusive } }, { occurredAt: { gte: window.endExclusive } }] },
      ],
      eventType: 'LOCATION_UPDATED', routePlanId,
    },
  });
  return rows.map((row) => ({
    clientEventId: row.clientEventId, createdAt: row.createdAt.toISOString(), driverId: row.driverId, id: row.id,
    latitude: row.latitude?.toString() ?? null, longitude: row.longitude?.toString() ?? null, occurredAt: row.occurredAt.toISOString(), payload: jsonSafe(row.payload),
  }));
}

async function loadEligiblePositions(prisma: Pick<PrismaClient, 'driverEvent'> | Prisma.TransactionClient, routePlanId: string, window: RouteTrackingEventWindow): Promise<RouteTrackingGeometryPositionInput[]> {
  const rows = await prisma.driverEvent.findMany({
    orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    select: { createdAt: true, driverId: true, id: true, latitude: true, longitude: true, occurredAt: true, payload: true, routePlanId: true },
    where: { eventType: 'LOCATION_UPDATED', latitude: { not: null }, longitude: { not: null }, occurredAt: { gte: window.startInclusive, lt: window.endExclusive }, routePlanId },
  });
  return rows.map((row) => ({
    accuracyMeters: readAccuracy(row.payload), driverId: row.driverId, eventId: row.id,
    latitude: Number(row.latitude), longitude: Number(row.longitude), occurredAt: row.occurredAt.toISOString(),
    receivedAt: row.createdAt.toISOString(), routePlanId: row.routePlanId!,
  })).filter((row) => Number.isFinite(row.latitude) && Number.isFinite(row.longitude));
}

async function reconcileDerived(tx: Prisma.TransactionClient, routePlanId: string, window: RouteTrackingEventWindow): Promise<RouteTrackingGeometryPositionInput[]> {
  const eligible = await loadEligiblePositions(tx, routePlanId, window);
  if (eligible.length === 0) {
    await tx.routeTrackingRoadMatchJob.deleteMany({ where: { routePlanId } });
    await tx.routeTrackingGeometry.deleteMany({ where: { routePlanId } });
    return eligible;
  }
  const document = buildRouteTrackingGeometryDocument(eligible);
  const write = createRouteTrackingGeometryWrite(routePlanId, document);
  const cleared = {
    ...write,
    roadMatchedCoverage: null,
    roadMatchedGeometry: Prisma.JsonNull,
    roadMatchedLastInputOccurredAt: null,
    roadMatchedLastPosition: Prisma.JsonNull,
    roadMatchedPointCount: null,
    roadMatchedSchemaVersion: null,
    roadMatchedSourcePointCount: null,
    roadMatchedUncertainGeometry: Prisma.JsonNull,
    roadMatchedWatermark: null,
  };
  await tx.routeTrackingGeometry.upsert({ create: cleared, update: cleared, where: { routePlanId } });
  const last = document.samples.at(-1)!;
  await enqueueRouteTrackingRoadMatch(tx, {
    lastInputOccurredAt: new Date(last.occurredAt), routePlanId, sourcePointCount: document.sourcePointCount,
  });
  return eligible;
}

type ReviewedRow = {
  clientEventId: string | null;
  createdAt: Date;
  driverId: string | null;
  id: string;
  latitude: unknown;
  longitude: unknown;
  occurredAt: Date;
  payload: unknown;
};

function reviewedRowsMatchTombstones(rows: ReviewedRow[], candidates: Candidate[]): boolean {
  if (rows.length !== candidates.length) return false;
  const byId = new Map(rows.map((row) => [row.id, row]));
  return candidates.every((candidate) => {
    const row = byId.get(candidate.id);
    return row !== undefined
      && row.latitude === null
      && row.longitude === null
      && row.payload === null
      && hashCanonical(serializeReviewedRow(row)) === hashCanonical({
        clientEventId: candidate.clientEventId,
        createdAt: candidate.createdAt,
        driverId: candidate.driverId,
        id: candidate.id,
        occurredAt: candidate.occurredAt,
      });
  });
}

function serializeReviewedRow(row: Pick<ReviewedRow, 'clientEventId' | 'createdAt' | 'driverId' | 'id' | 'occurredAt'>) {
  return {
    clientEventId: row.clientEventId,
    createdAt: row.createdAt.toISOString(),
    driverId: row.driverId,
    id: row.id,
    occurredAt: row.occurredAt.toISOString(),
  };
}

function digestCandidates(candidates: Candidate[]): string { return hashCanonical(candidates); }
function serializeWindow(window: RouteTrackingEventWindow) {
  return {
    anchorSource: window.anchorSource,
    endExclusive: window.endExclusive.toISOString(),
    serviceDate: window.serviceDate,
    startInclusive: window.startInclusive.toISOString(),
    timezone: window.timezone,
  };
}
function assertIdentity(identity: Identity, args: Pick<Args, 'appId' | 'routePlanId' | 'shopDomain'>): void {
  if (identity.appId !== args.appId || identity.routePlanId !== args.routePlanId || identity.shopDomain !== args.shopDomain) throw new Error('Route identity does not match the exact CLI scope.');
}

async function writeExclusivePrivateJson(file: string, value: unknown): Promise<string> {
  const handle = await open(file, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(value)}\n`, { encoding: 'utf8' }); } finally { await handle.close(); }
  await assertPrivateFile(file);
  return sha256(await readFile(file));
}

async function readReviewedBackup(file: string, expectedSha256: string): Promise<Backup> {
  await assertPrivateFile(file);
  const bytes = await readFile(file);
  if (sha256(bytes) !== expectedSha256) throw new Error('Backup SHA-256 does not match the reviewed file.');
  const value = JSON.parse(bytes.toString('utf8')) as Backup;
  if (value.backupSchemaVersion !== 'route_tracking_outside_window_redaction.v1' || !Array.isArray(value.candidates)) throw new Error('Unsupported redaction backup.');
  if (digestCandidates(value.candidates) !== value.candidateDigest) throw new Error('Backup candidate digest is invalid.');
  return value;
}

async function assertPrivateFile(file: string): Promise<void> {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Backup must be a regular non-symlink file.');
  if ((stat.mode & 0o077) !== 0) throw new Error('Backup permissions must not grant group or other access.');
}

function hashCanonical(value: unknown): string { return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }
function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
function jsonSafe(value: unknown): unknown {
  if (value === undefined) return null;
  const serialized = JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint' ? item.toString() : item);
  return JSON.parse(serialized) as unknown;
}
function sha256(value: Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
function isSha256(value: string | undefined): value is string { return value !== undefined && /^[a-f0-9]{64}$/u.test(value); }
function required(values: Map<string, string>, flag: string): string { const value = values.get(flag); if (!value) throw new Error(`Missing required ${flag}`); return value; }
function readAccuracy(payload: unknown): number | null {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const location = record.location !== null && typeof record.location === 'object' && !Array.isArray(record.location) ? record.location as Record<string, unknown> : null;
  const value = record.accuracyMeters ?? record.accuracy ?? location?.accuracyMeters;
  const parsed = Number(value);
  return value === null || value === undefined || value === '' || !Number.isFinite(parsed) || parsed < 0 ? null : parsed;
}

async function main(): Promise<void> {
  const args = parseRouteTrackingOutsideWindowRedactionArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  try { console.log(JSON.stringify(await executeRouteTrackingOutsideWindowRedaction({ args, store: new PrismaRouteTrackingOutsideWindowRedactionStore(prisma) }), null, 2)); }
  finally { await prisma.$disconnect(); }
}

if (process.argv[1]?.endsWith('redact-route-tracking-outside-window.js') || process.argv[1]?.endsWith('redact-route-tracking-outside-window.ts')) {
  main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
