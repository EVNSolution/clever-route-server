import type { CommerceSyncRunStatus, Prisma, PrismaClient, RoutePlanStatus } from '@prisma/client';

import { normalizeCommerceSiteUrl } from '../commerce/commerce-connection.repository.js';
import type { WordPressPluginAuthRepository } from './wordpress-plugin-auth.service.js';
import { hashSecret, createPairingCode } from './wordpress-plugin-auth.service.js';
import { toInternalRoutePlanStatus, toWordPressRoutePlanStatus, toWordPressStopStatus } from './wordpress-plugin-status.js';
import type {
  WordPressPluginConnectionContext,
  WordPressPluginFreshness,
  WordPressPluginHealth,
  WordPressPluginMappingConfig,
  WordPressPluginRoutePlanDetail,
  WordPressPluginRoutePlanFilters,
  WordPressPluginRoutePlanStop,
  WordPressPluginRoutePlanSummary,
  WordPressPluginSyncRun,
  WordPressPluginSyncRunRequest,
  WordPressPluginSyncRunResult
} from './wordpress-plugin.types.js';

type WordPressPluginPrismaClient = Pick<
  PrismaClient,
  | 'commerceConnection'
  | 'commerceConnectionOrderMapping'
  | 'commerceSyncRun'
  | 'orderDeliveryFact'
  | 'routePlan'
  | 'wordPressPluginPairingCode'
  | 'wordPressPluginToken'
>;

type SyncRunRecord = {
  acceptedAt: Date;
  completedAt: Date | null;
  created: number | null;
  errorMessage: string | null;
  geocodeFailed: number | null;
  geocodeNotRequired: number | null;
  geocodePending: number | null;
  geocodeResolved: number | null;
  id: string;
  needsReview: number | null;
  pagesRead: number | null;
  readyToPlan: number | null;
  received: number | null;
  requestPayload: unknown;
  skipped: number | null;
  startedAt: Date | null;
  status: CommerceSyncRunStatus;
  unchanged: number | null;
  updated: number | null;
  warnings: unknown;
};

const ACTIVE_SYNC_RUN_RECOVERY_TIMEOUT_MS = 30 * 60 * 1000;
const STALE_SYNC_RUN_ERROR_MESSAGE = 'Sync run failed because the background worker did not complete before the recovery timeout.';

type RoutePlanSummaryRecord = {
  _count?: { routeStops?: number };
  createdAt: Date;
  driver: { displayName: string; id: string; status: string } | null;
  driverId: string | null;
  id: string;
  metrics: unknown;
  name: string;
  planDate: Date;
  status: string;
  updatedAt: Date;
};

type RoutePlanDetailRecord = RoutePlanSummaryRecord & {
  routeStops: RoutePlanStopRecord[];
};

type RoutePlanStopRecord = {
  deliveryStop: {
    address1: string | null;
    address2: string | null;
    city: string | null;
    countryCode: string | null;
    deliveryDate: Date | null;
    id: string;
    order: {
      id: string;
      name: string;
      sourceOrderId: string | null;
      sourceOrderNumber: string | null;
      sourcePlatform: string | null;
      sourceSiteUrl: string | null;
    };
    postalCode: string | null;
    province: string | null;
    recipientName: string | null;
    status: string;
    timeWindowEnd: Date | null;
    timeWindowStart: Date | null;
  };
  estimatedArrivalAt: Date | null;
  sequence: number;
};

export class PrismaWordPressPluginRepository implements WordPressPluginAuthRepository {
  constructor(private readonly prisma: WordPressPluginPrismaClient) {}

