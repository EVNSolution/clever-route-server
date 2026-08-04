import type { FastifyInstance } from 'fastify';

import {
  CustomerEmailNotFoundError,
  CustomerEmailValidationError,
  readCustomerEmailCommandPayload,
  readCustomerEmailTestPayload,
  type CustomerEmailService,
} from '../modules/customer-email/customer-email.service.js';
import {
  CustomerEmailTransportConfigurationError,
  CustomerEmailTransportSendError,
} from '../modules/customer-email/customer-email-transport.js';
import {
  logRejectedAdminSessionToken,
  type AdminSessionTokenVerifier,
} from './admin-session-auth.js';
import { DEFAULT_SHOPIFY_APP_ID } from '../modules/shopify/shopify-app-scope.js';

export type AdminCustomerEmailDependencies = {
  customerEmailService: CustomerEmailService;
  sessionTokenVerifier: AdminSessionTokenVerifier;
};

export function registerAdminCustomerEmailRoutes(
  app: FastifyInstance,
  dependencies: AdminCustomerEmailDependencies,
): void {
  app.get('/admin/customer-email/settings', async (request, reply) => {
    const authenticated = authenticate(request.headers.authorization, request.headers['x-clever-app-id'], dependencies, request.log);
    if (authenticated.status === 'unauthorized') return reply.code(401).send(errorResponse('UNAUTHORIZED', authenticated.message));
    const customerEmailSettings = await dependencies.customerEmailService.getSettings(authenticated);
    if (customerEmailSettings === null) return reply.code(404).send(errorResponse('NOT_FOUND', 'Shop not found'));
    return reply.code(200).send({ data: { customerEmailSettings }, error: null });
  });

  app.patch<{ Body: unknown }>('/admin/customer-email/settings', async (request, reply) => {
    const authenticated = authenticate(request.headers.authorization, request.headers['x-clever-app-id'], dependencies, request.log);
    if (authenticated.status === 'unauthorized') return reply.code(401).send(errorResponse('UNAUTHORIZED', authenticated.message));
    try {
      const customerEmailSettings = await dependencies.customerEmailService.saveSettings({
        ...authenticated,
        payload: request.body,
      });
      if (customerEmailSettings === null) return reply.code(404).send(errorResponse('NOT_FOUND', 'Shop not found'));
      return reply.code(200).send({ data: { customerEmailSettings }, error: null });
    } catch (error) {
      if (error instanceof Error) return reply.code(400).send(errorResponse('BAD_REQUEST', error.message));
      throw error;
    }
  });

  app.post<{ Body: unknown }>('/admin/customer-email/test', async (request, reply) => {
    const correlationId = readCorrelationId(request.headers['x-correlation-id']) ?? request.id;
    const authenticated = authenticate(request.headers.authorization, request.headers['x-clever-app-id'], dependencies, request.log);
    if (authenticated.status === 'unauthorized') {
      request.log.warn({ correlationId }, 'customer email test rejected before authentication');
      return reply.code(401).send(errorResponse('UNAUTHORIZED', authenticated.message));
    }
    const payload = readCustomerEmailTestPayload(request.body);
    if (payload === null) {
      request.log.warn({ appId: authenticated.appId, correlationId, shopDomain: authenticated.shopDomain }, 'customer email test rejected because payload is invalid');
      return reply.code(400).send(errorResponse('BAD_REQUEST', 'Invalid customer email test payload'));
    }
    request.log.info({
      appId: authenticated.appId,
      correlationId,
      recipientDomain: readEmailDomain(payload.recipientEmail),
      shopDomain: authenticated.shopDomain,
      signal: payload.signal ?? 'DELIVERY_SCHEDULED',
    }, 'customer email test requested');
    try {
      const result = await dependencies.customerEmailService.sendTest({
        ...authenticated,
        ...payload,
      });
      request.log.info({
        correlationId,
        messageId: result.messageId,
        provider: result.provider,
      }, 'customer email test accepted by provider');
      return reply.code(202).send({ data: { correlationId, test: result }, error: null });
    } catch (error) {
      request.log.error({
        correlationId,
        errorName: error instanceof Error ? error.name : 'UnknownError',
        providerStatus: error instanceof CustomerEmailTransportSendError ? error.statusCode : null,
      }, 'customer email test failed');
      return sendCustomerEmailError(reply, error);
    }
  });

  app.post<{ Body: unknown; Params: { routePlanId: string } }>(
    '/admin/route-plans/:routePlanId/customer-email/preview',
    async (request, reply) => {
      const authenticated = authenticate(request.headers.authorization, request.headers['x-clever-app-id'], dependencies, request.log);
      if (authenticated.status === 'unauthorized') return reply.code(401).send(errorResponse('UNAUTHORIZED', authenticated.message));
      const payload = readCustomerEmailCommandPayload(request.body);
      if (payload === null) return reply.code(400).send(errorResponse('BAD_REQUEST', 'Invalid customer email preview payload'));
      const preview = await dependencies.customerEmailService.preview({
        ...authenticated,
        deliveryStopIds: payload.deliveryStopIds,
        routePlanId: request.params.routePlanId,
        signal: payload.signal,
      });
      if (preview === null) return reply.code(404).send(errorResponse('NOT_FOUND', 'Route plan not found'));
      return reply.code(200).send({ data: { preview }, error: null });
    },
  );

  app.post<{ Body: unknown; Params: { routePlanId: string } }>(
    '/admin/route-plans/:routePlanId/customer-email/send',
    async (request, reply) => {
      const authenticated = authenticate(request.headers.authorization, request.headers['x-clever-app-id'], dependencies, request.log);
      if (authenticated.status === 'unauthorized') return reply.code(401).send(errorResponse('UNAUTHORIZED', authenticated.message));
      const payload = readCustomerEmailCommandPayload(request.body);
      if (payload === null || payload.commandId === undefined) {
        return reply.code(400).send(errorResponse('BAD_REQUEST', 'Invalid customer email send payload'));
      }
      try {
        const dispatch = await dependencies.customerEmailService.send({
          ...authenticated,
          actor: authenticated.subject,
          commandId: payload.commandId,
          confirmed: payload.confirmed ?? false,
          deliveryStopIds: payload.deliveryStopIds,
          routePlanId: request.params.routePlanId,
          signal: payload.signal,
        });
        if (dispatch === null) return reply.code(404).send(errorResponse('NOT_FOUND', 'Route plan not found'));
        return reply.code(202).send({ data: { dispatch }, error: null });
      } catch (error) {
        return sendCustomerEmailError(reply, error);
      }
    },
  );
}

