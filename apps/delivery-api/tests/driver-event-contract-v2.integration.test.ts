import pg from 'pg';
import { describe, expect, test } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { cleanupResolvedDriverEventAttempts } from '../src/modules/driver/driver-event-attempt-retention.js';
import {
  DriverEventRouteVersionMismatchError,
  DriverRouteCompletionIncompleteError,
  PrismaDriverEventRepository
} from '../src/modules/driver/driver-event.repository.js';
import {
  DriverEventReceiptScopeError,
  PrismaDriverEventReceiptRepository
} from '../src/modules/driver/driver-event-receipt.repository.js';
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
      await prisma.$executeRawUnsafe(`INSERT INTO route_plan_stops
        (id, "shopId", "routePlanId", "deliveryStopId", sequence, "createdAt", "updatedAt") VALUES
        ('62000000-0000-4000-8000-000000000010', '${shopId}', '${routePlanId}', '61000000-0000-4000-8000-000000000010', 1, now(), now())`);
      await prisma.routeGroupingChildVersion.update({
        data: { snapshot: { stops: [{ deliveryStopId: '61000000-0000-4000-8000-000000000010' }] } },
        where: { id: routeVersionId }
      });

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
    } finally {
      await prisma.$disconnect();
    }
  });
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
