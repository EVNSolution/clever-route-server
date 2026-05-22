import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from 'fastify';

import type { AdminCommerceActor, AdminCommerceTokenVerifier } from '../modules/commerce/admin-commerce-auth.js';
import type {
  SafeWooCommerceConnection
} from '../modules/commerce/commerce-connection.service.js';
import {
  WooCommerceOnboardingError,
  type WooCommerceConnectionOnboardingService,
  type WooCommerceOnboardingInput,
  type WooCommerceOnboardingResult
} from '../modules/commerce/woocommerce-connection-onboarding.service.js';

export type AdminCommerceConnectionsDependencies = {
  adminTokenVerifier: AdminCommerceTokenVerifier;
  onboardingService: Pick<
    WooCommerceConnectionOnboardingService,
    | 'createConnection'
    | 'getConnection'
    | 'listConnections'
    | 'rotateCredentials'
    | 'rotateWebhookSecret'
    | 'testConnection'
    | 'updateStatus'
  >;
  publicBaseUrl?: string;
};

export function registerAdminCommerceConnectionsRoutes(
  app: FastifyInstance,
  dependencies: AdminCommerceConnectionsDependencies
): void {
  app.post<{ Body: unknown }>('/admin/commerce-connections/woocommerce/test', async (request, reply) => {
    const actor = authenticate(request.headers.authorization, dependencies, request.log);
    if (actor.status === 'unauthorized') {
      return reply.code(401).send(errorResponse('UNAUTHORIZED', actor.message));
    }

    try {
      const result = await dependencies.onboardingService.testConnection({
        actor: actor.actor,
        ...readCredentialBody(request.body)
      });
      return reply.code(200).send({ data: result, error: null });
    } catch (error) {
      return sendRouteError(reply, request.log, error);
    }
  });

  app.post<{ Body: unknown }>('/admin/commerce-connections/woocommerce', async (request, reply) => {
    const actor = authenticate(request.headers.authorization, dependencies, request.log);
    if (actor.status === 'unauthorized') {
      return reply.code(401).send(errorResponse('UNAUTHORIZED', actor.message));
    }

    try {
      const result = await dependencies.onboardingService.createConnection({
        actor: actor.actor,
        ...readCredentialBody(request.body)
      });
      return reply.code(201).send({ data: toConnectionResponse(request, dependencies, result), error: null });
    } catch (error) {
      return sendRouteError(reply, request.log, error);
    }
  });

  app.get<{ Querystring: Record<string, string | string[] | undefined> }>(
    '/admin/commerce-connections/woocommerce',
    async (request, reply) => {
      const actor = authenticate(request.headers.authorization, dependencies, request.log);
      if (actor.status === 'unauthorized') {
        return reply.code(401).send(errorResponse('UNAUTHORIZED', actor.message));
      }

      try {
        const connections = await dependencies.onboardingService.listConnections({
          actor: actor.actor,
          shopDomain: readSingleQueryString(request.query.shopDomain)
        });
        return reply.code(200).send({ data: { connections }, error: null });
      } catch (error) {
        return sendRouteError(reply, request.log, error);
      }
    }
  );

  app.get<{ Params: { connectionId: string } }>(
    '/admin/commerce-connections/woocommerce/:connectionId',
    async (request, reply) => {
      const actor = authenticate(request.headers.authorization, dependencies, request.log);
      if (actor.status === 'unauthorized') {
        return reply.code(401).send(errorResponse('UNAUTHORIZED', actor.message));
      }

      try {
        const connection = await dependencies.onboardingService.getConnection({
          actor: actor.actor,
          connectionId: request.params.connectionId
        });
        return reply.code(200).send({ data: { connection: withWebhookDelivery(request, dependencies, connection) }, error: null });
      } catch (error) {
        return sendRouteError(reply, request.log, error);
      }
    }
  );

  app.patch<{ Body: unknown; Params: { connectionId: string } }>(
    '/admin/commerce-connections/woocommerce/:connectionId/credentials',
    async (request, reply) => {
      const actor = authenticate(request.headers.authorization, dependencies, request.log);
      if (actor.status === 'unauthorized') {
        return reply.code(401).send(errorResponse('UNAUTHORIZED', actor.message));
      }

      try {
        const body = readObject(request.body);
        const connection = await dependencies.onboardingService.rotateCredentials({
          actor: actor.actor,
          connectionId: request.params.connectionId,
          consumerKey: readRequiredString(body.consumerKey, 'consumerKey'),
          consumerSecret: readRequiredString(body.consumerSecret, 'consumerSecret')
        });
        return reply.code(200).send({ data: { connection: withWebhookDelivery(request, dependencies, connection) }, error: null });
      } catch (error) {
        return sendRouteError(reply, request.log, error);
      }
    }
  );

  app.patch<{ Body: unknown; Params: { connectionId: string } }>(
    '/admin/commerce-connections/woocommerce/:connectionId/webhook-secret',
    async (request, reply) => {
      const actor = authenticate(request.headers.authorization, dependencies, request.log);
      if (actor.status === 'unauthorized') {
        return reply.code(401).send(errorResponse('UNAUTHORIZED', actor.message));
      }

      try {
        const body = request.body === undefined ? {} : readObject(request.body);
        const result = await dependencies.onboardingService.rotateWebhookSecret({
          actor: actor.actor,
          connectionId: request.params.connectionId,
          webhookSecret: readOptionalString(body.webhookSecret, 'webhookSecret')
        });
        return reply.code(200).send({ data: toConnectionResponse(request, dependencies, result), error: null });
      } catch (error) {
        return sendRouteError(reply, request.log, error);
      }
    }
  );

  app.patch<{ Body: unknown; Params: { connectionId: string } }>(
    '/admin/commerce-connections/woocommerce/:connectionId/status',
    async (request, reply) => {
      const actor = authenticate(request.headers.authorization, dependencies, request.log);
      if (actor.status === 'unauthorized') {
        return reply.code(401).send(errorResponse('UNAUTHORIZED', actor.message));
      }

      try {
        const body = readObject(request.body);
        const connection = await dependencies.onboardingService.updateStatus({
          actor: actor.actor,
          connectionId: request.params.connectionId,
          status: readStatus(body.status)
        });
        return reply.code(200).send({ data: { connection: withWebhookDelivery(request, dependencies, connection) }, error: null });
      } catch (error) {
        return sendRouteError(reply, request.log, error);
      }
    }
  );
}

