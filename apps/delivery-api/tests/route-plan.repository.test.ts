import { describe, expect, test, vi } from 'vitest';

import { PrismaRoutePlanRepository } from '../src/modules/route-plans/route-plan.repository.js';
import {
  RoutePlanBatchInvalidError,
  RoutePlanConflictError,
  RoutePlanDriverAssignInvalidError,
  RoutePlanDeleteBlockedError,
  RoutePlanOrderAlreadyPlannedError,
  RoutePlanPublishInvalidError,
  RoutePlanStopUpdateInvalidError
} from '../src/modules/route-plans/route-plan.types.js';
import type { OrderItemDto } from '../src/modules/order-items/order-items.js';
import type { RoutePlanOrderInput } from '../src/modules/route-plans/route-plan.types.js';

describe('PrismaRoutePlanRepository', () => {
  test('upserts selected Shopify orders and stores route stops in request sequence', async () => {
    const { prisma, routePlanStopCreateMany } = createPrismaHarness();
    const repository = new PrismaRoutePlanRepository(
      prisma as unknown as ConstructorParameters<typeof PrismaRoutePlanRepository>[0]
    );

    const result = await repository.createRoutePlanDraft({
      createdBy: 'shopify-user-id',
      depot: {
        address: 'Shopify departure location',
        latitude: 43.6532,
        longitude: -79.3832
      },
      name: 'CLEVER route draft',
      orders: [
        routePlanOrder({ gid: 'gid://shopify/Order/123', name: '#1035' }),
        routePlanOrder({ gid: 'gid://shopify/Order/124', name: '#1036' })
      ],
      planDate: '2026-05-08',
      shopDomain: 'Example.myshopify.com'
    });

    expect(result).toEqual(expect.objectContaining({ id: 'route-plan-id', stopsCount: 2 }));
    expect(prisma.shop.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { shopDomain: 'example.myshopify.com' }
      })
    );
    expect(prisma.order.upsert).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: {
          shopId_shopifyOrderGid: {
            shopId: 'shop-id',
            shopifyOrderGid: 'gid://shopify/Order/123'
          }
        }
      })
    );
    expect(prisma.deliveryStop.upsert).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: {
          shopId_orderId: {
            orderId: 'order-1',
            shopId: 'shop-id'
          }
        }
      })
    );
    expect(routePlanStopCreateMany).toHaveBeenCalledWith({
      data: [
        { deliveryStopId: 'stop-1', routePlanId: 'route-plan-id', sequence: 1 },
        { deliveryStopId: 'stop-2', routePlanId: 'route-plan-id', sequence: 2 }
      ]
    });
  });

  test('looks up route plan detail by current shop id to preserve shop isolation', async () => {
    const { prisma } = createPrismaHarness();
    const repository = new PrismaRoutePlanRepository(
      prisma as unknown as ConstructorParameters<typeof PrismaRoutePlanRepository>[0]
    );

    await repository.findRoutePlanDetail({
      routePlanId: 'route-plan-id',
      shopDomain: 'example.myshopify.com'
    });

    expect(prisma.routePlan.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'route-plan-id',
          shopId: 'shop-id'
        }
      })
    );
    const routePlanFindArgs = prisma.routePlan.findFirst.mock.calls[0]?.[0] as { include?: Record<string, unknown> } | undefined;
    expect(routePlanFindArgs?.include).not.toHaveProperty('routeGeometryCaches');
    const cacheFindArgs = prisma.routePlanGeometryCache.findUnique.mock.calls[0]?.[0] as
      | { where?: { routePlanId_shapeSignature?: { routePlanId?: unknown; shapeSignature?: unknown } } }
      | undefined;
    expect(cacheFindArgs?.where?.routePlanId_shapeSignature?.routePlanId).toBe('route-plan-id');
    expect(typeof cacheFindArgs?.where?.routePlanId_shapeSignature?.shapeSignature).toBe('string');
  });

  test('marks route geometry stale from metadata without overfetching cached geometry rows', async () => {
    const { prisma } = createPrismaHarness({
      routeGeometryCacheFindFirst: {
        generatedAt: new Date('2026-05-07T13:00:00.000Z'),
        provider: 'osrm',
        providerVersion: null,
        shapeSignature: 'previous-shape-signature',
        source: 'CREATE_ROUTE'
      }
    });
    const repository = new PrismaRoutePlanRepository(
      prisma as unknown as ConstructorParameters<typeof PrismaRoutePlanRepository>[0]
    );

    const result = await repository.findRoutePlanDetail({
      routePlanId: 'route-plan-id',
      shopDomain: 'example.myshopify.com'
    });

    expect(result?.routeGeometryStatus).toBe('stale');
    expect(result?.routeGeometryGeneratedAt).toBe('2026-05-07T13:00:00.000Z');
    expect(result?.routeGeometry).toBeNull();
    expect(prisma.routePlanGeometryCache.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: { generatedAt: 'desc' },
      where: { routePlanId: 'route-plan-id' }
    }));
  });

  test('does not repair a draft depot while reading route detail', async () => {
    const staleRoute = {
      ...routePlanRecord({ updatedAt: new Date('2026-05-07T12:30:00.000Z') }),
      depotLatitude: null,
      depotLongitude: null
    };
    const { prisma } = createPrismaHarness({
      shop: {
        defaultDepotAddress: 'Store depot',
        defaultDepotLatitude: '43.6532',
        defaultDepotLongitude: '-79.3832',
        id: 'shop-id'
      }
    });
    prisma.routePlan.findFirst.mockResolvedValueOnce(staleRoute);
    const repository = new PrismaRoutePlanRepository(
      prisma as unknown as ConstructorParameters<typeof PrismaRoutePlanRepository>[0]
    );

    const result = await repository.findRoutePlanDetail({
      routePlanId: 'route-plan-id',
      shopDomain: 'example.myshopify.com'
    });

    expect(prisma.routePlan.update).not.toHaveBeenCalled();
    expect(prisma.routePlan.findFirst).toHaveBeenCalledTimes(1);
    expect(result?.routePlan.updatedAt).toBe('2026-05-07T12:30:00.000Z');
    expect(result?.routePlan.depot).toEqual({ latitude: null, longitude: null });
  });

  test('filters listed route plans by the selected delivery date at the database boundary', async () => {
    const { prisma } = createPrismaHarness();
    const repository = new PrismaRoutePlanRepository(
      prisma as unknown as ConstructorParameters<typeof PrismaRoutePlanRepository>[0]
    );

    await repository.listRoutePlans({
      deliveryDate: '2026-05-08',
      shopDomain: 'example.myshopify.com'
    });

    expect(prisma.routePlan.findMany).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: { createdAt: 'desc' },
      where: {
        planDate: new Date('2026-05-08T00:00:00.000Z'),
        shopId: 'shop-id'
      }
    }));
  });

  test('rejects route plan drafts when a selected order already belongs to another route plan', async () => {
    const { prisma, routePlanStopCreateMany } = createPrismaHarness({
      existingRoutePlanStops: [{ deliveryStopId: 'stop-1' }]
    });
    const repository = new PrismaRoutePlanRepository(
      prisma as unknown as ConstructorParameters<typeof PrismaRoutePlanRepository>[0]
    );

    await expect(
      repository.createRoutePlanDraft({
        createdBy: 'shopify-user-id',
        depot: {
          address: 'Shopify departure location',
          latitude: 43.6532,
          longitude: -79.3832
        },
        name: 'CLEVER route draft',
        orders: [
          routePlanOrder({ gid: 'gid://shopify/Order/123', name: '#1035' }),
          routePlanOrder({ gid: 'gid://shopify/Order/124', name: '#1036' })
        ],
        planDate: '2026-05-08',
        shopDomain: 'Example.myshopify.com'
      })
    ).rejects.toBeInstanceOf(RoutePlanOrderAlreadyPlannedError);

    expect(prisma.routePlanStop.findMany).toHaveBeenCalledWith({
      select: { deliveryStopId: true },
      where: {
        deliveryStopId: { in: ['stop-1', 'stop-2'] },
        routePlan: { shopId: 'shop-id' }
      }
    });
    expect(prisma.routePlan.create).not.toHaveBeenCalled();
    expect(routePlanStopCreateMany).not.toHaveBeenCalled();
  });

  test('creates route drafts from selected order ids by reloading delivery facts and stops', async () => {
    const { prisma, routePlanStopCreateMany } = createPrismaHarness();
    const repository = new PrismaRoutePlanRepository(
      prisma as unknown as ConstructorParameters<typeof PrismaRoutePlanRepository>[0]
    );

    const result = await repository.createRoutePlanDraftFromOrderIds({
      createdBy: 'route-ops',
      depot: { address: 'Depot', latitude: 43.65, longitude: -79.38 },
      name: 'Woo batch',
      orderIds: ['order-1', 'order-2'],
      planDate: '2026-05-08',
      shopDomain: 'example.myshopify.com'
    });

    expect(result).toEqual(expect.objectContaining({ id: 'route-plan-id', stopsCount: 2 }));
    expect(prisma.order.upsert).not.toHaveBeenCalled();
    expect(prisma.deliveryStop.upsert).not.toHaveBeenCalled();
    expect(prisma.orderDeliveryFact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { orderId: { in: ['order-1', 'order-2'] }, shopId: 'shop-id' }
      })
    );
    expect(routePlanStopCreateMany).toHaveBeenCalledWith({
      data: [
        { deliveryStopId: 'stop-1', routePlanId: 'route-plan-id', sequence: 1 },
        { deliveryStopId: 'stop-2', routePlanId: 'route-plan-id', sequence: 2 }
      ]
    });
  });

  test('uses saved shop depot coordinates when selected-order route creation omits depot coordinates', async () => {
    const { prisma } = createPrismaHarness({
      shop: {
        defaultDepotAddress: '4475 Chesswood Dr North York, ON M3J 2C3',
        defaultDepotLatitude: '43.76393',
        defaultDepotLongitude: '-79.476',
        id: 'shop-id'
      }
    });
    const repository = new PrismaRoutePlanRepository(
      prisma as unknown as ConstructorParameters<typeof PrismaRoutePlanRepository>[0]
    );

    await repository.createRoutePlanDraftFromOrderIds({
      createdBy: 'route-ops',
      depot: { address: null, latitude: null, longitude: null },
      name: 'Woo batch',
      orderIds: ['order-1', 'order-2'],
      planDate: '2026-05-08',
      shopDomain: 'example.myshopify.com'
    });

    const createArg = prisma.routePlan.create.mock.calls[0]?.[0] as
      | { data: { constraints: { depot?: { address?: string; latitude?: number; longitude?: number } }; depotLatitude: string | null; depotLongitude: string | null } }
      | undefined;
    expect(createArg?.data.depotLatitude).toBe('43.76393');
    expect(createArg?.data.depotLongitude).toBe('-79.476');
    expect(createArg?.data.constraints.depot).toEqual({
      address: '4475 Chesswood Dr North York, ON M3J 2C3',
      latitude: 43.76393,
      longitude: -79.476
    });
  });

  test('allows selected order id route creation with safe custom route-scope tokens after API preflight', async () => {
    const { prisma, routePlanStopCreateMany } = createPrismaHarness({
      deliveryFacts: [
        orderDeliveryFact({
          deliverySession: 'MORNING',
          orderId: 'order-1',
          routeScopeKey: '2026-05-08|MORNING_DELIVERY|08:00|12:00',
          serviceType: 'MORNING_DELIVERY',
          stopId: 'stop-1'
        })
      ]
    });
    const repository = new PrismaRoutePlanRepository(
      prisma as unknown as ConstructorParameters<typeof PrismaRoutePlanRepository>[0]
    );

    await expect(
      repository.createRoutePlanDraftFromOrderIds({
        createdBy: 'route-ops',
        depot: { address: 'Depot', latitude: 43.65, longitude: -79.38 },
        name: 'Morning Woo batch',
        orderIds: ['order-1'],
        planDate: '2026-05-08',
        shopDomain: 'example.myshopify.com'
      })
    ).resolves.toEqual(expect.objectContaining({ id: 'route-plan-id' }));

    const createArg = prisma.routePlan.create.mock.calls[0]?.[0] as
      | { data: { constraints: { routeScope?: { deliverySession?: string; serviceType?: string } } } }
      | undefined;
    expect(createArg?.data.constraints.routeScope).toEqual(
      expect.objectContaining({
        deliverySession: 'MORNING',
        serviceType: 'MORNING_DELIVERY'
      })
    );
    expect(routePlanStopCreateMany).toHaveBeenCalledWith({
      data: [{ deliveryStopId: 'stop-1', routePlanId: 'route-plan-id', sequence: 1 }]
    });
  });

  test('hard-fails selected order id route creation for mixed route scopes without partial routes', async () => {
    const { prisma, routePlanStopCreateMany } = createPrismaHarness({
      deliveryFacts: [
        orderDeliveryFact({ orderId: 'order-1', routeScopeKey: '2026-05-08|DELIVERY||', stopId: 'stop-1' }),
        orderDeliveryFact({ orderId: 'order-2', routeScopeKey: '2026-05-08|EVENING_DELIVERY|17:00|21:00', serviceType: 'EVENING_DELIVERY', stopId: 'stop-2' })
      ]
    });
    const repository = new PrismaRoutePlanRepository(
      prisma as unknown as ConstructorParameters<typeof PrismaRoutePlanRepository>[0]
    );

    await expect(
      repository.createRoutePlanDraftFromOrderIds({
        createdBy: 'route-ops',
        depot: { address: 'Depot', latitude: 43.65, longitude: -79.38 },
        name: 'Woo batch',
        orderIds: ['order-1', 'order-2'],
        planDate: '2026-05-08',
        shopDomain: 'example.myshopify.com'
      })
    ).rejects.toBeInstanceOf(RoutePlanBatchInvalidError);

    expect(prisma.routePlan.create).not.toHaveBeenCalled();
    expect(routePlanStopCreateMany).not.toHaveBeenCalled();
  });

  test('allows selected order id route creation when stale missing-coordinate fact was resolved live', async () => {
    const { prisma, routePlanStopCreateMany } = createPrismaHarness({
      deliveryFacts: [
        orderDeliveryFact({ orderId: 'order-1', readiness: 'NEEDS_REVIEW', reviewReasons: ['missing_coordinates'], stopId: 'stop-1' })
      ]
    });
    const repository = new PrismaRoutePlanRepository(
      prisma as unknown as ConstructorParameters<typeof PrismaRoutePlanRepository>[0]
    );

    await expect(
      repository.createRoutePlanDraftFromOrderIds({
        createdBy: 'route-ops',
        depot: { address: 'Depot', latitude: 43.65, longitude: -79.38 },
        name: 'Woo batch',
        orderIds: ['order-1'],
        planDate: '2026-05-08',
        shopDomain: 'example.myshopify.com'
      })
    ).resolves.toEqual(expect.objectContaining({ id: 'route-plan-id' }));

    expect(routePlanStopCreateMany).toHaveBeenCalledWith({
      data: [{ deliveryStopId: 'stop-1', routePlanId: 'route-plan-id', sequence: 1 }]
    });
  });

  test('allows selected WooCommerce order id route creation when only normalized order items are missing', async () => {
    const { prisma, routePlanStopCreateMany } = createPrismaHarness({
      deliveryFacts: [
        orderDeliveryFact({
          orderId: 'order-1',
          orderItems: [],
          readiness: 'NEEDS_REVIEW',
          reviewReasons: ['missing_order_items'],
          sourceOrderNumber: '#1035',
          stopId: 'stop-1'
        })
      ]
    });
    const repository = new PrismaRoutePlanRepository(
      prisma as unknown as ConstructorParameters<typeof PrismaRoutePlanRepository>[0]
    );

    await expect(
      repository.createRoutePlanDraftFromOrderIds({
        createdBy: 'route-ops',
        depot: { address: 'Depot', latitude: 43.65, longitude: -79.38 },
        name: 'Woo batch',
        orderIds: ['order-1'],
        planDate: '2026-05-08',
        shopDomain: 'example.myshopify.com'
      })
    ).resolves.toEqual(expect.objectContaining({ id: 'route-plan-id' }));

    expect(routePlanStopCreateMany).toHaveBeenCalledWith({
      data: [{ deliveryStopId: 'stop-1', routePlanId: 'route-plan-id', sequence: 1 }]
    });
  });


  test('reorders, removes omitted stops, and adds same-date stops in normalized sequence', async () => {
    const { prisma, routePlanStopCreateMany } = createPrismaHarness();
    const repository = new PrismaRoutePlanRepository(
      prisma as unknown as ConstructorParameters<typeof PrismaRoutePlanRepository>[0]
    );

    const result = await repository.updateRoutePlanStops({
      routePlanId: 'route-plan-id',
      shopDomain: 'example.myshopify.com',
      payload: {
        stops: [
          { deliveryStopId: 'stop-2', shopifyOrderGid: 'gid://shopify/Order/124', sequence: 20 },
          { shopifyOrderGid: 'gid://shopify/Order/123', sequence: 10 }
        ]
      }
    });

    expect(result?.routePlan.id).toBe('route-plan-id');
    expect(prisma.order.findMany).toHaveBeenCalledWith({
      include: {
        deliveryStops: { take: 1 },
        orderItems: { orderBy: { lineIndex: 'asc' } }
      },
      where: {
        shopId: 'shop-id',
        shopifyOrderGid: { in: ['gid://shopify/Order/123', 'gid://shopify/Order/124'] }
      }
    });
    expect(prisma.deliveryStop.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { shopId_orderId: { orderId: 'order-1', shopId: 'shop-id' } }
      })
    );
    expect(prisma.deliveryStop.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'stop-2',
        orderId: 'order-2',
        shopId: 'shop-id'
      }
    });
    expect(prisma.routePlanStop.deleteMany).toHaveBeenCalledWith({ where: { routePlanId: 'route-plan-id' } });
    expect(routePlanStopCreateMany).toHaveBeenLastCalledWith({
      data: [
        { deliveryStopId: 'stop-1', routePlanId: 'route-plan-id', sequence: 1 },
        { deliveryStopId: 'stop-2', routePlanId: 'route-plan-id', sequence: 2 }
      ]
    });
    expect(prisma.routePlan.update).toHaveBeenCalledOnce();
    const updateArg = prisma.routePlan.update.mock.calls[0]?.[0] as
      | { data: { metrics: { stopsCount: number } }; where: { id: string } }
      | undefined;
    expect(updateArg?.where).toEqual({ id: 'route-plan-id' });
    expect(updateArg?.data.metrics.stopsCount).toBe(2);
  });

  test('preserves published item fingerprint when reordering assigned route stops', async () => {
    const { prisma } = createPrismaHarness({
      routePlanFindFirst: routePlanRecord({
        metrics: {
          deliveryAreas: ['Mississauga'],
          deliveryDays: ['Friday'],
          itemFingerprint: 'published-item-fingerprint',
          missingCoordinates: 0,
          stopsCount: 2
        },
        status: 'ASSIGNED'
      })
    });
    const repository = new PrismaRoutePlanRepository(
      prisma as unknown as ConstructorParameters<typeof PrismaRoutePlanRepository>[0]
    );

    await repository.updateRoutePlanStops({
      routePlanId: 'route-plan-id',
      shopDomain: 'example.myshopify.com',
      payload: {
        stops: [
          { deliveryStopId: 'stop-2', shopifyOrderGid: 'gid://shopify/Order/124', sequence: 1 },
          { deliveryStopId: 'stop-1', shopifyOrderGid: 'gid://shopify/Order/123', sequence: 2 }
        ]
      }
    });

    const metricsUpdate = findRoutePlanMetricsUpdate(prisma);
    expect(metricsUpdate?.data.metrics.itemFingerprint).toBe('published-item-fingerprint');
  });

  test('assigns a route driver within the current shop scope', async () => {
    const { prisma } = createPrismaHarness();
    const repository = new PrismaRoutePlanRepository(
      prisma as unknown as ConstructorParameters<typeof PrismaRoutePlanRepository>[0]
    );

    const result = await repository.assignRoutePlanDriver({
      routePlanId: 'route-plan-id',
      shopDomain: 'example.myshopify.com',
      payload: { driverId: 'driver-id' }
    });

    expect(result?.routePlan.id).toBe('route-plan-id');
    expect(prisma.driver.findFirst).toHaveBeenCalledWith({
      select: { id: true },
      where: {
        id: 'driver-id',
        shopId: 'shop-id'
      }
    });
    expect(prisma.routePlan.update).toHaveBeenCalledWith({
      data: { driverId: 'driver-id' },
      where: { id: 'route-plan-id' }
    });
  });

  test('publishes a driver-assigned draft route as assigned for driver app visibility', async () => {
    const { prisma } = createPrismaHarness();
    prisma.routePlan.findFirst
      .mockResolvedValueOnce({
        _count: { routeStops: 2 },
        driverId: 'driver-id',
        id: 'route-plan-id',
        status: 'DRAFT'
      })
      .mockResolvedValueOnce({
        createdAt: new Date('2026-05-07T12:30:00.000Z'),
        depotLatitude: '43.6532',
        depotLongitude: '-79.3832',
        driverId: 'driver-id',
        id: 'route-plan-id',
        metrics: {
          deliveryAreas: ['Mississauga'],
          deliveryDays: ['Thursday'],
          missingCoordinates: 0,
          stopsCount: 2
        },
        name: 'CLEVER route draft',
        planDate: new Date('2026-05-08T00:00:00.000Z'),
        routeStops: [],
        status: 'ASSIGNED',
        updatedAt: new Date('2026-05-07T12:30:00.000Z')
      });
    const repository = new PrismaRoutePlanRepository(
      prisma as unknown as ConstructorParameters<typeof PrismaRoutePlanRepository>[0]
    );

    const result = await repository.publishRoutePlan({
      routePlanId: 'route-plan-id',
      shopDomain: 'example.myshopify.com'
    });

    expect(result?.routePlan.status).toBe('ASSIGNED');
    expect(hasRouteStatusUpdate(prisma.routePlan.update.mock.calls, 'route-plan-id', 'ASSIGNED')).toBe(true);
  });

  test('rejects publishing a route before a driver is assigned', async () => {
    const { prisma } = createPrismaHarness();
    prisma.routePlan.findFirst.mockResolvedValueOnce({
      _count: { routeStops: 2 },
      driverId: null,
      id: 'route-plan-id',
      status: 'DRAFT'
    });
    const repository = new PrismaRoutePlanRepository(
      prisma as unknown as ConstructorParameters<typeof PrismaRoutePlanRepository>[0]
    );

    await expect(
      repository.publishRoutePlan({
        routePlanId: 'route-plan-id',
        shopDomain: 'example.myshopify.com'
      })
    ).rejects.toBeInstanceOf(RoutePlanPublishInvalidError);

    expect(prisma.routePlan.update).not.toHaveBeenCalledWith(expect.objectContaining({
      data: { status: 'ASSIGNED' }
    }));
  });

  test('rejects assigning a driver from another shop before updating the route', async () => {
    const { prisma } = createPrismaHarness({ driverForAssignment: null });
    const repository = new PrismaRoutePlanRepository(
      prisma as unknown as ConstructorParameters<typeof PrismaRoutePlanRepository>[0]
    );

    await expect(
      repository.assignRoutePlanDriver({
        routePlanId: 'route-plan-id',
        shopDomain: 'example.myshopify.com',
        payload: { driverId: 'other-shop-driver-id' }
      })
    ).rejects.toBeInstanceOf(RoutePlanDriverAssignInvalidError);

    expect(prisma.driver.findFirst).toHaveBeenCalledWith({
      select: { id: true },
      where: {
        id: 'other-shop-driver-id',
        shopId: 'shop-id'
      }
    });
    expect(prisma.routePlan.update).not.toHaveBeenCalled();
  });

  test('rejects duplicate stop update payload orders before changing route stops', async () => {
    const { prisma } = createPrismaHarness();
    const repository = new PrismaRoutePlanRepository(
      prisma as unknown as ConstructorParameters<typeof PrismaRoutePlanRepository>[0]
    );

    await expect(
      repository.updateRoutePlanStops({
        routePlanId: 'route-plan-id',
        shopDomain: 'example.myshopify.com',
        payload: {
          stops: [
            { shopifyOrderGid: 'gid://shopify/Order/123', sequence: 1 },
            { shopifyOrderGid: 'gid://shopify/Order/123', sequence: 2 }
          ]
        }
      })
    ).rejects.toBeInstanceOf(RoutePlanStopUpdateInvalidError);

    expect(prisma.routePlanStop.deleteMany).not.toHaveBeenCalled();
  });

  test('rejects stop update orders that are missing from the current shop before changing stops', async () => {
    const { prisma } = createPrismaHarness({
      orders: [orderRecord({ id: 'order-1', gid: 'gid://shopify/Order/123', stopId: 'stop-1', deliveryDate: '2026-05-08' })]
    });
    const repository = new PrismaRoutePlanRepository(
      prisma as unknown as ConstructorParameters<typeof PrismaRoutePlanRepository>[0]
    );

    await expect(
      repository.updateRoutePlanStops({
        routePlanId: 'route-plan-id',
        shopDomain: 'example.myshopify.com',
        payload: { stops: [{ shopifyOrderGid: 'gid://shopify/Order/999', sequence: 1 }] }
      })
    ).rejects.toMatchObject({
      code: 'ROUTE_STOP_UPDATE_INVALID',
      message: 'Route stops can only include orders from the current shop.'
    });

    expect(prisma.routePlanStop.deleteMany).not.toHaveBeenCalled();
  });

  test('rejects deliveryStopId that is not owned by the selected order and shop', async () => {
    const { prisma } = createPrismaHarness({ deliveryStopForId: null });
    const repository = new PrismaRoutePlanRepository(
      prisma as unknown as ConstructorParameters<typeof PrismaRoutePlanRepository>[0]
    );

    await expect(
      repository.updateRoutePlanStops({
        routePlanId: 'route-plan-id',
        shopDomain: 'example.myshopify.com',
        payload: {
          stops: [{ deliveryStopId: 'other-stop-id', shopifyOrderGid: 'gid://shopify/Order/123', sequence: 1 }]
        }
      })
    ).rejects.toMatchObject({
      code: 'ROUTE_STOP_UPDATE_INVALID',
      message: 'Route stop does not belong to the selected order.'
    });

    expect(prisma.deliveryStop.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'other-stop-id',
        orderId: 'order-1',
        shopId: 'shop-id'
      }
    });
    expect(prisma.routePlanStop.deleteMany).not.toHaveBeenCalled();
  });

  test('rejects wrong-date stop update orders', async () => {
    const { prisma } = createPrismaHarness({ orderDeliveryDate: '2026-05-09' });
    const repository = new PrismaRoutePlanRepository(
      prisma as unknown as ConstructorParameters<typeof PrismaRoutePlanRepository>[0]
    );

    try {
      await repository.updateRoutePlanStops({
        routePlanId: 'route-plan-id',
        shopDomain: 'example.myshopify.com',
        payload: { stops: [{ shopifyOrderGid: 'gid://shopify/Order/123', sequence: 1 }] }
      });
      throw new Error('Expected route stop update to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(RoutePlanStopUpdateInvalidError);
      expect(error).toMatchObject({ code: 'ROUTE_STOP_UPDATE_INVALID' });
      expect(error instanceof Error ? error.message : '').toContain('same delivery date');
    }

    expect(prisma.routePlanStop.deleteMany).not.toHaveBeenCalled();
  });

  test('rejects stop update orders already assigned to another route plan while allowing same-route stops', async () => {
    const { prisma } = createPrismaHarness({ existingRoutePlanStops: [{ deliveryStopId: 'stop-1' }] });
    const repository = new PrismaRoutePlanRepository(
      prisma as unknown as ConstructorParameters<typeof PrismaRoutePlanRepository>[0]
    );

    await expect(
      repository.updateRoutePlanStops({
        routePlanId: 'route-plan-id',
        shopDomain: 'example.myshopify.com',
        payload: { stops: [{ deliveryStopId: 'stop-1', shopifyOrderGid: 'gid://shopify/Order/123', sequence: 1 }] }
      })
    ).rejects.toBeInstanceOf(RoutePlanOrderAlreadyPlannedError);

    expect(prisma.routePlanStop.findMany).toHaveBeenCalledWith({
      select: { deliveryStopId: true },
      where: {
        deliveryStopId: { in: ['stop-1'] },
        routePlanId: { not: 'route-plan-id' },
        routePlan: { shopId: 'shop-id' }
      }
    });
    expect(prisma.routePlanStop.deleteMany).not.toHaveBeenCalled();
  });

  test('returns null without touching stops when route plan is outside the current shop scope', async () => {
    const { prisma } = createPrismaHarness({ routePlanToDelete: null });
    const repository = new PrismaRoutePlanRepository(
      prisma as unknown as ConstructorParameters<typeof PrismaRoutePlanRepository>[0]
    );

    const result = await repository.updateRoutePlanStops({
      routePlanId: 'other-shop-route-plan-id',
      shopDomain: 'example.myshopify.com',
      payload: { stops: [{ shopifyOrderGid: 'gid://shopify/Order/123', sequence: 1 }] }
    });

    expect(result).toBeNull();
    expect(prisma.routePlan.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'other-shop-route-plan-id', shopId: 'shop-id' } })
    );
    expect(prisma.routePlanStop.deleteMany).not.toHaveBeenCalled();
  });

  test('maps a pending invite driver to INVITE_PENDING on route plan detail fetch', async () => {
    const { prisma } = createPrismaHarness();
    prisma.routePlan.findFirst = vi.fn(() =>
      Promise.resolve({
        createdAt: new Date('2026-05-07T12:30:00.000Z'),
        depotLatitude: '43.6532',
        depotLongitude: '-79.3832',
        driver: {
          _count: { driverEvents: 3 },
          authSubject: null,
          createdAt: new Date('2026-05-07T12:00:00.000Z'),
          displayName: 'Test Driver',
          id: 'driver-id',
          lastSeenAt: new Date('2026-05-07T12:15:00.000Z'),
          phone: '+14165550111',
          status: 'ACTIVE',
          updatedAt: new Date('2026-05-07T12:20:00.000Z')
        },
        id: 'route-plan-id',
        metrics: {
          deliveryAreas: ['Mississauga'],
          deliveryDays: ['Thursday'],
          missingCoordinates: 0,
          stopsCount: 0
        },
        name: 'Pending driver route',
        planDate: new Date('2026-05-08T00:00:00.000Z'),
        status: 'DRAFT',
        updatedAt: new Date('2026-05-07T12:30:00.000Z')
      } satisfies unknown)
    );

    const repository = new PrismaRoutePlanRepository(
      prisma as unknown as ConstructorParameters<typeof PrismaRoutePlanRepository>[0]
    );

    const detail = await repository.findRoutePlanDetail({
      routePlanId: 'route-plan-id',
      shopDomain: 'example.myshopify.com'
    });

    expect(detail?.routePlan.driver).toEqual(expect.objectContaining({
      authStatus: 'INVITE_PENDING',
      authSubject: null,
      id: 'driver-id',
      status: 'PENDING'
    }));
    expect(detail?.routePlan.driver?.recentEventsCount).toBe(3);
  });

  test('leaves a draft route missing depot coordinates unchanged when detail is opened', async () => {
    const { prisma } = createPrismaHarness({
      routePlanFindFirst: {
        createdAt: new Date('2026-05-07T12:30:00.000Z'),
        constraints: { routeScope: null },
        depotLatitude: null,
        depotLongitude: null,
        id: 'route-plan-id',
        metrics: {
          deliveryAreas: ['Toronto'],
          deliveryDays: ['Thursday'],
          missingCoordinates: 0,
          stopsCount: 0
        },
        name: 'Missing depot draft',
        planDate: new Date('2026-05-08T00:00:00.000Z'),
        routeStops: [],
        status: 'DRAFT',
        updatedAt: new Date('2026-05-07T12:30:00.000Z')
      },
      shop: {
        defaultDepotAddress: '4475 Chesswood Dr North York, ON M3J 2C3',
        defaultDepotLatitude: '43.76393',
        defaultDepotLongitude: '-79.476',
        id: 'shop-id'
      }
    });
    const repository = new PrismaRoutePlanRepository(
      prisma as unknown as ConstructorParameters<typeof PrismaRoutePlanRepository>[0]
    );

    const detail = await repository.findRoutePlanDetail({
      routePlanId: 'route-plan-id',
      shopDomain: 'example.myshopify.com'
    });

    expect(detail?.routePlan.depot).toEqual({ latitude: null, longitude: null });
    expect(prisma.routePlan.update).not.toHaveBeenCalled();
  });

  test('saves return-to-depot route mode in draft route constraints', async () => {
    const { prisma } = createPrismaHarness({
      shop: {
        defaultDepotAddress: '4475 Chesswood Dr North York, ON M3J 2C3',
        defaultDepotLatitude: '43.76393',
        defaultDepotLongitude: '-79.476',
        id: 'shop-id'
      }
    });
    prisma.routePlan.findFirst
      .mockResolvedValueOnce({
        constraints: {},
        depotLatitude: null,
        depotLongitude: null,
        id: 'route-plan-id',
        status: 'DRAFT'
      })
      .mockResolvedValueOnce({
        createdAt: new Date('2026-05-07T12:30:00.000Z'),
        constraints: {
          depot: {
            address: '4475 Chesswood Dr North York, ON M3J 2C3',
            latitude: 43.76393,
            longitude: -79.476
          },
          routeEndMode: 'RETURN_TO_DEPOT'
        },
        depotLatitude: '43.76393',
        depotLongitude: '-79.476',
        id: 'route-plan-id',
        metrics: {
          deliveryAreas: ['Toronto'],
          deliveryDays: ['Thursday'],
          missingCoordinates: 0,
          stopsCount: 0
        },
        name: 'Return route',
        planDate: new Date('2026-05-08T00:00:00.000Z'),
        routeStops: [],
        status: 'DRAFT',
        updatedAt: new Date('2026-05-07T12:30:00.000Z')
      });
    const repository = new PrismaRoutePlanRepository(
      prisma as unknown as ConstructorParameters<typeof PrismaRoutePlanRepository>[0]
    );

    const detail = await repository.updateRoutePlanOptions({
      routePlanId: 'route-plan-id',
      shopDomain: 'example.myshopify.com',
      payload: { routeEndMode: 'RETURN_TO_DEPOT' }
    });

    expect(detail?.routePlan.routeEndMode).toBe('RETURN_TO_DEPOT');
    expect(prisma.routePlan.update).toHaveBeenCalledWith({
      data: {
        constraints: {
          depot: {
            address: '4475 Chesswood Dr North York, ON M3J 2C3',
            latitude: 43.76393,
            longitude: -79.476
          },
          optimizer: 'manual-sequence-mvp',
          routeEndMode: 'RETURN_TO_DEPOT',
          sequenceSource: 'request-order'
        },
        depotLatitude: '43.76393',
        depotLongitude: '-79.476'
      },
      where: { id: 'route-plan-id' }
    });
  });

  test('saves return-to-depot route mode after route publishing', async () => {
    const { prisma } = createPrismaHarness({
      shop: {
        defaultDepotAddress: '4475 Chesswood Dr North York, ON M3J 2C3',
        defaultDepotLatitude: '43.76393',
        defaultDepotLongitude: '-79.476',
        id: 'shop-id'
      }
    });
    prisma.routePlan.findFirst
      .mockResolvedValueOnce({
        constraints: { routeEndMode: 'END_AT_LAST_STOP' },
        depotLatitude: '43.6532',
        depotLongitude: '-79.3832',
        id: 'route-plan-id',
        status: 'ASSIGNED'
      })
      .mockResolvedValueOnce({
        createdAt: new Date('2026-05-07T12:30:00.000Z'),
        constraints: { routeEndMode: 'RETURN_TO_DEPOT' },
        depotLatitude: '43.6532',
        depotLongitude: '-79.3832',
        id: 'route-plan-id',
        metrics: {
          deliveryAreas: ['Toronto'],
          deliveryDays: ['Thursday'],
          missingCoordinates: 0,
          stopsCount: 0
        },
        name: 'Published return route',
        planDate: new Date('2026-05-08T00:00:00.000Z'),
        routeStops: [],
        status: 'ASSIGNED',
        updatedAt: new Date('2026-05-07T12:30:00.000Z')
      });
    const repository = new PrismaRoutePlanRepository(
      prisma as unknown as ConstructorParameters<typeof PrismaRoutePlanRepository>[0]
    );

    const detail = await repository.updateRoutePlanOptions({
      routePlanId: 'route-plan-id',
      shopDomain: 'example.myshopify.com',
      payload: { routeEndMode: 'RETURN_TO_DEPOT' }
    });

    expect(detail?.routePlan.routeEndMode).toBe('RETURN_TO_DEPOT');
    expect(detail?.routePlan.status).toBe('ASSIGNED');
    expect(prisma.routePlan.update).toHaveBeenCalledWith({
      data: {
        constraints: {
          depot: {
            address: null,
            latitude: 43.6532,
            longitude: -79.3832
          },
          optimizer: 'manual-sequence-mvp',
          routeEndMode: 'RETURN_TO_DEPOT',
          sequenceSource: 'request-order'
        }
      },
      where: { id: 'route-plan-id' }
    });
  });

  test('aggregate save applies changed fields but keeps draft routes unpublished', async () => {
    const firstDuplicateItem = orderItemRecord({ quantity: 1 });
    const secondDuplicateItem = orderItemRecord({ quantity: 2 });
    const duplicateItemOrders = [
      orderRecord({
        deliveryDate: '2026-05-08',
        gid: 'gid://shopify/Order/123',
        id: 'order-1',
        orderItems: [firstDuplicateItem],
        stopId: 'stop-1'
      }),
      orderRecord({
        deliveryDate: '2026-05-08',
        gid: 'gid://shopify/Order/124',
        id: 'order-2',
        orderItems: [secondDuplicateItem],
        stopId: 'stop-2'
      })
    ];
    const { prisma, routePlanStopCreateMany } = createPrismaHarness({ orders: duplicateItemOrders });
    const initialRoute = routePlanRecord({
      constraints: { routeEndMode: 'END_AT_LAST_STOP' },
      driverId: null,
      routeStops: [],
      status: 'DRAFT',
      updatedAt: new Date('2026-05-07T12:30:00.000Z')
    });
    const savedRoute = routePlanRecord({
      constraints: { routeEndMode: 'RETURN_TO_DEPOT' },
      driverId: 'driver-id',
      metrics: {
        deliveryAreas: ['Mississauga'],
        deliveryDays: ['Thursday'],
        missingCoordinates: 0,
        stopsCount: 2
      },
      routeStops: [],
      status: 'DRAFT',
      updatedAt: new Date('2026-05-07T12:31:00.000Z')
    });
    prisma.routePlan.findFirst
      .mockResolvedValueOnce(initialRoute)
      .mockResolvedValueOnce(savedRoute);
    const repository = new PrismaRoutePlanRepository(
      prisma as unknown as ConstructorParameters<typeof PrismaRoutePlanRepository>[0]
    );

    const result = await repository.saveRoutePlan({
      routePlanId: 'route-plan-id',
      shopDomain: 'example.myshopify.com',
      payload: {
        driverId: 'driver-id',
        expectedUpdatedAt: '2026-05-07T12:30:00.000Z',
        routeEndMode: 'RETURN_TO_DEPOT',
        stops: [
          { deliveryStopId: 'stop-2', shopifyOrderGid: 'gid://shopify/Order/124', sequence: 1 },
          { deliveryStopId: 'stop-1', shopifyOrderGid: 'gid://shopify/Order/123', sequence: 2 }
        ]
      }
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expectRoutePlanVersionClaim(prisma, '2026-05-07T12:30:00.000Z');
    expect(result?.detail.routePlan.status).toBe('DRAFT');
    expect(result?.operations).toEqual([
      { name: 'options', reason: 'route_end_mode_changed', status: 'applied' },
      { name: 'stops', reason: 'sequence_changed', status: 'applied' },
      { name: 'driver', reason: 'driver_changed', status: 'applied' },
      { name: 'publish', reason: 'explicit_publish_required', status: 'skipped' }
    ]);
    expect(routePlanStopCreateMany).toHaveBeenCalledWith({
      data: [
        { deliveryStopId: 'stop-2', routePlanId: 'route-plan-id', sequence: 1 },
        { deliveryStopId: 'stop-1', routePlanId: 'route-plan-id', sequence: 2 }
      ]
    });
    expect(prisma.routePlan.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { driverId: 'driver-id' },
      where: { id: 'route-plan-id' }
    }));
    expect(hasRouteStatusUpdate(prisma.routePlan.update.mock.calls, 'route-plan-id', 'ASSIGNED')).toBe(false);
  });

  test('aggregate save applies route options after publishing without republishing', async () => {
    const { prisma, routePlanStopCreateMany } = createPrismaHarness();
    const assignedRoute = routePlanRecord({
      constraints: { routeEndMode: 'END_AT_LAST_STOP' },
      driverId: 'driver-id',
      status: 'ASSIGNED',
      updatedAt: new Date('2026-05-07T12:30:00.000Z')
    });
    const savedRoute = routePlanRecord({
      constraints: { routeEndMode: 'RETURN_TO_DEPOT' },
      driverId: 'driver-id',
      status: 'ASSIGNED',
      updatedAt: new Date('2026-05-07T12:31:00.000Z')
    });
    prisma.routePlan.findFirst
      .mockResolvedValueOnce(assignedRoute)
      .mockResolvedValueOnce(savedRoute);
    const repository = new PrismaRoutePlanRepository(
      prisma as unknown as ConstructorParameters<typeof PrismaRoutePlanRepository>[0]
    );

    const result = await repository.saveRoutePlan({
      routePlanId: 'route-plan-id',
      shopDomain: 'example.myshopify.com',
      payload: {
        expectedUpdatedAt: '2026-05-07T12:30:00.000Z',
        routeEndMode: 'RETURN_TO_DEPOT'
      }
    });

    expectRoutePlanVersionClaim(prisma, '2026-05-07T12:30:00.000Z');
    expect(result?.detail.routePlan.routeEndMode).toBe('RETURN_TO_DEPOT');
    expect(result?.detail.routePlan.status).toBe('ASSIGNED');
    expect(result?.operations).toEqual([
      { name: 'options', reason: 'route_end_mode_changed', status: 'applied' },
      { name: 'stops', reason: 'not_provided', status: 'skipped' },
      { name: 'driver', reason: 'not_provided', status: 'skipped' },
      { name: 'publish', reason: 'status_assigned', status: 'skipped' }
    ]);
    expect(routePlanStopCreateMany).not.toHaveBeenCalled();
    expect(prisma.routePlan.update).toHaveBeenCalledWith({
      data: {
        constraints: {
          depot: {
            address: null,
            latitude: 43.6532,
            longitude: -79.3832
          },
          optimizer: 'manual-sequence-mvp',
          routeEndMode: 'RETURN_TO_DEPOT',
          sequenceSource: 'request-order'
        }
      },
      where: { id: 'route-plan-id' }
    });
  });

  test('aggregate save preserves published item fingerprint when assigned route stops are saved', async () => {
    const { prisma } = createPrismaHarness();
    const assignedRoute = routePlanRecord({
      driverId: 'driver-id',
      metrics: {
        deliveryAreas: ['Mississauga'],
        deliveryDays: ['Friday'],
        itemFingerprint: 'published-item-fingerprint',
        missingCoordinates: 0,
        stopsCount: 2
      },
      status: 'ASSIGNED',
      updatedAt: new Date('2026-05-07T12:30:00.000Z')
    });
    prisma.routePlan.findFirst
      .mockResolvedValueOnce(assignedRoute)
      .mockResolvedValueOnce(assignedRoute);
    const repository = new PrismaRoutePlanRepository(
      prisma as unknown as ConstructorParameters<typeof PrismaRoutePlanRepository>[0]
    );

    await repository.saveRoutePlan({
      routePlanId: 'route-plan-id',
      shopDomain: 'example.myshopify.com',
      payload: {
        expectedUpdatedAt: '2026-05-07T12:30:00.000Z',
        stops: [
          { deliveryStopId: 'stop-2', shopifyOrderGid: 'gid://shopify/Order/124', sequence: 1 },
          { deliveryStopId: 'stop-1', shopifyOrderGid: 'gid://shopify/Order/123', sequence: 2 }
        ]
      }
    });

    const metricsUpdate = findRoutePlanMetricsUpdate(prisma);
    expect(metricsUpdate?.data.metrics.itemFingerprint).toBe('published-item-fingerprint');
  });

  test('aggregate save rejects stale route details before mutating route state', async () => {
    const { prisma, routePlanStopCreateMany } = createPrismaHarness();
    prisma.routePlan.findFirst.mockResolvedValueOnce(routePlanRecord({
      updatedAt: new Date('2026-05-07T12:30:00.000Z')
    }));
    prisma.routePlan.updateMany.mockResolvedValueOnce({ count: 0 });
    const repository = new PrismaRoutePlanRepository(
      prisma as unknown as ConstructorParameters<typeof PrismaRoutePlanRepository>[0]
    );

    await expect(repository.saveRoutePlan({
      routePlanId: 'route-plan-id',
      shopDomain: 'example.myshopify.com',
      payload: {
        driverId: 'driver-id',
        expectedUpdatedAt: '2026-05-07T12:29:59.000Z'
      }
    })).rejects.toBeInstanceOf(RoutePlanConflictError);

    expectRoutePlanVersionClaim(prisma, '2026-05-07T12:29:59.000Z');
    expect(prisma.routePlan.update).not.toHaveBeenCalled();
    expect(prisma.routePlanStop.deleteMany).not.toHaveBeenCalled();
    expect(routePlanStopCreateMany).not.toHaveBeenCalled();
  });

  test('aggregate save does not claim a route version when the payload has no route mutation', async () => {
    const { prisma, routePlanStopCreateMany } = createPrismaHarness();
    const assignedRoute = routePlanRecord({
      driverId: 'driver-id',
      status: 'ASSIGNED',
      updatedAt: new Date('2026-05-07T12:30:00.000Z')
    });
    prisma.routePlan.findFirst
      .mockResolvedValueOnce(assignedRoute)
      .mockResolvedValueOnce(assignedRoute);
    const repository = new PrismaRoutePlanRepository(
      prisma as unknown as ConstructorParameters<typeof PrismaRoutePlanRepository>[0]
    );

    const result = await repository.saveRoutePlan({
      routePlanId: 'route-plan-id',
      shopDomain: 'example.myshopify.com',
      payload: {
        expectedUpdatedAt: '2026-05-07T12:30:00.000Z'
      }
    });

    expect(prisma.routePlan.updateMany).not.toHaveBeenCalled();
    expect(prisma.routePlan.update).not.toHaveBeenCalled();
    expect(prisma.routePlanStop.deleteMany).not.toHaveBeenCalled();
    expect(routePlanStopCreateMany).not.toHaveBeenCalled();
    expect(result?.operations).toEqual([
      { name: 'options', reason: 'not_provided', status: 'skipped' },
      { name: 'stops', reason: 'not_provided', status: 'skipped' },
      { name: 'driver', reason: 'not_provided', status: 'skipped' },
      { name: 'publish', reason: 'status_assigned', status: 'skipped' }
    ]);
  });

  test('deletes route-plan stops first and then deletes the route plan within shop scope', async () => {
    const { prisma } = createPrismaHarness();
    const repository = new PrismaRoutePlanRepository(
      prisma as unknown as ConstructorParameters<typeof PrismaRoutePlanRepository>[0]
    );

    const result = await repository.deleteRoutePlan({
      routePlanId: 'route-plan-id',
      shopDomain: 'example.myshopify.com'
    });

    expect(result).toEqual({
      routePlanId: 'route-plan-id',
      deleted: true
    });
    expect(prisma.routePlan.findFirst).toHaveBeenCalledWith({
      select: { id: true },
      where: { id: 'route-plan-id', shopId: 'shop-id' }
    });
    expect(prisma.routeGroupingChildVersion.count).toHaveBeenCalledWith({
      where: { routePlanId: 'route-plan-id', shopId: 'shop-id' }
    });
    expect(prisma.routePlanStop.deleteMany).toHaveBeenCalledWith({
      where: { routePlanId: 'route-plan-id' }
    });
    expect(prisma.routePlan.delete).toHaveBeenCalledWith({
      where: { id: 'route-plan-id' }
    });
    expect(prisma.routePlan.delete).toHaveBeenCalledTimes(1);
  });


  test('blocks direct deletion of a route generated from a parent grouping', async () => {
    const { prisma } = createPrismaHarness({ routeGroupingChildVersionCount: 1 });
    const repository = new PrismaRoutePlanRepository(
      prisma as unknown as ConstructorParameters<typeof PrismaRoutePlanRepository>[0]
    );

    await expect(repository.deleteRoutePlan({
      routePlanId: 'route-plan-id',
      shopDomain: 'example.myshopify.com'
    })).rejects.toBeInstanceOf(RoutePlanDeleteBlockedError);

    expect(prisma.routePlanStop.deleteMany).not.toHaveBeenCalled();
    expect(prisma.routePlan.delete).not.toHaveBeenCalled();
  });

  test('returns deleted:false when no matching route plan is found for this shop', async () => {
    const { prisma } = createPrismaHarness({
      routePlanToDelete: null
    });
    const repository = new PrismaRoutePlanRepository(
      prisma as unknown as ConstructorParameters<typeof PrismaRoutePlanRepository>[0]
    );

    const result = await repository.deleteRoutePlan({
      routePlanId: 'route-plan-id',
      shopDomain: 'example.myshopify.com'
    });

    expect(result).toEqual({
      routePlanId: 'route-plan-id',
      deleted: false
    });
    expect(prisma.routePlan.findFirst).toHaveBeenCalledWith({
      select: { id: true },
      where: { id: 'route-plan-id', shopId: 'shop-id' }
    });
    expect(prisma.routePlanStop.deleteMany).not.toHaveBeenCalled();
    expect(prisma.routePlan.delete).not.toHaveBeenCalled();
  });
});

