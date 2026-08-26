import type { FastifyInstance } from 'fastify';

import {
  DsvDriverAuthConflictError,
  DsvDriverAuthCredentialsError,
  DsvDriverAuthRefreshError,
  DsvDriverSignupInviteError,
  type DsvDriverAuthRepository,
  type DsvDriverAuthSession,
} from '../modules/dsv/dsv-driver-auth.repository.js';
import {
  normalizeDsvDriverLoginId,
  normalizeDsvDriverPhone,
} from '../modules/dsv/dsv-driver-identity.js';
import { signDriverAccountToken } from '../modules/driver/driver-token-verifier.js';
import { DSV_DRIVER_SIGNUP_TOKEN_PATTERN } from '../modules/dsv/dsv-driver-signup-invite.js';

export type DsvDriverAuthDependencies = {
  jwtSecret: string;
  repository: DsvDriverAuthRepository;
};

const DRIVER_ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const LOGIN_ID_PATTERN = /^[a-z0-9._-]{4,40}$/u;
const PHONE_PATTERN = /^01\d{8,9}$/u;
const RESIDENT_NUMBER_FRONT_PATTERN = /^\d{7}$/u;

export function registerDsvDriverAuthRoutes(
  app: FastifyInstance,
  dependencies: DsvDriverAuthDependencies,
): void {
  app.post<{ Body: unknown }>('/api/dsv/driver/auth/signup-invite/validate', {
    config: {
      rateLimit: {
        groupId: 'dsv-driver-signup-invite-validate',
        max: 10,
        timeWindow: '15 minutes',
      },
    },
  }, async (request, reply) => {
    const token = readSignupInviteToken(request.body);
    if (token === null) {
      return reply.code(400).send({
        data: null,
        error: { code: 'BAD_REQUEST', message: 'A valid signup invite token is required' },
      });
    }
    try {
      const invite = await dependencies.repository.validateSignupInvite({ token });
      return reply.code(200).send({ data: { invite }, error: null });
    } catch (error) {
      if (error instanceof DsvDriverSignupInviteError) {
        return reply.code(401).send({
          data: null,
          error: { code: 'INVALID_SIGNUP_INVITE', message: error.message },
        });
      }
      request.log.error({ err: error }, 'DSV driver signup invite validation failed');
      return reply.code(500).send({
        data: null,
        error: { code: 'INTERNAL_SERVER_ERROR', message: 'Signup invite could not be validated' },
      });
    }
  });

  app.post<{ Body: unknown }>('/api/dsv/driver/auth/register', {
    config: {
      rateLimit: {
        groupId: 'dsv-driver-register',
        max: 5,
        timeWindow: '15 minutes',
      },
    },
  }, async (request, reply) => {
    const input = readRegistrationInput(request.body);
    if (input === null) {
      return reply.code(400).send({
        data: null,
        error: { code: 'BAD_REQUEST', message: 'Invalid DSV driver registration input' },
      });
    }
    try {
      const session = await dependencies.repository.register(input);
      return reply.code(201).send(buildSessionResponse(session, dependencies.jwtSecret));
    } catch (error) {
      if (error instanceof DsvDriverAuthConflictError) {
        return reply.code(409).send({
          data: null,
          error: { code: 'ACCOUNT_EXISTS', message: error.message },
        });
      }
      if (error instanceof DsvDriverSignupInviteError) {
        return reply.code(401).send({
          data: null,
          error: { code: 'INVALID_SIGNUP_INVITE', message: error.message },
        });
      }
      request.log.error({ err: error }, 'DSV driver registration failed');
      return reply.code(500).send({
        data: null,
        error: { code: 'INTERNAL_SERVER_ERROR', message: 'DSV driver account could not be created' },
      });
    }
  });

  app.post<{ Body: unknown }>('/api/dsv/driver/auth/login', {
    config: {
      rateLimit: {
        groupId: 'dsv-driver-login',
        max: 10,
        timeWindow: '15 minutes',
      },
    },
  }, async (request, reply) => {
    const input = readLoginInput(request.body);
    if (input === null) {
      return reply.code(400).send({
        data: null,
        error: { code: 'BAD_REQUEST', message: 'loginId and password are required' },
      });
    }
    try {
      const session = await dependencies.repository.login(input);
      return reply.code(200).send(buildSessionResponse(session, dependencies.jwtSecret));
    } catch (error) {
      if (error instanceof DsvDriverAuthCredentialsError) {
        return reply.code(401).send({
          data: null,
          error: { code: 'INVALID_CREDENTIALS', message: error.message },
        });
      }
      request.log.error({ err: error }, 'DSV driver login failed');
      return reply.code(500).send({
        data: null,
        error: { code: 'INTERNAL_SERVER_ERROR', message: 'DSV driver login could not be completed' },
      });
    }
  });

  app.post<{ Body: unknown }>('/api/dsv/driver/auth/refresh', {
    config: {
      rateLimit: {
        groupId: 'dsv-driver-refresh',
        max: 30,
        timeWindow: '15 minutes',
      },
    },
  }, async (request, reply) => {
    const input = readRefreshInput(request.body);
    if (input === null) {
      return reply.code(400).send({
        data: null,
        error: { code: 'BAD_REQUEST', message: 'refreshToken is required' },
      });
    }
    try {
      const session = await dependencies.repository.refresh(input);
      return reply.code(200).send(buildSessionResponse(session, dependencies.jwtSecret));
    } catch (error) {
      if (error instanceof DsvDriverAuthRefreshError) {
        return reply.code(401).send({
          data: null,
          error: { code: 'SESSION_EXPIRED', message: error.message },
        });
      }
      request.log.error({ err: error }, 'DSV driver session refresh failed');
      return reply.code(500).send({
        data: null,
        error: { code: 'INTERNAL_SERVER_ERROR', message: 'DSV driver session could not be refreshed' },
      });
    }
  });
}

