import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  DsvForbiddenError,
  requireDsvScopes,
} from '../modules/dsv/dsv-principal.js';
import type {
  DsvAdminPrincipal,
  DsvCustomerUserPrincipal,
  DsvPrincipal,
  DsvScope,
} from '../modules/dsv/dsv-principal.js';
import {
  mapDsvV1ConditionListItem,
  mapDsvV1ControlSummary,
  mapDsvV1CustomerDeliveryInquiryPage,
  mapDsvV1CustomerListItem,
  mapDsvV1DestinationListItem,
  mapDsvV1DriverListItem,
  mapDsvV1ManagementListPage,
  mapDsvV1RecordPage,
  mapDsvV1SellerOrderSummaryPage,
  mapDsvV1SessionPrincipal,
  mapDsvV1VehicleListItem,
  toDsvV1ErrorEnvelope,
  toDsvV1SuccessEnvelope,
  type DsvV1ErrorCode,
} from '../modules/dsv/dsv-v1-read.dto.js';
import {
  DsvV1ReadQueryError,
  type DsvV1CustomerDeliveriesInput,
  type DsvV1DispatchListInput,
  type DsvV1ReadListInput,
  type DsvV1ReadQueryService,
  type DsvV1ServiceDateInput,
} from '../modules/dsv/dsv-v1-read-query.service.js';
import {
  DsvTimeConstraintCommandError,
  type DsvClearTimeConstraintInput,
  type DsvConfirmTimeConstraintInput,
  type DsvTimeConstraintActor,
  type DsvTimeConstraintCommandService,
} from '../modules/dsv/dsv-time-constraint-command.service.js';
import type { DsvMapProfile } from '../modules/dsv/dsv-map-profile.config.js';
import type { RoutePlanService } from '../modules/route-plans/route-plan.types.js';
import {
  clearAdminWebSessionCookie,
  verifyAdminWebCsrfToken,
  verifyAdminWebSessionFromRequest,
} from './admin-ui-session.js';

export type { DsvV1ReadQueryService } from '../modules/dsv/dsv-v1-read-query.service.js';

const apiRoot = '/api/dsv/v1';
const cookiePath = '/api/dsv/';

type DsvV1Session = {
  principal: DsvPrincipal;
  session: NonNullable<ReturnType<typeof verifyAdminWebSessionFromRequest>>;
};

export type DsvV1SessionResolver = {
  resolve(subject: string): Promise<DsvPrincipal>;
};

export type DsvV1ReadDependencies = {
  cookieName: string;
  mapProfile?: DsvMapProfile;
  queryService?: DsvV1ReadQueryService;
  routePlanService?: Pick<RoutePlanService, 'getRoutePlanDetail' | 'listRoutePlans'>;
  secureCookies: boolean;
  sessionResolver: DsvV1SessionResolver;
  sessionSecret: string;
  timeConstraintCommandService?: DsvTimeConstraintCommandService;
};

type RouteSpec<Query> = {
  allowedQuery: readonly string[];
  handler: (principal: DsvPrincipal, query: Query) => unknown;
  parseQuery: (request: FastifyRequest) => Query | null;
  requiredScopes: readonly DsvScope[];
};

