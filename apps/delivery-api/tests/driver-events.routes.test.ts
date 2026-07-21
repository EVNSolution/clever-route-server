import { describe, expect, test, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import {
  DriverEventContextError,
  DriverEventExecutionConflictError,
  DriverEventRouteNotInProgressError
} from '../src/modules/driver/driver-event.repository.js';
import type { DriverApiDependencies } from '../src/routes/driver-events.routes.js';
import { signDriverRouteToken } from '../src/modules/driver/driver-token-verifier.js';

const secret = 'driver-secret';
const now = new Date('2026-05-07T06:10:00Z');

describe('Driver events route', () => {
  test('rejects event requests without a driver bearer token', async () => {
    const { dependencies, recordDriverEvent } = createDependencyHarness();
    const app = await buildApp({ driverApi: dependencies });

    try {
      const response = await app.inject({
        method: 'POST',
        payload: eventPayload(),
        url: '/driver/events'
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        data: null,
        error: { code: 'UNAUTHORIZED', message: 'Missing driver bearer token' }
      });
      expect(recordDriverEvent).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('records a valid driver event with authenticated driver context', async () => {
    const { dependencies, recordDriverEvent } = createDependencyHarness();
    const app = await buildApp({ driverApi: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${driverToken()}` },
        method: 'POST',
        payload: eventPayload(),
        url: '/driver/events'
      });

      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({
        data: {
          duplicate: false,
          eventId: 'driver-event-id'
        },
        error: null
      });
      expect(recordDriverEvent).toHaveBeenCalledWith({
        clientEventId: 'mobile-event-1',
        deliveryStopId: 'stop-id',
        driverId: 'driver-id',
        eventType: 'LOCATION_UPDATED',
        latitude: '40.7128',
        longitude: '-74.006',
        occurredAt: new Date('2026-05-07T06:09:30.000Z'),
        payload: eventPayload(),
        routePlanId: 'route-plan-id',
        shopDomain: 'example.myshopify.com',
        shopId: 'shop-id'
      });
    } finally {
      await app.close();
    }
  });

  test('publishes a v1 route tracking position after a nonduplicate location update is committed', async () => {
    const publishPosition = vi.fn();
    const { dependencies } = createDependencyHarness();
    dependencies.routeTrackingStreamHub = { publishPosition } as never;
    const app = await buildApp({ driverApi: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${driverToken()}` },
        method: 'POST',
        payload: eventPayload(),
        url: '/driver/events'
      });

      expect(response.statusCode).toBe(202);
      expect(publishPosition).toHaveBeenCalledWith({
        driverId: 'driver-id',
        eventId: 'driver-event-id',
        latitude: 40.7128,
        longitude: -74.006,
        occurredAt: '2026-05-07T06:09:30.000Z',
        receivedAt: '2026-05-07T06:10:00.000Z',
        routePlanId: 'route-plan-id',
        schemaVersion: 'route_tracking.v1'
      });
    } finally {
      await app.close();
    }
  });

  test('publishes route progress after a nonduplicate driver stage event is committed', async () => {
    const publishProgress = vi.fn();
    const { dependencies } = createDependencyHarness();
    dependencies.routeTrackingStreamHub = { publishProgress } as never;
    const app = await buildApp({ driverApi: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${driverToken()}` },
        method: 'POST',
        payload: {
          clientEventId: 'stop-arrived-1',
          deliveryStopId: 'stop-id',
          eventType: 'STOP_ARRIVED',
          occurredAt: '2026-05-07T06:09:30.000Z',
          routePlanId: 'route-plan-id'
        },
        url: '/driver/events'
      });

      expect(response.statusCode).toBe(202);
      expect(publishProgress).toHaveBeenCalledWith({
        deliveryStopId: 'stop-id',
        driverId: 'driver-id',
        eventId: 'driver-event-id',
        eventType: 'STOP_ARRIVED',
        occurredAt: '2026-05-07T06:09:30.000Z',
        receivedAt: '2026-05-07T06:10:00.000Z',
        routePlanId: 'route-plan-id',
        schemaVersion: 'route_tracking.v1'
      });
    } finally {
      await app.close();
    }
  });

  test('creates a durable administrator alert when the server detects an out-of-order stop', async () => {
    const { dependencies, recordDriverEvent } = createDependencyHarness();
    const createAdminNotification = vi.fn(() => Promise.resolve({
      createdCount: 1,
      dedupedCount: 0,
      notifications: []
    }));
    dependencies.adminNotificationService = { createAdminNotification };
    recordDriverEvent.mockResolvedValueOnce({
      duplicate: false,
      eventId: 'driver-event-id',
      sequenceDeviation: {
        expectedDeliveryStopId: 'stop-1',
        expectedSequence: 1,
        selectedDeliveryStopId: 'stop-2',
        selectedSequence: 2
      }
    });
    const app = await buildApp({ driverApi: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${driverToken()}` },
        method: 'POST',
        payload: {
          clientEventId: 'stop-arrived-2',
          deliveryStopId: 'stop-2',
          eventType: 'STOP_ARRIVED',
          occurredAt: '2026-05-07T06:09:30.000Z',
          routePlanId: 'route-plan-id'
        },
        url: '/driver/events'
      });

      expect(response.statusCode).toBe(202);
      expect(createAdminNotification).toHaveBeenCalledWith({
        createdAt: now,
        driverId: 'driver-id',
        eventId: 'driver-event-id',
        eventType: 'STOP_ARRIVED',
        expectedDeliveryStopId: 'stop-1',
        expectedSequence: 1,
        occurredAt: new Date('2026-05-07T06:09:30.000Z'),
        routePlanId: 'route-plan-id',
        selectedDeliveryStopId: 'stop-2',
        selectedSequence: 2,
        shopId: 'shop-id',
        type: 'driver.stop_sequence_deviated'
      });
    } finally {
      await app.close();
    }
  });

  test('accepts the driver event when the administrator alert cannot be created', async () => {
    const { dependencies, recordDriverEvent } = createDependencyHarness();
    dependencies.adminNotificationService = {
      createAdminNotification: vi.fn(() => Promise.reject(new Error('notification store unavailable')))
    };
    recordDriverEvent.mockResolvedValueOnce({
      duplicate: false,
      eventId: 'driver-event-id',
      sequenceDeviation: {
        expectedDeliveryStopId: 'stop-1',
        expectedSequence: 1,
        selectedDeliveryStopId: 'stop-2',
        selectedSequence: 2
      }
    });
    const app = await buildApp({ driverApi: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${driverToken()}` },
        method: 'POST',
        payload: {
          clientEventId: 'stop-arrived-2',
          deliveryStopId: 'stop-2',
          eventType: 'STOP_ARRIVED',
          occurredAt: '2026-05-07T06:09:30.000Z',
          routePlanId: 'route-plan-id'
        },
        url: '/driver/events'
      });

      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({
        data: { duplicate: false, eventId: 'driver-event-id' },
        error: null
      });
    } finally {
      await app.close();
    }
  });

  test('rejects driver event tokens invalidated by a relogin token-version cutoff', async () => {
    const { dependencies, resolveDriverRouteAccess, recordDriverEvent } = createDependencyHarness({
      accessTokenActive: false
    });
    const app = await buildApp({ driverApi: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${driverToken({ tokenVersion: 1 })}` },
        method: 'POST',
        payload: eventPayload(),
        url: '/driver/events'
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        data: null,
        error: { code: 'DRIVER_ACCESS_TOKEN_INVALID', message: 'Invalid driver access token' }
      });
      expect(resolveDriverRouteAccess).toHaveBeenCalledWith({
        accountId: 'account-id',
        routePlanId: 'route-plan-id',
        tokenVersion: 1
      });
      expect(recordDriverEvent).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('reports duplicate client event ids idempotently', async () => {
    const { dependencies, recordDriverEvent } = createDependencyHarness();
    recordDriverEvent.mockResolvedValueOnce({ duplicate: true, eventId: 'driver-event-id' });
    const app = await buildApp({ driverApi: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${driverToken()}` },
        method: 'POST',
        payload: eventPayload(),
        url: '/driver/events'
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        data: {
          duplicate: true,
          eventId: 'driver-event-id'
        },
        error: null
      });
    } finally {
      await app.close();
    }
  });

  test('authenticates a completed assignment only for an idempotent completion retry', async () => {
    const { dependencies, recordDriverEvent, resolveDriverRouteAccess } = createDependencyHarness();
    recordDriverEvent.mockResolvedValueOnce({ duplicate: true, eventId: 'recorded-completion-id' });
    const app = await buildApp({ driverApi: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${driverToken()}` },
        method: 'POST',
        payload: {
          clientEventId: 'route-completed-client-id',
          deliveryStopId: null,
          eventType: 'ROUTE_COMPLETED',
          occurredAt: '2026-05-07T06:09:30.000Z',
          routePlanId: 'route-plan-id'
        },
        url: '/driver/events'
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        data: { duplicate: true, eventId: 'recorded-completion-id' },
        error: null
      });
      expect(resolveDriverRouteAccess).toHaveBeenCalledWith({
        accountId: 'account-id',
        routePlanId: 'route-plan-id',
        tokenVersion: 0
      }, { allowCompleted: true });
    } finally {
      await app.close();
    }
  });

  test('maps missing terminal route/stop context to a deterministic bad request response', async () => {
    const { dependencies, recordDriverEvent } = createDependencyHarness();
    recordDriverEvent.mockRejectedValueOnce(new DriverEventContextError('missing routePlanId'));
    const app = await buildApp({ driverApi: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${driverToken()}` },
        method: 'POST',
        payload: {
          clientEventId: 'mobile-event-2',
          deliveryStopId: null,
          eventType: 'STOP_DELIVERED',
          occurredAt: '2026-05-07T06:09:30.000Z',
          routePlanId: null
        },
        url: '/driver/events'
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        data: null,
        error: { code: 'BAD_REQUEST', message: 'Invalid driver event route or stop context' }
      });
    } finally {
      await app.close();
    }
  });

  test('maps location updates outside in-progress routes to a deterministic conflict response', async () => {
    const { dependencies, recordDriverEvent } = createDependencyHarness();
    recordDriverEvent.mockRejectedValueOnce(new DriverEventRouteNotInProgressError('route is not in progress'));
    const app = await buildApp({ driverApi: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${driverToken()}` },
        method: 'POST',
        payload: eventPayload(),
        url: '/driver/events'
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        data: null,
        error: { code: 'ROUTE_NOT_IN_PROGRESS', message: 'Route is not in progress' }
      });
    } finally {
      await app.close();
    }
  });

  test('maps overlapping active route ownership to a deterministic conflict response', async () => {
    const { dependencies, recordDriverEvent } = createDependencyHarness();
    recordDriverEvent.mockRejectedValueOnce(new DriverEventExecutionConflictError(
      'other-route-plan-id',
      'stop-id'
    ));
    const app = await buildApp({ driverApi: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${driverToken()}` },
        method: 'POST',
        payload: { ...eventPayload(), deliveryStopId: null, eventType: 'ROUTE_STARTED' },
        url: '/driver/events'
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        data: null,
        error: { code: 'ROUTE_EXECUTION_CONFLICT', message: 'An overlapping route is already in progress' }
      });
    } finally {
      await app.close();
    }
  });

  test('maps terminal route/stop ownership mismatch to a deterministic forbidden response', async () => {
    const { dependencies, recordDriverEvent } = createDependencyHarness();
    const app = await buildApp({ driverApi: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${driverToken()}` },
        method: 'POST',
        payload: {
          clientEventId: 'mobile-event-3',
          deliveryStopId: 'foreign-stop-id',
          eventType: 'STOP_DELIVERED',
          occurredAt: '2026-05-07T06:09:30.000Z',
          routePlanId: 'foreign-route-plan-id'
        },
        url: '/driver/events'
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        data: null,
        error: { code: 'ROUTE_ASSIGNMENT_ACCOUNT_MISMATCH', message: 'Driver route assignment rejected' }
      });
      expect(recordDriverEvent).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('maps invalid route completion ownership to a deterministic forbidden response', async () => {
    const { dependencies, recordDriverEvent } = createDependencyHarness();
    const app = await buildApp({ driverApi: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${driverToken()}` },
        method: 'POST',
        payload: {
          clientEventId: 'mobile-event-4',
          deliveryStopId: null,
          eventType: 'ROUTE_COMPLETED',
          occurredAt: '2026-05-07T06:09:30.000Z',
          routePlanId: 'foreign-route-plan-id'
        },
        url: '/driver/events'
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        data: null,
        error: { code: 'ROUTE_ASSIGNMENT_ACCOUNT_MISMATCH', message: 'Driver route assignment rejected' }
      });
      expect(recordDriverEvent).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

function createDependencyHarness(input: { accessTokenActive?: boolean } = {}): {
  dependencies: DriverApiDependencies;
  resolveDriverRouteAccess: ReturnType<
    typeof vi.fn<
      NonNullable<DriverApiDependencies['driverTokenAccessRepository']>['resolveDriverRouteAccess']
    >
  >;
  recordDriverEvent: ReturnType<typeof vi.fn<DriverApiDependencies['driverEventService']['recordDriverEvent']>>;
} {
  const recordDriverEvent = vi.fn<DriverApiDependencies['driverEventService']['recordDriverEvent']>(() =>
    Promise.resolve({ duplicate: false, eventId: 'driver-event-id' })
  );
  const resolveDriverRouteAccess = vi.fn<
    NonNullable<DriverApiDependencies['driverTokenAccessRepository']>['resolveDriverRouteAccess']
  >(() => Promise.resolve(input.accessTokenActive === false ? null : {
    accountId: 'account-id',
    driverId: 'driver-id',
    routePlanId: 'route-plan-id',
    shopDomain: 'example.myshopify.com',
    shopId: 'shop-id'
  }));

  return {
    dependencies: {
      driverEventService: {
        recordDriverEvent
      },
      driverTokenAccessRepository: {
        isDriverAccountAccessTokenActive: vi.fn(() => Promise.resolve(true)),
        isDriverAccessTokenActive: vi.fn(() => Promise.resolve(false)),
        resolveDriverRouteAccess
      },
      jwtSecret: secret,
      now: () => now
    },
    resolveDriverRouteAccess,
    recordDriverEvent
  };
}

function eventPayload(): Record<string, unknown> {
  return {
    clientEventId: 'mobile-event-1',
    deliveryStopId: 'stop-id',
    eventType: 'LOCATION_UPDATED',
    latitude: 40.7128,
    longitude: -74.006,
    occurredAt: '2026-05-07T06:09:30.000Z',
    routePlanId: 'route-plan-id'
  };
}

function driverToken(input: { tokenVersion?: number } = {}): string {
  return signDriverRouteToken({
    accountId: 'account-id',
    expiresInSeconds: 60,
    routePlanId: 'route-plan-id',
    subject: 'driver-account:account-id',
    tokenVersion: input.tokenVersion ?? 0
  }, { now, secret }).token;
}
