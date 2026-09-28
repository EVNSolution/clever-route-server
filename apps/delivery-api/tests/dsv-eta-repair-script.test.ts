import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { PrismaClient } from '@prisma/client';
import { afterEach, describe, expect, test } from 'vitest';

import { DsvEtaRepairRefusal, type DsvEtaRepairPlan } from '../src/modules/dsv/dsv-eta-repair.js';
import { parseDsvEtaRepairFlags, verifyBackupEvidence, verifyRuntimeRevision } from '../src/scripts/repair-dsv-route-eta.js';

const revision = 'a'.repeat(40);
const planSha256 = 'b'.repeat(64);
const routePlanId = 'afbbb523-4f57-4d83-8f1f-a54e3c6a7f7d';
const shopId = '95375ce2-8a45-43d0-a7f0-b3de2a74191c';
const systemIdentifier = '7644013342647144485';
const generatedAt = '2026-09-28T06:00:00.000Z';
const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

function sha(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

async function backupFixture(input: { invalidHeader?: boolean; wrongCluster?: boolean } = {}) {
  const directory = await mkdtemp('/tmp/dsv-eta-repair-');
  directories.push(directory);
  const backupFile = join(directory, 'backup.dump');
  const backupManifest = join(directory, 'manifest.json');
  const recoveryPlanFile = join(directory, 'recovery.json');
  const bytes = Buffer.alloc(2048);
  bytes.write(input.invalidHeader ? 'NOPE!' : 'PGDMP');
  const backupSha256 = sha(bytes);
  const listing = `;     dbname: clever\n${[
    'route_plans', 'route_plan_stops', 'route_plan_geometry_caches', 'driver_events'
  ].map((table, index) => `${index + 1}; 0 0 TABLE DATA public ${table} clever`).join('\n')}\n`;
  const recoveryText = JSON.stringify({
    backupSha256, database: 'clever', disposableDatabase: 'clever_dsv_eta_recovery_test',
    planSha256, routePlanIds: [routePlanId], schema: 'dsv_eta_scoped_recovery_v1',
    steps: ['RESTORE_TO_DISPOSABLE_DATABASE', 'VERIFY_TARGET_BASELINE', 'CAS_COMPENSATE_ETA_AND_CACHE', 'AUDIT_UNCHANGED_OPERATIONS'],
    systemIdentifier
  });
  await writeFile(backupFile, bytes);
  await writeFile(recoveryPlanFile, recoveryText);
  await writeFile(backupManifest, JSON.stringify({
    backupBytes: bytes.length, backupListingSha256: sha(listing), backupSha256,
    createdAt: '2026-09-28T06:01:00.000Z', database: 'clever',
    planSha256, recoveryPlanSha256: sha(recoveryText), routePlanIds: [routePlanId],
    runtimeRevision: revision, schema: 'dsv_eta_host_backup_v1', shopId, systemIdentifier
  }));
  const flags = parseDsvEtaRepairFlags([
    '--apply', '--backup-file', backupFile,
    '--backup-manifest', backupManifest, '--cluster-system-identifier', systemIdentifier,
    '--expected-stop-count', '1', '--plan-file', '/tmp/reviewed-plan.json',
    '--planned-start', `${routePlanId}=2026-08-31T22:30:00.000Z`,
    '--recovery-plan-file', recoveryPlanFile, '--reviewed-plan-sha256', planSha256,
    '--route-plan-id', routePlanId, '--runtime-revision', revision,
    '--shop-domain', 'dsv-demo.local', '--shop-id', shopId
  ]);
  let query = 0;
  const prisma = {
    $queryRaw: () => Promise.resolve(++query === 1
      ? [{ database: 'clever' }]
      : [{ systemIdentifier: input.wrongCluster ? '1234567890123456789' : systemIdentifier }])
  } as unknown as PrismaClient;
  return { flags, prisma };
}

describe('DSV ETA repair operator gates', () => {
  test('binds every mode to the immutable runtime image revision', async () => {
    const directory = await mkdtemp('/tmp/dsv-eta-revision-');
    directories.push(directory);
    const path = join(directory, 'build-revision');
    await writeFile(path, `${revision}\n`);
    await expect(verifyRuntimeRevision(revision, path)).resolves.toBe(revision);
    await expect(verifyRuntimeRevision('c'.repeat(40), path)).rejects.toThrowError(new DsvEtaRepairRefusal('RUNTIME_REVISION_MISMATCH'));
  });

  test.each([
    { invalidHeader: true, wrongCluster: false, code: 'HOST_BACKUP_ARCHIVE_INVALID' },
    { invalidHeader: false, wrongCluster: false, code: 'HOST_BACKUP_ARCHIVE_INVALID' },
    { invalidHeader: false, wrongCluster: true, code: 'HOST_BACKUP_EVIDENCE_MISMATCH' }
  ])('rejects invalid host backup evidence before apply: %j', async ({ code, ...input }) => {
    const { flags, prisma } = await backupFixture(input);
    await expect(verifyBackupEvidence(prisma, flags, planSha256, {
      generatedAt, routes: [], schema: 'dsv_eta_missing_duration_repair_v1'
    } as unknown as DsvEtaRepairPlan))
      .rejects.toThrowError(new DsvEtaRepairRefusal(code));
  });
});