function hasRouteStatusUpdate(
  calls: unknown[][],
  routePlanId: string,
  status: string
): boolean {
  return calls.some(([call]) => {
    const update = call as { data?: { status?: unknown }; where?: { id?: unknown } } | undefined;
    return update?.where?.id === routePlanId && update.data?.status === status;
  });
}

function createPrismaHarness(input: {
  deliveryStopForId?: { id: string } | null;
  deliveryFacts?: Array<Record<string, unknown>>;
  driverForAssignment?: { id: string } | null;
  existingRoutePlanStops?: Array<{ deliveryStopId: string }>;
  orderDeliveryDate?: string;
  orders?: Array<Record<string, unknown>>;
  routeGeometryCacheFindFirst?: Record<string, unknown> | null;
  routeGeometryCacheFindUnique?: Record<string, unknown> | null;
  routePlanFindFirst?: Record<string, unknown> | null;
  routePlanToDelete?: { id: string } | null;
  routeGroupingChildVersionCount?: number;
  shop?: Record<string, unknown> | null;
} = {}): {
  prisma: {
    $transaction: ReturnType<typeof vi.fn>;
    deliveryStop: {
      findFirst: ReturnType<typeof vi.fn>;
      upsert: ReturnType<typeof vi.fn>;
    };
    driver: {
      findFirst: ReturnType<typeof vi.fn>;
    };
    order: {
      findMany: ReturnType<typeof vi.fn>;
      upsert: ReturnType<typeof vi.fn>;
    };
    orderDeliveryFact: {
      findMany: ReturnType<typeof vi.fn>;
    };
    routeGroupingChildVersion: {
      count: ReturnType<typeof vi.fn>;
    };
    routePlan: {
      create: ReturnType<typeof vi.fn>;
      findFirst: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
      delete: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
    routePlanGeometryCache: {
      findFirst: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
      upsert: ReturnType<typeof vi.fn>;
    };
    routePlanStop: {
      createMany: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
      deleteMany: ReturnType<typeof vi.fn>;
    };
    shop: {
      findUnique: ReturnType<typeof vi.fn>;
      upsert: ReturnType<typeof vi.fn>;
    };
  };
  routePlanStopCreateMany: ReturnType<typeof vi.fn>;
} {
  const routePlanStopCreateMany = vi.fn(() => Promise.resolve({ count: 2 }));
  const prisma = {
    $transaction: vi.fn(async (callback: (client: unknown) => Promise<unknown>) => callback(prisma)),
    deliveryStop: {
      findFirst: vi.fn((args: { where?: { id?: string } }) =>
        Promise.resolve(
          input.deliveryStopForId === undefined
            ? { id: args.where?.id ?? 'stop-1' }
            : input.deliveryStopForId
        )
      ),
      upsert: vi
        .fn()
        .mockResolvedValueOnce({ id: 'stop-1' })
        .mockResolvedValueOnce({ id: 'stop-2' })
        .mockResolvedValue({ id: 'stop-3' })
    },
    driver: {
      findFirst: vi.fn(() => Promise.resolve(input.driverForAssignment === undefined ? { id: 'driver-id' } : input.driverForAssignment))
    },
    order: {
      findMany: vi.fn(() => Promise.resolve(input.orders ?? [
        orderRecord({ id: 'order-1', gid: 'gid://shopify/Order/123', stopId: 'stop-1', deliveryDate: input.orderDeliveryDate ?? '2026-05-08' }),
        orderRecord({ id: 'order-2', gid: 'gid://shopify/Order/124', stopId: 'stop-2', deliveryDate: input.orderDeliveryDate ?? '2026-05-08' })
      ])),
      upsert: vi
        .fn()
        .mockResolvedValueOnce({ id: 'order-1' })
        .mockResolvedValueOnce({ id: 'order-2' })
    },
    orderDeliveryFact: {
      findMany: vi.fn(() =>
        Promise.resolve(
          input.deliveryFacts ?? [
            orderDeliveryFact({ orderId: 'order-1', stopId: 'stop-1', sourceOrderNumber: '#1035' }),
            orderDeliveryFact({ orderId: 'order-2', stopId: 'stop-2', sourceOrderNumber: '#1036' })
          ]
        )
      )
    },
    routeGroupingChildVersion: {
      count: vi.fn(() => Promise.resolve(input.routeGroupingChildVersionCount ?? 0))
    },
    routePlan: {
      create: vi.fn(() =>
        Promise.resolve({
          createdAt: new Date('2026-05-07T12:30:00.000Z'),
          depotLatitude: '43.6532',
          depotLongitude: '-79.3832',
          id: 'route-plan-id',
          metrics: {
            deliveryAreas: ['Mississauga'],
            deliveryDays: ['Thursday'],
            missingCoordinates: 0,
            stopsCount: 2
          },
          name: 'CLEVER route draft',
          planDate: new Date('2026-05-08T00:00:00.000Z'),
          status: 'DRAFT',
          updatedAt: new Date('2026-05-07T12:30:00.000Z')
        })
      ),
      findFirst: vi.fn(() =>
        input.routePlanFindFirst !== undefined
          ? Promise.resolve(input.routePlanFindFirst)
          :
        input.routePlanToDelete !== undefined
          ? input.routePlanToDelete === null
            ? Promise.resolve(null)
            : Promise.resolve(input.routePlanToDelete)
          : Promise.resolve({
              createdAt: new Date('2026-05-07T12:30:00.000Z'),
              depotLatitude: '43.6532',
              depotLongitude: '-79.3832',
              id: 'route-plan-id',
              metrics: {
                deliveryAreas: ['Mississauga'],
                deliveryDays: ['Thursday'],
                missingCoordinates: 0,
                stopsCount: 0
              },
              name: 'CLEVER route draft',
              planDate: new Date('2026-05-08T00:00:00.000Z'),
              routeStops: [],
              status: 'DRAFT',
              updatedAt: new Date('2026-05-07T12:30:00.000Z')
            })
      ),
      findMany: vi.fn(() => Promise.resolve([])),
      update: vi.fn(() => Promise.resolve({ id: 'route-plan-id' })),
      updateMany: vi.fn(() => Promise.resolve({ count: 1 })),
      delete: vi.fn(() =>
        Promise.resolve({
          createdAt: new Date('2026-05-07T12:30:00.000Z'),
          depotLatitude: '43.6532',
          depotLongitude: '-79.3832',
          id: 'route-plan-id',
          metrics: {
            deliveryAreas: ['Mississauga'],
            deliveryDays: ['Thursday'],
            missingCoordinates: 0,
            stopsCount: 2
          },
          name: 'CLEVER route draft',
          planDate: new Date('2026-05-08T00:00:00.000Z'),
          status: 'DRAFT',
          updatedAt: new Date('2026-05-07T12:30:00.000Z')
        })
      )
    },
    routePlanGeometryCache: {
      findFirst: vi.fn((args: unknown) => { void args; return Promise.resolve(input.routeGeometryCacheFindFirst ?? null); }),
      findUnique: vi.fn((args: unknown) => { void args; return Promise.resolve(input.routeGeometryCacheFindUnique ?? null); }),
      upsert: vi.fn((args: unknown) => { void args; return Promise.resolve({ id: 'route-geometry-cache-id' }); })
    },
    routePlanStop: {
      createMany: routePlanStopCreateMany,
      findMany: vi.fn(() => Promise.resolve(input.existingRoutePlanStops ?? [])),
      deleteMany: vi.fn(() => Promise.resolve({ count: 2 }))
    },
    shop: {
      findUnique: vi.fn(() => Promise.resolve(input.shop === undefined ? { id: 'shop-id' } : input.shop)),
      upsert: vi.fn(() => Promise.resolve(input.shop === undefined ? { id: 'shop-id', shopDomain: 'example.myshopify.com' } : input.shop))
    }
  };

  return { prisma, routePlanStopCreateMany };
}

function expectRoutePlanVersionClaim(
  prisma: ReturnType<typeof createPrismaHarness>['prisma'],
  expectedUpdatedAt: string
): void {
  const rawCall = prisma.routePlan.updateMany.mock.calls.at(-1)?.[0] as unknown;
  const updateManyCall = rawCall as
    | { data?: { updatedAt?: unknown }; where?: { id?: unknown; shopId?: unknown; updatedAt?: unknown } }
    | undefined;
  expect(updateManyCall?.data?.updatedAt).toBeInstanceOf(Date);
  expect(updateManyCall?.where).toEqual({
    id: 'route-plan-id',
    shopId: 'shop-id',
    updatedAt: new Date(expectedUpdatedAt)
  });
}

function findRoutePlanMetricsUpdate(
  prisma: ReturnType<typeof createPrismaHarness>['prisma']
): { data: { metrics: Record<string, unknown> } } | undefined {
  return prisma.routePlan.update.mock.calls
    .map(([call]) => call as { data?: { metrics?: Record<string, unknown> } } | undefined)
    .find((call): call is { data: { metrics: Record<string, unknown> } } => call?.data?.metrics !== undefined);
}

function routePlanRecord(input: {
  constraints?: Record<string, unknown>;
  driverId?: string | null;
  metrics?: Record<string, unknown>;
  routeStops?: Array<Record<string, unknown>>;
  status?: string;
  updatedAt?: Date;
} = {}): Record<string, unknown> {
  return {
    createdAt: new Date('2026-05-07T12:30:00.000Z'),
    constraints: input.constraints ?? {},
    depotLatitude: '43.6532',
    depotLongitude: '-79.3832',
    driverId: input.driverId ?? null,
    id: 'route-plan-id',
    metrics: input.metrics ?? {
      deliveryAreas: ['Mississauga'],
      deliveryDays: ['Thursday'],
      missingCoordinates: 0,
      stopsCount: input.routeStops?.length ?? 0
    },
    name: 'CLEVER route draft',
    planDate: new Date('2026-05-08T00:00:00.000Z'),
    routeStops: input.routeStops ?? [],
    status: input.status ?? 'DRAFT',
    updatedAt: input.updatedAt ?? new Date('2026-05-07T12:30:00.000Z')
  };
}

function orderRecord(input: {
  deliveryDate: string;
  gid: string;
  id: string;
  orderItems?: OrderItemDto[];
  stopId: string;
}): Record<string, unknown> {
  return {
    deliveryStops: [
      {
        address1: '300 City Centre Dr',
        address2: '#08',
        city: 'Mississauga',
        countryCode: 'CA',
        deliveryDate: new Date(`${input.deliveryDate}T00:00:00.000Z`),
        id: input.stopId,
        latitude: '43.589',
        longitude: '-79.644',
        phone: '+14165550000',
        postalCode: 'L5B 3C1',
        province: 'ON',
        recipientName: 'Noah Yoon',
        status: 'PENDING'
      }
    ],
    email: 'customer@example.com',
    financialStatus: 'PENDING',
    fulfillmentStatus: 'UNFULFILLED',
    id: input.id,
    name: input.gid.endsWith('/123') ? '#1035' : '#1036',
    orderItems: input.orderItems ?? [orderItemRecord()],
    phone: '+14165550000',
    rawPayload: {
      deliveryArea: 'Mississauga',
      deliveryDate: input.deliveryDate,
      deliveryDay: 'Thursday',
      recipientName: 'Noah Yoon',
      timeWindowEnd: '21:00',
      timeWindowStart: '17:00'
    },
    shippingAddress: {
      address1: '300 City Centre Dr',
      address2: '#08',
      city: 'Mississauga',
      countryCode: 'CA',
      postalCode: 'L5B 3C1',
      province: 'ON'
    },
    shopifyOrderGid: input.gid
  };
}

function orderDeliveryFact(input: {
  deliverySession?: string;
  orderId: string;
  orderItems?: OrderItemDto[];
  readiness?: string;
  reviewReasons?: string[];
  routeScopeKey?: string;
  serviceType?: string;
  sourceOrderNumber?: string;
  stopId: string;
}): Record<string, unknown> {
  return {
    deliveryArea: 'Mississauga',
    deliveryDate: new Date('2026-05-08T00:00:00.000Z'),
    deliveryDateWeekday: 'FRIDAY',
    deliveryDateWeekdayMismatch: false,
    deliveryDateWeekdayVerified: true,
    deliveryDayParseStatus: 'PARSED',
    deliverySession: input.deliverySession ?? (input.serviceType === 'EVENING_DELIVERY' ? 'EVENING' : 'DAY'),
    deliveryWeekday: 'FRIDAY',
    geocodeStatus: 'RESOLVED',
    order: {
      deliveryStops: [
        {
          id: input.stopId,
          latitude: '43.589',
          longitude: '-79.644',
          routePlanStops: []
        }
      ],
      name: input.sourceOrderNumber ?? '#1035',
      orderItems: input.orderItems ?? [orderItemRecord()]
    },
    orderId: input.orderId,
    planningGroupKey: `${input.routeScopeKey ?? '2026-05-08|DELIVERY||'}|Mississauga`,
    rawDeliveryDay: 'Friday',
    rawDeliveryTimeWindow: null,
    readiness: input.readiness ?? 'READY_TO_PLAN',
    reviewReasons: input.reviewReasons ?? [],
    routeScopeKey: input.routeScopeKey ?? '2026-05-08|DELIVERY||',
    serviceType: input.serviceType ?? 'DELIVERY',
    sourceOrderId: input.orderId,
    sourceOrderNumber: input.sourceOrderNumber ?? '#1035',
    sourcePlatform: 'WOOCOMMERCE',
    sourceSiteUrl: 'https://woo.example.test',
    timeWindowEnd: null,
    timeWindowStart: null
  };
}

function orderItemRecord(input: {
  name?: string;
  options?: Array<{ key: string; value: string }>;
  productId?: number;
  quantity?: number;
  sku?: string | null;
  variationId?: number;
} = {}): OrderItemDto {
  return {
    name: input.name ?? 'Tomato box',
    options: input.options ?? [{ key: 'Size', value: 'Large' }],
    productId: input.productId ?? 101,
    quantity: input.quantity ?? 2,
    sku: input.sku ?? 'TOMATO-L',
    variationId: input.variationId ?? 0
  };
}

function routePlanOrder(input: { gid: string; name: string }): RoutePlanOrderInput {
  return {
    attributes: [{ key: 'Delivery Area', value: 'Mississauga' }],
    currencyCode: 'CAD',
    deliveryArea: 'Mississauga',
    deliveryDay: 'Thursday',
    email: 'customer@example.com',
    financialStatus: 'PENDING',
    fulfillmentStatus: 'UNFULFILLED',
    latitude: 43.589,
    longitude: -79.644,
    name: input.name,
    phone: '+14165550000',
    processedAt: new Date('2026-05-07T12:00:00.000Z'),
    rawPayload: {},
    recipientName: 'Noah Yoon',
    shippingAddress: {
      address1: '300 City Centre Dr',
      address2: '#08',
      city: 'Mississauga',
      countryCode: 'CA',
      postalCode: 'L5B 3C1',
      province: 'ON'
    },
    shopifyOrderGid: input.gid,
    totalPriceAmount: '95.00'
  };
}
