import { chmod, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test, vi } from 'vitest';
import { Prisma } from '@prisma/client';

import {
  executeRouteTrackingOutsideWindowRedaction,
  parseRouteTrackingOutsideWindowRedactionArgs,
  PrismaRouteTrackingOutsideWindowRedactionStore,
  type RouteTrackingOutsideWindowRedactionStore,
} from '../src/scripts/redact-route-tracking-outside-window.js';

const scope = {
  appId: 'clever-route-kfood',
  routePlanId: '00630d18-a4a2-4cc1-8b3b-50a66fc6e2c1',
  shopDomain: 'example.myshopify.com',
};

describe('route tracking outside-window redaction script', () => {
  test('dry-run writes a private complete backup without a database mutation', async () => {
    const store = new MemoryStore();
    const backupFile = await newBackupPath();
    const result = await executeRouteTrackingOutsideWindowRedaction({
      args: dryRunArgs(backupFile), store,
    });

    expect(result).toMatchObject({ candidateCount: 1, mode: 'dry-run', mutationCount: 0, routePlanId: scope.routePlanId });
    expect(store.applyCount).toBe(0);
    const backup = JSON.parse(await readFile(backupFile, 'utf8')) as Record<string, unknown>;
    expect(backup).toMatchObject({
      backupSchemaVersion: 'route_tracking_outside_window_redaction.v1',
      currentDerived: { routePlanId: scope.routePlanId },
      currentJob: { status: 'COMPLETED' },
    });
    expect(JSON.stringify(backup)).toContain('43.6500000');
    expect(JSON.stringify(backup)).toContain('accuracyMeters');
  });

  test('apply requires the reviewed backup SHA and exact candidate digest', async () => {
    const store = new MemoryStore();
    const backupFile = await newBackupPath();
    const dryRun = await executeRouteTrackingOutsideWindowRedaction({ args: dryRunArgs(backupFile), store });
    const backup = dryRun.backup as { sha256: string };
    const apply = applyArgs(backupFile, backup.sha256, String(dryRun.candidateDigest));

    await expect(executeRouteTrackingOutsideWindowRedaction({ args: apply, store }))
      .resolves.toMatchObject({ mode: 'apply', mutationCount: 1, remainingEligiblePointCount: 2 });
    expect(store.applyCount).toBe(1);

    await expect(executeRouteTrackingOutsideWindowRedaction({
      args: applyArgs(backupFile, 'f'.repeat(64), String(dryRun.candidateDigest)), store,
    })).rejects.toThrow('Backup SHA-256');
    await expect(executeRouteTrackingOutsideWindowRedaction({
      args: applyArgs(backupFile, backup.sha256, 'f'.repeat(64)), store,
    })).rejects.toThrow('candidate digest');
  });

  test('safe retry is delegated with the same reviewed backup', async () => {
    const store = new MemoryStore();
    const backupFile = await newBackupPath();
    const dryRun = await executeRouteTrackingOutsideWindowRedaction({ args: dryRunArgs(backupFile), store });
    const backup = dryRun.backup as { sha256: string };
    const args = applyArgs(backupFile, backup.sha256, String(dryRun.candidateDigest));
    await executeRouteTrackingOutsideWindowRedaction({ args, store });
    const repeated = await executeRouteTrackingOutsideWindowRedaction({ args, store });

    expect(repeated).toMatchObject({ mode: 'apply', mutationCount: 0 });
    expect(store.applyCount).toBe(2);
  });

  test('restore requires the reviewed hashes and a private pre-restore backup path', async () => {
    const store = new MemoryStore();
    const backupFile = await newBackupPath();
    const dryRun = await executeRouteTrackingOutsideWindowRedaction({ args: dryRunArgs(backupFile), store });
    const backup = dryRun.backup as { sha256: string };
    const preRestoreBackupFile = await newBackupPath();

    await expect(executeRouteTrackingOutsideWindowRedaction({
      args: restoreArgs(backupFile, backup.sha256, String(dryRun.candidateDigest), preRestoreBackupFile), store,
    })).resolves.toMatchObject({ mode: 'restore', mutationCount: 1, preRestoreBackupFile });
    expect(store.restoreCount).toBe(1);
    expect(() => parseRouteTrackingOutsideWindowRedactionArgs([
      '--app-id', scope.appId, '--shop-domain', scope.shopDomain, '--route-plan-id', scope.routePlanId,
      '--backup-file', backupFile, '--backup-sha256', backup.sha256, '--candidate-digest', String(dryRun.candidateDigest), '--restore',
    ])).toThrow('pre-restore-backup-file');
  });

  test('backup must remain private and exclusive', async () => {
    const store = new MemoryStore();
    const backupFile = await newBackupPath();
    await executeRouteTrackingOutsideWindowRedaction({ args: dryRunArgs(backupFile), store });
    await expect(executeRouteTrackingOutsideWindowRedaction({ args: dryRunArgs(backupFile), store }))
      .rejects.toMatchObject({ code: 'EEXIST' });
    await chmod(backupFile, 0o644);
    const bytes = await readFile(backupFile);
    const sha = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex');
    const parsed = JSON.parse(bytes.toString()) as { candidateDigest: string };
    await expect(executeRouteTrackingOutsideWindowRedaction({ args: applyArgs(backupFile, sha, parsed.candidateDigest), store }))
      .rejects.toThrow('permissions');
  });

  test('production adapter locks in order, scopes redaction, and removes stale derived state on the empty path', async () => {
    const backupFile = await newBackupPath();
    const reviewed = await executeRouteTrackingOutsideWindowRedaction({ args: dryRunArgs(backupFile), store: new MemoryStore() });
    const backup = reviewed.backup as { sha256: string };
    const tx = fakeTransaction({ candidateRows: [candidateDatabaseRow()], eligibleRows: [] });
    const store = new PrismaRouteTrackingOutsideWindowRedactionStore(fakePrisma(tx));

    const result = await executeRouteTrackingOutsideWindowRedaction({
      args: applyArgs(backupFile, backup.sha256, String(reviewed.candidateDigest)), store,
    });

    expect(result).toMatchObject({ mode: 'apply', mutationCount: 1, remainingEligiblePointCount: 0 });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(sqlText(tx.$queryRaw.mock.calls[0]![0])).toContain('FOR UPDATE');
    expect(sqlText(tx.$queryRaw.mock.calls[1]![0])).toContain('pg_advisory_xact_lock');
    const updateInput = tx.driverEvent.updateMany.mock.calls[0]?.[0] as { where?: unknown } | undefined;
    expect(updateInput?.where).toMatchObject({ eventType: 'LOCATION_UPDATED', routePlanId: scope.routePlanId });
    expect((tx.driverEvent.updateMany.mock.calls[0]?.[0] as { data?: { payload?: unknown } } | undefined)?.data?.payload)
      .toBe(Prisma.JsonNull);
    expect(tx.routeTrackingGeometry.deleteMany).toHaveBeenCalledWith({ where: { routePlanId: scope.routePlanId } });
    expect(tx.routeTrackingRoadMatchJob.deleteMany).toHaveBeenCalledWith({ where: { routePlanId: scope.routePlanId } });
  });

  test('production adapter repeat apply repairs stale derived state and restore verifies tombstones before scoped restore', async () => {
    const backupFile = await newBackupPath();
    const reviewed = await executeRouteTrackingOutsideWindowRedaction({ args: dryRunArgs(backupFile), store: new MemoryStore() });
    const backup = reviewed.backup as { sha256: string };
    const eligibleRows = [eligibleDatabaseRow(1), eligibleDatabaseRow(2)];
    const repeatTx = fakeTransaction({ candidateRows: [], reviewedRows: [tombstoneDatabaseRow()], eligibleRows });
    const repeatStore = new PrismaRouteTrackingOutsideWindowRedactionStore(fakePrisma(repeatTx));

    await expect(executeRouteTrackingOutsideWindowRedaction({
      args: applyArgs(backupFile, backup.sha256, String(reviewed.candidateDigest)), store: repeatStore,
    })).resolves.toMatchObject({ mode: 'apply', mutationCount: 0, remainingEligiblePointCount: 2 });
    expect(repeatTx.driverEvent.updateMany).not.toHaveBeenCalled();
    const upsertInput = repeatTx.routeTrackingGeometry.upsert.mock.calls[0]?.[0] as { update?: unknown } | undefined;
    expect(upsertInput?.update).toMatchObject({ roadMatchedWatermark: null });
    expect(upsertInput?.update).toHaveProperty('roadMatchedGeometry');
    expect(repeatTx.routeTrackingRoadMatchJob.create).toHaveBeenCalledOnce();

    const preRestoreBackupFile = await newBackupPath();
    const restoreTx = fakeTransaction({ candidateRows: [], reviewedRows: [tombstoneDatabaseRow()], eligibleRows: [] });
    restoreTx.driverEvent.findMany.mockReset()
      .mockResolvedValueOnce([tombstoneDatabaseRow()])
      .mockResolvedValueOnce([]);
    restoreTx.$executeRaw.mockResolvedValueOnce(1);
    const restoreStore = new PrismaRouteTrackingOutsideWindowRedactionStore(fakePrisma(restoreTx));
    await expect(executeRouteTrackingOutsideWindowRedaction({
      args: restoreArgs(backupFile, backup.sha256, String(reviewed.candidateDigest), preRestoreBackupFile), store: restoreStore,
    })).resolves.toMatchObject({ mode: 'restore', mutationCount: 1, preRestoreBackupFile });
    expect(sqlText(restoreTx.$executeRaw.mock.calls[0]![0])).toContain('LOCATION_UPDATED');
    expect(sqlText(restoreTx.$executeRaw.mock.calls[0]![0])).toContain('routePlanId');
    expect(sqlText(restoreTx.$executeRaw.mock.calls[0]![0])).toContain('"payload" = \'null\'::jsonb');
    expect(JSON.parse(await readFile(preRestoreBackupFile, 'utf8'))).toMatchObject({
      backupSchemaVersion: 'route_tracking_outside_window_pre_restore.v1',
    });
  });

  test('production adapter aborts on changed candidate CAS before mutation', async () => {
    const backupFile = await newBackupPath();
    const reviewed = await executeRouteTrackingOutsideWindowRedaction({ args: dryRunArgs(backupFile), store: new MemoryStore() });
    const backup = reviewed.backup as { sha256: string };
    const changed = { ...candidateDatabaseRow(), longitude: '-79.3900000' };
    const tx = fakeTransaction({ candidateRows: [changed], eligibleRows: [] });
    const store = new PrismaRouteTrackingOutsideWindowRedactionStore(fakePrisma(tx));

    await expect(executeRouteTrackingOutsideWindowRedaction({
      args: applyArgs(backupFile, backup.sha256, String(reviewed.candidateDigest)), store,
    })).rejects.toThrow('candidate set changed');
    expect(tx.driverEvent.updateMany).not.toHaveBeenCalled();
    expect(tx.routeTrackingGeometry.deleteMany).not.toHaveBeenCalled();
  });

  test('restore aborts before backup or mutation when retained tombstone metadata changed', async () => {
    const backupFile = await newBackupPath();
    const reviewed = await executeRouteTrackingOutsideWindowRedaction({ args: dryRunArgs(backupFile), store: new MemoryStore() });
    const backup = reviewed.backup as { sha256: string };
    const preRestoreBackupFile = await newBackupPath();
    const tx = fakeTransaction({ candidateRows: [], eligibleRows: [] });
    tx.driverEvent.findMany.mockReset().mockResolvedValueOnce([{
      ...tombstoneDatabaseRow(), clientEventId: 'changed-after-review',
    }]);
    const store = new PrismaRouteTrackingOutsideWindowRedactionStore(fakePrisma(tx));

    await expect(executeRouteTrackingOutsideWindowRedaction({
      args: restoreArgs(backupFile, backup.sha256, String(reviewed.candidateDigest), preRestoreBackupFile), store,
    })).rejects.toThrow('unchanged tombstones');
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    await expect(readFile(preRestoreBackupFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

class MemoryStore implements RouteTrackingOutsideWindowRedactionStore {
  applyCount = 0;
  restoreCount = 0;
  private applied = false;

  inspect() {
    return Promise.resolve({
      candidates: [{
        clientEventId: 'late-gps-1', createdAt: '2026-09-28T08:26:36.000Z', driverId: '22222222-2222-4222-8222-222222222222', id: '11111111-1111-4111-8111-111111111111',
        latitude: '43.6500000', longitude: '-79.3800000', occurredAt: '2026-09-28T08:26:35.625Z', payload: { accuracyMeters: 5 },
      }],
      currentDerived: { routePlanId: scope.routePlanId }, currentJob: { status: 'COMPLETED' },
      identity: { ...scope, assignmentGeneration: '1', driverId: '22222222-2222-4222-8222-222222222222', planDate: '2026-09-17', routeStatus: 'IN_PROGRESS', shopId: '33333333-3333-4333-8333-333333333333' },
      window: {
        anchorSource: 'PLAN_DATE' as const, serviceDate: '2026-09-17', startInclusive: new Date('2026-09-17T04:00:00.000Z'),
        endExclusive: new Date('2026-09-19T04:00:00.000Z'), timezone: 'America/Toronto',
      },
    });
  }

  apply() {
    this.applyCount += 1;
    if (this.applied) return Promise.resolve({ mutationCount: 0, remainingEligiblePointCount: 2 });
    this.applied = true;
    return Promise.resolve({ mutationCount: 1, remainingEligiblePointCount: 2 });
  }

  restore(input: Parameters<RouteTrackingOutsideWindowRedactionStore['restore']>[0]) {
    this.restoreCount += 1;
    return Promise.resolve({ mutationCount: 1, preRestoreBackupFile: input.preRestoreBackupFile, remainingEligiblePointCount: 2 });
  }
}

function dryRunArgs(backupFile: string) {
  return parseRouteTrackingOutsideWindowRedactionArgs([
    '--app-id', scope.appId, '--shop-domain', scope.shopDomain, '--route-plan-id', scope.routePlanId, '--backup-file', backupFile,
  ]);
}

function applyArgs(backupFile: string, sha: string, digest: string) {
  return parseRouteTrackingOutsideWindowRedactionArgs([
    '--app-id', scope.appId, '--shop-domain', scope.shopDomain, '--route-plan-id', scope.routePlanId,
    '--backup-file', backupFile, '--backup-sha256', sha, '--candidate-digest', digest, '--apply',
  ]);
}

function restoreArgs(backupFile: string, sha: string, digest: string, preRestoreBackupFile: string) {
  return parseRouteTrackingOutsideWindowRedactionArgs([
    '--app-id', scope.appId, '--shop-domain', scope.shopDomain, '--route-plan-id', scope.routePlanId,
    '--backup-file', backupFile, '--backup-sha256', sha, '--candidate-digest', digest,
    '--pre-restore-backup-file', preRestoreBackupFile, '--restore',
  ]);
}

async function newBackupPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'tracking-redaction-')), 'backup.json');
}

function candidateDatabaseRow() {
  return {
    clientEventId: 'late-gps-1', createdAt: new Date('2026-09-28T08:26:36.000Z'), driverId: '22222222-2222-4222-8222-222222222222',
    id: '11111111-1111-4111-8111-111111111111', latitude: '43.6500000', longitude: '-79.3800000',
    occurredAt: new Date('2026-09-28T08:26:35.625Z'), payload: { accuracyMeters: 5 }, routePlanId: scope.routePlanId,
  };
}

function tombstoneDatabaseRow() {
  return { ...candidateDatabaseRow(), latitude: null, longitude: null, payload: null };
}

function eligibleDatabaseRow(index: number) {
  return {
    ...candidateDatabaseRow(), id: `44444444-4444-4444-8444-44444444444${index}`,
    latitude: `43.650000${index}`, longitude: `-79.380000${index}`,
    occurredAt: new Date(`2026-09-17T13:00:0${index}.000Z`), createdAt: new Date(`2026-09-17T13:00:0${index}.100Z`),
  };
}

function fakeTransaction(input: { candidateRows: ReturnType<typeof candidateDatabaseRow>[]; eligibleRows: ReturnType<typeof eligibleDatabaseRow>[]; reviewedRows?: ReturnType<typeof tombstoneDatabaseRow>[] }) {
  const findMany = vi.fn()
    .mockResolvedValueOnce(input.candidateRows);
  if (input.reviewedRows !== undefined) findMany.mockResolvedValueOnce(input.reviewedRows);
  findMany.mockResolvedValueOnce(input.eligibleRows);
  return {
    $executeRaw: vi.fn(),
    $queryRaw: vi.fn().mockResolvedValue([]),
    driverEvent: {
      findFirst: vi.fn().mockResolvedValue(null), findMany, updateMany: vi.fn().mockResolvedValue({ count: input.candidateRows.length }),
    },
    routePlan: {
      findFirst: vi.fn().mockResolvedValue({
        assignmentGeneration: 1n, driverId: '22222222-2222-4222-8222-222222222222', id: scope.routePlanId,
        planDate: new Date('2026-09-17T00:00:00.000Z'), shop: { appId: scope.appId, id: '33333333-3333-4333-8333-333333333333', shopDomain: scope.shopDomain }, status: 'IN_PROGRESS',
      }),
      findUnique: vi.fn().mockResolvedValue({
        constraints: { scheduledStartTimeZone: 'America/Toronto' }, planDate: new Date('2026-09-17T00:00:00.000Z'),
        shopId: '33333333-3333-4333-8333-333333333333',
      }),
    },
    routeTrackingGeometry: {
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }), findUnique: vi.fn().mockResolvedValue({ routePlanId: scope.routePlanId }),
      upsert: vi.fn().mockResolvedValue({}),
    },
    routeTrackingRoadMatchJob: {
      create: vi.fn().mockResolvedValue({}), deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUnique: vi.fn().mockResolvedValue(null), update: vi.fn().mockResolvedValue({}),
    },
  };
}

function fakePrisma(tx: ReturnType<typeof fakeTransaction>) {
  return {
    $transaction: vi.fn((callback: (transaction: never) => unknown, options?: { timeout?: number }) => {
      void options;
      return callback(tx as never);
    }),
  } as never;
}

function sqlText(value: unknown): string {
  if (value === null || typeof value !== 'object') return String(value);
  const strings = (value as { strings?: string[] }).strings;
  return Array.isArray(strings) ? strings.join('?') : '[sql]';
}
