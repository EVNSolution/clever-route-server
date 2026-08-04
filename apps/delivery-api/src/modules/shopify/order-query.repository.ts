import { createHmac, randomBytes } from 'node:crypto';

import { Prisma, type PrismaClient } from '@prisma/client';

import {
  createOrdersFilterHash,
  decodeOrdersCursor,
  encodeOrdersCursor,
  ORDERS_PAGE_SIZE,
  ORDERS_SORT
} from './order-pagination.js';
import {
  canonicalOrderInclude,
  toCanonicalOrderRow,
  toCanonicalOrderWhere,
  type CanonicalOrderRecord,
  type BulkOrderPaymentValue,
  type BulkOrderStateValue,
  type ListCanonicalOrdersFilters
} from './order-sync.repository.js';
import type { CanonicalOrderRow } from './order-sync.mapper.js';
import { appScopedShopWhere, normalizeShopifyAppId } from './shopify-app-scope.js';

const SNAPSHOT_TTL_MS = 15 * 60_000;
const SNAPSHOT_RETENTION_MS = 24 * 60 * 60_000;
const SNAPSHOT_SKIPPED_REASON_KEYS = ['cancelled', 'missing', 'routeLocked'] as const;

type SnapshotSkippedReason = typeof SNAPSHOT_SKIPPED_REASON_KEYS[number];
type SnapshotSkippedReasonCounts = Record<SnapshotSkippedReason, number>;

export type OrdersPageResult = {
  filterHash: string;
  pageInfo: {
    endCursor: string | null;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
    readWatermark: string;
    startCursor: string | null;
  };
  rows: CanonicalOrderRow[];
  sort: typeof ORDERS_SORT;
};

export class OrderSelectionSnapshotError extends Error {
  readonly code: 'INVALID_SELECTION_SNAPSHOT' | 'SELECTION_SNAPSHOT_CONSUMED';

  constructor(code: OrderSelectionSnapshotError['code']) {
    super(code === 'SELECTION_SNAPSHOT_CONSUMED' ? 'Selection snapshot already consumed' : 'Invalid or expired selection snapshot');
    this.name = 'OrderSelectionSnapshotError';
    this.code = code;
  }
}

export class OrdersPaginationNotReadyError extends Error {
  readonly code = 'ORDERS_PAGINATION_NOT_READY';
  constructor() {
    super('Orders pagination requires a complete visible-order sequence backfill');
    this.name = 'OrdersPaginationNotReadyError';
  }
}