export function registerDsvV1ReadRoutes(app: FastifyInstance, dependencies: DsvV1ReadDependencies): void {
  app.get(`${apiRoot}/session`, (request, reply) =>
    withDsvV1Session(request, reply, dependencies, (session) =>
      sendV1Data(
        reply,
        request,
        mapDsvV1SessionPrincipal(session.principal, session.session.csrfToken),
      )));

  app.post(`${apiRoot}/session/logout`, (request, reply) =>
    withDsvV1Session(request, reply, dependencies, (session) => {
      if (hasUnsupportedQuery(request, [])) return sendV1Error(reply, request, 400, 'BAD_REQUEST', 'Unsupported query parameter');
      if (!isEmptyObjectBody(request.body)) return sendV1Error(reply, request, 400, 'BAD_REQUEST', 'Unsupported request body');
      if (!verifyAdminWebCsrfToken({ session: session.session, token: request.headers['x-csrf-token'] as string | undefined })) {
        return sendV1Error(reply, request, 403, 'FORBIDDEN', 'Invalid CSRF token');
      }
      return sendV1Data(reply.header('Set-Cookie', clearAdminWebSessionCookie({
        cookieName: dependencies.cookieName,
        path: cookiePath,
        secure: dependencies.secureCookies,
      })), request, { ok: true });
    }));

  registerReadRoute(app, dependencies, 'dispatches', {
    allowedQuery: ['cursor', 'destinationName', 'limit', 'orderNumber', 'serviceDate'],
    handler: async (principal, query) => mapDsvV1SellerOrderSummaryPage(
      await requireQueryService(dependencies).listDispatches(requireAdminPrincipal(principal), query)
    ),
    parseQuery: parseDispatchesQuery,
    requiredScopes: ['dsv:dispatches:read'],
  });
  registerReadRoute(app, dependencies, 'control', {
    allowedQuery: ['serviceDate'],
    handler: async (principal, query) => mapDsvV1ControlSummary(
      await requireQueryService(dependencies).listControl(requireAdminPrincipal(principal), query)
    ),
    parseQuery: parseServiceDateOnlyQuery,
    requiredScopes: ['dsv:control:read'],
  });
  registerReadRoute(app, dependencies, 'control/routes', {
    allowedQuery: ['serviceDate'],
    handler: async (principal, query) => {
      const admin = requireAdminPrincipal(principal);
      const queryService = requireQueryService(dependencies);
      const routePlanService = requireRoutePlanService(dependencies);
      const shopDomain = requireAdminShopDomain(admin);
      const serviceDate = query.serviceDate ?? (await queryService.resolveTenantDates(admin.shopId)).today;
      const routePlans = await routePlanService.listRoutePlans({
        appId: 'clever',
        deliveryDate: serviceDate,
        shopDomain,
      });
      const details = await Promise.all(routePlans.map((routePlan) => routePlanService.getRoutePlanDetail({
        appId: 'clever',
        routePlanId: routePlan.id,
        shopDomain,
      })));
      return {
        routes: details.flatMap((detail) => {
          if (detail === null) return [];
          return [{
            coordinates: detail.routeGeometry?.coordinates ?? [],
            generatedAt: detail.routeGeometryGeneratedAt ?? null,
            geometryStatus: detail.routeGeometryStatus ?? 'missing',
            legDurationsSeconds: [...detail.routeStopPoints]
              .sort((left, right) => left.sequence - right.sequence)
              .map((stop) => stop.durationFromPreviousSeconds ?? null),
            routePlanId: detail.routePlan.id,
          }];
        }),
        serviceDate,
      };
    },
    parseQuery: parseServiceDateOnlyQuery,
    requiredScopes: ['dsv:control:read'],
  });
  registerReadRoute(app, dependencies, 'map/profile', {
    allowedQuery: [],
    handler: () => {
      if (dependencies.mapProfile === undefined) {
        throw new DsvV1DependencyError('DSV map profile is not configured');
      }
      return dependencies.mapProfile;
    },
    parseQuery: parseEmptyQuery,
    requiredScopes: [],
  });
  registerReadRoute(app, dependencies, 'records', {
    allowedQuery: ['cursor', 'limit', 'serviceDate'],
    handler: async (principal, query) => mapDsvV1RecordPage(
      await requireQueryService(dependencies).listRecords(requireAdminPrincipal(principal), query)
    ),
    parseQuery: parsePagedDateQuery,
    requiredScopes: ['dsv:records:read'],
  });
  registerReadRoute(app, dependencies, 'drivers', {
    allowedQuery: ['cursor', 'limit'],
    handler: async (principal, query) => {
      const page = await requireQueryService(dependencies).listDrivers(requireAdminPrincipal(principal), query);
      return mapDsvV1ManagementListPage({ items: page.items.map(mapDsvV1DriverListItem), page: page.page });
    },
    parseQuery: parsePagedQuery,
    requiredScopes: ['dsv:resources:read'],
  });
  registerReadRoute(app, dependencies, 'vehicles', {
    allowedQuery: ['cursor', 'limit'],
    handler: async (principal, query) => {
      const page = await requireQueryService(dependencies).listVehicles(requireAdminPrincipal(principal), query);
      return mapDsvV1ManagementListPage({ items: page.items.map(mapDsvV1VehicleListItem), page: page.page });
    },
    parseQuery: parsePagedQuery,
    requiredScopes: ['dsv:resources:read'],
  });
  registerReadRoute(app, dependencies, 'customers', {
    allowedQuery: ['cursor', 'limit'],
    handler: async (principal, query) => {
      const page = await requireQueryService(dependencies).listCustomers(requireAdminPrincipal(principal), query);
      return mapDsvV1ManagementListPage({ items: page.items.map(mapDsvV1CustomerListItem), page: page.page });
    },
    parseQuery: parsePagedQuery,
    requiredScopes: ['dsv:customers:read'],
  });
  registerReadRoute(app, dependencies, 'destinations', {
    allowedQuery: ['cursor', 'limit'],
    handler: async (principal, query) => {
      const page = await requireQueryService(dependencies).listDestinations(requireAdminPrincipal(principal), query);
      return mapDsvV1ManagementListPage({ items: page.items.map(mapDsvV1DestinationListItem), page: page.page });
    },
    parseQuery: parsePagedQuery,
    requiredScopes: ['dsv:destinations:read'],
  });
  registerReadRoute(app, dependencies, 'conditions', {
    allowedQuery: ['cursor', 'limit'],
    handler: async (principal, query) => {
      const page = await requireQueryService(dependencies).listConditions(requireAdminPrincipal(principal), query);
      return mapDsvV1ManagementListPage({ items: page.items.map(mapDsvV1ConditionListItem), page: page.page });
    },
    parseQuery: parsePagedQuery,
    requiredScopes: ['dsv:conditions:read'],
  });
  registerTimeConstraintCommandRoutes(app, dependencies);
  registerReadRoute(app, dependencies, 'customer/deliveries', {
    allowedQuery: ['cursor', 'limit', 'serviceDate', 'window'],
    handler: async (principal, query) => mapDsvV1CustomerDeliveryInquiryPage(
      await requireQueryService(dependencies).listCustomerDeliveries(requireCustomerPrincipal(principal), query)
    ),
    parseQuery: parseCustomerDeliveriesQuery,
    requiredScopes: ['dsv:customer-deliveries:read'],
  });
  registerReadRoute(app, dependencies, 'customers/deliveries', {
    allowedQuery: ['cursor', 'customerId', 'limit', 'serviceDate', 'window'],
    handler: async (principal, query) => mapDsvV1CustomerDeliveryInquiryPage(
      await requireQueryService(dependencies).listCustomerDeliveriesForAdmin(
        requireAdminPrincipal(principal),
        query.customerId,
        query,
      )
    ),
    parseQuery: parseAdminCustomerDeliveriesQuery,
    requiredScopes: ['dsv:customers:read', 'dsv:dispatches:read'],
  });
}

