import type { PrismaClient } from '@prisma/client';
import { describe, expect, test, vi } from 'vitest';

import { PrismaDsvExecutionApiService } from '../src/modules/dsv/dsv-execution-api.service.js';
import { createDsvAdminPrincipal, type DsvDriverPrincipal } from '../src/modules/dsv/dsv-principal.js';

const ids = {
  account: '11111111-1111-4111-8111-111111111111',
  context: '22222222-2222-4222-8222-222222222222',
  driver: '33333333-3333-4333-8333-333333333333',
  event: '44444444-4444-4444-8444-444444444444',
  notification: '55555555-5555-4555-8555-555555555555',
  report: '66666666-6666-4666-8666-666666666666',
  route: '77777777-7777-4777-8777-777777777777',
  sample: '88888888-8888-4888-8888-888888888888',
  shop: '99999999-9999-4999-8999-999999999999',
  stop: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  vehicle: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
};
const at = new Date('2026-10-06T09:00:00.000Z');

function context(overrides: Record<string, unknown> = {}) {
  return {
    assignmentEpoch: 4n,
    closedAt: null,
    departureObservedAt: at,
    driverId: ids.driver,
    effectiveAt: at,
    id: ids.context,
    liveEligibleAt: null,
    monitorEndAt: new Date('2026-10-06T13:00:00.000Z'),
    monitorStartAt: at,
    notificationMode: 'SHADOW',
    recipientAccountId: ids.account,
    reminderDueAt: new Date('2026-10-06T09:05:00.000Z'),
    reminderIncidentId: ids.event,
    reminderOrdinal: 2,
    reminderStatus: 'REMINDER_ACTIVE',
    routePlanId: ids.route,
    routeVersion: 3,
    serviceDate: new Date('2026-10-06T00:00:00.000Z'),
    startedAt: null,
    status: 'ACTIVE',
    vehicleId: ids.vehicle,
    warehouseNotifiedAt: at,
    ...overrides,
  };
}

function route() {
  return {
    assignmentGeneration: 9n,
    id: ids.route,
    routeGroupingChildVersions: [{ driverId: ids.driver, id: ids.event }],
    status: 'READY',
  };
}

function admin(scopes: readonly ('dsv:control:read' | 'dsv:session:read')[] = ['dsv:control:read']) {
  return createDsvAdminPrincipal({ scopes, shopId: ids.shop });
}

