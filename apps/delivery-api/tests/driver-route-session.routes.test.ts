import { describe, expect, test, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import { DriverRouteSessionScopeError } from '../src/modules/driver/driver-route-session.types.js';
import type { DriverApiDependencies } from '../src/routes/driver-events.routes.js';
import { signDriverRouteToken } from '../src/modules/driver/driver-token-verifier.js';

const secret = 'driver-secret';
const now = new Date('2026-06-15T12:20:00.000Z');

const activeSession = {
  status: 'ACTIVE_SESSION' as const,
  route: {
    deliveryDate: '2026-06-15',
    etaSnapshot: {
      calculatedAt: null,
      failureCode: null,
      failureMessage: null,
      nextStopEta: null,
      pickupCompletedAt: null,
      remainingRouteEta: null,
      status: 'PRE_PICKUP' as const
    },
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
        routePlanId: 'route-plan-id',
        shopDomain: 'example.myshopify.com',
        shopId: 'shop-id'
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
        shopDomain: 'example.myshopify.com',
        shopId: 'shop-id'
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
      driverTokenAccessRepository: {
        isDriverAccessTokenActive: vi.fn(() => Promise.resolve(false)),
        isDriverAccountAccessTokenActive: vi.fn(() => Promise.resolve(true)),
        resolveDriverRouteAccess: vi.fn(() => Promise.resolve({
          accountId: 'account-id',
          driverId: 'driver-id',
          routePlanId: 'route-plan-id',
          shopDomain: 'example.myshopify.com',
          shopId: 'shop-id'
        }))
      },
      ...(input.driverRouteMapPreviewBaseUrl === undefined ? {} : { driverRouteMapPreviewBaseUrl: input.driverRouteMapPreviewBaseUrl }),
      ...(input.driverRouteMapPreviewService === undefined ? {} : { driverRouteMapPreviewService: input.driverRouteMapPreviewService }),
      jwtSecret: secret,
      now: () => now
    }
  });

  return { app, getActiveRouteSession };
}

function driverToken(): string {
  return signDriverRouteToken({
    accountId: 'account-id',
    expiresInSeconds: 60,
    routePlanId: 'route-plan-id',
    subject: 'driver-account:account-id',
    tokenVersion: 0
  }, { now, secret }).token;
}