function registerTimeConstraintCommandRoutes(app: FastifyInstance, dependencies: DsvV1ReadDependencies): void {
  app.post(`${apiRoot}/seller-orders/:sellerOrderId/time-constraint/confirm`, (request, reply) =>
    withDsvV1Session(request, reply, dependencies, async (session) => {
      const principal = requireAdminPrincipal(session.principal);
      requireDsvScopes(principal, ['dsv:dispatches:write']);
      if (!verifyAdminWebCsrfToken({ session: session.session, token: request.headers['x-csrf-token'] as string | undefined })) {
        return sendV1Error(reply, request, 403, 'FORBIDDEN', 'Invalid CSRF token');
      }
      const service = dependencies.timeConstraintCommandService;
      if (service === undefined) {
        return sendV1Error(reply, request, 503, 'DEPENDENCY_UNAVAILABLE', 'DSV time constraint command service is not configured');
      }
      const sellerOrderId = readUuidParam(request, 'sellerOrderId');
      const command = readConfirmTimeConstraintCommand(request);
      if (sellerOrderId === null || command === null) {
        return sendV1Error(reply, request, 400, 'BAD_REQUEST', 'Invalid time constraint confirmation payload');
      }
      try {
        return sendV1Data(reply, request, await service.confirm({
          actor: dsvV1AdminCommandActor(principal, request),
          ...command,
          sellerOrderId,
          shopDomain: requireAdminShopDomain(principal),
        }));
      } catch (error) {
        return sendTimeConstraintCommandError(reply, request, error);
      }
    }));

  app.post(`${apiRoot}/seller-orders/:sellerOrderId/time-constraint/clear`, (request, reply) =>
    withDsvV1Session(request, reply, dependencies, async (session) => {
      const principal = requireAdminPrincipal(session.principal);
      requireDsvScopes(principal, ['dsv:dispatches:write']);
      if (!verifyAdminWebCsrfToken({ session: session.session, token: request.headers['x-csrf-token'] as string | undefined })) {
        return sendV1Error(reply, request, 403, 'FORBIDDEN', 'Invalid CSRF token');
      }
      const service = dependencies.timeConstraintCommandService;
      if (service === undefined) {
        return sendV1Error(reply, request, 503, 'DEPENDENCY_UNAVAILABLE', 'DSV time constraint command service is not configured');
      }
      const sellerOrderId = readUuidParam(request, 'sellerOrderId');
      const command = readClearTimeConstraintCommand(request);
      if (sellerOrderId === null || command === null) {
        return sendV1Error(reply, request, 400, 'BAD_REQUEST', 'Invalid time constraint clear payload');
      }
      try {
        return sendV1Data(reply, request, await service.clear({
          actor: dsvV1AdminCommandActor(principal, request),
          ...command,
          sellerOrderId,
          shopDomain: requireAdminShopDomain(principal),
        }));
      } catch (error) {
        return sendTimeConstraintCommandError(reply, request, error);
      }
    }));
}

