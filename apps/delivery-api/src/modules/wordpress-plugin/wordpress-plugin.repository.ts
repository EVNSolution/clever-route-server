import type { Prisma, PrismaClient, RoutePlanStatus } from '@prisma/client';

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
  WordPressPluginRoutePlanSummary
} from './wordpress-plugin.types.js';

type WordPressPluginPrismaClient = Pick<
  PrismaClient,
  'commerceConnection' | 'commerceConnectionOrderMapping' | 'orderDeliveryFact' | 'routePlan' | 'wordPressPluginPairingCode' | 'wordPressPluginToken'
>;

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

  async readHealth(input: { context: WordPressPluginConnectionContext; now: Date }): Promise<WordPressPluginHealth> {
    const freshness = await this.readFreshness(input);
    return {
      connection: {
        connectionId: input.context.connectionId,
        label: input.context.label,
        shopDomain: input.context.shopDomain,
        siteUrl: input.context.siteUrl,
        state: input.context.status === 'ACTIVE' ? 'connected' : 'disabled',
        tokenPrefix: input.context.tokenPrefix
      },
      freshness
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
