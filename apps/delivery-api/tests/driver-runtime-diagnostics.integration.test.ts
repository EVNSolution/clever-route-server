import { createHash } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { describe, expect, test } from 'vitest';

import type { DriverDiagnosticEnvelope, DriverDiagnosticSnapshot } from '../src/modules/driver/driver-runtime-diagnostics.contract.js';
import {
  PrismaDriverRuntimeDiagnosticsRepository,
} from '../src/modules/driver/driver-runtime-diagnostics.repository.js';

const databaseUrl = process.env.DRIVER_RUNTIME_DIAGNOSTICS_DATABASE_URL ?? '';
const targetClass = process.env.DRIVER_RUNTIME_DIAGNOSTICS_DATABASE_TARGET_CLASS ?? '';
const live = databaseUrl === '' ? test.skip : test;

const shopA = 'a1000000-0000-4000-8000-000000000001';
const shopB = 'a1000000-0000-4000-8000-000000000002';
const accountA = 'a2000000-0000-4000-8000-000000000001';
const accountB = 'a2000000-0000-4000-8000-000000000002';
const driverA = 'a3000000-0000-4000-8000-000000000001';
const driverB = 'a3000000-0000-4000-8000-000000000002';
const driverC = 'a3000000-0000-4000-8000-000000000003';
const routeA = 'a4000000-0000-4000-8000-000000000001';
const routeB = 'a4000000-0000-4000-8000-000000000002';
const routeC = 'a4000000-0000-4000-8000-000000000003';
const deviceHash = 'a'.repeat(64);