function authenticate(
  authorization: string | undefined,
  dependencies: AdminCommerceConnectionsDependencies,
  log: FastifyBaseLogger
): { actor: AdminCommerceActor; status: 'authenticated' } | { message: string; status: 'unauthorized' } {
  const token = extractBearerToken(authorization);
  if (token === null) {
    return { message: 'Missing CLEVER admin bearer token', status: 'unauthorized' };
  }

  try {
    return { actor: dependencies.adminTokenVerifier.verify(token), status: 'authenticated' };
  } catch (error) {
    log.warn(
      {
        event: 'clever_admin_commerce_token_rejected',
        reason: error instanceof Error ? error.message : 'verification_failed',
        surface: 'admin_commerce_connections'
      },
      'CLEVER admin commerce token rejected'
    );
    return { message: 'Invalid CLEVER admin bearer token', status: 'unauthorized' };
  }
}

function readCredentialBody(value: unknown): Omit<WooCommerceOnboardingInput, 'actor'> {
  const body = readObject(value);
  return {
    consumerKey: readRequiredString(body.consumerKey, 'consumerKey'),
    consumerSecret: readRequiredString(body.consumerSecret, 'consumerSecret'),
    label: readOptionalString(body.label, 'label'),
    shopDomain: readRequiredString(body.shopDomain, 'shopDomain'),
    siteUrl: readRequiredString(body.siteUrl, 'siteUrl'),
    timezone: readOptionalString(body.timezone, 'timezone'),
    webhookSecret: readOptionalString(body.webhookSecret, 'webhookSecret')
  };
}

