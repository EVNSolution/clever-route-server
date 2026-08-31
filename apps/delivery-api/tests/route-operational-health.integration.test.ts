import { PrismaClient } from '@prisma/client';
import { describe, expect, test } from 'vitest';
import { PrismaDriverSyncHealthService, type DriverSyncHeartbeatInput } from '../src/modules/driver/driver-sync-health.service.js';
import { PrismaOperationalAlertRepository } from '../src/modules/notifications/operational-alert.repository.js';
import { PrismaCustomerDeliveryNotificationAttemptRepository } from '../src/modules/customer-email/customer-delivery-notification-attempt.repository.js';
import { PrismaAdminNotificationRepository } from '../src/modules/notifications/admin-notification.repository.js';
import { PrismaEmailRuntimeHealthService } from '../src/modules/customer-email/email-runtime-health.service.js';
import { PrismaRouteOperationalStateService } from '../src/modules/route-tracking/route-operational-state.service.js';
import { cleanupRouteOperationalEvidence } from '../src/modules/operations/route-operational-evidence-retention.js';

const databaseUrl = process.env.ROUTE_OPERATIONAL_HEALTH_DATABASE_URL ?? '';
const live = databaseUrl === '' ? test.skip : test;

describe('route operational health PostgreSQL contract', () => {
  live('fails future queue clocks closed while retaining server-observed queue age', async () => {
    assertDisposableDatabase();
    const prisma = client();
    const now = new Date('2026-08-24T08:00:00.000Z');
    const service = new PrismaDriverSyncHealthService(prisma, undefined, () => now);
    const fixture = await seed(prisma, '09');
    const context = { accountId: fixture.accountId, driverId: fixture.driverId, routePlanId: fixture.routePlanId, shopDomain: fixture.shopDomain, shopId: fixture.shopId };
    try {
      await expect(service.recordHeartbeat(context, heartbeat('z', 1, {
        clientOccurredAt: new Date('2026-08-25T08:00:00.000Z'),
        oldestQueuedAt: null,
        queueDepth: 0
      }))).resolves.toMatchObject({ accepted: true, syncHealth: { state: 'BLOCKED' } });
      await expect(prisma.driverSyncHeartbeat.findFirst({ where: { syncSession: { routePlanId: fixture.routePlanId } } }))
        .resolves.toMatchObject({ serverReceivedAt: now, state: 'BLOCKED' });
    } finally { await prisma.$disconnect(); }
  });

  live('rejects stale heartbeats and preserves lease history through explicit takeover', async () => {
    assertDisposableDatabase();
    const prisma = client();
    let now = new Date('2026-08-24T08:00:00.000Z');
    const alerts = new PrismaOperationalAlertRepository(prisma);
    const service = new PrismaDriverSyncHealthService(prisma, alerts, () => now);
    const fixture = await seed(prisma, '01');
    const context = { accountId: fixture.accountId, driverId: fixture.driverId, routePlanId: fixture.routePlanId, shopDomain: fixture.shopDomain, shopId: fixture.shopId };
    try {
      const first = await service.recordHeartbeat(context, heartbeat('a', 2));
      expect(first).toMatchObject({ accepted: true, conflict: false, syncHealth: { heartbeatSequence: 2, state: 'HEALTHY' } });
      await alerts.openOrObserve({ dedupeKey: `HEARTBEAT_ABSENT:${fixture.routePlanId}:${fixture.driverId}`, observedAt: now, routePlanId: fixture.routePlanId, severity: 'CRITICAL', shopId: fixture.shopId, title: 'absent', type: 'HEARTBEAT_ABSENT' });
      const stale = await service.recordHeartbeat(context, heartbeat('a', 1, { appVersion: 'stale-must-not-win' }));
      expect(stale).toMatchObject({ accepted: false, syncHealth: { heartbeatSequence: 2 } });
      expect(await prisma.alertCycle.count({ where: { condition: { shopId: fixture.shopId, type: 'HEARTBEAT_ABSENT' }, resolvedAt: null } })).toBe(1);
      expect(await prisma.driverSyncSession.findFirst({ where: { routePlanId: fixture.routePlanId } })).toMatchObject({ appVersion: '2.0.0', lastObservedAt: new Date('2026-08-24T08:00:00.000Z') });
      await service.recordHeartbeat(context, heartbeat('a', 3));
      expect(await prisma.alertCycle.count({ where: { condition: { shopId: fixture.shopId, type: 'HEARTBEAT_ABSENT' }, resolvedAt: null } })).toBe(0);
      await service.recordHeartbeat(context, heartbeat('a', 4, { oldestQueuedAt: new Date('2026-08-24T07:54:00.000Z'), queueDepth: 1 }));
      expect(await prisma.alertCycle.count({ where: { condition: { type: 'SYNC_QUEUE_STALE' }, resolvedAt: null } })).toBe(0);
      now = new Date('2026-08-24T08:05:01.000Z');
      await service.recordHeartbeat(context, heartbeat('a', 5, { oldestQueuedAt: new Date('2026-08-24T07:54:00.000Z'), queueDepth: 1 }));
      expect(await prisma.alertCycle.count({ where: { condition: { type: 'SYNC_QUEUE_STALE' }, resolvedAt: null } })).toBe(1);
      await service.recordHeartbeat(context, heartbeat('a', 6));
      expect(await prisma.alertCycle.count({ where: { condition: { type: 'SYNC_QUEUE_STALE' }, resolvedAt: null } })).toBe(0);
      await service.recordHeartbeat(context, heartbeat('a', 7, { completedStopCount: 2 }));
      expect(await prisma.alertCycle.count({ where: { condition: { type: 'PROGRESS_MISMATCH' }, resolvedAt: null } })).toBe(0);
      now = new Date('2026-08-24T08:07:02.000Z');
      await service.recordHeartbeat(context, heartbeat('a', 8, { completedStopCount: 2 }));
      expect(await prisma.alertCycle.count({ where: { condition: { type: 'PROGRESS_MISMATCH' }, resolvedAt: null } })).toBe(1);
      await service.recordHeartbeat(context, heartbeat('a', 9));
      expect(await prisma.alertCycle.count({ where: { condition: { type: 'PROGRESS_MISMATCH' }, resolvedAt: null } })).toBe(0);
      now = new Date('2026-08-24T08:09:03.000Z');
      await service.recordHeartbeat(context, heartbeat('a', 10, { completedStopCount: 2 }));
      expect(await prisma.alertCycle.count({ where: { condition: { type: 'PROGRESS_MISMATCH' }, resolvedAt: null } })).toBe(0);
      now = new Date('2026-08-24T08:11:04.000Z');
      await service.recordHeartbeat(context, heartbeat('a', 11, { completedStopCount: 2 }));
      expect(await prisma.alertCycle.count({ where: { condition: { type: 'PROGRESS_MISMATCH' }, resolvedAt: null } })).toBe(1);
      await service.recordHeartbeat(context, heartbeat('a', 12));
      const conflict = await service.recordHeartbeat(context, heartbeat('b', 1));
      expect(conflict).toMatchObject({ accepted: true, conflict: true, syncHealth: { state: 'BLOCKED' } });
      expect(await prisma.alertCycle.count({ where: { condition: { type: 'MULTI_DEVICE_CONFLICT' }, resolvedAt: null } })).toBe(1);
      await expect(service.getActiveSyncHealth(fixture.routePlanId, now)).resolves.toMatchObject({ state: 'BLOCKED' });
      const batchedConflictHealth = await service.getActiveSyncHealthForRoutePlans([fixture.routePlanId], now);
      expect(batchedConflictHealth.get(fixture.routePlanId)).toMatchObject({ state: 'BLOCKED' });
      await expect(service.takeover({
        accountId: '82000000-0000-4000-8000-000000000099',
        deviceInstanceHash: 'b'.repeat(64),
        routePlanId: fixture.routePlanId,
        sessionGeneration: '2026-08-24T07:00:00.000Z'
      })).resolves.toBe(false);
      expect(await prisma.driverRouteSessionLease.count({ where: { revokedAt: null, routePlanId: fixture.routePlanId } })).toBe(1);
      await expect(service.takeover({
        accountId: fixture.accountId,
        deviceInstanceHash: 'b'.repeat(64),
        routePlanId: fixture.routePlanId,
        sessionGeneration: '2026-08-24T07:00:00.000Z'
      })).resolves.toBe(true);
      expect(await prisma.driverRouteSessionLease.count({ where: { routePlanId: fixture.routePlanId } })).toBe(3);
      expect(await prisma.driverRouteSessionLease.count({ where: { revokedAt: null, routePlanId: fixture.routePlanId } })).toBe(1);
      expect(await prisma.driverSyncSession.count({ where: { routePlanId: fixture.routePlanId } })).toBe(2);
      expect(await prisma.alertCycle.count({ where: { condition: { type: 'MULTI_DEVICE_CONFLICT' }, resolvedAt: null } })).toBe(0);
      const healthAfterTakeover = await service.getActiveSyncHealth(fixture.routePlanId, now);
      expect(healthAfterTakeover).toMatchObject({ deviceInstanceHash: 'b'.repeat(64) });
      expect(healthAfterTakeover?.state).not.toBe('BLOCKED');
      now = new Date('2026-08-24T08:12:00.000Z');
      await expect(service.recordHeartbeat(context, heartbeat('a', 13))).resolves.toMatchObject({
        accepted: true,
        conflict: true
      });
      now = new Date('2026-08-24T08:14:05.000Z');
      await service.detectOperationalHealth();
      expect(await prisma.alertCycle.count({ where: { condition: { shopId: fixture.shopId, type: 'HEARTBEAT_ABSENT' }, resolvedAt: null } })).toBe(1);
    } finally { await prisma.$disconnect(); }
  });

  live('replaces an expired same-session lease and keeps concurrent takeover idempotent', async () => {
    assertDisposableDatabase();
    const prisma = client();
    let now = new Date('2026-08-24T08:00:00.000Z');
    const fixture = await seed(prisma, '11');
    const context = { accountId: fixture.accountId, driverId: fixture.driverId, routePlanId: fixture.routePlanId, shopDomain: fixture.shopDomain, shopId: fixture.shopId };
    const service = new PrismaDriverSyncHealthService(prisma, undefined, () => now);
    try {
      await service.recordHeartbeat(context, heartbeat('e', 1));
      now = new Date('2026-08-24T08:10:00.000Z');
      const takeoverInput = {
        accountId: fixture.accountId,
        deviceInstanceHash: 'e'.repeat(64),
        routePlanId: fixture.routePlanId,
        sessionGeneration: '2026-08-24T07:00:00.000Z'
      };
      await expect(Promise.all([
        service.takeover(takeoverInput),
        service.takeover(takeoverInput)
      ])).resolves.toEqual([true, true]);
      expect(await prisma.driverRouteSessionLease.count({ where: { routePlanId: fixture.routePlanId } })).toBe(2);
      expect(await prisma.driverRouteSessionLease.count({
        where: { expiresAt: { gt: now }, revokedAt: null, routePlanId: fixture.routePlanId }
      })).toBe(1);
      await expect(service.getActiveSyncHealth(fixture.routePlanId, now)).resolves.toMatchObject({
        deviceInstanceHash: 'e'.repeat(64),
        heartbeatSequence: 1,
        state: 'BLOCKED'
      });
    } finally { await prisma.$disconnect(); }
  });

  live('re-derives heartbeat age at read time for exact boundaries and batched projections', async () => {
    assertDisposableDatabase();
    const prisma = client();
    const heartbeatAt = new Date('2026-08-24T08:00:00.000Z');
    const fixture = await seed(prisma, '12');
    const context = { accountId: fixture.accountId, driverId: fixture.driverId, routePlanId: fixture.routePlanId, shopDomain: fixture.shopDomain, shopId: fixture.shopId };
    const service = new PrismaDriverSyncHealthService(prisma, undefined, () => heartbeatAt);
    try {
      await service.recordHeartbeat(context, heartbeat('f', 1));
      await prisma.driverRouteSessionLease.updateMany({
        data: { expiresAt: new Date('2026-08-24T09:00:00.000Z') },
        where: { routePlanId: fixture.routePlanId, revokedAt: null }
      });
      await expect(service.getActiveSyncHealth(fixture.routePlanId, new Date('2026-08-24T08:01:00.000Z')))
        .resolves.toMatchObject({ state: 'HEALTHY' });
      await expect(service.getActiveSyncHealth(fixture.routePlanId, new Date('2026-08-24T08:01:00.001Z')))
        .resolves.toMatchObject({ state: 'DELAYED' });
      await expect(service.getActiveSyncHealth(fixture.routePlanId, new Date('2026-08-24T08:03:00.000Z')))
        .resolves.toMatchObject({ state: 'DELAYED' });
      const absent = await service.getActiveSyncHealthForRoutePlans(
        [fixture.routePlanId],
        new Date('2026-08-24T08:03:00.001Z')
      );
      expect(absent.get(fixture.routePlanId)).toMatchObject({ state: 'BLOCKED' });
    } finally { await prisma.$disconnect(); }
  });

  live('rolls back projection faults and converges concurrent recurrence to one active alert cycle', async () => {
    assertDisposableDatabase();
    const prisma = client();
    const fixture = await seed(prisma, '02');
    try {
      const failing = new PrismaOperationalAlertRepository(prisma, { beforeLegacyProjection: () => { throw new Error('projection fault'); } });
      await expect(failing.openOrObserve(alertInput(fixture, new Date('2026-08-24T08:00:00.000Z')))).rejects.toThrow('projection fault');
      expect(await prisma.alertCondition.count({ where: { shopId: fixture.shopId } })).toBe(0);
      expect(await prisma.adminNotification.count({ where: { shopId: fixture.shopId } })).toBe(0);

      const repository = new PrismaOperationalAlertRepository(prisma);
      const opened = await repository.openOrObserve(alertInput(fixture, new Date('2026-08-24T08:01:00.000Z')));
      await repository.openOrObserve(alertInput(fixture, new Date('2026-08-24T08:02:00.000Z')));
      expect(await prisma.alertCycle.count({ where: { condition: { shopId: fixture.shopId } } })).toBe(1);
      const projection = await prisma.adminNotification.findFirstOrThrow({ where: { shopId: fixture.shopId } });
      const notificationRepository = new PrismaAdminNotificationRepository(prisma, repository);
      await notificationRepository.markReadForShopDomain({ notificationId: projection.id, readAt: new Date('2026-08-24T08:02:30.000Z'), shopDomain: fixture.shopDomain });
      expect(await prisma.alertCycle.findUnique({ where: { id: opened.id } })).toMatchObject({ readAt: new Date('2026-08-24T08:02:30.000Z') });
      expect(await prisma.adminNotification.findUnique({ where: { id: projection.id } })).toMatchObject({ readAt: new Date('2026-08-24T08:02:30.000Z') });
      const acknowledged = await repository.acknowledge({ actor: 'operator', alertId: opened.id, shopDomain: fixture.shopDomain });
      expect(typeof acknowledged?.acknowledgedAt).toBe('string');
      await repository.resolve({ alertId: opened.id, resolutionCode: 'RECOVERED', shopId: fixture.shopId });
      const recurrenceTime = new Date('2026-08-24T08:03:00.000Z');
      const recurrence = await Promise.allSettled([
        repository.openOrObserve(alertInput(fixture, recurrenceTime)),
        repository.openOrObserve(alertInput(fixture, recurrenceTime))
      ]);
      expect(recurrence.map(({ status }) => status)).toEqual(['fulfilled', 'fulfilled']);
      expect(await prisma.alertCycle.count({ where: { condition: { shopId: fixture.shopId }, resolvedAt: null } })).toBe(1);
      expect(await prisma.alertCycle.count({ where: { condition: { shopId: fixture.shopId } } })).toBe(2);
      expect(await prisma.adminNotification.findFirst({ where: { shopId: fixture.shopId } })).toMatchObject({ readAt: null });
    } finally { await prisma.$disconnect(); }
  });

  live('keeps automatic and each manual recipient attempt lineage unique and redacted', async () => {
    assertDisposableDatabase();
    const prisma = client();
    const fixture = await seed(prisma, '03');
    const attempts = new PrismaCustomerDeliveryNotificationAttemptRepository(prisma, () => new Date('2026-08-24T08:00:00.000Z'));
    try {
      const order = await prisma.order.create({ data: { name: '#G003', rawPayload: {}, shopId: fixture.shopId, shopifyOrderGid: `gid://shopify/Order/${fixture.shopId}`, sourceOrderId: 'g003-order', sourcePlatform: 'SHOPIFY' } });
      const fact = await prisma.customerRouteNotificationFact.create({
        data: { orderId: order.id, shopId: fixture.shopId, source: 'TEST', status: 'QUEUED' }
      });
      const dispatch = await prisma.customerEmailManualDispatch.create({
        data: { actor: 'operator', commandId: 'g003-email', counts: {}, request: {}, routePlanId: fixture.routePlanId, shopId: fixture.shopId, signal: 'READY', template: {} }
      });
      const recipients = await Promise.all(['1', '2'].map((suffix) => prisma.customerEmailManualDispatchRecipient.create({
        data: { dispatchId: dispatch.id, routePlanId: fixture.routePlanId, shopId: fixture.shopId, status: 'PENDING', recipientEmail: `forbidden-${suffix}@invalid.test` }
      })));
      const automatic = await attempts.startAutomatic({ attemptNumber: 1, factId: fact.id, provider: 'fixture', startedAt: new Date() });
      await attempts.settle({ attemptId: automatic.attemptId, completedAt: new Date(), errorCode: 'TEMPORARY_PROVIDER_FAILURE', outcome: 'RETRYABLE_FAILURE' });
      const automaticStarted = await attempts.startAutomatic({ attemptNumber: 2, factId: fact.id, provider: 'fixture', startedAt: new Date() });
      await Promise.all(recipients.map(({ id }) => attempts.startManual({ manualDispatchRecipientId: id, provider: 'brevo', shopId: fixture.shopId, startedAt: new Date() })));
      expect(await prisma.customerDeliveryNotificationAttempt.count({ where: { shopId: fixture.shopId } })).toBe(4);
      const other = await seed(prisma, '04');
      const otherOrder = await prisma.order.create({ data: { name: '#OTHER', rawPayload: {}, shopId: other.shopId, shopifyOrderGid: `gid://shopify/Order/${other.shopId}`, sourceOrderId: 'other-order', sourcePlatform: 'SHOPIFY' } });
      await prisma.customerRouteNotificationFact.create({ data: { orderId: otherOrder.id, shopId: other.shopId, source: 'TEST', status: 'DEAD' } });
      const health = await new PrismaEmailRuntimeHealthService(prisma, {
        automaticSenderConfigured: false, automaticWorkerEnabled: false, manualBrevoConfigured: true
      }).get({ shopDomain: fixture.shopDomain });
      expect(health.email).toMatchObject({ automatic: { enabled: false }, configured: false, manual: { brevoConfigured: true }, outbox: { deadLetter: 0, pending: 1 }, state: 'DEGRADED' });
      const columns = await prisma.$queryRaw<Array<{ column_name: string }>>`SELECT column_name FROM information_schema.columns WHERE table_name = 'customer_delivery_notification_attempts'`;
      expect(columns.map(({ column_name }) => column_name)).not.toEqual(expect.arrayContaining(['recipient', 'recipientEmail', 'subject', 'body', 'errorMessage']));
      await prisma.customerRouteNotificationFact.update({ data: { sentAt: new Date(), status: 'SENT' }, where: { id: fact.id } });
      await expect(cleanupRouteOperationalEvidence(prisma, new Date('2026-08-24T08:01:00.000Z'))).resolves.toMatchObject({
        notificationAttemptsReconciled: 1
      });
      await expect(prisma.customerDeliveryNotificationAttempt.findUnique({ where: { id: automaticStarted.attemptId } }))
        .resolves.toMatchObject({ outcome: 'SENT' });

      const retentionCondition = await prisma.alertCondition.create({
        data: { dedupeKey: 'bounded-retention', shopId: fixture.shopId, type: 'RETENTION_TEST' }
      });
      const expiredAt = new Date('1900-01-01T00:00:00.000Z');
      const retentionNow = new Date('2026-08-24T08:02:00.000Z');
      await prisma.alertCycle.createMany({ data: [1, 2, 3].map(() => ({
        conditionId: retentionCondition.id,
        lastObservedAt: retentionNow,
        openedAt: retentionNow,
        resolutionCode: 'RETENTION_TEST_RESOLVED',
        resolvedAt: retentionNow,
        retainedUntil: expiredAt,
        severity: 'WARNING'
      })) });
      await prisma.customerDeliveryNotificationAttempt.createMany({ data: [1, 2, 3].flatMap((sequence) => [{
        attemptNumber: 100 + sequence,
        completedAt: retentionNow,
        correlationId: `terminal-${sequence}`,
        factId: fact.id,
        outcome: 'SENT',
        provider: 'fixture',
        retainedUntil: expiredAt,
        shopId: fixture.shopId,
        startedAt: retentionNow
      }, {
        attemptNumber: 200 + sequence,
        correlationId: `reconcile-${sequence}`,
        factId: fact.id,
        outcome: 'STARTED',
        provider: 'fixture',
        retainedUntil: new Date('2030-01-01T00:00:00.000Z'),
        shopId: fixture.shopId,
        startedAt: retentionNow
      }]) });
      const bounded = await cleanupRouteOperationalEvidence(prisma, retentionNow, {
        reconciliationBatchSize: 1,
        reconciliationMaxRows: 2,
        terminalBatchSize: 1,
        terminalMaxRows: 2
      });
      expect(bounded).toMatchObject({
        alertCycles: 2,
        alertCyclesContinuationRequired: true,
        notificationAttemptReconciliationContinuationRequired: true,
        notificationAttempts: 2,
        notificationAttemptsContinuationRequired: true,
        notificationAttemptsReconciled: 2
      });
      expect(await prisma.alertCycle.count({ where: { conditionId: retentionCondition.id } })).toBe(1);
      expect(await prisma.customerDeliveryNotificationAttempt.count({
        where: { correlationId: { startsWith: 'terminal-' } }
      })).toBe(1);
      expect(await prisma.customerDeliveryNotificationAttempt.count({
        where: { correlationId: { startsWith: 'reconcile-' }, outcome: 'STARTED' }
      })).toBe(1);
    } finally { await prisma.$disconnect(); }
  });

  live('derives Kitchener GPS proximity and accuracy from persisted route evidence', async () => {
    assertDisposableDatabase();
    const prisma = client();
    const fixture = await seed(prisma, '05');
    const observedAt = new Date('2026-08-24T08:00:00.000Z');
    try {
      const order = await prisma.order.create({ data: { name: '#GPS', rawPayload: {}, shopId: fixture.shopId, shopifyOrderGid: `gid://shopify/Order/gps-${fixture.shopId}`, sourceOrderId: 'gps-order', sourcePlatform: 'SHOPIFY' } });
      const stop = await prisma.deliveryStop.create({ data: { latitude: 43.4517, longitude: -80.4926, orderId: order.id, shopId: fixture.shopId } });
      await prisma.routePlanStop.create({ data: { deliveryStopId: stop.id, routePlanId: fixture.routePlanId, sequence: 11, shopId: fixture.shopId } });
      const event = await prisma.driverEvent.create({ data: {
        driverId: fixture.driverId, eventType: 'LOCATION_UPDATED', latitude: 43.4516, longitude: -80.4925,
        occurredAt: observedAt, payload: { accuracyMeters: 9 }, routePlanId: fixture.routePlanId, shopId: fixture.shopId
      } });
      await prisma.routeTrackingGeometry.create({ data: {
        expiresAt: new Date('2026-11-24T08:00:00.000Z'), firstOccurredAt: observedAt, geometryPointCount: 1,
        lastEventId: event.id, lastLatitude: 43.4516, lastLongitude: -80.4925, lastOccurredAt: observedAt,
        lastReceivedAt: observedAt, routePlanId: fixture.routePlanId,
        sampleMetadata: [{ driverId: fixture.driverId, eventId: event.id, occurredAt: observedAt.toISOString(), receivedAt: observedAt.toISOString() }], sourcePointCount: 1
      } });
      const state = await new PrismaRouteOperationalStateService(
        prisma,
        { getActiveSyncHealthForRoutePlans: () => Promise.resolve(new Map()) } as never,
        new PrismaOperationalAlertRepository(prisma),
        () => new Date('2026-08-24T08:00:30.000Z')
      ).get(fixture.routePlanId);
      expect(state?.physicalPosition).toMatchObject({ accuracyMeters: 9, freshness: 'FRESH', nearestStopSequence: 11, reliableForProximity: true, withinProximityThreshold: true });
    } finally { await prisma.$disconnect(); }
  });

  live('converges heartbeat recovery after the commit-to-alert crash gap without stale retry mutation', async () => {
    assertDisposableDatabase();
    const prisma = client();
    const now = new Date('2026-08-24T08:00:00.000Z');
    const repository = new PrismaOperationalAlertRepository(prisma);
    const fixture = await seed(prisma, '06');
    const context = { accountId: fixture.accountId, driverId: fixture.driverId, routePlanId: fixture.routePlanId, shopDomain: fixture.shopDomain, shopId: fixture.shopId };
    try {
      await repository.openOrObserve({
        dedupeKey: `HEARTBEAT_ABSENT:${fixture.routePlanId}:${fixture.driverId}`,
        observedAt: new Date('2026-08-24T07:55:00.000Z'), routePlanId: fixture.routePlanId,
        severity: 'CRITICAL', shopId: fixture.shopId, title: 'Absent', type: 'HEARTBEAT_ABSENT'
      });
      const crashGapService = new PrismaDriverSyncHealthService(prisma, {
        openOrObserve: repository.openOrObserve.bind(repository),
        resolveByDedupeKey: () => Promise.reject(new Error('alert repository unavailable'))
      } as never, () => now);
      await expect(crashGapService.recordHeartbeat(context, heartbeat('c', 1))).rejects.toThrow('alert repository unavailable');
      expect(await prisma.driverSyncHeartbeat.count({ where: { syncSession: { routePlanId: fixture.routePlanId } } })).toBe(1);
      expect(await prisma.alertCycle.count({ where: { condition: { shopId: fixture.shopId, type: 'HEARTBEAT_ABSENT' }, resolvedAt: null } })).toBe(1);

      const recoveringService = new PrismaDriverSyncHealthService(prisma, repository, () => now);
      await expect(recoveringService.recordHeartbeat(context, heartbeat('c', 1))).resolves.toMatchObject({ accepted: false });
      expect(await prisma.alertCycle.count({ where: { condition: { shopId: fixture.shopId, type: 'HEARTBEAT_ABSENT' }, resolvedAt: null } })).toBe(1);
      await recoveringService.detectOperationalHealth();
      expect(await prisma.alertCycle.count({ where: { condition: { shopId: fixture.shopId, type: 'HEARTBEAT_ABSENT' }, resolvedAt: null } })).toBe(0);
      expect(await prisma.alertCycle.findFirst({ where: { condition: { shopId: fixture.shopId, type: 'HEARTBEAT_ABSENT' } } })).toMatchObject({ resolutionCode: 'HEARTBEAT_RECOVERED_BY_DETECTOR', resolvedAt: now });
    } finally { await prisma.$disconnect(); }
  });
});

