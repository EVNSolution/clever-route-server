import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { canAccessShopDomain } from '../modules/commerce/admin-commerce-auth.js';
import type { AdminCommerceActor } from '../modules/commerce/admin-commerce-auth.js';
import {
  DestinationTipConflictError,
  DestinationTipSourceError,
  destinationTipCategories,
  destinationTipSeverities,
  destinationTipStatuses,
} from '../modules/dsv/dsv-control.repository.js';
import type {
  DsvControlRepository,
} from '../modules/dsv/dsv-control.repository.js';
import {
  clearAdminWebSessionCookie,
  createAdminWebSession,
  verifyAdminWebCsrfToken,
  verifyAdminWebLoginSecret,
  verifyAdminWebSessionFromRequest,
} from './admin-ui-session.js';

const apiRoot = '/api/dsv';
const cookiePath = `${apiRoot}/`;
const sessionSubjectPrefix = 'dsv-shop:';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type DsvControlDependencies = {
  allowedShopDomains: AdminCommerceActor['allowedShopDomains'];
  cookieName: string;
  loginId: string;
  loginSecret: string;
  repository: DsvControlRepository;
  secureCookies: boolean;
  sessionSecret: string;
};

export function registerDsvControlRoutes(app: FastifyInstance, dependencies: DsvControlDependencies): void {
  app.post(`${apiRoot}/auth/login`, async (request, reply) => {
    const body = objectBody(request.body);
    const id = readTrimmed(body?.id);
    const password = readTrimmed(body?.password);
    const shopDomain = normalizeShopDomain(readTrimmed(body?.shopDomain));
    if (id === null || password === null || shopDomain === null) {
      return sendError(reply, 400, 'BAD_REQUEST', 'ID, password, and shopDomain are required');
    }
    if (id !== dependencies.loginId || !verifyAdminWebLoginSecret({ candidate: password, expected: dependencies.loginSecret })) {
      return sendError(reply, 401, 'UNAUTHORIZED', '로그인 정보가 올바르지 않습니다.');
    }
    if (!canAccessShopDomain(actor(dependencies), shopDomain) || !(await dependencies.repository.hasShop(shopDomain))) {
      return sendError(reply, 404, 'NOT_FOUND', 'Customer workspace not found');
    }
    const { cookieHeader, session } = createAdminWebSession({
      cookieName: dependencies.cookieName,
      path: cookiePath,
      secure: dependencies.secureCookies,
      sessionSecret: dependencies.sessionSecret,
      subject: `${sessionSubjectPrefix}${shopDomain}`,
    });
    return sendData(reply.header('Set-Cookie', cookieHeader), {
      csrfToken: session.csrfToken,
      expiresAt: new Date(session.expiresAt).toISOString(),
      shopDomain,
    });
  });

  app.post(`${apiRoot}/auth/logout`, async (request, reply) => {
    const session = readDsvSession(request, dependencies);
    if (session === null) return sendError(reply, 401, 'UNAUTHORIZED', 'DSV login required');
    if (!verifyAdminWebCsrfToken({ session: session.session, token: request.headers['x-csrf-token'] as string | undefined })) {
      return sendError(reply, 403, 'FORBIDDEN', 'Invalid CSRF token');
    }
    return sendData(reply.header('Set-Cookie', clearAdminWebSessionCookie({
      cookieName: dependencies.cookieName,
      path: cookiePath,
      secure: dependencies.secureCookies,
    })), { loggedOut: true });
  });

  app.get(`${apiRoot}/auth/session`, async (request, reply) => {
    const session = readDsvSession(request, dependencies);
    if (session === null) return sendError(reply, 401, 'UNAUTHORIZED', 'DSV login required');
    return sendData(reply, {
      csrfToken: session.session.csrfToken,
      expiresAt: new Date(session.session.expiresAt).toISOString(),
      shopDomain: session.shopDomain,
    });
  });

  app.get(`${apiRoot}/control/delivery-stops/:deliveryStopId/context`, async (request, reply) =>
    withDsvSession(request, reply, dependencies, async ({ shopDomain }) => {
      const deliveryStopId = readUuidParam(request, 'deliveryStopId');
      if (deliveryStopId === null) return sendError(reply, 400, 'BAD_REQUEST', 'deliveryStopId must be a UUID');
      const context = await dependencies.repository.getDeliveryStopContext({ deliveryStopId, shopDomain });
      return context === null
        ? sendError(reply, 404, 'NOT_FOUND', 'Delivery stop not found')
        : sendData(reply, context);
    }));

  app.get(`${apiRoot}/destinations/:destinationId/tips`, async (request, reply) =>
    withDsvSession(request, reply, dependencies, async ({ shopDomain }) => {
      const destinationId = readUuidParam(request, 'destinationId');
      if (destinationId === null) return sendError(reply, 400, 'BAD_REQUEST', 'destinationId must be a UUID');
      const statusValue = readQuery(request, 'status') ?? 'active';
      if (!includes(destinationTipStatuses, statusValue)) return sendError(reply, 400, 'BAD_REQUEST', 'Invalid tip status');
      const tips = await dependencies.repository.listDestinationTips({ destinationId, shopDomain, status: statusValue });
      return tips === null ? sendError(reply, 404, 'NOT_FOUND', 'Destination not found') : sendData(reply, { tips });
    }));

  app.post(`${apiRoot}/destinations/:destinationId/tips`, async (request, reply) =>
    withDsvMutation(request, reply, dependencies, async ({ actor: actorId, shopDomain }) => {
      const destinationId = readUuidParam(request, 'destinationId');
      if (destinationId === null) return sendError(reply, 400, 'BAD_REQUEST', 'destinationId must be a UUID');
      const body = objectBody(request.body);
      const category = readEnum(body?.category, destinationTipCategories);
      const severity = readEnum(body?.severity, destinationTipSeverities);
      const title = readBoundedText(body?.title, 80);
      const text = readBoundedText(body?.body, 1_000);
      const sourceDeliveryStopId = readOptionalUuid(body?.sourceDeliveryStopId);
      if (category === null || severity === null || title === null || text === null || sourceDeliveryStopId === undefined) {
        return sendError(reply, 400, 'BAD_REQUEST', 'Invalid destination tip payload');
      }
      try {
        const tip = await dependencies.repository.createDestinationTip({
          actor: actorId,
          body: text,
          category,
          destinationId,
          severity,
          shopDomain,
          sourceDeliveryStopId,
          title,
        });
        return tip === null ? sendError(reply, 404, 'NOT_FOUND', 'Destination not found') : sendData(reply, { tip }, 201);
      } catch (error) {
        if (error instanceof DestinationTipSourceError) return sendError(reply, 400, 'BAD_REQUEST', error.message);
        throw error;
      }
    }));

  app.patch(`${apiRoot}/destinations/:destinationId/tips/:tipId`, async (request, reply) =>
    withDsvMutation(request, reply, dependencies, async ({ actor: actorId, shopDomain }) => {
      const destinationId = readUuidParam(request, 'destinationId');
      const tipId = readUuidParam(request, 'tipId');
      if (destinationId === null || tipId === null) return sendError(reply, 400, 'BAD_REQUEST', 'Destination and tip ids must be UUIDs');
      const body = objectBody(request.body);
      const revision = readPositiveInteger(body?.revision);
      const category = readOptionalEnum(body?.category, destinationTipCategories);
      const severity = readOptionalEnum(body?.severity, destinationTipSeverities);
      const status = readOptionalEnum(body?.status, destinationTipStatuses);
      const title = readOptionalBoundedText(body?.title, 80);
      const text = readOptionalBoundedText(body?.body, 1_000);
      if (revision === null || category === null || severity === null || status === null || title === null || text === null) {
        return sendError(reply, 400, 'BAD_REQUEST', 'Invalid destination tip update');
      }
      if ([category, severity, status, title, text].every((value) => value === undefined)) {
        return sendError(reply, 400, 'BAD_REQUEST', 'Destination tip update is empty');
      }
      try {
        const tip = await dependencies.repository.updateDestinationTip({
          actor: actorId,
          ...(text === undefined ? {} : { body: text }),
          ...(category === undefined ? {} : { category }),
          destinationId,
          revision,
          ...(severity === undefined ? {} : { severity }),
          shopDomain,
          ...(status === undefined ? {} : { status }),
          tipId,
          ...(title === undefined ? {} : { title }),
        });
        return tip === null ? sendError(reply, 404, 'NOT_FOUND', 'Destination tip not found') : sendData(reply, { tip });
      } catch (error) {
        if (error instanceof DestinationTipConflictError) {
          return sendError(reply, 409, 'TIP_REVISION_CONFLICT', error.message, { currentRevision: error.currentRevision });
        }
        throw error;
      }
    }));
}

