import { describe, expect, test, vi } from 'vitest';

import { PrismaDriverAssignedRouteRepository } from '../src/modules/driver/driver-assigned-route.repository.js';

const routePlanRecord = {
  constraints: {
    timezone: 'America/Toronto'
  },
  id: 'route-plan-id',
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
          name: '#1001',
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
    shopDomain: 'example.myshopify.com'
  },
  status: 'ASSIGNED'
};

describe('PrismaDriverAssignedRouteRepository', () => {
  test('returns the token driver assigned route with ordered stops', async () => {
    const { prisma } = createPrismaHarness();
    const repository = new PrismaDriverAssignedRouteRepository(prisma as never);

    const result = await repository.getAssignedRoute({
      driverId: 'driver-id',
      routeContext: 'route-plan-id',
      shopDomain: 'Example.myshopify.com'
    });

    expect(prisma.shop.findUnique).toHaveBeenCalledWith({ where: { shopDomain: 'example.myshopify.com' } });
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
        shopDomain: 'example.myshopify.com',
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
});

function createPrismaHarness(input: { driverShopId?: string } = {}) {
  return {
    prisma: {
      driver: {
        findUnique: vi.fn(() => Promise.resolve({ id: 'driver-id', shopId: input.driverShopId ?? 'shop-id' }))
      },
      routePlan: {
        findFirst: vi.fn((args: { where: { id?: string } }) =>
          Promise.resolve(args.where.id === 'wrong-route' ? null : routePlanRecord)
        )
      },
      shop: {
        findUnique: vi.fn(() => Promise.resolve({ id: 'shop-id' }))
      }
    }
  };
}
