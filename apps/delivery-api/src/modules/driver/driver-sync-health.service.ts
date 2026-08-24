import { Prisma, type PrismaClient } from '@prisma/client';
import type { DriverRouteAccessScope } from './driver-token-access.repository.js';
import type { PrismaOperationalAlertRepository } from '../notifications/operational-alert.repository.js';

export const DRIVER_SYNC_HEALTH_DEFAULTS = {
  heartbeatAbsentSeconds: 180,
  healthyHeartbeatSeconds: 60,
  leaseSeconds: 180,
  mismatchDurationSeconds: 120,
  mismatchStopGap: 2,
  oldestQueueSeconds: 300,
  maxFutureClockSkewSeconds: 60,
  retentionDays: 30
} as const;

export type DriverSyncHeartbeatInput = {
  appVersion: string;
  clientOccurredAt: Date;
  completedStopCount: number | null;
  currentStopSequence: number | null;
  deviceInstanceHash: string;
  driverContractVersion: number;
  finishPending: boolean;
  firstErrorCode: string | null;
  firstFailedAt: Date | null;
  heartbeatSequence: number;
  lastAcknowledgedAt: Date | null;
  lastErrorCode: string | null;
  lastRetryAt: Date | null;
  locallyFinished: boolean | null;
  nextRetryAt: Date | null;
  oldestQueuedAt: Date | null;
  queueDepth: number | null;
  retryCount: number;
  retryJournal: Prisma.InputJsonValue | null;
  sessionGeneration: string;
  totalStopCount: number | null;
  versionCode: number;
};

export type DriverSyncHealthDto = {
  appVersion: string;
  clientOccurredAt: string;
  deviceInstanceHash: string;
  driverContractVersion: number;
  finishPending: boolean;
  firstErrorCode: string | null;
  firstFailedAt: string | null;
  heartbeatSequence: number;
  lastAcknowledgedAt: string | null;
  lastErrorCode: string | null;
  lastObservedAt: string;
  lastRetryAt: string | null;
  nextRetryAt: string | null;
  oldestQueuedAt: string | null;
  queueDepth: number | null;
  retryCount: number;
  serverReceivedAt: string;
  sessionGeneration: string;
  state: 'BLOCKED' | 'DELAYED' | 'HEALTHY' | 'UNKNOWN';
  versionCode: number;
};

export type DriverSyncHeartbeatResult = {
  accepted: boolean;
  conflict: boolean;
  syncHealth: DriverSyncHealthDto;
};

