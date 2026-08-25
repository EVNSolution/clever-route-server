import pg from 'pg';
import { describe, expect, test } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { cleanupResolvedDriverEventAttempts } from '../src/modules/driver/driver-event-attempt-retention.js';
import { cleanupReviewedRouteCompletionEvidence } from '../src/modules/driver/driver-route-completion-review-retention.js';
import {
  DriverEventExecutionConflictError,
  DriverEventRouteNotInProgressError,
  DriverEventRouteVersionMismatchError,
  DriverRouteCompletionIncompleteError,
  PrismaDriverEventRepository
} from '../src/modules/driver/driver-event.repository.js';
import {
  DriverEventReceiptScopeError,
  PrismaDriverEventReceiptRepository
} from '../src/modules/driver/driver-event-receipt.repository.js';
import { PrismaRouteGroupingService, replaceCurrentRouteGroupingChildVersion } from '../src/modules/route-grouping/route-grouping.service.js';
import { FakeDriverPushProvider } from '../src/modules/route-grouping/driver-push.provider.js';
import { PrismaRoutePlanRepository } from '../src/modules/route-plans/route-plan.repository.js';
import { PrismaDriverRouteCompletionReviewRepository } from '../src/modules/driver/driver-route-completion-review.repository.js';

const databaseUrl = process.env.DRIVER_EVENT_CONTRACT_V2_DATABASE_URL ?? '';
const live = databaseUrl === '' ? test.skip : test;

