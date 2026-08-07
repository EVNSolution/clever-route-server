import { describe, expect, test, vi } from 'vitest';

import { PrismaDriverRouteAccessRepository } from '../src/modules/driver/driver-route-access.repository.js';
import { ROUTE_DRIVER_OPERATIONAL_STATUSES } from '../src/modules/route-plans/route-plan-lifecycle.js';

const routePlanId = '11111111-1111-4111-8111-111111111111';

describe('PrismaDriverRouteAccessRepository', () => {
  test('matches an active assigned driver and maps non-sensitive company guidance', async () => {
    const { prisma } = createPrismaHarness({
      routePlan: routePlanRecord({ shopDomain: 'https://Dev1.TomatonoFood.com/admin' })
    });
    const repository = new PrismaDriverRouteAccessRepository(prisma as never);

    const result = await repository.lookupRouteAccess({
      accountId: 'account-id',
      routeContext: routePlanId
    });

    expect(prisma.routePlan.findUnique).toHaveBeenCalledWith({
      select: {
        constraints: true,
        driver: {
          select: {
            account: { select: { id: true, status: true, tokenVersion: true } },
            accountId: true,
            authSubject: true,
            id: true,
            status: true
          }
        },
        id: true,
        name: true,
        planDate: true,
        shop: { select: { shopDomain: true } },
        status: true,
        vehicleId: true
      },
      where: {
        driverEvents: { none: { eventType: 'ROUTE_COMPLETED' } },
        id: routePlanId,
        status: { in: [...ROUTE_DRIVER_OPERATIONAL_STATUSES] }
      }
    });
    expect(result).toEqual({
      driverContext: {
        accountId: 'account-id',
        routePlanId,
        tokenVersion: 4
      },
      status: 'INVITED',
      routeAccess: {
        nextState: 'consent_required',
        routeContext: routePlanId,
        routePlanId
      },
      companyGuidance: {
        companyDisplayName: 'Tomatono Toronto',
        deliveryDate: '2026-05-12',
        driverInstructions: ['Bring insulated bag'],
        executionStatus: 'READY',
        operatorSupportContact: '+14165550000',
        pickupGuidance: 'Meet at dispatch desk by 9:00 AM',
        routeName: 'Tuesday AM Route',
        shopDomain: 'dev1.tomatonofood.com',
        timezone: 'America/Toronto'
      }
    });
    expect(JSON.stringify(result)).not.toContain('routeStops');
    expect(JSON.stringify(result)).not.toContain('address1');
  });

  test('finds active route choices by phone without requiring route context', async () => {
    const { prisma } = createPrismaHarness({
      phoneRoutePlans: [
        routePlanRecord({
          id: '22222222-2222-4222-8222-222222222222',
          name: 'Tuesday AM Route'
        }),
        routePlanRecord({
          id: '33333333-3333-4333-8333-333333333333',
          name: 'North PM Route',
          shopDomain: 'north-market.myshopify.com'
        })
      ]
    });
    const repository = new PrismaDriverRouteAccessRepository(prisma as never);

    const result = await repository.lookupRouteAccess({
      accountId: 'account-id',
      routeContext: null
    });

    expect(prisma.routePlan.findMany).toHaveBeenCalledWith({
      orderBy: [{ planDate: 'asc' }, { name: 'asc' }],
      select: {
        constraints: true,
        driver: {
          select: {
            account: { select: { id: true, status: true, tokenVersion: true } },
            accountId: true,
            authSubject: true,
            id: true,
            status: true
          }
        },
        id: true,
        name: true,
        planDate: true,
        shop: { select: { shopDomain: true } },
        status: true,
        vehicleId: true
      },
      where: {
        driver: { is: { authSubject: { not: null }, accountId: 'account-id', status: 'ACTIVE' } },
        driverEvents: { none: { eventType: 'ROUTE_COMPLETED' } },
        status: { in: [...ROUTE_DRIVER_OPERATIONAL_STATUSES] }
      }
    });
    expect(result.status).toBe('ROUTES_FOUND');
    if (result.status !== 'ROUTES_FOUND') {
      throw new Error(`Expected ROUTES_FOUND, got ${result.status}`);
    }
    expect(result.routes).toMatchObject([
      {
        status: 'INVITED',
        routeAccess: {
          nextState: 'consent_required',
          routeContext: '22222222-2222-4222-8222-222222222222',
          routePlanId: '22222222-2222-4222-8222-222222222222'
        },
        companyGuidance: {
          companyDisplayName: 'Tomatono Toronto',
          executionStatus: 'READY',
          routeName: 'Tuesday AM Route',
          shopDomain: 'tomatono.myshopify.com'
        }
      },
      {
        status: 'INVITED',
        routeAccess: {
          nextState: 'consent_required',
          routeContext: '33333333-3333-4333-8333-333333333333',
          routePlanId: '33333333-3333-4333-8333-333333333333'
        },
        companyGuidance: {
          companyDisplayName: 'North Market',
          executionStatus: 'READY',
          routeName: 'North PM Route',
          shopDomain: 'north-market.myshopify.com'
        }
      }
    ]);
    expect(JSON.stringify(result)).not.toContain('address1');
  });

  test('does not issue route access for active drivers that have not verified an invite code', async () => {
    const { prisma } = createPrismaHarness({
      phoneRoutePlans: [
        routePlanRecord({
          authSubject: null,
          id: '22222222-2222-4222-8222-222222222222'
        })
      ],
      phoneDrivers: [{ authSubject: null, status: 'ACTIVE' }]
    });
    const repository = new PrismaDriverRouteAccessRepository(prisma as never);

    const result = await repository.lookupRouteAccess({
      accountId: 'account-id',
      routeContext: null
    });

    expect(result).toEqual({ status: 'NOT_FOUND' });
  });

  test('allows a registered active driver phone even when no active routes are assigned', async () => {
    const { prisma } = createPrismaHarness({
      phoneDrivers: [{ status: 'ACTIVE' }],
      phoneRoutePlans: []
    });
    const repository = new PrismaDriverRouteAccessRepository(prisma as never);

    const result = await repository.lookupRouteAccess({
      accountId: 'account-id',
      routeContext: null
    });

    expect(prisma.driver.findMany).toHaveBeenCalledWith({
      select: { authSubject: true, status: true },
      where: { accountId: 'account-id' }
    });
    expect(result).toEqual({
      status: 'ROUTES_FOUND',
      routes: []
    });
  });

  test('materializes a vehicle-backed standby route for the latest public delivery grouping', async () => {
    const standbyRoutePlanId = '44444444-4444-4444-8444-444444444444';
    const { prisma } = createPrismaHarness({
      phoneDrivers: [{ status: 'ACTIVE' }],
      phoneRoutePlanResponses: [[], [routePlanRecord({ id: standbyRoutePlanId })]],
      publicRouteContext: { groupingId: 'grouping-id' },
      vehicleAssignments: [{
        driver: {
          id: 'driver-id',
          shop: { id: 'shop-id', shopDomain: 'tomatono.myshopify.com' }
        },
        vehicle: { id: 'vehicle-id' }
      }]
    });
    const grouping = {
      children: [{
        color: null,
        displayStatus: 'READY',
        driverId: null,
        orderIds: ['order-id'],
        routeIdx: 1,
        routePlan: { updatedAt: '2026-08-07T00:00:00.000Z' },
        routePlanId: 'public-route-id',
        sortOrder: 1,
        updatedAt: '2026-08-07T00:00:00.000Z'
      }, {
        color: null,
        displayStatus: 'READY',
        driverId: null,
        orderIds: [],
        routeIdx: 2,
        routePlan: null,
        routePlanId: null,
        sortOrder: 2,
        updatedAt: '2026-08-07T00:00:00.000Z'
      }],
      id: 'grouping-id',
      updatedAt: '2026-08-07T00:00:00.000Z'
    };
    const routeGroupingService = {
      getGrouping: vi.fn(() => Promise.resolve(grouping)),
      saveDraft: vi.fn(() => Promise.resolve(grouping))
    };
    const repository = new PrismaDriverRouteAccessRepository(
      prisma as never,
      routeGroupingService as never
    );

    const result = await repository.lookupRouteAccess({
      accountId: 'account-id',
      routeContext: null
    });

    expect(result).toMatchObject({
      status: 'ROUTES_FOUND',
      routes: [{ routeAccess: { routePlanId: standbyRoutePlanId } }]
    });
    expect(routeGroupingService.saveDraft).toHaveBeenCalledWith({
      expectedUpdatedAt: grouping.updatedAt,
      groupingId: grouping.id,
      routes: [
        expect.objectContaining({ orderIds: ['order-id'], routePlanId: 'public-route-id' }),
        {
          branchId: null,
          driverId: 'driver-id',
          label: null,
          orderIds: [],
          routePlanId: null,
          sortOrder: 3,
          tempId: 'standby:driver-id',
          vehicleId: 'vehicle-id'
        }
      ],
      shopDomain: 'tomatono.myshopify.com'
    });
  });

  test('requires a vehicle when an active route-less driver opens public delivery', async () => {
    const { prisma } = createPrismaHarness({
      phoneDrivers: [{ status: 'ACTIVE' }],
      phoneRoutePlans: []
    });
    const repository = new PrismaDriverRouteAccessRepository(
      prisma as never,
      { getGrouping: vi.fn(), saveDraft: vi.fn() } as never
    );

    await expect(repository.lookupRouteAccess({
      accountId: 'account-id',
      routeContext: null
    })).resolves.toEqual({ status: 'VEHICLE_REQUIRED' });
  });

  test('requires a registered vehicle before issuing route access', async () => {
    const { prisma } = createPrismaHarness({
      phoneRoutePlans: [routePlanRecord({ vehicleId: null })]
    });
    const repository = new PrismaDriverRouteAccessRepository(prisma as never);

    await expect(repository.lookupRouteAccess({
      accountId: 'account-id',
      routeContext: null
    })).resolves.toEqual({ status: 'VEHICLE_REQUIRED' });
  });

  test('does not reveal route guidance when the phone does not match the assigned driver', async () => {
    const { prisma } = createPrismaHarness();
    const repository = new PrismaDriverRouteAccessRepository(prisma as never);

    await expect(
      repository.lookupRouteAccess({ accountId: 'other-account-id', routeContext: routePlanId })
    ).resolves.toEqual({ status: 'NOT_FOUND' });
  });

  test('maps inactive and suspended assigned drivers to safe denial statuses', async () => {
    const inactive = new PrismaDriverRouteAccessRepository(
      createPrismaHarness({ driverStatus: 'INACTIVE' }).prisma as never
    );
    const suspended = new PrismaDriverRouteAccessRepository(
      createPrismaHarness({ driverStatus: 'SUSPENDED' }).prisma as never
    );

    await expect(
      inactive.lookupRouteAccess({ accountId: 'account-id', routeContext: routePlanId })
    ).resolves.toEqual({ status: 'DISABLED' });
    await expect(
      suspended.lookupRouteAccess({ accountId: 'account-id', routeContext: routePlanId })
    ).resolves.toEqual({ status: 'BLOCKED' });
  });

  test('narrows exact route lookup to operational routes without a completion event', async () => {
    const { prisma } = createPrismaHarness({ routePlan: null });
    const repository = new PrismaDriverRouteAccessRepository(prisma as never);

    await expect(
      repository.lookupRouteAccess({ accountId: 'account-id', routeContext: routePlanId })
    ).resolves.toEqual({ status: 'NOT_FOUND' });

    expect(prisma.routePlan.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        driverEvents: { none: { eventType: 'ROUTE_COMPLETED' } },
        id: routePlanId,
        status: { in: [...ROUTE_DRIVER_OPERATIONAL_STATUSES] }
      }
    }));
  });

  test('returns multiple matches for shared route scope without route or token evidence', async () => {
    const { prisma } = createPrismaHarness({
      sharedRoutePlans: [
        routePlanRecord({
          id: '22222222-2222-4222-8222-222222222222',
          name: 'Tuesday AM Route'
        }),
        routePlanRecord({
          id: '33333333-3333-4333-8333-333333333333',
          name: 'North PM Route',
          shopDomain: 'north-market.myshopify.com'
        })
      ]
    });
    const repository = new PrismaDriverRouteAccessRepository(prisma as never);

    const result = await repository.lookupRouteAccess({
      accountId: 'account-id',
      routeContext: 'toronto-shared-route-scope'
    });

    expect(prisma.routePlan.findMany).toHaveBeenCalledWith({
      orderBy: [{ planDate: 'asc' }, { name: 'asc' }],
      select: {
        constraints: true,
        driver: {
          select: {
            account: { select: { id: true, status: true, tokenVersion: true } },
            accountId: true,
            authSubject: true,
            id: true,
            status: true
          }
        },
        id: true,
        name: true,
        planDate: true,
        shop: { select: { shopDomain: true } },
        status: true,
        vehicleId: true
      },
      take: 3,
      where: {
        constraints: { path: ['routeScope', 'routeScopeKey'], equals: 'toronto-shared-route-scope' },
        driver: { is: { authSubject: { not: null }, accountId: 'account-id', status: 'ACTIVE' } },
        driverEvents: { none: { eventType: 'ROUTE_COMPLETED' } },
        status: { in: [...ROUTE_DRIVER_OPERATIONAL_STATUSES] }
      }
    });
    expect(result).toEqual({
      status: 'MULTIPLE_MATCHES',
      matches: [
        {
          companyDisplayName: 'Tomatono Toronto',
          deliveryDate: '2026-05-12',
          operatorSupportContact: '+14165550000',
          pickupGuidance: 'Meet at dispatch desk by 9:00 AM',
          routeName: 'Tuesday AM Route',
          shopDomain: 'tomatono.myshopify.com',
          timezone: 'America/Toronto'
        },
        {
          companyDisplayName: 'North Market',
          deliveryDate: '2026-05-12',
          operatorSupportContact: '+14165550000',
          pickupGuidance: 'Meet at dispatch desk by 9:00 AM',
          routeName: 'North PM Route',
          shopDomain: 'north-market.myshopify.com',
          timezone: 'America/Toronto'
        }
      ],
      resolutionHint: 'Use the account route list or contact dispatch.'
    });
    expect(JSON.stringify(result)).not.toContain('driverContext');
    expect(JSON.stringify(result)).not.toContain('routePlanId');
    expect(JSON.stringify(result)).not.toContain('routeAccess');
    expect(JSON.stringify(result)).not.toContain('address1');
  });

  test('maps one shared route scope match to invited route access', async () => {
    const { prisma } = createPrismaHarness({
      sharedRoutePlans: [routePlanRecord({ id: '22222222-2222-4222-8222-222222222222' })]
    });
    const repository = new PrismaDriverRouteAccessRepository(prisma as never);

    const result = await repository.lookupRouteAccess({
      accountId: 'account-id',
      routeContext: 'toronto-shared-route-scope'
    });

    expect(result).toEqual(expect.objectContaining({
      status: 'INVITED',
      routeAccess: {
        nextState: 'consent_required',
        routeContext: '22222222-2222-4222-8222-222222222222',
        routePlanId: '22222222-2222-4222-8222-222222222222'
      }
    }));
  });

  test('returns not found for non-UUID route contexts with no active shared match', async () => {
    const { prisma } = createPrismaHarness();
    const repository = new PrismaDriverRouteAccessRepository(prisma as never);

    await expect(
      repository.lookupRouteAccess({ accountId: 'account-id', routeContext: 'tomato-route' })
    ).resolves.toEqual({ status: 'NOT_FOUND' });
    expect(prisma.routePlan.findUnique).not.toHaveBeenCalled();
    expect(prisma.routePlan.findMany).toHaveBeenCalledOnce();
  });
});