export class PrismaDriverSyncHealthService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly alerts?: PrismaOperationalAlertRepository,
    private readonly now: () => Date = () => new Date()
  ) {}

  async recordHeartbeat(context: DriverRouteAccessScope, input: DriverSyncHeartbeatInput): Promise<DriverSyncHeartbeatResult> {
    const now = this.now();
    const expiresAt = new Date(now.getTime() + DRIVER_SYNC_HEALTH_DEFAULTS.leaseSeconds * 1000);
    const retainedUntil = new Date(now.getTime() + DRIVER_SYNC_HEALTH_DEFAULTS.retentionDays * 24 * 60 * 60 * 1000);
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "route_plans" WHERE "id" = ${context.routePlanId}::uuid FOR UPDATE`;
      const sessionKey = {
        deviceInstanceHash: input.deviceInstanceHash,
        driverId: context.driverId,
        routePlanId: context.routePlanId,
        sessionGeneration: input.sessionGeneration
      };
      let session = await tx.driverSyncSession.findUnique({
        where: { routePlanId_driverId_deviceInstanceHash_sessionGeneration: sessionKey }
      });
      if (session !== null) {
        const latest = await tx.driverSyncHeartbeat.findFirst({
          orderBy: { heartbeatSequence: 'desc' },
          where: { syncSessionId: session.id }
        });
        if (latest !== null && input.heartbeatSequence <= latest.heartbeatSequence) {
          const activeLease = await tx.driverRouteSessionLease.findFirst({
            where: { driverId: context.driverId, expiresAt: { gt: now }, revokedAt: null, routePlanId: context.routePlanId }
          });
          return { accepted: false, conflict: activeLease !== null && activeLease.syncSessionId !== session.id, heartbeat: latest, session };
        }
        session = await tx.driverSyncSession.update({
          data: {
            appVersion: input.appVersion,
            driverContractVersion: input.driverContractVersion,
            expiresAt,
            lastObservedAt: now,
            versionCode: input.versionCode
          },
          where: { id: session.id }
        });
      } else {
        session = await tx.driverSyncSession.create({
          data: {
          appVersion: input.appVersion,
          deviceInstanceHash: input.deviceInstanceHash,
          driverContractVersion: input.driverContractVersion,
          driverId: context.driverId,
          expiresAt,
          firstObservedAt: now,
          lastObservedAt: now,
          routePlanId: context.routePlanId,
          sessionGeneration: input.sessionGeneration,
          shopId: context.shopId,
          versionCode: input.versionCode
          }
        });
      }
      const state = deriveSyncState(input, now);
      const heartbeat = await tx.driverSyncHeartbeat.create({
        data: {
          clientOccurredAt: input.clientOccurredAt,
          completedStopCount: input.completedStopCount,
          currentStopSequence: input.currentStopSequence,
          finishPending: input.finishPending,
          firstErrorCode: input.firstErrorCode,
          firstFailedAt: input.firstFailedAt,
          heartbeatSequence: input.heartbeatSequence,
          lastAcknowledgedAt: input.lastAcknowledgedAt,
          lastErrorCode: input.lastErrorCode,
          lastRetryAt: input.lastRetryAt,
          locallyFinished: input.locallyFinished,
          nextRetryAt: input.nextRetryAt,
          oldestQueuedAt: input.oldestQueuedAt,
          queueDepth: input.queueDepth,
          retainedUntil,
          retryCount: input.retryCount,
          ...(input.retryJournal === null ? {} : { retryJournal: input.retryJournal }),
          serverReceivedAt: now,
          state,
          syncSessionId: session.id,
          totalStopCount: input.totalStopCount
        }
      });
      await tx.driverRouteSessionLease.updateMany({
        data: { revokedAt: now },
        where: { driverId: context.driverId, expiresAt: { lte: now }, revokedAt: null, routePlanId: context.routePlanId }
      });
      const currentLease = await tx.driverRouteSessionLease.findFirst({
        where: { driverId: context.driverId, expiresAt: { gt: now }, revokedAt: null, routePlanId: context.routePlanId }
      });
      if (currentLease === null) {
        await tx.driverRouteSessionLease.create({
          data: {
            deviceInstanceHash: input.deviceInstanceHash,
            driverId: context.driverId,
            expiresAt,
            issuedAt: now,
            routePlanId: context.routePlanId,
            sessionGeneration: input.sessionGeneration,
            shopId: context.shopId,
            syncSessionId: session.id
          }
        });
      } else if (currentLease.syncSessionId === session.id) {
        await tx.driverRouteSessionLease.update({ data: { expiresAt }, where: { id: currentLease.id } });
      }
      return { accepted: true, conflict: currentLease !== null && currentLease.syncSessionId !== session.id, heartbeat, session };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    if (result.accepted && result.conflict) {
      await this.alerts?.openOrObserve({
        dedupeKey: `MULTI_DEVICE_CONFLICT:${context.routePlanId}:${context.driverId}`,
        observedAt: now,
        routePlanId: context.routePlanId,
        severity: 'CRITICAL',
        shopId: context.shopId,
        title: 'Multiple active driver devices',
        type: 'MULTI_DEVICE_CONFLICT'
      });
    }
    if (result.accepted) {
      await this.alerts?.resolveByDedupeKey({
        dedupeKey: `HEARTBEAT_ABSENT:${context.routePlanId}:${context.driverId}`,
        resolutionCode: 'HEARTBEAT_RECOVERED',
        resolvedAt: now,
        shopId: context.shopId
      });
      await this.observeMismatch(context, result.session.id, result.heartbeat, now);
    }
    return {
      accepted: result.accepted,
      conflict: result.conflict,
      syncHealth: toSyncHealth(result.session, result.heartbeat, result.conflict ? 'BLOCKED' : undefined)
    };
  }

  async takeover(input: {
    accountId: string;
    deviceInstanceHash: string;
    routePlanId: string;
    sessionGeneration: string;
  }): Promise<boolean> {
    const now = this.now();
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "route_plans" WHERE "id" = ${input.routePlanId}::uuid FOR UPDATE`;
      const route = await tx.routePlan.findFirst({
        select: { driver: { select: { accountId: true } }, driverId: true, shopId: true },
        where: { id: input.routePlanId }
      });
      if (route?.driverId === null || route?.driver?.accountId !== input.accountId) return null;
      const session = await tx.driverSyncSession.findUnique({
        where: { routePlanId_driverId_deviceInstanceHash_sessionGeneration: {
          deviceInstanceHash: input.deviceInstanceHash,
          driverId: route.driverId,
          routePlanId: input.routePlanId,
          sessionGeneration: input.sessionGeneration
        } }
      });
      if (session === null) return null;
      await tx.driverRouteSessionLease.updateMany({
        data: { revokedAt: now },
        where: { driverId: route.driverId, expiresAt: { lte: now }, revokedAt: null, routePlanId: input.routePlanId }
      });
      const prior = await tx.driverRouteSessionLease.findFirst({
        where: { driverId: route.driverId, expiresAt: { gt: now }, revokedAt: null, routePlanId: input.routePlanId }
      });
      if (prior?.syncSessionId === session.id && prior.expiresAt > now) return { alertId: null, shopId: route.shopId };
      if (prior !== null) await tx.driverRouteSessionLease.update({ data: { revokedAt: now }, where: { id: prior.id } });
      await tx.driverRouteSessionLease.create({
        data: {
          deviceInstanceHash: session.deviceInstanceHash,
          driverId: route.driverId,
          expiresAt: new Date(now.getTime() + DRIVER_SYNC_HEALTH_DEFAULTS.leaseSeconds * 1000),
          issuedAt: now,
          routePlanId: input.routePlanId,
          sessionGeneration: session.sessionGeneration,
          shopId: route.shopId,
          syncSessionId: session.id,
          takeoverActorId: input.accountId,
          takeoverFromHash: prior?.deviceInstanceHash ?? null
        }
      });
      const conflict = await tx.alertCycle.findFirst({
        select: { id: true },
        where: { condition: { dedupeKey: `MULTI_DEVICE_CONFLICT:${input.routePlanId}:${route.driverId}`, shopId: route.shopId }, resolvedAt: null }
      });
      return { alertId: conflict?.id ?? null, shopId: route.shopId };
    });
    if (result === null) return false;
    if (result.alertId !== null) {
      await this.alerts?.resolve({ alertId: result.alertId, resolutionCode: 'EXPLICIT_TAKEOVER', resolvedAt: now, shopId: result.shopId });
    }
    return true;
  }

  async getActiveSyncHealth(routePlanId: string, now = this.now()): Promise<DriverSyncHealthDto | null> {
    return (await this.getActiveSyncHealthForRoutePlans([routePlanId], now)).get(routePlanId) ?? null;
  }

  async getActiveSyncHealthForRoutePlans(
    routePlanIds: string[],
    now = this.now()
  ): Promise<Map<string, DriverSyncHealthDto>> {
    if (routePlanIds.length === 0) return new Map();
    const [leases, sessionCounts, unresolvedConflicts] = await Promise.all([
      this.prisma.driverRouteSessionLease.findMany({
        include: { syncSession: { include: { heartbeats: { orderBy: { heartbeatSequence: 'desc' }, take: 1 } } } },
        orderBy: { issuedAt: 'desc' },
        where: { expiresAt: { gt: now }, revokedAt: null, routePlanId: { in: routePlanIds } }
      }),
      this.prisma.driverRouteSessionLease.groupBy({
        _count: { _all: true },
        by: ['routePlanId'],
        where: { expiresAt: { gt: now }, revokedAt: null, routePlanId: { in: routePlanIds } }
      }),
      this.prisma.alertCycle.findMany({
        select: { condition: { select: { routePlanId: true } } },
        where: {
          condition: { routePlanId: { in: routePlanIds }, type: 'MULTI_DEVICE_CONFLICT' },
          resolvedAt: null
        }
      })
    ]);
    const conflictsByRoutePlan = new Map(sessionCounts.map((row) => [row.routePlanId, row._count._all]));
    const unresolvedConflictRoutePlanIds = new Set(unresolvedConflicts.flatMap(({ condition }) => condition.routePlanId === null ? [] : [condition.routePlanId]));
    const result = new Map<string, DriverSyncHealthDto>();
    for (const lease of leases) {
      if (result.has(lease.routePlanId)) continue;
      const heartbeat = lease.syncSession.heartbeats[0];
      if (heartbeat === undefined) continue;
      result.set(
        lease.routePlanId,
        toSyncHealth(
          lease.syncSession,
          heartbeat,
          (conflictsByRoutePlan.get(lease.routePlanId) ?? 0) > 1 || unresolvedConflictRoutePlanIds.has(lease.routePlanId)
            ? 'BLOCKED'
            : undefined,
          now
        )
      );
    }
    return result;
  }

  async detectOperationalHealth(): Promise<{ heartbeatAbsent: number; routesChecked: number }> {
    if (this.alerts === undefined) return { heartbeatAbsent: 0, routesChecked: 0 };
    const now = this.now();
    const routes = await this.prisma.routePlan.findMany({
      include: {
        driverRouteSessionLeases: {
          include: { syncSession: { include: { heartbeats: { orderBy: { heartbeatSequence: 'desc' }, take: 1 } } } },
          orderBy: { issuedAt: 'desc' }, take: 1, where: { expiresAt: { gt: now }, revokedAt: null }
        }
      },
      where: { driverId: { not: null }, status: 'IN_PROGRESS' }
    });
    let heartbeatAbsent = 0;
    for (const route of routes) {
      if (route.driverId === null) continue;
      const heartbeatDedupeKey = `HEARTBEAT_ABSENT:${route.id}:${route.driverId}`;
      const activeLease = route.driverRouteSessionLeases[0];
      const activeHeartbeat = activeLease?.syncSession.heartbeats[0];
      const heartbeatIsAbsent = activeHeartbeat === undefined
        || now.getTime() - activeHeartbeat.serverReceivedAt.getTime() > DRIVER_SYNC_HEALTH_DEFAULTS.heartbeatAbsentSeconds * 1000;
      if (heartbeatIsAbsent) {
        heartbeatAbsent += 1;
        await this.alerts.openOrObserve({
          dedupeKey: heartbeatDedupeKey, observedAt: now, routePlanId: route.id, severity: 'CRITICAL', shopId: route.shopId,
          title: 'Driver heartbeat is absent', type: 'HEARTBEAT_ABSENT'
        });
      } else if (activeLease !== undefined && activeHeartbeat !== undefined) {
        await this.alerts.resolveByDedupeKey({
          dedupeKey: heartbeatDedupeKey,
          resolutionCode: 'HEARTBEAT_RECOVERED_BY_DETECTOR',
          resolvedAt: now,
          shopId: route.shopId
        });
      }
      if (activeLease !== undefined && activeHeartbeat !== undefined) {
        await this.observeMismatch(
          { driverId: route.driverId, routePlanId: route.id, shopId: route.shopId },
          activeLease.syncSessionId,
          activeHeartbeat,
          now
        );
      }
    }
    return { heartbeatAbsent, routesChecked: routes.length };
  }

  private async observeMismatch(
    context: Pick<DriverRouteAccessScope, 'driverId' | 'routePlanId' | 'shopId'>,
    syncSessionId: string,
    heartbeat: { completedStopCount: number | null; oldestQueuedAt: Date | null; queueDepth: number | null; serverReceivedAt: Date },
    now: Date
  ): Promise<void> {
    if (this.alerts === undefined) return;
    const futureQueueClock = heartbeat.oldestQueuedAt !== null
      && heartbeat.oldestQueuedAt.getTime() - now.getTime() > DRIVER_SYNC_HEALTH_DEFAULTS.maxFutureClockSkewSeconds * 1000;
    const staleQueueObservation = (heartbeat.queueDepth ?? 0) > 0
      ? await this.prisma.driverSyncHeartbeat.findFirst({
          select: { id: true },
          where: {
            queueDepth: { gt: 0 },
            serverReceivedAt: { lte: new Date(now.getTime() - DRIVER_SYNC_HEALTH_DEFAULTS.oldestQueueSeconds * 1000) },
            syncSessionId
          }
        })
      : null;
    const staleQueue = futureQueueClock || staleQueueObservation !== null;
    const queueDedupeKey = `SYNC_QUEUE_STALE:${context.routePlanId}:${context.driverId}`;
    if (staleQueue) {
      await this.alerts.openOrObserve({
        dedupeKey: queueDedupeKey,
        observedAt: now, routePlanId: context.routePlanId, severity: 'CRITICAL', shopId: context.shopId,
        title: 'Driver ordered queue is stale', type: 'SYNC_QUEUE_STALE'
      });
    } else {
      await this.alerts.resolveByDedupeKey({ dedupeKey: queueDedupeKey, resolutionCode: 'QUEUE_RECOVERED', resolvedAt: now, shopId: context.shopId });
    }
    if (heartbeat.completedStopCount === null) return;
    const serverResolved = await this.prisma.routePlanStop.count({
      where: { deliveryStop: { status: { in: ['CANCELLED', 'DELIVERED', 'FAILED', 'SKIPPED'] } }, routePlanId: context.routePlanId }
    });
    const mismatchDedupeKey = `PROGRESS_MISMATCH:${context.routePlanId}:${context.driverId}`;
    if (heartbeat.completedStopCount - serverResolved < DRIVER_SYNC_HEALTH_DEFAULTS.mismatchStopGap) {
      await this.alerts.resolveByDedupeKey({ dedupeKey: mismatchDedupeKey, resolutionCode: 'PROGRESS_CONVERGED', resolvedAt: now, shopId: context.shopId });
      return;
    }
    const threshold = new Date(now.getTime() - DRIVER_SYNC_HEALTH_DEFAULTS.mismatchDurationSeconds * 1000);
    const priorCycle = await this.prisma.alertCycle.findFirst({
      orderBy: { resolvedAt: 'desc' },
      select: { resolvedAt: true },
      where: { condition: { dedupeKey: mismatchDedupeKey, shopId: context.shopId }, resolvedAt: { not: null } }
    });
    const observationFloor = priorCycle?.resolvedAt ?? new Date(0);
    const qualifying = await this.prisma.driverSyncHeartbeat.findFirst({
      where: {
        completedStopCount: { gte: serverResolved + DRIVER_SYNC_HEALTH_DEFAULTS.mismatchStopGap },
        serverReceivedAt: { gt: observationFloor, lte: threshold },
        syncSessionId
      }
    });
    if (qualifying === null) return;
    await this.alerts.openOrObserve({
      dedupeKey: mismatchDedupeKey,
      observedAt: now, routePlanId: context.routePlanId, severity: 'CRITICAL', shopId: context.shopId,
      title: 'Driver progress differs from server progress', type: 'PROGRESS_MISMATCH'
    });
  }
}