function registerReadRoute<Query>(
  app: FastifyInstance,
  dependencies: DsvV1ReadDependencies,
  path: string,
  spec: RouteSpec<Query>,
): void {
  app.get(`${apiRoot}/${path}`, (request, reply) =>
    withDsvV1Session(request, reply, dependencies, async (session) => {
      if (hasUnsupportedQuery(request, spec.allowedQuery)) {
        return sendV1Error(reply, request, 400, 'BAD_REQUEST', 'Unsupported query parameter');
      }
      const query = spec.parseQuery(request);
      if (query === null) return sendV1Error(reply, request, 400, 'BAD_REQUEST', 'Invalid query parameter');
      requireDsvScopes(session.principal, spec.requiredScopes);
      return sendV1Data(reply, request, await spec.handler(session.principal, query));
    }));
}

async function readDsvV1Session(request: FastifyRequest, dependencies: DsvV1ReadDependencies): Promise<DsvV1Session | null> {
  const session = verifyAdminWebSessionFromRequest({
    cookieName: dependencies.cookieName,
    request,
    sessionSecret: dependencies.sessionSecret,
  });
  if (session === null) return null;
  try {
    return {
      principal: await dependencies.sessionResolver.resolve(session.subject),
      session,
    };
  } catch (error) {
    if (error instanceof DsvV1AuthenticationError) return null;
    throw error;
  }
}

async function withDsvV1Session(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: DsvV1ReadDependencies,
  handler: (session: DsvV1Session) => unknown,
): Promise<unknown> {
  try {
    if (hasUnsupportedQuery(request, []) && request.url.startsWith(`${apiRoot}/session?`)) {
      return sendV1Error(reply, request, 400, 'BAD_REQUEST', 'Unsupported query parameter');
    }
    const session = await readDsvV1Session(request, dependencies);
    if (session === null) return sendV1Error(reply, request, 401, 'UNAUTHENTICATED', 'DSV session required');
    requireDsvScopes(session.principal, ['dsv:session:read']);
    return await handler(session);
  } catch (error) {
    if (error instanceof DsvV1ForbiddenError) {
      return sendV1Error(reply, request, 403, 'FORBIDDEN', error.message);
    }
    if (error instanceof DsvForbiddenError) {
      return sendV1Error(reply, request, error.httpStatus, 'FORBIDDEN', error.message, error.details);
    }
    if (error instanceof DsvV1ReadQueryError) {
      return sendV1Error(reply, request, error.httpStatus, error.code, error.message, safeDsvV1ErrorDetails(error.details));
    }
    if (error instanceof DsvV1DependencyError) {
      return sendV1Error(reply, request, 503, 'DEPENDENCY_UNAVAILABLE', error.message);
    }
    request.log.error({ err: error }, 'DSV v1 request failed');
    return sendV1Error(reply, request, 503, 'DEPENDENCY_UNAVAILABLE', 'DSV v1 dependency unavailable');
  }
}

