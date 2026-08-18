import { describe, expect, test, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import { DriverDeliverySpaceError } from '../src/modules/driver/driver-delivery-space.service.js';
import { signDriverRouteToken } from '../src/modules/driver/driver-token-verifier.js';

const secret = 'driver-secret';
const now = new Date('2026-08-03T06:40:00.000Z');
const context = {
  accountId: 'account-id',
  driverId: 'driver-id',
  routePlanId: 'route-plan-id',
  shopDomain: 'example.myshopify.com',
  shopId: 'shop-id'
};
const emptySpace = { available: [], mine: [], recipients: [], version: 'route-version-1' };

describe('driver delivery space routes', () => {
  test('returns destination bundles only inside the bearer route scope', async () => {
    const getSpace = vi.fn(() => Promise.resolve(emptySpace));
    const app = await createApp({ getSpace });

    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${driverToken()}` },
        method: 'GET',
        url: '/driver/delivery-space'
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.json()).toEqual({ data: emptySpace, error: null });
      expect(getSpace).toHaveBeenCalledWith(context);
    } finally {
      await app.close();
    }
  });

  test('delegates a destination-wide release using only bearer scope and version', async () => {
    const release = vi.fn(() => Promise.resolve({ bundle: {}, routePlanId: 'available-route', version: 'route-version-2' }));
    const app = await createApp({ release });

    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${driverToken()}` },
        method: 'POST',
        payload: { expectedVersion: 'route-version-1' },
        url: '/driver/delivery-space/destination-1/release'
      });

      expect(response.statusCode).toBe(200);
      expect(release).toHaveBeenCalledWith({
        ...context,
        destinationId: 'destination-1',
        expectedVersion: 'route-version-1'
      });
    } finally {
      await app.close();
    }
  });

  test('delegates a destination-wide transfer to a selected in-group driver', async () => {
    const transfer = vi.fn(() => Promise.resolve({ bundle: {}, routePlanId: 'recipient-route', version: 'route-version-2' }));
    const app = await createApp({ transfer });

    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${driverToken()}` },
        method: 'POST',
        payload: { expectedVersion: 'route-version-1', targetDriverId: 'recipient-driver' },
        url: '/driver/delivery-space/destination-1/transfer'
      });

      expect(response.statusCode).toBe(200);
      expect(transfer).toHaveBeenCalledWith({
        ...context,
        destinationId: 'destination-1',
        expectedVersion: 'route-version-1',
        targetDriverId: 'recipient-driver'
      });
    } finally {
      await app.close();
    }
  });

  test('rejects body authority overrides before calling the service', async () => {
    const acquire = vi.fn();
    const app = await createApp({ acquire });

    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${driverToken()}` },
        method: 'POST',
        payload: { driverId: 'body-driver', expectedVersion: 'route-version-1', shopId: 'body-shop' },
        url: '/driver/delivery-space/destination-1/acquire'
      });

      expect(response.statusCode).toBe(400);
      expect(acquire).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('returns a stable conflict when another driver acquires the bundle first', async () => {
    const acquire = vi.fn(() => Promise.reject(new DriverDeliverySpaceError(
      'DESTINATION_BUNDLE_ALREADY_ACQUIRED',
      '다른 배송원이 먼저 가져간 배송입니다.'
    )));
    const app = await createApp({ acquire });

    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${driverToken()}` },
        method: 'POST',
        payload: { expectedVersion: 'route-version-1' },
        url: '/driver/delivery-space/destination-1/acquire'
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        data: null,
        error: {
          code: 'DESTINATION_BUNDLE_ALREADY_ACQUIRED',
          message: '다른 배송원이 먼저 가져간 배송입니다.'
        }
      });
    } finally {
      await app.close();
    }
  });
});

async function createApp(overrides: Record<string, unknown>) {
  return buildApp({
    driverApi: {
      driverDeliverySpaceService: {
        acquire: vi.fn(() => Promise.resolve({})),
        getSpace: vi.fn(() => Promise.resolve(emptySpace)),
        release: vi.fn(() => Promise.resolve({})),
        transfer: vi.fn(() => Promise.resolve({})),
        ...overrides
      } as never,
      driverEventService: {
        recordDriverEvent: vi.fn(() => Promise.resolve({ duplicate: false, eventId: 'unused-event-id' }))
      },
      driverTokenAccessRepository: {
        isDriverAccessTokenActive: vi.fn(() => Promise.resolve(false)),
        isDriverAccountAccessTokenActive: vi.fn(() => Promise.resolve(true)),
        resolveDriverRouteAccess: vi.fn(() => Promise.resolve(context))
      },
      jwtSecret: secret,
      now: () => now
    }
  });
}

function driverToken(): string {
  return signDriverRouteToken({
    accountId: context.accountId,
    expiresInSeconds: 60,
    routePlanId: context.routePlanId,
    subject: `driver-account:${context.accountId}`,
    tokenVersion: 0
  }, { now, secret }).token;
}