function actor(dependencies: DsvControlDependencies): AdminCommerceActor {
  return { allowedShopDomains: dependencies.allowedShopDomains, subject: dependencies.loginId };
}

function readDsvSession(request: FastifyRequest, dependencies: DsvControlDependencies): {
  actor: string;
  session: NonNullable<ReturnType<typeof verifyAdminWebSessionFromRequest>>;
  shopDomain: string;
} | null {
  const session = verifyAdminWebSessionFromRequest({
    cookieName: dependencies.cookieName,
    request,
    sessionSecret: dependencies.sessionSecret,
  });
  if (session === null || !session.subject.startsWith(sessionSubjectPrefix)) return null;
  const shopDomain = normalizeShopDomain(session.subject.slice(sessionSubjectPrefix.length));
  if (shopDomain === null || !canAccessShopDomain(actor(dependencies), shopDomain)) return null;
  return { actor: dependencies.loginId, session, shopDomain };
}

async function withDsvSession(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: DsvControlDependencies,
  handler: (session: NonNullable<ReturnType<typeof readDsvSession>>) => Promise<unknown>,
): Promise<unknown> {
  const session = readDsvSession(request, dependencies);
  if (session === null) return sendError(reply, 401, 'UNAUTHORIZED', 'DSV login required');
  try {
    return await handler(session);
  } catch (error) {
    request.log.error({ err: error }, 'DSV API request failed');
    if (isPrismaSchemaDriftError(error)) {
      return sendError(reply, 503, 'DSV_SCHEMA_NOT_READY', 'DSV storage schema is not up to date. Apply the delivery API migration and retry.');
    }
    return sendError(reply, 500, 'DSV_REQUEST_FAILED', 'DSV API request failed');
  }
}

