import { describe, expect, test, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import { verifyDriverToken } from '../src/modules/driver/driver-token-verifier.js';
import type { DriverAuthDependencies } from '../src/routes/driver-auth.routes.js';

const anyStringMatcher: unknown = expect.any(String);

describe('Driver auth routes', () => {
  test('verifies invite codes case-insensitively and returns driver access session evidence', async () => {
    const verifyInvite = vi.fn<DriverAuthDependencies['driverAuthRepository']['verifyInvite']>(() =>
      Promise.resolve({
        driverId: 'driver-id',
        expiresAt: new Date('2026-06-15T00:00:00.000Z'),
        refreshToken: 'refresh-token',
        shopDomain: 'tomatono.myshopify.com',
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
        payload: { phone: '+14165550123', inviteCode: 'abc123', displayName: '  Minji Kim  ' },
        url: '/driver/auth/verify-invite'
      });

      expect(response.statusCode).toBe(200);
      expect(verifyInvite).toHaveBeenCalledWith({
        phone: '+14165550123',
        inviteCode: 'ABC123',
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

  test('returns driver access tokens for Woo customer-domain drivers', async () => {
    const verifyInvite = vi.fn<DriverAuthDependencies['driverAuthRepository']['verifyInvite']>(() =>
      Promise.resolve({
        driverId: 'driver-id',
        expiresAt: new Date('2026-06-15T00:00:00.000Z'),
        refreshToken: 'refresh-token',
        shopDomain: 'dev1.tomatonofood.com',
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
        payload: { phone: '+821089216198', inviteCode: 'face12', displayName: '  임 지인  ' },
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
      expect(verifyDriverToken(body.data.accessToken, { secret: 'test-secret' })).toMatchObject({
        driverId: 'driver-id',
        shopDomain: 'dev1.tomatonofood.com',
        subject: 'driver:driver-id',
        tokenVersion: 4
      });
    } finally {
      await app.close();
    }
  });

  test('logs sanitized verify-invite payload shape without raw invite secrets', async () => {
    const verifyInvite = vi.fn<DriverAuthDependencies['driverAuthRepository']['verifyInvite']>(() =>
      Promise.resolve({
        driverId: 'driver-id',
        expiresAt: new Date('2026-06-15T00:00:00.000Z'),
        refreshToken: 'refresh-token',
        shopDomain: 'tomatono.myshopify.com',
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
        payload: { phone: '+14165550123', inviteCode: 'abc123', displayName: '  Minji Kim  ' },
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
        payload: { phone: '+14165550123', inviteCode: '1234567' },
        url: '/driver/auth/verify-invite'
      });

      expect(response.statusCode).toBe(400);
      expect(verifyInvite).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
