import { createHmac } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import { DriverRouteSessionScopeError } from '../src/modules/driver/driver-route-session.types.js';
import type { DriverApiDependencies } from '../src/routes/driver-events.routes.js';

const secret = 'driver-secret';
const now = new Date('2026-06-15T12:20:00.000Z');

const activeSession = {
  status: 'ACTIVE_SESSION' as const,
  route: {
    deliveryDate: '2026-06-15',
    id: 'route-plan-id',
    name: 'Monday Route',
    routeGeometry: null,
    routeMapPreview: null,
    routeMetrics: null,
    routeStopPoints: [],
    shopDomain: 'example.myshopify.com',
    stops: [],
    timezone: 'America/Toronto'
  },
  session: {
    currentDeliveryStopId: 'stop-2',
    currentRoutePlanStopId: 'route-stop-2',
    lastEventId: 'route-started-event-id',
    lastResumedAt: null,
    navigationStepIndex: 2,
    routePlanId: 'route-plan-id',
    sessionId: null,
    source: 'BEST_EFFORT_ROUTE_STATE' as const,
    startedAt: '2026-06-15T12:00:00.000Z',
    status: 'ACTIVE' as const
  }
};

describe('Driver route session restore route', () => {
  test('rejects active session restore without a driver bearer token', async () => {
    const { app, getActiveRouteSession } = await createAppHarness();

    try {
      const response = await app.inject({ method: 'GET', url: '/driver/route-session/active' });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        data: null,
        error: { code: 'UNAUTHORIZED', message: 'Missing driver bearer token' }
      });
      expect(getActiveRouteSession).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('returns a token-scoped active session with no-store caching', async () => {
    const { app, getActiveRouteSession } = await createAppHarness();

    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${driverToken()}` },
        method: 'GET',
        url: '/driver/route-session/active'
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.json()).toEqual({ data: activeSession, error: null });
      expect(getActiveRouteSession).toHaveBeenCalledWith({
        driverId: 'driver-id',
        shopDomain: 'example.myshopify.com'
      });
    } finally {
      await app.close();
    }
  });

  test('returns no active session safely', async () => {
    const { app } = await createAppHarness({ noActiveSession: true });

    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${driverToken()}` },
        method: 'GET',
        url: '/driver/route-session/active'
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        data: { status: 'NO_ACTIVE_SESSION' },
        error: null
      });
    } finally {
      await app.close();
    }
  });

  test('maps restore scope errors to forbidden', async () => {
    const { app, getActiveRouteSession } = await createAppHarness();
    getActiveRouteSession.mockRejectedValueOnce(new DriverRouteSessionScopeError('foreign driver'));

    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${driverToken()}` },
        method: 'GET',
        url: '/driver/route-session/active'
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        data: null,
        error: { code: 'FORBIDDEN', message: 'Driver route session scope rejected' }
      });
    } finally {
      await app.close();
    }
  });

  test('attaches a signed route map preview when configured', async () => {
    const routeMapPreview = {
      altText: 'Static route preview for active route.',
      contentType: 'image/png' as const,
      expiresAt: '2026-06-15T12:30:00.000Z',
      generatedAt: '2026-06-15T12:20:00.000Z',
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
        headers: { authorization: `Bearer ${driverToken()}` },
        method: 'GET',
        url: '/driver/route-session/active'
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        data: { route: { routeMapPreview } }
      });
      expect(createRouteMapPreview).toHaveBeenCalledWith({
        baseUrl: 'https://delivery.example.com',
        driverId: 'driver-id',
        route: activeSession.route,
        shopDomain: 'example.myshopify.com'
      });
    } finally {
      await app.close();
    }
  });
});

async function createAppHarness(input: {
  driverRouteMapPreviewBaseUrl?: string;
  driverRouteMapPreviewService?: NonNullable<DriverApiDependencies['driverRouteMapPreviewService']>;
  noActiveSession?: boolean;
} = {}) {
  const getActiveRouteSession = vi.fn<
    NonNullable<DriverApiDependencies['driverRouteSessionRestoreService']>['getActiveRouteSession']
  >(() => Promise.resolve(input.noActiveSession === true ? { status: 'NO_ACTIVE_SESSION' } : activeSession));
  const app = await buildApp({
    driverApi: {
      driverEventService: {
        recordDriverEvent: vi.fn(() => Promise.resolve({ duplicate: false, eventId: 'unused-event-id' }))
      },
      driverRouteSessionRestoreService: { getActiveRouteSession },
      ...(input.driverRouteMapPreviewBaseUrl === undefined ? {} : { driverRouteMapPreviewBaseUrl: input.driverRouteMapPreviewBaseUrl }),
      ...(input.driverRouteMapPreviewService === undefined ? {} : { driverRouteMapPreviewService: input.driverRouteMapPreviewService }),
      jwtSecret: secret,
      now: () => now
    }
  });

  return { app, getActiveRouteSession };
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