  async createPairingCode(input: {
    commerceConnectionId: string;
    expiresAt: Date;
    issuedAt: Date;
    issuedBy: string | null;
    plaintextCode?: string;
    siteUrl?: string | null;
  }): Promise<{ code: string; expiresAt: Date; siteUrl: string; tokenPreview: null }> {
    const connection = await this.prisma.commerceConnection.findUnique({
      select: { id: true, shopId: true, siteUrl: true },
      where: { id: input.commerceConnectionId }
    });
    if (connection === null) {
      throw new Error('WooCommerce commerce connection not found');
    }

    const code = input.plaintextCode ?? createPairingCode();
    const siteUrl = normalizeCommerceSiteUrl(input.siteUrl ?? connection.siteUrl);
    await this.prisma.wordPressPluginPairingCode.create({
      data: {
        codeHash: hashSecret(code),
        commerceConnectionId: connection.id,
        expiresAt: input.expiresAt,
        issuedAt: input.issuedAt,
        issuedBy: input.issuedBy,
        shopId: connection.shopId,
        siteUrl
      },
      select: { id: true }
    });

    return { code, expiresAt: input.expiresAt, siteUrl, tokenPreview: null };
  }

  async findPairingCodeByHash(input: { codeHash: string }) {
    return this.prisma.wordPressPluginPairingCode.findUnique({
      include: {
        commerceConnection: {
          select: {
            id: true,
            label: true,
            shopDomain: true,
            shopId: true,
            siteUrl: true,
            status: true
          }
        }
      },
      where: { codeHash: input.codeHash }
    });
  }

  async incrementPairingCodeFailedAttempt(input: { failedAt: Date; pairingCodeId: string }): Promise<void> {
    await this.prisma.wordPressPluginPairingCode.update({
      data: {
        failedAttemptCount: { increment: 1 },
        lastFailedAt: input.failedAt
      },
      where: { id: input.pairingCodeId }
    });
  }

  async consumePairingCode(input: {
    consumedAt: Date;
    consumedBySiteUrl: string;
    pairingCodeId: string;
  }): Promise<boolean> {
    const result = await this.prisma.wordPressPluginPairingCode.updateMany({
      data: {
        consumedAt: input.consumedAt,
        consumedBySiteUrl: input.consumedBySiteUrl
      },
      where: {
        consumedAt: null,
        id: input.pairingCodeId
      }
    });
    return result.count === 1;
  }

  async createPluginToken(input: {
    commerceConnectionId: string;
    issuedAt: Date;
    tokenHash: string;
    tokenPrefix: string;
  }): Promise<{ id: string; tokenPrefix: string }> {
    return this.prisma.wordPressPluginToken.create({
      data: {
        commerceConnectionId: input.commerceConnectionId,
        issuedAt: input.issuedAt,
        tokenHash: input.tokenHash,
        tokenPrefix: input.tokenPrefix
      },
      select: { id: true, tokenPrefix: true }
    });
  }

  async findPluginTokenByHash(input: { tokenHash: string }) {
    return this.prisma.wordPressPluginToken.findUnique({
      include: {
        commerceConnection: {
          select: {
            id: true,
            label: true,
            shopDomain: true,
            shopId: true,
            siteUrl: true,
            status: true
          }
        }
      },
      where: { tokenHash: input.tokenHash }
    });
  }

  async touchPluginToken(input: { lastUsedAt: Date; tokenId: string }): Promise<void> {
    await this.prisma.wordPressPluginToken.update({
      data: { lastUsedAt: input.lastUsedAt },
      where: { id: input.tokenId }
    });
  }

  async markWebhookAccepted(input: { at: Date; connectionId: string }): Promise<void> {
    await this.prisma.commerceConnection.update({
      data: {
        lastSyncAt: input.at,
        lastSyncStatus: 'webhook',
        lastWebhookAt: input.at
      },
      where: { id: input.connectionId }
    });
  }

  async markRestSyncCompleted(input: { at: Date; connectionId: string }): Promise<void> {
    await this.prisma.commerceConnection.update({
      data: {
        lastRestSyncAt: input.at,
        lastSyncAt: input.at,
        lastSyncStatus: 'rest_backfill'
      },
      where: { id: input.connectionId }
    });
  }

