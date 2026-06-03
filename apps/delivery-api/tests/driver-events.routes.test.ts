import { createHmac } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import {
  DriverEventContextError,
  DriverEventScopeError
} from '../src/modules/driver/driver-event.repository.js';
import type { DriverApiDependencies } from '../src/routes/driver-events.routes.js';

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
        shopDomain: 'example.myshopify.com'
      });
    } finally {
      await app.close();
    }
  });

  test('rejects driver event tokens invalidated by a relogin token-version cutoff', async () => {
    const { dependencies, isDriverAccessTokenActive, recordDriverEvent } = createDependencyHarness({
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
        error: { code: 'UNAUTHORIZED', message: 'Invalid driver bearer token' }
      });
      expect(isDriverAccessTokenActive).toHaveBeenCalledWith({
        driverId: 'driver-id',
        shopDomain: 'example.myshopify.com',
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

  test('maps terminal route/stop ownership mismatch to a deterministic forbidden response', async () => {
    const { dependencies, recordDriverEvent } = createDependencyHarness();
    recordDriverEvent.mockRejectedValueOnce(new DriverEventScopeError('foreign route'));
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
        error: { code: 'FORBIDDEN', message: 'Driver event route or stop scope rejected' }
      });
    } finally {
      await app.close();
    }
  });

  test('maps invalid route completion ownership to a deterministic forbidden response', async () => {
    const { dependencies, recordDriverEvent } = createDependencyHarness();
    recordDriverEvent.mockRejectedValueOnce(new DriverEventScopeError('foreign completed route'));
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
        error: { code: 'FORBIDDEN', message: 'Driver event route or stop scope rejected' }
      });
    } finally {
      await app.close();
    }
  });
});

function createDependencyHarness(input: { accessTokenActive?: boolean } = {}): {
  dependencies: DriverApiDependencies;
  isDriverAccessTokenActive: ReturnType<
    typeof vi.fn<
      NonNullable<DriverApiDependencies['driverTokenAccessRepository']>['isDriverAccessTokenActive']
    >
  >;
  recordDriverEvent: ReturnType<typeof vi.fn<DriverApiDependencies['driverEventService']['recordDriverEvent']>>;
} {
  const recordDriverEvent = vi.fn<DriverApiDependencies['driverEventService']['recordDriverEvent']>(() =>
    Promise.resolve({ duplicate: false, eventId: 'driver-event-id' })
  );
  const isDriverAccessTokenActive = vi.fn<
    NonNullable<DriverApiDependencies['driverTokenAccessRepository']>['isDriverAccessTokenActive']
  >(() => Promise.resolve(input.accessTokenActive ?? true));

  return {
    dependencies: {
      driverEventService: {
        recordDriverEvent
      },
      driverTokenAccessRepository: {
        isDriverAccessTokenActive
      },
      jwtSecret: secret,
      now: () => now
    },
    isDriverAccessTokenActive,
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
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    aud: 'clever-delivery-driver',
    driverId: 'driver-id',
    exp: Math.floor(now.getTime() / 1000) + 60,
    iat: Math.floor(now.getTime() / 1000),
    shopDomain: 'example.myshopify.com',
    sub: 'driver-auth-subject',
    tokenVersion: input.tokenVersion ?? 0
  };
  const encodedHeader = Buffer.from(JSON.stringify(header), 'utf8').toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = createHmac('sha256', secret).update(signingInput).digest('base64url');

  return `${signingInput}.${signature}`;
}
