import type { FastifyInstance, FastifyRequest } from 'fastify';

import { normalizeCommerceSiteUrl } from '../modules/commerce/commerce-connection.repository.js';
import {
  WordPressPluginConnectionDisabledError,
  WordPressPluginPairingConsumedError,
  WordPressPluginPairingExpiredError,
  WordPressPluginPairingInvalidError
} from '../modules/wordpress-plugin/wordpress-plugin-auth.service.js';
import { toInternalRoutePlanStatus } from '../modules/wordpress-plugin/wordpress-plugin-status.js';
import type {
  WordPressPluginConnectionContext,
  WordPressPluginMappingConfig,
  WordPressPluginPairInput,
  WordPressPluginPairResult,
  WordPressPluginRoutePlanDetail,
  WordPressPluginRoutePlanFilters,
  WordPressPluginRoutePlanSummary,
  WordPressPluginSyncRequestInput,
  WordPressPluginSyncRequestResult,
  WordPressPluginHealth,
  WordPressPluginFreshness
} from '../modules/wordpress-plugin/wordpress-plugin.types.js';

const activeWordPressPluginSyncRequests = new Set<string>();

export type WordPressPluginDependencies = {
  adminLaunchService?: {
    createAdminLaunch(input: {
      context: WordPressPluginConnectionContext;
      section: WordPressPluginAdminLaunchSection;
    }): Promise<{ expiresAt: string; launchUrl: string }>;
  };
  authService: {
    authenticateToken(token: string): Promise<WordPressPluginConnectionContext | null>;
    pairPlugin(input: WordPressPluginPairInput): Promise<WordPressPluginPairResult>;
  };
  mappingService: {
    readMapping(input: { context: WordPressPluginConnectionContext }): Promise<WordPressPluginMappingConfig>;
  };
  routeResultService: {
    findRoutePlanDetail(input: {
      context: WordPressPluginConnectionContext;
      now: Date;
      routePlanId: string;
    }): Promise<{ detail: WordPressPluginRoutePlanDetail; freshness: WordPressPluginFreshness } | null>;
    listRoutePlans(input: {
      context: WordPressPluginConnectionContext;
      filters: WordPressPluginRoutePlanFilters;
      now: Date;
    }): Promise<{ freshness: WordPressPluginFreshness; routePlans: WordPressPluginRoutePlanSummary[] }>;
    readHealth(input: { context: WordPressPluginConnectionContext; now: Date }): Promise<WordPressPluginHealth>;
  };
  syncService: {
    requestSync(input: {
      context: WordPressPluginConnectionContext;
      payload: WordPressPluginSyncRequestInput;
    }): Promise<WordPressPluginSyncRequestResult>;
  };
};

type WordPressPluginAdminLaunchSection = 'drivers' | 'orders' | 'route-plans' | 'settings';

type PairBody = {
  hposEnabled?: boolean | null;
  pairingCode?: string;
  pluginVersion?: string | null;
  siteUrl?: string;
  wooVersion?: string | null;
  wpVersion?: string | null;
};

type SyncRequestBody = {
  modifiedAfter?: unknown;
  pageSize?: unknown;
  status?: unknown;
};

type AdminLaunchBody = {
  section?: unknown;
};

