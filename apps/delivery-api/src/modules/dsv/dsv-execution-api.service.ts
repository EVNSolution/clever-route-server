import type { PrismaClient } from '@prisma/client';

import { PrismaDsvExecutionContextService } from './dsv-execution-context.service.js';
import { DsvExecutionCommandError } from './dsv-execution-commands.service.js';
import { requireDsvScopes, type DsvPrincipal } from './dsv-principal.js';
import type { DsvExecutionContextApi } from '../../routes/dsv-execution.routes.js';

/** New operational DTOs do not change the existing web or driver DTOs. */
export class PrismaDsvExecutionApiService implements DsvExecutionContextApi {
  constructor(private readonly prisma: PrismaClient) {}

  async list(input: { principal: DsvPrincipal; serviceDate?: string }): Promise<unknown> {
    const principal = input.principal;
    let accountId: string | null = null;
    if (principal.principalType === 'DRIVER') {
      const driver = await this.prisma.driver.findFirst({
        where: { id: principal.driverId, shopId: principal.shopId, status: 'ACTIVE', account: { status: 'ACTIVE' } },
        select: { accountId: true },
      });
      if (driver?.accountId === null || driver === null) throw new DsvExecutionCommandError('UNAUTHORIZED');
      accountId = driver.accountId;
    } else {
      if (principal.principalType !== 'DSV_ADMIN') throw new DsvExecutionCommandError('UNAUTHORIZED');
      requireDsvScopes(principal, ['dsv:control:read']);
    }
    const contexts = await this.prisma.dsvExecutionContext.findMany({
      where: {
        shopId: principal.shopId,
        ...(input.serviceDate === undefined ? {} : { serviceDate: new Date(`${input.serviceDate}T00:00:00Z`) }),
        ...(principal.principalType === 'DRIVER' ? { driverId: principal.driverId, recipientAccountId: accountId, status: 'ACTIVE' } : {}),
      },
      orderBy: [{ serviceDate: 'desc' }, { id: 'asc' }],
      take: 100,
    });
    const items: Array<Record<string, unknown>> = [];
    for (const context of contexts) {
      const route = await this.prisma.routePlan.findFirst({
        where: {
          id: context.routePlanId, shopId: principal.shopId,
          ...(principal.principalType === 'DRIVER' ? { driverId: principal.driverId, vehicleId: context.vehicleId, status: { in: ['READY', 'IN_PROGRESS'] } } : {}),
        },
        select: {
          id: true, assignmentGeneration: true, status: true,
          routeGroupingChildVersions: { where: { status: 'CURRENT', supersededAt: null, publishedAt: { not: null } }, take: 1, select: { id: true, driverId: true } },
        },
      });
      const child = route?.routeGroupingChildVersions[0];
      if (principal.principalType === 'DRIVER' && (route === null || child === undefined || child.driverId !== principal.driverId)) continue;
      const common = {
        executionContextId: context.id, routePlanId: context.routePlanId,
        routeVersion: context.routeVersion, assignmentEpoch: context.assignmentEpoch.toString(),
        expectedRouteVersionId: child?.id ?? null, assignmentGeneration: route?.assignmentGeneration.toString() ?? null,
        serviceDate: context.serviceDate.toISOString().slice(0, 10), status: context.status,
        startedAt: context.startedAt?.toISOString() ?? null,
      };
      items.push(principal.principalType === 'DRIVER' ? common : {
        ...common,
        closedAt: context.closedAt?.toISOString() ?? null,
        departureObservedAt: context.departureObservedAt?.toISOString() ?? null,
        driverId: context.driverId,
        endReason: context.status === 'ACTIVE' ? null : context.status,
        monitorEndAt: context.monitorEndAt?.toISOString() ?? null,
        monitorStartAt: context.monitorStartAt?.toISOString() ?? null,
        notificationMode: context.notificationMode,
        reminderDueAt: context.reminderDueAt?.toISOString() ?? null,
        reminderIncidentId: context.reminderIncidentId,
        reminderOrdinal: context.reminderOrdinal,
        reminderStatus: context.reminderStatus,
        vehicleId: context.vehicleId,
        warehouseNotifiedAt: context.warehouseNotifiedAt?.toISOString() ?? null,
      });
    }
    if (principal.principalType === 'DSV_ADMIN' && items.length > 0) {
      const contextIds = items.map((item) => String(item.executionContextId));
      const notificationRows = await this.prisma.dsvOperationalNotification.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { businessStatus: true, executionContextId: true, id: true, kind: true },
        take: 1_001,
        where: { executionContextId: { in: contextIds }, shopId: principal.shopId },
      });
      const notifications = notificationRows.slice(0, 1_000);
      const warningIds = notifications.filter((notification) => notification.kind === 'N05').map((notification) => notification.id);
      const attemptRows = warningIds.length === 0 ? [] : await this.prisma.dsvOperationalNotificationAttempt.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { attemptCount: true, notificationId: true, status: true },
        take: 1_001,
        where: { notificationId: { in: warningIds }, shopId: principal.shopId },
      });
      const attempts = attemptRows.slice(0, 1_000);
      for (const item of items) {
        const contextNotifications = notifications.filter((notification) => notification.executionContextId === item.executionContextId);
        const warnings = contextNotifications.filter((notification) => notification.kind === 'N05');
        const warningIdSet = new Set(warnings.map((warning) => warning.id));
        const warningAttempts = attempts.filter((attempt) => warningIdSet.has(attempt.notificationId));
        item.notificationSummary = {
          byBusinessStatus: countBy(contextNotifications, (notification) => notification.businessStatus),
          byKind: countBy(contextNotifications, (notification) => notification.kind),
          total: contextNotifications.length,
        };
        item.missingStartDelivery = {
          attemptRecordsByStatus: countBy(warningAttempts, (attempt) => attempt.status),
          businessByStatus: countBy(warnings, (warning) => warning.businessStatus),
          workerAttemptCount: warningAttempts.reduce((total, attempt) => total + attempt.attemptCount, 0),
          warningCount: warnings.length,
        };
        item.operationalSummaryTruncated = notificationRows.length > 1_000 || attemptRows.length > 1_000;
      }
    }
    return { items, limit: 100 };
  }

  async get(input: { executionContextId: string; principal: DsvPrincipal }): Promise<unknown> {
    if (input.principal.principalType !== 'DSV_ADMIN') throw new DsvExecutionCommandError('UNAUTHORIZED');
    requireDsvScopes(input.principal, ['dsv:control:read']);
    const context = await this.prisma.dsvExecutionContext.findFirst({
      where: { id: input.executionContextId, shopId: input.principal.shopId },
    });
    if (context === null) throw new DsvExecutionCommandError('CONTEXT_NOT_FOUND');

    const [eventRows, notificationRows, reportRows] = await Promise.all([
      this.prisma.dsvGeofenceEvent.findMany({
        orderBy: [{ confirmedObservedAt: 'desc' }, { id: 'desc' }],
        select: {
          assignmentEpoch: true,
          confirmedAt: true,
          confirmedObservedAt: true,
          firstObservedAt: true,
          id: true,
          policyVersion: true,
          routeVersion: true,
          sourceSampleId: true,
          targetKey: true,
          transition: true,
          visitOrdinal: true,
        },
        take: 101,
        where: { executionContextId: context.id, shopId: input.principal.shopId },
      }),
      this.prisma.dsvOperationalNotification.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: {
          assignmentEpoch: true,
          businessStatus: true,
          createdAt: true,
          dueAt: true,
          expiresAt: true,
          id: true,
          kind: true,
          ordinal: true,
          resolutionReason: true,
          resolvedAt: true,
          routeVersion: true,
        },
        take: 101,
        where: { executionContextId: context.id, shopId: input.principal.shopId },
      }),
      this.prisma.dsvDeliveryException.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: {
          acknowledgedAt: true,
          createdAt: true,
          emailSentAt: true,
          emailStatus: true,
          explanation: true,
          id: true,
          reasonCode: true,
          resolvedAt: true,
          status: true,
          targetStopId: true,
        },
        take: 101,
        where: { executionContextId: context.id, shopId: input.principal.shopId },
      }),
    ]);
    const notifications = notificationRows.slice(0, 100);
    const attempts = notifications.length === 0 ? [] : await this.prisma.dsvOperationalNotificationAttempt.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { attemptCount: true, completedAt: true, notificationId: true, status: true },
      take: 1_001,
      where: { notificationId: { in: notifications.map((notification) => notification.id) }, shopId: input.principal.shopId },
    });
    const boundedAttempts = attempts.slice(0, 1_000);
    const attemptByNotification = new Map<string, typeof boundedAttempts>();
    for (const attempt of boundedAttempts) {
      const rows = attemptByNotification.get(attempt.notificationId) ?? [];
      rows.push(attempt);
      attemptByNotification.set(attempt.notificationId, rows);
    }
    return {
      context: {
        assignmentEpoch: context.assignmentEpoch.toString(),
        closedAt: context.closedAt?.toISOString() ?? null,
        departureObservedAt: context.departureObservedAt?.toISOString() ?? null,
        driverId: context.driverId,
        effectiveAt: context.effectiveAt.toISOString(),
        endReason: context.status === 'ACTIVE' ? null : context.status,
        executionContextId: context.id,
        liveEligibleAt: context.liveEligibleAt?.toISOString() ?? null,
        monitorEndAt: context.monitorEndAt?.toISOString() ?? null,
        monitorStartAt: context.monitorStartAt?.toISOString() ?? null,
        notificationMode: context.notificationMode,
        reminderDueAt: context.reminderDueAt?.toISOString() ?? null,
        reminderIncidentId: context.reminderIncidentId,
        reminderOrdinal: context.reminderOrdinal,
        reminderStatus: context.reminderStatus,
        routePlanId: context.routePlanId,
        routeVersion: context.routeVersion,
        serviceDate: context.serviceDate.toISOString().slice(0, 10),
        startedAt: context.startedAt?.toISOString() ?? null,
        status: context.status,
        vehicleId: context.vehicleId,
        warehouseNotifiedAt: context.warehouseNotifiedAt?.toISOString() ?? null,
      },
      deliveryExceptions: {
        byStatus: countBy(reportRows.slice(0, 100), (report) => report.status),
        items: reportRows.slice(0, 100).map((report) => ({
          acknowledgedAt: report.acknowledgedAt?.toISOString() ?? null,
          createdAt: report.createdAt.toISOString(),
          emailSentAt: report.emailSentAt?.toISOString() ?? null,
          emailStatus: report.emailStatus,
          id: report.id,
          reason: report.explanation ?? report.reasonCode,
          reasonCode: report.reasonCode,
          resolvedAt: report.resolvedAt?.toISOString() ?? null,
          status: report.status,
          targetStopId: report.targetStopId,
        })),
        limit: 100,
        truncated: reportRows.length > 100,
      },
      geofenceEvidence: {
        items: eventRows.slice(0, 100).map((event) => ({
          assignmentEpoch: event.assignmentEpoch.toString(),
          boundary: { targetKey: event.targetKey, transition: event.transition, visitOrdinal: event.visitOrdinal },
          confirmedAt: event.confirmedAt.toISOString(),
          confirmedObservedAt: event.confirmedObservedAt.toISOString(),
          firstObservedAt: event.firstObservedAt.toISOString(),
          id: event.id,
          policyVersion: event.policyVersion,
          routeVersion: event.routeVersion,
          sourceSampleId: event.sourceSampleId,
        })),
        limit: 100,
        truncated: eventRows.length > 100,
      },
      notifications: {
        attemptRecordsByStatus: countBy(boundedAttempts, (attempt) => attempt.status),
        attemptsTruncated: attempts.length > 1_000,
        byBusinessStatus: countBy(notifications, (notification) => notification.businessStatus),
        byKind: countBy(notifications, (notification) => notification.kind),
        items: notifications.map((notification) => {
          const notificationAttempts = attemptByNotification.get(notification.id) ?? [];
          return {
            assignmentEpoch: notification.assignmentEpoch.toString(),
            attemptRecordsByStatus: countBy(notificationAttempts, (attempt) => attempt.status),
            businessStatus: notification.businessStatus,
            createdAt: notification.createdAt.toISOString(),
            dueAt: notification.dueAt.toISOString(),
            expiresAt: notification.expiresAt.toISOString(),
            id: notification.id,
            kind: notification.kind,
            lastCompletedAt: notificationAttempts
              .map((attempt) => attempt.completedAt)
              .filter((value): value is Date => value !== null)
              .sort((left, right) => right.getTime() - left.getTime())[0]?.toISOString() ?? null,
            ordinal: notification.ordinal,
            workerAttemptCount: notificationAttempts.reduce((total, attempt) => total + attempt.attemptCount, 0),
            resolutionReason: notification.resolutionReason,
            resolvedAt: notification.resolvedAt?.toISOString() ?? null,
            routeVersion: notification.routeVersion,
          };
        }),
        limit: 100,
        workerAttemptCount: boundedAttempts.reduce((total, attempt) => total + attempt.attemptCount, 0),
        truncated: notificationRows.length > 100,
      },
    };
  }

  async map(input: Parameters<DsvExecutionContextApi['map']>[0]): Promise<unknown> {
    requireDsvScopes(input.principal, ['dsv:dispatches:write']);
    // Future mappings cannot authorize present GPS evidence.
    const now = new Date();
    if (input.effectiveAt.getTime() > now.getTime()) {
      throw new DsvExecutionCommandError('INVALID_INPUT');
    }
    return this.prisma.$transaction(async (tx) => new PrismaDsvExecutionContextService(tx).syncForRoute({
      shopId: input.principal.shopId, routePlanId: input.routePlanId, commandId: input.commandId,
      tripIntent: input.mapping, now: input.effectiveAt,
      ...(input.executionContextId === undefined ? {} : { executionContextId: input.executionContextId }),
    }));
  }

  async select(input: Parameters<DsvExecutionContextApi['select']>[0]): Promise<unknown> {
    requireDsvScopes(input.principal, ['dsv:dispatches:write']);
    return this.prisma.$transaction(async (tx) => new PrismaDsvExecutionContextService(tx).selectActiveExecution({
      shopId: input.principal.shopId, vehicleId: input.vehicleId, executionContextId: input.executionContextId,
      commandId: input.commandId, validFrom: input.validFrom, validUntil: input.validUntil,
    }));
  }
}

function countBy<T>(rows: readonly T[], key: (row: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const value = key(row);
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}
