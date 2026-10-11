import type { FastifyInstance, FastifyReply, FastifyRequest, onSendHookHandler } from 'fastify';
import type { PrismaClient } from '@prisma/client';

import { verifyDriverAccountToken } from '../modules/driver/driver-token-verifier.js';
import type {
  DsvReportDeliveryExceptionInput,
  DsvStartExecutionInput,
  PrismaDsvExecutionCommandsService,
} from '../modules/dsv/dsv-execution-commands.service.js';
import { DsvExecutionCommandError } from '../modules/dsv/dsv-execution-commands.service.js';
import { DsvExecutionContextError } from '../modules/dsv/dsv-execution-context.types.js';
import {
  DsvOperationalNotificationNotFoundError,
  DsvOperationalNotificationValidationError,
} from '../modules/dsv/dsv-operational-driver-notification.service.js';
import { requireDsvScopes, type DsvAdminPrincipal, type DsvDriverPrincipal, type DsvPrincipal } from '../modules/dsv/dsv-principal.js';
import { verifyAdminWebCsrfToken, verifyAdminWebSessionFromRequest } from './admin-ui-session.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const positiveBigint = /^[1-9]\d{0,18}$/u;
const isoInstant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;

export const dsvExecutionNoStore: onSendHookHandler = (_request, reply, payload, done) => {
  reply.header('Cache-Control', 'private, no-store');
  done(null, payload);
};

export type DsvDriverExecutionAuth = {
  accountId: string;
  principal: DsvDriverPrincipal;
  shopDomain: string;
  tokenVersion: number;
};

export type DsvDriverExecutionPrincipalResolver = {
  resolve(input: { accountId: string; tokenVersion: number }): Promise<DsvDriverExecutionAuth>;
};

export class PrismaDsvDriverExecutionPrincipalResolver implements DsvDriverExecutionPrincipalResolver {
  constructor(private readonly prisma: Pick<PrismaClient, 'driver'>) {}

  async resolve(input: { accountId: string; tokenVersion: number }): Promise<DsvDriverExecutionAuth> {
    const drivers = await this.prisma.driver.findMany({
      select: { id: true, shopId: true, shop: { select: { shopDomain: true } } },
      take: 2,
      where: {
        account: { id: input.accountId, status: 'ACTIVE', tokenVersion: input.tokenVersion },
        accountId: input.accountId,
        dsvProfile: { isNot: null },
        isStoreReviewData: false,
        status: 'ACTIVE',
      },
    });
    const driver = drivers.length === 1 ? drivers[0] : undefined;
    if (driver === undefined) throw new Error('Driver account does not resolve to one active DSV driver');
    return {
      accountId: input.accountId,
      principal: {
        driverId: driver.id,
        principalType: 'DRIVER',
        scopes: ['driver:assignments:read', 'driver:events:write'],
        shopId: driver.shopId,
      },
      shopDomain: driver.shop.shopDomain,
      tokenVersion: input.tokenVersion,
    };
  }
}

export type DsvOperationalDriverNotificationApi = {
  ack(input: { ackKind: 'OPENED' | 'READ'; notificationId: string; principal: DsvPrincipal }): Promise<unknown>;
  list(input: { cursor?: string; limit?: number; principal: DsvPrincipal }): Promise<unknown>;
  registerCapability(input: {
    installationId: string;
    kinds: string[];
    principal: DsvPrincipal;
    schemaVersion: number;
    tokenId: string;
  }): Promise<unknown>;
  resolve(input: { notificationId: string; principal: DsvPrincipal }): Promise<unknown>;
};

export type DsvExecutionContextApi = {
  get(input: { executionContextId: string; principal: DsvAdminPrincipal }): Promise<unknown>;
  list(input: { principal: DsvPrincipal; serviceDate?: string }): Promise<unknown>;
  map(input: {
    commandId: string;
    effectiveAt: Date;
    executionContextId?: string;
    mapping: 'NEW_EXECUTION' | 'SAME_EXECUTION';
    principal: DsvAdminPrincipal;
    routePlanId: string;
  }): Promise<unknown>;
  select(input: {
    commandId: string;
    executionContextId: string;
    principal: DsvAdminPrincipal;
    validFrom: Date;
    validUntil: Date;
    vehicleId: string;
  }): Promise<unknown>;
};

export type DsvExecutionAdminSessionResolver = {
  resolve(subject: string): Promise<DsvPrincipal>;
};

