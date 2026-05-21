import { createHmac } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';

import { buildApp } from '../src/app.js';

const secret = 'driver-secret';
const now = new Date('2026-05-12T06:40:00.000Z');

const assignedRoute = {
  status: 'ASSIGNED_ROUTE' as const,
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
};

describe('Driver assigned route route', () => {
  test('rejects assigned route reads without a driver bearer token', async () => {
    const { app, getAssignedRoute } = await createAppHarness();

    try {
      const response = await app.inject({ method: 'GET', url: '/driver/assigned-route?routeContext=route-plan-id' });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        data: null,
        error: { code: 'UNAUTHORIZED', message: 'Missing driver bearer token' }
      });
      expect(getAssignedRoute).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('rejects assigned route reads with an invalid driver bearer token', async () => {
    const { app, getAssignedRoute } = await createAppHarness();

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer invalid-token' },
        method: 'GET',
        url: '/driver/assigned-route?routeContext=route-plan-id'
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        data: null,
        error: { code: 'UNAUTHORIZED', message: 'Invalid driver bearer token' }
      });
      expect(getAssignedRoute).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('returns only the bearer driver assigned route and stop list', async () => {
    const { app, getAssignedRoute } = await createAppHarness();

    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${driverToken()}` },
        method: 'GET',
        url: '/driver/assigned-route?routeContext=route-plan-id'
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ data: assignedRoute, error: null });
      expect(getAssignedRoute).toHaveBeenCalledWith({
        driverId: 'driver-id',
        routeContext: 'route-plan-id',
        shopDomain: 'example.myshopify.com'
      });
      expect(JSON.stringify(response.json())).not.toContain('other-driver-id');
    } finally {
      await app.close();
    }
  });

  test('returns a safe empty status when no assigned route matches', async () => {
    const { app, getAssignedRoute } = await createAppHarness({ empty: true });

    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${driverToken()}` },
        method: 'GET',
        url: '/driver/assigned-route?routeContext=wrong-route'
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ data: { status: 'NO_ASSIGNED_ROUTE' }, error: null });
      expect(getAssignedRoute).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });
});

async function createAppHarness(input: { empty?: boolean } = {}) {
  const getAssignedRoute = vi.fn(() =>
    Promise.resolve(input.empty === true ? { status: 'NO_ASSIGNED_ROUTE' as const } : assignedRoute)
  );
  const app = await buildApp({
    driverApi: {
      driverAssignedRouteService: { getAssignedRoute },
      driverEventService: {
        recordDriverEvent: vi.fn(() => Promise.resolve({ duplicate: false, eventId: 'unused-event-id' }))
      },
      jwtSecret: secret,
      now: () => now
    }
  });

  return { app, getAssignedRoute };
}

function driverToken(): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    aud: 'clever-delivery-driver',
    driverId: 'driver-id',
    exp: Math.floor(now.getTime() / 1000) + 60,
    iat: Math.floor(now.getTime() / 1000),
    shopDomain: 'example.myshopify.com',
    sub: 'driver-auth-subject',
    tokenVersion: 0
  };
  const encodedHeader = Buffer.from(JSON.stringify(header), 'utf8').toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = createHmac('sha256', secret).update(signingInput).digest('base64url');

  return `${signingInput}.${signature}`;
}
