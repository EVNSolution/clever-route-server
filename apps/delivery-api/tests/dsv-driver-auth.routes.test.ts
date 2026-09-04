import { describe, expect, test, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import {
  DsvDriverAuthConflictError,
  DsvDriverAuthCredentialsError,
  DsvDriverAuthRefreshError,
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
  test('redacts caught DSV auth errors even when caller serializers request raw errors', async () => {
    const privateMessage = 'password=dsv-secret dsv@example.invalid +82 10 9000 0001 71 DSV Road';
    const logLines: string[] = [];
    const app = await buildApp({
      dsvDriverAuth: {
        jwtSecret: 'test-jwt-secret',
        repository: { login: vi.fn(() => Promise.reject(new Error(privateMessage))) } as never
      },
      logger: {
        level: 'error',
        serializers: {
          err: () => ({ message: privateMessage, stack: privateMessage, type: 'RawError' }),
          error: () => ({ message: privateMessage, stack: privateMessage })
        },
        stream: { write: (line: string) => logLines.push(line) }
      }
    });

    try {
      const response = await app.inject({
        method: 'POST',
        payload: { loginId: 'driver.one', password: 'valid-password' },
        url: '/api/dsv/driver/auth/login'
      });

      expect(response.statusCode).toBe(500);
      const serialized = logLines.join('\n');
      expect(serialized).toContain('errorCode');
      expect(serialized).not.toContain(privateMessage);
      expect(serialized).not.toContain('dsv-secret');
      expect(serialized).not.toContain('dsv@example.invalid');
      expect(serialized).not.toContain('stack');
    } finally {
      await app.close();
    }
  });

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
          residentNumberFront: null,
          signupInviteToken: null,
        },
        url: '/api/dsv/driver/auth/register',
      });

      expect(response.statusCode).toBe(201);
      expect(register).toHaveBeenCalledWith({
        loginId: 'driver.one',
        name: 'QA 배송원 01',
        password: 'test-password-01',
        phone: '01090000001',
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

  test('accepts direct app signup with name and phone and no invite token', async () => {
    const register = vi.fn<DsvDriverAuthRepository['register']>(() => Promise.resolve(session));
    const app = await buildApp({
      dsvDriverAuth: { jwtSecret: 'test-jwt-secret', repository: { register } as never },
    });

    try {
      const response = await app.inject({
        method: 'POST',
        payload: {
          loginId: ' Driver.Direct ',
          name: '  QA 배송원 01  ',
          password: 'test-password-01',
          phone: '010-9000-0001',
        },
        url: '/api/dsv/driver/auth/register',
      });

      expect(response.statusCode).toBe(201);
      expect(register).toHaveBeenCalledWith({
        loginId: 'driver.direct',
        name: 'QA 배송원 01',
        password: 'test-password-01',
        phone: '01090000001',
      });
    } finally {
      await app.close();
    }
  });

  test('accepts only null legacy signup fields and never forwards them to the repository', async () => {
    const register = vi.fn<DsvDriverAuthRepository['register']>(() => Promise.resolve(session));
    const app = await buildApp({
      dsvDriverAuth: { jwtSecret: 'test-jwt-secret', repository: { register } as never },
    });

    try {
      const explicitNull = await app.inject({
        method: 'POST',
        payload: {
          loginId: 'driver.null',
          name: 'QA 배송원 01',
          password: 'test-password-01',
          phone: '01090000001',
          residentNumberFront: null,
          signupInviteToken: null,
        },
        url: '/api/dsv/driver/auth/register',
      });
      const omitted = await app.inject({
        method: 'POST',
        payload: {
          loginId: 'driver.omitted',
          name: 'QA 배송원 01',
          password: 'test-password-01',
          phone: '01090000002',
        },
        url: '/api/dsv/driver/auth/register',
      });
      const residentValue = await app.inject({
        method: 'POST',
        payload: {
          loginId: 'driver.resident',
          name: 'QA 배송원 01',
          password: 'test-password-01',
          phone: '01090000003',
          residentNumberFront: '9001011',
        },
        url: '/api/dsv/driver/auth/register',
      });
      const inviteValue = await app.inject({
        method: 'POST',
        payload: {
          loginId: 'driver.invite',
          name: 'QA 배송원 01',
          password: 'test-password-01',
          phone: '01090000004',
          signupInviteToken: 'A'.repeat(43),
        },
        url: '/api/dsv/driver/auth/register',
      });

      expect(explicitNull.statusCode).toBe(201);
      expect(omitted.statusCode).toBe(201);
      expect(residentValue.statusCode).toBe(400);
      expect(inviteValue.statusCode).toBe(400);
      expect(register).toHaveBeenNthCalledWith(1, {
        loginId: 'driver.null',
        name: 'QA 배송원 01',
        password: 'test-password-01',
        phone: '01090000001',
      });
      expect(register).toHaveBeenNthCalledWith(2, {
        loginId: 'driver.omitted',
        name: 'QA 배송원 01',
        password: 'test-password-01',
        phone: '01090000002',
      });
      expect(register).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });

  test('does not expose the retired signup invite validation endpoint', async () => {
    const app = await buildApp({
      dsvDriverAuth: { jwtSecret: 'test-jwt-secret', repository: {} as never },
    });

    try {
      const response = await app.inject({
        method: 'POST',
        payload: { token: 'A'.repeat(43) },
        url: '/api/dsv/driver/auth/signup-invite/validate',
      });

      expect(response.statusCode).toBe(404);
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

  test('accepts normalized email addresses for registration and login', async () => {
    const register = vi.fn<DsvDriverAuthRepository['register']>(() => Promise.resolve(session));
    const login = vi.fn<DsvDriverAuthRepository['login']>(() => Promise.resolve(session));
    const app = await buildApp({
      dsvDriverAuth: { jwtSecret: 'test-jwt-secret', repository: { login, register } as never },
    });

    try {
      const registration = await app.inject({
        method: 'POST',
        payload: {
          loginId: ' Driver.Name+DSV@Example.CO.KR ',
          name: 'QA 배송원 01',
          password: 'test-password-01',
          phone: '01090000001',
        },
        url: '/api/dsv/driver/auth/register',
      });
      const loginResponse = await app.inject({
        method: 'POST',
        payload: { loginId: ' Driver.Name+DSV@Example.CO.KR ', password: 'test-password-01' },
        url: '/api/dsv/driver/auth/login',
      });

      expect(registration.statusCode).toBe(201);
      expect(loginResponse.statusCode).toBe(200);
      expect(register).toHaveBeenCalledWith(expect.objectContaining({ loginId: 'driver.name+dsv@example.co.kr' }));
      expect(login).toHaveBeenCalledWith({ loginId: 'driver.name+dsv@example.co.kr', password: 'test-password-01' });
    } finally {
      await app.close();
    }
  });

  test('accepts an email login identifier at the 254-character limit', async () => {
    const loginId = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`;
    const register = vi.fn<DsvDriverAuthRepository['register']>(() => Promise.resolve(session));
    const app = await buildApp({
      dsvDriverAuth: { jwtSecret: 'test-jwt-secret', repository: { register } as never },
    });

    try {
      const response = await app.inject({
        method: 'POST',
        payload: {
          loginId,
          name: 'QA 배송원 01',
          password: 'test-password-01',
          phone: '01090000001',
        },
        url: '/api/dsv/driver/auth/register',
      });

      expect(loginId).toHaveLength(254);
      expect(response.statusCode).toBe(201);
      expect(register).toHaveBeenCalledWith(expect.objectContaining({ loginId }));
    } finally {
      await app.close();
    }
  });

  test('rejects invalid email login identifiers for registration and login', async () => {
    const register = vi.fn<DsvDriverAuthRepository['register']>(() => Promise.resolve(session));
    const login = vi.fn<DsvDriverAuthRepository['login']>(() => Promise.resolve(session));
    const app = await buildApp({
      dsvDriverAuth: { jwtSecret: 'test-jwt-secret', repository: { login, register } as never },
    });

    try {
      const invalidLoginIds = [
        'driver name@example.com',
        'driver@@example.com',
        'driver@',
        `${'a'.repeat(65)}@example.com`,
        `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}.com`,
      ];
      for (const loginId of invalidLoginIds) {
        const registration = await app.inject({
          method: 'POST',
          payload: {
            loginId,
            name: 'QA 배송원 01',
            password: 'test-password-01',
            phone: '01090000001',
          },
          url: '/api/dsv/driver/auth/register',
        });
        const loginResponse = await app.inject({
          method: 'POST',
          payload: { loginId, password: 'test-password-01' },
          url: '/api/dsv/driver/auth/login',
        });

        expect(registration.statusCode).toBe(400);
        expect(loginResponse.statusCode).toBe(400);
      }
      expect(register).not.toHaveBeenCalled();
      expect(login).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('refreshes a DSV account session without asking for the password again', async () => {
    const refresh = vi.fn<DsvDriverAuthRepository['refresh']>(() => Promise.resolve(session));
    const app = await buildApp({
      dsvDriverAuth: { jwtSecret: 'test-jwt-secret', repository: { refresh } as never },
    });

    try {
      const response = await app.inject({
        method: 'POST',
        payload: { refreshToken: ' refresh-token ' },
        url: '/api/dsv/driver/auth/refresh',
      });

      expect(response.statusCode).toBe(200);
      expect(refresh).toHaveBeenCalledWith({ refreshToken: 'refresh-token' });
      expect(response.json()).toMatchObject({
        data: {
          account: session.account,
          refreshToken: 'refresh-token',
          use: 'dsv_driver_account',
        },
        error: null,
      });
    } finally {
      await app.close();
    }
  });

  test('rejects missing and expired DSV refresh sessions', async () => {
    const refresh = vi.fn<DsvDriverAuthRepository['refresh']>(() => Promise.reject(new DsvDriverAuthRefreshError()));
    const app = await buildApp({
      dsvDriverAuth: { jwtSecret: 'test-jwt-secret', repository: { refresh } as never },
    });

    try {
      const missing = await app.inject({
        method: 'POST',
        payload: {},
        url: '/api/dsv/driver/auth/refresh',
      });
      const expired = await app.inject({
        method: 'POST',
        payload: { refreshToken: 'expired-token' },
        url: '/api/dsv/driver/auth/refresh',
      });

      expect(missing.statusCode).toBe(400);
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(expired.statusCode).toBe(401);
      expect(expired.json()).toEqual({
        data: null,
        error: { code: 'SESSION_EXPIRED', message: 'Invalid or expired refresh token' },
      });
    } finally {
      await app.close();
    }
  });

  test('uses bounded validation and stable public conflict and credential errors', async () => {
    const register = vi.fn<DsvDriverAuthRepository['register']>(() => Promise.reject(new DsvDriverAuthConflictError()));
    const login = vi.fn<DsvDriverAuthRepository['login']>(() => Promise.reject(new DsvDriverAuthCredentialsError()));
    const app = await buildApp({
      dsvDriverAuth: { jwtSecret: 'test-jwt-secret', repository: { login, register } as never },
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