  async createSyncRunUnlessActive(input: {
    acceptedAt: Date;
    context: WordPressPluginConnectionContext;
    request: WordPressPluginSyncRunRequest;
  }): Promise<{ alreadyRunning: boolean; run: WordPressPluginSyncRun; startBackgroundProcessing: boolean }> {
    await this.failStaleRunningSyncRuns({ context: input.context, now: input.acceptedAt });
    const active = await this.findActiveSyncRun(input.context);
    if (active !== null) {
      return { alreadyRunning: true, run: toSyncRunDto(active), startBackgroundProcessing: active.status === 'QUEUED' };
    }

    try {
      const run = await this.prisma.commerceSyncRun.create({
        data: {
          acceptedAt: input.acceptedAt,
          commerceConnectionId: input.context.connectionId,
          platform: 'WOOCOMMERCE',
          requestPayload: input.request,
          shopId: input.context.shopId,
          source: 'wordpress_plugin',
          status: 'QUEUED',
          trigger: 'manual_rest_backfill',
          updatedAt: input.acceptedAt,
          warnings: []
        },
        select: syncRunSelect()
      });
      return { alreadyRunning: false, run: toSyncRunDto(run), startBackgroundProcessing: true };
    } catch (error) {
      if (isPrismaUniqueConstraintError(error)) {
        await this.failStaleRunningSyncRuns({ context: input.context, now: input.acceptedAt });
        const activeAfterConflict = await this.findActiveSyncRun(input.context);
        if (activeAfterConflict !== null) {
          return {
            alreadyRunning: true,
            run: toSyncRunDto(activeAfterConflict),
            startBackgroundProcessing: activeAfterConflict.status === 'QUEUED'
          };
        }
      }
      throw error;
    }
  }

  private async failStaleRunningSyncRuns(input: {
    context: WordPressPluginConnectionContext;
    now: Date;
  }): Promise<void> {
    const staleStartedBefore = new Date(input.now.getTime() - ACTIVE_SYNC_RUN_RECOVERY_TIMEOUT_MS);
    await this.prisma.commerceSyncRun.updateMany({
      data: {
        completedAt: input.now,
        errorMessage: STALE_SYNC_RUN_ERROR_MESSAGE,
        status: 'FAILED',
        updatedAt: input.now
      },
      where: {
        commerceConnectionId: input.context.connectionId,
        OR: [
          { startedAt: { lt: staleStartedBefore } },
          { acceptedAt: { lt: staleStartedBefore }, startedAt: null }
        ],
        shopId: input.context.shopId,
        status: 'RUNNING'
      }
    });
  }

  private findActiveSyncRun(context: WordPressPluginConnectionContext): Promise<SyncRunRecord | null> {
    return this.prisma.commerceSyncRun.findFirst({
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      select: syncRunSelect(),
      where: {
        commerceConnectionId: context.connectionId,
        shopId: context.shopId,
        status: { in: ['QUEUED', 'RUNNING'] }
      }
    });
  }

  private findScopedSyncRunRecord(input: {
    context: WordPressPluginConnectionContext;
    syncRunId: string;
  }): Promise<SyncRunRecord | null> {
    return this.prisma.commerceSyncRun.findFirst({
      select: syncRunSelect(),
      where: toScopedSyncRunWhere(input.context, input.syncRunId)
    });
  }

  async findSyncRunById(input: {
    context: WordPressPluginConnectionContext;
    syncRunId: string;
  }): Promise<WordPressPluginSyncRun | null> {
    const run = await this.findScopedSyncRunRecord(input);
    return run === null ? null : toSyncRunDto(run);
  }

  async findLatestSyncRun(input: { context: WordPressPluginConnectionContext }): Promise<WordPressPluginSyncRun | null> {
    const run = await this.prisma.commerceSyncRun.findFirst({
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      select: syncRunSelect(),
      where: {
        commerceConnectionId: input.context.connectionId,
        shopId: input.context.shopId
      }
    });
    return run === null ? null : toSyncRunDto(run);
  }