export function registerWordPressPluginRoutes(
  app: FastifyInstance,
  dependencies: WordPressPluginDependencies
): void {
  app.post<{ Body: unknown }>('/wordpress/plugin/pair', async (request, reply) => {
    const payload = readPairBody(request.body);
    if (payload === null) {
      return reply.code(400).send(errorResponse('BAD_REQUEST', 'Invalid WordPress plugin pairing payload'));
    }

    try {
      const paired = await dependencies.authService.pairPlugin(payload);
      return reply.code(201).send({ data: paired, error: null });
    } catch (error) {
      if (error instanceof WordPressPluginPairingExpiredError) {
        return reply.code(410).send(errorResponse('PAIRING_EXPIRED', 'Pairing code expired'));
      }
      if (error instanceof WordPressPluginPairingConsumedError) {
        return reply.code(409).send(errorResponse('PAIRING_CONSUMED', 'Pairing code already consumed'));
      }
      if (error instanceof WordPressPluginPairingInvalidError) {
        return reply.code(401).send(errorResponse('UNAUTHORIZED', 'Invalid pairing code'));
      }
      throw error;
    }
  });

  app.get('/wordpress/plugin/health', async (request, reply) => {
    const authenticated = await authenticatePlugin(request, dependencies);
    if (authenticated.status === 'unauthorized') {
      return reply.code(authenticated.httpStatus).send(errorResponse(authenticated.code, authenticated.message));
    }

    const health = await dependencies.routeResultService.readHealth({
      context: authenticated.context,
      now: new Date()
    });
    return reply.code(200).send({ data: health, error: null });
  });

  app.get('/wordpress/plugin/route-plans', async (request, reply) => {
    const authenticated = await authenticatePlugin(request, dependencies);
    if (authenticated.status === 'unauthorized') {
      return reply.code(authenticated.httpStatus).send(errorResponse(authenticated.code, authenticated.message));
    }
    const filters = readRoutePlanFilters(request.query);
    if (filters === null) {
      return reply.code(400).send(errorResponse('BAD_REQUEST', 'Invalid route plan filters'));
    }

    const result = await dependencies.routeResultService.listRoutePlans({
      context: authenticated.context,
      filters,
      now: new Date()
    });
    return reply.code(200).send({ data: result, error: null });
  });

  app.get<{ Params: { routePlanId: string } }>('/wordpress/plugin/route-plans/:routePlanId', async (request, reply) => {
    const authenticated = await authenticatePlugin(request, dependencies);
    if (authenticated.status === 'unauthorized') {
      return reply.code(authenticated.httpStatus).send(errorResponse(authenticated.code, authenticated.message));
    }

    if (!isUuid(request.params.routePlanId)) {
      return reply.code(400).send(errorResponse('BAD_REQUEST', 'Route plan id must be a UUID'));
    }

    const result = await dependencies.routeResultService.findRoutePlanDetail({
      context: authenticated.context,
      now: new Date(),
      routePlanId: request.params.routePlanId
    });
    if (result === null) {
      return reply.code(404).send(errorResponse('NOT_FOUND', 'Route plan not found'));
    }

    return reply.code(200).send({ data: result, error: null });
  });

  app.post<{ Body: unknown }>('/wordpress/plugin/sync/request', async (request, reply) => {
    const authenticated = await authenticatePlugin(request, dependencies);
    if (authenticated.status === 'unauthorized') {
      return reply.code(authenticated.httpStatus).send(errorResponse(authenticated.code, authenticated.message));
    }

    const payload = readSyncRequestBody(request.body);
    if (payload === null) {
      return reply.code(400).send(errorResponse('BAD_REQUEST', 'Invalid sync request payload'));
    }

    const alreadyRunning = activeWordPressPluginSyncRequests.has(authenticated.context.connectionId);
    if (!alreadyRunning) {
      activeWordPressPluginSyncRequests.add(authenticated.context.connectionId);
      request.log.info(
        {
          connectionId: authenticated.context.connectionId,
          shopDomain: authenticated.context.shopDomain
        },
        'wordpress plugin sync request queued'
      );
      void runWordPressPluginSyncRequest({
        context: authenticated.context,
        dependencies,
        log: request.log,
        payload
      });
    }

    return reply.code(202).send({ data: queuedSyncRequestResult({ alreadyRunning }), error: null });
  });

  app.post<{ Body: unknown }>('/wordpress/plugin/admin-launch', async (request, reply) => {
    const authenticated = await authenticatePlugin(request, dependencies);
    if (authenticated.status === 'unauthorized') {
      return reply.code(authenticated.httpStatus).send(errorResponse(authenticated.code, authenticated.message));
    }
    if (dependencies.adminLaunchService === undefined) {
      return reply.code(503).send(errorResponse('ADMIN_LAUNCH_DISABLED', 'CLEVER admin plugin launch is not enabled'));
    }

    const section = readAdminLaunchSection(request.body);
    if (section === null) {
      return reply.code(400).send(errorResponse('BAD_REQUEST', 'Invalid admin launch payload'));
    }

    const result = await dependencies.adminLaunchService.createAdminLaunch({
      context: authenticated.context,
      section
    });
    return reply.code(201).send({ data: result, error: null });
  });

  app.get('/wordpress/plugin/mapping', async (request, reply) => {
    const authenticated = await authenticatePlugin(request, dependencies);
    if (authenticated.status === 'unauthorized') {
      return reply.code(authenticated.httpStatus).send(errorResponse(authenticated.code, authenticated.message));
    }

    const mapping = await dependencies.mappingService.readMapping({ context: authenticated.context });
    return reply.code(200).send({ data: { mapping }, error: null });
  });
}

