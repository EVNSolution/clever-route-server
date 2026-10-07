import { describe, expect, test, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import type { DriverApiDependencies } from '../src/routes/driver-events.routes.js';
import {
  DriverDestinationCompletionCollisionError,
  DriverEventStopTransitionConflictError,
} from '../src/modules/driver/driver-event.repository.js';
import { signDriverAccountToken, signDriverRouteToken } from '../src/modules/driver/driver-token-verifier.js';

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
        completionOwnerAccountId: 'account-id',
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
      expect(response.json<{ error: { completionOutcome: string } }>().error.completionOutcome).toBe('NOT_APPLIED');
      expect(completeDeliveryDestination).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('marks route authentication rejection as not applied', async () => {
    const app = await buildApp({ driverApi: dependenciesWith(vi.fn<CompleteDeliveryDestination>()) });
    try {
      const response = await app.inject({
        method: 'POST',
        payload: completionRequest(),
        url: '/driver/destinations/complete',
      });
      expect(response.statusCode).toBe(401);
      expect(response.json<{ error: { completionOutcome: string } }>().error.completionOutcome).toBe('NOT_APPLIED');
    } finally {
      await app.close();
    }
  });

  test('marks unavailable completion handling as not applied', async () => {
    const dependencies = dependenciesWith(vi.fn<CompleteDeliveryDestination>());
    delete dependencies.driverEventService.completeDeliveryDestination;
    const app = await buildApp({ driverApi: dependencies });
    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${driverToken()}` },
        method: 'POST',
        payload: completionRequest(),
        url: '/driver/destinations/complete',
      });
      expect(response.statusCode).toBe(503);
      expect(response.json<{ error: { completionOutcome: string } }>().error.completionOutcome).toBe('NOT_APPLIED');
    } finally {
      await app.close();
    }
  });

  test('marks a route mismatch as not applied', async () => {
    const completeDeliveryDestination = vi.fn<CompleteDeliveryDestination>();
    const app = await buildApp({ driverApi: dependenciesWith(completeDeliveryDestination) });
    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${driverToken()}` },
        method: 'POST',
        payload: { ...completionRequest(), routePlanId: 'other-route' },
        url: '/driver/destinations/complete',
      });
      expect(response.statusCode).toBe(403);
      expect(response.json<{ error: { completionOutcome: string } }>().error.completionOutcome).toBe('NOT_APPLIED');
      expect(completeDeliveryDestination).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('does not mark a post-commit progress failure as not applied', async () => {
    const completeDeliveryDestination = vi.fn<CompleteDeliveryDestination>().mockResolvedValue([
      { duplicate: false, eventId: 'event-1' },
      { duplicate: false, eventId: 'event-2' },
    ]);
    const dependencies = dependenciesWith(completeDeliveryDestination);
    dependencies.routeTrackingStreamHub = {
      publishProgress: vi.fn(() => { throw new DriverEventStopTransitionConflictError(); }),
    } as never;
    const app = await buildApp({ driverApi: dependencies });
    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${driverToken()}` },
        method: 'POST',
        payload: completionRequest(),
        url: '/driver/destinations/complete',
      });
      expect(response.statusCode).toBe(409);
      expect(response.json<{ error: { completionOutcome?: string } }>().error.completionOutcome).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  test('returns an untagged conflict for a completion fingerprint collision', async () => {
    const completeDeliveryDestination = vi.fn<CompleteDeliveryDestination>()
      .mockRejectedValue(new DriverDestinationCompletionCollisionError());
    const app = await buildApp({ driverApi: dependenciesWith(completeDeliveryDestination) });
    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${driverToken()}` },
        method: 'POST',
        payload: completionRequest(),
        url: '/driver/destinations/complete',
      });
      expect(response.statusCode).toBe(409);
      expect(response.json<{ error: { code: string; completionOutcome?: string } }>().error).toEqual({
        code: 'DESTINATION_COMPLETION_COLLISION',
        message: 'Destination completion conflicts with existing evidence',
      });
    } finally {
      await app.close();
    }
  });

  test('recovers an applied completion with an active account token', async () => {
    const dependencies = dependenciesWith(vi.fn<CompleteDeliveryDestination>());
    dependencies.driverEventReceiptService = {
      lookup: vi.fn(),
      lookupDestinationCompletion: vi.fn().mockResolvedValue({
        clientEventId: 'destination-1:delivered:1',
        completedStopCount: 2,
        deliveryStopIds: ['stop-1', 'stop-2'],
        destinationId: 'destination-1',
        eventIds: ['event-1', 'event-2'],
        occurredAt: '2026-08-05T02:59:00.000Z',
        routePlanId: 'route-plan-id',
        status: 'APPLIED',
      }),
    };
    const app = await buildApp({ driverApi: dependencies });
    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${accountToken()}` },
        method: 'POST',
        payload: completionRequest(),
        url: '/driver/destinations/complete/result',
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.json<{ data: { status: string } }>().data.status).toBe('APPLIED');
      expect(dependencies.driverEventReceiptService.lookupDestinationCompletion).toHaveBeenCalledWith({
        accountId: 'account-id',
        clientEventId: 'destination-1:delivered:1',
        deliveryStopIds: ['stop-1', 'stop-2'],
        destinationId: 'destination-1',
        occurredAt: new Date('2026-08-05T02:59:00.000Z'),
        routePlanId: 'route-plan-id',
      });
    } finally {
      await app.close();
    }
  });

  test.each([
    ['route token', driverToken(), true],
    ['inactive account token', accountToken(), false],
  ])('rejects a %s for result recovery', async (_label, token, active) => {
    const dependencies = dependenciesWith(vi.fn<CompleteDeliveryDestination>());
    dependencies.driverTokenAccessRepository!.isDriverAccountAccessTokenActive = vi.fn().mockResolvedValue(active);
    dependencies.driverEventReceiptService = {
      lookup: vi.fn(),
      lookupDestinationCompletion: vi.fn(),
    };
    const app = await buildApp({ driverApi: dependencies });
    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${token}` },
        method: 'POST',
        payload: completionRequest(),
        url: '/driver/destinations/complete/result',
      });
      expect(response.statusCode).toBe(401);
      expect(dependencies.driverEventReceiptService.lookupDestinationCompletion).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('fails closed when result recovery has no active-token repository', async () => {
    const dependencies = dependenciesWith(vi.fn<CompleteDeliveryDestination>());
    delete dependencies.driverTokenAccessRepository;
    dependencies.driverEventReceiptService = {
      lookup: vi.fn(),
      lookupDestinationCompletion: vi.fn(),
    };
    const app = await buildApp({ driverApi: dependencies });
    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${accountToken()}` },
        method: 'POST',
        payload: completionRequest(),
        url: '/driver/destinations/complete/result',
      });
      expect(response.statusCode).toBe(401);
      expect(dependencies.driverEventReceiptService.lookupDestinationCompletion).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

function completionRequest(): Record<string, unknown> {
  return {
    clientEventId: 'destination-1:delivered:1',
    deliveryStopIds: ['stop-1', 'stop-2'],
    destinationId: 'destination-1',
    occurredAt: '2026-08-05T02:59:00.000Z',
    routePlanId: 'route-plan-id',
  };
}

function dependenciesWith(
  completeDeliveryDestination: ReturnType<typeof vi.fn<CompleteDeliveryDestination>>,
): DriverApiDependencies {
  return {
    driverEventService: {
      admitDriverEventAttempt: vi.fn(() => Promise.resolve({ attemptId: 'attempt-id', attemptNumber: 1 })),
      completeDeliveryDestination,
      finalizeDriverEventAttempt: vi.fn(() => Promise.resolve()),
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

function accountToken(): string {
  return signDriverAccountToken({
    accountId: 'account-id',
    expiresInSeconds: 60,
    subject: 'driver-account:account-id',
    tokenVersion: 0,
  }, { now, secret }).token;
}