async function withDsvMutation(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: DsvControlDependencies,
  handler: (session: NonNullable<ReturnType<typeof readDsvSession>>) => Promise<unknown>,
): Promise<unknown> {
  return withDsvSession(request, reply, dependencies, async (session) => {
    if (!verifyAdminWebCsrfToken({ session: session.session, token: request.headers['x-csrf-token'] as string | undefined })) {
      return sendError(reply, 403, 'FORBIDDEN', 'Invalid CSRF token');
    }
    return handler(session);
  });
}

function sendData<T>(reply: FastifyReply, data: T, statusCode = 200): unknown {
  return reply.code(statusCode).type('application/json; charset=utf-8').header('Cache-Control', 'private, no-store').send({ data, error: null });
}

function sendError(
  reply: FastifyReply,
  statusCode: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): unknown {
  return reply.code(statusCode).type('application/json; charset=utf-8').header('Cache-Control', 'private, no-store').send({
    data: null,
    error: { code, ...(details === undefined ? {} : { details }), message },
  });
}

function objectBody(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readTrimmed(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function normalizeShopDomain(value: string | null): string | null {
  if (value === null) return null;
  const domain = value.toLowerCase().replace(/^https?:\/\//u, '').replace(/\/.*$/u, '');
  return /^[a-z0-9.-]+$/u.test(domain) ? domain : null;
}

function readUuidParam(request: FastifyRequest, name: string): string | null {
  const params = request.params as Record<string, unknown>;
  const value = readTrimmed(params[name]);
  return value !== null && uuidPattern.test(value) ? value : null;
}

function readQuery(request: FastifyRequest, name: string): string | null {
  const query = request.query as Record<string, unknown>;
  return readTrimmed(query[name]);
}

function readBoundedText(value: unknown, maxLength: number): string | null {
  const text = readTrimmed(value);
  return text !== null && text.length <= maxLength ? text : null;
}

function readOptionalBoundedText(value: unknown, maxLength: number): string | null | undefined {
  return value === undefined ? undefined : readBoundedText(value, maxLength);
}

function readOptionalUuid(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  const id = readTrimmed(value);
  return id !== null && uuidPattern.test(id) ? id : undefined;
}

function readPositiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function readEnum<const T extends readonly string[]>(value: unknown, values: T): T[number] | null {
  return typeof value === 'string' && includes(values, value) ? value : null;
}

function readOptionalEnum<const T extends readonly string[]>(value: unknown, values: T): T[number] | null | undefined {
  return value === undefined ? undefined : readEnum(value, values);
}

function includes<const T extends readonly string[]>(values: T, value: string): value is T[number] {
  return (values as readonly string[]).includes(value);
}

function isPrismaSchemaDriftError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error.code === 'P2021' || error.code === 'P2022');
}
