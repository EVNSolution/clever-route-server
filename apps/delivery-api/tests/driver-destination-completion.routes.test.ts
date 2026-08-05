import { describe, expect, test, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import type { DriverApiDependencies } from '../src/routes/driver-events.routes.js';
import { signDriverRouteToken } from '../src/modules/driver/driver-token-verifier.js';

const now = new Date('2026-08-05T03:00:00.000Z');
const secret = 'driver-secret';
type CompleteDeliveryDestination = NonNullable<
  DriverApiDependencies['driverEventService']['completeDeliveryDestination']
>;

describe('Driver destination completion route', () => {
  test('completes all order stops at one destination in a single request', async () => {
    const completeDeliveryDestination = vi.fn<CompleteDeliveryDestination>().mockResolvedValue([
      { duplicate: false, eventId: 'event-1' },
      { duplicate: false, eventId: 'event-2' },
    ]);
    const dependencies = dependenciesWith(completeDeliveryDestination);
    const app = await buildApp({ driverApi: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${driverToken()}` },
        method: 'POST',
        payload: {
          clientEventId: 'destination-1:delivered:1',
          deliveryStopIds: ['stop-1', 'stop-2'],
          destinationId: 'destination-1',
          occurredAt: '2026-08-05T02:59:00.000Z',
          routePlanId: 'route-plan-id',
        },
        url: '/driver/destinations/complete',
      });

      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({
        data: { completedStopCount: 2, eventIds: ['event-1', 'event-2'] },
        error: null,
      });
      expect(completeDeliveryDestination).toHaveBeenCalledWith(expect.objectContaining({
        deliveryStopIds: ['stop-1', 'stop-2'],
        destinationId: 'destination-1',
        driverId: 'driver-id',
        routePlanId: 'route-plan-id',
        shopId: 'shop-id',
      }));
    } finally {
      await app.close();
    }
  });

  test('rejects duplicate stop IDs before recording events', async () => {
    const completeDeliveryDestination = vi.fn<CompleteDeliveryDestination>();
    const app = await buildApp({ driverApi: dependenciesWith(completeDeliveryDestination) });
    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${driverToken()}` },
        method: 'POST',
        payload: {
          clientEventId: 'destination-1:delivered:1',
          deliveryStopIds: ['stop-1', 'stop-1'],
          destinationId: 'destination-1',
          occurredAt: '2026-08-05T02:59:00.000Z',
          routePlanId: 'route-plan-id',
        },
        url: '/driver/destinations/complete',
      });
      expect(response.statusCode).toBe(400);
      expect(completeDeliveryDestination).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

function dependenciesWith(
  completeDeliveryDestination: ReturnType<typeof vi.fn<CompleteDeliveryDestination>>,
): DriverApiDependencies {
  return {
    driverEventService: {
      completeDeliveryDestination,
      recordDriverEvent: vi.fn(),
    },
    driverTokenAccessRepository: {
      isDriverAccountAccessTokenActive: vi.fn(() => Promise.resolve(true)),
      isDriverAccessTokenActive: vi.fn(() => Promise.resolve(false)),
      resolveDriverRouteAccess: vi.fn(() => Promise.resolve({
        accountId: 'account-id',
        driverId: 'driver-id',
        routePlanId: 'route-plan-id',
        shopDomain: 'example.myshopify.com',
        shopId: 'shop-id',
      })),
    },
    jwtSecret: secret,
    now: () => now,
  };
}

function driverToken(): string {
  return signDriverRouteToken({
    accountId: 'account-id',
    expiresInSeconds: 60,
    routePlanId: 'route-plan-id',
    subject: 'driver-account:account-id',
    tokenVersion: 0,
  }, { now, secret }).token;
}