export class PrismaOrderQueryRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly secret: string
  ) {}

  async listPage(input: {
    after?: string;
    appId?: string;
    before?: string;
    filters?: ListCanonicalOrdersFilters;
    shopDomain: string;
  }): Promise<OrdersPageResult> {
    if (input.after !== undefined && input.before !== undefined) {
      throw new Error('after and before are mutually exclusive');
    }
    const filters = input.filters ?? {};
    const shop = await this.findShop(input);
    if (shop === null) return emptyPage(createOrdersFilterHash(filters, this.secret));
    const appId = normalizeShopifyAppId(input.appId);
    const filterHash = createOrdersFilterHash(filters, this.secret);
    const cursorValue = input.after ?? input.before;
    const boundary = input.before === undefined ? 'after' : 'before';
    const cursor = cursorValue === undefined ? null : decodeOrdersCursor(cursorValue, {
      appId,
      boundary,
      filterHash,
      shopId: shop.id
    }, this.secret);
    const readWatermark = cursor?.readWatermark ?? new Date().toISOString();
    const missingSequence = await this.prisma.order.findFirst({
      select: { id: true },
      where: { AND: [toCanonicalOrderWhere(shop.id, filters), { displayOrderSequence: null }] }
    });
    if (missingSequence !== null) throw new OrdersPaginationNotReadyError();
    const tupleWhere: Prisma.OrderWhereInput = cursor === null ? {} : boundary === 'after'
      ? {
          AND: [
            { displayOrderSequence: { lte: BigInt(cursor.sequence) } },
            { OR: [
              { displayOrderSequence: { lt: BigInt(cursor.sequence) } },
              { displayOrderSequence: BigInt(cursor.sequence), id: { lt: cursor.orderId } }
            ] }
          ]
        }
      : {
          AND: [
            { displayOrderSequence: { gte: BigInt(cursor.sequence) } },
            { OR: [
              { displayOrderSequence: { gt: BigInt(cursor.sequence) } },
              { displayOrderSequence: BigInt(cursor.sequence), id: { gt: cursor.orderId } }
            ] }
          ]
        };
    const rows = await this.prisma.order.findMany({
      include: canonicalOrderInclude(),
      orderBy: boundary === 'before'
        ? [{ displayOrderSequence: 'asc' }, { id: 'asc' }]
        : [{ displayOrderSequence: 'desc' }, { id: 'desc' }],
      take: ORDERS_PAGE_SIZE + 1,
      where: {
        AND: [
          toCanonicalOrderWhere(shop.id, filters),
          { createdAt: { lte: new Date(readWatermark) }, displayOrderSequence: { not: null } },
          tupleWhere
        ]
      }
    }) as CanonicalOrderRecord[];
    const hasExtra = rows.length > ORDERS_PAGE_SIZE;
    const kept = rows.slice(0, ORDERS_PAGE_SIZE);
    if (boundary === 'before') kept.reverse();
    const mapped = kept.map(toCanonicalOrderRow);
    const start = kept[0];
    const end = kept.at(-1);
    return {
      filterHash,
      pageInfo: {
        endCursor: end === undefined ? null : this.cursorFor(end, { appId, boundary: 'after', filterHash, readWatermark, shopId: shop.id }),
        hasNextPage: boundary === 'before' ? cursor !== null : hasExtra,
        hasPreviousPage: boundary === 'before' ? hasExtra : cursor !== null,
        readWatermark,
        startCursor: start === undefined ? null : this.cursorFor(start, { appId, boundary: 'before', filterHash, readWatermark, shopId: shop.id })
      },
      rows: mapped,
      sort: ORDERS_SORT
    };
  }

  async facets(input: { appId?: string; filters?: ListCanonicalOrdersFilters; shopDomain: string }) {
    const filters = input.filters ?? {};
    const shop = await this.findShop(input);
    const filterHash = createOrdersFilterHash(filters, this.secret);
    if (shop === null) return { countPrecision: 'exact' as const, facets: emptyFacets(), filterHash, totalCount: 0 };
    const without = <K extends keyof ListCanonicalOrdersFilters>(...keys: K[]) => {
      const copy = { ...filters };
      for (const key of keys) delete copy[key];
      return copy;
    };
    const deliveryStates = ['unplanned', 'planned', 'assigned_undelivered', 'past_due', 'delivered', 'fulfilled', 'unfulfilled'] as const;
    const [totalCount, areas, dates, weekdays, services, stateCounts] = await Promise.all([
      this.prisma.order.count({ where: toCanonicalOrderWhere(shop.id, filters) }),
      this.prisma.orderDeliveryFact.groupBy({ by: ['deliveryArea'], _count: { _all: true }, where: { order: toCanonicalOrderWhere(shop.id, without('deliveryArea')) } }),
      this.prisma.orderDeliveryFact.groupBy({ by: ['deliveryDate'], _count: { _all: true }, where: { order: toCanonicalOrderWhere(shop.id, without('deliveryDate')) } }),
      this.prisma.orderDeliveryFact.groupBy({ by: ['deliveryWeekday'], _count: { _all: true }, where: { order: toCanonicalOrderWhere(shop.id, without('deliveryWeekday')) } }),
      this.prisma.orderDeliveryFact.groupBy({ by: ['serviceType'], _count: { _all: true }, where: { order: toCanonicalOrderWhere(shop.id, without('serviceType')) } }),
      Promise.all(deliveryStates.map(async (value) => ({
        count: await this.prisma.order.count({ where: toCanonicalOrderWhere(shop.id, { ...without('deliveryState'), deliveryState: value }) }),
        value
      })))
    ]);
    return {
      countPrecision: 'exact' as const,
      facets: {
        deliveryAreas: facetValues(areas, 'deliveryArea'),
        deliveryDates: facetDates(dates),
        deliveryStates: stateCounts.filter(({ count }) => count > 0),
        deliveryWeekdays: facetValues(weekdays, 'deliveryWeekday'),
        serviceTypes: facetValues(services, 'serviceType')
      },
      filterHash,
      totalCount
    };
  }

  async mapPoints(input: { appId?: string; filters?: ListCanonicalOrdersFilters; limit: number; shopDomain: string }) {
    const filters = input.filters ?? {};
    const shop = await this.findShop(input);
    const filterHash = createOrdersFilterHash(filters, this.secret);
    if (shop === null) return { filterHash, generatedAt: new Date().toISOString(), omittedCount: 0, points: [] };
    const boundedLimit = Math.min(Math.max(input.limit, 1), 2_000);
    const where = toCanonicalOrderWhere(shop.id, filters);
    const [orders, totalCount] = await this.prisma.$transaction([
      this.prisma.order.findMany({
        orderBy: [{ displayOrderSequence: 'desc' }, { id: 'desc' }],
        select: {
          deliveryFacts: { select: { deliveryArea: true, deliveryDate: true }, take: 1 },
          deliveryStops: {
            select: {
              latitude: true,
              longitude: true,
              routePlanStops: { select: { id: true }, take: 1 }
            },
            take: 1
          },
          id: true,
          name: true
        },
        take: boundedLimit,
        where
      }),
      this.prisma.order.count({ where })
    ]);
    const points = orders.flatMap((order) => {
      const stop = order.deliveryStops[0];
      const latitude = stop?.latitude === null || stop?.latitude === undefined ? null : Number(stop.latitude);
      const longitude = stop?.longitude === null || stop?.longitude === undefined ? null : Number(stop.longitude);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return [];
      const fact = order.deliveryFacts[0];
      return [{
        deliveryArea: fact?.deliveryArea ?? null,
        deliveryDate: fact?.deliveryDate?.toISOString().slice(0, 10) ?? null,
        displayLabel: order.name,
        latitude,
        longitude,
        orderId: order.id,
        planningStatus: (stop?.routePlanStops.length ?? 0) > 0 ? 'PLANNED' : 'UNPLANNED'
      }];
    });
    return {
      filterHash,
      generatedAt: new Date().toISOString(),
      omittedCount: Math.max(0, totalCount - points.length),
      points
    };
  }

  async createSelectionSnapshot(input: {
    actor: string;
    appId?: string;
    excludeOrderIds?: string[];
    filters?: ListCanonicalOrdersFilters;
    shopDomain: string;
  }) {
    const filters = input.filters ?? {};
    const shop = await this.findShop(input);
    if (shop === null || input.actor.trim() === '') throw new OrderSelectionSnapshotError('INVALID_SELECTION_SNAPSHOT');
    const appId = normalizeShopifyAppId(input.appId);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SNAPSHOT_TTL_MS);
    const token = randomBytes(32).toString('base64url');
    const tokenHash = keyedHash(this.secret, token);
    const actorSubjectHash = keyedHash(this.secret, input.actor);
    const filterHash = createOrdersFilterHash(filters, this.secret);
    const exclusions = new Set(input.excludeOrderIds ?? []);
    const result = await this.prisma.$transaction(async (tx) => {
      const members = await tx.order.findMany({
        select: { id: true },
        where: { AND: [
          toCanonicalOrderWhere(shop.id, filters),
          { createdAt: { lte: now }, displayOrderSequence: { not: null } }
        ] }
      });
      const memberIds = new Set(members.map(({ id }) => id));
      if ([...exclusions].some((id) => !memberIds.has(id))) throw new OrderSelectionSnapshotError('INVALID_SELECTION_SNAPSHOT');
      const snapshot = await tx.orderSelectionSnapshot.create({
        data: {
          actorSubjectHash,
          appId,
          expiresAt,
          filterHash,
          selectedCount: members.length - exclusions.size,
          shopId: shop.id,
          snapshotWatermark: now,
          sort: ORDERS_SORT,
          tokenHash
        }
      });
      if (members.length > 0) await tx.orderSelectionSnapshotOrder.createMany({
        data: members.map(({ id }) => ({ excludedAt: exclusions.has(id) ? now : null, orderId: id, snapshotId: snapshot.id }))
      });
      return snapshot;
    });
    void this.cleanupSelectionSnapshots().catch(() => undefined);
    return {
      expiresAt: result.expiresAt.toISOString(),
      filterHash,
      selectedCount: result.selectedCount,
      selectionToken: token,
      snapshotWatermark: result.snapshotWatermark.toISOString()
    };
  }

  async replaceSelectionExclusions(input: {
    actor: string;
    appId?: string;
    excludeOrderIds: string[];
    selectionToken: string;
    shopDomain: string;
  }) {
    const snapshot = await this.boundSnapshot(input);
    const exclusions = new Set(input.excludeOrderIds);
    const members = new Set(snapshot.orders.map(({ orderId }) => orderId));
    if ([...exclusions].some((id) => !members.has(id))) throw new OrderSelectionSnapshotError('INVALID_SELECTION_SNAPSHOT');
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.orderSelectionSnapshotOrder.updateMany({ data: { excludedAt: null }, where: { snapshotId: snapshot.id } }),
      this.prisma.orderSelectionSnapshotOrder.updateMany({ data: { excludedAt: now }, where: { orderId: { in: [...exclusions] }, snapshotId: snapshot.id } }),
      this.prisma.orderSelectionSnapshot.update({ data: { selectedCount: members.size - exclusions.size }, where: { id: snapshot.id } })
    ]);
    return { expiresAt: snapshot.expiresAt.toISOString(), selectedCount: members.size - exclusions.size };
  }

  async consumeSelectionSnapshot(input: { actor: string; appId?: string; selectionToken: string; shopDomain: string }) {
    return this.prisma.$transaction(async (tx) => {
      const snapshot = await this.boundSnapshot(input, tx);
      const consumed = await tx.orderSelectionSnapshot.updateMany({
        data: { consumedAt: new Date() },
        where: { consumedAt: null, id: snapshot.id }
      });
      if (consumed.count !== 1) throw new OrderSelectionSnapshotError('SELECTION_SNAPSHOT_CONSUMED');
      return snapshot.orders.filter(({ excludedAt }) => excludedAt === null).map(({ orderId }) => orderId);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async bulkPatchSelectionSnapshot(input: {
    actor: string;
    appId?: string;
    field: 'payment' | 'state';
    selectionToken: string;
    shopDomain: string;
    value: BulkOrderPaymentValue | BulkOrderStateValue;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const snapshot = await this.boundSnapshot(input, tx);
      const claimed = await tx.orderSelectionSnapshot.updateMany({
        data: { consumedAt: new Date() },
        where: { consumedAt: null, id: snapshot.id }
      });
      if (claimed.count !== 1) throw new OrderSelectionSnapshotError('SELECTION_SNAPSHOT_CONSUMED');
      const memberIds = snapshot.orders.filter(({ excludedAt }) => excludedAt === null).map(({ orderId }) => orderId);
      const orders = await tx.order.findMany({
        select: {
          cancelledAt: true,
          deliveryStops: {
            select: {
              routePlanStops: {
                select: {
                  routePlan: {
                    select: {
                      optimizationJobs: {
                        select: { id: true },
                        take: 1,
                        where: { status: { in: ['QUEUED', 'RUNNING'] } }
                      },
                      status: true
                    }
                  }
                }
              },
              status: true
            },
            take: 1
          },
          financialStatus: true,
          id: true,
          rawPayload: true
        },
        where: { id: { in: memberIds }, shopId: snapshot.shopId }
      });
      let noOp = 0;
      let updated = 0;
      const skippedByReason = emptySkippedReasonCounts();
      for (const order of orders) {
        if (order.cancelledAt !== null) {
          skippedByReason.cancelled += 1;
          continue;
        }
        const stop = order.deliveryStops[0] ?? null;
        if (input.field === 'state' && stop !== null && deliveryStopHasLockedRoute(stop)) {
          skippedByReason.routeLocked += 1;
          continue;
        }
        const raw = order.rawPayload !== null && typeof order.rawPayload === 'object' && !Array.isArray(order.rawPayload)
          ? order.rawPayload
          : {};
        if (input.field === 'state') {
          const stateValue = input.value as BulkOrderStateValue;
          const rawState = typeof raw.cleverManualDeliveryStatus === 'string' ? raw.cleverManualDeliveryStatus : null;
          const stopState = stop?.status ?? null;
          if (rawState === stateValue && stopState === stateValue) {
            noOp += 1;
            continue;
          }
          await tx.order.update({
            data: { rawPayload: { ...raw, cleverManualDeliveryStatus: stateValue, cleverManualDeliveryUpdatedSource: 'admin_orders_bulk_selection' } },
            where: { id: order.id }
          });
          await tx.deliveryStop.upsert({
            create: { orderId: order.id, shopId: snapshot.shopId, status: stateValue },
            update: { status: stateValue },
            where: { shopId_orderId: { orderId: order.id, shopId: snapshot.shopId } }
          });
          updated += 1;
        } else {
          const paymentValue = input.value as BulkOrderPaymentValue;
          const rawPayment = typeof raw.cleverManualPaymentStatus === 'string' ? raw.cleverManualPaymentStatus : null;
          if (order.financialStatus === paymentValue && rawPayment === paymentValue) {
            noOp += 1;
            continue;
          }
          await tx.order.update({
            data: {
              financialStatus: paymentValue,
              rawPayload: { ...raw, cleverManualPaymentStatus: paymentValue, cleverManualPaymentUpdatedSource: 'admin_orders_bulk_selection' }
            },
            where: { id: order.id }
          });
          updated += 1;
        }
      }
      skippedByReason.missing = Math.max(0, snapshot.selectedCount - orders.length);
      const skipped = sumSkippedReasons(skippedByReason);
      const resolved = snapshot.selectedCount - skipped;
      if (snapshot.selectedCount !== resolved + skipped) throw new Error('Selection snapshot count invariant failed');
      if (resolved !== updated + noOp) throw new Error('Selection snapshot update invariant failed');
      return {
        noOp,
        resolved,
        selected: snapshot.selectedCount,
        skipped,
        skippedByReason,
        updated
      };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async cleanupSelectionSnapshots(batchSize = 100): Promise<number> {
    const cutoff = new Date(Date.now() - SNAPSHOT_RETENTION_MS);
    const expired = await this.prisma.orderSelectionSnapshot.findMany({
      select: { id: true },
      take: Math.min(Math.max(batchSize, 1), 500),
      where: { OR: [{ expiresAt: { lt: cutoff } }, { consumedAt: { lt: cutoff } }] }
    });
    if (expired.length === 0) return 0;
    return (await this.prisma.orderSelectionSnapshot.deleteMany({ where: { id: { in: expired.map(({ id }) => id) } } })).count;
  }

  private async boundSnapshot(
    input: { actor: string; appId?: string; selectionToken: string; shopDomain: string },
    client: Pick<PrismaClient, 'orderSelectionSnapshot' | 'shop'> = this.prisma
  ) {
    const shop = await this.findShop(input, client);
    if (shop === null) throw new OrderSelectionSnapshotError('INVALID_SELECTION_SNAPSHOT');
    const snapshot = await client.orderSelectionSnapshot.findFirst({
      include: { orders: true },
      where: {
        actorSubjectHash: keyedHash(this.secret, input.actor),
        appId: normalizeShopifyAppId(input.appId),
        consumedAt: null,
        expiresAt: { gt: new Date() },
        shopId: shop.id,
        tokenHash: keyedHash(this.secret, input.selectionToken)
      }
    });
    if (snapshot === null) throw new OrderSelectionSnapshotError('INVALID_SELECTION_SNAPSHOT');
    return snapshot;
  }

  private cursorFor(record: CanonicalOrderRecord, context: Omit<Parameters<typeof encodeOrdersCursor>[0], 'sequence' | 'orderId'>) {
    if (record.displayOrderSequence === null || record.displayOrderSequence === undefined) throw new Error('missing display sequence');
    return encodeOrdersCursor({ ...context, orderId: record.id, sequence: String(record.displayOrderSequence) }, this.secret);
  }

  private async findShop(
    input: { appId?: string; shopDomain: string },
    client: Pick<PrismaClient, 'shop'> = this.prisma
  ) {
    return client.shop.findUnique({
      select: { id: true },
      where: appScopedShopWhere({ appId: normalizeShopifyAppId(input.appId), shopDomain: input.shopDomain.trim().toLowerCase() })
    });
  }
}

function emptyPage(filterHash: string): OrdersPageResult {
  return { filterHash, pageInfo: { endCursor: null, hasNextPage: false, hasPreviousPage: false, readWatermark: new Date().toISOString(), startCursor: null }, rows: [], sort: ORDERS_SORT };
}

function emptyFacets() {
  return { deliveryAreas: [], deliveryDates: [], deliveryStates: [], deliveryWeekdays: [], serviceTypes: [] };
}

function facetValues<K extends string>(rows: Array<Record<K, string | null> & { _count: { _all: number } }>, key: K) {
  return rows.flatMap((row) => {
    const value = row[key];
    return value === null ? [] : [{ count: row._count._all, value }];
  });
}

function facetDates(rows: Array<{ deliveryDate: Date | null; _count: { _all: number } }>) {
  return rows.flatMap((row) => row.deliveryDate === null ? [] : [{ count: row._count._all, value: row.deliveryDate.toISOString().slice(0, 10) }]);
}

function keyedHash(secret: string, value: string): string {
  return `hmac-sha256:${createHmac('sha256', secret).update(value).digest('hex')}`;
}

function emptySkippedReasonCounts(): SnapshotSkippedReasonCounts {
  return { cancelled: 0, missing: 0, routeLocked: 0 };
}

function sumSkippedReasons(counts: SnapshotSkippedReasonCounts): number {
  return SNAPSHOT_SKIPPED_REASON_KEYS.reduce((sum, key) => sum + counts[key], 0);
}

function deliveryStopHasLockedRoute(stop: {
  routePlanStops?: Array<{
    routePlan?: {
      optimizationJobs?: Array<{ id: string }>;
      status?: string;
    };
  }>;
}): boolean {
  return (stop.routePlanStops ?? []).some(({ routePlan }) => {
    if (routePlan === undefined) return false;
    if ((routePlan.optimizationJobs?.length ?? 0) > 0) return true;
    return routePlan.status !== undefined && !['ASSIGNED', 'DRAFT', 'OPTIMIZED', 'PUBLISHED', 'READY'].includes(routePlan.status);
  });
}