describe('driver event contract v2 PostgreSQL invariants', () => {
  live('serializes assignment ownership and increments exactly once per distinct owner', async () => {
    assertDisposableDatabase();
    const seed = new pg.Client({ connectionString: databaseUrl });
    await seed.connect();
    try {
      await seed.query(`INSERT INTO shops (id, "shopDomain", "createdAt", "updatedAt") VALUES
        ('10000000-0000-4000-8000-000000000001', 'g002.invalid', now(), now())`);
      await seed.query(`INSERT INTO drivers (id, "shopId", "displayName", "createdAt", "updatedAt") VALUES
        ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'A', now(), now()),
        ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'B', now(), now()),
        ('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'C', now(), now())`);
      await seed.query(`INSERT INTO route_plans
        (id, "shopId", name, "planDate", "optimizerVersion", constraints, metrics, "createdAt", "updatedAt") VALUES
        ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'G002', '2026-08-24', 'test', '{}', '{}', now(), now())`);
    } finally {
      await seed.end();
    }

    const first = new pg.Client({ connectionString: databaseUrl });
    const second = new pg.Client({ connectionString: databaseUrl });
    await Promise.all([first.connect(), second.connect()]);
    try {
      await first.query('BEGIN');
      const firstRow = await lock(first);
      expect(firstRow).toMatchObject({ assignmentGeneration: '1', driverId: null });
      await assignWhenChanged(first, '20000000-0000-4000-8000-000000000001');

      await second.query('BEGIN');
      let secondAcquired = false;
      const blockedLock = lock(second).then((row) => { secondAcquired = true; return row; });
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(secondAcquired).toBe(false);
      await first.query('COMMIT');
      expect(await blockedLock).toMatchObject({ assignmentGeneration: '2', driverId: '20000000-0000-4000-8000-000000000001' });
      await assignWhenChanged(second, '20000000-0000-4000-8000-000000000001');
      await second.query('COMMIT');

      await distinctAssignment(first, '20000000-0000-4000-8000-000000000002');
      await distinctAssignment(first, '20000000-0000-4000-8000-000000000003');
      const final = await first.query(`SELECT "driverId", "assignmentGeneration"::text FROM route_plans WHERE id = '30000000-0000-4000-8000-000000000001'`);
      expect(final.rows[0]).toEqual({ assignmentGeneration: '4', driverId: '20000000-0000-4000-8000-000000000003' });

      const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
      try {
        const productionRepository = new PrismaRoutePlanRepository(prisma, { allowAnyShopDomain: true });
        await Promise.all([
          productionRepository.assignRoutePlanDriver({ routePlanId: '30000000-0000-4000-8000-000000000001', shopDomain: 'g002.invalid', payload: { driverId: '20000000-0000-4000-8000-000000000001' } }),
          productionRepository.assignRoutePlanDriver({ routePlanId: '30000000-0000-4000-8000-000000000001', shopDomain: 'g002.invalid', payload: { driverId: '20000000-0000-4000-8000-000000000002' } })
        ]);
        const afterConcurrent = await prisma.routePlan.findUniqueOrThrow({ where: { id: '30000000-0000-4000-8000-000000000001' } });
        expect(afterConcurrent.assignmentGeneration).toBe(6n);
        await productionRepository.assignRoutePlanDriver({ routePlanId: afterConcurrent.id, shopDomain: 'g002.invalid', payload: { driverId: afterConcurrent.driverId } });
        expect((await prisma.routePlan.findUniqueOrThrow({ where: { id: afterConcurrent.id } })).assignmentGeneration).toBe(6n);
      } finally {
        await prisma.$disconnect();
      }
    } finally {
      await Promise.allSettled([first.query('ROLLBACK'), second.query('ROLLBACK')]);
      await Promise.all([first.end(), second.end()]);
    }
  });

  live('creates only the allowlisted redacted attempt columns and bigint checks', async () => {
    assertDisposableDatabase();
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const result = await client.query<{ column_name: string }>(`SELECT "column_name" FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'driver_event_attempts' ORDER BY "column_name"`);
      const columns = result.rows.map((row) => row.column_name);
      expect(columns).toContain('retainedUntil');
      expect(columns).toContain('attemptNumber');
      expect(columns).not.toEqual(expect.arrayContaining(['accessToken', 'address', 'errorMessage', 'payload', 'proofMedia', 'recipient']));
      await expect(client.query(`INSERT INTO route_plans
        (id, "shopId", name, "planDate", "optimizerVersion", constraints, metrics, "assignmentGeneration", "createdAt", "updatedAt") VALUES
        ('30000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'bad', '2026-08-24', 'test', '{}', '{}', 0, now(), now())`))
        .rejects.toMatchObject({ code: '23514' });
    } finally {
      await client.end();
    }
  });

  live('preserves attempt evidence across rollback, retry, finalize gaps, account scope, and retention', async () => {
    assertDisposableDatabase();
    const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    const repository = new PrismaDriverEventRepository(prisma, {
      attemptRetentionDays: 90,
      now: () => new Date('2026-08-24T05:00:00.000Z')
    });
    const receipts = new PrismaDriverEventReceiptRepository(prisma);
    const shopId = '10000000-0000-4000-8000-000000000010';
    const accountA = '11000000-0000-4000-8000-000000000010';
    const accountB = '11000000-0000-4000-8000-000000000011';
    const driverA = '20000000-0000-4000-8000-000000000010';
    const driverB = '20000000-0000-4000-8000-000000000011';
    const routePlanId = '30000000-0000-4000-8000-000000000010';
    const routeVersionId = '50000000-0000-4000-8000-000000000010';
    try {
      await seedEvidenceFixture(prisma, { accountA, accountB, driverA, driverB, routePlanId, routeVersionId, shopId });
      await prisma.$executeRawUnsafe(`INSERT INTO orders
        (id, "shopId", "shopifyOrderGid", name, "rawPayload", "createdAt", "updatedAt") VALUES
        ('60000000-0000-4000-8000-000000000010', '${shopId}', 'gid://shopify/Order/completion-invariant', 'Invariant', '{}', now(), now())`);
      await prisma.$executeRawUnsafe(`INSERT INTO delivery_stops
        (id, "shopId", "orderId", status, "createdAt", "updatedAt") VALUES
        ('61000000-0000-4000-8000-000000000010', '${shopId}', '60000000-0000-4000-8000-000000000010', 'ASSIGNED', now(), now())`);
      await prisma.$executeRawUnsafe(`INSERT INTO route_grouping_orders
        (id, "shopId", "groupingId", "orderId", "deliveryStopId", "assignmentStatus", "sourceSequence", "createdAt", "updatedAt") VALUES
        ('63000000-0000-4000-8000-000000000010', '${shopId}', '40000000-0000-4000-8000-000000000010',
         '60000000-0000-4000-8000-000000000010', '61000000-0000-4000-8000-000000000010', 'ASSIGNED', 1, now(), now())`);
      await prisma.$executeRawUnsafe(`INSERT INTO route_plan_stops
        (id, "shopId", "routePlanId", "deliveryStopId", sequence, "createdAt", "updatedAt") VALUES
        ('62000000-0000-4000-8000-000000000010', '${shopId}', '${routePlanId}', '61000000-0000-4000-8000-000000000010', 1, now(), now())`);
      await prisma.routeGroupingChildVersion.update({
        data: { snapshot: { stops: [{ deliveryStopId: '61000000-0000-4000-8000-000000000010' }] } },
        where: { id: routeVersionId }
      });
      await prisma.order.update({ data: { currentRouteVersionId: routeVersionId }, where: { id: '60000000-0000-4000-8000-000000000010' } });

      const routePlanRepository = new PrismaRoutePlanRepository(prisma, { allowAnyShopDomain: true });
      await prisma.routePlan.update({ data: { status: 'READY' }, where: { id: routePlanId } });
      const routeStart = new pg.Client({ connectionString: databaseUrl });
      await routeStart.connect();
      try {
        await routeStart.query('BEGIN');
        await routeStart.query('UPDATE route_plans SET status = \'IN_PROGRESS\' WHERE id = $1', [routePlanId]);
        let stopReplacementSettled = false;
        const stopReplacement = routePlanRepository.updateRoutePlanStops({
          routePlanId, shopDomain: 'g002-evidence.invalid', payload: { stops: [] }
        }).then(
          (value) => ({ error: null, value }),
          (error: unknown) => ({ error, value: null })
        ).finally(() => { stopReplacementSettled = true; });
        await new Promise((resolve) => setTimeout(resolve, 75));
        expect(stopReplacementSettled).toBe(false);
        await routeStart.query('COMMIT');
        expect((await stopReplacement).error).toMatchObject({ code: 'ROUTE_STOP_UPDATE_INVALID' });
      } finally {
        await routeStart.query('ROLLBACK').catch(() => undefined);
        await routeStart.end();
      }
      expect(await prisma.routePlanStop.count({ where: { routePlanId } })).toBe(1);

      await prisma.routePlan.update({ data: { status: 'READY' }, where: { id: routePlanId } });
      const groupingDeleteRace = new pg.Client({ connectionString: databaseUrl });
      const routeGroupingService = new PrismaRouteGroupingService(
        prisma,
        new FakeDriverPushProvider(),
        undefined,
        undefined,
        { buildRoute: () => Promise.resolve({
          routeGeometry: { coordinates: [[-80.49, 43.45], [-80.48, 43.46]], type: 'LineString' },
          routeMetrics: { distanceMeters: 1, durationSeconds: 1 },
          routeStopPoints: []
        }) }
      );
      await groupingDeleteRace.connect();
      try {
        await groupingDeleteRace.query('BEGIN');
        await groupingDeleteRace.query('UPDATE route_plans SET status = \'IN_PROGRESS\' WHERE id = $1', [routePlanId]);
        const groupingDelete = routeGroupingService.deleteGrouping({
          groupingId: '40000000-0000-4000-8000-000000000010', shopDomain: 'g002-evidence.invalid'
        }).then(
          (value) => ({ error: null, value }),
          (error: unknown) => ({ error, value: null })
        );
        await new Promise((resolve) => setTimeout(resolve, 75));
        await groupingDeleteRace.query('COMMIT');
        expect((await groupingDelete).error).toMatchObject({ code: 'ROUTE_GROUPING_INVALID' });
      } finally {
        await groupingDeleteRace.query('ROLLBACK').catch(() => undefined);
        await groupingDeleteRace.end();
      }
      expect(await prisma.routePlanStop.count({ where: { routePlanId } })).toBe(1);
      expect(await prisma.routeGrouping.findUnique({ where: { id: '40000000-0000-4000-8000-000000000010' } })).not.toBeNull();

      await prisma.deliveryStop.update({ data: { status: 'DELIVERED' }, where: { id: '61000000-0000-4000-8000-000000000010' } });
      const completionGate = new pg.Client({ connectionString: databaseUrl });
      await completionGate.connect();
      try {
        await completionGate.query('SELECT pg_advisory_lock(26533001)');
        await prisma.$executeRawUnsafe(`CREATE FUNCTION block_v2_completion_for_append_race() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN PERFORM pg_advisory_xact_lock(26533001); RETURN NEW; END $$`);
        await prisma.$executeRawUnsafe(`CREATE TRIGGER block_v2_completion_for_append_race
          BEFORE INSERT ON driver_events FOR EACH ROW
          WHEN (NEW."clientEventId" = 'v2-completion-append-race')
          EXECUTE FUNCTION block_v2_completion_for_append_race()`);
        const completion = repository.recordDriverEvent({
          appVersion: '1.2.0', assignmentGeneration: '1', clientEventId: 'v2-completion-append-race', deliveryStopId: null,
          driverContractVersion: 2, driverId: driverA, eventType: 'ROUTE_COMPLETED', expectedRouteVersionId: routeVersionId,
          latitude: null, longitude: null, occurredAt: new Date('2026-08-24T04:56:00.000Z'), payload: {},
          requestId: 'request-v2-completion-append-race', routePlanId, shopDomain: 'g002-evidence.invalid', shopId, versionCode: 120
        });
        await new Promise((resolve) => setTimeout(resolve, 75));
        let appendSettled = false;
        const append = routeGroupingService.createCustomStop({
          actor: 'route-ops:test', groupingId: '40000000-0000-4000-8000-000000000010',
          shopDomain: 'g002-evidence.invalid', stopName: 'Completion race append', targetRoutePlanId: routePlanId
        }).then(
          (value) => ({ error: null, value }),
          (error: unknown) => ({ error, value: null })
        ).finally(() => { appendSettled = true; });
        await new Promise((resolve) => setTimeout(resolve, 75));
        expect(appendSettled).toBe(false);
        await completionGate.query('SELECT pg_advisory_unlock(26533001)');
        await expect(completion).resolves.toMatchObject({ duplicate: false });
        expect((await append).error).toMatchObject({ code: 'ROUTE_GROUPING_INVALID' });
      } finally {
        await completionGate.query('SELECT pg_advisory_unlock(26533001)').catch(() => undefined);
        await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS block_v2_completion_for_append_race ON driver_events');
        await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS block_v2_completion_for_append_race()');
        await completionGate.end();
      }
      expect(await prisma.routePlan.findUniqueOrThrow({ where: { id: routePlanId } })).toMatchObject({ status: 'COMPLETED' });
      expect(await prisma.order.count({ where: { name: 'Completion race append', shopId } })).toBe(0);
      expect(await prisma.routePlanStop.count({ where: { routePlanId } })).toBe(1);
      await prisma.driverRouteCompletionReview.deleteMany({ where: { routePlanId } });
      await prisma.driverEvent.deleteMany({ where: { clientEventId: 'v2-completion-append-race', routePlanId } });
      await prisma.driverEventAttempt.deleteMany({ where: { clientEventId: 'v2-completion-append-race', routePlanId } });

      const customOrderId = '60000000-0000-4000-8000-000000000012';
      const customStopId = '61000000-0000-4000-8000-000000000012';
      await prisma.routePlan.update({ data: { status: 'READY' }, where: { id: routePlanId } });
      await prisma.order.create({ data: {
        id: customOrderId, name: 'Completion race delete', ownedRouteGroupingId: '40000000-0000-4000-8000-000000000010',
        rawPayload: {}, shopId, shopifyOrderGid: 'gid://clever/CustomRouteStop/completion-race-delete',
        sourceOrderId: 'custom-stop:completion-race-delete', sourcePlatform: 'CUSTOM'
      } });
      await prisma.deliveryStop.create({ data: { id: customStopId, orderId: customOrderId, shopId, status: 'DELIVERED' } });
      await prisma.routeGroupingOrder.create({ data: {
        assignmentStatus: 'ASSIGNED', deliveryStopId: customStopId, groupingId: '40000000-0000-4000-8000-000000000010',
        orderId: customOrderId, shopId, sourceSequence: 2
      } });
      await prisma.routePlanStop.create({ data: { deliveryStopId: customStopId, routePlanId, sequence: 2, shopId } });
      await prisma.routeGroupingChildVersion.update({
        data: { snapshot: { stops: [
          { deliveryStopId: '61000000-0000-4000-8000-000000000010', sequence: 1 },
          { deliveryStopId: customStopId, sequence: 2 }
        ] } },
        where: { id: routeVersionId }
      });

      const deleteGate = new pg.Client({ connectionString: databaseUrl });
      await deleteGate.connect();
      try {
        await deleteGate.query('SELECT pg_advisory_lock(26533002)');
        await prisma.$executeRawUnsafe(`CREATE FUNCTION block_custom_delete_before_route_lock() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN PERFORM pg_advisory_xact_lock(26533002); RETURN NEW; END $$`);
        await prisma.$executeRawUnsafe(`CREATE TRIGGER block_custom_delete_before_route_lock
          BEFORE UPDATE ON route_groupings FOR EACH ROW
          WHEN (OLD.id = '40000000-0000-4000-8000-000000000010'::uuid)
          EXECUTE FUNCTION block_custom_delete_before_route_lock()`);
        let deleteSettled = false;
        const deletion = routeGroupingService.deleteCustomStop({
          deliveryStopId: customStopId, groupingId: '40000000-0000-4000-8000-000000000010', shopDomain: 'g002-evidence.invalid'
        }).then(
          (value) => ({ error: null, value }),
          (error: unknown) => ({ error, value: null })
        ).finally(() => { deleteSettled = true; });
        await new Promise((resolve) => setTimeout(resolve, 75));
        expect(deleteSettled).toBe(false);
        await prisma.routePlan.update({ data: { status: 'IN_PROGRESS' }, where: { id: routePlanId } });
        await expect(repository.recordDriverEvent({
          clientEventId: 'legacy-completion-delete-race', deliveryStopId: null, driverId: driverA,
          eventType: 'ROUTE_COMPLETED', latitude: null, longitude: null, occurredAt: new Date('2026-08-24T04:56:30.000Z'),
          payload: {}, routePlanId, shopDomain: 'g002-evidence.invalid', shopId
        })).resolves.toMatchObject({ duplicate: false });
        await deleteGate.query('SELECT pg_advisory_unlock(26533002)');
        expect((await deletion).error).toMatchObject({ code: 'ROUTE_GROUPING_INVALID' });
      } finally {
        await deleteGate.query('SELECT pg_advisory_unlock(26533002)').catch(() => undefined);
        await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS block_custom_delete_before_route_lock ON route_groupings');
        await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS block_custom_delete_before_route_lock()');
        await deleteGate.end();
      }
      expect(await prisma.order.findUnique({ where: { id: customOrderId } })).not.toBeNull();
      expect(await prisma.routePlanStop.count({ where: { routePlanId } })).toBe(2);
      await prisma.driverRouteCompletionReview.deleteMany({ where: { routePlanId } });
      await prisma.driverEvent.deleteMany({ where: { clientEventId: 'legacy-completion-delete-race', routePlanId } });
      await prisma.routePlan.update({ data: { status: 'READY' }, where: { id: routePlanId } });

      const updateGate = new pg.Client({ connectionString: databaseUrl });
      await updateGate.connect();
      try {
        await updateGate.query('SELECT pg_advisory_lock(26533003)');
        await prisma.$executeRawUnsafe(`CREATE FUNCTION block_custom_update_before_route_lock() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN PERFORM pg_advisory_xact_lock(26533003); RETURN NEW; END $$`);
        await prisma.$executeRawUnsafe(`CREATE TRIGGER block_custom_update_before_route_lock
          BEFORE UPDATE ON route_groupings FOR EACH ROW
          WHEN (OLD.id = '40000000-0000-4000-8000-000000000010'::uuid)
          EXECUTE FUNCTION block_custom_update_before_route_lock()`);
        let updateSettled = false;
        const update = routeGroupingService.updateCustomStop({
          deliveryStopId: customStopId, groupingId: '40000000-0000-4000-8000-000000000010',
          instructions: 'must roll back after completion', shopDomain: 'g002-evidence.invalid'
        }).then(
          (value) => ({ error: null, value }),
          (error: unknown) => ({ error, value: null })
        ).finally(() => { updateSettled = true; });
        await new Promise((resolve) => setTimeout(resolve, 75));
        expect(updateSettled).toBe(false);
        await prisma.routePlan.update({ data: { status: 'IN_PROGRESS' }, where: { id: routePlanId } });
        await expect(repository.recordDriverEvent({
          clientEventId: 'legacy-completion-update-race', deliveryStopId: null, driverId: driverA,
          eventType: 'ROUTE_COMPLETED', latitude: null, longitude: null, occurredAt: new Date('2026-08-24T04:56:45.000Z'),
          payload: {}, routePlanId, shopDomain: 'g002-evidence.invalid', shopId
        })).resolves.toMatchObject({ duplicate: false });
        await updateGate.query('SELECT pg_advisory_unlock(26533003)');
        expect((await update).error).toMatchObject({ code: 'ROUTE_GROUPING_INVALID' });
      } finally {
        await updateGate.query('SELECT pg_advisory_unlock(26533003)').catch(() => undefined);
        await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS block_custom_update_before_route_lock ON route_groupings');
        await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS block_custom_update_before_route_lock()');
        await updateGate.end();
      }
      expect(await prisma.deliveryStop.findUniqueOrThrow({ where: { id: customStopId } }))
        .toMatchObject({ instructions: null });
      await prisma.driverRouteCompletionReview.deleteMany({ where: { routePlanId } });
      await prisma.driverEvent.deleteMany({ where: { clientEventId: 'legacy-completion-update-race', routePlanId } });
      await prisma.routePlanStop.deleteMany({ where: { deliveryStopId: customStopId, routePlanId } });
      await prisma.order.delete({ where: { id: customOrderId } });
      await prisma.routeGroupingChildVersion.update({
        data: { snapshot: { stops: [{ deliveryStopId: '61000000-0000-4000-8000-000000000010', sequence: 1 }] } },
        where: { id: routeVersionId }
      });
      await prisma.deliveryStop.update({ data: { status: 'ASSIGNED' }, where: { id: '61000000-0000-4000-8000-000000000010' } });
      await prisma.routePlan.update({ data: { status: 'IN_PROGRESS' }, where: { id: routePlanId } });
      expect(await prisma.routePlanStop.count({ where: { routePlanId } })).toBe(1);

      await expect(routePlanRepository.updateRoutePlanStops({
        routePlanId,
        shopDomain: 'g002-evidence.invalid',
        payload: { stops: [] }
      })).rejects.toMatchObject({ code: 'ROUTE_STOP_UPDATE_INVALID' });
      await expect(routePlanRepository.saveRoutePlan({
        routePlanId,
        shopDomain: 'g002-evidence.invalid',
        payload: { stops: [] }
      })).rejects.toMatchObject({ code: 'ROUTE_STOP_UPDATE_INVALID' });
      expect(await prisma.routePlanStop.count({ where: { routePlanId } })).toBe(1);
      expect(await prisma.routeGroupingChildVersion.findMany({
        where: { routePlanId, status: 'CURRENT', supersededAt: null }
      })).toEqual([expect.objectContaining({ id: routeVersionId })]);
      const siblingRoutePlanId = '30000000-0000-4000-8000-000000000011';
      const siblingVersionId = '50000000-0000-4000-8000-000000000011';
      await prisma.routePlan.create({ data: {
        constraints: {}, id: siblingRoutePlanId, metrics: {}, name: 'Disposable sibling',
        optimizerVersion: 'test', planDate: new Date('2026-08-24T00:00:00.000Z'), shopId
      } });
      await prisma.routeGroupingChildVersion.create({ data: {
        groupingId: '40000000-0000-4000-8000-000000000010',
        groupingVersionId: '41000000-0000-4000-8000-000000000010', id: siblingVersionId,
        routePlanId: siblingRoutePlanId, shopId, snapshot: { stops: [] }, status: 'CURRENT', version: 2
      } });
      await expect(routePlanRepository.deleteRoutePlan({ routePlanId: siblingRoutePlanId, shopDomain: 'g002-evidence.invalid' }))
        .rejects.toMatchObject({ code: 'ROUTE_DELETE_BLOCKED' });
      expect(await prisma.routePlan.findUniqueOrThrow({ where: { id: siblingRoutePlanId } })).toMatchObject({ status: 'READY' });
      expect(await prisma.routeGroupingChildVersion.findUniqueOrThrow({ where: { id: siblingVersionId } }))
        .toMatchObject({ routePlanId: siblingRoutePlanId, status: 'CURRENT', supersededAt: null });
      expect(await prisma.routePlanStop.count({ where: { routePlanId } })).toBe(1);
      await expect(routePlanRepository.deleteRoutePlan({ routePlanId, shopDomain: 'g002-evidence.invalid' }))
        .rejects.toMatchObject({ code: 'ROUTE_DELETE_BLOCKED' });
      await expect(routeGroupingService.deleteGrouping({
        groupingId: '40000000-0000-4000-8000-000000000010', shopDomain: 'g002-evidence.invalid'
      })).rejects.toThrow('in-progress child routes cannot be archived or deleted');
      expect(await prisma.routePlan.findUniqueOrThrow({ where: { id: routePlanId } })).toMatchObject({ status: 'IN_PROGRESS' });
      expect(await prisma.routeGroupingChildVersion.findUniqueOrThrow({ where: { id: routeVersionId } }))
        .toMatchObject({ status: 'CURRENT', supersededAt: null });

      const removalReceipt = await prisma.dsvCommandReceipt.create({ data: {
        actorType: 'DSV_ADMIN', commandId: 'active-removal-command', commandName: 'ACTIVE_ROUTE_ORDER_REMOVAL',
        payloadHash: 'non-pii-test-hash', principalType: 'DSV_ADMIN', requestId: 'active-removal-request', shopId
      } });
      const removalRequest = await prisma.dsvDispatchChangeRequest.create({ data: {
        commandReceiptId: removalReceipt.id, deliveryStopId: '61000000-0000-4000-8000-000000000010',
        driverId: driverA, priorSnapshot: { currentRouteVersionId: routeVersionId }, removalReason: 'test',
        requestId: 'active-removal-request', requestedByActorType: 'DSV_ADMIN', routePlanId,
        routeVersionId, sellerOrderId: '60000000-0000-4000-8000-000000000010', shopId,
        type: 'ACTIVE_ROUTE_ORDER_REMOVAL'
      } });
      await expect(repository.recordDriverEvent({
        appVersion: '1.2.0', assignmentGeneration: '1', changeRequestId: removalRequest.id,
        clientEventId: 'active-removal-ack', deliveryStopId: null,
        driverContractVersion: 2, driverId: driverA, eventType: 'DISPATCH_CHANGE_ACKNOWLEDGED', expectedRouteVersionId: routeVersionId,
        latitude: null, longitude: null, occurredAt: new Date('2026-08-24T04:57:30.000Z'), payload: { changeRequestId: removalRequest.id },
        requestId: 'request-active-removal-ack', routePlanId, shopDomain: 'g002-evidence.invalid', shopId, versionCode: 120
      })).rejects.toBeInstanceOf(DriverEventExecutionConflictError);
      expect(await prisma.dsvDispatchChangeRequest.findUniqueOrThrow({ where: { id: removalRequest.id } }))
        .toMatchObject({ appliedDriverEventId: null, status: 'PENDING_ACK' });
      expect(await prisma.order.findUniqueOrThrow({ where: { id: '60000000-0000-4000-8000-000000000010' } }))
        .toMatchObject({ currentRouteVersionId: routeVersionId });
      expect(await prisma.routePlanStop.count({ where: { routePlanId } })).toBe(1);
      expect(await prisma.routeGroupingChildVersion.findUniqueOrThrow({ where: { id: routeVersionId } }))
        .toMatchObject({ status: 'CURRENT', supersededAt: null });

      await expect(prisma.routeGroupingChildVersion.create({ data: {
        driverId: driverA, groupingId: '40000000-0000-4000-8000-000000000010',
        groupingVersionId: '41000000-0000-4000-8000-000000000010', routePlanId, shopId,
        snapshot: { stops: [] }, status: 'CURRENT', version: 1
      } })).rejects.toMatchObject({ code: 'P2002' });

      await prisma.routePlan.update({ data: { status: 'DRAFT' }, where: { id: routePlanId } });
      await expect(repository.recordDriverEvent({
        appVersion: '1.2.0', assignmentGeneration: '1', clientEventId: 'draft-completion', deliveryStopId: null,
        driverContractVersion: 2, driverId: driverA, eventType: 'ROUTE_COMPLETED', expectedRouteVersionId: routeVersionId,
        latitude: null, longitude: null, occurredAt: new Date('2026-08-24T04:57:00.000Z'), payload: {},
        requestId: 'request-draft-completion', routePlanId, shopDomain: 'g002-evidence.invalid', shopId, versionCode: 120
      })).rejects.toBeInstanceOf(DriverEventRouteNotInProgressError);
      expect(await prisma.routePlan.findUniqueOrThrow({ where: { id: routePlanId } })).toMatchObject({ status: 'DRAFT' });
      expect(await prisma.driverEvent.count({ where: { clientEventId: 'draft-completion' } })).toBe(0);
      await prisma.routePlan.update({ data: { status: 'IN_PROGRESS' }, where: { id: routePlanId } });

      const guardedRepository = new PrismaDriverEventRepository(prisma, { completionInvariantMode: 'GUARDED' });
      await expect(guardedRepository.recordDriverEvent({
        appVersion: '1.2.0', assignmentGeneration: '1', clientEventId: 'guarded-incomplete', deliveryStopId: null,
        driverContractVersion: 2, driverId: driverA, eventType: 'ROUTE_COMPLETED', expectedRouteVersionId: routeVersionId,
        latitude: null, longitude: null, occurredAt: new Date('2026-08-24T04:58:00.000Z'), payload: {},
        requestId: 'request-guarded-incomplete', routePlanId, shopDomain: 'g002-evidence.invalid', shopId, versionCode: 120
      })).rejects.toBeInstanceOf(DriverRouteCompletionIncompleteError);
      expect(await prisma.routePlan.findUniqueOrThrow({ where: { id: routePlanId } })).toMatchObject({ status: 'IN_PROGRESS' });
      expect(await prisma.driverEvent.count({ where: { clientEventId: 'guarded-incomplete' } })).toBe(0);
      await expect(receipts.lookup({ accountId: accountA, clientEventId: 'guarded-incomplete', routePlanId }))
        .resolves.toMatchObject({ errorCode: 'ROUTE_COMPLETION_INCOMPLETE', status: 'REJECTED' });
      const guardedReview = await prisma.driverRouteCompletionReview.findFirstOrThrow({ where: { routePlanId, decision: 'REJECTED' } });
      expect(guardedReview).toMatchObject({ receiptAware: true, routeVersionId, totalStopCount: 1, unresolvedStopCount: 1 });
      const reviewRepository = new PrismaDriverRouteCompletionReviewRepository(prisma, () => new Date('2026-08-24T05:01:00.000Z'));
      await reviewRepository.review({
        actor: 'route-ops:test', note: 'The immutable assignment snapshot correctly had one unresolved stop.',
        outcome: 'CONFIRMED_CORRECT', reviewId: guardedReview.id, shopDomain: 'g002-evidence.invalid', source: 'REPORT_RECONCILIATION'
      });
      expect(await prisma.driverRouteCompletionReviewHistory.findMany({ where: { reviewId: guardedReview.id } }))
        .toEqual([expect.objectContaining({ actor: 'route-ops:test', outcome: 'CONFIRMED_CORRECT', priorOutcome: null })]);
      await reviewRepository.review({
        actor: 'route-ops:test', note: 'Adversarial assessment history check.', outcome: 'FALSE_POSITIVE',
        reviewId: guardedReview.id, shopDomain: 'g002-evidence.invalid', source: 'REPORT_RECONCILIATION'
      });
      await reviewRepository.review({
        actor: 'route-ops:test', note: 'Latest assessment is correct but history remains.', outcome: 'CONFIRMED_CORRECT',
        reviewId: guardedReview.id, shopDomain: 'g002-evidence.invalid', source: 'REPORT_RECONCILIATION'
      });
      expect(await prisma.driverRouteCompletionReview.findUniqueOrThrow({ where: { id: guardedReview.id } }))
        .toMatchObject({ reviewOutcome: 'CONFIRMED_CORRECT' });
      expect(await prisma.driverRouteCompletionReviewHistory.count({ where: { reviewId: guardedReview.id, outcome: 'FALSE_POSITIVE' } })).toBe(1);
      expect(await prisma.driverRouteCompletionGateHistory.count({ where: { outcome: 'FALSE_POSITIVE' } })).toBe(1);

      await prisma.$executeRawUnsafe(`CREATE FUNCTION reject_completion_review_for_fault_test() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'fault-injected completion review failure'; END $$`);
      await prisma.$executeRawUnsafe(`CREATE TRIGGER reject_completion_review_for_fault_test
        BEFORE INSERT ON driver_route_completion_reviews FOR EACH ROW EXECUTE FUNCTION reject_completion_review_for_fault_test()`);
      try {
        await expect(guardedRepository.recordDriverEvent({
          appVersion: '1.2.0', assignmentGeneration: '1', clientEventId: 'guarded-fault', deliveryStopId: null,
          driverContractVersion: 2, driverId: driverA, eventType: 'ROUTE_COMPLETED', expectedRouteVersionId: routeVersionId,
          latitude: null, longitude: null, occurredAt: new Date('2026-08-24T04:58:30.000Z'), payload: {},
          requestId: 'request-guarded-fault-1', routePlanId, shopDomain: 'g002-evidence.invalid', shopId, versionCode: 120
        })).rejects.not.toBeInstanceOf(DriverRouteCompletionIncompleteError);
      } finally {
        await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS reject_completion_review_for_fault_test ON driver_route_completion_reviews');
        await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS reject_completion_review_for_fault_test()');
      }
      expect(await prisma.driverRouteCompletionReview.count({ where: { attempt: { clientEventId: 'guarded-fault' } } })).toBe(0);
      expect(await prisma.driverEvent.count({ where: { clientEventId: 'guarded-fault' } })).toBe(0);
      expect(await prisma.driverEventAttempt.findFirst({ where: { clientEventId: 'guarded-fault' }, orderBy: { attemptNumber: 'desc' } }))
        .toMatchObject({ status: 'FAILED' });
      expect(await prisma.routePlan.findUniqueOrThrow({ where: { id: routePlanId } })).toMatchObject({ status: 'IN_PROGRESS' });
      await expect(guardedRepository.recordDriverEvent({
        appVersion: '1.2.0', assignmentGeneration: '1', clientEventId: 'guarded-fault', deliveryStopId: null,
        driverContractVersion: 2, driverId: driverA, eventType: 'ROUTE_COMPLETED', expectedRouteVersionId: routeVersionId,
        latitude: null, longitude: null, occurredAt: new Date('2026-08-24T04:58:30.000Z'), payload: {},
        requestId: 'request-guarded-fault-2', routePlanId, shopDomain: 'g002-evidence.invalid', shopId, versionCode: 120
      })).rejects.toBeInstanceOf(DriverRouteCompletionIncompleteError);
      expect(await prisma.driverEventAttempt.findFirst({ where: { clientEventId: 'guarded-fault' }, orderBy: { attemptNumber: 'desc' } }))
        .toMatchObject({ attemptNumber: 2, status: 'REJECTED' });
      expect(await prisma.driverRouteCompletionReview.count({ where: { attempt: { clientEventId: 'guarded-fault' } } })).toBe(1);

      const malformedAdmission = await repository.admitDriverEventAttempt({
        appVersion: null, assignmentGeneration: null, clientEventId: null, driverContractVersion: 2,
        driverId: driverA, eventType: null, expectedRouteVersionId: null, occurredAt: null,
        requestId: 'request-malformed', routePlanId, shopId, versionCode: null
      });
      expect(await prisma.driverEventAttempt.findUnique({ where: { id: malformedAdmission.attemptId } }))
        .toMatchObject({ clientEventId: null, eventType: null, status: 'ACCEPTED' });

      const first = await repository.admitDriverEventAttempt(admissionInput({
        clientEventId: 'retry-lineage', driverId: driverA, requestId: 'request-lineage-1', routePlanId, shopId
      }));
      const second = await repository.admitDriverEventAttempt(admissionInput({
        clientEventId: 'retry-lineage', driverId: driverA, requestId: 'request-lineage-2', routePlanId, shopId
      }));
      const replayedRequest = await repository.admitDriverEventAttempt(admissionInput({
        clientEventId: 'retry-lineage', driverId: driverA, requestId: 'request-lineage-2', routePlanId, shopId
      }));
      expect([first.attemptNumber, second.attemptNumber, replayedRequest.attemptNumber]).toEqual([1, 2, 3]);
      expect(replayedRequest.attemptId).not.toBe(second.attemptId);
      const concurrent = await Promise.all([
        repository.admitDriverEventAttempt(admissionInput({
          clientEventId: 'retry-lineage', driverId: driverA, requestId: 'request-lineage-3', routePlanId, shopId
        })),
        repository.admitDriverEventAttempt(admissionInput({
          clientEventId: 'retry-lineage', driverId: driverA, requestId: 'request-lineage-4', routePlanId, shopId
        }))
      ]);
      expect(concurrent.map(({ attemptNumber }) => attemptNumber).sort((left, right) => left - right)).toEqual([4, 5]);

      const crossDriverSameTransportId = await repository.admitDriverEventAttempt(admissionInput({
        clientEventId: 'cross-driver-request', driverId: driverB, requestId: 'request-lineage-2', routePlanId, shopId
      }));
      expect(crossDriverSameTransportId.attemptId).not.toBe(second.attemptId);
      const transportCollisions = await prisma.driverEventAttempt.findMany({
        where: { shopId, transportRequestId: 'request-lineage-2' }
      });
      expect(transportCollisions).toHaveLength(3);
      expect(new Set(transportCollisions.map(({ requestId }) => requestId)).size).toBe(3);

      await expect(repository.recordDriverEvent({
        appVersion: '1.2.0', assignmentGeneration: '1', clientEventId: 'rollback-event', deliveryStopId: null,
        driverContractVersion: 2, driverId: driverA, eventType: 'ROUTE_COMPLETED',
        expectedRouteVersionId: '50000000-0000-4000-8000-000000000099', latitude: null, longitude: null,
        occurredAt: new Date('2026-08-24T04:59:00.000Z'), payload: {}, requestId: 'request-rollback',
        routePlanId, shopDomain: 'g002-evidence.invalid', shopId, versionCode: 120
      })).rejects.toBeInstanceOf(DriverEventRouteVersionMismatchError);
      expect(await prisma.driverEvent.count({ where: { clientEventId: 'rollback-event' } })).toBe(0);
      expect(await prisma.driverEventAttempt.findFirst({ where: { transportRequestId: 'request-rollback' } }))
        .toMatchObject({ errorCode: 'ROUTE_VERSION_MISMATCH', status: 'REJECTED' });

      const committedAdmission = await repository.admitDriverEventAttempt(admissionInput({
        clientEventId: 'committed-gap', driverId: driverA, requestId: 'request-committed-gap', routePlanId, shopId
      }));
      await prisma.driverEvent.create({
        data: {
          assignmentGeneration: 1n, clientEventId: 'committed-gap', driverContractVersion: 2, driverId: driverA,
          eventType: 'ROUTE_COMPLETED', expectedRouteVersionId: routeVersionId, occurredAt: new Date(), payload: {},
          routePlanId, routeVersionId, shopId
        }
      });
      expect(await prisma.driverEventAttempt.findUnique({ where: { id: committedAdmission.attemptId } }))
        .toMatchObject({ status: 'ACCEPTED' });
      await expect(receipts.lookup({ accountId: accountA, clientEventId: 'committed-gap', routePlanId }))
        .resolves.toMatchObject({ status: 'APPLIED' });
      await expect(receipts.lookup({ accountId: accountB, clientEventId: 'committed-gap', routePlanId }))
        .rejects.toBeInstanceOf(DriverEventReceiptScopeError);

      const rejected = await repository.admitDriverEventAttempt(admissionInput({
        clientEventId: 'rejected-event', driverId: driverA, requestId: 'request-rejected', routePlanId, shopId
      }));
      await repository.finalizeDriverEventAttempt(rejected.attemptId, {
        errorCode: 'ROUTE_ASSIGNMENT_CHANGED', failureStage: 'CONTRACT_VALIDATION', retryable: false, status: 'REJECTED'
      });
      await expect(receipts.lookup({ accountId: accountA, clientEventId: 'rejected-event', routePlanId }))
        .resolves.toMatchObject({ errorCode: 'ROUTE_ASSIGNMENT_CHANGED', status: 'REJECTED' });

      const unresolved = await repository.admitDriverEventAttempt(admissionInput({
        clientEventId: 'unknown-event', driverId: driverA, requestId: 'request-unknown', routePlanId, shopId
      }));
      await repository.finalizeDriverEventAttempt(unresolved.attemptId, {
        errorCode: 'DRIVER_EVENT_TRANSIENT_FAILURE', failureStage: 'BUSINESS_TRANSACTION', retryable: true, status: 'FAILED'
      });
      await expect(receipts.lookup({ accountId: accountA, clientEventId: 'unknown-event', routePlanId }))
        .resolves.toMatchObject({ errorCode: null, status: 'UNKNOWN' });

      const priorChild = await prisma.routeGroupingChildVersion.findUniqueOrThrow({ where: { id: routeVersionId } });
      const priorSnapshot = structuredClone(priorChild.snapshot);
      const assignedOrder = await prisma.order.findFirstOrThrow({ where: { deliveryStops: { some: { id: '61000000-0000-4000-8000-000000000010' } } } });
      const nextChildId = await prisma.$transaction((transaction) => replaceCurrentRouteGroupingChildVersion(transaction, {
        currentChildId: priorChild.id,
        driverId: priorChild.driverId,
        groupingId: priorChild.groupingId,
        groupingVersionId: priorChild.groupingVersionId,
        notificationStatus: priorChild.notificationStatus,
        orderIds: [assignedOrder.id],
        publishedAt: priorChild.publishedAt,
        routePlanId: priorChild.routePlanId,
        shopId: priorChild.shopId,
        snapshot: { stops: [{ deliveryStopId: '61000000-0000-4000-8000-000000000010', orderId: assignedOrder.id }], immutableSuccessor: true },
        version: priorChild.version
      }));
      expect(await prisma.routeGroupingChildVersion.findUniqueOrThrow({ where: { id: routeVersionId } }))
        .toMatchObject({ snapshot: priorSnapshot, status: 'ARCHIVED' });
      expect(await prisma.routeGroupingChildVersion.findUniqueOrThrow({ where: { id: nextChildId } }))
        .toMatchObject({ status: 'CURRENT' });
      expect(await prisma.order.findUniqueOrThrow({ where: { id: assignedOrder.id } }))
        .toMatchObject({ currentRouteVersionId: nextChildId });

      const addedDraft = await routeGroupingService.createCustomStop({
        actor: 'route-ops:test', groupingId: priorChild.groupingId, shopDomain: 'g002-evidence.invalid',
        stopName: 'In-progress draft append'
      });
      expect(addedDraft).not.toBeNull();
      const addedDraftOrder = await prisma.order.findFirstOrThrow({ where: { name: 'In-progress draft append', shopId } });
      await prisma.$transaction((transaction) => routeGroupingService.saveDraftInTransaction(transaction, {
        groupingId: priorChild.groupingId,
        routes: [
          { branchId: null, orderIds: [assignedOrder.id, addedDraftOrder.id], routePlanId },
          { branchId: null, orderIds: [], routePlanId: siblingRoutePlanId }
        ],
        shopDomain: 'g002-evidence.invalid'
      }));
      expect(await prisma.routePlan.findUniqueOrThrow({ where: { id: routePlanId } })).toMatchObject({ status: 'IN_PROGRESS' });
      expect(await prisma.routePlanStop.count({ where: { routePlanId } })).toBe(2);
      const savedDraftChild = await prisma.routeGroupingChildVersion.findFirstOrThrow({
        where: { routePlanId, status: 'CURRENT', supersededAt: null }
      });
      expect(savedDraftChild.id).not.toBe(nextChildId);
      expect(await prisma.order.findUniqueOrThrow({ where: { id: addedDraftOrder.id } }))
        .toMatchObject({ currentRouteVersionId: savedDraftChild.id });

      const unresolvedMembership = await prisma.routeGroupingOrder.findUniqueOrThrow({
        where: { groupingId_orderId: { groupingId: priorChild.groupingId, orderId: assignedOrder.id } }
      });
      await prisma.routeGroupingOrder.delete({ where: { id: unresolvedMembership.id } });
      await expect(routeGroupingService.createCustomStop({
        actor: 'route-ops:test', groupingId: priorChild.groupingId, shopDomain: 'g002-evidence.invalid',
        stopName: 'Must roll back unresolved membership', targetRoutePlanId: routePlanId
      })).rejects.toMatchObject({ code: 'ROUTE_GROUPING_INVALID' });
      expect(await prisma.order.count({ where: { name: 'Must roll back unresolved membership', shopId } })).toBe(0);
      expect(await prisma.routePlanStop.count({ where: { routePlanId } })).toBe(2);
      expect((await prisma.routeGroupingChildVersion.findFirstOrThrow({
        where: { routePlanId, status: 'CURRENT', supersededAt: null }
      })).id).toBe(savedDraftChild.id);
      await prisma.routeGroupingOrder.create({ data: {
        assignedDriverId: unresolvedMembership.assignedDriverId,
        assignedPolygonId: unresolvedMembership.assignedPolygonId,
        assignmentStatus: unresolvedMembership.assignmentStatus,
        deliveryStopId: unresolvedMembership.deliveryStopId,
        groupingId: unresolvedMembership.groupingId,
        id: unresolvedMembership.id,
        orderId: unresolvedMembership.orderId,
        shopId: unresolvedMembership.shopId,
        sourceSequence: unresolvedMembership.sourceSequence
      } });
      await prisma.routeGroupingChildVersion.update({
        data: { snapshot: { stops: [{ deliveryStopId: '61000000-0000-4000-8000-000000000010', orderId: addedDraftOrder.id }] } },
        where: { id: savedDraftChild.id }
      });
      await expect(routeGroupingService.createCustomStop({
        actor: 'route-ops:test', groupingId: priorChild.groupingId, shopDomain: 'g002-evidence.invalid',
        stopName: 'Must roll back tuple mismatch', targetRoutePlanId: routePlanId
      })).rejects.toMatchObject({ code: 'ROUTE_GROUPING_INVALID' });
      expect(await prisma.order.count({ where: { name: 'Must roll back tuple mismatch', shopId } })).toBe(0);
      expect((await prisma.routeGroupingChildVersion.findFirstOrThrow({
        where: { routePlanId, status: 'CURRENT', supersededAt: null }
      })).id).toBe(savedDraftChild.id);
      await prisma.routeGroupingChildVersion.update({
        data: { snapshot: { stops: { deliveryStopId: 'not-an-array' } } }, where: { id: savedDraftChild.id }
      });
      await expect(routeGroupingService.createCustomStop({
        actor: 'route-ops:test', groupingId: priorChild.groupingId, shopDomain: 'g002-evidence.invalid',
        stopName: 'Must roll back malformed snapshot', targetRoutePlanId: routePlanId
      })).rejects.toMatchObject({ code: 'ROUTE_GROUPING_INVALID' });
      expect(await prisma.order.count({ where: { name: 'Must roll back malformed snapshot', shopId } })).toBe(0);
      await prisma.routeGroupingChildVersion.update({
        data: { snapshot: savedDraftChild.snapshot as Prisma.InputJsonValue }, where: { id: savedDraftChild.id }
      });

      const publicDraft = await routeGroupingService.createCustomStop({
        actor: 'route-ops:test', groupingId: priorChild.groupingId, shopDomain: 'g002-evidence.invalid',
        stopName: 'Public draft append after driver change'
      });
      expect(publicDraft).not.toBeNull();
      const publicDraftOrder = await prisma.order.findFirstOrThrow({
        where: { name: 'Public draft append after driver change', shopId }
      });
      await prisma.shop.update({
        data: { defaultDepotLatitude: 43.45, defaultDepotLongitude: -80.49 }, where: { id: shopId }
      });
      await prisma.deliveryStop.updateMany({
        data: { latitude: 43.46, longitude: -80.48 },
        where: { orderId: { in: [assignedOrder.id, addedDraftOrder.id, publicDraftOrder.id] } }
      });
      await expect(routeGroupingService.updateGroupingOrders({
        addOrderIds: [publicDraftOrder.id],
        groupingId: priorChild.groupingId,
        removeOrderIds: [assignedOrder.id],
        shopDomain: 'g002-evidence.invalid',
        targetRoutePlanId: routePlanId
      })).rejects.toMatchObject({ code: 'ROUTE_GROUPING_INVALID' });
      expect(await prisma.routeGroupingOrder.count({
        where: { groupingId: priorChild.groupingId, orderId: { in: [assignedOrder.id, publicDraftOrder.id] } }
      })).toBe(2);
      expect(await prisma.routePlanStop.count({ where: { routePlanId } })).toBe(2);
      expect((await prisma.routeGroupingChildVersion.findFirstOrThrow({
        where: { routePlanId, status: 'CURRENT', supersededAt: null }
      })).id).toBe(savedDraftChild.id);
      const assignmentGate = new pg.Client({ connectionString: databaseUrl });
      await assignmentGate.connect();
      try {
        await assignmentGate.query('BEGIN');
        await assignmentGate.query('SELECT id FROM route_plans WHERE id = $1 FOR UPDATE', [routePlanId]);
        let assignmentSettled = false;
        const driverAssignment = routePlanRepository.assignRoutePlanDriver({
          payload: { driverId: driverB }, routePlanId, shopDomain: 'g002-evidence.invalid'
        }).finally(() => { assignmentSettled = true; });
        await new Promise((resolve) => setTimeout(resolve, 75));
        expect(assignmentSettled).toBe(false);
        let draftSettled = false;
        const save = routeGroupingService.saveDraft({
          groupingId: priorChild.groupingId,
          mode: 'MANUAL_ORDER',
          routes: [
            { branchId: null, orderIds: [assignedOrder.id, addedDraftOrder.id, publicDraftOrder.id], routePlanId },
            { branchId: null, orderIds: [], routePlanId: siblingRoutePlanId }
          ],
          shopDomain: 'g002-evidence.invalid'
        }).finally(() => { draftSettled = true; });
        await new Promise((resolve) => setTimeout(resolve, 75));
        expect(draftSettled).toBe(false);
        await assignmentGate.query('COMMIT');
        await expect(driverAssignment).resolves.toMatchObject({ routePlan: { driverId: driverB } });
        await expect(save).resolves.not.toBeNull();
      } finally {
        await assignmentGate.query('ROLLBACK').catch(() => undefined);
        await assignmentGate.end();
      }
      expect(await prisma.routePlan.findUniqueOrThrow({ where: { id: routePlanId } }))
        .toMatchObject({ assignmentGeneration: 2n, driverId: driverB, status: 'IN_PROGRESS' });
      expect(await prisma.routePlanStop.count({ where: { routePlanId } })).toBe(3);
      const publicSavedChild = await prisma.routeGroupingChildVersion.findFirstOrThrow({
        where: { routePlanId, status: 'CURRENT', supersededAt: null }
      });
      expect(publicSavedChild.driverId).toBe(driverB);
      expect(await prisma.order.findUniqueOrThrow({ where: { id: publicDraftOrder.id } }))
        .toMatchObject({ currentRouteVersionId: publicSavedChild.id });

      const optimizedRouteEndModes: string[] = [];
      const geometryRouteEndModes: string[] = [];
      const reOptimizationService = new PrismaRouteGroupingService(
        prisma,
        new FakeDriverPushProvider(),
        undefined,
        {
          optimizeStopOrder: ({ detail }) => {
            optimizedRouteEndModes.push(detail.routePlan.routeEndMode);
            return Promise.resolve({
            missingCoordinateStops: 0,
            source: 'vroom',
            stops: [...detail.stops].reverse().map((stop, index) => ({
              deliveryStopId: stop.deliveryStopId,
              sequence: index + 1,
              shopifyOrderGid: stop.shopifyOrderGid
            }))
            });
          }
        },
        {
          buildRoute: (detail) => {
            geometryRouteEndModes.push(detail.routePlan.routeEndMode);
            return Promise.resolve({
            routeGeometry: { coordinates: [[-80.49, 43.45], [-80.48, 43.46]], type: 'LineString' },
            routeMetrics: { distanceMeters: 1, durationSeconds: 1 },
            routeStopPoints: []
            });
          }
        }
      );
      await expect(reOptimizationService.reOptimizeRoutes({
        actor: 'route-ops:test', groupingId: priorChild.groupingId, shopDomain: 'g002-evidence.invalid'
      })).rejects.toMatchObject({ code: 'ROUTE_GROUPING_INVALID' });
      const addedDraftStop = await prisma.deliveryStop.findFirstOrThrow({ where: { orderId: addedDraftOrder.id } });
      const publicDraftStop = await prisma.deliveryStop.findFirstOrThrow({ where: { orderId: publicDraftOrder.id } });
      expect((await prisma.routePlanStop.findMany({ where: { routePlanId }, orderBy: { sequence: 'asc' } }))
        .map(({ deliveryStopId }) => deliveryStopId)).toEqual([
          '61000000-0000-4000-8000-000000000010',
          addedDraftStop.id,
          publicDraftStop.id
        ]);
      expect((await prisma.routeGroupingChildVersion.findFirstOrThrow({
        where: { routePlanId, status: 'CURRENT', supersededAt: null }
      })).id).toBe(publicSavedChild.id);

      await prisma.routePlan.update({ data: { status: 'READY' }, where: { id: routePlanId } });
      const reOptimizationGate = new pg.Client({ connectionString: databaseUrl });
      await reOptimizationGate.connect();
      try {
        await reOptimizationGate.query('BEGIN');
        await reOptimizationGate.query(
          'UPDATE route_plans SET name = $2, constraints = $3::jsonb WHERE id = $1',
          [routePlanId, 'Concurrent authoritative name', JSON.stringify({
            departureTime: '08:30',
            scheduledStartAt: '2026-08-24T12:30:00.000Z',
            scheduledStartTimeZone: 'America/Toronto',
            routeEndMode: 'END_AT_LAST_STOP'
          })]
        );
        const concurrentAssignment = routePlanRepository.assignRoutePlanDriver({
          payload: { driverId: driverA }, routePlanId, shopDomain: 'g002-evidence.invalid'
        });
        await new Promise((resolve) => setTimeout(resolve, 75));
        let reOptimizationSettled = false;
        const reOptimization = reOptimizationService.reOptimizeRoutes({
          actor: 'route-ops:test', groupingId: priorChild.groupingId, shopDomain: 'g002-evidence.invalid'
        }).finally(() => { reOptimizationSettled = true; });
        const reOptimizationRejection = expect(reOptimization).rejects.toMatchObject({
          code: 'ROUTE_GROUPING_STALE_WRITE'
        });
        await new Promise((resolve) => setTimeout(resolve, 75));
        expect(reOptimizationSettled).toBe(false);
        await reOptimizationGate.query('COMMIT');
        await expect(concurrentAssignment).resolves.toMatchObject({ routePlan: { driverId: driverA } });
        await reOptimizationRejection;
      } finally {
        await reOptimizationGate.query('ROLLBACK').catch(() => undefined);
        await reOptimizationGate.end();
      }
      expect(await prisma.routePlan.findUniqueOrThrow({ where: { id: routePlanId } })).toMatchObject({
        assignmentGeneration: 3n,
        constraints: {
          departureTime: '08:30',
          scheduledStartAt: '2026-08-24T12:30:00.000Z',
          scheduledStartTimeZone: 'America/Toronto',
          routeEndMode: 'END_AT_LAST_STOP'
        },
        driverId: driverA,
        name: 'Concurrent authoritative name',
        status: 'READY'
      });
      expect((await prisma.routeGroupingChildVersion.findFirstOrThrow({
        where: { routePlanId, status: 'CURRENT', supersededAt: null }
      })).id).toBe(publicSavedChild.id);
      await expect(reOptimizationService.reOptimizeRoutes({
        actor: 'route-ops:test', groupingId: priorChild.groupingId, shopDomain: 'g002-evidence.invalid'
      })).resolves.not.toBeNull();
      const reOptimizedChild = await prisma.routeGroupingChildVersion.findFirstOrThrow({
        where: { routePlanId, status: 'CURRENT', supersededAt: null }
      });
      expect(reOptimizedChild).toMatchObject({ driverId: driverA });
      expect(reOptimizedChild.snapshot).toMatchObject({ name: 'Concurrent authoritative name' });
      expect(optimizedRouteEndModes.at(-1)).toBe('END_AT_LAST_STOP');
      expect(geometryRouteEndModes.at(-1)).toBe('END_AT_LAST_STOP');
      expect(await prisma.routePlan.findUniqueOrThrow({ where: { id: routePlanId } })).toMatchObject({
        constraints: { routeEndMode: 'END_AT_LAST_STOP', scheduledStartAt: '2026-08-24T12:30:00.000Z' }
      });

      for (const status of ['COMPLETED', 'CANCELLED'] as const) {
        await prisma.routePlan.update({ data: { status }, where: { id: routePlanId } });
        await expect(routeGroupingService.saveDraft({
          groupingId: priorChild.groupingId,
          mode: 'MANUAL_ORDER',
          routes: [
            { branchId: null, label: `forbidden ${status}`, orderIds: [assignedOrder.id, addedDraftOrder.id, publicDraftOrder.id], routePlanId },
            { branchId: null, orderIds: [], routePlanId: siblingRoutePlanId }
          ],
          shopDomain: 'g002-evidence.invalid'
        })).rejects.toMatchObject({ code: 'ROUTE_GROUPING_INVALID' });
      }
      await prisma.routePlan.update({ data: { status: 'IN_PROGRESS' }, where: { id: routePlanId } });

      await prisma.driverEventAttempt.updateMany({
        data: { retainedUntil: new Date('2026-08-23T00:00:00.000Z') },
        where: { id: { in: [rejected.attemptId, unresolved.attemptId, first.attemptId] } }
      });
      await cleanupResolvedDriverEventAttempts(prisma, new Date('2026-08-24T00:00:00.000Z'));
      expect(await prisma.driverEventAttempt.findUnique({ where: { id: rejected.attemptId } })).toMatchObject({ reconciledAt: null, status: 'REJECTED' });
      await expect(repository.reconcileRejectedDriverEventAttempt({
        attemptId: rejected.attemptId, reconciliationCode: 'CONFIRMED_REJECTED', shopId: '10000000-0000-4000-8000-000000000099'
      })).resolves.toBe(false);
      await expect(repository.reconcileRejectedDriverEventAttempt({
        attemptId: rejected.attemptId, reconciliationCode: 'CONFIRMED_REJECTED', shopId
      })).resolves.toBe(true);
      await cleanupResolvedDriverEventAttempts(prisma, new Date('2026-08-24T00:00:00.000Z'));
      expect(await prisma.driverEventAttempt.findUnique({ where: { id: rejected.attemptId } })).toBeNull();
      expect(await prisma.driverEventAttempt.findUnique({ where: { id: unresolved.attemptId } })).toMatchObject({ status: 'FAILED' });
      expect(await prisma.driverEventAttempt.findUnique({ where: { id: first.attemptId } })).toMatchObject({ status: 'ACCEPTED' });

      await prisma.driverRouteCompletionReview.update({
        data: { retainedUntil: new Date('2027-08-25T00:00:00.000Z') }, where: { id: guardedReview.id }
      });
      await prisma.driverRouteCompletionReview.delete({ where: { id: guardedReview.id } });
      expect(await prisma.driverRouteCompletionReviewHistory.count({ where: { reviewId: guardedReview.id } })).toBe(0);
      expect(await prisma.driverRouteCompletionGateHistory.count({ where: { outcome: 'FALSE_POSITIVE' } })).toBe(1);
      await cleanupReviewedRouteCompletionEvidence(prisma, new Date('2027-08-26T00:00:00.000Z'));
      expect(await prisma.driverRouteCompletionReview.findUnique({ where: { id: guardedReview.id } })).toBeNull();
      expect(await prisma.driverRouteCompletionReviewHistory.count({ where: { reviewId: guardedReview.id } })).toBe(0);
      expect(await prisma.driverRouteCompletionGateHistory.count()).toBe(0);
    } finally {
      await prisma.$disconnect();
    }
  }, 15_000);
});