  async markSyncRunRunning(input: {
    context: WordPressPluginConnectionContext;
    startedAt: Date;
    syncRunId: string;
  }): Promise<WordPressPluginSyncRun | null> {
    const updated = await this.prisma.commerceSyncRun.updateMany({
      data: {
        startedAt: input.startedAt,
        status: 'RUNNING',
        updatedAt: input.startedAt
      },
      where: {
        commerceConnectionId: input.context.connectionId,
        id: input.syncRunId,
        shopId: input.context.shopId,
        status: 'QUEUED'
      }
    });
    if (updated.count !== 1) return null;

    const run = await this.findScopedSyncRunRecord(input);
    return run === null ? null : toSyncRunDto(run);
  }

  async markSyncRunSucceeded(input: {
    completedAt: Date;
    context: WordPressPluginConnectionContext;
    result: WordPressPluginSyncRunResult;
    syncRunId: string;
  }): Promise<WordPressPluginSyncRun> {
    const updated = await this.prisma.commerceSyncRun.updateMany({
      data: {
        completedAt: input.completedAt,
        created: input.result.sync.created,
        errorMessage: null,
        geocodeFailed: input.result.geocode.failed,
        geocodeNotRequired: input.result.geocode.notRequired,
        geocodePending: input.result.geocode.pending,
        geocodeResolved: input.result.geocode.resolved,
        needsReview: input.result.sync.needsReview,
        pagesRead: input.result.pagesRead,
        readyToPlan: input.result.sync.readyToPlan,
        received: input.result.sync.received,
        skipped: input.result.sync.skipped,
        status: 'SUCCEEDED',
        unchanged: input.result.sync.unchanged,
        updated: input.result.sync.updated,
        updatedAt: input.completedAt,
        warnings: input.result.warnings
      },
      where: toScopedSyncRunWhere(input.context, input.syncRunId)
    });
    if (updated.count !== 1) {
      throw new Error('WordPress plugin sync run not found for connection');
    }
    const run = await this.findScopedSyncRunRecord(input);
    if (run === null) throw new Error('WordPress plugin sync run not found after update');
    return toSyncRunDto(run);
  }

  async markSyncRunFailed(input: {
    completedAt: Date;
    context: WordPressPluginConnectionContext;
    errorMessage: string;
    syncRunId: string;
  }): Promise<WordPressPluginSyncRun> {
    const updated = await this.prisma.commerceSyncRun.updateMany({
      data: {
        completedAt: input.completedAt,
        errorMessage: input.errorMessage,
        status: 'FAILED',
        updatedAt: input.completedAt
      },
      where: toScopedSyncRunWhere(input.context, input.syncRunId)
    });
    if (updated.count !== 1) {
      throw new Error('WordPress plugin sync run not found for connection');
    }
    const run = await this.findScopedSyncRunRecord(input);
    if (run === null) throw new Error('WordPress plugin sync run not found after update');
    return toSyncRunDto(run);
  }

  async readHealth(input: { context: WordPressPluginConnectionContext; now: Date }): Promise<WordPressPluginHealth> {
    const [freshness, latestSyncRun] = await Promise.all([
      this.readFreshness(input),
      this.findLatestSyncRun({ context: input.context })
    ]);
    return {
      connection: {
        connectionId: input.context.connectionId,
        label: input.context.label,
        shopDomain: input.context.shopDomain,
        siteUrl: input.context.siteUrl,
        state: input.context.status === 'ACTIVE' ? 'connected' : 'disabled',
        tokenPrefix: input.context.tokenPrefix
      },
      freshness,
      latestSyncRun
    };
  }

  async listRoutePlans(input: {
    context: WordPressPluginConnectionContext;
    filters: WordPressPluginRoutePlanFilters;
    now: Date;
  }): Promise<{ freshness: WordPressPluginFreshness; routePlans: WordPressPluginRoutePlanSummary[] }> {
    const routePlans = (await this.prisma.routePlan.findMany({
      include: {
        _count: { select: { routeStops: true } },
        driver: { select: { displayName: true, id: true, status: true } }
      },
      orderBy: [{ planDate: 'desc' }, { updatedAt: 'desc' }],
      where: toRoutePlanWhere(input.context.shopId, input.filters)
    })) as RoutePlanSummaryRecord[];

    return {
      freshness: await this.readFreshness(input),
      routePlans: routePlans.map((routePlan) => toRoutePlanSummary(routePlan))
    };
  }