describe('PrismaDsvExecutionApiService', () => {
  test('keeps the driver list to current target and command fences', async () => {
    const prisma = {
      driver: { findFirst: vi.fn().mockResolvedValue({ accountId: ids.account }) },
      dsvExecutionContext: { findMany: vi.fn().mockResolvedValue([context()]) },
      routePlan: { findFirst: vi.fn().mockResolvedValue(route()) },
    } as unknown as PrismaClient;
    const principal: DsvDriverPrincipal = {
      driverId: ids.driver,
      principalType: 'DRIVER',
      scopes: ['driver:assignments:read'],
      shopId: ids.shop,
    };
    const result = await new PrismaDsvExecutionApiService(prisma).list({ principal }) as { items: Array<Record<string, unknown>> };
    expect(result.items).toEqual([{
      assignmentEpoch: '4',
      assignmentGeneration: '9',
      executionContextId: ids.context,
      expectedRouteVersionId: ids.event,
      routePlanId: ids.route,
      routeVersion: 3,
      serviceDate: '2026-10-06',
      startedAt: null,
      status: 'ACTIVE',
    }]);
    expect(result.items[0]).not.toHaveProperty('reminderDueAt');
    expect(result.items[0]).not.toHaveProperty('warehouseNotifiedAt');
    expect(result.items[0]).not.toHaveProperty('driverId');
  });

  test('adds control state and missing-start delivery counts to the operations list', async () => {
    const prisma = {
      dsvExecutionContext: { findMany: vi.fn().mockResolvedValue([context()]) },
      dsvOperationalNotification: { findMany: vi.fn().mockResolvedValue([
        { businessStatus: 'OPEN', executionContextId: ids.context, id: ids.notification, kind: 'N05' },
      ]) },
      dsvOperationalNotificationAttempt: { findMany: vi.fn().mockResolvedValue([
        { attemptCount: 2, notificationId: ids.notification, status: 'RETRY' },
      ]) },
      routePlan: { findFirst: vi.fn().mockResolvedValue(route()) },
    } as unknown as PrismaClient;
    const result = await new PrismaDsvExecutionApiService(prisma).list({ principal: admin() }) as { items: Array<Record<string, unknown>> };
    expect(result.items[0]).toMatchObject({
      departureObservedAt: at.toISOString(),
      endReason: null,
      missingStartDelivery: {
        attemptRecordsByStatus: { RETRY: 1 },
        businessByStatus: { OPEN: 1 },
        workerAttemptCount: 2,
        warningCount: 1,
      },
      notificationSummary: { byBusinessStatus: { OPEN: 1 }, byKind: { N05: 1 }, total: 1 },
      reminderIncidentId: ids.event,
      reminderOrdinal: 2,
      warehouseNotifiedAt: at.toISOString(),
    });
  });

  test('returns bounded persisted evidence without raw locations, tokens or customer detail', async () => {
    const findContext = vi.fn().mockResolvedValue(context({ closedAt: at, status: 'COMPLETED' }));
    const transaction = vi.fn();
    const prisma = {
      $transaction: transaction,
      dsvDeliveryException: { findMany: vi.fn().mockResolvedValue([{
        acknowledgedAt: at, createdAt: at, id: ids.report, reasonCode: 'RECIPIENT_ABSENT',
        resolvedAt: null, status: 'ACKNOWLEDGED', targetStopId: ids.stop,
      }]) },
      dsvExecutionContext: { findFirst: findContext },
      dsvGeofenceEvent: { findMany: vi.fn().mockResolvedValue([{
        assignmentEpoch: 4n, confirmedAt: at, confirmedObservedAt: at, firstObservedAt: at,
        id: ids.event, policyVersion: 'synthetic-v1', routeVersion: 3, sourceSampleId: ids.sample,
        targetKey: 'WAREHOUSE', transition: 'DEPARTED', visitOrdinal: 1,
      }]) },
      dsvOperationalNotification: { findMany: vi.fn().mockResolvedValue([{
        assignmentEpoch: 4n, businessStatus: 'RESOLVED', createdAt: at, dueAt: at,
        expiresAt: new Date('2026-10-07T09:00:00.000Z'), id: ids.notification, kind: 'N05',
        ordinal: 2, resolutionReason: 'STARTED', resolvedAt: at, routeVersion: 3,
      }]) },
      dsvOperationalNotificationAttempt: { findMany: vi.fn().mockResolvedValue([{
        attemptCount: 2, completedAt: at, notificationId: ids.notification, status: 'SENT',
      }]) },
    } as unknown as PrismaClient;
    const result = await new PrismaDsvExecutionApiService(prisma).get({
      executionContextId: ids.context,
      principal: admin(),
    }) as Record<string, unknown>;
    expect(findContext).toHaveBeenCalledWith({ where: { id: ids.context, shopId: ids.shop } });
    expect(result).toMatchObject({
      context: { endReason: 'COMPLETED', executionContextId: ids.context },
      deliveryExceptions: { byStatus: { ACKNOWLEDGED: 1 }, truncated: false },
      geofenceEvidence: {
        items: [{
          boundary: { targetKey: 'WAREHOUSE', transition: 'DEPARTED', visitOrdinal: 1 },
          confirmedAt: at.toISOString(),
          policyVersion: 'synthetic-v1',
          sourceSampleId: ids.sample,
        }],
        truncated: false,
      },
      notifications: {
        attemptRecordsByStatus: { SENT: 1 },
        byKind: { N05: 1 },
        workerAttemptCount: 2,
      },
    });
    expect(JSON.stringify(result)).not.toContain('latitude');
    expect(JSON.stringify(result)).not.toContain('token');
    expect(JSON.stringify(result)).not.toContain('explanation');
    expect(transaction).not.toHaveBeenCalled();
  });

  test('rejects missing control scope and cross-tenant contexts before evidence reads', async () => {
    const eventFindMany = vi.fn();
    const notificationFindMany = vi.fn();
    const reportFindMany = vi.fn();
    const contextFindFirst = vi.fn().mockResolvedValue(null);
    const prisma = {
      dsvDeliveryException: { findMany: reportFindMany },
      dsvExecutionContext: { findFirst: contextFindFirst },
      dsvGeofenceEvent: { findMany: eventFindMany },
      dsvOperationalNotification: { findMany: notificationFindMany },
    } as unknown as PrismaClient;
    const service = new PrismaDsvExecutionApiService(prisma);
    await expect(service.get({ executionContextId: ids.context, principal: admin(['dsv:session:read']) })).rejects.toMatchObject({ code: 'DSV_FORBIDDEN' });
    expect(contextFindFirst).not.toHaveBeenCalled();
    await expect(service.get({ executionContextId: ids.context, principal: admin() })).rejects.toMatchObject({ code: 'CONTEXT_NOT_FOUND' });
    expect(contextFindFirst).toHaveBeenCalledWith({ where: { id: ids.context, shopId: ids.shop } });
    expect(eventFindMany).not.toHaveBeenCalled();
    expect(notificationFindMany).not.toHaveBeenCalled();
    expect(reportFindMany).not.toHaveBeenCalled();
  });
});
