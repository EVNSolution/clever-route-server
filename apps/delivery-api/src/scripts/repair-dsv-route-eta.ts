import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { open, readFile, stat, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import { PrismaClient } from '@prisma/client';

import {
  auditDsvEtaRepairPlan,
  applyDsvEtaRepairPlan,
  createDsvEtaRepairPlan,
  DsvEtaRepairRefusal,
  type DsvEtaRepairPlan
} from '../modules/dsv/dsv-eta-repair.js';
import { OsrmRouteGeometryProvider } from '../modules/route-plans/osrm-route-geometry.client.js';

type Flags = {
  apply: boolean;
  audit: boolean;
  backupFile?: string;
  backupManifest?: string;
  clusterSystemIdentifier?: string;
  expectedStopCount?: number;
  planFile?: string;
  plannedStarts: Record<string, string>;
  recoveryPlanFile?: string;
  reviewedPlanSha256?: string;
  routePlanIds: string[];
  runtimeRevision?: string;
  shopDomain?: string;
  shopId?: string;
};

export function parseDsvEtaRepairFlags(argv: string[]): Flags {
  const flags: Flags = { apply: false, audit: false, plannedStarts: {}, routePlanIds: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--apply') { flags.apply = true; continue; }
    if (key === '--audit') { flags.audit = true; continue; }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
    index += 1;
    switch (key) {
      case '--backup-file': flags.backupFile = value; break;
      case '--backup-manifest': flags.backupManifest = value; break;
      case '--cluster-system-identifier': flags.clusterSystemIdentifier = value; break;
      case '--expected-stop-count': flags.expectedStopCount = Number(value); break;
      case '--plan-file': flags.planFile = value; break;
      case '--planned-start': {
        const separator = value.indexOf('=');
        if (separator < 1) throw new Error('--planned-start must be route-id=ISO-instant');
        const id = value.slice(0, separator);
        if (flags.plannedStarts[id] !== undefined) throw new Error('Duplicate --planned-start route ID');
        flags.plannedStarts[id] = value.slice(separator + 1);
        break;
      }
      case '--recovery-plan-file': flags.recoveryPlanFile = value; break;
      case '--reviewed-plan-sha256': flags.reviewedPlanSha256 = value; break;
      case '--route-plan-id': flags.routePlanIds.push(value); break;
      case '--runtime-revision': flags.runtimeRevision = value; break;
      case '--shop-domain': flags.shopDomain = value; break;
      case '--shop-id': flags.shopId = value; break;
      default: throw new Error(`Unknown flag: ${key}`);
    }
  }
  if (!flags.planFile?.startsWith('/tmp/')) throw new Error('--plan-file must be an absolute /tmp path inside the API container');
  if (!flags.shopDomain || !flags.shopId || flags.routePlanIds.length === 0
    || new Set(flags.routePlanIds).size !== flags.routePlanIds.length
    || Object.keys(flags.plannedStarts).length !== flags.routePlanIds.length
    || flags.routePlanIds.some((id) => flags.plannedStarts[id] === undefined)
    || !/^[a-f0-9]{40}$/u.test(flags.runtimeRevision ?? '')
    || !Number.isSafeInteger(flags.expectedStopCount) || (flags.expectedStopCount ?? 0) < 1) {
    throw new Error('Exact shop, unique route IDs, reviewed starts, runtime revision, and positive stop count are required');
  }
  if (flags.apply && flags.audit) throw new Error('--apply and --audit are mutually exclusive');
  if (flags.apply) {
    if (!isSha(flags.reviewedPlanSha256)
      || !flags.backupFile?.startsWith('/tmp/')
      || !flags.backupManifest?.startsWith('/tmp/')
      || !flags.recoveryPlanFile?.startsWith('/tmp/')
      || !/^\d{12,24}$/u.test(flags.clusterSystemIdentifier ?? '')) {
      throw new Error('Apply requires reviewed plan SHA, host backup, cluster identity, manifest, and recovery plan');
    }
  } else if (flags.audit) {
    if (!isSha(flags.reviewedPlanSha256)) throw new Error('Audit requires reviewed plan SHA');
  } else if (flags.reviewedPlanSha256 !== undefined) {
    throw new Error('Reviewed plan SHA requires --apply or --audit');
  }
  if (!flags.apply && (flags.backupFile !== undefined
    || flags.backupManifest !== undefined || flags.clusterSystemIdentifier !== undefined || flags.recoveryPlanFile !== undefined)) {
    throw new Error('Backup evidence flags require --apply');
  }
  return flags;
}

async function main(): Promise<void> {
  const flags = parseDsvEtaRepairFlags(process.argv.slice(2));
  const imageRevision = await verifyRuntimeRevision(flags.runtimeRevision!);
  const prisma = new PrismaClient();
  try {
    const scope = {
      plannedStarts: Object.fromEntries(Object.entries(flags.plannedStarts).sort(([left], [right]) => left.localeCompare(right))),
      routePlanIds: [...flags.routePlanIds].sort(), shopDomain: flags.shopDomain!, shopId: flags.shopId!
    };
    if (flags.apply || flags.audit) {
      const data = await readFile(flags.planFile!, 'utf8');
      const plan = JSON.parse(data) as DsvEtaRepairPlan;
      const planSha256 = sha(data);
      if (planSha256 !== flags.reviewedPlanSha256 || JSON.stringify(plan.scope) !== JSON.stringify(scope)
        || plan.sourceRevision !== imageRevision
        || plan.routes.reduce((sum, route) => sum + route.stops.length, 0) !== flags.expectedStopCount) {
        throw new DsvEtaRepairRefusal('REVIEWED_PLAN_MISMATCH');
      }
      if (flags.audit) {
        const result = await auditDsvEtaRepairPlan(prisma, plan);
        process.stdout.write(`${JSON.stringify({ ...result, mode: 'audit', planSha256, runtimeRevision: imageRevision })}\n`);
        return;
      }
      const backup = await verifyBackupEvidence(prisma, flags, planSha256, plan.generatedAt);
      const result = await applyDsvEtaRepairPlan(prisma, plan);
      process.stdout.write(`${JSON.stringify({ ...result, backupSha256: backup.backupSha256, mode: 'apply', planSha256, runtimeRevision: imageRevision })}\n`);
      return;
    }
    const baseUrl = process.env.OSRM_KOREA_BASE_URL;
    if (!baseUrl) throw new DsvEtaRepairRefusal('KOREA_OSRM_UNAVAILABLE');
    const plan = await createDsvEtaRepairPlan(prisma, new OsrmRouteGeometryProvider({ baseUrl, timeoutMs: 60_000 }), scope, imageRevision);
    const stopCount = plan.routes.reduce((sum, route) => sum + route.stops.length, 0);
    if (stopCount !== flags.expectedStopCount) throw new DsvEtaRepairRefusal('EXPECTED_STOP_COUNT_MISMATCH');
    const data = JSON.stringify(plan);
    await writeFile(flags.planFile!, data, { flag: 'wx', mode: 0o600 });
    process.stdout.write(`${JSON.stringify({
      mode: 'dry-run', mutationCount: 0, planFile: flags.planFile, planSha256: sha(data), runtimeRevision: imageRevision,
      routes: plan.routes.map((route) => ({
        routePlanId: route.routePlanId,
        status: route.status,
        plannedStartAt: route.plannedStartAt,
        plannedStartSource: route.plannedStartSource,
        stopCount: route.stops.length,
        plannedEtaCount: route.stops.filter((stop) => stop.etaSource === 'DSV_ETA_REPAIR_PLANNED').length,
        eventReplayEtaCount: route.stops.filter((stop) => stop.etaSource === 'DSV_ETA_REPAIR_EVENT_REPLAY').length
      })), stopCount
    })}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

export async function verifyRuntimeRevision(expectedRevision: string, path = '/app/build-revision'): Promise<string> {
  const imageRevision = (await readFile(path, 'utf8')).trim();
  if (!/^[a-f0-9]{40}$/u.test(imageRevision) || imageRevision !== expectedRevision) {
    throw new DsvEtaRepairRefusal('RUNTIME_REVISION_MISMATCH');
  }
  return imageRevision;
}

type BackupManifest = {
  backupBytes: number;
  backupListingSha256: string;
  backupSha256: string;
  createdAt: string;
  database: string;
  planSha256: string;
  recoveryPlanSha256: string;
  routePlanIds: string[];
  runtimeRevision: string;
  schema: string;
  shopId: string;
  systemIdentifier: string;
};

const execFileAsync = promisify(execFile);

type RecoveryPlan = {
  backupSha256: string;
  database: string;
  disposableDatabase: string;
  planSha256: string;
  routePlanIds: string[];
  schema: 'dsv_eta_scoped_recovery_v1';
  steps: ['RESTORE_TO_DISPOSABLE_DATABASE', 'VERIFY_TARGET_BASELINE', 'CAS_COMPENSATE_ETA_AND_CACHE', 'AUDIT_UNCHANGED_OPERATIONS'];
  systemIdentifier: string;
};

export async function verifyBackupEvidence(
  prisma: PrismaClient,
  flags: Flags,
  planSha256: string,
  planGeneratedAt: string
): Promise<BackupManifest> {
  const manifest = JSON.parse(await readFile(flags.backupManifest!, 'utf8')) as BackupManifest;
  const createdAt = Date.parse(manifest.createdAt);
  const database = await prisma.$queryRaw<Array<{ database: string }>>`SELECT current_database() AS database`;
  const cluster = await prisma.$queryRaw<Array<{ systemIdentifier: string }>>`
    SELECT system_identifier::text AS "systemIdentifier" FROM pg_control_system()
  `;
  const recoveryText = await readFile(flags.recoveryPlanFile!, 'utf8');
  const recovery = JSON.parse(recoveryText) as RecoveryPlan;
  const header = Buffer.alloc(5);
  const archive = await open(flags.backupFile!, 'r');
  try { await archive.read(header, 0, 5, 0); } finally { await archive.close(); }
  if (header.toString('ascii') !== 'PGDMP') throw new DsvEtaRepairRefusal('HOST_BACKUP_ARCHIVE_INVALID');
  if (manifest.schema !== 'dsv_eta_host_backup_v1'
    || !isSha(manifest.backupSha256)
    || !isSha(manifest.backupListingSha256)
    || !isSha(manifest.recoveryPlanSha256)
    || !Number.isSafeInteger(manifest.backupBytes) || manifest.backupBytes < 1024
    || !Number.isFinite(createdAt) || createdAt < Date.parse(planGeneratedAt) || createdAt > Date.now()
    || manifest.database !== database[0]?.database
    || manifest.systemIdentifier !== cluster[0]?.systemIdentifier
    || manifest.systemIdentifier !== flags.clusterSystemIdentifier
    || manifest.planSha256 !== planSha256
    || manifest.runtimeRevision !== flags.runtimeRevision
    || manifest.shopId !== flags.shopId
    || JSON.stringify(manifest.routePlanIds) !== JSON.stringify([...flags.routePlanIds].sort())
    || manifest.recoveryPlanSha256 !== sha(recoveryText)
    || recovery.schema !== 'dsv_eta_scoped_recovery_v1'
    || recovery.backupSha256 !== manifest.backupSha256
    || recovery.database !== manifest.database
    || recovery.systemIdentifier !== manifest.systemIdentifier
    || recovery.planSha256 !== planSha256
    || JSON.stringify(recovery.routePlanIds) !== JSON.stringify(manifest.routePlanIds)
    || !/^clever_dsv_eta_recovery_[a-z0-9_]{4,40}$/u.test(recovery.disposableDatabase)
    || JSON.stringify(recovery.steps) !== JSON.stringify([
      'RESTORE_TO_DISPOSABLE_DATABASE', 'VERIFY_TARGET_BASELINE', 'CAS_COMPENSATE_ETA_AND_CACHE', 'AUDIT_UNCHANGED_OPERATIONS'
    ])
    || (await stat(flags.backupFile!)).size !== manifest.backupBytes
    || await shaFile(flags.backupFile!) !== manifest.backupSha256) {
    throw new DsvEtaRepairRefusal('HOST_BACKUP_EVIDENCE_MISMATCH');
  }
  let listing: string;
  try {
    listing = (await execFileAsync('pg_restore', ['--list', flags.backupFile!], {
      maxBuffer: 16 * 1024 * 1024, timeout: 60_000
    })).stdout;
  } catch {
    throw new DsvEtaRepairRefusal('HOST_BACKUP_ARCHIVE_INVALID');
  }
  if (manifest.backupListingSha256 !== sha(listing)
    || !listing.includes(`;     dbname: ${manifest.database}\n`)
    || !['route_plans', 'route_plan_stops', 'route_plan_geometry_caches', 'driver_events']
      .every((table) => new RegExp(`^\\d+; .* TABLE DATA public ${table} `, 'mu').test(listing))) {
    throw new DsvEtaRepairRefusal('HOST_BACKUP_ARCHIVE_INVALID');
  }
  return manifest;
}

async function shaFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function isSha(value: string | undefined): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

if (process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], 'file:').href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify({
      errorCode: error instanceof DsvEtaRepairRefusal ? error.code : 'DSV_ETA_REPAIR_FAILED',
      errorName: error instanceof Error ? error.name : 'UnknownError'
    })}\n`);
    process.exitCode = 2;
  });
}