export type DsvExecutionRouteDependencies = {
  admin?: {
    cookieName: string;
    sessionResolver: DsvExecutionAdminSessionResolver;
    sessionSecret: string;
  };
  commands: Pick<PrismaDsvExecutionCommandsService,
    | 'acknowledgeDeliveryException'
    | 'getDeliveryException'
    | 'listDeliveryExceptions'
    | 'reportDeliveryException'
    | 'resolveDeliveryException'
    | 'start'
  >;
  contexts?: DsvExecutionContextApi;
  driverJwtSecret: string;
  driverPrincipalResolver: DsvDriverExecutionPrincipalResolver;
  notifications: DsvOperationalDriverNotificationApi;
};

export function registerDsvExecutionRoutes(app: FastifyInstance, dependencies: DsvExecutionRouteDependencies): void {
  const driverOptions = { onSend: dsvExecutionNoStore };

  app.get('/api/dsv/driver/operational-notifications', driverOptions, (request, reply) =>
    withDriver(request, reply, dependencies, async (auth) => {
      const query = exactObject(request.query, ['cursor', 'limit']);
      if (query === null) return failure(reply, 400, 'BAD_REQUEST');
      const cursor = optionalString(query.cursor, 300);
      const limit = optionalIntegerString(query.limit, 1, 50);
      if ((query.cursor !== undefined && cursor === null) || (query.limit !== undefined && limit === null)) {
        return failure(reply, 400, 'BAD_REQUEST');
      }
      return success(reply, await dependencies.notifications.list({
        ...(cursor === null ? {} : { cursor }),
        ...(limit === null ? {} : { limit }),
        principal: auth.principal,
      }));
    }));

  app.get<{ Params: { id: string } }>('/api/dsv/driver/operational-notifications/:id/resolve', driverOptions, (request, reply) =>
    withDriver(request, reply, dependencies, async (auth) => {
      if (!uuid.test(request.params.id) || !isEmptyObject(request.query) || !isEmptyBody(request.body)) {
        return failure(reply, 400, 'BAD_REQUEST');
      }
      return success(reply, await dependencies.notifications.resolve({ notificationId: request.params.id, principal: auth.principal }));
    }));

  app.post<{ Params: { id: string } }>('/api/dsv/driver/operational-notifications/:id/acks', driverOptions, (request, reply) =>
    withDriver(request, reply, dependencies, async (auth) => {
      const body = exactObject(request.body, ['ackKind']);
      if (!uuid.test(request.params.id) || !isEmptyObject(request.query) || body === null) return failure(reply, 400, 'BAD_REQUEST');
      const ackKind = enumValue(body.ackKind, ['READ', 'OPENED'] as const);
      if (ackKind === null) return failure(reply, 400, 'BAD_REQUEST');
      return success(reply, await dependencies.notifications.ack({ ackKind, notificationId: request.params.id, principal: auth.principal }));
    }));

  app.post('/api/dsv/driver/operational-notifications/capability', driverOptions, (request, reply) =>
    withDriver(request, reply, dependencies, async (auth) => {
      const body = exactObject(request.body, ['installationId', 'kinds', 'schemaVersion', 'tokenId']);
      if (!isEmptyObject(request.query) || body === null) return failure(reply, 400, 'BAD_REQUEST');
      const installationId = requiredString(body.installationId, 160);
      const tokenId = typeof body.tokenId === 'string' && uuid.test(body.tokenId) ? body.tokenId : null;
      const schemaVersion = integer(body.schemaVersion, 1, 100);
      const kinds = stringArray(body.kinds, 1, 32, 80);
      if (installationId === null || tokenId === null || schemaVersion === null || kinds === null) {
        return failure(reply, 400, 'BAD_REQUEST');
      }
      return success(reply, await dependencies.notifications.registerCapability({
        installationId, kinds, principal: auth.principal, schemaVersion, tokenId,
      }));
    }));

  app.get('/api/dsv/driver/executions', driverOptions, (request, reply) =>
    withDriver(request, reply, dependencies, async (auth) => {
      const query = exactObject(request.query, ['serviceDate']);
      const serviceDate = query === null ? null : optionalDate(query.serviceDate);
      if (query === null || (query.serviceDate !== undefined && serviceDate === null)) return failure(reply, 400, 'BAD_REQUEST');
      if (dependencies.contexts === undefined) return failure(reply, 503, 'DEPENDENCY_UNAVAILABLE');
      return success(reply, await dependencies.contexts.list({ principal: auth.principal, ...(serviceDate === null ? {} : { serviceDate }) }));
    }));

  app.post<{ Params: { id: string } }>('/api/dsv/driver/executions/:id/start', driverOptions, (request, reply) =>
    withDriver(request, reply, dependencies, async (auth) => {
      const parsed = parseStartBody(request, auth, request.params.id);
      if (parsed === null) return failure(reply, 400, 'BAD_REQUEST');
      const result = await dependencies.commands.start(parsed);
      return success(reply.code(result.duplicate ? 200 : 201), result);
    }));

  app.post<{ Params: { id: string } }>('/api/dsv/driver/executions/:id/delivery-exceptions', driverOptions, (request, reply) =>
    withDriver(request, reply, dependencies, async (auth) => {
      const parsed = parseDeliveryExceptionBody(request, auth, request.params.id);
      if (parsed === null) return failure(reply, 400, 'BAD_REQUEST');
      const result = await dependencies.commands.reportDeliveryException(parsed);
      return success(reply.code(result.duplicate ? 200 : 201), result);
    }));

  if (dependencies.admin !== undefined && dependencies.contexts !== undefined) {
    app.get('/api/dsv/v1/operations/notifications', driverOptions, (request, reply) =>
      withAdmin(request, reply, dependencies, false, async (principal) => {
        const query = exactObject(request.query, ['cursor', 'limit']);
        if (query === null || !isEmptyBody(request.body)) return failure(reply, 400, 'BAD_REQUEST');
        const cursor = optionalString(query.cursor, 300);
        const limit = optionalIntegerString(query.limit, 1, 100);
        if ((query.cursor !== undefined && cursor === null) || (query.limit !== undefined && limit === null)) return failure(reply, 400, 'BAD_REQUEST');
        return success(reply, await dependencies.notifications.list({
          ...(cursor === null ? {} : { cursor }), ...(limit === null ? {} : { limit }), principal,
        }));
      }));

    app.get<{ Params: { id: string } }>('/api/dsv/v1/operations/notifications/:id/resolve', driverOptions, (request, reply) =>
      withAdmin(request, reply, dependencies, false, async (principal) => {
        if (!uuid.test(request.params.id) || !isEmptyObject(request.query) || !isEmptyBody(request.body)) return failure(reply, 400, 'BAD_REQUEST');
        return success(reply, await dependencies.notifications.resolve({ notificationId: request.params.id, principal }));
      }));

    app.post<{ Params: { id: string } }>('/api/dsv/v1/operations/notifications/:id/acks', driverOptions, (request, reply) =>
      withAdmin(request, reply, dependencies, true, async (principal) => {
        const body = exactObject(request.body, ['ackKind']);
        const ackKind = body === null ? null : enumValue(body.ackKind, ['OPENED', 'READ'] as const);
        if (!uuid.test(request.params.id) || !isEmptyObject(request.query) || ackKind === null) return failure(reply, 400, 'BAD_REQUEST');
        return success(reply, await dependencies.notifications.ack({ ackKind, notificationId: request.params.id, principal }));
      }, ['dsv:control:read', 'dsv:dispatches:write']));

    app.get('/api/dsv/v1/operations/delivery-exceptions', driverOptions, (request, reply) =>
      withAdmin(request, reply, dependencies, false, async (principal) => {
        const query = exactObject(request.query, ['cursor', 'limit']);
        if (query === null || !isEmptyBody(request.body)) return failure(reply, 400, 'BAD_REQUEST');
        const cursor = optionalString(query.cursor, 300);
        const limit = optionalIntegerString(query.limit, 1, 100);
        if ((query.cursor !== undefined && cursor === null) || (query.limit !== undefined && limit === null)) return failure(reply, 400, 'BAD_REQUEST');
        return success(reply, await dependencies.commands.listDeliveryExceptions({
          ...(cursor === null ? {} : { cursor }), ...(limit === null ? {} : { limit }), shopId: principal.shopId,
        }));
      }));

    app.get<{ Params: { id: string } }>('/api/dsv/v1/operations/delivery-exceptions/:id', driverOptions, (request, reply) =>
      withAdmin(request, reply, dependencies, false, async (principal) => {
        if (!uuid.test(request.params.id) || !isEmptyObject(request.query) || !isEmptyBody(request.body)) return failure(reply, 400, 'BAD_REQUEST');
        return success(reply, await dependencies.commands.getDeliveryException({ id: request.params.id, shopId: principal.shopId }));
      }));

    for (const transition of ['acknowledge', 'resolve'] as const) {
      app.post<{ Params: { id: string } }>(`/api/dsv/v1/operations/delivery-exceptions/:id/${transition}`, driverOptions, (request, reply) =>
        withAdmin(request, reply, dependencies, true, async (principal) => {
          if (!uuid.test(request.params.id) || !isEmptyObject(request.query) || !isEmptyObject(request.body)) return failure(reply, 400, 'BAD_REQUEST');
          const method = transition === 'acknowledge'
            ? dependencies.commands.acknowledgeDeliveryException.bind(dependencies.commands)
            : dependencies.commands.resolveDeliveryException.bind(dependencies.commands);
          return success(reply, await method({ id: request.params.id, shopId: principal.shopId }));
        }, ['dsv:control:read', 'dsv:dispatches:write']));
    }

    app.get('/api/dsv/v1/operations/executions', driverOptions, (request, reply) =>
      withAdmin(request, reply, dependencies, false, async (principal) => {
        const query = exactObject(request.query, ['serviceDate']);
        const serviceDate = query === null ? null : optionalDate(query.serviceDate);
        if (query === null || (query.serviceDate !== undefined && serviceDate === null) || !isEmptyBody(request.body)) {
          return failure(reply, 400, 'BAD_REQUEST');
        }
        return success(reply, await dependencies.contexts!.list({ principal, ...(serviceDate === null ? {} : { serviceDate }) }));
      }));

    app.get<{ Params: { id: string } }>('/api/dsv/v1/operations/executions/:id', driverOptions, (request, reply) =>
      withAdmin(request, reply, dependencies, false, async (principal) => {
        if (!uuid.test(request.params.id) || !isEmptyObject(request.query) || !isEmptyBody(request.body)) {
          return failure(reply, 400, 'BAD_REQUEST');
        }
        return success(reply, await dependencies.contexts!.get({ executionContextId: request.params.id, principal }));
      }));

    app.post('/api/dsv/v1/operations/executions/map', driverOptions, (request, reply) =>
      withAdmin(request, reply, dependencies, true, async (principal) => {
        const body = exactObject(request.body, ['commandId', 'effectiveAt', 'executionContextId', 'mapping', 'routePlanId']);
        if (!isEmptyObject(request.query) || body === null) return failure(reply, 400, 'BAD_REQUEST');
        const commandId = uuidString(body.commandId);
        const effectiveAt = instant(body.effectiveAt);
        const executionContextId = optionalUuid(body.executionContextId);
        const mapping = enumValue(body.mapping, ['NEW_EXECUTION', 'SAME_EXECUTION'] as const);
        const routePlanId = uuidString(body.routePlanId);
        if (commandId === null || effectiveAt === null || mapping === null || routePlanId === null
          || (body.executionContextId !== undefined && executionContextId === null)
          || (mapping === 'SAME_EXECUTION' && executionContextId === null)
          || (mapping === 'NEW_EXECUTION' && executionContextId !== null)) return failure(reply, 400, 'BAD_REQUEST');
        return success(reply, await dependencies.contexts!.map({
          commandId, effectiveAt, ...(executionContextId === null ? {} : { executionContextId }), mapping, principal, routePlanId,
        }));
      }));

    app.post('/api/dsv/v1/operations/executions/select', driverOptions, (request, reply) =>
      withAdmin(request, reply, dependencies, true, async (principal) => {
        const body = exactObject(request.body, ['commandId', 'executionContextId', 'validFrom', 'validUntil', 'vehicleId']);
        if (!isEmptyObject(request.query) || body === null) return failure(reply, 400, 'BAD_REQUEST');
        const commandId = uuidString(body.commandId);
        const executionContextId = uuidString(body.executionContextId);
        const validFrom = instant(body.validFrom);
        const validUntil = instant(body.validUntil);
        const vehicleId = uuidString(body.vehicleId);
        if (commandId === null || executionContextId === null || validFrom === null || validUntil === null || vehicleId === null
          || validUntil <= validFrom) return failure(reply, 400, 'BAD_REQUEST');
        return success(reply, await dependencies.contexts!.select({ commandId, executionContextId, principal, validFrom, validUntil, vehicleId }));
      }));
  }
}