describe('driver runtime diagnostics PostgreSQL contract', () => {
  live('enforces credential, tenant, replay, ordering, idempotency, rollback, and retention invariants', async () => {
    assertDisposableDatabase();
    const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    let now = new Date('2026-10-02T10:00:00.000Z');
    let nextToken = 'A'.repeat(43);
    const repository = new PrismaDriverRuntimeDiagnosticsRepository(prisma, {
      now: () => now,
      token: () => nextToken,
    });

    try {
      await cleanup(prisma);
      await seed(prisma);

      await expect(repository.register({
        accountId: accountA,
        deviceInstanceHash: deviceHash,
        tokenVersion: 9,
      })).resolves.toBeNull();
      const registration = await repository.register({
        accountId: accountA,
        deviceInstanceHash: deviceHash,
        tokenVersion: 3,
      });
      expect(registration).toEqual({
        expiresAt: new Date('2026-10-03T10:00:00.000Z'),
        token: nextToken,
      });
      if (registration === null) throw new Error('Expected diagnostic registration');
      expect(await prisma.driverRuntimeDiagnosticCredential.findFirstOrThrow({
        select: { tokenHash: true },
      })).toEqual({ tokenHash: createHash('sha256').update(nextToken).digest('hex') });
      expect(JSON.stringify(await prisma.driverRuntimeDiagnosticCredential.findMany())).not.toContain(nextToken);

      const credential = await repository.authenticate(registration.token);
      if (credential === null) throw new Error('Expected credential authentication');
      await repository.recordContact(credential);

      const initial = envelope({
        batchId: 'b1000000-0000-4000-8000-000000000001',
        diagnosticId: 'd1000000-0000-4000-8000-000000000001',
        observedAt: '2026-10-02T10:00:00.000Z',
        routePlanId: routeA,
      });
      const concurrent = await Promise.all([
        repository.ingest(credential, initial),
        repository.ingest(credential, initial),
      ]);
      expect(concurrent.map((result) => result.acceptedDiagnosticIds)).toEqual([
        ['d1000000-0000-4000-8000-000000000001'],
        ['d1000000-0000-4000-8000-000000000001'],
      ]);
      expect(await prisma.driverRuntimeDiagnosticRecord.count({ where: { deviceId: credential.deviceId } })).toBe(1);

      now = new Date('2026-10-02T10:00:03.000Z');
      const otherTenantScope = envelope({
        batchId: 'b1000000-0000-4000-8000-000000000010',
        bootId: 'c1000000-0000-4000-8000-000000000010',
        diagnosticId: 'd1000000-0000-4000-8000-000000000010',
        observedAt: '2026-10-02T10:00:03.000Z',
        routePlanId: routeC,
        sessionGeneration: '10',
      });
      await repository.ingest(credential, otherTenantScope);
      await repository.recordFailure(credential, 'INVALID_ENVELOPE');
      expect(await prisma.driverRuntimeDiagnosticSnapshot.findMany({
        select: { lastIngestionFailureCode: true, routePlanId: true },
        where: { deviceId: credential.deviceId },
      })).toEqual(expect.arrayContaining([
        { lastIngestionFailureCode: null, routePlanId: routeA },
        { lastIngestionFailureCode: null, routePlanId: routeC },
      ]));
      await repository.recordFailure(credential, 'INVALID_RECORD', initial);
      expect(await prisma.driverRuntimeDiagnosticSnapshot.findFirstOrThrow({
        select: { lastIngestionFailureCode: true },
        where: { deviceId: credential.deviceId, routePlanId: routeA, sessionGeneration: '1' },
      })).toEqual({ lastIngestionFailureCode: 'INVALID_RECORD' });
      expect(await prisma.driverRuntimeDiagnosticSnapshot.findFirstOrThrow({
        select: { lastIngestionFailureCode: true },
        where: { deviceId: credential.deviceId, routePlanId: routeC },
      })).toEqual({ lastIngestionFailureCode: null });

      await prisma.driverRuntimeDiagnosticSnapshot.deleteMany({
        where: { deviceId: credential.deviceId, routePlanId: routeC },
      });
      now = new Date('2026-10-02T10:00:04.000Z');
      await repository.ingest(credential, envelope({
        batchId: 'b1000000-0000-4000-8000-000000000020',
        bootId: 'c1000000-0000-4000-8000-000000000020',
        diagnosticId: 'd1000000-0000-4000-8000-000000000020',
        liveObservedAt: '2026-10-02T10:10:04.000Z',
        observedAt: '2026-10-02T10:00:04.000Z',
        routePlanId: routeC,
        sessionGeneration: '20',
      }));
      expect((await repository.listForShop({ appId: 'clever', shopDomain: 'tenant-b.test' }))?.devices[0])
        .toMatchObject({
          lastIngestionFailureAt: new Date('2026-10-02T10:00:04.000Z'),
          lastIngestionFailureCode: 'FUTURE_SNAPSHOT',
        });

      const conflicting = envelope({
        batchId: 'b1000000-0000-4000-8000-000000000002',
        diagnosticId: 'd1000000-0000-4000-8000-000000000001',
        observedAt: '2026-10-02T10:00:01.000Z',
        routePlanId: routeA,
        sequence: 2,
      });
      await expect(repository.ingest(credential, conflicting)).resolves.toMatchObject({
        acceptedDiagnosticIds: [],
        rejectedDiagnostics: [{
          code: 'DIAGNOSTIC_ID_CONFLICT',
          diagnosticId: 'd1000000-0000-4000-8000-000000000001',
        }],
      });

      const unauthorizedRecord = envelope({
        batchId: 'b1000000-0000-4000-8000-000000000003',
        diagnosticId: 'd1000000-0000-4000-8000-000000000002',
        liveRoutePlanId: null,
        observedAt: '2026-10-02T10:00:02.000Z',
        routePlanId: routeB,
      });
      await expect(repository.ingest(credential, unauthorizedRecord)).resolves.toMatchObject({
        acceptedDiagnosticIds: [],
        rejectedDiagnostics: [{ code: 'ROUTE_ACCESS_REVOKED' }],
      });

      now = new Date('2026-10-02T10:00:10.000Z');
      const newer = envelope({
        batchId: 'b1000000-0000-4000-8000-000000000004',
        diagnosticId: 'd1000000-0000-4000-8000-000000000003',
        observedAt: '2026-10-02T10:00:10.000Z',
        routePlanId: routeA,
      });
      await repository.ingest(credential, newer);
      now = new Date('2026-10-02T10:00:20.000Z');
      await repository.ingest(credential, {
        ...newer,
        batchId: 'b1000000-0000-4000-8000-000000000005',
        liveSnapshot: snapshot('2026-10-02T10:00:05.000Z'),
        records: [],
        sentAt: '2026-10-02T10:00:20.000Z',
      });
      const scopedView = await repository.listForShop({ appId: 'clever', shopDomain: 'tenant-a.test' });
      expect(scopedView?.devices).toHaveLength(1);
      expect(scopedView?.devices[0]?.latestSnapshot?.snapshotObservedAt).toEqual(new Date('2026-10-02T10:00:10.000Z'));

      now = new Date('2026-10-02T10:00:21.000Z');
      const delayedOldBoot = envelope({
        batchId: 'b1000000-0000-4000-8000-000000000017',
        bootId: 'c1000000-0000-4000-8000-000000000017',
        diagnosticId: 'd1000000-0000-4000-8000-000000000017',
        observedAt: '2026-10-02T10:00:01.000Z',
        routePlanId: routeA,
        sessionGeneration: '17',
      });
      delayedOldBoot.records = [];
      await repository.ingest(credential, delayedOldBoot);
      expect((await repository.listForShop({ appId: 'clever', shopDomain: 'tenant-a.test' }))
        ?.devices[0]?.latestSnapshot?.snapshotObservedAt).toEqual(new Date('2026-10-02T10:00:10.000Z'));

      now = new Date('2026-10-02T10:00:30.000Z');
      const futureSnapshot = envelope({
        batchId: 'b1000000-0000-4000-8000-000000000011',
        diagnosticId: 'd1000000-0000-4000-8000-000000000011',
        liveObservedAt: '2026-10-02T10:10:30.000Z',
        observedAt: '2026-10-02T10:00:30.000Z',
        routePlanId: routeA,
      });
      await expect(repository.ingest(credential, futureSnapshot)).resolves.toMatchObject({
        acceptedDiagnosticIds: ['d1000000-0000-4000-8000-000000000011'],
      });
      expect(await prisma.driverRuntimeDiagnosticSnapshot.findFirstOrThrow({
        select: { lastIngestionFailureCode: true, snapshotObservedAt: true },
        where: { deviceId: credential.deviceId, routePlanId: routeA, sessionGeneration: '1' },
      })).toEqual({
        lastIngestionFailureCode: 'FUTURE_SNAPSHOT',
        snapshotObservedAt: new Date('2026-10-02T10:00:10.000Z'),
      });

      now = new Date('2026-10-02T10:00:30.500Z');
      const delayedAfterFuture = envelope({
        batchId: 'b1000000-0000-4000-8000-000000000018',
        diagnosticId: 'd1000000-0000-4000-8000-000000000018',
        observedAt: '2026-10-02T10:00:09.000Z',
        routePlanId: routeA,
      });
      delayedAfterFuture.records = [];
      await repository.ingest(credential, delayedAfterFuture);
      expect(await prisma.driverRuntimeDiagnosticSnapshot.findFirstOrThrow({
        select: { lastIngestionFailureCode: true, snapshotObservedAt: true },
        where: { deviceId: credential.deviceId, routePlanId: routeA, sessionGeneration: '1' },
      })).toEqual({
        lastIngestionFailureCode: 'FUTURE_SNAPSHOT',
        snapshotObservedAt: new Date('2026-10-02T10:00:10.000Z'),
      });

      now = new Date('2026-10-02T10:00:31.000Z');
      const recoveredSnapshot = envelope({
        batchId: 'b1000000-0000-4000-8000-000000000012',
        discardedRecordCount: 7,
        diagnosticId: 'd1000000-0000-4000-8000-000000000012',
        observedAt: '2026-10-02T10:00:31.000Z',
        routePlanId: routeA,
      });
      recoveredSnapshot.liveSnapshot.blockers = [{
        clientEventId: 'location-updated-fixture',
        lastObservedAt: '2026-10-02T10:00:31.000Z',
        reason: 'NETWORK_REQUEST_FAILED',
        requestId: 'e1000000-0000-4000-8000-000000000001',
        since: '2026-10-02T10:00:31.000Z',
        stage: 'TRANSPORT',
      }];
      await repository.ingest(credential, recoveredSnapshot);
      expect(await prisma.driverRuntimeDiagnosticSnapshot.findFirstOrThrow({
        select: { lastIngestionFailureCode: true, snapshotObservedAt: true },
        where: { deviceId: credential.deviceId, routePlanId: routeA, sessionGeneration: '1' },
      })).toEqual({
        lastIngestionFailureCode: null,
        snapshotObservedAt: new Date('2026-10-02T10:00:31.000Z'),
      });
      await prisma.driverEventAttempt.createMany({ data: [
        {
          clientEventId: 'location-updated-fixture',
          driverContractVersion: 1,
          driverId: driverA,
          id: 'e2000000-0000-4000-8000-000000000001',
          receivedAt: new Date('2026-10-02T10:00:31.000Z'),
          requestId: 'diagnostic-exact-attempt',
          retainedUntil: new Date('2026-11-02T10:00:31.000Z'),
          routePlanId: routeA,
          shopId: shopA,
          status: 'FAILED',
          transportRequestId: 'e1000000-0000-4000-8000-000000000001',
        },
        {
          attemptNumber: 2,
          clientEventId: 'location-updated-fixture',
          driverContractVersion: 1,
          driverId: driverA,
          id: 'e2000000-0000-4000-8000-000000000002',
          receivedAt: new Date('2026-10-02T10:00:30.000Z'),
          requestId: 'diagnostic-expired-attempt',
          retainedUntil: new Date('2026-10-02T10:00:30.000Z'),
          routePlanId: routeA,
          shopId: shopA,
          status: 'FAILED',
          transportRequestId: 'e1000000-0000-4000-8000-000000000001',
        },
        {
          clientEventId: 'location-updated-fixture',
          driverContractVersion: 1,
          driverId: driverC,
          id: 'e2000000-0000-4000-8000-000000000003',
          receivedAt: new Date('2026-10-02T10:00:31.000Z'),
          requestId: 'diagnostic-other-tenant-attempt',
          retainedUntil: new Date('2026-11-02T10:00:31.000Z'),
          routePlanId: routeC,
          shopId: shopB,
          status: 'FAILED',
          transportRequestId: 'e1000000-0000-4000-8000-000000000001',
        },
      ] });
      expect((await repository.listForShop({ appId: 'clever', shopDomain: 'tenant-a.test' }))
        ?.devices[0]?.attempts.map((attempt) => attempt.id)).toEqual([
        'e2000000-0000-4000-8000-000000000001',
      ]);
      expect((await repository.listForShop({ appId: 'clever', shopDomain: 'tenant-a.test' }))
        ?.devices[0]?.latestSnapshot?.discardedRecordCount).toBe(7);
      await prisma.driverEventAttempt.deleteMany({
        where: { id: { in: [
          'e2000000-0000-4000-8000-000000000001',
          'e2000000-0000-4000-8000-000000000002',
          'e2000000-0000-4000-8000-000000000003',
        ] } },
      });

      now = new Date('2026-10-02T10:00:40.000Z');
      const futureOnlyScope = envelope({
        batchId: 'b1000000-0000-4000-8000-000000000013',
        bootId: 'c1000000-0000-4000-8000-000000000013',
        diagnosticId: 'd1000000-0000-4000-8000-000000000013',
        liveObservedAt: '2026-10-02T10:10:40.000Z',
        observedAt: '2026-10-02T10:00:40.000Z',
        routePlanId: routeA,
        sessionGeneration: '13',
      });
      await repository.ingest(credential, futureOnlyScope);
      expect((await repository.listForShop({ appId: 'clever', shopDomain: 'tenant-a.test' }))?.devices[0]).toMatchObject({
        lastIngestionFailureCode: 'FUTURE_SNAPSHOT',
        latestSnapshot: { snapshotObservedAt: new Date('2026-10-02T10:00:31.000Z') },
      });
      now = new Date('2026-10-02T10:00:40.500Z');
      const delayedThirdScope = envelope({
        batchId: 'b1000000-0000-4000-8000-000000000019',
        bootId: 'c1000000-0000-4000-8000-000000000019',
        diagnosticId: 'd1000000-0000-4000-8000-000000000019',
        observedAt: '2026-10-02T10:00:05.000Z',
        routePlanId: routeA,
        sessionGeneration: '19',
      });
      delayedThirdScope.records = [];
      await repository.ingest(credential, delayedThirdScope);
      expect((await repository.listForShop({ appId: 'clever', shopDomain: 'tenant-a.test' }))?.devices[0]).toMatchObject({
        lastIngestionFailureCode: 'FUTURE_SNAPSHOT',
        latestSnapshot: { snapshotObservedAt: new Date('2026-10-02T10:00:31.000Z') },
      });
      now = new Date('2026-10-02T10:00:41.000Z');
      await repository.ingest(credential, envelope({
        batchId: 'b1000000-0000-4000-8000-000000000014',
        bootId: 'c1000000-0000-4000-8000-000000000013',
        diagnosticId: 'd1000000-0000-4000-8000-000000000014',
        observedAt: '2026-10-02T10:00:41.000Z',
        routePlanId: routeA,
        sessionGeneration: '13',
      }));
      expect(await prisma.driverRuntimeDiagnosticSnapshot.findFirstOrThrow({
        select: { lastIngestionFailureCode: true, snapshotObservedAt: true },
        where: { deviceId: credential.deviceId, sessionGeneration: '13' },
      })).toEqual({
        lastIngestionFailureCode: null,
        snapshotObservedAt: new Date('2026-10-02T10:00:41.000Z'),
      });

      await prisma.routePlan.update({ data: { driverId: driverB, shopId: shopB }, where: { id: routeA } });
      now = new Date('2026-10-02T10:00:25.000Z');
      const replay = envelope({
        batchId: 'b1000000-0000-4000-8000-000000000006',
        diagnosticId: 'd1000000-0000-4000-8000-000000000004',
        liveRoutePlanId: null,
        observedAt: '2026-10-02T10:00:20.000Z',
        routePlanId: routeA,
      });
      await expect(repository.ingest(credential, replay)).resolves.toMatchObject({
        acceptedDiagnosticIds: ['d1000000-0000-4000-8000-000000000004'],
      });
      expect(await prisma.driverRuntimeDiagnosticRecord.findFirstOrThrow({
        select: { isHistoricalReplay: true, shopId: true },
        where: { diagnosticId: 'd1000000-0000-4000-8000-000000000004' },
      })).toEqual({ isHistoricalReplay: true, shopId: shopA });

      const earlyReplay = envelope({
        batchId: 'b1000000-0000-4000-8000-000000000015',
        diagnosticId: 'd1000000-0000-4000-8000-000000000015',
        liveRoutePlanId: null,
        observedAt: '2026-10-02T09:59:00.000Z',
        routePlanId: routeA,
      });
      await expect(repository.ingest(credential, earlyReplay)).resolves.toMatchObject({
        acceptedDiagnosticIds: [],
        rejectedDiagnostics: [{ code: 'ROUTE_ACCESS_REVOKED' }],
      });
      const lateReplay = envelope({
        batchId: 'b1000000-0000-4000-8000-000000000016',
        diagnosticId: 'd1000000-0000-4000-8000-000000000016',
        liveRoutePlanId: null,
        observedAt: '2026-10-02T10:02:00.000Z',
        routePlanId: routeA,
      });
      await expect(repository.ingest(credential, lateReplay)).resolves.toMatchObject({
        acceptedDiagnosticIds: [],
        rejectedDiagnostics: [{ code: 'ROUTE_ACCESS_REVOKED' }],
      });
      await prisma.driverRuntimeDiagnosticSnapshot.deleteMany({
        where: { deviceId: credential.deviceId, routePlanId: routeA },
      });
      const historicalOnlyView = await repository.listForShop({ appId: 'clever', shopDomain: 'tenant-a.test' });
      expect(historicalOnlyView?.devices).toHaveLength(1);
      expect(historicalOnlyView?.devices[0]).toMatchObject({
        lastScopedContactAt: null,
        latestSnapshot: null,
        routePlanId: routeA,
      });
      expect(historicalOnlyView?.devices[0]?.records.some((record) => record.isHistoricalReplay)).toBe(true);

      const privateRecord = envelope({
        batchId: 'b1000000-0000-4000-8000-000000000007',
        diagnosticId: 'd1000000-0000-4000-8000-000000000005',
        liveRoutePlanId: null,
        observedAt: '2026-10-02T10:00:25.000Z',
        routePlanId: null,
      });
      await repository.ingest(credential, privateRecord);
      expect(await prisma.driverRuntimeDiagnosticRecord.findFirstOrThrow({
        select: { shopId: true },
        where: { diagnosticId: 'd1000000-0000-4000-8000-000000000005' },
      })).toEqual({ shopId: null });
      expect((await repository.listForShop({ appId: 'clever', shopDomain: 'tenant-b.test' }))?.devices
        .map((device) => device.routePlanId)).toEqual([routeC]);

      await prisma.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION reject_diagnostic_fixture() RETURNS trigger AS $$
        BEGIN
          IF NEW."diagnosticId" = 'd1000000-0000-4000-8000-000000000099'::uuid THEN
            RAISE EXCEPTION 'fixture persistence failure';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `);
      await prisma.$executeRawUnsafe(`CREATE TRIGGER reject_diagnostic_fixture BEFORE INSERT ON driver_runtime_diagnostic_records
        FOR EACH ROW EXECUTE FUNCTION reject_diagnostic_fixture()`);
      const rollbackEnvelope = envelope({
        batchId: 'b1000000-0000-4000-8000-000000000008',
        diagnosticId: 'd1000000-0000-4000-8000-000000000098',
        liveRoutePlanId: null,
        observedAt: '2026-10-02T10:00:25.000Z',
        routePlanId: null,
      });
      rollbackEnvelope.records = [
        ...rollbackEnvelope.records,
        { ...rollbackEnvelope.records[0]!, diagnosticId: 'd1000000-0000-4000-8000-000000000099', sequence: 99 },
      ];
      await expect(repository.ingest(credential, rollbackEnvelope)).rejects.toThrow('fixture persistence failure');
      expect(await prisma.driverRuntimeDiagnosticRecord.count({
        where: { deviceId: credential.deviceId, diagnosticId: { in: [
          'd1000000-0000-4000-8000-000000000098',
          'd1000000-0000-4000-8000-000000000099',
        ] } },
      })).toBe(0);
      await prisma.$executeRawUnsafe('DROP TRIGGER reject_diagnostic_fixture ON driver_runtime_diagnostic_records');
      await prisma.$executeRawUnsafe('DROP FUNCTION reject_diagnostic_fixture()');

      await prisma.driverAccount.update({ data: { tokenVersion: 4 }, where: { id: accountA } });
      await expect(repository.authenticate(registration.token)).resolves.toBeNull();
      await prisma.driverAccount.update({ data: { tokenVersion: 3 }, where: { id: accountA } });
      nextToken = 'B'.repeat(43);
      const secondRegistration = await repository.register({ accountId: accountA, deviceInstanceHash: deviceHash, tokenVersion: 3 });
      expect(secondRegistration).not.toBeNull();
      await expect(repository.revoke({ accountId: accountA, deviceInstanceHash: deviceHash, tokenVersion: 2 })).resolves.toBeNull();
      await expect(repository.revoke({ accountId: accountA, deviceInstanceHash: deviceHash, tokenVersion: 3 })).resolves.toMatchObject({ revokedCount: 2 });
      await expect(repository.authenticate(nextToken)).resolves.toBeNull();

      now = new Date('2026-11-03T10:00:00.000Z');
      const cleanupResult = await repository.cleanupExpired({ batchSize: 2, deadlineMs: 5_000, now });
      expect(cleanupResult.credentials).toBeGreaterThanOrEqual(2);
      expect(cleanupResult.records).toBeGreaterThan(0);
      expect(cleanupResult.snapshots).toBeGreaterThan(0);
      expect(cleanupResult.devices).toBe(1);
      expect(cleanupResult.continuationRequired).toBe(false);
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS reject_diagnostic_fixture ON driver_runtime_diagnostic_records').catch(() => undefined);
      await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS reject_diagnostic_fixture()').catch(() => undefined);
      await cleanup(prisma).catch(() => undefined);
      await prisma.$disconnect();
    }
  }, 30_000);
});

function envelope(input: {
  batchId: string;
  bootId?: string;
  diagnosticId: string;
  discardedRecordCount?: number;
  liveObservedAt?: string;
  liveRoutePlanId?: string | null;
  observedAt: string;
  routePlanId: string | null;
  sequence?: number;
  sessionGeneration?: string;
}): DriverDiagnosticEnvelope {
  const liveRoutePlanId = input.liveRoutePlanId === undefined ? input.routePlanId : input.liveRoutePlanId;
  const bootId = input.bootId ?? 'c1000000-0000-4000-8000-000000000001';
  const context = {
    appVersion: '2.0.0',
    assignmentGeneration: '1',
    deviceInstanceHash: deviceHash,
    os: 'ANDROID' as const,
    osVersion: '15',
    routePlanId: input.routePlanId,
    sessionGeneration: input.sessionGeneration ?? '1',
    versionCode: 200,
  };
  return {
    batchId: input.batchId,
    bootId,
    discardedRecordCount: input.discardedRecordCount ?? 0,
    liveContext: { ...context, routePlanId: liveRoutePlanId },
    liveSnapshot: snapshot(input.liveObservedAt ?? input.observedAt),
    records: [{
      bootId,
      context,
      diagnosticId: input.diagnosticId,
      identifiers: { clientEventId: 'location-updated-fixture', requestId: 'fixture-request' },
      kind: 'HEARTBEAT',
      observedAt: input.observedAt,
      sequence: input.sequence ?? 1,
      snapshot: snapshot(input.observedAt),
    }],
    schemaVersion: 1,
    sentAt: input.observedAt,
  };
}

function snapshot(observedAt: string): DriverDiagnosticSnapshot {
  return {
    blockers: [],
    businessQueue: { nextRetryAt: null, observedAt, oldestAgeMs: null, oldestQueuedAt: null, queueDepth: 0, retryCount: 0 },
    lastGpsCallbackAt: observedAt,
    lastGpsCollectedAt: observedAt,
    lastGpsPersistedAt: observedAt,
    lastGpsSendAcknowledgedAt: observedAt,
    lastGpsSendAttemptAt: observedAt,
    lifecycle: 'FOREGROUND',
    locationPermission: 'GRANTED_ALWAYS',
    locationService: 'ENABLED',
    locationTask: 'STARTED',
    locationTaskExpected: true,
    network: 'ONLINE',
    snapshotObservedAt: observedAt,
    stateObservedAt: {
      lifecycle: observedAt,
      locationPermission: observedAt,
      locationService: observedAt,
      locationTask: observedAt,
      network: observedAt,
    },
  };
}

async function seed(prisma: PrismaClient): Promise<void> {
  await prisma.shop.createMany({ data: [
    { appId: 'clever', id: shopA, shopDomain: 'tenant-a.test' },
    { appId: 'clever', id: shopB, shopDomain: 'tenant-b.test' },
  ] });
  await prisma.driverAccount.createMany({ data: [
    { id: accountA, phone: '+15550000001', status: 'ACTIVE', tokenVersion: 3 },
    { id: accountB, phone: '+15550000002', status: 'ACTIVE', tokenVersion: 1 },
  ] });
  await prisma.driver.createMany({ data: [
    { accountId: accountA, authSubject: 'diagnostic-driver-a', displayName: 'A', id: driverA, shopId: shopA },
    { accountId: accountB, authSubject: 'diagnostic-driver-b', displayName: 'B', id: driverB, shopId: shopB },
    { accountId: accountA, authSubject: 'diagnostic-driver-c', displayName: 'C', id: driverC, shopId: shopB },
  ] });
  await prisma.routePlan.createMany({ data: [
    { constraints: {}, driverId: driverA, id: routeA, metrics: {}, name: 'A', optimizerVersion: 'fixture', planDate: new Date('2026-10-02'), shopId: shopA, status: 'COMPLETED' },
    { constraints: {}, driverId: driverB, id: routeB, metrics: {}, name: 'B', optimizerVersion: 'fixture', planDate: new Date('2026-10-02'), shopId: shopB, status: 'IN_PROGRESS' },
    { constraints: {}, driverId: driverC, id: routeC, metrics: {}, name: 'C', optimizerVersion: 'fixture', planDate: new Date('2026-10-02'), shopId: shopB, status: 'IN_PROGRESS' },
  ] });
}

async function cleanup(prisma: PrismaClient): Promise<void> {
  await prisma.driverRuntimeDiagnosticDevice.deleteMany({ where: { accountId: { in: [accountA, accountB] } } });
  await prisma.routePlan.deleteMany({ where: { id: { in: [routeA, routeB, routeC] } } });
  await prisma.driver.deleteMany({ where: { id: { in: [driverA, driverB, driverC] } } });
  await prisma.driverAccount.deleteMany({ where: { id: { in: [accountA, accountB] } } });
  await prisma.shop.deleteMany({ where: { id: { in: [shopA, shopB] } } });
}

function assertDisposableDatabase(): void {
  const parsed = new URL(databaseUrl);
  const databaseName = decodeURIComponent(parsed.pathname.slice(1));
  if (
    targetClass !== 'safe-local-disposable'
    || parsed.protocol !== 'postgresql:'
    || parsed.hostname !== '127.0.0.1'
    || parsed.port === ''
    || ['5433', '55444', '55455'].includes(parsed.port)
    || !['clever_diagnostics', 'clever_diagnostics_http', 'clever_g002', 'clever_g002_disposable'].includes(databaseName)
  ) {
    throw new Error('Refusing unsafe driver runtime diagnostics database target');
  }
}