function createPrismaHarness(
  overrides: {
    driverStatus?: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';
    phoneDrivers?: Array<{ authSubject?: string | null; status: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED' }>;
    routePlan?: ReturnType<typeof routePlanRecord> | null;
    sharedRoutePlans?: ReturnType<typeof routePlanRecord>[];
    phoneRoutePlans?: ReturnType<typeof routePlanRecord>[];
    phoneRoutePlanResponses?: Array<ReturnType<typeof routePlanRecord>[]>;
    publicRouteContext?: { groupingId: string } | null;
    vehicleAssignments?: Array<{
      driver: { id: string; shop: { id: string; shopDomain: string } };
      vehicle: { id: string };
    }>;
  } = {}
): {
  prisma: {
    dsvVehicleDriverAssignment: {
      findMany: ReturnType<typeof vi.fn>;
    };
    driver: {
      findMany: ReturnType<typeof vi.fn>;
    };
    routeGroupingChildVersion: {
      findFirst: ReturnType<typeof vi.fn>;
    };
    routePlan: {
      findMany: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
    };
  };
} {
  const routePlan = overrides.routePlan === undefined
    ? routePlanRecord(overrides.driverStatus === undefined ? {} : { driverStatus: overrides.driverStatus })
    : overrides.routePlan;
  const phoneRoutePlanResponses = [...(overrides.phoneRoutePlanResponses ?? [])];
  return {
    prisma: {
      dsvVehicleDriverAssignment: {
        findMany: vi.fn(() => Promise.resolve(overrides.vehicleAssignments ?? []))
      },
      driver: {
        findMany: vi.fn(() => Promise.resolve(overrides.phoneDrivers ?? []))
      },
      routeGroupingChildVersion: {
        findFirst: vi.fn(() => Promise.resolve(overrides.publicRouteContext ?? null))
      },
      routePlan: {
        findMany: vi.fn((query?: unknown) => {
          const text = JSON.stringify(query);
          if (text.includes('routeScopeKey')) {
            return Promise.resolve(overrides.sharedRoutePlans ?? []);
          }

          const response = phoneRoutePlanResponses.shift();
          if (response !== undefined) return Promise.resolve(response);
          return Promise.resolve(overrides.phoneRoutePlans ?? overrides.sharedRoutePlans ?? []);
        }),
        findUnique: vi.fn(() => Promise.resolve(routePlan))
      }
    }
  };
}

function routePlanRecord(
  overrides: {
    authSubject?: string | null;
    driverStatus?: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';
    id?: string;
    name?: string;
    shopDomain?: string;
    status?: string;
    vehicleId?: string | null;
  } = {}
) {
  const shopDomain = overrides.shopDomain ?? 'tomatono.myshopify.com';
  return {
    constraints: {
      companyDisplayName: shopDomain === 'north-market.myshopify.com' ? 'North Market' : 'Tomatono Toronto',
      driverInstructions: ['Bring insulated bag'],
      operatorSupportContact: '+14165550000',
      pickupGuidance: 'Meet at dispatch desk by 9:00 AM',
      routeScope: {
        routeScopeKey: 'toronto-shared-route-scope'
      },
      timezone: 'America/Toronto'
    },
    driver: {
      account: {
        id: 'account-id',
        status: 'ACTIVE',
        tokenVersion: 4
      },
      authSubject: overrides.authSubject === undefined ? 'driver-auth-subject' : overrides.authSubject,
      id: 'driver-id',
      accountId: 'account-id',
      status: overrides.driverStatus ?? 'ACTIVE',
    },
    id: overrides.id ?? routePlanId,
    name: overrides.name ?? 'Tuesday AM Route',
    planDate: new Date('2026-05-12T00:00:00.000Z'),
    shop: {
      shopDomain
    },
    status: overrides.status ?? 'READY',
    vehicleId: overrides.vehicleId === undefined ? 'vehicle-id' : overrides.vehicleId
  };
}
