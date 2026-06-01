import { describe, expect, test, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import { verifyDriverToken } from '../src/modules/driver/driver-token-verifier.js';
import type { DriverApiDependencies } from '../src/routes/driver-events.routes.js';

type LookupRouteAccess = NonNullable<DriverApiDependencies['routeAccessService']>['lookupRouteAccess'];
type RecordDriverEvent = DriverApiDependencies['driverEventService']['recordDriverEvent'];

const now = new Date('2026-05-12T06:40:00.000Z');


type InvitedLookupResponseBody = {
  data: typeof invitedLookup & {
    driverAccess: {
      accessToken: string;
      expiresAt: string;
      tokenType: 'Bearer';
      ttlSeconds: number;
      use: 'consent_and_assigned_route';
    };
  };
  error: null;
};

const invitedLookup = {
  status: 'INVITED' as const,
  driverContext: {
    driverId: 'driver-id',
    shopDomain: 'tomatono.myshopify.com',
    tokenVersion: 4
  },
  routeAccess: {
    nextState: 'consent_required' as const,
    routeContext: 'route-plan-id',
    routePlanId: 'route-plan-id'
  },
  companyGuidance: {
    companyDisplayName: 'Tomatono Toronto',
    deliveryDate: '2026-05-12',
    driverInstructions: ['Bring insulated bag'],
    operatorSupportContact: '+14165550000',
    pickupGuidance: 'Meet at dispatch desk by 9:00 AM',
    routeName: 'Tuesday AM Route',
    shopDomain: 'tomatono.myshopify.com',
    timezone: 'America/Toronto'
  }
};

describe('Driver route access lookup route', () => {
  test('accepts phone-only access and returns route choices with company guidance', async () => {
    const { app, lookupRouteAccess } = await createAppHarness({
      result: {
        status: 'ROUTES_FOUND',
        routes: [invitedLookup]
      }
    });

    try {
      const response = await app.inject({
        method: 'POST',
        payload: { phoneE164: '+14165550123' },
        url: '/driver/route-access/lookup'
      });

      expect(response.statusCode).toBe(200);
      const body = response.json<{ data: { routes: Array<{ driverAccess: { accessToken: string } }> }; error: null }>();
      expect(body.data).toMatchObject({
        status: 'ROUTES_FOUND',
        routes: [
          {
            companyGuidance: invitedLookup.companyGuidance,
            routeAccess: invitedLookup.routeAccess
          }
        ]
      });
      expect(body.data.routes[0]?.driverAccess.accessToken).toEqual(expect.any(String));
      expect(body.data.routes[0]).not.toHaveProperty('status');
      expect(lookupRouteAccess).toHaveBeenCalledWith({
        phoneE164: '+14165550123',
        routeContext: null
      });
      expect(JSON.stringify(body)).not.toContain('driverContext');
      expect(JSON.stringify(body)).not.toContain('address1');
    } finally {
      await app.close();
    }
  });

  test('accepts registered phone lookup with no active routes as an empty route list', async () => {
    const { app, lookupRouteAccess } = await createAppHarness({
      result: {
        status: 'ROUTES_FOUND',
        routes: []
      }
    });

    try {
      const response = await app.inject({
        method: 'POST',
        payload: { phoneE164: '+14165550123' },
        url: '/driver/route-access/lookup'
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        data: {
          status: 'ROUTES_FOUND',
          routes: []
        },
        error: null
      });
      expect(lookupRouteAccess).toHaveBeenCalledWith({
        phoneE164: '+14165550123',
        routeContext: null
      });
    } finally {
      await app.close();
    }
  });

  test('rejects non-E.164 phone numbers before repository lookup', async () => {
    const { app, lookupRouteAccess } = await createAppHarness();

    try {
      const response = await app.inject({
        method: 'POST',
        payload: { phoneE164: '010-1234-5678', routeContext: 'route-plan-id' },
        url: '/driver/route-access/lookup'
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        data: null,
        error: { code: 'BAD_REQUEST', message: 'Invalid route access lookup payload' }
      });
      expect(lookupRouteAccess).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('returns company guidance for a matched active driver without stop data', async () => {
    const { app, lookupRouteAccess } = await createAppHarness();

    try {
      const response = await app.inject({
        method: 'POST',
        payload: { phoneE164: '+14165550123', routeContext: ' route-plan-id ' },
        url: '/driver/route-access/lookup'
      });

      expect(response.statusCode).toBe(200);
      const body = response.json<InvitedLookupResponseBody>();
      expect(body.data).toMatchObject({
        companyGuidance: invitedLookup.companyGuidance,
        routeAccess: invitedLookup.routeAccess,
        status: 'INVITED'
      });
      expect(body.data.driverAccess).toMatchObject({
        expiresAt: '2026-05-12T06:55:00.000Z',
        tokenType: 'Bearer',
        ttlSeconds: 900,
        use: 'consent_and_assigned_route'
      });
      expect(verifyDriverToken(body.data.driverAccess.accessToken, {
        now,
        secret: 'driver-secret'
      })).toEqual({
        driverId: 'driver-id',
        issuedAt: now,
        shopDomain: 'tomatono.myshopify.com',
        subject: 'driver:driver-id',
        tokenVersion: 4
      });
      expect(JSON.stringify(body)).not.toContain('driverContext');
      expect(lookupRouteAccess).toHaveBeenCalledWith({
        phoneE164: '+14165550123',
        routeContext: 'route-plan-id'
      });
      expect(JSON.stringify(response.json())).not.toContain('deliveryStop');
      expect(JSON.stringify(response.json())).not.toContain('address1');
    } finally {
      await app.close();
    }
  });

  test('returns a safe not-found status for route or phone mismatch', async () => {
    const { app, lookupRouteAccess } = await createAppHarness({ status: 'NOT_FOUND' });

    try {
      const response = await app.inject({
        method: 'POST',
        payload: { phoneE164: '+14165550123', routeContext: 'missing-route' },
        url: '/driver/route-access/lookup'
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ data: { status: 'NOT_FOUND' }, error: null });
      expect(lookupRouteAccess).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  test('returns multiple matches without issuing driver access', async () => {
    const multipleMatches = await createAppHarness({
      result: {
        status: 'MULTIPLE_MATCHES',
        matches: [
          {
            companyDisplayName: 'Tomatono Toronto',
            deliveryDate: '2026-05-12',
            operatorSupportContact: '+14165550000',
            pickupGuidance: 'Meet at dispatch desk by 9:00 AM',
            routeName: 'Tuesday AM Route',
            shopDomain: 'tomatono.myshopify.com',
            timezone: 'America/Toronto'
          },
          {
            companyDisplayName: 'North Market',
            deliveryDate: '2026-05-12',
            operatorSupportContact: '+14165550001',
            pickupGuidance: 'Contact dispatch if this route assignment looks unfamiliar.',
            routeName: 'North PM Route',
            shopDomain: 'north-market.myshopify.com',
            timezone: 'America/Toronto'
          }
        ],
        resolutionHint: 'Use the phone-only route list or contact dispatch.'
      }
    });

    try {
      const response = await multipleMatches.app.inject({
        method: 'POST',
        payload: { phoneE164: '+14165550123', routeContext: 'toronto-shared-route-scope' },
        url: '/driver/route-access/lookup'
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        data: {
          status: 'MULTIPLE_MATCHES',
          matches: [
            {
              companyDisplayName: 'Tomatono Toronto',
              deliveryDate: '2026-05-12',
              operatorSupportContact: '+14165550000',
              pickupGuidance: 'Meet at dispatch desk by 9:00 AM',
              routeName: 'Tuesday AM Route',
              shopDomain: 'tomatono.myshopify.com',
              timezone: 'America/Toronto'
            },
            {
              companyDisplayName: 'North Market',
              deliveryDate: '2026-05-12',
              operatorSupportContact: '+14165550001',
              pickupGuidance: 'Contact dispatch if this route assignment looks unfamiliar.',
              routeName: 'North PM Route',
              shopDomain: 'north-market.myshopify.com',
              timezone: 'America/Toronto'
            }
          ],
          resolutionHint: 'Use the phone-only route list or contact dispatch.'
        },
        error: null
      });
      expect(JSON.stringify(response.json())).not.toContain('driverAccess');
      expect(JSON.stringify(response.json())).not.toContain('driverContext');
      expect(JSON.stringify(response.json())).not.toContain('routePlanId');
      expect(JSON.stringify(response.json())).not.toContain('address1');
    } finally {
      await multipleMatches.app.close();
    }
  });

  test('distinguishes inactive and suspended driver states without guidance', async () => {
    const inactive = await createAppHarness({ status: 'DISABLED' });
    const blocked = await createAppHarness({ status: 'BLOCKED' });

    try {
      const inactiveResponse = await inactive.app.inject({
        method: 'POST',
        payload: { phoneE164: '+14165550123', routeContext: 'route-plan-id' },
        url: '/driver/route-access/lookup'
      });
      const blockedResponse = await blocked.app.inject({
        method: 'POST',
        payload: { phoneE164: '+14165550123', routeContext: 'route-plan-id' },
        url: '/driver/route-access/lookup'
      });

      expect(inactiveResponse.statusCode).toBe(200);
      expect(inactiveResponse.json()).toEqual({ data: { status: 'DISABLED' }, error: null });
      expect(blockedResponse.statusCode).toBe(200);
      expect(blockedResponse.json()).toEqual({ data: { status: 'BLOCKED' }, error: null });
    } finally {
      await inactive.app.close();
      await blocked.app.close();
    }
  });
});

async function createAppHarness(
  override: {
    result?: Awaited<ReturnType<LookupRouteAccess>>;
    status?: 'BLOCKED' | 'DISABLED' | 'NOT_FOUND';
  } = {}
): Promise<{
  app: Awaited<ReturnType<typeof buildApp>>;
  lookupRouteAccess: ReturnType<typeof vi.fn<LookupRouteAccess>>;
}> {
  const lookupRouteAccess = vi.fn<LookupRouteAccess>(() =>
    Promise.resolve(override.result ?? (override.status === undefined ? invitedLookup : { status: override.status }))
  );
  const recordDriverEvent = vi.fn<RecordDriverEvent>(() =>
    Promise.resolve({ duplicate: false, eventId: 'unused-driver-event-id' })
  );
  const app = await buildApp({
    driverApi: {
      driverEventService: {
        recordDriverEvent
      },
      jwtSecret: 'driver-secret',
      now: () => now,
      routeAccessService: {
        lookupRouteAccess
      }
    }
  });

  return { app, lookupRouteAccess };
}
