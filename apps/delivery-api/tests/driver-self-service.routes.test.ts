import { describe, expect, test, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import {
  DriverAccountDeletionActiveRouteError,
  DriverRouteHistoryCursorError
} from '../src/modules/driver/driver-self-service.types.js';
import type { DriverApiDependencies } from '../src/routes/driver-events.routes.js';
import {
  signDriverAccountToken,
  signDriverRouteToken
} from '../src/modules/driver/driver-token-verifier.js';

const secret = 'driver-secret';
const now = new Date('2026-05-19T06:40:00.000Z');

describe('Driver self-service routes', () => {
  test.each([
    ['GET', '/driver/routes'],
    ['POST', '/driver/routes/route-plan-id/feedback'],
    ['GET', '/driver/profile'],
    ['PATCH', '/driver/profile'],
    ['POST', '/driver/account-deletion-requests'],
    ['GET', '/driver/earnings']
  ] as const)('rejects %s %s without a bearer token', async (method, url) => {
    const { app, selfService } = await createAppHarness();

    try {
      const response = await app.inject({ method, url });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        data: null,
        error: { code: 'UNAUTHORIZED', message: 'Missing driver bearer token' }
      });
      expect(selfService.listDriverRoutes).not.toHaveBeenCalled();
      expect(selfService.submitRouteFeedback).not.toHaveBeenCalled();
      expect(selfService.getDriverProfile).not.toHaveBeenCalled();
      expect(selfService.updateDriverProfile).not.toHaveBeenCalled();
      expect(selfService.requestAccountDeletion).not.toHaveBeenCalled();
      expect(selfService.requestGlobalAccountDeletion).not.toHaveBeenCalled();
      expect(selfService.getDriverEarnings).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('rejects new self-service routes when tokenVersion was invalidated', async () => {
    const { app, resolveDriverRouteAccess } = await createAppHarness({ activeToken: false });

    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${driverToken()}` },
        method: 'GET',
        url: '/driver/routes'
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        data: null,
        error: { code: 'DRIVER_ACCESS_TOKEN_INVALID', message: 'Invalid driver access token' }
      });
      expect(resolveDriverRouteAccess).toHaveBeenCalledWith({
        accountId: 'account-id',
        routePlanId: 'route-plan-id',
        tokenVersion: 0
      });
    } finally {
      await app.close();
    }
  });

  test('returns driver route history with token-scoped identity and query filters', async () => {
    const { app, selfService } = await createAppHarness();

    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${driverToken()}` },
        method: 'GET',
        url: '/driver/routes?from=2026-05-01&to=2026-05-31&status=completed&cursor=cursor-token'
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        data: {
          routes: [
            {
              completedAt: '2026-05-19T08:30:00.000Z',
              completedStopCount: 4,
              deliveryDate: '2026-05-19',
              failedStopCount: 0,
              name: 'Tuesday AM Route',
              routePlanId: 'route-plan-id',
              shopDomain: 'example.myshopify.com',
              companyDisplayName: 'Tomatono',
              status: 'completed',
              stopCount: 4,
              timezone: 'America/Toronto'
            }
          ],
          pageInfo: { endCursor: null, hasNextPage: false }
        },
        error: null
      });
      expect(selfService.listDriverRoutes).toHaveBeenCalledWith({
        cursor: 'cursor-token',
        driverId: 'driver-id',
        from: new Date('2026-05-01T00:00:00.000Z'),
        shopDomain: 'example.myshopify.com',
        shopId: 'shop-id',
        status: 'completed',
        to: new Date('2026-05-31T00:00:00.000Z')
      });
    } finally {
      await app.close();
    }
  });

  test('rejects invalid driver route history filters', async () => {
    const { app, selfService } = await createAppHarness();

    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${driverToken()}` },
        method: 'GET',
        url: '/driver/routes?status=weekday'
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        data: null,
        error: { code: 'BAD_REQUEST', message: 'Invalid driver route history query' }
      });
      expect(selfService.listDriverRoutes).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('maps malformed route history cursors to bad request instead of server errors', async () => {
    const { app, selfService } = await createAppHarness();
    selfService.listDriverRoutes.mockRejectedValueOnce(new DriverRouteHistoryCursorError('Invalid route history cursor'));

    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${driverToken()}` },
        method: 'GET',
        url: '/driver/routes?cursor=not-base64'
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        data: null,
        error: { code: 'BAD_REQUEST', message: 'Invalid driver route history query' }
      });
      expect(selfService.listDriverRoutes).toHaveBeenCalledWith({
        cursor: 'not-base64',
        driverId: 'driver-id',
        from: null,
        shopDomain: 'example.myshopify.com',
        shopId: 'shop-id',
        status: null,
        to: null
      });
    } finally {
      await app.close();
    }
  });

  test('records route feedback only through token driver context', async () => {
    const { app, selfService } = await createAppHarness();

    try {
      const response = await app.inject({
        body: { reviewNote: 'Use west entrance next time.' },
        headers: { authorization: `Bearer ${driverToken()}` },
        method: 'POST',
        url: '/driver/routes/route-plan-id/feedback'
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({
        data: {
          feedbackId: 'feedback-id',
          reviewNote: 'Use west entrance next time.',
          routePlanId: 'route-plan-id',
          submittedAt: now.toISOString()
        },
        error: null
      });
      expect(selfService.submitRouteFeedback).toHaveBeenCalledWith({
        driverId: 'driver-id',
        reviewNote: 'Use west entrance next time.',
        routePlanId: 'route-plan-id',
        shopDomain: 'example.myshopify.com',
        shopId: 'shop-id',
        submittedAt: now
      });
    } finally {
      await app.close();
    }
  });

  test('rejects feedback for a route other than the token assignment', async () => {
    const { app, selfService } = await createAppHarness();

    try {
      const response = await app.inject({
        body: { reviewNote: 'Use west entrance next time.' },
        headers: { authorization: `Bearer ${driverToken()}` },
        method: 'POST',
        url: '/driver/routes/other-route/feedback'
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        data: null,
        error: {
          code: 'ROUTE_ASSIGNMENT_ACCOUNT_MISMATCH',
          message: 'Driver route assignment rejected'
        }
      });
      expect(selfService.submitRouteFeedback).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('reads and updates driver profile with displayName-only payloads', async () => {
    const { app, selfService } = await createAppHarness();

    try {
      const readResponse = await app.inject({
        headers: { authorization: `Bearer ${driverToken()}` },
        method: 'GET',
        url: '/driver/profile'
      });
      expect(readResponse.statusCode).toBe(200);
      expect(readResponse.json<DriverProfileResponseBody>().data.driver.displayName).toBe('Minji Kim');

      const updateResponse = await app.inject({
        body: { displayName: '  Mina Kang  ' },
        headers: { authorization: `Bearer ${driverToken()}` },
        method: 'PATCH',
        url: '/driver/profile'
      });

      expect(updateResponse.statusCode).toBe(200);
      expect(updateResponse.json<DriverProfileResponseBody>().data.driver.displayName).toBe('Mina Kang');
      expect(selfService.updateDriverProfile).toHaveBeenCalledWith({
        displayName: 'Mina Kang',
        driverId: 'driver-id',
        shopDomain: 'example.myshopify.com',
        shopId: 'shop-id'
      });
    } finally {
      await app.close();
    }
  });

  test('rejects profile mutation attempts outside displayName', async () => {
    const { app, selfService } = await createAppHarness();

    try {
      const response = await app.inject({
        body: { displayName: 'Mina Kang', phone: '+14165559999' },
        headers: { authorization: `Bearer ${driverToken()}` },
        method: 'PATCH',
        url: '/driver/profile'
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        data: null,
        error: { code: 'BAD_REQUEST', message: 'Invalid driver profile payload' }
      });
      expect(selfService.updateDriverProfile).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('creates account deletion request without deleting the driver', async () => {
    const { app, selfService } = await createAppHarness();

    try {
      const response = await app.inject({
        body: { confirmation: 'DELETE', reason: 'No longer driving' },
        headers: { authorization: `Bearer ${driverToken()}` },
        method: 'POST',
        url: '/driver/account-deletion-requests'
      });

      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({
        data: { duplicate: false, requestId: 'deletion-request-id', status: 'REQUESTED' },
        error: null
      });
      expect(selfService.requestAccountDeletion).toHaveBeenCalledWith({
        driverId: 'driver-id',
        reason: 'No longer driving',
        requestedAt: now,
        shopDomain: 'example.myshopify.com',
        shopId: 'shop-id'
      });
    } finally {
      await app.close();
    }
  });

  test('creates one global deletion request from the account bearer without Store scope', async () => {
    const { app, selfService } = await createAppHarness();

    try {
      const response = await app.inject({
        body: { confirmation: 'DELETE', reason: 'Delete my account' },
        headers: { authorization: `Bearer ${accountToken()}` },
        method: 'POST',
        url: '/driver/account-deletion-requests'
      });

      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({
        data: { duplicate: false, requestId: 'global-deletion-request-id', status: 'REQUESTED' },
        error: null
      });
      expect(selfService.requestGlobalAccountDeletion).toHaveBeenCalledWith({
        accountId: 'account-id',
        reason: 'Delete my account',
        requestedAt: now,
        tokenVersion: 0
      });
      expect(selfService.requestAccountDeletion).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('blocks a new global deletion request while a route is in progress', async () => {
    const { app, selfService } = await createAppHarness();
    selfService.requestGlobalAccountDeletion.mockRejectedValueOnce(
      new DriverAccountDeletionActiveRouteError()
    );

    try {
      const response = await app.inject({
        body: { confirmation: 'DELETE' },
        headers: { authorization: `Bearer ${accountToken()}` },
        method: 'POST',
        url: '/driver/account-deletion-requests'
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        data: null,
        error: {
          code: 'ACCOUNT_DELETION_ACTIVE_ROUTE',
          message: 'Finish or release the active route before requesting account deletion'
        }
      });
    } finally {
      await app.close();
    }
  });

  test('requires explicit account deletion confirmation', async () => {
    const { app, selfService } = await createAppHarness();

    try {
      const response = await app.inject({
        body: { confirmation: 'delete' },
        headers: { authorization: `Bearer ${driverToken()}` },
        method: 'POST',
        url: '/driver/account-deletion-requests'
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        data: null,
        error: { code: 'BAD_REQUEST', message: 'Invalid account deletion request payload' }
      });
      expect(selfService.requestAccountDeletion).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('returns conservative earnings readiness for a period', async () => {
    const { app, selfService } = await createAppHarness();

    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${driverToken()}` },
        method: 'GET',
        url: '/driver/earnings?period=2026-05'
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        data: {
          currency: 'CAD',
          items: [],
          period: '2026-05',
          summary: {
            adjustments: 0,
            completedRoutes: 2,
            completedStops: 16,
            estimatedPayout: 0,
            grossAmount: 0
          }
        },
        error: null
      });
      expect(selfService.getDriverEarnings).toHaveBeenCalledWith({
        driverId: 'driver-id',
        period: '2026-05',
        shopDomain: 'example.myshopify.com',
        shopId: 'shop-id'
      });
    } finally {
      await app.close();
    }
  });
});

type DriverProfileResponseBody = {
  data: {
    driver: {
      displayName: string;
    };
  };
};

async function createAppHarness(input: { activeToken?: boolean } = {}) {
  type DriverSelfService = NonNullable<DriverApiDependencies['driverSelfService']>;

  const selfService = {
    getDriverEarnings: vi.fn<DriverSelfService['getDriverEarnings']>(() => Promise.resolve({
      currency: 'CAD',
      items: [],
      period: '2026-05',
      summary: {
        adjustments: 0,
        completedRoutes: 2,
        completedStops: 16,
        estimatedPayout: 0,
        grossAmount: 0
      }
    })),
    getDriverProfile: vi.fn<DriverSelfService['getDriverProfile']>(() => Promise.resolve({
      driver: { displayName: 'Minji Kim', id: 'driver-id', phone: '+14165550123', status: 'ACTIVE' }
    })),
    listDriverRoutes: vi.fn<DriverSelfService['listDriverRoutes']>(() => Promise.resolve({
      routes: [
        {
          completedAt: '2026-05-19T08:30:00.000Z',
          completedStopCount: 4,
          deliveryDate: '2026-05-19',
          failedStopCount: 0,
          name: 'Tuesday AM Route',
          routePlanId: 'route-plan-id',
          shopDomain: 'example.myshopify.com',
          companyDisplayName: 'Tomatono',
          status: 'completed',
          stopCount: 4,
          timezone: 'America/Toronto'
        }
      ],
      pageInfo: { endCursor: null, hasNextPage: false }
    })),
    requestAccountDeletion: vi.fn<DriverSelfService['requestAccountDeletion']>(() =>
      Promise.resolve({ duplicate: false, requestId: 'deletion-request-id', status: 'REQUESTED' })
    ),
    requestGlobalAccountDeletion: vi.fn<DriverSelfService['requestGlobalAccountDeletion']>(() =>
      Promise.resolve({ duplicate: false, requestId: 'global-deletion-request-id', status: 'REQUESTED' })
    ),
    submitRouteFeedback: vi.fn<DriverSelfService['submitRouteFeedback']>((request) => Promise.resolve({
      feedbackId: 'feedback-id',
      reviewNote: request.reviewNote,
      routePlanId: request.routePlanId,
      submittedAt: request.submittedAt.toISOString()
    })),
    updateDriverProfile: vi.fn<DriverSelfService['updateDriverProfile']>((request) => Promise.resolve({
      driver: { displayName: request.displayName, id: 'driver-id', phone: '+14165550123', status: 'ACTIVE' }
    }))
  } satisfies NonNullable<DriverApiDependencies['driverSelfService']>;

  const resolveDriverRouteAccess = vi.fn<
    NonNullable<DriverApiDependencies['driverTokenAccessRepository']>['resolveDriverRouteAccess']
  >(() => Promise.resolve(input.activeToken === false ? null : {
    accountId: 'account-id',
    driverId: 'driver-id',
    routePlanId: 'route-plan-id',
    shopDomain: 'example.myshopify.com',
    shopId: 'shop-id'
  }));

  const app = await buildApp({
    driverApi: {
      driverEventService: {
        recordDriverEvent: vi.fn(() => Promise.resolve({ duplicate: false, eventId: 'unused-event-id' }))
      },
      driverSelfService: selfService,
      driverTokenAccessRepository: {
        isDriverAccountAccessTokenActive: vi.fn(() => Promise.resolve(true)),
        isDriverAccessTokenActive: vi.fn(() => Promise.resolve(false)),
        resolveDriverRouteAccess
      },
      jwtSecret: secret,
      now: () => now
    }
  });

  return { app, resolveDriverRouteAccess, selfService };
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

function accountToken(): string {
  return signDriverAccountToken({
    accountId: 'account-id',
    expiresInSeconds: 60,
    subject: 'driver-account:account-id',
    tokenVersion: 0
  }, { now, secret }).token;
}
