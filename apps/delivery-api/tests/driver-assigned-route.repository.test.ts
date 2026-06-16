import { describe, expect, test, vi } from 'vitest';

import { PrismaDriverAssignedRouteRepository } from '../src/modules/driver/driver-assigned-route.repository.js';
import type { RouteGeometryProvider } from '../src/modules/route-plans/route-plan.service.js';

const routePlanRecord = {
  createdAt: new Date('2026-05-12T06:00:00.000Z'),
  constraints: {
    timezone: 'America/Toronto'
  },
  depotLatitude: '43.6532000',
  depotLongitude: '-79.3832000',
  id: 'route-plan-id',
  metrics: {},
  name: 'Tuesday AM Route',
  planDate: new Date('2026-05-12T00:00:00.000Z'),
  routeStops: [
    {
      deliveryStop: {
        address1: '100 King St W',
        address2: null,
        city: 'Toronto',
        countryCode: 'CA',
        id: 'stop-id',
        latitude: '43.6487000',
        longitude: '-79.3817000',
        order: {
          financialStatus: 'Cash',
          fulfillmentStatus: 'PROCESSING',
          id: 'order-id',
          name: '#1001',
          orderItems: [
            {
              name: 'Tomato Box',
              options: [{ key: 'Size', value: 'Large' }],
              productId: 1000,
              quantity: 2,
              sku: 'TB-1',
              variationId: 0
            }
          ],
          rawPayload: {
            normalizedPaymentStatus: 'CASH_COLLECT_REQUIRED'
          },
          shopifyOrderGid: 'gid://shopify/Order/1001'
        },
        phone: '+14165550123',
        postalCode: 'M5X 1A9',
        province: 'ON',
        recipientName: 'Recipient One',
        status: 'ASSIGNED'
      },
      sequence: 1
    }
  ],
  shop: {
    shopDomain: 'dev1.tomatonofood.com'
  },
  status: 'ASSIGNED',
  updatedAt: new Date('2026-05-12T06:30:00.000Z')
};