async function runWordPressPluginSyncRequest(input: {
  context: WordPressPluginConnectionContext;
  dependencies: WordPressPluginDependencies;
  log: FastifyRequest['log'];
  payload: WordPressPluginSyncRequestInput;
}): Promise<void> {
  try {
    const result = await input.dependencies.syncService.requestSync({
      context: input.context,
      payload: input.payload
    });
    input.log.info(
      {
        connectionId: input.context.connectionId,
        pagesRead: result.pagesRead,
        received: result.sync.received,
        shopDomain: input.context.shopDomain
      },
      'wordpress plugin sync request processed'
    );
  } catch (error: unknown) {
    input.log.error(
      {
        connectionId: input.context.connectionId,
        error: error instanceof Error ? error.message : String(error),
        shopDomain: input.context.shopDomain
      },
      'wordpress plugin background sync request failed'
    );
  } finally {
    activeWordPressPluginSyncRequests.delete(input.context.connectionId);
  }
}

function queuedSyncRequestResult(input: { alreadyRunning: boolean }): WordPressPluginSyncRequestResult & { queued: true } {
  const message = input.alreadyRunning
    ? 'A sync is already running in the background. This request was accepted without starting a duplicate job.'
    : 'Sync was accepted and is running in the background.';
  return {
    message,
    pagesRead: 0,
    queued: true,
    sync: {
      created: 0,
      needsReview: 0,
      readyToPlan: 0,
      received: 0,
      skipped: 0,
      unchanged: 0,
      updated: 0
    },
    warnings: [
      `${message} The zero counts in this acknowledgement are placeholders, not the final sync result. Refresh CLEVER Route after it completes.`
    ]
  };
}

async function authenticatePlugin(
  request: FastifyRequest,
  dependencies: WordPressPluginDependencies
): Promise<
  | { context: WordPressPluginConnectionContext; status: 'authenticated' }
  | { code: 'FORBIDDEN' | 'UNAUTHORIZED'; httpStatus: 401 | 403; message: string; status: 'unauthorized' }
> {
  const token = extractBearerToken(request.headers.authorization);
  if (token === null) {
    return {
      code: 'UNAUTHORIZED',
      httpStatus: 401,
      message: 'Missing bearer plugin token',
      status: 'unauthorized'
    };
  }

  try {
    const context = await dependencies.authService.authenticateToken(token);
    if (context === null) {
      return {
        code: 'UNAUTHORIZED',
        httpStatus: 401,
        message: 'Invalid plugin token',
        status: 'unauthorized'
      };
    }
    return { context, status: 'authenticated' };
  } catch (error) {
    if (error instanceof WordPressPluginConnectionDisabledError) {
      return {
        code: 'FORBIDDEN',
        httpStatus: 403,
        message: 'WordPress plugin connection is disabled',
        status: 'unauthorized'
      };
    }
    throw error;
  }
}

function readPairBody(body: unknown): WordPressPluginPairInput | null {
  const object = objectOrNull<PairBody>(body);
  if (object === null) return null;
  if (typeof object.pairingCode !== 'string' || typeof object.siteUrl !== 'string') return null;
  const normalizedSiteUrl = readNormalizedSiteUrl(object.siteUrl);
  if (normalizedSiteUrl === null) return null;
  return {
    hposEnabled: typeof object.hposEnabled === 'boolean' ? object.hposEnabled : null,
    pairingCode: object.pairingCode,
    pluginVersion: readNullableString(object.pluginVersion),
    siteUrl: normalizedSiteUrl,
    wooVersion: readNullableString(object.wooVersion),
    wpVersion: readNullableString(object.wpVersion)
  };
}

