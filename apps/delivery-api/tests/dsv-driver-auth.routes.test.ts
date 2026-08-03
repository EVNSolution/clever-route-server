import { describe, expect, test, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import {
  DsvDriverAuthConflictError,
  DsvDriverAuthCredentialsError,
  type DsvDriverAuthRepository,
} from '../src/modules/dsv/dsv-driver-auth.repository.js';
import { verifyDriverAccountToken } from '../src/modules/driver/driver-token-verifier.js';

const session = {
  account: {
    connectionStatus: 'LINKED' as const,
    id: 'account-id',
    linkedDrivers: [{ driverId: 'driver-id', name: 'QA 배송원 01', shopDomain: 'dsv-demo.local' }],
    loginId: 'driver.one',
    name: 'QA 배송원 01',
    phone: '01090000001',
  },
  accountId: 'account-id',
  expiresAt: new Date('2026-09-01T00:00:00.000Z'),
  refreshToken: 'refresh-token',
  tokenVersion: 2,
};

describe('DSV Driver app auth routes', () => {
  test('registers, links, and returns an account-scoped bearer session', async () => {
    const register = vi.fn<DsvDriverAuthRepository['register']>(() => Promise.resolve(session));
    const app = await buildApp({
      dsvDriverAuth: { jwtSecret: 'test-jwt-secret', repository: { register } as never },
    });

    try {
      const response = await app.inject({
        method: 'POST',
        payload: {
          loginId: ' Driver.One ',
          name: '  QA 배송원 01  ',
          password: 'test-password-01',
          phone: '010-9000-0001',
          residentNumberFront: '9001011',
        },
        url: '/api/dsv/driver/auth/register',
      });

      expect(response.statusCode).toBe(201);
      expect(register).toHaveBeenCalledWith({
        loginId: 'driver.one',
        name: 'QA 배송원 01',
        password: 'test-password-01',
        phone: '01090000001',
        residentNumberFront: '9001011',
      });
      const body = response.json<{ data: { accessToken: string }; error: null }>();
      expect(body).toMatchObject({
        data: {
          account: session.account,
          refreshToken: 'refresh-token',
          refreshTokenExpiresAt: '2026-09-01T00:00:00.000Z',
          tokenType: 'Bearer',
          use: 'dsv_driver_account',
        },
        error: null,
      });
      expect(verifyDriverAccountToken(body.data.accessToken, { secret: 'test-jwt-secret' })).toMatchObject({
        accountId: 'account-id',
        tokenVersion: 2,
      });
    } finally {
      await app.close();
    }
  });

  test('logs in with a normalized identifier without accepting identity fields', async () => {
    const login = vi.fn<DsvDriverAuthRepository['login']>(() => Promise.resolve(session));
    const app = await buildApp({
      dsvDriverAuth: { jwtSecret: 'test-jwt-secret', repository: { login } as never },
    });

    try {
      const response = await app.inject({
        method: 'POST',
        payload: { loginId: ' DRIVER.ONE ', password: 'test-password-01' },
        url: '/api/dsv/driver/auth/login',
      });

      expect(response.statusCode).toBe(200);
      expect(login).toHaveBeenCalledWith({ loginId: 'driver.one', password: 'test-password-01' });
      expect(response.json()).toMatchObject({ data: { account: session.account }, error: null });
    } finally {
      await app.close();
    }
  });

  test('uses bounded validation and stable public conflict and credential errors', async () => {
    const register = vi.fn<DsvDriverAuthRepository['register']>(() => Promise.reject(new DsvDriverAuthConflictError()));
    const login = vi.fn<DsvDriverAuthRepository['login']>(() => Promise.reject(new DsvDriverAuthCredentialsError()));
    const app = await buildApp({
      dsvDriverAuth: { jwtSecret: 'test-jwt-secret', repository: { login, register } },
    });

    try {
      const invalidRegistration = await app.inject({
        method: 'POST',
        payload: { loginId: 'a', name: '', password: 'short', phone: '02', residentNumberFront: '123' },
        url: '/api/dsv/driver/auth/register',
      });
      const conflict = await app.inject({
        method: 'POST',
        payload: {
          loginId: 'driver.one',
          name: 'QA 배송원 01',
          password: 'test-password-01',
          phone: '01090000001',
          residentNumberFront: '9001011',
        },
        url: '/api/dsv/driver/auth/register',
      });
      const invalidLogin = await app.inject({
        method: 'POST',
        payload: { loginId: 'driver.one', password: 'wrong-password' },
        url: '/api/dsv/driver/auth/login',
      });

      expect(invalidRegistration.statusCode).toBe(400);
      expect(register).toHaveBeenCalledTimes(1);
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toEqual({
        data: null,
        error: { code: 'ACCOUNT_EXISTS', message: 'An account already exists for this login ID or phone number' },
      });
      expect(invalidLogin.statusCode).toBe(401);
      expect(invalidLogin.json()).toEqual({
        data: null,
        error: { code: 'INVALID_CREDENTIALS', message: 'Invalid login ID or password' },
      });
    } finally {
      await app.close();
    }
  });

  test('rate-limits repeated registration attempts by client address', async () => {
    const register = vi.fn<DsvDriverAuthRepository['register']>(() => Promise.reject(new DsvDriverAuthConflictError()));
    const app = await buildApp({
      dsvDriverAuth: { jwtSecret: 'test-jwt-secret', repository: { register } as never },
    });

    try {
      const responses = [];
      for (let attempt = 0; attempt < 6; attempt += 1) {
        responses.push(await app.inject({
          method: 'POST',
          payload: {
            loginId: 'driver.one',
            name: 'QA 배송원 01',
            password: 'test-password-01',
            phone: '01090000001',
            residentNumberFront: '9001011',
          },
          url: '/api/dsv/driver/auth/register',
        }));
      }

      expect(responses.slice(0, 5).map((response) => response.statusCode)).toEqual([409, 409, 409, 409, 409]);
      expect(responses[5]?.statusCode).toBe(429);
      expect(responses[5]?.json()).toEqual({
        data: null,
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many authentication attempts. Try again later.',
        },
      });
      expect(register).toHaveBeenCalledTimes(5);
    } finally {
      await app.close();
    }
  });
});