function sendV1Data<T>(reply: FastifyReply, request: FastifyRequest, data: T, statusCode = 200): unknown {
  return reply.code(statusCode).type('application/json; charset=utf-8').header('Cache-Control', 'private, no-store')
    .send(toDsvV1SuccessEnvelope(data, request.id));
}

function sendV1Error(
  reply: FastifyReply,
  request: FastifyRequest,
  statusCode: number,
  code: DsvV1ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): unknown {
  return reply.code(statusCode).type('application/json; charset=utf-8').header('Cache-Control', 'private, no-store').send(
    toDsvV1ErrorEnvelope({
      code,
      ...(details === undefined ? {} : { details }),
      message,
      requestId: request.id,
    })
  );
}

function sendTimeConstraintCommandError(reply: FastifyReply, request: FastifyRequest, error: unknown): unknown {
  if (!(error instanceof DsvTimeConstraintCommandError)) throw error;
  switch (error.code) {
    case 'COMMAND_IN_PROGRESS':
    case 'IDEMPOTENCY_PAYLOAD_MISMATCH':
    case 'SELLER_ORDER_ASSIGNMENT_CHANGED':
      return sendV1Error(reply, request, 409, error.code, error.message);
    case 'SELLER_ORDER_NOT_FOUND':
      return sendV1Error(reply, request, 404, 'NOT_FOUND', error.message);
    case 'VALIDATION_FAILED':
      return sendV1Error(reply, request, 400, 'BAD_REQUEST', error.message);
  }
}

function safeDsvV1ErrorDetails(details: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (details === undefined) return undefined;
  const safeEntries = Object.entries(details).flatMap(([key, value]) => {
    const safeValue = safeDsvV1ErrorDetailValue(value);
    return safeValue === undefined ? [] : [[key, safeValue] as const];
  });
  return safeEntries.length === 0 ? undefined : Object.fromEntries(safeEntries);
}

function safeDsvV1ErrorDetailValue(value: unknown): unknown {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean'
  ) return value;
  if (Array.isArray(value)) {
    const safeValues = value.map(safeDsvV1ErrorDetailValue).filter((item) => item !== undefined);
    return safeValues.length === value.length ? safeValues : undefined;
  }
  return undefined;
}

function parsePagedQuery(request: FastifyRequest): DsvV1ReadListInput | null {
  const cursor = readSingleQueryString(request, 'cursor');
  const limit = readLimit(request);
  if (cursor === null || limit === null) return null;
  return {
    ...(cursor === undefined ? {} : { cursor }),
    ...(limit === undefined ? {} : { limit }),
  };
}

function parsePagedDateQuery(request: FastifyRequest): DsvV1ServiceDateInput | null {
  const base = parsePagedQuery(request);
  const serviceDate = readServiceDate(request);
  if (base === null || serviceDate === null) return null;
  return {
    ...base,
    ...(serviceDate === undefined ? {} : { serviceDate }),
  };
}

function parseDispatchesQuery(request: FastifyRequest): DsvV1DispatchListInput | null {
  const base = parsePagedDateQuery(request);
  const destinationName = readOptionalSearchText(request, 'destinationName');
  const orderNumber = readOptionalSearchText(request, 'orderNumber');
  if (base === null || destinationName === null || orderNumber === null) return null;
  return {
    ...base,
    ...(destinationName === undefined ? {} : { destinationName }),
    ...(orderNumber === undefined ? {} : { orderNumber }),
  };
}