function readSyncRequestBody(body: unknown): WordPressPluginSyncRequestInput | null {
  const object = objectOrNull<SyncRequestBody>(body);
  if (object === null) return { modifiedAfter: null, pageSize: 100, status: null };
  const pageSize = object.pageSize ?? 100;
  if (typeof pageSize !== 'number' || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) return null;
  const modifiedAfter = readOptionalIsoDateTime(object.modifiedAfter ?? null);
  if (modifiedAfter.status === 'invalid') return null;
  return {
    modifiedAfter: modifiedAfter.value,
    pageSize,
    status: readNullableString(object.status)
  };
}

function readAdminLaunchSection(body: unknown): WordPressPluginAdminLaunchSection | null {
  const object = objectOrNull<AdminLaunchBody>(body) ?? {};
  const section = typeof object.section === 'string' && object.section.trim() !== '' ? object.section.trim() : 'orders';
  return section === 'orders' || section === 'route-plans' || section === 'drivers' || section === 'settings'
    ? section
    : null;
}

function readRoutePlanFilters(query: unknown): WordPressPluginRoutePlanFilters | null {
  const object = objectOrNull<Record<string, unknown>>(query) ?? {};
  const from = readNullableString(object.from);
  const driverId = readNullableString(object.driverId);
  const status = readNullableString(object.status);
  const to = readNullableString(object.to);
  if ((from !== null && !isDateOnly(from)) || (to !== null && !isDateOnly(to))) {
    return null;
  }
  if (status !== null && toInternalRoutePlanStatus(status) === null) {
    return null;
  }
  if (driverId !== null && !isUuid(driverId)) {
    return null;
  }
  return {
    driverId,
    from,
    status,
    to
  };
}

function readNormalizedSiteUrl(value: string): string | null {
  try {
    return normalizeCommerceSiteUrl(value);
  } catch {
    return null;
  }
}

function extractBearerToken(value: string | undefined): string | null {
  if (value === undefined) return null;
  const match = /^Bearer\s+(.+)$/iu.exec(value.trim());
  return match?.[1]?.trim() || null;
}

function readOptionalIsoDateTime(
  value: unknown
): { status: 'invalid'; value: null } | { status: 'valid'; value: Date | null } {
  if (value === null || value === undefined) return { status: 'valid', value: null };
  if (typeof value !== 'string') return { status: 'invalid', value: null };
  const trimmed = value.trim();
  if (trimmed === '') return { status: 'valid', value: null };

  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/u.exec(
      trimmed
    );
  if (match === null) return { status: 'invalid', value: null };

  const [, year, month, day, hour, minute, second = '0', millisecond = '0', timezone] = match;
  if (
    !isValidCalendarDateTime({
      day: Number(day),
      hour: Number(hour),
      millisecond: Number(millisecond),
      minute: Number(minute),
      month: Number(month),
      second: Number(second),
      timezone: timezone ?? '',
      year: Number(year)
    })
  ) {
    return { status: 'invalid', value: null };
  }

  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? { status: 'invalid', value: null } : { status: 'valid', value: date };
}

function readNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function isDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function isValidCalendarDateTime(input: {
  day: number;
  hour: number;
  millisecond: number;
  minute: number;
  month: number;
  second: number;
  timezone: string;
  year: number;
}): boolean {
  if (input.month < 1 || input.month > 12) return false;
  const lastDayOfMonth = new Date(Date.UTC(input.year, input.month, 0)).getUTCDate();
  if (input.day < 1 || input.day > lastDayOfMonth) return false;
  if (input.hour < 0 || input.hour > 23) return false;
  if (input.minute < 0 || input.minute > 59) return false;
  if (input.second < 0 || input.second > 59) return false;
  if (input.millisecond < 0 || input.millisecond > 999) return false;
  if (input.timezone === 'Z') return true;

  const offsetMatch = /^([+-])(\d{2}):(\d{2})$/u.exec(input.timezone);
  if (offsetMatch === null) return false;
  const offsetHour = Number(offsetMatch[2]);
  const offsetMinute = Number(offsetMatch[3]);
  return offsetHour >= 0 && offsetHour <= 23 && offsetMinute >= 0 && offsetMinute <= 59;
}

function objectOrNull<T extends Record<string, unknown>>(value: unknown): T | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as T) : null;
}

function errorResponse(code: string, message: string): { data: null; error: { code: string; message: string } } {
  return { data: null, error: { code, message } };
}
