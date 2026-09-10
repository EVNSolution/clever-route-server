import type { FastifyInstance, FastifyReply } from 'fastify';

import {
  DsvDriverAuthConflictError,
  DsvDriverAuthCredentialsError,
  DsvDriverAuthRefreshError,
  type DsvDriverAuthRepository,
  type DsvDriverAuthSession,
} from '../modules/dsv/dsv-driver-auth.repository.js';
import {
  normalizeDsvDriverLoginId,
  normalizeDsvDriverPhone,
} from '../modules/dsv/dsv-driver-identity.js';
import { signDriverAccountToken } from '../modules/driver/driver-token-verifier.js';
import { registerDsvDriverInquiryRoutes } from './dsv-driver-inquiries.routes.js';
import type { DsvDriverInquiryRepository } from '../modules/dsv/dsv-driver-inquiry.repository.js';
import {
  DsvDriverPasswordResetError,
  type DsvDriverPasswordResetService,
} from '../modules/dsv/dsv-driver-password-reset.service.js';

export type DsvDriverAuthDependencies = {
  jwtSecret: string;
  repository: DsvDriverAuthRepository;
  inquiryRepository?: DsvDriverInquiryRepository;
  passwordResetService?: DsvDriverPasswordResetService;
};

const DRIVER_ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const LOGIN_ID_PATTERN = /^[a-z0-9._-]{4,40}$/u;
const EMAIL_LOGIN_ID_PATTERN = /^(?=.{3,254}$)(?=[^@]{1,64}@)[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;
const PHONE_PATTERN = /^01\d{8,9}$/u;

export function registerDsvDriverAuthRoutes(
  app: FastifyInstance,
  dependencies: DsvDriverAuthDependencies,
): void {
  if (dependencies.inquiryRepository !== undefined) registerDsvDriverInquiryRoutes(app, dependencies.inquiryRepository, dependencies.jwtSecret);
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

  app.post<{ Body: unknown }>('/api/dsv/driver/auth/password-reset/validate', {
    config: {
      rateLimit: {
        groupId: 'dsv-driver-password-reset-validate',
        max: 20,
        timeWindow: '15 minutes',
      },
    },
  }, async (request, reply) => {
    const input = readPasswordResetTokenInput(request.body);
    if (input === null) return passwordResetTokenError(reply);
    if (dependencies.passwordResetService === undefined) {
      return reply.code(503).send({
        data: null,
        error: { code: 'PASSWORD_RESET_UNAVAILABLE', message: 'Password reset is unavailable' },
      });
    }
    const reset = await dependencies.passwordResetService.validateLink(input);
    return reset === null
      ? passwordResetTokenError(reply)
      : reply.code(200).send({
          data: { expiresAt: reset.expiresAt.toISOString(), method: reset.method, valid: true },
          error: null,
        });
  });

  app.post<{ Body: unknown }>('/api/dsv/driver/auth/password-reset/complete', {
    config: {
      rateLimit: {
        groupId: 'dsv-driver-password-reset-complete',
        max: 10,
        timeWindow: '15 minutes',
      },
    },
  }, async (request, reply) => {
    const input = readPasswordResetCompleteInput(request.body);
    if (input === null) {
      return reply.code(400).send({
        data: null,
        error: { code: 'BAD_REQUEST', message: 'Invalid password reset payload' },
      });
    }
    if (dependencies.passwordResetService === undefined) {
      return reply.code(503).send({
        data: null,
        error: { code: 'PASSWORD_RESET_UNAVAILABLE', message: 'Password reset is unavailable' },
      });
    }
    try {
      await dependencies.passwordResetService.complete({ ...input, requestId: request.id });
      return reply.code(200).send({ data: { completed: true }, error: null });
    } catch (error) {
      if (error instanceof DsvDriverPasswordResetError) {
        if (error.code === 'INVALID_TOKEN') return passwordResetTokenError(reply);
        return reply.code(error.code === 'PASSWORD_REUSED' ? 409 : 400).send({
          data: null,
          error: { code: error.code, message: error.message },
        });
      }
      request.log.error({ err: error }, 'DSV driver password reset failed');
      return reply.code(500).send({
        data: null,
        error: { code: 'INTERNAL_SERVER_ERROR', message: 'Password reset could not be completed' },
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
  const legacyFieldsAreNull = (object.residentNumberFront === undefined || object.residentNumberFront === null)
    && (object.signupInviteToken === undefined || object.signupInviteToken === null);
  if (
    !isValidLoginId(loginId)
    || name.length === 0
    || name.length > 80
    || password.length < 8
    || password.length > 128
    || !PHONE_PATTERN.test(phone)
    || !legacyFieldsAreNull
  ) return null;
  return { loginId, name, password, phone };
}

function readLoginInput(value: unknown) {
  const object = objectOrNull(value);
  if (object === null || !hasOnlyKeys(object, ['loginId', 'password'])) return null;
  const loginId = typeof object.loginId === 'string' ? normalizeDsvDriverLoginId(object.loginId) : '';
  const password = typeof object.password === 'string' ? object.password : '';
  return isValidLoginId(loginId) && password.length >= 8 && password.length <= 128
    ? { loginId, password }
    : null;
}

function isValidLoginId(value: string): boolean {
  return LOGIN_ID_PATTERN.test(value) || EMAIL_LOGIN_ID_PATTERN.test(value);
}

function readRefreshInput(value: unknown) {
  const object = objectOrNull(value);
  if (object === null || !hasOnlyKeys(object, ['refreshToken'])) return null;
  const refreshToken = typeof object.refreshToken === 'string' ? object.refreshToken.trim() : '';
  return refreshToken.length > 0 ? { refreshToken } : null;
}

function readPasswordResetTokenInput(value: unknown): { token: string } | null {
  const object = objectOrNull(value);
  if (object === null || !hasOnlyKeys(object, ['token'])) return null;
  const token = typeof object.token === 'string' ? object.token.trim() : '';
  return token.length === 43 ? { token } : null;
}

function readPasswordResetCompleteInput(value: unknown): { password: string; token: string } | null {
  const object = objectOrNull(value);
  if (object === null || !hasOnlyKeys(object, ['password', 'token'])) return null;
  const password = typeof object.password === 'string' ? object.password : '';
  const token = typeof object.token === 'string' ? object.token.trim() : '';
  return password.length >= 12 && password.length <= 128 && token.length === 43
    ? { password, token }
    : null;
}

function passwordResetTokenError(reply: FastifyReply) {
  return reply.code(401).send({
    data: null,
    error: { code: 'INVALID_RESET_LINK', message: 'Password reset link is invalid or expired' },
  });
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
