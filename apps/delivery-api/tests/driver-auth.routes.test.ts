import { describe, expect, test, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import {
  signDriverAccountToken,
  verifyDriverAccountToken,
  verifyDriverToken
} from '../src/modules/driver/driver-token-verifier.js';
import type { DriverAuthDependencies } from '../src/routes/driver-auth.routes.js';

const anyStringMatcher: unknown = expect.any(String);

describe('Driver auth routes', () => {
  test('reads the authenticated phone-account profile without a shop route token', async () => {
    const getAccountProfile = vi.fn(() => Promise.resolve({ name: null, phone: '+14165550123' }));
    const app = await buildApp({
      driverAuth: {
        driverAuthRepository: { getAccountProfile } as never,
        jwtSecret: 'test-secret'
      }
    });
    const accessToken = signDriverAccountToken({
      accountId: 'account-id',
      expiresInSeconds: 60,
      subject: 'driver-account:account-id',
      tokenVersion: 3
    }, { secret: 'test-secret' }).token;

    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${accessToken}` },
        method: 'GET',
        url: '/driver/account/profile'
      });

      expect(response.statusCode).toBe(200);
      expect(getAccountProfile).toHaveBeenCalledWith({ accountId: 'account-id', tokenVersion: 3 });
      expect(response.json()).toEqual({
        data: { account: { name: null, phone: '+14165550123' } },
        error: null
      });
    } finally {
      await app.close();
    }
  });

  test('updates only the authenticated phone-account name', async () => {
    const updateAccountProfile = vi.fn(() => Promise.resolve({ name: '임 지인', phone: '+821089216198' }));
    const app = await buildApp({
      driverAuth: {
        driverAuthRepository: { updateAccountProfile } as never,
        jwtSecret: 'test-secret'
      }
    });
    const accessToken = signDriverAccountToken({
      accountId: 'account-id',
      expiresInSeconds: 60,
      subject: 'driver-account:account-id',
      tokenVersion: 4
    }, { secret: 'test-secret' }).token;

    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${accessToken}` },
        method: 'PATCH',
        payload: { name: '  임 지인  ' },
        url: '/driver/account/profile'
      });

      expect(response.statusCode).toBe(200);
      expect(updateAccountProfile).toHaveBeenCalledWith({
        accountId: 'account-id',
        name: '임 지인',
        tokenVersion: 4
      });
      expect(response.json()).toEqual({
        data: { account: { name: '임 지인', phone: '+821089216198' } },
        error: null
      });
    } finally {
      await app.close();
    }
  });

  test('rejects invalid account profile credentials and invalid name payloads', async () => {
    const getAccountProfile = vi.fn(() => Promise.resolve(null));
    const updateAccountProfile = vi.fn(() => Promise.resolve(null));
    const app = await buildApp({
      driverAuth: {
        driverAuthRepository: { getAccountProfile, updateAccountProfile } as never,
        jwtSecret: 'test-secret'
      }
    });
    const accessToken = signDriverAccountToken({
      accountId: 'account-id',
      expiresInSeconds: 60,
      subject: 'driver-account:account-id',
      tokenVersion: 7
    }, { secret: 'test-secret' }).token;

    try {
      const missingToken = await app.inject({ method: 'GET', url: '/driver/account/profile' });
      const revokedToken = await app.inject({
        headers: { authorization: `Bearer ${accessToken}` },
        method: 'GET',
        url: '/driver/account/profile'
      });
      const invalidName = await app.inject({
        headers: { authorization: `Bearer ${accessToken}` },
        method: 'PATCH',
        payload: { name: ' '.repeat(3) },
        url: '/driver/account/profile'
      });
      const unexpectedField = await app.inject({
        headers: { authorization: `Bearer ${accessToken}` },
        method: 'PATCH',
        payload: { name: 'Jiin', phone: '+10000000000' },
        url: '/driver/account/profile'
      });

      expect(missingToken.statusCode).toBe(401);
      expect(revokedToken.statusCode).toBe(401);
      expect(invalidName.statusCode).toBe(400);
      expect(unexpectedField.statusCode).toBe(400);
      expect(updateAccountProfile).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('verifies invite codes case-insensitively and returns account access session evidence', async () => {
    const verifyInvite = vi.fn<DriverAuthDependencies['driverAuthRepository']['verifyInvite']>(() =>
      Promise.resolve({
        accountId: 'account-id',
        expiresAt: new Date('2026-06-15T00:00:00.000Z'),
        kind: 'account',
        refreshToken: 'refresh-token',
        tokenVersion: 2
      })
    );
    const app = await buildApp({
      driverAuth: {
        driverAuthRepository: { verifyInvite } as never,
        jwtSecret: 'test-secret'
      }
    });

    try {
      const response = await app.inject({
        method: 'POST',
        payload: { phone: '+14165550123', inviteCode: 'abc123', pin: '012345', displayName: '  Minji Kim  ' },
        url: '/driver/auth/verify-invite'
      });

      expect(response.statusCode).toBe(200);
      expect(verifyInvite).toHaveBeenCalledWith({
        phone: '+14165550123',
        inviteCode: 'ABC123',
        pin: '012345',
        displayName: 'Minji Kim'
      });
      expect(response.json()).toMatchObject({
        data: {
          accessToken: anyStringMatcher,
          refreshToken: 'refresh-token',
          refreshTokenExpiresAt: '2026-06-15T00:00:00.000Z'
        },
        error: null
      });
    } finally {
      await app.close();
    }
  });

  test('returns account access tokens for Woo customer-domain drivers', async () => {
    const verifyInvite = vi.fn<DriverAuthDependencies['driverAuthRepository']['verifyInvite']>(() =>
      Promise.resolve({
        accountId: 'account-id',
        expiresAt: new Date('2026-06-15T00:00:00.000Z'),
        kind: 'account',
        refreshToken: 'refresh-token',
        tokenVersion: 4
      })
    );
    const app = await buildApp({
      driverAuth: {
        driverAuthRepository: { verifyInvite } as never,
        jwtSecret: 'test-secret'
      }
    });

    try {
      const response = await app.inject({
        method: 'POST',
        payload: { phone: '+821089216198', inviteCode: 'face12', pin: '012345', displayName: '  임 지인  ' },
        url: '/driver/auth/verify-invite'
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as {
        data: {
          accessToken: string;
          refreshToken: string;
          refreshTokenExpiresAt: string;
        };
        error: null;
      };
      expect(body).toMatchObject({
        data: {
          accessToken: anyStringMatcher,
          refreshToken: 'refresh-token',
          refreshTokenExpiresAt: '2026-06-15T00:00:00.000Z'
        },
        error: null
      });
      expect(verifyDriverAccountToken(body.data.accessToken, { secret: 'test-secret' })).toMatchObject({
        accountId: 'account-id',
        subject: 'driver-account:account-id',
        tokenVersion: 4
      });
    } finally {
      await app.close();
    }
  });

  test('refreshes driver auth sessions and returns a new access token', async () => {
    const refreshSession = vi.fn<DriverAuthDependencies['driverAuthRepository']['refreshSession']>(() =>
      Promise.resolve({
        driverId: 'driver-id',
        expiresAt: new Date('2026-06-15T00:00:00.000Z'),
        kind: 'driver',
        refreshToken: 'stored-refresh-token',
        shopDomain: 'tomatono.myshopify.com',
        tokenVersion: 2
      })
    );
    const app = await buildApp({
      driverAuth: {
        driverAuthRepository: { refreshSession } as never,
        jwtSecret: 'test-secret'
      }
    });

    try {
      const response = await app.inject({
        method: 'POST',
        payload: { refreshToken: ' stored-refresh-token ' },
        url: '/driver/auth/refresh'
      });

      expect(response.statusCode).toBe(200);
      expect(refreshSession).toHaveBeenCalledWith({ refreshToken: 'stored-refresh-token' });
      const body: { data: { accessToken: string; refreshToken: string; refreshTokenExpiresAt: string }; error: null } = response.json();
      expect(body).toMatchObject({
        data: {
          accessToken: anyStringMatcher,
          refreshToken: 'stored-refresh-token',
          refreshTokenExpiresAt: '2026-06-15T00:00:00.000Z'
        },
        error: null
      });
      expect(verifyDriverToken(body.data.accessToken, { secret: 'test-secret' })).toMatchObject({
        driverId: 'driver-id',
        shopDomain: 'tomatono.myshopify.com',
        subject: 'driver:driver-id',
        tokenVersion: 2
      });
    } finally {
      await app.close();
    }
  });

  test('rejects missing or invalid refresh tokens without creating access tokens', async () => {
    const refreshSession = vi.fn<DriverAuthDependencies['driverAuthRepository']['refreshSession']>(() =>
      Promise.reject(new Error('Invalid or expired refresh token'))
    );
    const app = await buildApp({
      driverAuth: {
        driverAuthRepository: { refreshSession } as never,
        jwtSecret: 'test-secret'
      }
    });

    try {
      const noPayload = await app.inject({
        method: 'POST',
        url: '/driver/auth/refresh'
      });
      const missing = await app.inject({
        method: 'POST',
        payload: {},
        url: '/driver/auth/refresh'
      });
      const invalid = await app.inject({
        method: 'POST',
        payload: { refreshToken: 'revoked-refresh-token' },
        url: '/driver/auth/refresh'
      });

      expect(noPayload.statusCode).toBe(400);
      expect(missing.statusCode).toBe(400);
      expect(invalid.statusCode).toBe(401);
      expect(invalid.json()).toMatchObject({
        data: null,
        error: { code: 'UNAUTHORIZED', message: 'Invalid or expired refresh token' }
      });
      expect(refreshSession).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });


  test('does not expose unexpected refresh failures as invalid credentials', async () => {
    const refreshSession = vi.fn<DriverAuthDependencies['driverAuthRepository']['refreshSession']>(() =>
      Promise.reject(new Error('database connection failed'))
    );
    const app = await buildApp({
      driverAuth: {
        driverAuthRepository: { refreshSession } as never,
        jwtSecret: 'test-secret'
      }
    });

    try {
      const response = await app.inject({
        method: 'POST',
        payload: { refreshToken: 'stored-refresh-token' },
        url: '/driver/auth/refresh'
      });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({
        data: null,
        error: { code: 'INTERNAL_SERVER_ERROR', message: 'Driver session could not be refreshed' }
      });
    } finally {
      await app.close();
    }
  });

  test('logs sanitized verify-invite payload shape without raw invite secrets', async () => {
    const verifyInvite = vi.fn<DriverAuthDependencies['driverAuthRepository']['verifyInvite']>(() =>
      Promise.resolve({
        accountId: 'account-id',
        expiresAt: new Date('2026-06-15T00:00:00.000Z'),
        kind: 'account',
        refreshToken: 'refresh-token',
        tokenVersion: 2
      })
    );
    const logLines: string[] = [];
    const app = await buildApp({
      driverAuth: {
        driverAuthRepository: { verifyInvite } as never,
        jwtSecret: 'test-secret'
      },
      logger: {
        level: 'info',
        stream: { write: (line: string) => logLines.push(line) }
      }
    });

    try {
      const response = await app.inject({
        method: 'POST',
        payload: { phone: '+14165550123', inviteCode: 'abc123', pin: '012345', displayName: '  Minji Kim  ' },
        url: '/driver/auth/verify-invite'
      });

      expect(response.statusCode).toBe(200);
      const payloadLog = logLines.find((line) => line.includes('driver invite verification payload accepted')) ?? '';
      expect(payloadLog).toContain('phoneLast4');
      expect(payloadLog).toContain('0123');
      expect(payloadLog).toContain('displayNameProvided');
      expect(payloadLog).toContain('displayNameLength');
      expect(payloadLog).toContain('inviteCodeLength');
      expect(payloadLog).not.toContain('+14165550123');
      expect(payloadLog).not.toContain('abc123');
      expect(payloadLog).not.toContain('ABC123');
      expect(payloadLog).not.toContain('Minji Kim');
    } finally {
      await app.close();
    }
  });

  test('rejects malformed invite codes before repository lookup', async () => {
    const verifyInvite = vi.fn<DriverAuthDependencies['driverAuthRepository']['verifyInvite']>();
    const app = await buildApp({
      driverAuth: {
        driverAuthRepository: { verifyInvite } as never,
        jwtSecret: 'test-secret'
      }
    });

    try {
      const response = await app.inject({
        method: 'POST',
        payload: { phone: '+14165550123', inviteCode: '1234567', pin: '012345' },
        url: '/driver/auth/verify-invite'
      });

      expect(response.statusCode).toBe(400);
      expect(verifyInvite).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
