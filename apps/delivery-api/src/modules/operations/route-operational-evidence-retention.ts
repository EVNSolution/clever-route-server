import { Prisma, type PrismaClient } from '@prisma/client';
import {
  createRouteTrackingGeometryWrite,
  pruneRouteTrackingGeometryDocument,
  readRouteTrackingGeometryDocument,
  ROUTE_TRACKING_GEOMETRY_RETENTION_DAYS
} from '../route-tracking/route-tracking.geometry.js';

const SYNC_HISTORY_DAYS = 30;

type OperationalEvidencePrisma = Pick<
  PrismaClient,
  '$queryRaw' | '$transaction' | 'alertCycle' | 'customerDeliveryNotificationAttempt' | 'driverEvent' | 'driverSyncHeartbeat' | 'driverSyncSession' | 'routeTrackingGeometry'
>;

const LOCATION_RETENTION_BATCH_SIZE = 1_000;
const LOCATION_RETENTION_MAX_ROWS = 10_000;
const RETENTION_JOB_DEADLINE_MS = 2 * 60 * 1000;
const SYNC_RETENTION_BATCH_SIZE = 1_000;
const SYNC_RETENTION_MAX_ROWS = 10_000;
const TERMINAL_EVIDENCE_BATCH_SIZE = 1_000;
const TERMINAL_EVIDENCE_MAX_ROWS = 10_000;