  async findRoutePlanDetail(input: {
    context: WordPressPluginConnectionContext;
    now: Date;
    routePlanId: string;
  }): Promise<{ detail: WordPressPluginRoutePlanDetail; freshness: WordPressPluginFreshness } | null> {
    const routePlan = (await this.prisma.routePlan.findFirst({
      include: {
        _count: { select: { routeStops: true } },
        driver: { select: { displayName: true, id: true, status: true } },
        routeStops: {
          include: {
            deliveryStop: {
              include: {
                order: {
                  select: {
                    id: true,
                    name: true,
                    sourceOrderId: true,
                    sourceOrderNumber: true,
                    sourcePlatform: true,
                    sourceSiteUrl: true
                  }
                }
              }
            }
          },
          orderBy: { sequence: 'asc' }
        }
      },
      where: {
        id: input.routePlanId,
        shopId: input.context.shopId
      }
    })) as RoutePlanDetailRecord | null;

    if (routePlan === null) {
      return null;
    }

    return {
      detail: {
        routePlan: toRoutePlanSummary(routePlan),
        stops: routePlan.routeStops.map((routeStop) => toRoutePlanStop(routeStop))
      },
      freshness: await this.readFreshness(input)
    };
  }

  async readMapping(input?: { context?: WordPressPluginConnectionContext }): Promise<WordPressPluginMappingConfig> {
    const base: WordPressPluginMappingConfig = {
      addressPreference: 'shipping',
      deliveryAreaMetaKey: 'delivery_area',
      deliveryDateMetaKey: 'delivery_date',
      deliveryTimeMetaKey: 'delivery_time',
      editable: false,
      notesField: 'customer_note',
      phonePreference: 'billing_then_shipping',
      preview: {
        address: 'redacted',
        phone: 'redacted',
        recipientName: 'redacted'
      }
    };
    const context = input?.context;
    if (context === undefined) return base;

    const [mapping, facts] = await Promise.all([
      this.prisma.commerceConnectionOrderMapping.findUnique({
        select: { config: true, discoveredPathStats: true },
        where: { commerceConnectionId: context.connectionId }
      }),
      this.prisma.orderDeliveryFact.findMany({
        select: { mappingDiagnostics: true, matchedMappingPaths: true, reviewReasons: true },
        take: 500,
        where: { commerceConnectionId: context.connectionId }
      })
    ]);
    return {
      ...base,
      ...(mapping === null ? {} : { config: mapping.config }),
      diagnostics: summarizeMappingDiagnostics(mapping?.discoveredPathStats ?? null, facts),
      matchedMappingPaths: summarizeMatchedMappingPaths(facts.map((fact) => fact.matchedMappingPaths))
    };
  }

  private async readFreshness(input: {
    context: WordPressPluginConnectionContext;
    now: Date;
  }): Promise<WordPressPluginFreshness> {
    const connection = await this.prisma.commerceConnection.findUnique({
      select: {
        lastRestSyncAt: true,
        lastWebhookAt: true
      },
      where: { id: input.context.connectionId }
    });
    const latestRoutePlan = await this.prisma.routePlan.findFirst({
      orderBy: { updatedAt: 'desc' },
      select: { updatedAt: true },
      where: { shopId: input.context.shopId }
    });

    return {
      lastRestSyncAt: connection?.lastRestSyncAt?.toISOString() ?? null,
      lastRouteUpdatedAt: latestRoutePlan?.updatedAt.toISOString() ?? null,
      lastWebhookAt: connection?.lastWebhookAt?.toISOString() ?? null,
      serverTime: input.now.toISOString()
    };
  }
}