describe('PrismaDriverAssignedRouteRepository', () => {
  test('returns the token driver assigned route with ordered stops', async () => {
    const { prisma } = createPrismaHarness();
    const repository = new PrismaDriverAssignedRouteRepository(prisma as never);

    const result = await repository.getAssignedRoute({
      driverId: 'driver-id',
      routeContext: 'route-plan-id',
      shopDomain: 'https://Dev1.TomatonoFood.com/routes'
    });

    expect(prisma.shop.findUnique).toHaveBeenCalledWith({ where: { shopDomain: 'dev1.tomatonofood.com' } });
    expect(prisma.driver.findUnique).toHaveBeenCalledWith({ where: { id: 'driver-id' } });
    const routePlanFindArgs = prisma.routePlan.findFirst.mock.calls[0]?.[0];
    expect(routePlanFindArgs?.where).toMatchObject({
      driverId: 'driver-id',
      id: 'route-plan-id',
      shopId: 'shop-id'
    });
    expect(result).toEqual({
      status: 'ASSIGNED_ROUTE',
      route: {
        deliveryDate: '2026-05-12',
        id: 'route-plan-id',
        name: 'Tuesday AM Route',
        routeGeometry: null,
        routeMapPreview: null,
        routeMetrics: null,
        routeStopPoints: [],
        shopDomain: 'dev1.tomatonofood.com',
        stops: [
          {
            address: {
              address1: '100 King St W',
              address2: null,
              city: 'Toronto',
              countryCode: 'CA',
              postalCode: 'M5X 1A9',
              province: 'ON'
            },
            coordinates: { latitude: 43.6487, longitude: -79.3817 },
            deliveryStopId: 'stop-id',
            items: [
              {
                name: 'Tomato Box',
                options: [{ key: 'Size', value: 'Large' }],
                productId: 1000,
                quantity: 2,
                sku: 'TB-1',
                variationId: 0
              }
            ],
            normalizedPaymentStatus: 'CASH_COLLECT_REQUIRED',
            orderName: '#1001',
            phone: '+14165550123',
            recipientName: 'Recipient One',
            sequence: 1,
            status: 'ASSIGNED'
          }
        ],
        timezone: 'America/Toronto'
      }
    });
  });

  test('enriches the assigned route with OSRM geometry, metrics, and safe stop points when configured', async () => {
    const { prisma } = createPrismaHarness();
    const routeGeometryProvider = {
      buildRoute: vi.fn<RouteGeometryProvider['buildRoute']>(() => Promise.resolve({
        routeGeometry: {
          type: 'LineString' as const,
          coordinates: [
            [-79.3832, 43.6532],
            [-79.3817, 43.6487]
          ] as [number, number][]
        },
        routeMetrics: { distanceMeters: 980.5, durationSeconds: 420.25 },
        routeStopPoints: [
          {
            deliveryStopId: 'stop-id',
            inputCoordinates: [-79.3817, 43.6487] as [number, number],
            name: 'King Street West',
            sequence: 1,
            shopifyOrderGid: 'gid://shopify/Order/1001',
            snapDistanceMeters: 3.5,
            snappedCoordinates: [-79.3818, 43.6488] as [number, number]
          }
        ]
      }))
    };
    const repository = new PrismaDriverAssignedRouteRepository(prisma as never, routeGeometryProvider);

    const result = await repository.getAssignedRoute({
      driverId: 'driver-id',
      routeContext: 'route-plan-id',
      shopDomain: 'dev1.tomatonofood.com'
    });

    const providerInput = routeGeometryProvider.buildRoute.mock.calls[0]?.[0];
    expect(providerInput?.routePlan.depot).toEqual({ latitude: 43.6532, longitude: -79.3832 });
    expect(providerInput?.routePlan.routeEndMode).toBe('END_AT_LAST_STOP');
    expect(providerInput?.stops[0]).toEqual(
      expect.objectContaining({
        deliveryStopId: 'stop-id',
        orderId: 'order-id',
        shopifyOrderGid: 'gid://shopify/Order/1001'
      })
    );
    expect(result).toMatchObject({
      status: 'ASSIGNED_ROUTE',
      route: {
        routeGeometry: {
          type: 'LineString',
          coordinates: [
            [-79.3832, 43.6532],
            [-79.3817, 43.6487]
          ]
        },
        routeMapPreview: null,
        routeMetrics: { distanceMeters: 980.5, durationSeconds: 420.25 },
        routeStopPoints: [
          {
            deliveryStopId: 'stop-id',
            inputCoordinates: [-79.3817, 43.6487],
            name: 'King Street West',
            sequence: 1,
            snapDistanceMeters: 3.5,
            snappedCoordinates: [-79.3818, 43.6488]
          }
        ]
      }
    });
    expect(JSON.stringify(result)).not.toContain('shopifyOrderGid');
  });

  test('does not leak a route for a token driver outside the token shop', async () => {
    const { prisma } = createPrismaHarness({ driverShopId: 'other-shop-id' });
    const repository = new PrismaDriverAssignedRouteRepository(prisma as never);

    await expect(
      repository.getAssignedRoute({
        driverId: 'driver-id',
        routeContext: 'route-plan-id',
        shopDomain: 'example.myshopify.com'
      })
    ).rejects.toThrow('Driver not found for shop');
    expect(prisma.routePlan.findFirst).not.toHaveBeenCalled();
  });

  test('returns no assigned route for route context mismatch', async () => {
    const { prisma } = createPrismaHarness();
    const repository = new PrismaDriverAssignedRouteRepository(prisma as never);

    const result = await repository.getAssignedRoute({
      driverId: 'driver-id',
      routeContext: 'wrong-route',
      shopDomain: 'example.myshopify.com'
    });

    expect(result).toEqual({ status: 'NO_ASSIGNED_ROUTE' });
    const routePlanFindArgs = prisma.routePlan.findFirst.mock.calls[0]?.[0];
    expect(routePlanFindArgs?.where).toMatchObject({ id: 'wrong-route' });
  });

  test('excludes completed routes from assigned-route lookup', async () => {
    const { prisma } = createPrismaHarness({ routePlan: null });
    const repository = new PrismaDriverAssignedRouteRepository(prisma as never);

    const result = await repository.getAssignedRoute({
      driverId: 'driver-id',
      routeContext: 'completed-route-plan-id',
      shopDomain: 'dev1.tomatonofood.com'
    });

    expect(result).toEqual({ status: 'NO_ASSIGNED_ROUTE' });
    const routePlanFindArgs = prisma.routePlan.findFirst.mock.calls[0]?.[0];
    expect(routePlanFindArgs?.where.status).toEqual({
      in: ['ASSIGNED', 'IN_PROGRESS', 'OPTIMIZED']
    });
    expect(routePlanFindArgs?.where.status?.in).not.toContain('COMPLETED');
  });
});

function createPrismaHarness(input: { driverShopId?: string; routePlan?: typeof routePlanRecord | null } = {}) {
  return {
    prisma: {
      driver: {
        findUnique: vi.fn(() => Promise.resolve({ id: 'driver-id', shopId: input.driverShopId ?? 'shop-id' }))
      },
      routePlan: {
        findFirst: vi.fn((args: { where: { id?: string; status?: { in: string[] } } }) =>
          Promise.resolve(args.where.id === 'wrong-route' ? null : input.routePlan === undefined ? routePlanRecord : input.routePlan)
        )
      },
      shop: {
        findUnique: vi.fn(() => Promise.resolve({ id: 'shop-id' }))
      }
    }
  };
}