function authenticate(
  authorization: string | undefined,
  appIdHeader: string | string[] | undefined,
  dependencies: AdminCustomerEmailDependencies,
  log: Parameters<typeof logRejectedAdminSessionToken>[0]['log'],
):
  | { appId: string; shopDomain: string; status: 'authenticated'; subject: string }
  | { message: string; status: 'unauthorized' } {
  const sessionToken = readBearerToken(authorization);
  if (sessionToken === null) return { message: 'Missing bearer session token', status: 'unauthorized' };
  try {
    const verified = dependencies.sessionTokenVerifier.verify(sessionToken, {
      appId: readAppIdHeader(appIdHeader),
    });
    return {
      appId: verified.appId ?? readAppIdHeader(appIdHeader) ?? DEFAULT_SHOPIFY_APP_ID,
      shopDomain: verified.shopDomain,
      status: 'authenticated',
      subject: verified.subject,
    };
  } catch (error) {
    logRejectedAdminSessionToken({ error, log, surface: 'admin_customer_email' });
    return { message: 'Invalid bearer session token', status: 'unauthorized' };
  }
}

function sendCustomerEmailError(reply: { code: (statusCode: number) => { send: (payload: unknown) => unknown } }, error: unknown): unknown {
  if (error instanceof CustomerEmailNotFoundError) return reply.code(404).send(errorResponse('NOT_FOUND', error.message));
  if (error instanceof CustomerEmailValidationError) return reply.code(400).send(errorResponse(error.code, error.message));
  if (error instanceof CustomerEmailTransportConfigurationError) {
    return reply.code(503).send(errorResponse('CUSTOMER_EMAIL_NOT_CONFIGURED', 'Customer email transport is not configured.'));
  }
  if (error instanceof CustomerEmailTransportSendError) {
    return reply.code(502).send(errorResponse('CUSTOMER_EMAIL_SEND_FAILED', 'Customer email provider rejected the request.'));
  }
  throw error;
}

function readBearerToken(value: string | undefined): string | null {
  if (value === undefined) return null;
  const match = /^Bearer\s+(.+)$/iu.exec(value.trim());
  return match?.[1] ?? null;
}

function readAppIdHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function readCorrelationId(value: string | string[] | undefined): string | null {
  const candidate = (Array.isArray(value) ? value[0] : value)?.trim();
  return candidate && candidate.length <= 128 ? candidate : null;
}

function readEmailDomain(value: string): string | null {
  const separator = value.lastIndexOf('@');
  return separator >= 0 ? value.slice(separator + 1).trim().toLowerCase() || null : null;
}

function errorResponse(code: string, message: string): { data: null; error: { code: string; message: string } } {
  return { data: null, error: { code, message } };
}