function toConnectionResponse(
  request: FastifyRequest,
  dependencies: AdminCommerceConnectionsDependencies,
  result: WooCommerceOnboardingResult
): {
  connection: ReturnType<typeof withWebhookDelivery>;
  webhookSetup?: { deliveryPath: string; deliveryUrl: string; oneTimeSecret?: string };
} {
  const connection = withWebhookDelivery(request, dependencies, result.connection);
  const webhookSetup =
    result.webhookSetup === undefined
      ? undefined
      : {
          deliveryPath: connection.webhook.deliveryPath,
          deliveryUrl: connection.webhook.deliveryUrl,
          ...(result.webhookSetup.oneTimeSecret === undefined
            ? {}
            : { oneTimeSecret: result.webhookSetup.oneTimeSecret })
        };
  return {
    connection,
    ...(webhookSetup === undefined ? {} : { webhookSetup })
  };
}

function withWebhookDelivery(
  request: FastifyRequest,
  dependencies: AdminCommerceConnectionsDependencies,
  connection: SafeWooCommerceConnection
): SafeWooCommerceConnection & { webhook: SafeWooCommerceConnection['webhook'] & { deliveryPath: string; deliveryUrl: string } } {
  const deliveryPath = `/woocommerce/webhooks/${connection.id}/orders`;
  return {
    ...connection,
    webhook: {
      ...connection.webhook,
      deliveryPath,
      deliveryUrl: `${resolveBaseUrl(request, dependencies)}${deliveryPath}`
    }
  };
}

function resolveBaseUrl(request: FastifyRequest, dependencies: AdminCommerceConnectionsDependencies): string {
  const configured = dependencies.publicBaseUrl?.trim().replace(/\/+$/u, '');
  if (configured !== undefined && configured !== '') return configured;

  const forwardedHost = readHeader(request.headers['x-forwarded-host']);
  const host = forwardedHost ?? readHeader(request.headers.host) ?? 'localhost';
  const forwardedProto = readHeader(request.headers['x-forwarded-proto']);
  const proto = forwardedProto ?? 'http';
  return `${proto}://${host}`.replace(/\/+$/u, '');
}

function sendRouteError(reply: { code(statusCode: number): { send(payload: unknown): unknown } }, log: FastifyBaseLogger, error: unknown): unknown {
  if (error instanceof WooCommerceOnboardingError) {
    return reply.code(error.httpStatus).send(errorResponse(error.code, error.message));
  }

  log.error({ event: 'admin_commerce_connection_route_failed' }, 'admin commerce connection route failed');
  return reply.code(500).send(errorResponse('INTERNAL_SERVER_ERROR', 'Admin commerce connection request failed'));
}

function errorResponse(code: string, message: string): { data: null; error: { code: string; message: string } } {
  return { data: null, error: { code, message } };
}

function readObject(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) {
    throw new WooCommerceOnboardingError('BAD_REQUEST', 'Request body must be an object', 400);
  }
  return value as Record<string, unknown>;
}

function readRequiredString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new WooCommerceOnboardingError('BAD_REQUEST', `${field} is required`, 400);
  }
  return value;
}

function readOptionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new WooCommerceOnboardingError('BAD_REQUEST', `${field} must be a string`, 400);
  }
  return value;
}

function readStatus(value: unknown): 'ACTIVE' | 'DISABLED' {
  if (value === 'ACTIVE' || value === 'DISABLED') return value;
  throw new WooCommerceOnboardingError('BAD_REQUEST', 'status must be ACTIVE or DISABLED', 400);
}

function readSingleQueryString(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function extractBearerToken(authorization: string | undefined): string | null {
  if (authorization === undefined) return null;
  const match = /^Bearer\s+(.+)$/iu.exec(authorization.trim());
  return match?.[1]?.trim() === '' ? null : match?.[1] ?? null;
}

function readHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  if (value === undefined || value.trim() === '') return undefined;
  return value.trim();
}
