import { describe, expect, test, vi } from 'vitest';

import { PrismaDriverAssignedRouteRepository } from '../src/modules/driver/driver-assigned-route.repository.js';
import { computeRouteShapeSignature } from '../src/modules/route-plans/route-plan-geometry-cache.js';
import { ROUTE_DRIVER_OPERATIONAL_STATUSES } from '../src/modules/route-plans/route-plan-lifecycle.js';

const routePlanRecord = {
  createdAt: new Date('2026-05-12T06:00:00.000Z'),
  constraints: {
    timezone: 'America/Toronto'
  },
  depotLatitude: '43.6532000',
  depotLongitude: '-79.3832000',
  id: 'route-plan-id',
  driverEvents: [],
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
          currencyCode: 'CAD',
          destinationId: 'canonical-destination-id',
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
            customer_note: 'Leave the box beside the loading entrance.',
            deliverySession: 'PICKUP',
            dsv: {
              normalized: {
                conditionComparisonKey: ' cold ',
                destinationId: 'destination-id',
                sellerOrderKey: 'DSV-ORDER-1001',
                shippedBoxes: 4
              }
            },
            normalizedPaymentStatus: 'CASH_COLLECT_REQUIRED',
            paymentMethodTitle: 'Cash on delivery',
            serviceType: 'PICKUP'
          },
          shopifyOrderGid: 'gid://shopify/Order/1001',
          totalPriceAmount: '84.50'
        },
        phone: '+14165550123',
        postalCode: 'M5X 1A9',
        province: 'ON',
        recipientName: 'Recipient One',
        serviceMinutes: 5,
        status: 'ASSIGNED'
    },
      distanceFromPreviousMeters: 1000,
      durationFromPreviousSeconds: 600,
      etaCalculatedAt: null,
      etaFailureCode: null,
      etaFailureMessage: null,
      estimatedArrivalAt: null,
      sequence: 1
    }
  ],
  shop: {
    shopDomain: 'dev1.tomatonofood.com'
  },
  status: 'ASSIGNED',
  updatedAt: new Date('2026-05-12T06:30:00.000Z')
};

type MutableRoutePlanRecord = Omit<typeof routePlanRecord, 'driverEvents' | 'routeStops'> & {
  driverEvents: Array<{ createdAt: Date }>;
  routeStops: Array<Omit<typeof routePlanRecord.routeStops[number],
    'durationFromPreviousSeconds' | 'estimatedArrivalAt' | 'etaCalculatedAt' | 'etaFailureCode' | 'etaFailureMessage'
  > & {
    durationFromPreviousSeconds: number | null;
    estimatedArrivalAt: Date | null;
    etaCalculatedAt: Date | null;
    etaFailureCode: string | null;
    etaFailureMessage: string | null;
  }>;
};

