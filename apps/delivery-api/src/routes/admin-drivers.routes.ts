import type { FastifyInstance } from 'fastify';

import {
  logRejectedAdminSessionToken,
  type AdminSessionAuthLogContext,
  type AdminSessionTokenVerifier
} from './admin-session-auth.js';

import { DEFAULT_SHOPIFY_APP_ID } from '../modules/shopify/shopify-app-scope.js';
import type { AdminDriverServiceContract, CreatePendingDriverInput } from '../modules/driver/admin-driver.types.js';

export type AdminDriversDependencies = {
  adminDriverService: AdminDriverServiceContract;
  sessionTokenVerifier: AdminSessionTokenVerifier;
};

type ErrorResponse = {
  data: null;
  error: { code: string; message: string };
};

export function registerAdminDriversRoutes(app: FastifyInstance, dependencies: AdminDriversDependencies): void {
  app.post<{ Body: unknown }>('/admin/drivers', async (request, reply) => {
    const authenticated = authenticate(request.headers.authorization, request.headers['x-clever-app-id'], dependencies, {
      log: request.log,
      surface: 'admin_drivers'
    });
    if (authenticated.status === 'unauthorized') {
      return reply.code(401).send(errorResponse('UNAUTHORIZED', authenticated.message));
    }

    let payload: DriverInvitePayload;
    try {
      payload = readDriverInvitePayload(request.body);
    } catch {
      return reply.code(400).send(errorResponse('BAD_REQUEST', 'Invalid driver payload'));
    }

    try {
      const driver = await dependencies.adminDriverService.createPendingDriver({
        appId: authenticated.appId,
        createdBy: authenticated.subject,
        displayName: payload.displayName,
        inviteLink: payload.inviteLink,
        phone: payload.phone,
        shopDomain: authenticated.shopDomain,
        source: payload.source
      });

      return reply.code(201).send({ data: { driver }, error: null });
    } catch (error) {
      request.log.error({ err: error }, 'admin driver creation failed');
      return reply.code(500).send(adminDriverStorageErrorResponse(error));
    }
  });

  app.get('/admin/drivers', async (request, reply) => {
    const authenticated = authenticate(request.headers.authorization, request.headers['x-clever-app-id'], dependencies, {
      log: request.log,
      surface: 'admin_drivers'
    });
    if (authenticated.status === 'unauthorized') {
      return reply.code(401).send(errorResponse('UNAUTHORIZED', authenticated.message));
    }

    try {
      const drivers = await dependencies.adminDriverService.listDrivers({
        appId: authenticated.appId,
        shopDomain: authenticated.shopDomain
      });

      return reply.code(200).send({ data: { drivers }, error: null });
    } catch (error) {
      request.log.error({ err: error }, 'admin driver listing failed');
      return reply.code(500).send(adminDriverStorageErrorResponse(error));
    }
  });

  app.delete<{ Params: { id: string } }>('/admin/drivers/:id', async (request, reply) => {
    const authenticated = authenticate(request.headers.authorization, request.headers['x-clever-app-id'], dependencies, {
      log: request.log,
      surface: 'admin_drivers'
    });
    if (authenticated.status === 'unauthorized') {
      return reply.code(401).send(errorResponse('UNAUTHORIZED', authenticated.message));
    }

    try {
      const driverId = await dependencies.adminDriverService.deleteDriver({
        appId: authenticated.appId,
        driverId: request.params.id,
        shopDomain: authenticated.shopDomain
      });

      return reply.code(200).send({ data: { driverId }, error: null });
    } catch (error) {
      request.log.error(
        {
          driverId: request.params.id,
          err: error,
          shopDomain: authenticated.shopDomain
        },
        'admin driver deletion failed'
      );
      return reply.code(404).send(errorResponse('NOT_FOUND', 'Driver not found'));
    }
  });

  app.post<{ Params: { id: string } }>('/admin/drivers/:id/regenerate-invite-code', async (request, reply) => {
    const authenticated = authenticate(request.headers.authorization, request.headers['x-clever-app-id'], dependencies, {
      log: request.log,
      surface: 'admin_drivers'
    });
    if (authenticated.status === 'unauthorized') {
      return reply.code(401).send(errorResponse('UNAUTHORIZED', authenticated.message));
    }

    try {
      const driver = await dependencies.adminDriverService.regenerateInviteCode({
        appId: authenticated.appId,
        driverId: request.params.id,
        shopDomain: authenticated.shopDomain
      });

      return reply.code(200).send({ data: { driver }, error: null });
    } catch {
      return reply.code(404).send(errorResponse('NOT_FOUND', 'Driver not found or cannot regenerate'));
    }
  });
}

