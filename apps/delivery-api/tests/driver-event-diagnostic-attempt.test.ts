import { describe, expect, test, vi } from 'vitest';
import Fastify from 'fastify';

import {
  DriverEventAdmissionUnavailableError,
  PrismaDriverEventRepository
} from '../src/modules/driver/driver-event.repository.js';
import { signDriverRouteToken } from '../src/modules/driver/driver-token-verifier.js';
import { registerDriverEventRoutes, type DriverApiDependencies } from '../src/routes/driver-events.routes.js';

const now = new Date('2026-10-02T03:00:00.000Z');
const secret = 'driver-location-diagnostic-secret';

describe('driver location diagnostic attempts', () => {
  test('keeps the validated transport identifier separate from the server-owned attempt identifier', async () => {
    const attemptCreate = vi.fn<(input: { data: Record<string, unknown> }) => Promise<{ attemptNumber: number; id: string }>>()
      .mockResolvedValue({ attemptNumber: 1, id: 'location-attempt-id' });
    const prisma = {
      driverEventAttempt: {
        create: attemptCreate,
        findFirst: vi.fn(() => Promise.resolve(null))
      }
    };
    const repository = new PrismaDriverEventRepository(prisma as never, { now: () => now });

    await expect(repository.admitDriverEventAttempt({
      appVersion: null,
      assignmentGeneration: null,
      clientEventId: 'mobile-location-42',
      driverContractVersion: 1,
      driverId: 'driver-id',
      eventType: 'LOCATION_UPDATED',
      expectedRouteVersionId: null,
      occurredAt: new Date('2026-10-02T02:59:30.000Z'),
      requestId: 'ea5e87d8-69e4-4706-89d9-a7c97d1886da',
      routePlanId: 'route-plan-id',
      shopId: 'shop-id',
      versionCode: null
    })).resolves.toEqual({ attemptId: 'location-attempt-id', attemptNumber: 1 });

    const data = attemptCreate.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(data.transportRequestId).toBe('ea5e87d8-69e4-4706-89d9-a7c97d1886da');
    expect(data.requestId).not.toBe('ea5e87d8-69e4-4706-89d9-a7c97d1886da');
    expect(data.requestId).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/u));
  });

  test.each([
    [{ duplicate: false, eventId: 'location-event-id' }, 202, false],
    [{ duplicate: true, eventId: 'existing-location-event-id' }, 200, true]
  ])('correlates a GPS result with its admitted attempt', async (result, statusCode, duplicate) => {
    const harness = routeHarness();
    harness.recordDriverEvent.mockResolvedValue(result);
    const app = buildDriverEventApp(harness.dependencies);
    try {
      const response = await app.inject({
        headers: {
          authorization: `Bearer ${routeToken()}`,
          'x-request-id': 'ea5e87d8-69e4-4706-89d9-a7c97d1886da'
        },
        method: 'POST',
        payload: locationPayload(),
        url: '/driver/events'
      });

      expect(response.statusCode).toBe(statusCode);
      expect(response.json()).toMatchObject({ data: { duplicate }, error: null });
      expect(harness.admitDriverEventAttempt).toHaveBeenCalledWith(expect.objectContaining({
        clientEventId: 'mobile-location-42',
        driverContractVersion: 1,
        eventType: 'LOCATION_UPDATED',
        requestId: 'ea5e87d8-69e4-4706-89d9-a7c97d1886da'
      }));
      expect(harness.recordDriverEvent).toHaveBeenCalledWith(expect.objectContaining({
        attemptId: 'location-attempt-id',
        clientEventId: 'mobile-location-42',
        requestId: 'ea5e87d8-69e4-4706-89d9-a7c97d1886da'
      }));
    } finally {
      await app.close();
    }
  });

  test('records a rejected malformed GPS attempt without invoking business handling', async () => {
    const harness = routeHarness();
    const app = buildDriverEventApp(harness.dependencies);
    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${routeToken()}` },
        method: 'POST',
        payload: { ...locationPayload(), latitude: 'not-a-coordinate' },
        url: '/driver/events'
      });

      expect(response.statusCode).toBe(400);
      expect(harness.recordDriverEvent).not.toHaveBeenCalled();
      expect(harness.finalizeDriverEventAttempt).toHaveBeenCalledWith('location-attempt-id', {
        errorCode: 'BAD_REQUEST',
        failureStage: 'WIRE_VALIDATION',
        retryable: false,
        status: 'REJECTED'
      });
    } finally {
      await app.close();
    }
  });

  test('does not store an invalid forged transport request identifier', async () => {
    const harness = routeHarness();
    const app = buildDriverEventApp(harness.dependencies);
    try {
      const response = await app.inject({
        headers: {
          authorization: `Bearer ${routeToken()}`,
          'x-request-id': 'forged request id with spaces and private@example.invalid'
        },
        method: 'POST',
        payload: locationPayload(),
        url: '/driver/events'
      });

      expect(response.statusCode).toBe(202);
      expect(harness.admitDriverEventAttempt).toHaveBeenCalledWith(expect.objectContaining({ requestId: null }));
      expect(harness.recordDriverEvent).toHaveBeenCalledWith(expect.not.objectContaining({ requestId: expect.anything() as unknown }));
    } finally {
      await app.close();
    }
  });

  test('preserves legacy GPS processing when diagnostic admission is unavailable', async () => {
    const harness = routeHarness();
    harness.admitDriverEventAttempt.mockRejectedValue(new DriverEventAdmissionUnavailableError());
    const app = buildDriverEventApp(harness.dependencies);
    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${routeToken()}` },
        method: 'POST',
        payload: locationPayload(),
        url: '/driver/events'
      });

      expect(response.statusCode).toBe(202);
      expect(harness.recordDriverEvent).toHaveBeenCalledWith(expect.not.objectContaining({ attemptId: expect.anything() as unknown }));
    } finally {
      await app.close();
    }
  });

  test('preserves a GPS rejection response when diagnostic finalization fails', async () => {
    const harness = routeHarness();
    harness.finalizeDriverEventAttempt.mockRejectedValue(new Error('diagnostic store unavailable'));
    const app = buildDriverEventApp(harness.dependencies);
    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${routeToken()}` },
        method: 'POST',
        payload: { ...locationPayload(), latitude: 'invalid' },
        url: '/driver/events'
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'BAD_REQUEST' } });
    } finally {
      await app.close();
    }
  });

  test('finalizes a correlated GPS business failure as retryable', async () => {
    const attemptUpdate = vi.fn(() => Promise.resolve({ id: 'location-attempt-id' }));
    const prisma = {
      $queryRaw: vi.fn(() => Promise.resolve([])),
      $transaction: vi.fn(() => Promise.reject(new Error('database unavailable'))),
      driverEventAttempt: { update: attemptUpdate }
    };
    const repository = new PrismaDriverEventRepository(prisma as never, { now: () => now });

    await expect(repository.recordDriverEvent({
      attemptId: 'location-attempt-id',
      clientEventId: 'mobile-location-42',
      deliveryStopId: null,
      driverId: 'driver-id',
      eventType: 'LOCATION_UPDATED',
      latitude: '40.7128',
      longitude: '-74.006',
      occurredAt: new Date('2026-10-02T02:59:30.000Z'),
      payload: locationPayload(),
      routePlanId: 'route-plan-id',
      shopDomain: 'example.myshopify.com',
      shopId: 'shop-id'
    })).rejects.toThrow('database unavailable');
    expect(attemptUpdate).toHaveBeenCalledWith({
      data: {
        committedEventId: null,
        errorCode: 'DRIVER_EVENT_TRANSIENT_FAILURE',
        failureStage: 'BUSINESS_TRANSACTION',
        retryable: true,
        status: 'FAILED'
      },
      where: { id: 'location-attempt-id' }
    });
  });
});

function routeHarness(): {
  admitDriverEventAttempt: ReturnType<typeof vi.fn>;
  dependencies: DriverApiDependencies;
  finalizeDriverEventAttempt: ReturnType<typeof vi.fn>;
  recordDriverEvent: ReturnType<typeof vi.fn>;
} {
  const admitDriverEventAttempt = vi.fn(() => Promise.resolve({ attemptId: 'location-attempt-id', attemptNumber: 1 }));
  const finalizeDriverEventAttempt = vi.fn(() => Promise.resolve());
  const recordDriverEvent = vi.fn(() => Promise.resolve({ duplicate: false, eventId: 'location-event-id' }));
  return {
    admitDriverEventAttempt,
    dependencies: {
      driverEventService: {
        admitDriverEventAttempt,
        finalizeDriverEventAttempt,
        recordDriverEvent
      },
      driverTokenAccessRepository: {
        isDriverAccountAccessTokenActive: vi.fn(() => Promise.resolve(true)),
        isDriverAccessTokenActive: vi.fn(() => Promise.resolve(false)),
        resolveDriverRouteAccess: vi.fn(() => Promise.resolve({
          accountId: 'account-id',
          driverId: 'driver-id',
          routePlanId: 'route-plan-id',
          shopDomain: 'example.myshopify.com',
          shopId: 'shop-id'
        }))
      },
      jwtSecret: secret,
      now: () => now
    },
    finalizeDriverEventAttempt,
    recordDriverEvent
  };
}

function buildDriverEventApp(dependencies: DriverApiDependencies) {
  const app = Fastify();
  registerDriverEventRoutes(app, dependencies);
  return app;
}

function locationPayload(): Record<string, unknown> {
  return {
    clientEventId: 'mobile-location-42',
    deliveryStopId: null,
    eventType: 'LOCATION_UPDATED',
    latitude: 40.7128,
    longitude: -74.006,
    occurredAt: '2026-10-02T02:59:30.000Z',
    routePlanId: 'route-plan-id'
  };
}

function routeToken(): string {
  return signDriverRouteToken({
    accountId: 'account-id',
    expiresInSeconds: 60,
    routePlanId: 'route-plan-id',
    subject: 'driver-account:account-id'
  }, { now, secret }).token;
}
