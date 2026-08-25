import { describe, expect, test, vi } from 'vitest';
import { cleanupRouteOperationalEvidence } from '../src/modules/operations/route-operational-evidence-retention.js';

describe('route operational evidence retention', () => {
  test('preserves active sessions, unresolved alerts, and email attempts without a successful parent', async () => {
    const prisma = {
      $queryRaw: retentionQueryMock({
        alertBatches: [[{ id: 'alert-1' }, { id: 'alert-2' }, { id: 'alert-3' }]],
        attemptBatches: [[{ id: 'attempt-1' }, { id: 'attempt-2' }, { id: 'attempt-3' }, { id: 'attempt-4' }]],
        reconciliationBatches: [[{ id: 'reconcile-1' }, { id: 'reconcile-2' }]]
      }),
      $transaction: vi.fn(),
      alertCycle: { deleteMany: vi.fn().mockResolvedValue({ count: 3 }) },
      customerDeliveryNotificationAttempt: {
        deleteMany: vi.fn().mockResolvedValue({ count: 4 }),
        updateMany: vi.fn().mockResolvedValue({ count: 2 })
      },
      driverEvent: {
        updateMany: vi.fn((input: { where: { id: { in: string[] } } }) => Promise.resolve({ count: input.where.id.in.length === 0 ? 0 : 6 })),
        findMany: vi.fn().mockResolvedValueOnce([{ id: 'old-location' }]).mockResolvedValue([])
      },
      driverSyncHeartbeat: {
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
        findMany: vi.fn().mockResolvedValueOnce([{ id: 'heartbeat-id' }]).mockResolvedValue([])
      },
      driverSyncSession: {
        deleteMany: vi.fn().mockResolvedValue({ count: 2 }),
        findMany: vi.fn().mockResolvedValueOnce([{ id: 'session-id' }]).mockResolvedValue([])
      },
      routeTrackingGeometry: {
        deleteMany: vi.fn().mockResolvedValue({ count: 5 }),
        findMany: vi.fn().mockResolvedValueOnce([{
          firstOccurredAt: new Date('2026-01-01T00:00:00.000Z'),
          geometry: null,
          geometryPointCount: 1,
          id: 'expired-geometry',
          lastDriverId: 'driver-id',
          lastEventId: 'old-location',
          lastLatitude: 43.45,
          lastLongitude: -80.49,
          lastOccurredAt: new Date('2026-01-01T00:00:00.000Z'),
          lastReceivedAt: new Date('2026-01-01T00:00:00.000Z'),
          routePlanId: 'route-id',
          sampleMetadata: [{ driverId: 'driver-id', eventId: 'old-location', occurredAt: '2026-01-01T00:00:00.000Z', receivedAt: '2026-01-01T00:00:00.000Z' }],
          sourcePointCount: 1
        }]).mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue({
          firstOccurredAt: new Date('2026-01-01T00:00:00.000Z'),
          geometry: null,
          geometryPointCount: 1,
          id: 'expired-geometry',
          lastDriverId: 'driver-id',
          lastEventId: 'old-location',
          lastLatitude: 43.45,
          lastLongitude: -80.49,
          lastOccurredAt: new Date('2026-01-01T00:00:00.000Z'),
          lastReceivedAt: new Date('2026-01-01T00:00:00.000Z'),
          routePlanId: 'route-id',
          sampleMetadata: [{ driverId: 'driver-id', eventId: 'old-location', occurredAt: '2026-01-01T00:00:00.000Z', receivedAt: '2026-01-01T00:00:00.000Z' }],
          sourcePointCount: 1
        }),
        update: vi.fn()
      }
    };
    prisma.$transaction.mockImplementation((callback: (tx: typeof prisma) => Promise<unknown>) => callback(prisma));
    const now = new Date('2026-08-24T08:00:00.000Z');

    await expect(cleanupRouteOperationalEvidence(prisma as never, now)).resolves.toEqual({
      alertCycles: 3,
      alertCyclesContinuationRequired: false,
      emailReconciliationAudits: 1,
      emailReconciliationAuditsContinuationRequired: false,
      locationEvents: 6,
      locationContinuationRequired: false,
      notificationAttempts: 4,
      notificationAttemptReconciliationContinuationRequired: false,
      notificationAttemptsContinuationRequired: false,
      notificationAttemptsReconciled: 2,
      routeTrackingGeometries: 5,
      syncContinuationRequired: false,
      syncHeartbeats: 1,
      syncSessions: 2
    });
    expect(prisma.driverSyncHeartbeat.findMany).toHaveBeenCalledWith({
      orderBy: [{ retainedUntil: 'asc' }, { id: 'asc' }],
      select: { id: true },
      take: 1000,
      where: {
        retainedUntil: { lt: now },
        syncSession: { leases: { none: { expiresAt: { gt: now }, revokedAt: null } } }
      }
    });
    expect(prisma.driverSyncHeartbeat.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['heartbeat-id'] } } });
    expect(prisma.driverSyncSession.findMany).toHaveBeenCalledWith({
      orderBy: [{ lastObservedAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
      take: 1000,
      where: {
        lastObservedAt: { lt: new Date('2026-07-25T08:00:00.000Z') },
        leases: { none: { expiresAt: { gt: now }, revokedAt: null } }
      }
    });
    expect(prisma.driverSyncSession.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['session-id'] } } });
    expect(prisma.routeTrackingGeometry.findMany).toHaveBeenCalledWith({
      orderBy: { firstOccurredAt: 'asc' },
      take: 1000,
      where: {
        firstOccurredAt: { lt: new Date('2026-05-26T08:00:00.000Z') }
      }
    });
    expect(prisma.driverEvent.findMany).toHaveBeenCalledWith({
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
      take: 1000,
      where: {
        OR: [{ latitude: { not: null } }, { longitude: { not: null } }],
        eventType: 'LOCATION_UPDATED',
        occurredAt: { lt: new Date('2026-05-26T08:00:00.000Z') }
      }
    });
    expect(prisma.driverEvent.updateMany).toHaveBeenCalledWith({
      data: {
        latitude: null,
        longitude: null,
        payload: { redacted: true, schema: 'driver_location_retention_tombstone_v1' }
      },
      where: { id: { in: ['old-location'] } }
    });
    const sql = prisma.$queryRaw.mock.calls.map(([statement]) => statement.strings.join(' ')).join('\n');
    expect(sql).toContain('UPDATE "customer_delivery_notification_attempts" target');
    expect(sql).toContain('FOR UPDATE OF attempt SKIP LOCKED');
  });

  test('bounds geometry-only backlog and reports executable continuation', async () => {
    const geometry = {
      firstOccurredAt: new Date('2026-01-01T00:00:00.000Z'),
      geometry: null,
      geometryPointCount: 1,
      id: 'expired-geometry',
      lastDriverId: 'driver-id',
      lastEventId: 'old-location',
      lastLatitude: 43.45,
      lastLongitude: -80.49,
      lastOccurredAt: new Date('2026-01-01T00:00:00.000Z'),
      lastReceivedAt: new Date('2026-01-01T00:00:00.000Z'),
      routePlanId: 'route-id',
      sampleMetadata: [{ driverId: 'driver-id', eventId: 'old-location', occurredAt: '2026-01-01T00:00:00.000Z', receivedAt: '2026-01-01T00:00:00.000Z' }],
      sourcePointCount: 1
    };
    const prisma = {
      $queryRaw: retentionQueryMock(),
      $transaction: vi.fn(),
      alertCycle: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      customerDeliveryNotificationAttempt: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }), updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      driverEvent: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      driverSyncHeartbeat: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }), findMany: vi.fn().mockResolvedValue([]) },
      driverSyncSession: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }), findMany: vi.fn().mockResolvedValue([]) },
      routeTrackingGeometry: {
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
        findMany: vi.fn().mockResolvedValue([geometry]),
        findUnique: vi.fn().mockResolvedValue(geometry),
        update: vi.fn()
      }
    };
    prisma.$transaction.mockImplementation((callback: (tx: typeof prisma) => Promise<unknown>) => callback(prisma));

    await expect(cleanupRouteOperationalEvidence(
      prisma as never,
      new Date('2026-08-24T08:00:00.000Z'),
      { locationBatchSize: 1, locationMaxRows: 2 }
    )).resolves.toMatchObject({
      locationContinuationRequired: true,
      locationEvents: 0,
      routeTrackingGeometries: 2
    });
    expect(prisma.routeTrackingGeometry.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.driverEvent.findMany).toHaveBeenCalledOnce();
  });

  test('bounds sync history deletion and reports continuation instead of treating deadline exhaustion as success', async () => {
    const prisma = {
      $queryRaw: retentionQueryMock(),
      $transaction: vi.fn(),
      alertCycle: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      customerDeliveryNotificationAttempt: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }), updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      driverEvent: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      driverSyncHeartbeat: {
        deleteMany: vi.fn(({ where }: { where: { id: { in: string[] } } }) => Promise.resolve({ count: where.id.in.length })),
        findMany: vi.fn().mockResolvedValue([{ id: 'heartbeat-id' }])
      },
      driverSyncSession: {
        deleteMany: vi.fn(({ where }: { where: { id: { in: string[] } } }) => Promise.resolve({ count: where.id.in.length })),
        findMany: vi.fn().mockResolvedValue([{ id: 'session-id' }])
      },
      routeTrackingGeometry: { deleteMany: vi.fn(), findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn(), update: vi.fn() }
    };
    prisma.$transaction.mockImplementation((callback: (tx: typeof prisma) => Promise<unknown>) => callback(prisma));

    await expect(cleanupRouteOperationalEvidence(
      prisma as never,
      new Date('2026-08-24T08:00:00.000Z'),
      { syncBatchSize: 1, syncMaxRows: 2 }
    )).resolves.toMatchObject({
      syncContinuationRequired: true,
      syncHeartbeats: 1,
      syncSessions: 1
    });
    expect(prisma.driverSyncHeartbeat.deleteMany).toHaveBeenCalledOnce();
    expect(prisma.driverSyncSession.deleteMany).toHaveBeenCalledOnce();
  });

  test('bounds alert and email terminal evidence independently and reports both backlogs', async () => {
    const prisma = {
      $queryRaw: retentionQueryMock({
        alertBatches: [[{ id: 'alert-1' }], [{ id: 'alert-2' }]],
        alertRemaining: true,
        attemptBatches: [[{ id: 'attempt-1' }], [{ id: 'attempt-2' }]],
        attemptRemaining: true
      }),
      $transaction: vi.fn(),
      alertCycle: { deleteMany: vi.fn() },
      customerDeliveryNotificationAttempt: { deleteMany: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      driverEvent: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      driverSyncHeartbeat: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }), findMany: vi.fn().mockResolvedValue([]) },
      driverSyncSession: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }), findMany: vi.fn().mockResolvedValue([]) },
      routeTrackingGeometry: { deleteMany: vi.fn(), findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn(), update: vi.fn() }
    };
    prisma.$transaction.mockImplementation((callback: (tx: typeof prisma) => Promise<unknown>) => callback(prisma));

    await expect(cleanupRouteOperationalEvidence(
      prisma as never,
      new Date('2026-08-24T08:00:00.000Z'),
      { terminalBatchSize: 1, terminalMaxRows: 2 }
    )).resolves.toMatchObject({
      alertCycles: 2,
      alertCyclesContinuationRequired: true,
      notificationAttempts: 2,
      notificationAttemptsContinuationRequired: true
    });
    const sql = prisma.$queryRaw.mock.calls.map(([statement]) => statement.strings.join(' ')).join('\n');
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).toContain('FOR UPDATE OF attempt SKIP LOCKED');
  });

  test.each([
    {
      alertBatches: [[{ id: 'alert-1' }], [{ id: 'alert-2' }]],
      expectedAlertDeletes: 2,
      expectedAttemptDeletes: 1,
      label: 'alert cap with empty email queue'
    },
    {
      attemptBatches: [[{ id: 'attempt-1' }], [{ id: 'attempt-2' }]],
      expectedAlertDeletes: 1,
      expectedAttemptDeletes: 2,
      label: 'email cap with empty alert queue'
    }
  ])('stops terminal cleanup without a deadline spin for $label', async ({
    alertBatches,
    attemptBatches,
    expectedAlertDeletes,
    expectedAttemptDeletes
  }) => {
    const prisma = {
      $queryRaw: retentionQueryMock({
        ...(alertBatches === undefined ? {} : { alertBatches }),
        ...(attemptBatches === undefined ? {} : { attemptBatches })
      }),
      $transaction: vi.fn(),
      alertCycle: { deleteMany: vi.fn() },
      customerDeliveryNotificationAttempt: { deleteMany: vi.fn(), updateMany: vi.fn() },
      driverEvent: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      driverSyncHeartbeat: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }), findMany: vi.fn().mockResolvedValue([]) },
      driverSyncSession: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }), findMany: vi.fn().mockResolvedValue([]) },
      routeTrackingGeometry: { deleteMany: vi.fn(), findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn(), update: vi.fn() }
    };
    prisma.$transaction.mockImplementation((callback: (tx: typeof prisma) => Promise<unknown>) => callback(prisma));

    await cleanupRouteOperationalEvidence(
      prisma as never,
      new Date('2026-08-24T08:00:00.000Z'),
      { terminalBatchSize: 1, terminalMaxRows: 2 }
    );
    const statements = prisma.$queryRaw.mock.calls.map(([statement]) => statement.strings.join(' '));
    expect(statements.filter((sql) => sql.includes('DELETE FROM "alert_cycles"'))).toHaveLength(expectedAlertDeletes);
    expect(statements.filter((sql) => sql.includes('DELETE FROM "customer_delivery_notification_attempts"')))
      .toHaveLength(expectedAttemptDeletes);
  });

  test('bounds STARTED-to-SENT reconciliation and reports backlog for immediate continuation', async () => {
    const prisma = {
      $queryRaw: retentionQueryMock({
        reconciliationBatches: [[{ id: 'reconcile-1' }], [{ id: 'reconcile-2' }]],
        reconciliationRemaining: true
      }),
      $transaction: vi.fn(),
      alertCycle: { deleteMany: vi.fn() },
      customerDeliveryNotificationAttempt: { deleteMany: vi.fn(), updateMany: vi.fn() },
      driverEvent: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      driverSyncHeartbeat: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }), findMany: vi.fn().mockResolvedValue([]) },
      driverSyncSession: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }), findMany: vi.fn().mockResolvedValue([]) },
      routeTrackingGeometry: { deleteMany: vi.fn(), findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn(), update: vi.fn() }
    };
    prisma.$transaction.mockImplementation((callback: (tx: typeof prisma) => Promise<unknown>) => callback(prisma));

    await expect(cleanupRouteOperationalEvidence(
      prisma as never,
      new Date('2026-08-24T08:00:00.000Z'),
      { reconciliationBatchSize: 1, reconciliationMaxRows: 2 }
    )).resolves.toMatchObject({
      notificationAttemptReconciliationContinuationRequired: true,
      notificationAttemptsReconciled: 2
    });
  });
});