function deriveSyncState(input: DriverSyncHeartbeatInput, now: Date): DriverSyncHealthDto['state'] {
  const queueAgeMs = input.oldestQueuedAt === null ? 0 : now.getTime() - input.oldestQueuedAt.getTime();
  const futureClientClock = input.clientOccurredAt.getTime() - now.getTime()
    > DRIVER_SYNC_HEALTH_DEFAULTS.maxFutureClockSkewSeconds * 1000;
  const futureQueueClock = input.oldestQueuedAt !== null
    && input.oldestQueuedAt.getTime() - now.getTime() > DRIVER_SYNC_HEALTH_DEFAULTS.maxFutureClockSkewSeconds * 1000;
  if (input.finishPending || input.firstErrorCode !== null || futureClientClock || futureQueueClock || queueAgeMs >= DRIVER_SYNC_HEALTH_DEFAULTS.oldestQueueSeconds * 1000) return 'BLOCKED';
  if ((input.queueDepth ?? 0) > 0 || now.getTime() - input.clientOccurredAt.getTime() > DRIVER_SYNC_HEALTH_DEFAULTS.healthyHeartbeatSeconds * 1000) return 'DELAYED';
  return 'HEALTHY';
}

function toSyncHealth(
  session: { appVersion: string; deviceInstanceHash: string; driverContractVersion: number; lastObservedAt: Date; sessionGeneration: string; versionCode: number },
  heartbeat: { clientOccurredAt: Date; finishPending: boolean; firstErrorCode: string | null; firstFailedAt: Date | null; heartbeatSequence: number; lastAcknowledgedAt: Date | null; lastErrorCode: string | null; lastRetryAt: Date | null; nextRetryAt: Date | null; oldestQueuedAt: Date | null; queueDepth: number | null; retryCount: number; serverReceivedAt: Date; state: string },
  forcedState?: DriverSyncHealthDto['state'],
  observedAt?: Date
): DriverSyncHealthDto {
  const persistedState = heartbeat.state === 'BLOCKED' || heartbeat.state === 'DELAYED' || heartbeat.state === 'HEALTHY' ? heartbeat.state : 'UNKNOWN';
  const heartbeatAgeMs = observedAt === undefined ? 0 : observedAt.getTime() - heartbeat.serverReceivedAt.getTime();
  const projectedState = heartbeatAgeMs > DRIVER_SYNC_HEALTH_DEFAULTS.heartbeatAbsentSeconds * 1000
    ? 'BLOCKED'
    : heartbeatAgeMs > DRIVER_SYNC_HEALTH_DEFAULTS.healthyHeartbeatSeconds * 1000 && persistedState === 'HEALTHY'
      ? 'DELAYED'
      : persistedState;
  return {
    appVersion: session.appVersion, clientOccurredAt: heartbeat.clientOccurredAt.toISOString(),
    deviceInstanceHash: session.deviceInstanceHash, driverContractVersion: session.driverContractVersion,
    finishPending: heartbeat.finishPending, firstErrorCode: heartbeat.firstErrorCode,
    firstFailedAt: heartbeat.firstFailedAt?.toISOString() ?? null, heartbeatSequence: heartbeat.heartbeatSequence,
    lastAcknowledgedAt: heartbeat.lastAcknowledgedAt?.toISOString() ?? null, lastErrorCode: heartbeat.lastErrorCode,
    lastObservedAt: session.lastObservedAt.toISOString(), lastRetryAt: heartbeat.lastRetryAt?.toISOString() ?? null,
    nextRetryAt: heartbeat.nextRetryAt?.toISOString() ?? null, oldestQueuedAt: heartbeat.oldestQueuedAt?.toISOString() ?? null,
    queueDepth: heartbeat.queueDepth, retryCount: heartbeat.retryCount, serverReceivedAt: heartbeat.serverReceivedAt.toISOString(),
    sessionGeneration: session.sessionGeneration, state: forcedState ?? projectedState, versionCode: session.versionCode
  };
}
