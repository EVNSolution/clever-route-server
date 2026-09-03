import { Prisma, type PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import {
  inspectRollingEtaBackfill,
  ROLLING_ETA_BACKFILL_APP_ID,
  ROLLING_ETA_BACKFILL_CHANGE_CONTROL_REF,
  RollingEtaBackfillService
} from '../src/modules/driver/rolling-eta-backfill.js';
import type {
  RollingEtaBackfillRefusalError,
  RollingEtaBackfillScope
} from '../src/modules/driver/rolling-eta-backfill.js';

const SHOP_ID = '4dd3c87b-1010-4740-922f-51e9f0fb1964';
const ROUTE_ID = '11111111-1111-4111-8111-111111111111';
const VERSION_ID = '22222222-2222-4222-8222-222222222222';
const DRIVER_ID = '33333333-3333-4333-8333-333333333333';

describe('rolling ETA backfill inspection and apply', () => {
  it('binds inspection to one explicit K-food shop and only replays the current route version', async () => {
    let capturedQuery: unknown;
    const prisma = fakePrisma({
      captureFindMany: (query) => { capturedQuery = query; },
      routePlans: [routePlan({
        events: [
          progressEvent('old-version-event', 'PICKUP_COMPLETED', '2026-08-27T12:00:00.000Z', 'old-version'),
          progressEvent('current-version-event', 'ROUTE_STARTED', '2026-08-27T09:00:00.000Z', VERSION_ID)
        ]
      })]
    });

    const result = await inspectRollingEtaBackfill(prisma, scope());

    expect(capturedQuery).toMatchObject({
      where: {
        shop: { is: { appId: ROLLING_ETA_BACKFILL_APP_ID, dsvOperationalSettings: { equals: Prisma.DbNull } } },
        shopId: SHOP_ID
      }
    });
    expect(result.ignoredNonCurrentVersionEvents).toBe(1);
    expect(result.plan.items).toHaveLength(1);
    expect(result.plan.items[0]?.after).toMatchObject({
      estimatedArrivalAt: '2026-08-27T09:10:00.000Z',
      etaInputRouteVersionId: VERSION_ID,
      etaSource: 'ROUTE_STARTED',
      etaStatus: 'READY'
    });
  });

  it('leaves a route with missing leg duration unchanged and reports it separately', async () => {
    const prisma = fakePrisma({
      routePlans: [routePlan({ durationFromPreviousSeconds: null })]
    });

    const result = await inspectRollingEtaBackfill(prisma, scope());

    expect(result.plan.items).toHaveLength(0);
    expect(result.excludedRoutes).toEqual([{
      reason: 'MISSING_LEG_DURATION',
      routePlanId: ROUTE_ID,
      shopId: SHOP_ID
    }]);
  });

  it('refuses a changed review hash before issuing any writes', async () => {
    let updateCalls = 0;
    const prisma = fakePrisma({
      routePlans: [routePlan()],
      updateMany: () => {
        updateCalls += 1;
        return { count: 1 };
      }
    });
    const service = new RollingEtaBackfillService(prisma);

    await expect(service.apply({
      changeControlRef: ROLLING_ETA_BACKFILL_CHANGE_CONTROL_REF,
      expectedChangeCount: 1,
      reviewedPlanSha256: '0'.repeat(64),
      scope: scope()
    })).rejects.toMatchObject({
      code: 'REVIEWED_PLAN_SHA256_MISMATCH'
    } satisfies Partial<RollingEtaBackfillRefusalError>);
    expect(updateCalls).toBe(0);
  });

  it('applies the exact reviewed plan inside a bounded serializable transaction', async () => {
    let transactionOptions: unknown;
    let updateCalls = 0;
    const routePlans = [routePlan()];
    const inspection = await inspectRollingEtaBackfill(fakePrisma({ routePlans }), scope());
    const prisma = fakePrisma({
      captureTransactionOptions: (options) => { transactionOptions = options; },
      routePlans,
      updateMany: () => {
        updateCalls += 1;
        return { count: 1 };
      }
    });

    const result = await new RollingEtaBackfillService(prisma).apply({
      changeControlRef: ROLLING_ETA_BACKFILL_CHANGE_CONTROL_REF,
      expectedChangeCount: inspection.plan.items.length,
      reviewedPlanSha256: inspection.planSha256,
      scope: scope()
    });

    expect(result).toEqual({
      appliedItems: 1,
      mode: 'apply',
      planSha256: inspection.planSha256
    });
    expect(updateCalls).toBe(1);
    expect(transactionOptions).toEqual({
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 10_000,
      timeout: 120_000
    });
  });
});

function scope(): RollingEtaBackfillScope {
  return { appId: ROLLING_ETA_BACKFILL_APP_ID, shopId: SHOP_ID };
}

function fakePrisma(input: {
  captureFindMany?: (query: unknown) => void;
  captureTransactionOptions?: (options: unknown) => void;
  routePlans: unknown[];
  updateMany?: () => { count: number };
}): PrismaClient {
  const transactionClient = {
    routePlan: {
      findMany: (query: unknown) => {
        input.captureFindMany?.(query);
        return Promise.resolve(input.routePlans);
      }
    },
    routePlanStop: {
      updateMany: () => Promise.resolve(input.updateMany?.() ?? { count: 1 })
    }
  };
  return {
    ...transactionClient,
    $transaction: (callback: (tx: unknown) => unknown, options: unknown) => {
      input.captureTransactionOptions?.(options);
      return Promise.resolve(callback(transactionClient));
    }
  } as unknown as PrismaClient;
}

function routePlan(input: {
  durationFromPreviousSeconds?: number | null;
  events?: unknown[];
} = {}) {
  return {
    driverEvents: input.events ?? [progressEvent('route-start', 'ROUTE_STARTED', '2026-08-27T09:00:00.000Z', VERSION_ID)],
    id: ROUTE_ID,
    routeGeometryCaches: [],
    routeGroupingChildVersions: [{ id: VERSION_ID }],
    routeStops: [{
      deliveryStop: { serviceMinutes: 5, status: 'PENDING' },
      deliveryStopId: '44444444-4444-4444-8444-444444444444',
      distanceFromPreviousMeters: 5000,
      durationFromPreviousSeconds: input.durationFromPreviousSeconds === undefined ? 600 : input.durationFromPreviousSeconds,
      estimatedArrivalAt: new Date('2026-08-27T10:00:00.000Z'),
      etaCalculatedAt: new Date('2026-08-27T08:00:00.000Z'),
      etaFailureCode: null,
      etaFailureMessage: null,
      etaInputRouteVersionId: VERSION_ID,
      etaSource: 'PLANNED_DEPARTURE',
      etaStatus: 'READY',
      id: '55555555-5555-4555-8555-555555555555',
      sequence: 1,
      updatedAt: new Date('2026-08-27T08:00:00.000Z')
    }],
    shopId: SHOP_ID
  };
}

function progressEvent(id: string, eventType: string, occurredAt: string, routeVersionId: string) {
  return {
    createdAt: new Date(occurredAt),
    deliveryStopId: null,
    driverId: DRIVER_ID,
    eventType,
    id,
    occurredAt: new Date(occurredAt),
    routeVersionId
  };
}
