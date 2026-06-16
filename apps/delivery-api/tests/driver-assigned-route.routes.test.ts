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
    routeGeometry: null,
    routeMapPreview: null,
    routeMetrics: null,
    routeStopPoints: [],
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
        items: [],
        normalizedPaymentStatus: 'TRANSFER_CHECK_PENDING' as const,
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
      expect(response.headers['cache-control']).toBe('private, no-store');
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

  test('attaches a signed route map preview when the preview service can create one', async () => {
    const routeMapPreview = {
      altText: 'Static route preview for 1 stops.',
      contentType: 'image/png' as const,
      expiresAt: '2026-05-12T06:50:00.000Z',
      generatedAt: '2026-05-12T06:40:00.000Z',
      height: 430,
      imageUrl: 'https://delivery.example.com/driver/route-map-preview/static?previewId=opaque&expires=1&signature=redacted',
      kind: 'static_route_map' as const,
      routeSequenceChecksum: 'checksum',
      width: 720
    };
    const createRouteMapPreview = vi.fn(() => routeMapPreview);
    const { app } = await createAppHarness({
      driverRouteMapPreviewBaseUrl: 'https://delivery.example.com',
      driverRouteMapPreviewService: {
        createRouteMapPreview,
        readRouteMapPreviewImage: vi.fn()
      }
    });

    try {
      const response = await app.inject({
        headers: {
          authorization: `Bearer ${driverToken()}`,
          host: 'attacker.example.com',
          'x-forwarded-host': 'attacker.example.com',
          'x-forwarded-proto': 'https'
        },
        method: 'GET',
        url: '/driver/assigned-route?routeContext=route-plan-id'
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        data: { route: { routeMapPreview } }
      });
      expect(createRouteMapPreview).toHaveBeenCalledWith({
        baseUrl: 'https://delivery.example.com',
        driverId: 'driver-id',
        route: assignedRoute.route,
        shopDomain: 'example.myshopify.com'
      });
    } finally {
      await app.close();
    }
  });

  test('serves signed route map preview images with private no-store headers', async () => {
    const image = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const readRouteMapPreviewImage = vi.fn(() => Promise.resolve(image));
    const { app } = await createAppHarness({
      driverRouteMapPreviewService: {
        createRouteMapPreview: vi.fn(() => null),
        readRouteMapPreviewImage
      }
    });

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/driver/route-map-preview/static?previewId=opaque-preview-id&expires=1781140000000&signature=sig'
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('image/png');
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.rawPayload).toEqual(image);
      expect(readRouteMapPreviewImage).toHaveBeenCalledWith({
        expires: '1781140000000',
        previewId: 'opaque-preview-id',
        signature: 'sig'
      });
    } finally {
      await app.close();
    }
  });

  test('rejects unavailable or malformed route map preview image requests', async () => {
    const { app } = await createAppHarness({
      driverRouteMapPreviewService: {
        createRouteMapPreview: vi.fn(() => null),
        readRouteMapPreviewImage: vi.fn(() => Promise.resolve(null))
      }
    });

    try {
      const missingQuery = await app.inject({
        method: 'GET',
        url: '/driver/route-map-preview/static?previewId=opaque-preview-id&expires=1781140000000'
      });
      expect(missingQuery.statusCode).toBe(400);

      const unavailable = await app.inject({
        method: 'GET',
        url: '/driver/route-map-preview/static?previewId=opaque-preview-id&expires=1781140000000&signature=sig'
      });
      expect(unavailable.statusCode).toBe(404);
      expect(unavailable.json()).toEqual({
        data: null,
        error: { code: 'NOT_FOUND', message: 'Route map preview unavailable' }
      });
    } finally {
      await app.close();
    }
  });
});

async function createAppHarness(input: {
  driverRouteMapPreviewBaseUrl?: string;
  driverRouteMapPreviewService?: NonNullable<NonNullable<Parameters<typeof buildApp>[0]>['driverApi']>['driverRouteMapPreviewService'];
  empty?: boolean;
} = {}) {
  const getAssignedRoute = vi.fn(() =>
    Promise.resolve(input.empty === true ? { status: 'NO_ASSIGNED_ROUTE' as const } : assignedRoute)
  );
  const app = await buildApp({
    driverApi: {
      driverAssignedRouteService: { getAssignedRoute },
      ...(input.driverRouteMapPreviewBaseUrl === undefined ? {} : { driverRouteMapPreviewBaseUrl: input.driverRouteMapPreviewBaseUrl }),
      ...(input.driverRouteMapPreviewService === undefined ? {} : { driverRouteMapPreviewService: input.driverRouteMapPreviewService }),
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