function parseStartBody(
  request: FastifyRequest,
  auth: DsvDriverExecutionAuth,
  executionContextId: string,
): DsvStartExecutionInput | null {
  const body = exactObject(request.body, [
    'assignmentEpoch', 'assignmentGeneration', 'commandId', 'expectedRouteVersionId', 'occurredAt', 'routeVersion',
  ]);
  if (!uuid.test(executionContextId) || !isEmptyObject(request.query) || body === null) return null;
  const common = parseCommandFence(body);
  return common === null ? null : {
    ...common,
    accountId: auth.accountId,
    driverId: auth.principal.driverId,
    executionContextId,
    shopDomain: auth.shopDomain,
    shopId: auth.principal.shopId,
  };
}

function parseDeliveryExceptionBody(
  request: FastifyRequest,
  auth: DsvDriverExecutionAuth,
  executionContextId: string,
): DsvReportDeliveryExceptionInput | null {
  const body = exactObject(request.body, [
    'assignmentEpoch', 'assignmentGeneration', 'commandId', 'expectedRouteVersionId', 'explanation', 'occurredAt',
    'reasonCode', 'routeVersion', 'targetStopId',
  ]);
  if (!uuid.test(executionContextId) || !isEmptyObject(request.query) || body === null) return null;
  const common = parseCommandFence(body);
  const reasonCode = requiredString(body.reasonCode, 80);
  const targetStopId = uuidString(body.targetStopId);
  const explanation = optionalText(body.explanation, 1_000);
  if (common === null || reasonCode === null || targetStopId === null
    || (body.explanation !== undefined && explanation === null)) return null;
  return {
    ...common,
    accountId: auth.accountId,
    driverId: auth.principal.driverId,
    executionContextId,
    ...(explanation === undefined ? {} : { explanation }),
    reasonCode,
    shopDomain: auth.shopDomain,
    shopId: auth.principal.shopId,
    targetStopId,
  };
}

