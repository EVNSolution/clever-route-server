import { describe, expect, test, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import {
  signDriverAccountToken,
  verifyDriverAccountToken
} from '../src/modules/driver/driver-token-verifier.js';
import type { DriverApiDependencies } from '../src/routes/driver-events.routes.js';

const now = new Date('2026-07-14T00:00:00.000Z');

describe('driver phone PIN authentication contract', () => {
  test('registers an invited phone only when a six-digit PIN is supplied', async () => {
    const verifyInvite = vi.fn(() => Promise.resolve(accountSession()));
    const app = await buildApp({
      driverAuth: {
        driverAuthRepository: { verifyInvite } as never,
        jwtSecret: 'driver-secret'
      }
    });

    try {
      const missingPin = await app.inject({
        method: 'POST',
        payload: { phone: '+821012345678', inviteCode: 'ABC123' },
        url: '/driver/auth/verify-invite'
      });
      expect(missingPin.statusCode).toBe(400);
      expect(verifyInvite).not.toHaveBeenCalled();

      const missingBody = await app.inject({
        method: 'POST',
        url: '/driver/auth/verify-invite'
      });
      expect(missingBody.statusCode).toBe(400);

      const response = await app.inject({
        method: 'POST',
        payload: { phone: '+821012345678', inviteCode: 'ABC123', pin: '012345' },
        url: '/driver/auth/verify-invite'
      });
      expect(response.statusCode).toBe(200);
      expect(verifyInvite).toHaveBeenCalledWith({
        inviteCode: 'ABC123',
        phone: '+821012345678',
        pin: '012345'
      });
      const body = response.json<{ data: { accessToken: string; use: string } }>();
      expect(body.data.use).toBe('driver_account');
      expect(verifyDriverAccountToken(body.data.accessToken, {
        now: new Date(),
        secret: 'driver-secret'
      })).toMatchObject({ accountId: 'account-id', tokenVersion: 3 });
    } finally {
      await app.close();
    }
  });

  test('logs an existing account in with phone and PIN', async () => {
    const loginWithPin = vi.fn(() => Promise.resolve(accountSession()));
    const app = await buildApp({
      driverAuth: {
        driverAuthRepository: { loginWithPin } as never,
        jwtSecret: 'driver-secret'
      }
    });

    try {
      const response = await app.inject({
        method: 'POST',
        payload: { phone: '+821012345678', pin: '012345' },
        url: '/driver/auth/login'
      });
      expect(response.statusCode).toBe(200);
      expect(loginWithPin).toHaveBeenCalledWith({ phone: '+821012345678', pin: '012345' });
      expect(response.json()).toMatchObject({ data: { use: 'driver_account' }, error: null });
    } finally {
      await app.close();
    }
  });

  test('requires a driver-account bearer before route lookup', async () => {
    const lookupRouteAccess = vi.fn<NonNullable<DriverApiDependencies['routeAccessService']>['lookupRouteAccess']>(
      () => Promise.resolve({ status: 'ROUTES_FOUND', routes: [] })
    );
    const app = await buildApp({
      driverApi: {
        driverEventService: {
          recordDriverEvent: vi.fn(() => Promise.resolve({ duplicate: false, eventId: 'unused' }))
        },
        jwtSecret: 'driver-secret',
        now: () => now,
        routeAccessService: { lookupRouteAccess }
      }
    });
    const accountToken = signDriverAccountToken({
      accountId: 'account-id',
      expiresInSeconds: 900,
      subject: 'driver-account:account-id',
      tokenVersion: 3
    }, { now, secret: 'driver-secret' });

    try {
      const unauthorized = await app.inject({
        method: 'POST',
        payload: { routeContext: null },
        url: '/driver/route-access/lookup'
      });
      expect(unauthorized.statusCode).toBe(401);

      const response = await app.inject({
        headers: { authorization: `Bearer ${accountToken.token}` },
        method: 'POST',
        payload: { routeContext: null },
        url: '/driver/route-access/lookup'
      });
      expect(response.statusCode).toBe(200);
      expect(lookupRouteAccess).toHaveBeenCalledWith({ accountId: 'account-id', routeContext: null });
    } finally {
      await app.close();
    }
  });
});

function accountSession() {
  return {
    accountId: 'account-id',
    expiresAt: new Date('2026-08-13T00:00:00.000Z'),
    kind: 'account' as const,
    refreshToken: 'refresh-token',
    tokenVersion: 3
  };
}
