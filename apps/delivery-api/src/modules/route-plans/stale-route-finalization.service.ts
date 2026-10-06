import type { PrismaClient } from '@prisma/client';

import { resolveRouteTrackingEventWindow } from '../route-tracking/route-tracking.event-window.js';
import { reconcileKfoodDeliveryWorkCompletion } from './kfood-delivery-completion.js';

export const KFOOD_STALE_ROUTE_APP_ID = 'clever-route-kfood';
export const KFOOD_STALE_ROUTE_SHOP_DOMAIN = '7hrud1-xq.myshopify.com';

export type StaleRouteFinalizationResult = {
  finalized: number;
  inspected: number;
  skippedConcurrent: number;
  skippedNotDue: number;
  skippedUnresolvableWindow: number;
};

export class PrismaStaleRouteFinalizationService {
  private scanCursor: { id: string; planDate: Date } | null = null;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly batchSize = 25
  ) {}

  async processDue(now = new Date()): Promise<StaleRouteFinalizationResult> {
    const candidates = await this.prisma.routePlan.findMany({
      orderBy: [{ planDate: 'asc' }, { id: 'asc' }],
      select: { id: true, planDate: true, shopId: true },
      take: this.batchSize,
      where: {
        ...(this.scanCursor === null ? {} : {
          OR: [
            { planDate: { gt: this.scanCursor.planDate } },
            { id: { gt: this.scanCursor.id }, planDate: this.scanCursor.planDate }
          ]
        }),
        shop: {
          appId: KFOOD_STALE_ROUTE_APP_ID,
          shopDomain: KFOOD_STALE_ROUTE_SHOP_DOMAIN
        },
        status: 'IN_PROGRESS'
      }
    });
    const lastCandidate = candidates.at(-1);
    this.scanCursor = candidates.length === this.batchSize && lastCandidate !== undefined
      ? { id: lastCandidate.id, planDate: lastCandidate.planDate }
      : null;
    const result: StaleRouteFinalizationResult = {
      finalized: 0,
      inspected: candidates.length,
      skippedConcurrent: 0,
      skippedNotDue: 0,
      skippedUnresolvableWindow: 0
    };

    for (const candidate of candidates) {
      const outcome = await this.finalizeCandidate(candidate.id, candidate.shopId, now);
      result[outcome] += 1;
    }
    return result;
  }

  private async finalizeCandidate(
    routePlanId: string,
    shopId: string,
    now: Date
  ): Promise<Exclude<keyof StaleRouteFinalizationResult, 'inspected'>> {
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "route_plans"
        WHERE "id" = ${routePlanId}::uuid
          AND "shopId" = ${shopId}::uuid
        FOR UPDATE
      `;
      if (locked[0] === undefined) return 'skippedConcurrent';

      const completion = await reconcileKfoodDeliveryWorkCompletion(tx, {
        allowStart: false,
        now,
        routePlanId,
        shopId
      });
      if (completion !== null) {
        if (completion.navigationUntil.getTime() > now.getTime()) return 'skippedNotDue';

        const route = await tx.routePlan.findFirst({
          select: {
            assignmentGeneration: true,
            deliveryWorkCompletedAt: true,
            deliveryWorkCompletedGeneration: true,
            deliveryWorkCompletedVersionId: true,
            driverNavigationUntil: true,
            id: true,
            shopId: true,
            updatedAt: true
          },
          where: {
            id: routePlanId,
            shopId,
            shop: {
              appId: KFOOD_STALE_ROUTE_APP_ID,
              shopDomain: KFOOD_STALE_ROUTE_SHOP_DOMAIN
            },
            status: 'IN_PROGRESS'
          }
        });
        if (route === null) return 'skippedConcurrent';

        const updated = await tx.routePlan.updateMany({
          data: { status: 'COMPLETED' },
          where: {
            assignmentGeneration: completion.assignmentGeneration,
            deliveryWorkCompletedAt: completion.completedAt,
            deliveryWorkCompletedGeneration: completion.assignmentGeneration,
            deliveryWorkCompletedVersionId: completion.routeVersionId,
            driverNavigationUntil: completion.navigationUntil,
            id: route.id,
            shopId: route.shopId,
            status: 'IN_PROGRESS',
            updatedAt: route.updatedAt
          }
        });
        return updated.count === 1 ? 'finalized' : 'skippedConcurrent';
      }

      const route = await tx.routePlan.findFirst({
        select: {
          assignmentGeneration: true,
          constraints: true,
          driverEvents: {
            orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
            select: { eventType: true, occurredAt: true },
            where: { eventType: { in: ['ROUTE_STARTED', 'ROUTE_COMPLETED'] } }
          },
          id: true,
          planDate: true,
          shopId: true,
          updatedAt: true
        },
        where: {
          id: routePlanId,
          shopId,
          shop: {
            appId: KFOOD_STALE_ROUTE_APP_ID,
            shopDomain: KFOOD_STALE_ROUTE_SHOP_DOMAIN
          },
          status: 'IN_PROGRESS'
        }
      });
      if (route === null || route.driverEvents.some((event) => event.eventType === 'ROUTE_COMPLETED')) {
        return 'skippedConcurrent';
      }

      const routeStarted = route.driverEvents.find((event) => event.eventType === 'ROUTE_STARTED');
      const eventWindow = resolveRouteTrackingEventWindow({
        constraints: route.constraints,
        planDate: route.planDate,
        startOccurredAt: routeStarted?.occurredAt ?? null
      });
      if (eventWindow === null) return 'skippedUnresolvableWindow';
      if (eventWindow.endExclusive.getTime() > now.getTime()) return 'skippedNotDue';

      const updated = await tx.routePlan.updateMany({
        data: { status: 'INCOMPLETE' },
        where: {
          assignmentGeneration: route.assignmentGeneration,
          id: route.id,
          shopId: route.shopId,
          status: 'IN_PROGRESS',
          updatedAt: route.updatedAt
        }
      });
      return updated.count === 1 ? 'finalized' : 'skippedConcurrent';
    });
  }
}