function admissionInput(input: { clientEventId: string; driverId: string; requestId: string; routePlanId: string; shopId: string }) {
  return {
    appVersion: '1.2.0', assignmentGeneration: '1', clientEventId: input.clientEventId,
    driverContractVersion: 2 as const, driverId: input.driverId, eventType: 'ROUTE_COMPLETED',
    expectedRouteVersionId: '50000000-0000-4000-8000-000000000010', occurredAt: new Date(),
    requestId: input.requestId, routePlanId: input.routePlanId, shopId: input.shopId, versionCode: 120
  };
}

async function seedEvidenceFixture(prisma: PrismaClient, input: {
  accountA: string; accountB: string; driverA: string; driverB: string; routePlanId: string; routeVersionId: string; shopId: string;
}): Promise<void> {
  await prisma.$executeRawUnsafe(`INSERT INTO shops (id, "shopDomain", "createdAt", "updatedAt") VALUES
    ('${input.shopId}', 'g002-evidence.invalid', now(), now())`);
  await prisma.$executeRawUnsafe(`INSERT INTO driver_accounts (id, phone, "createdAt", "updatedAt") VALUES
    ('${input.accountA}', '+15550000010', now(), now()), ('${input.accountB}', '+15550000011', now(), now())`);
  await prisma.$executeRawUnsafe(`INSERT INTO drivers (id, "accountId", "shopId", "displayName", "createdAt", "updatedAt") VALUES
    ('${input.driverA}', '${input.accountA}', '${input.shopId}', 'Evidence A', now(), now()),
    ('${input.driverB}', '${input.accountB}', '${input.shopId}', 'Evidence B', now(), now())`);
  await prisma.$executeRawUnsafe(`INSERT INTO route_plans
    (id, "shopId", name, "planDate", status, "driverId", "optimizerVersion", constraints, metrics, "createdAt", "updatedAt") VALUES
    ('${input.routePlanId}', '${input.shopId}', 'Evidence', '2026-08-24', 'IN_PROGRESS', '${input.driverA}', 'test', '{}', '{}', now(), now())`);
  await prisma.$executeRawUnsafe(`INSERT INTO route_groupings
    (id, "shopId", name, "planDate", status, "currentVersion", "createdAt", "updatedAt") VALUES
    ('40000000-0000-4000-8000-000000000010', '${input.shopId}', 'Evidence', '2026-08-24', 'READY', 1, now(), now())`);
  await prisma.$executeRawUnsafe(`INSERT INTO route_grouping_versions
    (id, "shopId", "groupingId", version, status, "createdAt") VALUES
    ('41000000-0000-4000-8000-000000000010', '${input.shopId}', '40000000-0000-4000-8000-000000000010', 1, 'CURRENT', now())`);
  await prisma.$executeRawUnsafe(`INSERT INTO route_grouping_child_versions
    (id, "shopId", "groupingId", "groupingVersionId", "driverId", "routePlanId", version, status, snapshot, "createdAt", "updatedAt") VALUES
    ('${input.routeVersionId}', '${input.shopId}', '40000000-0000-4000-8000-000000000010',
     '41000000-0000-4000-8000-000000000010', '${input.driverA}', '${input.routePlanId}', 1, 'CURRENT', '{"stops":[]}', now(), now())`);
}

