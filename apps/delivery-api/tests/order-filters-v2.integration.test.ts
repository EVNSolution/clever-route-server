import {
  Prisma,
  PrismaClient,
  type DeliveryStopStatus,
  type RoutePlanStatus,
} from '@prisma/client';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { PrismaOrderQueryRepository } from '../src/modules/shopify/order-query.repository.js';
import {
  prepareOrdersV2Filters,
  V2_PROGRESS,
  v2ProgressForRecord,
} from '../src/modules/shopify/order-filters-v2.js';
import {
  canonicalOrderInclude,
  toCanonicalOrderWhere,
  type CanonicalOrderRecord,
  type ListCanonicalOrdersFilters,
} from '../src/modules/shopify/order-sync.repository.js';

const url = process.env.ORDERS_V2_DATABASE_URL;
const enabled =
  process.env.ORDERS_V2_DATABASE_TARGET_CLASS === 'safe-local-orders-v2-disposable' &&
  url?.startsWith('postgresql://task5@127.0.0.1:55515/task5_filters');
const database = enabled ? describe : describe.skip;
database('orders v2 actual PostgreSQL cohort parity', () => {
  const prisma = new PrismaClient({
    datasourceUrl: url ?? 'postgresql://disabled@127.0.0.1:1/disabled',
  });
  const now = new Date('2026-10-01T12:00:00Z'),
    shopDomain = 'orders-v2.example.test';
  const repository = new PrismaOrderQueryRepository(prisma, 'orders-v2-isolated-secret', () => now);
  let shopId = '';
  const ids: Record<string, string> = {};
  beforeAll(async () => {
    shopId = (await prisma.shop.create({ data: { shopDomain, appId: 'clever' } })).id;
    const seed = async (
      name: string,
      options: {
        status?: DeliveryStopStatus;
        route?: RoutePlanStatus;
        type?: string | null;
        date?: string | null;
        payment?: string | null;
        manual?: string | null;
        fulfillment?: string | null;
        cancelled?: boolean;
        noFact?: boolean;
        noStop?: boolean;
        processedAt?: string;
        area?: string | null;
      } = {},
    ) => {
      const order = await prisma.order.create({
        data: {
          shopId,
          shopifyOrderGid: `gid://shopify/Order/${name}`,
          name,
          sourcePlatform: 'SHOPIFY',
          displayOrderSequence: BigInt(Object.keys(ids).length + 1),
          processedAt: new Date(options.processedAt ?? '2026-10-01T05:00:00Z'),
          createdAt: new Date('2026-09-01T00:00:00Z'),
          cancelledAt: options.cancelled ? new Date('2026-09-30T00:00:00Z') : null,
          financialStatus: options.payment === undefined ? 'PENDING' : options.payment,
          fulfillmentStatus:
            options.fulfillment === undefined ? 'UNFULFILLED' : options.fulfillment,
          rawPayload:
            options.manual === undefined ? {} : { cleverManualPaymentStatus: options.manual },
          ...(options.noFact
            ? {}
            : {
                deliveryFacts: {
                  create: {
                    shopId,
                    sourcePlatform: 'SHOPIFY',
                    matchedMappingPaths: {},
                    reviewReasons: [],
                    readiness: 'READY_TO_PLAN',
                    geocodeStatus: 'RESOLVED',
                    deliveryDayParseStatus: 'PARSED',
                    deliveryArea: options.area === undefined ? 'Toronto' : options.area,
                    deliveryDate:
                      options.date === null
                        ? null
                        : new Date(`${options.date ?? '2026-10-02'}T00:00:00Z`),
                    deliveryWeekday: 'MONDAY',
                    deliveryDateWeekday: 'MONDAY', // Deliberate mismatch: v2 uses the actual Friday date.
                    serviceType: options.type === undefined ? 'DELIVERY' : options.type,
                  },
                },
              }),
          ...(options.noStop
            ? {}
            : {
                deliveryStops: {
                  create: {
                    latitude: 43.65,
                    longitude: -79.38,
                    status: options.status ?? 'PENDING',
                  },
                },
              }),
        },
        include: { deliveryStops: true },
      });
      ids[name] = order.id;
      if (options.route) {
        const route = await prisma.routePlan.create({
          data: {
            shopId,
            name: `${name}-route`,
            status: options.route,
            constraints: {},
            metrics: {},
            optimizerVersion: 'test',
            planDate: new Date('2026-10-02T00:00:00Z'),
            depotLatitude: 43,
            depotLongitude: -79,
          },
        });
        await prisma.routePlanStop.create({
          data: {
            shopId,
            routePlanId: route.id,
            deliveryStopId: order.deliveryStops[0]!.id,
            sequence: 1,
          },
        });
      }
    };
    await seed('unplanned');
    await seed('planned', { route: 'READY' });
    await seed('active', { route: 'IN_PROGRESS', status: 'EN_ROUTE' });
    await seed('delivered', { status: 'DELIVERED', route: 'COMPLETED' });
    await seed('failed', { status: 'FAILED' });
    await seed('skipped', { status: 'SKIPPED' });
    await seed('delivery-cancelled', { status: 'CANCELLED' });
    await seed('pickup-elapsed', { type: 'PICKUP', date: '2026-09-30' });
    await seed('unknown', { noStop: true, noFact: true, payment: null, fulfillment: null });
    await seed('shared-old-delivered', { status: 'DELIVERED', route: 'READY' });
    await seed('manual-paid', {
      payment: 'PENDING',
      manual: 'PAID',
      type: 'EVENING_DELIVERY',
      fulfillment: 'PARTIALLY_FULFILLED',
    });
    await seed('manual-unknown', { payment: 'PAID', manual: 'UNKNOWN' });
    await seed('source-paid', { payment: 'PAID' });
    await seed('missing-date', { date: null, type: 'PICKUP', area: null });
    await seed('source-cancelled', { cancelled: true, payment: 'VOIDED' });
    await seed('voided-not-cancelled', { payment: 'VOIDED' });
    await seed('dst-first', { processedAt: '2026-03-08T05:00:00Z' });
    await seed('dst-last', { processedAt: '2026-03-09T03:59:59Z' });
    await seed('dst-next', { processedAt: '2026-03-09T04:00:00Z' });
  });
  afterAll(async () => {
    if (shopId) await prisma.shop.delete({ where: { id: shopId } });
    await prisma.$disconnect();
  });
  const query = (filters: ListCanonicalOrdersFilters = {}) => ({
    filterVersion: '2' as const,
    orderedDateTimeZone: 'America/Toronto',
    ...filters,
  });
  async function cohort(filters: ListCanonicalOrdersFilters) {
    const prepared = await prepareOrdersV2Filters(prisma, shopId, filters);
    return prisma.order.findMany({
      where: toCanonicalOrderWhere(shopId, prepared, now),
      include: canonicalOrderInclude(),
    });
  }
  test('every order belongs to exactly one progress bucket with matching row classification', async () => {
    const all = await cohort(query());
    const seen = new Set<string>();
    for (const state of V2_PROGRESS) {
      const rows = await cohort(query({ deliveryProgress: [state] }));
      for (const row of rows) {
        expect(seen.has(row.id)).toBe(false);
        seen.add(row.id);
        expect(
          v2ProgressForRecord(row as unknown as CanonicalOrderRecord, now, 'America/Toronto'),
        ).toBe(state);
      }
    }
    expect(seen.size).toBe(all.length);
    expect(
      (await cohort(query({ deliveryProgress: ['planned'] }))).map((row) => row.name),
    ).toContain('shared-old-delivered');
    expect(
      (await cohort(query({ deliveryProgress: ['delivered'] }))).map((row) => row.name),
    ).not.toContain('pickup-elapsed');
  });
  test('actual weekday, null dates and types have independent AND/OR semantics', async () => {
    expect(
      (
        await cohort(
          query({ scheduledWeekdays: ['FRIDAY'], serviceTypes: ['PICKUP', 'EVENING_DELIVERY'] }),
        )
      ).map((row) => row.name),
    ).toEqual(['manual-paid']);
    expect(
      (await cohort(query({ scheduledDateMissing: true }))).map((row) => row.name).sort(),
    ).toEqual(['missing-date', 'unknown']);
    expect(
      (
        await cohort(
          query({
            scheduledDateFrom: '2026-10-02',
            scheduledDateTo: '2026-10-02',
            scheduledWeekdays: ['MONDAY'],
          }),
        )
      ).length,
    ).toBe(0);
  });
  test('manual payment overrides, legacy fulfillment aliases and source cancellation remain separate', async () => {
    expect(
      (await cohort(query({ paymentStatuses: ['PAID'] }))).map((row) => row.name).sort(),
    ).toEqual(['manual-paid', 'source-paid']);
    expect(
      (await cohort(query({ paymentStatuses: ['UNKNOWN'] }))).map((row) => row.name).sort(),
    ).toEqual(['manual-unknown', 'unknown']);
    expect(
      (await cohort(query({ paymentStatuses: ['VOIDED'], cancelled: false }))).map(
        (row) => row.name,
      ),
    ).toEqual(['voided-not-cancelled']);
    expect(
      (
        await cohort(
          query({
            fulfillmentStatuses: ['PARTIALLY_FULFILLED'],
            paymentStatuses: ['PAID'],
            deliveryProgress: ['unplanned'],
          }),
        )
      ).map((row) => row.name),
    ).toEqual(['manual-paid']);
  });
  test('received day includes both DST ends and excludes next midnight', async () => {
    expect(
      (await cohort(query({ receivedDateFrom: '2026-03-08', receivedDateTo: '2026-03-08' })))
        .map((row) => row.name)
        .sort(),
    ).toEqual(['dst-first', 'dst-last']);
  });
  test('numeric page, count, facets, map and frozen selection use the same cohort', async () => {
    const filters = query({
      scheduledWeekdays: ['FRIDAY'],
      serviceTypes: ['DELIVERY', 'EVENING_DELIVERY'],
      paymentStatuses: ['PAID', 'PENDING'],
      cancelled: false,
    });
    const expected = (await cohort(filters)).map((row) => row.id).sort();
    const page = await repository.listPage({
      shopDomain,
      filters,
      page: 1,
      readWatermark: now.toISOString(),
    });
    const facets = await repository.facets({ shopDomain, filters });
    const map = await repository.mapPoints({ shopDomain, filters, limit: 2000 });
    const snapshot = await repository.createSelectionSnapshot({
      actor: 'isolated-user',
      shopDomain,
      filters,
    });
    const members = await prisma.orderSelectionSnapshotOrder.findMany({
      where: { snapshot: { filterHash: snapshot.filterHash }, excludedAt: null },
    });
    expect(page.rows.map((row) => row.orderId).sort()).toEqual(expected);
    expect(page.count).toBe(expected.length);
    expect(facets.totalCount).toBe(expected.length);
    expect(map.points.map((row) => row.orderId).sort()).toEqual(expected);
    expect(snapshot.selectedCount).toBe(expected.length);
    expect(members.map((row) => row.orderId).sort()).toEqual(expected);
    expect(
      new Set([page.filterHash, facets.filterHash, map.filterHash, snapshot.filterHash]).size,
    ).toBe(1);
    const v2 = facets.facets as { fulfillmentStatuses: { value: string; count: number }[] };
    expect(v2.fulfillmentStatuses.find((row) => row.value === 'PARTIALLY_FULFILLED')?.count).toBe(
      1,
    );
    await prisma.orderSelectionSnapshot.deleteMany({ where: { shopId } });
  });
  test('CURRENT ownership outranks old ready membership and invalid ownership is unknown', async () => {
    const original = await prisma.order.findUniqueOrThrow({
      where: { id: ids['planned']! },
      include: { deliveryStops: true },
    });
    const activeRoute = await prisma.routePlan.findFirstOrThrow({
      where: { shopId, name: 'active-route' },
    });
    const group = await prisma.routeGrouping.create({
      data: { shopId, name: 'current-owner-fixture', planDate: new Date('2026-10-02T00:00:00Z') },
    });
    const version = await prisma.routeGroupingVersion.create({
      data: { shopId, groupingId: group.id, version: 1 },
    });
    const child = await prisma.routeGroupingChildVersion.create({
      data: {
        shopId,
        groupingId: group.id,
        groupingVersionId: version.id,
        routePlanId: activeRoute.id,
        version: 1,
        snapshot: {},
      },
    });
    const link = await prisma.routePlanStop.create({
      data: {
        shopId,
        routePlanId: activeRoute.id,
        deliveryStopId: original.deliveryStops[0]!.id,
        sequence: 2,
      },
    });
    try {
      await prisma.order.update({
        where: { id: original.id },
        data: { currentRouteVersionId: child.id },
      });
      const rows = await cohort(query({ deliveryProgress: ['assigned_in_progress'] }));
      expect(rows.map((row) => row.name)).toContain('planned');
      const owned = rows.find((row) => row.id === original.id)!;
      expect(
        v2ProgressForRecord(owned as unknown as CanonicalOrderRecord, now, 'America/Toronto'),
      ).toBe('assigned_in_progress');
      expect(
        (await cohort(query({ deliveryProgress: ['planned'] }))).map((row) => row.id),
      ).not.toContain(original.id);
      await prisma.routeGroupingChildVersion.update({
        where: { id: child.id },
        data: { supersededAt: now },
      });
      expect(
        (await cohort(query({ deliveryProgress: ['unknown'] }))).map((row) => row.id),
      ).toContain(original.id);
    } finally {
      await prisma.order.update({
        where: { id: original.id },
        data: { currentRouteVersionId: null },
      });
      await prisma.routePlanStop.delete({ where: { id: link.id } });
      await prisma.routeGrouping.delete({ where: { id: group.id } });
    }
  });

  test('read-only queries leave source/operational data unchanged', async () => {
    const before = await prisma.$queryRaw<[{ fingerprint: string }]>(
      Prisma.sql`SELECT md5(string_agg(id::text || "rawPayload"::text || COALESCE("financialStatus", ''), ',' ORDER BY id)) AS fingerprint FROM orders WHERE "shopId" = ${shopId}::uuid`,
    );
    await cohort(query({ paymentStatuses: ['PAID'], scheduledWeekdays: ['FRIDAY'] }));
    const after = await prisma.$queryRaw<[{ fingerprint: string }]>(
      Prisma.sql`SELECT md5(string_agg(id::text || "rawPayload"::text || COALESCE("financialStatus", ''), ',' ORDER BY id)) AS fingerprint FROM orders WHERE "shopId" = ${shopId}::uuid`,
    );
    expect(after).toEqual(before);
  });
});