function parseCommandFence(body: Record<string, unknown>): Pick<
  DsvStartExecutionInput,
  'assignmentEpoch' | 'assignmentGeneration' | 'commandId' | 'expectedRouteVersionId' | 'occurredAt' | 'routeVersion'
> | null {
  const assignmentEpoch = bigintString(body.assignmentEpoch);
  const assignmentGeneration = bigintString(body.assignmentGeneration);
  const commandId = uuidString(body.commandId);
  const expectedRouteVersionId = uuidString(body.expectedRouteVersionId);
  const occurredAt = instant(body.occurredAt);
  const routeVersion = integer(body.routeVersion, 1, Number.MAX_SAFE_INTEGER);
  return assignmentEpoch === null || assignmentGeneration === null || commandId === null
    || expectedRouteVersionId === null || occurredAt === null || routeVersion === null
    ? null : { assignmentEpoch, assignmentGeneration, commandId, expectedRouteVersionId, occurredAt, routeVersion };
}

async function withDriver(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: DsvExecutionRouteDependencies,
  action: (auth: DsvDriverExecutionAuth) => Promise<unknown>,
): Promise<unknown> {
  const bearer = request.headers.authorization?.match(/^Bearer (\S+)$/u)?.[1];
  let auth: DsvDriverExecutionAuth;
  try {
    if (bearer === undefined) throw new Error('missing bearer');
    const token = verifyDriverAccountToken(bearer, { secret: dependencies.driverJwtSecret });
    if (!uuid.test(token.accountId)) throw new Error('invalid account');
    auth = await dependencies.driverPrincipalResolver.resolve({ accountId: token.accountId, tokenVersion: token.tokenVersion });
  } catch { return failure(reply, 401, 'UNAUTHORIZED'); }
  try { return await action(auth); } catch (error) { return mappedFailure(request, reply, error); }
}