function parseServiceDateOnlyQuery(request: FastifyRequest): Pick<DsvV1ServiceDateInput, 'serviceDate'> | null {
  const serviceDate = readServiceDate(request);
  if (serviceDate === null) return null;
  return serviceDate === undefined ? {} : { serviceDate };
}

function parseCustomerDeliveriesQuery(request: FastifyRequest): DsvV1CustomerDeliveriesInput | null {
  const base = parsePagedDateQuery(request);
  const window = readSingleQueryString(request, 'window');
  if (base === null || window === null) return null;
  if (
    window !== undefined
    && window !== 'today'
    && window !== 'tomorrow'
    && window !== 'day-after-tomorrow'
  ) return null;
  return {
    ...base,
    ...(window === undefined ? {} : { window }),
  };
}

function parseAdminCustomerDeliveriesQuery(
  request: FastifyRequest,
): (DsvV1CustomerDeliveriesInput & { customerId: string }) | null {
  const base = parseCustomerDeliveriesQuery(request);
  const customerId = readSingleQueryString(request, 'customerId');
  if (base === null || customerId === undefined || customerId === null) return null;
  return { ...base, customerId };
}

function parseEmptyQuery(): Record<string, never> {
  return {};
}

function readServiceDate(request: FastifyRequest): string | undefined | null {
  const value = readSingleQueryString(request, 'serviceDate');
  if (value === undefined || value === null) return value;
  return /^\d{4}-\d{2}-\d{2}$/u.test(value) ? value : null;
}

function readLimit(request: FastifyRequest): number | undefined | null {
  const value = readSingleQueryString(request, 'limit');
  if (value === undefined || value === null) return value;
  if (!/^\d+$/u.test(value)) return null;
  const limit = Number(value);
  return Number.isInteger(limit) && limit >= 1 && limit <= 100 ? limit : null;
}

function readOptionalSearchText(request: FastifyRequest, key: string): string | undefined | null {
  const value = readSingleQueryString(request, key);
  if (value === undefined || value === null) return value;
  const normalized = value.trim().replace(/\s+/gu, ' ');
  return normalized.length <= 120 ? normalized : null;
}

function readSingleQueryString(request: FastifyRequest, key: string): string | undefined | null {
  const value = queryRecord(request)[key];
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return null;
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function readConfirmTimeConstraintCommand(request: FastifyRequest): Omit<DsvConfirmTimeConstraintInput, 'actor' | 'sellerOrderId' | 'shopDomain'> | null {
  const body = objectBody(request.body);
  if (body === null || !hasOnlyAllowedBodyKeys(body, ['commandId', 'deliveryStopId', 'expectedVersion', 'timeWindowEnd', 'timeWindowStart'])) return null;
  const base = readTimeConstraintCommandBase(body);
  const timeWindowStart = readBoundedText(body.timeWindowStart, 5);
  const timeWindowEnd = readBoundedText(body.timeWindowEnd, 5);
  if (base === null || timeWindowStart === null || timeWindowEnd === null) return null;
  return { ...base, timeWindowEnd, timeWindowStart };
}

function readClearTimeConstraintCommand(request: FastifyRequest): Omit<DsvClearTimeConstraintInput, 'actor' | 'sellerOrderId' | 'shopDomain'> | null {
  const body = objectBody(request.body);
  if (body === null || !hasOnlyAllowedBodyKeys(body, ['commandId', 'deliveryStopId', 'expectedVersion', 'reason'])) return null;
  const base = readTimeConstraintCommandBase(body);
  const reason = readOptionalBoundedText(body.reason, 500);
  if (base === null || reason === null) return null;
  return { ...base, ...(reason === undefined ? {} : { reason }) };
}

function readTimeConstraintCommandBase(body: Record<string, unknown>): {
  commandId: string;
  deliveryStopId: string;
  expectedVersion?: string | null;
} | null {
  const commandId = readBoundedText(body.commandId, 120);
  const deliveryStopId = readUuidValue(body.deliveryStopId);
  const expectedVersion = readExpectedVersion(body);
  if (commandId === null || deliveryStopId === null || expectedVersion === invalidExpectedVersion) return null;
  return {
    commandId,
    deliveryStopId,
    ...(expectedVersion === undefined ? {} : { expectedVersion }),
  };
}

const invalidExpectedVersion = Symbol('invalidExpectedVersion');

function readExpectedVersion(body: Record<string, unknown>): string | null | undefined | typeof invalidExpectedVersion {
  if (!Object.hasOwn(body, 'expectedVersion')) return undefined;
  if (body.expectedVersion === null) return null;
  return readBoundedText(body.expectedVersion, 160) ?? invalidExpectedVersion;
}

function objectBody(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function hasOnlyAllowedBodyKeys(body: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  return Object.keys(body).every((key) => allowedKeys.includes(key));
}

function readUuidParam(request: FastifyRequest, key: string): string | null {
  const params = request.params;
  if (params === null || typeof params !== 'object' || Array.isArray(params)) return null;
  return readUuidValue((params as Record<string, unknown>)[key]);
}

function readUuidValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) return null;
  return value;
}