function buildSessionResponse(session: DsvDriverAuthSession, secret: string) {
  const token = signDriverAccountToken({
    accountId: session.accountId,
    expiresInSeconds: DRIVER_ACCESS_TOKEN_TTL_SECONDS,
    subject: `driver-account:${session.accountId}`,
    tokenVersion: session.tokenVersion,
  }, { secret });
  return {
    data: {
      accessToken: token.token,
      account: session.account,
      expiresAt: token.expiresAt,
      refreshToken: session.refreshToken,
      refreshTokenExpiresAt: session.expiresAt.toISOString(),
      tokenType: 'Bearer' as const,
      ttlSeconds: DRIVER_ACCESS_TOKEN_TTL_SECONDS,
      use: 'dsv_driver_account' as const,
    },
    error: null,
  };
}

function readRegistrationInput(value: unknown) {
  const object = objectOrNull(value);
  if (object === null || !hasOnlyKeys(object, ['loginId', 'name', 'password', 'phone', 'residentNumberFront', 'signupInviteToken'])) return null;
  const loginId = typeof object.loginId === 'string' ? normalizeDsvDriverLoginId(object.loginId) : '';
  const name = typeof object.name === 'string' ? object.name.trim() : '';
  const password = typeof object.password === 'string' ? object.password : '';
  const phone = typeof object.phone === 'string' ? normalizeDsvDriverPhone(object.phone) : '';
  const residentNumberFront = object.residentNumberFront === undefined
    || object.residentNumberFront === null
    ? null
    : typeof object.residentNumberFront === 'string'
      ? object.residentNumberFront.trim()
      : undefined;
  const signupInviteToken = object.signupInviteToken === undefined
    || object.signupInviteToken === null
    ? null
    : typeof object.signupInviteToken === 'string'
      ? object.signupInviteToken.trim()
      : undefined;
  if (
    !LOGIN_ID_PATTERN.test(loginId)
    || name.length === 0
    || name.length > 80
    || password.length < 8
    || password.length > 128
    || !PHONE_PATTERN.test(phone)
    || residentNumberFront === undefined
    || (residentNumberFront !== null && !RESIDENT_NUMBER_FRONT_PATTERN.test(residentNumberFront))
    || signupInviteToken === undefined
    || (signupInviteToken !== null && !DSV_DRIVER_SIGNUP_TOKEN_PATTERN.test(signupInviteToken))
  ) return null;
  return { loginId, name, password, phone, residentNumberFront, signupInviteToken };
}

function readSignupInviteToken(value: unknown): string | null {
  const object = objectOrNull(value);
  if (object === null || !hasOnlyKeys(object, ['token'])) return null;
  const token = typeof object.token === 'string' ? object.token.trim() : '';
  return DSV_DRIVER_SIGNUP_TOKEN_PATTERN.test(token) ? token : null;
}

function readLoginInput(value: unknown) {
  const object = objectOrNull(value);
  if (object === null || !hasOnlyKeys(object, ['loginId', 'password'])) return null;
  const loginId = typeof object.loginId === 'string' ? normalizeDsvDriverLoginId(object.loginId) : '';
  const password = typeof object.password === 'string' ? object.password : '';
  return LOGIN_ID_PATTERN.test(loginId) && password.length >= 8 && password.length <= 128
    ? { loginId, password }
    : null;
}

function readRefreshInput(value: unknown) {
  const object = objectOrNull(value);
  if (object === null || !hasOnlyKeys(object, ['refreshToken'])) return null;
  const refreshToken = typeof object.refreshToken === 'string' ? object.refreshToken.trim() : '';
  return refreshToken.length > 0 ? { refreshToken } : null;
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasOnlyKeys(object: Record<string, unknown>, allowed: string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(object).every((key) => allowedKeys.has(key));
}