async function withAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: DsvExecutionRouteDependencies,
  requireCsrf: boolean,
  action: (principal: DsvAdminPrincipal) => Promise<unknown>,
  requiredScopes: readonly ('dsv:control:read' | 'dsv:dispatches:write')[] = ['dsv:control:read'],
): Promise<unknown> {
  try {
    if (dependencies.admin === undefined) return failure(reply, 503, 'DEPENDENCY_UNAVAILABLE');
    const session = verifyAdminWebSessionFromRequest({
      cookieName: dependencies.admin.cookieName,
      request,
      sessionSecret: dependencies.admin.sessionSecret,
    });
    if (session === null) return failure(reply, 401, 'UNAUTHORIZED');
    if (requireCsrf && !verifyAdminWebCsrfToken({ session, token: request.headers['x-csrf-token'] as string | undefined })) {
      return failure(reply, 403, 'FORBIDDEN');
    }
    const resolved = await dependencies.admin.sessionResolver.resolve(session.subject);
    if (resolved.principalType !== 'DSV_ADMIN') return failure(reply, 403, 'FORBIDDEN');
    requireDsvScopes(resolved, requiredScopes);
    return await action(resolved);
  } catch (error) {
    return mappedFailure(request, reply, error);
  }
}

function mappedFailure(request: FastifyRequest, reply: FastifyReply, error: unknown): unknown {
  if (error instanceof DsvExecutionCommandError) {
    const status = error.code === 'UNAUTHORIZED' ? 403
      : error.code === 'CONTEXT_NOT_FOUND' || error.code === 'TARGET_NOT_FOUND' || error.code === 'REPORT_NOT_FOUND' ? 404
      : error.code === 'COMMAND_CONFLICT' || error.code === 'ASSIGNMENT_CHANGED'
        || error.code === 'CONTEXT_CLOSED' || error.code === 'ROUTE_VERSION_CHANGED'
        || error.code === 'TARGET_TERMINAL' ? 409 : 400;
    return failure(reply, status, error.code);
  }
  if (error instanceof DsvOperationalNotificationNotFoundError) return failure(reply, 404, 'NOT_FOUND');
  if (error instanceof DsvOperationalNotificationValidationError) return failure(reply, 400, 'BAD_REQUEST');
  if (error instanceof DsvExecutionContextError) {
    const status = error.code === 'EXECUTION_CONTEXT_SCOPE_INVALID' || error.code === 'ROUTE_SCOPE_INVALID' ? 404
      : error.code === 'CLOSED_EXECUTION_CONTEXT' || error.code === 'COMMAND_PAYLOAD_MISMATCH'
        || error.code === 'MAPPING_EFFECTIVE_TIME_INVALID'
        || error.code === 'NEW_EXECUTION_REQUIRES_UNMAPPED_ROUTE' || error.code === 'SELECTION_INTERVAL_OVERLAP' ? 409
      : error.code.endsWith('_SCOPE_INVALID') ? 403 : 400;
    return failure(reply, status, error.code);
  }
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'DSV_FORBIDDEN') {
    return failure(reply, 403, 'FORBIDDEN');
  }
  request.log.error({ event: 'dsv_execution_request_failed', requestId: request.id }, 'DSV execution request failed');
  return failure(reply, 500, 'INTERNAL_SERVER_ERROR');
}