function retentionQueryMock(input: {
  alertBatches?: Array<Array<{ id: string }>>;
  alertRemaining?: boolean;
  attemptBatches?: Array<Array<{ id: string }>>;
  attemptRemaining?: boolean;
  reconciliationBatches?: Array<Array<{ id: string }>>;
  reconciliationRemaining?: boolean;
} = {}) {
  const alertBatches = [...(input.alertBatches ?? [])];
  const attemptBatches = [...(input.attemptBatches ?? [])];
  const reconciliationBatches = [...(input.reconciliationBatches ?? [])];
  return vi.fn((statement: { strings: readonly string[] }) => {
    const sql = statement.strings.join(' ');
    if (sql.includes('UPDATE "customer_delivery_notification_attempts" target')) return Promise.resolve(reconciliationBatches.shift() ?? []);
    if (sql.includes('DELETE FROM "alert_cycles"')) return Promise.resolve(alertBatches.shift() ?? []);
    if (sql.includes('DELETE FROM "customer_delivery_notification_attempts"')) return Promise.resolve(attemptBatches.shift() ?? []);
    if (sql.includes('SELECT EXISTS') && sql.includes('attempt."outcome" = \'STARTED\'')) return Promise.resolve([{ exists: input.reconciliationRemaining ?? false }]);
    if (sql.includes('SELECT EXISTS') && sql.includes('FROM "alert_cycles"')) return Promise.resolve([{ exists: input.alertRemaining ?? false }]);
    if (sql.includes('SELECT EXISTS') && sql.includes('FROM "customer_delivery_notification_attempts"')) return Promise.resolve([{ exists: input.attemptRemaining ?? false }]);
    return Promise.resolve([{ locked: true }]);
  });
}