function toRoutePlanWhere(shopId: string, filters: WordPressPluginRoutePlanFilters): Prisma.RoutePlanWhereInput {
  const where: Prisma.RoutePlanWhereInput = { shopId };
  const from = parseDateFilter(filters.from ?? null);
  const to = parseDateFilter(filters.to ?? null);
  if (from !== null || to !== null) {
    where.planDate = {
      ...(from === null ? {} : { gte: from }),
      ...(to === null ? {} : { lte: to })
    };
  }
  const internalStatus = filters.status === undefined || filters.status === null ? null : toInternalRoutePlanStatus(filters.status);
  if (internalStatus !== null) {
    where.status = { equals: internalStatus as RoutePlanStatus };
  }
  if (filters.driverId !== undefined && filters.driverId !== null && filters.driverId.trim() !== '') {
    where.driverId = filters.driverId.trim();
  }
  return where;
}

function toRoutePlanSummary(routePlan: RoutePlanSummaryRecord): WordPressPluginRoutePlanSummary {
  const metrics = objectOrNull(routePlan.metrics);
  return {
    createdAt: routePlan.createdAt.toISOString(),
    deliveryDate: formatDateOnly(routePlan.planDate),
    driver:
      routePlan.driver === null
        ? null
        : {
            displayName: routePlan.driver.displayName,
            id: routePlan.driver.id,
            status: routePlan.driver.status
          },
    durationSeconds: readNumber(metrics?.durationSeconds) ?? readNumber(metrics?.totalDurationSeconds),
    id: routePlan.id,
    name: routePlan.name,
    planDate: formatDateOnly(routePlan.planDate),
    status: toWordPressRoutePlanStatus(routePlan.status),
    stopCount: routePlan._count?.routeStops ?? readNumber(metrics?.stopsCount) ?? 0,
    totalDistanceMeters: readNumber(metrics?.totalDistanceMeters) ?? readNumber(metrics?.distanceMeters),
    updatedAt: routePlan.updatedAt.toISOString()
  };
}

function toRoutePlanStop(routeStop: RoutePlanStopRecord): WordPressPluginRoutePlanStop {
  const stop = routeStop.deliveryStop;
  return {
    address: {
      address1: stop.address1,
      address2: stop.address2,
      city: stop.city,
      countryCode: stop.countryCode,
      postalCode: stop.postalCode,
      province: stop.province
    },
    deliveryDate: stop.deliveryDate === null ? null : formatDateOnly(stop.deliveryDate),
    deliveryStopId: stop.id,
    estimatedArrivalAt: routeStop.estimatedArrivalAt?.toISOString() ?? null,
    order: {
      id: stop.order.id,
      name: stop.order.name,
      sourceOrderId: stop.order.sourceOrderId,
      sourceOrderNumber: stop.order.sourceOrderNumber,
      sourcePlatform: stop.order.sourcePlatform,
      sourceSiteUrl: stop.order.sourceSiteUrl
    },
    recipientName: stop.recipientName,
    sequence: routeStop.sequence,
    status: toWordPressStopStatus(stop.status),
    timeWindowEnd: stop.timeWindowEnd?.toISOString() ?? null,
    timeWindowStart: stop.timeWindowStart?.toISOString() ?? null
  };
}

function syncRunSelect(): {
  acceptedAt: true;
  completedAt: true;
  created: true;
  errorMessage: true;
  geocodeFailed: true;
  geocodeNotRequired: true;
  geocodePending: true;
  geocodeResolved: true;
  id: true;
  needsReview: true;
  pagesRead: true;
  readyToPlan: true;
  received: true;
  requestPayload: true;
  skipped: true;
  startedAt: true;
  status: true;
  unchanged: true;
  updated: true;
  warnings: true;
} {
  return {
    acceptedAt: true,
    completedAt: true,
    created: true,
    errorMessage: true,
    geocodeFailed: true,
    geocodeNotRequired: true,
    geocodePending: true,
    geocodeResolved: true,
    id: true,
    needsReview: true,
    pagesRead: true,
    readyToPlan: true,
    received: true,
    requestPayload: true,
    skipped: true,
    startedAt: true,
    status: true,
    unchanged: true,
    updated: true,
    warnings: true
  };
}

