import { describe, expect, test, vi } from 'vitest';

import { PrismaRoutePlanRepository } from '../src/modules/route-plans/route-plan.repository.js';
import {
  RoutePlanDriverAssignInvalidError,
  RoutePlanOrderAlreadyPlannedError,
  RoutePlanStopUpdateInvalidError
} from '../src/modules/route-plans/route-plan.types.js';
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
      include: { deliveryStops: { take: 1 } },
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
    expect(prisma.routePlanStop.deleteMany).toHaveBeenCalledWith({
      where: { routePlanId: 'route-plan-id' }
    });
    expect(prisma.routePlan.delete).toHaveBeenCalledWith({
      where: { id: 'route-plan-id' }
    });
    expect(prisma.routePlan.delete).toHaveBeenCalledTimes(1);
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

function createPrismaHarness(input: {
  deliveryStopForId?: { id: string } | null;
  driverForAssignment?: { id: string } | null;
  existingRoutePlanStops?: Array<{ deliveryStopId: string }>;
  orderDeliveryDate?: string;
  orders?: Array<Record<string, unknown>>;
  routePlanToDelete?: { id: string } | null;
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
    routePlan: {
      create: ReturnType<typeof vi.fn>;
      findFirst: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
      delete: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
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
    routePlanStop: {
      createMany: routePlanStopCreateMany,
      findMany: vi.fn(() => Promise.resolve(input.existingRoutePlanStops ?? [])),
      deleteMany: vi.fn(() => Promise.resolve({ count: 2 }))
    },
    shop: {
      findUnique: vi.fn(() => Promise.resolve({ id: 'shop-id' })),
      upsert: vi.fn(() => Promise.resolve({ id: 'shop-id', shopDomain: 'example.myshopify.com' }))
    }
  };

  return { prisma, routePlanStopCreateMany };
}


function orderRecord(input: { deliveryDate: string; gid: string; id: string; stopId: string }): Record<string, unknown> {
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