type DriverInvitePayload = Pick<CreatePendingDriverInput, 'displayName' | 'inviteLink' | 'phone' | 'source'>;

function readDriverInvitePayload(value: unknown): DriverInvitePayload {
  const object = requireObject(value);
  const source = requireNonEmptyString(object.source);
  if (source !== 'clever-app-driver-invite') {
    throw new Error('invalid source');
  }

  return {
    displayName: readNullableString(object.displayName),
    inviteLink: readNullableUrl(object.inviteLink),
    phone: readPhone(object.phone),
    source
  };
}

function authenticate(
  authorization: string | undefined,
  appIdHeader: string | string[] | undefined,
  dependencies: AdminDriversDependencies,
  options: AdminSessionAuthLogContext
):
  | { appId: string; shopDomain: string; status: 'authenticated'; subject: string }
  | { message: string; status: 'unauthorized' } {
  const sessionToken = extractBearerToken(authorization);
  if (sessionToken === null) {
    return { message: 'Missing bearer session token', status: 'unauthorized' };
  }

  try {
    const expectedAppId = readHeaderValue(appIdHeader);
    const verified = dependencies.sessionTokenVerifier.verify(
      sessionToken,
      expectedAppId === null ? {} : { expectedAppId }
    );
    return {
      appId: verified.appId ?? DEFAULT_SHOPIFY_APP_ID,
      shopDomain: verified.shopDomain,
      status: 'authenticated',
      subject: verified.subject
    };
  } catch (error) {
    logRejectedAdminSessionToken({ ...options, error });
    return { message: 'Invalid Shopify session token', status: 'unauthorized' };
  }
}


function readHeaderValue(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || raw.trim() === '') return null;
  return raw.trim();
}

function extractBearerToken(authorization: string | undefined): string | null {
  if (authorization === undefined) {
    return null;
  }

  const match = /^Bearer\s+(.+)$/iu.exec(authorization.trim());
  if (match?.[1] === undefined || match[1].trim() === '') {
    return null;
  }

  return match[1].trim();
}

function errorResponse(code: string, message: string): ErrorResponse {
  return { data: null, error: { code, message } };
}

function adminDriverStorageErrorResponse(error: unknown): ErrorResponse {
  if (isPrismaSchemaDriftError(error)) {
    return errorResponse(
      'DRIVER_SCHEMA_NOT_READY',
      'Delivery driver storage schema is not up to date. Run the delivery API schema push and retry.'
    );
  }

  return errorResponse('DRIVER_STORAGE_ERROR', 'Delivery driver storage is temporarily unavailable.');
}

function isPrismaSchemaDriftError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2022';
}

function requireObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('object required');
  }

  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('non-empty string required');
  }

  return value.trim();
}

function readNullableString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const text = requireNonEmptyString(value);
  return text;
}

function readNullableUrl(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const text = requireNonEmptyString(value);
  try {
    return new URL(text).toString();
  } catch {
    throw new Error('invalid inviteLink');
  }
}

function readPhone(value: unknown): string {
  const phone = requireNonEmptyString(value);
  if (!/^\+[1-9]\d{6,14}$/u.test(phone)) {
    throw new Error('phone must be E.164');
  }
  return phone;
}