async function lock(client: pg.Client): Promise<{ assignmentGeneration: string; driverId: string | null }> {
  const result = await client.query<{ assignmentGeneration: string; driverId: string | null }>(`SELECT "driverId", "assignmentGeneration"::text
    FROM route_plans WHERE id = '30000000-0000-4000-8000-000000000001' FOR UPDATE`);
  const row = result.rows[0];
  if (row === undefined) throw new Error('Disposable route plan was not found');
  return row;
}

async function assignWhenChanged(client: pg.Client, driverId: string): Promise<void> {
  await client.query(`UPDATE route_plans SET "driverId" = $1, "assignmentGeneration" = "assignmentGeneration" + 1
    WHERE id = '30000000-0000-4000-8000-000000000001' AND "driverId" IS DISTINCT FROM $1::uuid`, [driverId]);
}

async function distinctAssignment(client: pg.Client, driverId: string): Promise<void> {
  await client.query('BEGIN');
  await lock(client);
  await assignWhenChanged(client, driverId);
  await client.query('COMMIT');
}

function assertDisposableDatabase(): void {
  if (process.env.G002_DATABASE_TARGET_CLASS !== 'safe-local-g002-disposable' || !databaseUrl.includes('127.0.0.1:55488/clever_g002')) {
    throw new Error('Refusing non-disposable G002 database target');
  }
}