describe('PrismaDriverAssignedRouteRepository', () => {
  test('returns the token driver assigned route with ordered stops', async () => {
    const { prisma } = createPrismaHarness();
    const repository = new PrismaDriverAssignedRouteRepository(prisma as never);

    const result = await repository.getAssignedRoute({
      driverId: 'driver-id',
      routeContext: 'route-plan-id',
      shopDomain: 'https://Dev1.TomatonoFood.com/routes',
      shopId: 'shop-id'
    });

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
        etaSnapshot: {
          calculatedAt: null,
          failureCode: null,
          failureMessage: null,
          nextStopEta: null,
          pickupCompletedAt: null,
          remainingRouteEta: null,
          status: 'PRE_PICKUP'
        },
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
            currencyCode: 'CAD',
            customerNote: 'Leave the box beside the loading entrance.',
            deliverySession: 'PICKUP',
            deliveryStopId: 'stop-id',
            destinationId: 'canonical-destination-id',
            distanceFromPreviousMeters: 1000,
            durationFromPreviousSeconds: 600,
            estimatedArrivalAt: null,
            conditionCode: 'COLD',
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
            paymentMethodTitle: 'Cash on delivery',
            phone: '+14165550123',
            recipientName: 'Recipient One',
            sequence: 1,
            serviceType: 'PICKUP',
            sellerOrderKey: 'DSV-ORDER-1001',
            shippedBoxes: 4,
            status: 'ASSIGNED',
            totalPriceAmount: '84.50'
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
      shopDomain: 'dev1.tomatonofood.com',
      shopId: 'shop-id'
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

  test('derives READY eta snapshot from persisted pickup event and route stops', async () => {
    const routePlan = structuredClone(routePlanRecord) as MutableRoutePlanRecord;
    const routeStop = routePlan.routeStops[0]!;
    routePlan.driverEvents = [{ createdAt: new Date('2026-05-12T06:40:00.000Z') }];
    routeStop.estimatedArrivalAt = new Date('2026-05-12T06:50:00.000Z');
    routeStop.etaCalculatedAt = new Date('2026-05-12T06:40:00.000Z');
    const { prisma } = createPrismaHarness({ routePlan });
    const repository = new PrismaDriverAssignedRouteRepository(prisma as never);

    const result = await repository.getAssignedRoute({
      driverId: 'driver-id',
      routeContext: 'route-plan-id',
      shopDomain: 'dev1.tomatonofood.com',
      shopId: 'shop-id'
    });

    expect(result).toMatchObject({
      status: 'ASSIGNED_ROUTE',
      route: {
        etaSnapshot: {
          calculatedAt: '2026-05-12T06:40:00.000Z',
          nextStopEta: {
            deliveryStopId: 'stop-id',
            distanceFromPreviousMeters: 1000,
            estimatedArrivalAt: '2026-05-12T06:50:00.000Z',
            sequence: 1
          },
          pickupCompletedAt: '2026-05-12T06:40:00.000Z',
          remainingRouteEta: {
            distanceMeters: 1000,
            estimatedCompletionAt: '2026-05-12T06:55:00.000Z'
          },
          status: 'READY'
        }
      }
    });
  });

  test('derives FAILED eta snapshot after pickup when clock ETA is unavailable', async () => {
    const routePlan = structuredClone(routePlanRecord) as MutableRoutePlanRecord;
    const routeStop = routePlan.routeStops[0]!;
    routePlan.driverEvents = [{ createdAt: new Date('2026-05-12T06:40:00.000Z') }];
    routeStop.durationFromPreviousSeconds = null;
    routeStop.etaCalculatedAt = new Date('2026-05-12T06:40:00.000Z');
    routeStop.etaFailureCode = 'ETA_INPUT_DURATION_UNAVAILABLE';
    routeStop.etaFailureMessage = 'ETA could not be calculated because route leg durations are unavailable.';
    const { prisma } = createPrismaHarness({ routePlan });
    const repository = new PrismaDriverAssignedRouteRepository(prisma as never);

    const result = await repository.getAssignedRoute({
      driverId: 'driver-id',
      routeContext: 'route-plan-id',
      shopDomain: 'dev1.tomatonofood.com',
      shopId: 'shop-id'
    });

    expect(result).toMatchObject({
      status: 'ASSIGNED_ROUTE',
      route: {
        etaSnapshot: {
          calculatedAt: '2026-05-12T06:40:00.000Z',
          failureCode: 'ETA_INPUT_DURATION_UNAVAILABLE',
          nextStopEta: {
            deliveryStopId: 'stop-id',
            estimatedArrivalAt: null
          },
          pickupCompletedAt: '2026-05-12T06:40:00.000Z',
          remainingRouteEta: {
            distanceMeters: 1000,
            estimatedCompletionAt: null
          },
          status: 'FAILED'
        }
      }
    });
  });

  test('falls back to Shopify financial status when canonical payment status is absent', async () => {
    const routePlan = structuredClone(routePlanRecord);
    Reflect.deleteProperty(routePlan.routeStops[0]!.deliveryStop.order.rawPayload, 'normalizedPaymentStatus');
    routePlan.routeStops[0]!.deliveryStop.order.financialStatus = 'PAID';
    const { prisma } = createPrismaHarness({ routePlan });
    const repository = new PrismaDriverAssignedRouteRepository(prisma as never);

    const result = await repository.getAssignedRoute({
      driverId: 'driver-id',
      routeContext: 'route-plan-id',
      shopDomain: 'dev1.tomatonofood.com',
      shopId: 'shop-id'
    });

    expect(result).toMatchObject({
      status: 'ASSIGNED_ROUTE',
      route: {
        stops: [{ normalizedPaymentStatus: 'PAID_CONFIRMED' }]
      }
    });
  });

  test('reads DSV stop fields from legacy top-level raw payload keys', async () => {
    const routePlan = structuredClone(routePlanRecord);
    (routePlan.routeStops[0]!.deliveryStop.order as { destinationId: string | null }).destinationId = null;
    (routePlan.routeStops[0]!.deliveryStop.order as { rawPayload: unknown }).rawPayload = {
      condition_code: ' ambient ',
      destination_id: 'legacy-destination-id',
      seller_order_key: 'LEGACY-ORDER-1',
      shipped_boxes: '7'
    };
    const { prisma } = createPrismaHarness({ routePlan });
    const repository = new PrismaDriverAssignedRouteRepository(prisma as never);

    const result = await repository.getAssignedRoute({
      driverId: 'driver-id',
      routeContext: 'route-plan-id',
      shopDomain: 'dev1.tomatonofood.com',
      shopId: 'shop-id'
    });

    expect(result).toMatchObject({
      status: 'ASSIGNED_ROUTE',
      route: {
        stops: [
          {
            conditionCode: 'AMBIENT',
            destinationId: 'legacy-destination-id',
            sellerOrderKey: 'LEGACY-ORDER-1',
            shippedBoxes: 7
          }
        ]
      }
    });
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
      shopDomain: 'dev1.tomatonofood.com',
      shopId: 'shop-id'
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
    const { prisma } = createPrismaHarness({ routePlan: null });
    const repository = new PrismaDriverAssignedRouteRepository(prisma as never);

    await expect(
      repository.getAssignedRoute({
        driverId: 'driver-id',
        routeContext: 'route-plan-id',
        shopDomain: 'example.myshopify.com',
        shopId: 'other-shop-id'
      })
    ).resolves.toEqual({ status: 'NO_ASSIGNED_ROUTE' });
  });

  test('returns no assigned route for route context mismatch', async () => {
    const { prisma } = createPrismaHarness();
    const repository = new PrismaDriverAssignedRouteRepository(prisma as never);

    const result = await repository.getAssignedRoute({
      driverId: 'driver-id',
      routeContext: 'wrong-route',
      shopDomain: 'example.myshopify.com',
      shopId: 'shop-id'
    });

    expect(result).toEqual({ status: 'NO_ASSIGNED_ROUTE' });
    const routePlanFindArgs = prisma.routePlan.findFirst.mock.calls[0]?.[0];
    expect(routePlanFindArgs?.where).toMatchObject({ id: 'wrong-route' });
  });

  test('keeps ready and in-progress routes visible but excludes completed routes from operations', async () => {
    const { prisma } = createPrismaHarness({ routePlan: null });
    const repository = new PrismaDriverAssignedRouteRepository(prisma as never);

    const result = await repository.getAssignedRoute({
      driverId: 'driver-id',
      routeContext: 'completed-route-plan-id',
      shopDomain: 'dev1.tomatonofood.com',
      shopId: 'shop-id'
    });

    expect(result).toEqual({ status: 'NO_ASSIGNED_ROUTE' });
    const routePlanFindArgs = prisma.routePlan.findFirst.mock.calls[0]?.[0];
    expect(routePlanFindArgs?.where.status).toEqual({ in: [...ROUTE_DRIVER_OPERATIONAL_STATUSES] });
    expect(routePlanFindArgs?.where.driverEvents).toEqual({ none: { eventType: 'ROUTE_COMPLETED' } });
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
  routePlan?: MutableRoutePlanRecord | typeof routePlanRecord | null;
} = {}) {
  return {
    prisma: {
      driver: {
        findUnique: vi.fn(() => Promise.resolve({ id: 'driver-id', shopId: input.driverShopId ?? 'shop-id' }))
      },
      routePlan: {
        findFirst: vi.fn((args: { where: { driverEvents?: unknown; id?: string; status?: { in: string[] } } }) =>
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