function exactObject(value: unknown, allowed: readonly string[]): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return Object.keys(record).some((key) => !allowed.includes(key)) ? null : record;
}
function isEmptyObject(value: unknown): boolean { return exactObject(value, []) !== null; }
function isEmptyBody(value: unknown): boolean { return value === undefined || value === null || isEmptyObject(value); }
function uuidString(value: unknown): string | null { return typeof value === 'string' && uuid.test(value) ? value : null; }
function optionalUuid(value: unknown): string | null { return value === undefined ? null : uuidString(value); }
function bigintString(value: unknown): string | null { return typeof value === 'string' && positiveBigint.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n ? value : null; }
function integer(value: unknown, min: number, max: number): number | null { return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max ? Number(value) : null; }
function optionalIntegerString(value: unknown, min: number, max: number): number | null {
  if (value === undefined) return null;
  return typeof value === 'string' && /^\d+$/u.test(value) ? integer(Number(value), min, max) : null;
}
function instant(value: unknown): Date | null {
  if (typeof value !== 'string' || !isoInstant.test(value)) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}
function optionalDate(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value) || value.startsWith('0000-')) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : null;
}
function requiredString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized !== '' && normalized.length <= max && !containsControlCharacter(normalized) ? normalized : null;
}
function optionalString(value: unknown, max: number): string | null {
  return value === undefined ? null : typeof value === 'string' && value !== '' && value.length <= max ? value : null;
}
function optionalText(value: unknown, max: number): string | null | undefined {
  return value === undefined ? undefined : value === null ? null : requiredString(value, max);
}
function stringArray(value: unknown, min: number, max: number, itemMax: number): string[] | null {
  if (!Array.isArray(value) || value.length < min || value.length > max) return null;
  const items = value.map((item) => requiredString(item, itemMax));
  if (items.some((item) => item === null) || new Set(items).size !== items.length) return null;
  return items.filter((item): item is string => item !== null);
}
function enumValue<const T extends readonly string[]>(value: unknown, allowed: T): T[number] | null {
  return typeof value === 'string' && allowed.includes(value) ? value : null;
}
function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
}
function success(reply: FastifyReply, data: unknown): unknown { return reply.send({ data, error: null }); }
function failure(reply: FastifyReply, status: number, code: string): unknown {
  return reply.code(status).send({ data: null, error: { code, message: code } });
}