function toSyncRunDto(run: SyncRunRecord): WordPressPluginSyncRun {
  const request = readSyncRunRequest(run.requestPayload);
  const hasResult = run.status === 'SUCCEEDED';
  return {
    acceptedAt: run.acceptedAt.toISOString(),
    completedAt: run.completedAt?.toISOString() ?? null,
    errorMessage: run.errorMessage,
    request,
    result: hasResult
      ? {
          geocode: {
            failed: run.geocodeFailed ?? 0,
            notRequired: run.geocodeNotRequired ?? 0,
            pending: run.geocodePending ?? 0,
            resolved: run.geocodeResolved ?? 0
          },
          pagesRead: run.pagesRead ?? 0,
          sync: {
            created: run.created ?? 0,
            needsReview: run.needsReview ?? 0,
            readyToPlan: run.readyToPlan ?? 0,
            received: run.received ?? 0,
            skipped: run.skipped ?? 0,
            unchanged: run.unchanged ?? 0,
            updated: run.updated ?? 0
          },
          warnings: readStringArray(run.warnings)
        }
      : null,
    startedAt: run.startedAt?.toISOString() ?? null,
    status: run.status,
    syncRunId: run.id
  };
}

function toScopedSyncRunWhere(
  context: WordPressPluginConnectionContext,
  syncRunId: string
): Prisma.CommerceSyncRunWhereInput {
  return {
    commerceConnectionId: context.connectionId,
    id: syncRunId,
    shopId: context.shopId
  };
}

function readSyncRunRequest(value: unknown): WordPressPluginSyncRunRequest {
  const object = objectOrNull(value);
  return {
    modifiedAfter: typeof object?.modifiedAfter === 'string' ? object.modifiedAfter : null,
    pageSize: typeof object?.pageSize === 'number' && Number.isInteger(object.pageSize) ? object.pageSize : 100,
    status: typeof object?.status === 'string' && object.status.trim() !== '' ? object.status : null
  };
}

function parseDateFilter(value: string | null): Date | null {
  if (value === null || value.trim() === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function summarizeMappingDiagnostics(
  storedStats: unknown,
  facts: Array<{ mappingDiagnostics: unknown; reviewReasons: unknown }>
): NonNullable<WordPressPluginMappingConfig['diagnostics']> {
  const discoveredPathStats = readNumberRecord(storedStats);
  let unsupportedValueCount = 0;
  let unparseableValueCount = 0;
  for (const fact of facts) {
    const diagnostics = objectOrNull(fact.mappingDiagnostics);
    const stats = readNumberRecord(diagnostics?.discoveredPathStats);
    for (const [path, count] of Object.entries(stats)) {
      discoveredPathStats[path] = (discoveredPathStats[path] ?? 0) + count;
    }
    const unsupported = diagnostics?.unsupportedValues;
    if (Array.isArray(unsupported)) unsupportedValueCount += unsupported.length;
    const reasons = readStringArray(fact.reviewReasons);
    if (reasons.includes('delivery_day_unparsed') || reasons.includes('delivery_date_weekday_unverified')) {
      unparseableValueCount += 1;
    }
  }
  return { discoveredPathStats, unparseableValueCount, unsupportedValueCount };
}

function summarizeMatchedMappingPaths(values: unknown[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    const object = objectOrNull(value);
    if (object === null) continue;
    for (const path of Object.values(object)) {
      if (typeof path !== 'string' || path.trim() === '') continue;
      counts[path] = (counts[path] ?? 0) + 1;
    }
  }
  return counts;
}

function readNumberRecord(value: unknown): Record<string, number> {
  const object = objectOrNull(value);
  if (object === null) return {};
  return Object.fromEntries(
    Object.entries(object).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]))
  );
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isPrismaUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}
