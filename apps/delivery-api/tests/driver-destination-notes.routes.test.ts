import { describe, expect, test, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import { DriverDestinationNotesScopeError } from '../src/modules/driver/driver-destination-notes.repository.js';
import { signDriverRouteToken } from '../src/modules/driver/driver-token-verifier.js';

const secret = 'driver-secret';
const now = new Date('2026-08-18T03:20:00.000Z');
const savedNotes = {
  lunchEntryStatus: 'UNAVAILABLE' as const,
  lunchEntryStatusUpdatedAt: '2026-08-18T03:20:00.000Z',
  lunchTimeRange: '12:00~13:00',
  lunchTimeRangeUpdatedAt: '2026-08-18T03:20:00.000Z',
  memo: '후문으로 입장',
  memoUpdatedAt: '2026-08-18T03:20:00.000Z',
  requiredArrivalTime: '10:30',
  requiredArrivalTimeUpdatedAt: '2026-08-18T03:20:00.000Z'
};

describe('Driver destination notes route', () => {
  test('updates destination notes within the bearer route assignment', async () => {
    const { app, update } = await createAppHarness();

    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${driverToken()}` },
        method: 'PATCH',
        payload: {
          lunchEntryStatus: 'UNAVAILABLE',
          lunchTimeRange: '12:00~13:00',
          memo: ' 후문으로 입장 ',
          requiredArrivalTime: '10:30'
        },
        url: '/driver/destinations/destination-id/notes'
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.json()).toEqual({ data: { destinationId: 'destination-id', notes: savedNotes }, error: null });
      expect(update).toHaveBeenCalledWith({
        destinationId: 'destination-id',
        driverId: 'driver-id',
        patch: {
          lunchEntryStatus: 'UNAVAILABLE',
          lunchTimeRange: '12:00~13:00',
          memo: '후문으로 입장',
          requiredArrivalTime: '10:30'
        },
        routePlanId: 'route-plan-id',
        shopId: 'shop-id'
      });
    } finally {
      await app.close();
    }
  });

  test.each([
    { description: 'empty patch', payload: {} },
    { description: 'unsupported lunch entry status', payload: { lunchEntryStatus: 'UNKNOWN' } },
    { description: 'invalid lunch time range', payload: { lunchTimeRange: '12:70~13:00' } },
    { description: 'noncanonical arrival time', payload: { requiredArrivalTime: '9:30' } },
    { description: 'empty string instead of null', payload: { memo: '' } },
    { description: 'unknown field', payload: { unexpected: true } }
  ])('rejects $description', async ({ payload }) => {
    const { app, update } = await createAppHarness();

    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${driverToken()}` },
        method: 'PATCH',
        payload,
        url: '/driver/destinations/destination-id/notes'
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        data: null,
        error: { code: 'BAD_REQUEST', message: 'Invalid driver destination notes payload' }
      });
      expect(update).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('rejects a destination outside the bearer route assignment', async () => {
    const { app } = await createAppHarness({ scopeRejected: true });

    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${driverToken()}` },
        method: 'PATCH',
        payload: { memo: '변조 시도' },
        url: '/driver/destinations/other-destination-id/notes'
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        data: null,
        error: { code: 'DESTINATION_NOTES_ROUTE_SCOPE_REJECTED', message: '현재 배송 경로의 배송지만 수정할 수 있습니다.' }
      });
    } finally {
      await app.close();
    }
  });
});

async function createAppHarness(input: { scopeRejected?: boolean } = {}) {
  const update = vi.fn(() => input.scopeRejected === true
    ? Promise.reject(new DriverDestinationNotesScopeError())
    : Promise.resolve(savedNotes));
  const app = await buildApp({
    driverApi: {
      driverDestinationNotesService: { update },
      driverEventService: {
        admitDriverEventAttempt: vi.fn(() => Promise.resolve({ attemptId: 'attempt-id', attemptNumber: 1 })),
        finalizeDriverEventAttempt: vi.fn(() => Promise.resolve()),
        recordDriverEvent: vi.fn(() => Promise.resolve({ duplicate: false, eventId: 'unused-event-id' }))
      },
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
      jwtSecret: secret,
      now: () => now
    }
  });
  return { app, update };
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