function readBoundedText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized !== '' && normalized.length <= maxLength ? normalized : null;
}

function readOptionalBoundedText(value: unknown, maxLength: number): string | undefined | null {
  if (value === undefined || value === null || value === '') return undefined;
  return readBoundedText(value, maxLength);
}

function dsvV1AdminCommandActor(principal: DsvAdminPrincipal, request: FastifyRequest): DsvTimeConstraintActor {
  return {
    actorId: principal.actorId ?? null,
    actorType: 'DSV_ADMIN' as const,
    principalType: 'DSV_ADMIN' as const,
    requestId: request.id,
  };
}

function hasUnsupportedQuery(request: FastifyRequest, allowedKeys: readonly string[]): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(queryRecord(request)).some((key) => !allowed.has(key));
}

function queryRecord(request: FastifyRequest): Record<string, unknown> {
  return typeof request.query === 'object' && request.query !== null && !Array.isArray(request.query)
    ? request.query as Record<string, unknown>
    : {};
}

function isEmptyObjectBody(value: unknown): boolean {
  return value === undefined || (typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 0);
}

function requireQueryService(dependencies: DsvV1ReadDependencies): DsvV1ReadQueryService {
  if (dependencies.queryService === undefined) {
    throw new DsvV1DependencyError('DSV v1 read query service is not configured');
  }
  return dependencies.queryService;
}

function requireRoutePlanService(
  dependencies: DsvV1ReadDependencies,
): Pick<RoutePlanService, 'getRoutePlanDetail' | 'listRoutePlans'> {
  if (dependencies.routePlanService === undefined) {
    throw new DsvV1DependencyError('DSV route plan read service is not configured');
  }
  return dependencies.routePlanService;
}

function requireAdminPrincipal(principal: DsvPrincipal): DsvAdminPrincipal {
  if (principal.principalType === 'DSV_ADMIN') return principal;
  throw new DsvForbiddenError({ principal, requiredScopes: [] });
}

function requireAdminShopDomain(principal: DsvAdminPrincipal): string {
  const shopDomain = principal.shopDomain?.trim();
  if (shopDomain === undefined || shopDomain === '') {
    throw new DsvV1DependencyError('DSV admin shop domain is not available');
  }
  return shopDomain;
}

function requireCustomerPrincipal(principal: DsvPrincipal): DsvCustomerUserPrincipal {
  if (principal.principalType === 'CUSTOMER_USER') return principal;
  throw new DsvForbiddenError({ principal, requiredScopes: ['dsv:customer-deliveries:read'] });
}

export class DsvV1AuthenticationError extends Error {
  constructor() {
    super('DSV v1 authentication failed');
    this.name = 'DsvV1AuthenticationError';
  }
}

export class DsvV1ForbiddenError extends Error {
  constructor(message = 'DSV v1 principal is forbidden') {
    super(message);
    this.name = 'DsvV1ForbiddenError';
  }
}

class DsvV1DependencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DsvV1DependencyError';
  }
}
