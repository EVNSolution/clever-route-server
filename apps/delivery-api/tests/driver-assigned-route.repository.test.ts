import { describe, expect, test, vi } from 'vitest';

import { PrismaDriverAssignedRouteRepository } from '../src/modules/driver/driver-assigned-route.repository.js';
import { computeRouteShapeSignature } from '../src/modules/route-plans/route-plan-geometry-cache.js';

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

    expect(prisma.shop.findUnique).toHaveBeenCalledWith({ where: { appId_shopDomain: { appId: 'clever', shopDomain: 'dev1.tomatonofood.com' } } });
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

  test('returns cached route geometry without calling OSRM on assigned-route reads', async () => {
    const routeGeometryProvider = { buildRoute: vi.fn() };
    const { prisma } = createPrismaHarness({ routeGeometryCacheFindUnique: cachedGeometryRecord(routePlanRecord) });
    const repository = new PrismaDriverAssignedRouteRepository(prisma as never);

    const result = await repository.getAssignedRoute({
      driverId: 'driver-id',
      routeContext: 'route-plan-id',
      shopDomain: 'dev1.tomatonofood.com'
    });

    expect(routeGeometryProvider.buildRoute).not.toHaveBeenCalled();
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
    const routePlanFindArgs = prisma.routePlan.findFirst.mock.calls[0]?.[0] as { include?: Record<string, unknown> } | undefined;
    expect(routePlanFindArgs?.include).not.toHaveProperty('routeGeometryCaches');
    const cacheFindArgs = prisma.routePlanGeometryCache.findUnique.mock.calls[0]?.[0] as
      | { where?: { routePlanId_shapeSignature?: { routePlanId?: unknown; shapeSignature?: unknown } } }
      | undefined;
    expect(cacheFindArgs?.where?.routePlanId_shapeSignature?.routePlanId).toBe('route-plan-id');
    expect(typeof cacheFindArgs?.where?.routePlanId_shapeSignature?.shapeSignature).toBe('string');
  });

  test('falls back to latest geometry metadata without returning stale line data on assigned-route reads', async () => {
    const { prisma } = createPrismaHarness({
      routeGeometryCacheFindFirst: {
        generatedAt: new Date('2026-05-12T06:31:00.000Z'),
        provider: 'osrm',
        providerVersion: null,
        shapeSignature: 'previous-shape-signature',
        source: 'CREATE_ROUTE'
      }
    });
    const repository = new PrismaDriverAssignedRouteRepository(prisma as never);

    const result = await repository.getAssignedRoute({
      driverId: 'driver-id',
      routeContext: 'route-plan-id',
      shopDomain: 'dev1.tomatonofood.com'
    });

    expect(result).toMatchObject({
      status: 'ASSIGNED_ROUTE',
      route: {
        routeGeometry: null,
        routeMetrics: null,
        routeStopPoints: []
      }
    });
    expect(prisma.routePlanGeometryCache.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: { generatedAt: 'desc' },
      where: { routePlanId: 'route-plan-id' }
    }));
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

  test('looks up only published routes for assigned-route visibility', async () => {
    const { prisma } = createPrismaHarness({ routePlan: null });
    const repository = new PrismaDriverAssignedRouteRepository(prisma as never);

    const result = await repository.getAssignedRoute({
      driverId: 'driver-id',
      routeContext: 'completed-route-plan-id',
      shopDomain: 'dev1.tomatonofood.com'
    });

    expect(result).toEqual({ status: 'NO_ASSIGNED_ROUTE' });
    const routePlanFindArgs = prisma.routePlan.findFirst.mock.calls[0]?.[0];
    expect(routePlanFindArgs?.where.status).toBe('PUBLISHED');
  });
});


function cachedGeometryRecord(record: typeof routePlanRecord): Record<string, unknown> {
  return {
        generatedAt: new Date('2026-05-12T06:31:00.000Z'),
        geometry: {
          type: 'LineString',
          coordinates: [
            [-79.3832, 43.6532],
            [-79.3817, 43.6487]
          ]
        },
        metrics: { distanceMeters: 980.5, durationSeconds: 420.25 },
        provider: 'osrm',
        providerVersion: null,
        shapeSignature: computeRouteShapeSignature({
          routeGeometry: null,
          routeMetrics: null,
          routePlan: {
            createdAt: record.createdAt.toISOString(),
            deliveryAreas: [],
            deliveryDays: [],
            depot: { latitude: 43.6532, longitude: -79.3832 },
            id: record.id,
            itemSummary: { changedSincePublish: false, fingerprint: '', itemTypes: 0, items: [], totalQuantity: 0 },
            missingCoordinates: 0,
            name: record.name,
            planDate: '2026-05-12',
            routeEndMode: 'END_AT_LAST_STOP',
            status: record.status,
            stopsCount: 1,
            updatedAt: record.updatedAt.toISOString()
          },
          routeStopPoints: [],
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
              attributes: [],
              coordinates: { latitude: 43.6487, longitude: -79.3817 },
              deliveryArea: null,
              deliveryDay: null,
              deliveryStopId: 'stop-id',
              financialStatus: 'Cash',
              fulfillmentStatus: 'PROCESSING',
              items: [],
              normalizedPaymentStatus: 'CASH_COLLECT_REQUIRED',
              orderId: 'order-id',
              orderName: '#1001',
              paymentStatus: 'Cash',
              recipientName: 'Recipient One',
              sequence: 1,
              shopifyOrderGid: 'gid://shopify/Order/1001',
              status: 'ASSIGNED'
            }
          ]
        }),
        source: 'CREATE_ROUTE',
        stopPoints: [
          {
            deliveryStopId: 'stop-id',
            inputCoordinates: [-79.3817, 43.6487],
            name: 'King Street West',
            sequence: 1,
            shopifyOrderGid: 'gid://shopify/Order/1001',
            snapDistanceMeters: 3.5,
            snappedCoordinates: [-79.3818, 43.6488]
          }
        ]
  };
}

function createPrismaHarness(input: {
  driverShopId?: string;
  routeGeometryCacheFindFirst?: Record<string, unknown> | null;
  routeGeometryCacheFindUnique?: Record<string, unknown> | null;
  routePlan?: typeof routePlanRecord | null;
} = {}) {
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
      routePlanGeometryCache: {
        findFirst: vi.fn((args: unknown) => { void args; return Promise.resolve(input.routeGeometryCacheFindFirst ?? null); }),
        findUnique: vi.fn((args: unknown) => { void args; return Promise.resolve(input.routeGeometryCacheFindUnique ?? null); })
      },
      shop: {
        findUnique: vi.fn(() => Promise.resolve({ id: 'shop-id' }))
      }
    }
  };
}
