import { describe, expect, test, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import {
  DriverSellerOrderAlreadyAcquiredError,
  type DriverSellerOrderAssignmentCommandInput
} from '../src/modules/driver/driver-seller-order-assignment.service.js';
import { signDriverRouteToken } from '../src/modules/driver/driver-token-verifier.js';

const secret = 'driver-secret';
const now = new Date('2026-07-22T06:40:00.000Z');
const context = {
  accountId: 'account-id',
  driverId: 'driver-id',
  routePlanId: 'route-plan-id',
  shopDomain: 'example.myshopify.com',
  shopId: 'shop-id'
};

describe('driver SellerOrder assignment routes', () => {
  test('returns unassigned orders only inside the bearer route scope', async () => {
    const listUnassigned = vi.fn(() => Promise.resolve([{ orderId: 'order-1' }]));
    const app = await createApp({ listUnassigned });

    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${driverToken()}` },
        method: 'GET',
        url: '/driver/orders/unassigned'
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.json()).toEqual({ data: { orders: [{ orderId: 'order-1' }] }, error: null });
      expect(listUnassigned).toHaveBeenCalledWith(context);
    } finally {
      await app.close();
    }
  });

  test('returns a stable conflict code when another driver acquired the order first', async () => {
    const acquire = vi.fn(() => Promise.reject(new DriverSellerOrderAlreadyAcquiredError()));
    const app = await createApp({ acquire });

    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${driverToken()}`, 'idempotency-key': 'acquire-command-1' },
        method: 'POST',
        url: '/driver/orders/order-1/acquire'
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        data: null,
        error: {
          code: 'SELLER_ORDER_ALREADY_ACQUIRED',
          message: 'This order has already been acquired by another driver.'
        }
      });
      expect(acquire).toHaveBeenCalledWith({
        ...context,
        commandId: 'acquire-command-1',
        expectedVersion: null,
        orderId: 'order-1'
      });
    } finally {
      await app.close();
    }
  });

  test('preserves legacy driver acquire calls without an idempotency key using an internal command id', async () => {
    const acquire = vi.fn<(input: DriverSellerOrderAssignmentCommandInput) => Promise<{ order: { orderId: string } }>>(
      () => Promise.resolve({ order: { orderId: 'order-1' } })
    );
    const app = await createApp({ acquire });

    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${driverToken()}` },
        method: 'POST',
        url: '/driver/orders/order-1/acquire'
      });

      expect(response.statusCode).toBe(200);
      const input = acquire.mock.calls[0]?.[0] as { commandId?: unknown } | undefined;
      expect(input?.commandId).toEqual(expect.stringMatching(/^driver-assignment:/u));
      expect(acquire).toHaveBeenCalledWith(expect.objectContaining({
        ...context,
        expectedVersion: null,
        orderId: 'order-1'
      }));
    } finally {
      await app.close();
    }
  });

  test('passes only bearer scope plus documented command fields to acquire', async () => {
    const acquire = vi.fn(() => Promise.resolve({ order: { orderId: 'order-1' } }));
    const app = await createApp({ acquire });

    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${driverToken()}`, 'idempotency-key': 'acquire-command-2' },
        method: 'POST',
        payload: { expectedVersion: 'route-version-1' },
        url: '/driver/orders/order-1/acquire'
      });

      expect(response.statusCode).toBe(200);
      expect(acquire).toHaveBeenCalledWith({
        ...context,
        commandId: 'acquire-command-2',
        expectedVersion: 'route-version-1',
        orderId: 'order-1'
      });
    } finally {
      await app.close();
    }
  });

  test('rejects body authority overrides for driver assignment commands', async () => {
    const acquire = vi.fn();
    const app = await createApp({ acquire });

    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${driverToken()}`, 'idempotency-key': 'acquire-command-3' },
        method: 'POST',
        payload: { driverId: 'body-driver-id', expectedVersion: 'route-version-1', shopId: 'body-shop-id' },
        url: '/driver/orders/order-1/acquire'
      });

      expect(response.statusCode).toBe(400);
      expect(acquire).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('keeps release separate from deletion and delegates the command envelope', async () => {
    const release = vi.fn(() => Promise.resolve({ order: { orderId: 'order-1' } }));
    const app = await createApp({ release });

    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${driverToken()}`, 'idempotency-key': 'release-command-1' },
        method: 'POST',
        payload: { expectedVersion: 'route-version-2' },
        url: '/driver/orders/order-1/release'
      });

      expect(response.statusCode).toBe(200);
      expect(release).toHaveBeenCalledWith({
        ...context,
        commandId: 'release-command-1',
        expectedVersion: 'route-version-2',
        orderId: 'order-1'
      });
    } finally {
      await app.close();
    }
  });
});

async function createApp(overrides: Record<string, unknown>) {
  return buildApp({
    driverApi: {
      driverEventService: {
        admitDriverEventAttempt: vi.fn(() => Promise.resolve({ attemptId: 'attempt-id', attemptNumber: 1 })),
        finalizeDriverEventAttempt: vi.fn(() => Promise.resolve()),
        recordDriverEvent: vi.fn(() => Promise.resolve({ duplicate: false, eventId: 'unused-event-id' }))
      },
      driverSellerOrderAssignmentService: {
        acquire: vi.fn(() => Promise.resolve({})),
        listUnassigned: vi.fn(() => Promise.resolve([])),
        release: vi.fn(() => Promise.resolve({})),
        ...overrides
      } as never,
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
