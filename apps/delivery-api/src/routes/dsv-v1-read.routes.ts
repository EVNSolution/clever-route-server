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
  type DsvV1ReadListInput,
  type DsvV1ReadQueryService,
  type DsvV1ServiceDateInput,
} from '../modules/dsv/dsv-v1-read-query.service.js';
import type { DsvMapProfile } from '../modules/dsv/dsv-map-profile.config.js';
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
  secureCookies: boolean;
  sessionResolver: DsvV1SessionResolver;
  sessionSecret: string;
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
      sendV1Data(reply, request, mapDsvV1SessionPrincipal(session.principal))));

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
    allowedQuery: ['cursor', 'limit', 'serviceDate'],
    handler: async (principal, query) => mapDsvV1SellerOrderSummaryPage(
      await requireQueryService(dependencies).listDispatches(requireAdminPrincipal(principal), query)
    ),
    parseQuery: parsePagedDateQuery,
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
  registerReadRoute(app, dependencies, 'customer/deliveries', {
    allowedQuery: ['cursor', 'limit', 'serviceDate', 'window'],
    handler: async (principal, query) => mapDsvV1CustomerDeliveryInquiryPage(
      await requireQueryService(dependencies).listCustomerDeliveries(requireCustomerPrincipal(principal), query)
    ),
    parseQuery: parseCustomerDeliveriesQuery,
    requiredScopes: ['dsv:customer-deliveries:read'],
  });
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
  code: Extract<DsvV1ErrorCode, 'BAD_REQUEST' | 'DEPENDENCY_UNAVAILABLE' | 'FORBIDDEN' | 'UNAUTHENTICATED'>,
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

function readSingleQueryString(request: FastifyRequest, key: string): string | undefined | null {
  const value = queryRecord(request)[key];
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return null;
  return typeof value === 'string' && value.trim() !== '' ? value : null;
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

function requireAdminPrincipal(principal: DsvPrincipal): DsvAdminPrincipal {
  if (principal.principalType === 'DSV_ADMIN') return principal;
  throw new DsvForbiddenError({ principal, requiredScopes: [] });
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