function client(): PrismaClient { return new PrismaClient({ datasources: { db: { url: databaseUrl } } }); }
function heartbeat(device: string, heartbeatSequence: number, overrides: Partial<DriverSyncHeartbeatInput> = {}): DriverSyncHeartbeatInput {
  return { ...baseHeartbeat(device, heartbeatSequence), ...overrides };
}
function baseHeartbeat(device: string, heartbeatSequence: number) {
  return {
    appVersion: '2.0.0', clientOccurredAt: new Date('2026-08-24T08:00:00.000Z'), completedStopCount: 0,
    currentStopSequence: 1, deviceInstanceHash: device.repeat(64), driverContractVersion: 2,
    finishPending: false, firstErrorCode: null, firstFailedAt: null, heartbeatSequence,
    lastAcknowledgedAt: null, lastErrorCode: null, lastRetryAt: null, locallyFinished: false,
    nextRetryAt: null, oldestQueuedAt: null, queueDepth: 0, retryCount: 0, retryJournal: null,
    sessionGeneration: '2026-08-24T07:00:00.000Z', totalStopCount: 1, versionCode: 200
  };
}
function alertInput(fixture: Awaited<ReturnType<typeof seed>>, observedAt: Date) {
  return { dedupeKey: `TEST_ALERT:${fixture.routePlanId}`, observedAt, routePlanId: fixture.routePlanId, severity: 'WARNING' as const, shopId: fixture.shopId, title: 'Test alert', type: 'TEST_ALERT' };
}
async function seed(prisma: PrismaClient, suffix: string) {
  const shopId = `81000000-0000-4000-8000-0000000000${suffix}`;
  const accountId = `82000000-0000-4000-8000-0000000000${suffix}`;
  const driverId = `83000000-0000-4000-8000-0000000000${suffix}`;
  const routePlanId = `84000000-0000-4000-8000-0000000000${suffix}`;
  const shopDomain = `g003-${suffix}.invalid`;
  await prisma.shop.create({ data: { id: shopId, shopDomain } });
  await prisma.driverAccount.create({ data: { id: accountId, phone: `+15550000${suffix}` } });
  await prisma.driver.create({ data: { accountId, displayName: 'G003', id: driverId, shopId } });
  await prisma.routePlan.create({ data: { constraints: {}, driverId, id: routePlanId, metrics: {}, name: 'G003', optimizerVersion: 'test', planDate: new Date('2026-08-24'), shopId, status: 'IN_PROGRESS' } });
  return { accountId, driverId, routePlanId, shopDomain, shopId };
}
function assertDisposableDatabase(): void {
  if (!databaseUrl.includes('127.0.0.1:55488/clever_g002')) throw new Error('Refusing non-disposable database');
}