export async function cleanupRouteOperationalEvidence(
  prisma: OperationalEvidencePrisma,
  now = new Date(),
  options: {
    deadlineAt?: number;
    locationBatchSize?: number;
    locationMaxRows?: number;
    syncBatchSize?: number;
    syncMaxRows?: number;
    reconciliationBatchSize?: number;
    reconciliationMaxRows?: number;
    terminalBatchSize?: number;
    terminalMaxRows?: number;
  } = {}
): Promise<{
  alertCycles: number;
  alertCyclesContinuationRequired: boolean;
  emailReconciliationAudits: number;
  emailReconciliationAuditsContinuationRequired: boolean;
  locationEvents: number;
  notificationAttempts: number;
  notificationAttemptsContinuationRequired: boolean;
  notificationAttemptsReconciled: number;
  notificationAttemptReconciliationContinuationRequired: boolean;
  routeTrackingGeometries: number;
  locationContinuationRequired: boolean;
  syncContinuationRequired: boolean;
  syncHeartbeats: number;
  syncSessions: number;
}> {
  const syncCutoff = new Date(now.getTime() - SYNC_HISTORY_DAYS * 24 * 60 * 60 * 1000);
  const deadlineAt = Math.min(options.deadlineAt ?? Number.POSITIVE_INFINITY, Date.now() + RETENTION_JOB_DEADLINE_MS);
  const syncBatchSize = options.syncBatchSize ?? SYNC_RETENTION_BATCH_SIZE;
  const syncMaxRows = options.syncMaxRows ?? SYNC_RETENTION_MAX_ROWS;
  let syncHeartbeats = 0;
  let syncSessions = 0;
  let syncContinuationRequired = false;
  for (;;) {
    const remainingCapacity = syncMaxRows - syncHeartbeats - syncSessions;
    if (remainingCapacity <= 0 || Date.now() >= deadlineAt) {
      syncContinuationRequired = true;
      break;
    }
    const batchSize = Math.min(syncBatchSize, remainingCapacity);
    const heartbeatIds = await prisma.driverSyncHeartbeat.findMany({
      orderBy: [{ retainedUntil: 'asc' }, { id: 'asc' }],
      select: { id: true },
      take: batchSize,
      where: {
        retainedUntil: { lt: now },
        syncSession: { leases: { none: { expiresAt: { gt: now }, revokedAt: null } } }
      }
    });
    syncHeartbeats += (await prisma.driverSyncHeartbeat.deleteMany({
      where: { id: { in: heartbeatIds.map(({ id }) => id) } }
    })).count;
    const sessionCapacity = syncMaxRows - syncHeartbeats - syncSessions;
    const sessionIds = sessionCapacity <= 0 ? [] : await prisma.driverSyncSession.findMany({
      orderBy: [{ lastObservedAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
      take: Math.min(batchSize, sessionCapacity),
      where: {
        lastObservedAt: { lt: syncCutoff },
        leases: { none: { expiresAt: { gt: now }, revokedAt: null } }
      }
    });
    syncSessions += (await prisma.driverSyncSession.deleteMany({
      where: { id: { in: sessionIds.map(({ id }) => id) } }
    })).count;
    if (heartbeatIds.length < batchSize && sessionIds.length < batchSize) break;
  }
  const locationCutoff = new Date(now.getTime() - ROUTE_TRACKING_GEOMETRY_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const locationBatchSize = options.locationBatchSize ?? LOCATION_RETENTION_BATCH_SIZE;
  const locationMaxRows = options.locationMaxRows ?? LOCATION_RETENTION_MAX_ROWS;
  const locationDeadlineAt = Math.min(
    options.deadlineAt ?? Number.POSITIVE_INFINITY,
    deadlineAt
  );
  const locationEvidence = await prisma.$transaction(async (tx) => {
    let locationEvents = 0;
    let routeTrackingGeometries = 0;
    let locationEvidenceScanned = 0;
    let locationContinuationRequired = false;
    for (;;) {
      const remainingCapacity = locationMaxRows - locationEvidenceScanned;
      if (remainingCapacity <= 0 || Date.now() >= locationDeadlineAt) {
        locationContinuationRequired = true;
        break;
      }
      const batchSize = Math.min(locationBatchSize, remainingCapacity);
      const geometries = await tx.routeTrackingGeometry.findMany({
        orderBy: { firstOccurredAt: 'asc' },
        take: batchSize,
        where: { firstOccurredAt: { lt: locationCutoff } }
      });
      locationEvidenceScanned += geometries.length;
      const eventCapacity = locationMaxRows - locationEvidenceScanned;
      const events = eventCapacity === 0 ? [] : await tx.driverEvent.findMany({
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
        select: { id: true },
        take: Math.min(batchSize, eventCapacity),
        where: {
          eventType: 'LOCATION_UPDATED',
          occurredAt: { lt: locationCutoff },
          OR: [{ latitude: { not: null } }, { longitude: { not: null } }]
        }
      });
      locationEvidenceScanned += events.length;
      for (const geometry of geometries) {
        await tx.$queryRaw(
          Prisma.sql`SELECT TRUE AS "locked" FROM pg_advisory_xact_lock(hashtextextended(${geometry.routePlanId}, 0))`
        );
        const currentGeometry = await tx.routeTrackingGeometry.findUnique({
          where: { routePlanId: geometry.routePlanId }
        });
        if (currentGeometry === null || currentGeometry.firstOccurredAt >= locationCutoff) continue;
        const document = pruneRouteTrackingGeometryDocument(
          readRouteTrackingGeometryDocument(currentGeometry),
          locationCutoff
        );
        if (document.samples.length === 0) {
          routeTrackingGeometries += (await tx.routeTrackingGeometry.deleteMany({
            where: { id: currentGeometry.id }
          })).count;
        } else {
          await tx.routeTrackingGeometry.update({
            data: createRouteTrackingGeometryWrite(geometry.routePlanId, document),
            where: { id: currentGeometry.id }
          });
          routeTrackingGeometries += 1;
        }
      }
      const updated = await tx.driverEvent.updateMany({
        data: {
          latitude: null,
          longitude: null,
          payload: { redacted: true, schema: 'driver_location_retention_tombstone_v1' }
        },
        where: { id: { in: events.map(({ id }) => id) } }
      });
      locationEvents += updated.count;
      if (events.length < batchSize && geometries.length < batchSize) break;
    }
    return { locationContinuationRequired, locationEvents, routeTrackingGeometries };
  });
  const reconciliation = await reconcileSentNotificationAttempts(prisma, now, {
    batchSize: options.reconciliationBatchSize ?? TERMINAL_EVIDENCE_BATCH_SIZE,
    deadlineAt,
    maxRows: options.reconciliationMaxRows ?? TERMINAL_EVIDENCE_MAX_ROWS
  });
  const terminal = await cleanupTerminalOperationalEvidence(prisma, now, {
    batchSize: options.terminalBatchSize ?? TERMINAL_EVIDENCE_BATCH_SIZE,
    deadlineAt,
    maxRows: options.terminalMaxRows ?? TERMINAL_EVIDENCE_MAX_ROWS
  });
  const emailReconciliationAudits = await cleanupEmailReconciliationAudits(prisma, now, {
    batchSize: options.terminalBatchSize ?? TERMINAL_EVIDENCE_BATCH_SIZE,
    deadlineAt,
    maxRows: options.terminalMaxRows ?? TERMINAL_EVIDENCE_MAX_ROWS
  });
  return {
    alertCycles: terminal.alertCycles,
    alertCyclesContinuationRequired: terminal.alertCyclesContinuationRequired,
    emailReconciliationAudits: emailReconciliationAudits.deleted,
    emailReconciliationAuditsContinuationRequired: emailReconciliationAudits.continuationRequired,
    ...locationEvidence,
    notificationAttempts: terminal.notificationAttempts,
    notificationAttemptsContinuationRequired: terminal.notificationAttemptsContinuationRequired,
    notificationAttemptsReconciled: reconciliation.notificationAttemptsReconciled,
    notificationAttemptReconciliationContinuationRequired: reconciliation.continuationRequired,
    syncContinuationRequired,
    syncHeartbeats,
    syncSessions
  };
}

async function cleanupEmailReconciliationAudits(
  prisma: OperationalEvidencePrisma,
  now: Date,
  options: { batchSize: number; deadlineAt: number; maxRows: number }
): Promise<{ continuationRequired: boolean; deleted: number }> {
  let deleted = 0;
  while (deleted < options.maxRows && Date.now() < options.deadlineAt) {
    const take = Math.min(options.batchSize, options.maxRows - deleted);
    const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      WITH candidates AS (
        SELECT "id"
        FROM "customer_email_operator_reconciliations"
        WHERE "retainedUntil" < ${now}
        ORDER BY "retainedUntil" ASC, "id" ASC
        LIMIT ${take}
        FOR UPDATE SKIP LOCKED
      )
      DELETE FROM "customer_email_operator_reconciliations" target
      USING candidates
      WHERE target."id" = candidates."id"
      RETURNING target."id"
    `);
    deleted += rows.length;
    if (rows.length < take) break;
  }
  const remaining = await prisma.$queryRaw<Array<{ exists: boolean }>>(Prisma.sql`
    SELECT EXISTS (
      SELECT 1 FROM "customer_email_operator_reconciliations"
      WHERE "retainedUntil" < ${now}
    ) AS "exists"
  `);
  return { continuationRequired: remaining[0]?.exists === true, deleted };
}

async function reconcileSentNotificationAttempts(
  prisma: OperationalEvidencePrisma,
  now: Date,
  options: { batchSize: number; deadlineAt: number; maxRows: number }
): Promise<{ continuationRequired: boolean; notificationAttemptsReconciled: number }> {
  let notificationAttemptsReconciled = 0;
  while (notificationAttemptsReconciled < options.maxRows && Date.now() < options.deadlineAt) {
    const take = Math.min(options.batchSize, options.maxRows - notificationAttemptsReconciled);
    const reconciled = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      WITH candidates AS (
        SELECT attempt."id"
        FROM "customer_delivery_notification_attempts" attempt
        LEFT JOIN "customer_route_notification_facts" fact ON fact."id" = attempt."factId"
        LEFT JOIN "customer_email_manual_dispatch_recipients" recipient ON recipient."id" = attempt."manualDispatchRecipientId"
        WHERE attempt."outcome" = 'STARTED'
          AND (fact."status" = 'SENT' OR recipient."status" = 'SENT')
        ORDER BY attempt."startedAt" ASC, attempt."id" ASC
        LIMIT ${take}
        FOR UPDATE OF attempt SKIP LOCKED
      )
      UPDATE "customer_delivery_notification_attempts" target
      SET "completedAt" = ${now}, "outcome" = 'SENT'
      FROM candidates
      WHERE target."id" = candidates."id"
      RETURNING target."id"
    `);
    notificationAttemptsReconciled += reconciled.length;
    if (reconciled.length < take) break;
  }
  const remaining = await prisma.$queryRaw<Array<{ exists: boolean }>>(Prisma.sql`
    SELECT EXISTS (
      SELECT 1
      FROM "customer_delivery_notification_attempts" attempt
      LEFT JOIN "customer_route_notification_facts" fact ON fact."id" = attempt."factId"
      LEFT JOIN "customer_email_manual_dispatch_recipients" recipient ON recipient."id" = attempt."manualDispatchRecipientId"
      WHERE attempt."outcome" = 'STARTED'
        AND (fact."status" = 'SENT' OR recipient."status" = 'SENT')
    ) AS "exists"
  `);
  return {
    continuationRequired: remaining[0]?.exists === true,
    notificationAttemptsReconciled
  };
}

async function cleanupTerminalOperationalEvidence(
  prisma: OperationalEvidencePrisma,
  now: Date,
  options: { batchSize: number; deadlineAt: number; maxRows: number }
): Promise<{
  alertCycles: number;
  alertCyclesContinuationRequired: boolean;
  notificationAttempts: number;
  notificationAttemptsContinuationRequired: boolean;
}> {
  let alertCycles = 0;
  let notificationAttempts = 0;
  let alertsDone = false;
  let notificationAttemptsDone = false;
  for (;;) {
    if (Date.now() >= options.deadlineAt || (alertsDone && notificationAttemptsDone)) break;
    const alertTake: number = alertsDone ? 0 : Math.min(options.batchSize, Math.max(0, options.maxRows - alertCycles));
    const attemptTake: number = notificationAttemptsDone ? 0 : Math.min(options.batchSize, Math.max(0, options.maxRows - notificationAttempts));
    const deletedAlerts = alertTake === 0 ? [] : await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      WITH candidates AS (
        SELECT "id"
        FROM "alert_cycles"
        WHERE "resolvedAt" IS NOT NULL
          AND "retainedUntil" < ${now}
        ORDER BY "retainedUntil" ASC, "id" ASC
        LIMIT ${alertTake}
        FOR UPDATE SKIP LOCKED
      )
      DELETE FROM "alert_cycles" target
      USING candidates
      WHERE target."id" = candidates."id"
      RETURNING target."id"
    `);
    const deletedAttempts = attemptTake === 0 ? [] : await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      WITH candidates AS (
        SELECT attempt."id"
        FROM "customer_delivery_notification_attempts" attempt
        LEFT JOIN "customer_route_notification_facts" fact ON fact."id" = attempt."factId"
        LEFT JOIN "customer_email_manual_dispatch_recipients" recipient ON recipient."id" = attempt."manualDispatchRecipientId"
        WHERE attempt."retainedUntil" < ${now}
          AND (fact."status" = 'SENT' OR recipient."status" = 'SENT')
        ORDER BY attempt."retainedUntil" ASC, attempt."id" ASC
        LIMIT ${attemptTake}
        FOR UPDATE OF attempt SKIP LOCKED
      )
      DELETE FROM "customer_delivery_notification_attempts" target
      USING candidates
      WHERE target."id" = candidates."id"
      RETURNING target."id"
    `);
    alertCycles += deletedAlerts.length;
    notificationAttempts += deletedAttempts.length;
    alertsDone = alertTake === 0 || deletedAlerts.length < alertTake;
    notificationAttemptsDone = attemptTake === 0 || deletedAttempts.length < attemptTake;
  }
  const [remainingAlerts, remainingAttempts] = await Promise.all([
    prisma.$queryRaw<Array<{ exists: boolean }>>(Prisma.sql`
      SELECT EXISTS (
        SELECT 1 FROM "alert_cycles"
        WHERE "resolvedAt" IS NOT NULL AND "retainedUntil" < ${now}
      ) AS "exists"
    `),
    prisma.$queryRaw<Array<{ exists: boolean }>>(Prisma.sql`
      SELECT EXISTS (
        SELECT 1
        FROM "customer_delivery_notification_attempts" attempt
        LEFT JOIN "customer_route_notification_facts" fact ON fact."id" = attempt."factId"
        LEFT JOIN "customer_email_manual_dispatch_recipients" recipient ON recipient."id" = attempt."manualDispatchRecipientId"
        WHERE attempt."retainedUntil" < ${now}
          AND (fact."status" = 'SENT' OR recipient."status" = 'SENT')
      ) AS "exists"
    `)
  ]);
  return {
    alertCycles,
    alertCyclesContinuationRequired: remainingAlerts[0]?.exists === true,
    notificationAttempts,
    notificationAttemptsContinuationRequired: remainingAttempts[0]?.exists === true
  };
}
