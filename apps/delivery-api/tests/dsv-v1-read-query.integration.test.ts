import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import {
  PrismaDsvV1ReadQueryService,
} from '../src/modules/dsv/dsv-v1-read-query.service.js';
import { deriveDsvV1ProofStatus } from '../src/modules/dsv/dsv-v1-read.dto.js';
import type { DsvV1ReadQueryError } from '../src/modules/dsv/dsv-v1-read-query.service.js';
import type { DsvCustomerUserPrincipal } from '../src/modules/dsv/dsv-principal.js';

const safeTargetClass = 'safe-local-g005-temp-cluster';
const exactDatabaseUrl = 'postgresql://clever_g005:clever_g005@127.0.0.1:55466/clever_g005?schema=public';
const databaseUrl = process.env.DATABASE_URL ?? '';
const targetClass = process.env.G005_DATABASE_TARGET_CLASS ?? '';
const isG005TargetClass = targetClass === safeTargetClass;
const isSafeDisposableTarget = isG005TargetClass && databaseUrl === exactDatabaseUrl;
const describeG005Disposable = isG005TargetClass ? describe.sequential : describe.skip;

describeG005Disposable('G005 DSV v1 read query DB integration', () => {
  let prisma: PrismaClient;
  const createdShopIds: string[] = [];

  beforeAll(async () => {
    if (!isSafeDisposableTarget) {
      throw new Error(
        `Refusing unsafe G005 integration target: G005_DATABASE_TARGET_CLASS=${targetClass || '<missing>'} DATABASE_URL=${databaseUrl || '<missing>'}`,
      );
    }
    prisma = new PrismaClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    if (!prisma) {
      return;
    }
    for (const shopId of createdShopIds.reverse()) {
      await prisma.shop.deleteMany({ where: { id: shopId } });
    }
    await prisma.$disconnect();
  });

  test('starts customer deliveries from Order scope and does not leak through shared destination or mismatched-shop stop evidence', async () => {
    const fixture = await createFixture(prisma, createdShopIds, 'shared-destination', { mismatchedShopEvidence: true });
    const service = new PrismaDsvV1ReadQueryService(prisma, () => new Date('2026-07-22T15:30:00.000Z'));
    const countsBefore = await canonicalCounts(prisma, fixture.shopId);

    const result = await service.listCustomerDeliveries(customerPrincipal(fixture.shopId, fixture.customerAId), {
      serviceDate: '2026-07-23',
    });
    const countsAfter = await canonicalCounts(prisma, fixture.shopId);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      destinationId: fixture.sharedDestinationId,
      destinationDisplayName: 'Shared Destination X',
      estimatedArrivalAt: new Date('2026-07-23T02:00:00.000Z'),
      etaInputRouteVersionId: fixture.routeVersionAId,
      etaSource: 'ROUTE_CALCULATION',
      etaStatus: 'READY',
      eventRows: [{ eventType: 'STOP_DELIVERED', occurredAt: new Date('2026-07-23T03:00:00.000Z') }],
      proofRows: [{ deletedAt: null }],
      sellerOrderKey: fixture.orderAKey,
      shippedBoxes: 6,
    });
    expect(result.items[0]?.eventRows).toHaveLength(1);
    expect(result.items[0]?.proofRows).toHaveLength(1);
    expect(result.items.map((item) => item.sellerOrderKey)).not.toContain(fixture.orderBKey);
    expect(JSON.stringify(result.items)).not.toContain(fixture.orderBKey);
    expect(JSON.stringify(result.items)).not.toContain(fixture.forbiddenEventId);
    expect(JSON.stringify(result.items)).not.toContain(fixture.mismatchedShopEventId);
    expect(JSON.stringify(result.items)).not.toContain('storage-key-b');
    expect(JSON.stringify(result.items)).not.toContain('storage-key-mismatched-shop');

    const records = await service.listRecords(customerlessAdmin(fixture.shopId), { serviceDate: '2026-07-23' });
    const ownRecord = records.items.find((item) => item.sellerOrderKey === fixture.orderAKey);
    expect(ownRecord?.eventRows).toEqual([
      expect.objectContaining({ eventType: 'STOP_DELIVERED', occurredAt: new Date('2026-07-23T03:00:00.000Z') }),
    ]);
    expect(ownRecord?.proofRows).toEqual([expect.objectContaining({ deletedAt: null })]);
    expect(JSON.stringify(records.items)).not.toContain(fixture.mismatchedShopEventId);
    expect(JSON.stringify(records.items)).not.toContain('storage-key-mismatched-shop');

    const dispatches = await service.listDispatches(customerlessAdmin(fixture.shopId), { serviceDate: '2026-07-23' });
    expect(dispatches.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        deliveryStopId: fixture.stopAId,
        sellerOrderId: fixture.orderAId,
        sellerOrderKey: fixture.orderAKey,
      }),
      expect.objectContaining({
        deliveryStopId: fixture.stopBId,
        sellerOrderId: fixture.orderBId,
        sellerOrderKey: fixture.orderBKey,
      }),
    ]));
    expect(dispatches.items.find((item) => item.sellerOrderId === fixture.orderAId)?.deliveryStopId).toBe(fixture.stopAId);
    expect(dispatches.items.find((item) => item.sellerOrderId === fixture.orderBId)?.deliveryStopId).toBe(fixture.stopBId);
    expect(countsAfter).toEqual(countsBefore);
  });

  test('keeps same-destination customer deliveries order-granular with per-stop shipped boxes', async () => {
    const fixture = await createFixture(prisma, createdShopIds, 'same-destination-order-granular', {
      extraSameDayCustomerAOrder: true,
    });
    const service = new PrismaDsvV1ReadQueryService(prisma, () => new Date('2026-07-22T15:30:00.000Z'));

    const result = await service.listCustomerDeliveries(customerPrincipal(fixture.shopId, fixture.customerAId), {
      serviceDate: '2026-07-23',
    });

    expect(result.items).toHaveLength(2);
    expect(result.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        deliveryStatus: 'PENDING',
        destinationId: fixture.sharedDestinationId,
        sellerOrderId: fixture.orderAId,
        sellerOrderKey: fixture.orderAKey,
        shippedBoxes: 6,
      }),
      expect.objectContaining({
        deliveryStatus: 'PENDING',
        destinationId: fixture.sharedDestinationId,
        sellerOrderId: fixture.extraCustomerAOrderId,
        sellerOrderKey: fixture.extraCustomerAOrderKey,
        shippedBoxes: 4,
      }),
    ]));
    expect(new Set(result.items.map((item) => item.destinationId))).toEqual(new Set([fixture.sharedDestinationId]));
    expect(new Set(result.items.map((item) => item.sellerOrderId)).size).toBe(2);
  });

  test('does not serialize stale RoutePlanStop ETA when no row is owned by the current route version', async () => {
    const fixture = await createStaleEtaFixture(prisma, createdShopIds, 'stale-eta');
    const service = new PrismaDsvV1ReadQueryService(prisma, () => new Date('2026-07-22T15:30:00.000Z'));

    const result = await service.listCustomerDeliveries(customerPrincipal(fixture.shopId, fixture.customerId), {
      serviceDate: '2026-07-23',
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      etaStatus: 'PENDING',
      sellerOrderKey: fixture.orderKey,
    });
    expect(result.items[0]).not.toHaveProperty('estimatedArrivalAt');
    expect(result.items[0]).not.toHaveProperty('etaInputRouteVersionId');
    expect(result.items[0]).not.toHaveProperty('etaSource');
    expect(JSON.stringify(result.items)).not.toContain(fixture.staleRouteVersionId);
  });

  test('derives proof NONE and EXPIRED from scoped proof rows without leaking raw proof metadata', async () => {
    const fixture = await createFixture(prisma, createdShopIds, 'proof-statuses');
    const service = new PrismaDsvV1ReadQueryService(prisma, () => new Date('2026-07-22T15:30:00.000Z'));

    const tomorrow = await service.listCustomerDeliveries(customerPrincipal(fixture.shopId, fixture.customerAId), {
      serviceDate: '2026-07-24',
    });
    const dayAfterTomorrow = await service.listCustomerDeliveries(customerPrincipal(fixture.shopId, fixture.customerAId), {
      serviceDate: '2026-07-25',
    });

    expect(tomorrow.items).toHaveLength(1);
    expect(deriveDsvV1ProofStatus(tomorrow.items[0]?.proofRows ?? [])).toBe('NONE');
    expect(dayAfterTomorrow.items).toHaveLength(1);
    expect(deriveDsvV1ProofStatus(dayAfterTomorrow.items[0]?.proofRows ?? [])).toBe('EXPIRED');
    expect(JSON.stringify([tomorrow, dayAfterTomorrow])).not.toMatch(/storageKey|storage-key|originalFilename|contentType|sha256|sizeBytes/u);
    expect(JSON.stringify([tomorrow, dayAfterTomorrow])).not.toContain('REDACTED');
  });

  test('uses tenant-local date windows, stable empty results, and filter-bound cursors', async () => {
    const fixture = await createFixture(prisma, createdShopIds, 'date-cursor', { extraSameDayCustomerAOrder: true });
    const service = new PrismaDsvV1ReadQueryService(prisma, () => new Date('2026-07-22T15:30:00.000Z'));

    const today = await service.listCustomerDeliveries(customerPrincipal(fixture.shopId, fixture.customerAId), { window: 'today' });
    const historical = await service.listCustomerDeliveries(customerPrincipal(fixture.shopId, fixture.customerAId), {
      serviceDate: '2026-07-27',
    });
    const firstPage = await service.listCustomerDeliveries(customerPrincipal(fixture.shopId, fixture.customerAId), {
      limit: 1,
      serviceDate: '2026-07-23',
    });

    expect(today.serviceDate).toBe('2026-07-23');
    expect(today.timezone).toBe('Asia/Seoul');
    expect(historical).toMatchObject({
      emptyReason: 'NO_DELIVERIES',
      items: [],
      serviceDate: '2026-07-27',
    });
    expect(firstPage.page.nextCursor).toEqual(expect.any(String));
    await expect(service.listCustomerDeliveries(customerPrincipal(fixture.shopId, fixture.customerBId), {
      cursor: firstPage.page.nextCursor ?? null,
      limit: 1,
      serviceDate: '2026-07-23',
    })).rejects.toMatchObject({ code: 'BAD_REQUEST', httpStatus: 400 } satisfies Partial<DsvV1ReadQueryError>);
  });

  test('orders customer delivery pages by sellerOrderKey then id', async () => {
    const fixture = await createCustomerDeliveryOrderingFixture(prisma, createdShopIds, 'customer-ordering');
    const service = new PrismaDsvV1ReadQueryService(prisma, () => new Date('2026-07-22T15:30:00.000Z'));

    const firstPage = await service.listCustomerDeliveries(customerPrincipal(fixture.shopId, fixture.customerId), {
      limit: 1,
      serviceDate: '2026-07-23',
    });
    const secondPage = await service.listCustomerDeliveries(customerPrincipal(fixture.shopId, fixture.customerId), {
      cursor: firstPage.page.nextCursor ?? null,
      limit: 1,
      serviceDate: '2026-07-23',
    });

    expect(firstPage.items.map((item) => item.sellerOrderKey)).toEqual([fixture.lowKey]);
    expect(secondPage.items.map((item) => item.sellerOrderKey)).toEqual([fixture.highKey]);
    expect(secondPage.page.hasMore).toBe(false);
    expect([...firstPage.items, ...secondPage.items].map((item) => item.sellerOrderKey).sort()).toEqual([
      fixture.highKey,
      fixture.lowKey,
    ].sort());
  });

  test('paginates one record per delivery stop and keeps each stop event timeline intact', async () => {
    const fixture = await createRecordPaginationFixture(prisma, createdShopIds, 'record-pagination');
    const service = new PrismaDsvV1ReadQueryService(prisma, () => new Date('2026-07-22T15:30:00.000Z'));

    const pages = [];
    for (let pageNumber = 1; pageNumber <= 3; pageNumber += 1) {
      const page = await service.listRecords(customerlessAdmin(fixture.shopId), {
        limit: 2,
        page: pageNumber,
        serviceDate: '2026-07-23',
      });
      pages.push(page);
    }
    const eventSummaries = pages.flatMap((page) => page.items.flatMap((item) => item.eventRows ?? []));

    expect(eventSummaries.map((event) => `${new Date(event.occurredAt).toISOString()}:${event.eventType}`).sort())
      .toEqual([...fixture.expectedEvents].sort());
    expect(new Set(eventSummaries.map((event) => `${new Date(event.occurredAt).toISOString()}:${event.eventType}`)).size)
      .toBe(fixture.expectedEvents.length);
    expect(pages.map((page) => page.items).flat()).toHaveLength(5);
    expect(pages.map(({ page }) => page)).toEqual([
      { currentPage: 1, hasMore: true, pageSize: 2, totalItems: 5, totalPages: 3 },
      { currentPage: 2, hasMore: true, pageSize: 2, totalItems: 5, totalPages: 3 },
      { currentPage: 3, hasMore: false, pageSize: 2, totalItems: 5, totalPages: 3 },
    ]);
  });

  test('keeps a shop-A synthetic record when its only public event belongs to shop B', async () => {
    const fixture = await createSyntheticRecordIsolationFixture(prisma, createdShopIds, 'synthetic-event-isolation');
    const service = new PrismaDsvV1ReadQueryService(prisma, () => new Date('2026-07-22T15:30:00.000Z'));

    const [shopAEventCount, shopBEventCount] = await Promise.all([
      prisma.driverEvent.count({ where: { deliveryStopId: fixture.stopId, shopId: fixture.shopId } }),
      prisma.driverEvent.count({ where: { deliveryStopId: fixture.stopId, shopId: fixture.crossShopId } }),
    ]);

    const result = await service.listRecords(customerlessAdmin(fixture.shopId), { serviceDate: '2026-07-23' });

    expect(shopAEventCount).toBe(0);
    expect(shopBEventCount).toBe(1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      eventRows: [],
      sellerOrderKey: fixture.orderKey,
    });
    expect(result.items[0]?.proofRows).toEqual([
      expect.objectContaining({ deletedAt: fixture.expiredAt }),
    ]);
    expect(deriveDsvV1ProofStatus(result.items[0]?.proofRows ?? [])).toBe('EXPIRED');
    expect(JSON.stringify(result.items)).not.toContain(fixture.crossShopEventId);
  });

  test('rejects real and synthetic shop-A stops that reference shop-B orders', async () => {
    const fixture = await createRecordOrderIsolationFixture(prisma, createdShopIds, 'record-order-isolation');
    const service = new PrismaDsvV1ReadQueryService(prisma, () => new Date('2026-07-22T15:30:00.000Z'));

    await expect(createStop(
      prisma,
      fixture.shopId,
      fixture.realOrderId,
      'Real Record Isolation Recipient',
      '2026-07-23',
    )).rejects.toMatchObject({ code: 'P2003' });
    await expect(createStop(
      prisma,
      fixture.shopId,
      fixture.syntheticOrderId,
      'Synthetic Record Isolation Recipient',
      '2026-07-23',
    )).rejects.toMatchObject({ code: 'P2003' });

    const result = await service.listRecords(customerlessAdmin(fixture.shopId), { serviceDate: '2026-07-23' });

    expect(result.items).toEqual([]);
  });

  test('paginates nullable customer and destination labels by one emitted effective label', async () => {
    const fixture = await createNullLabelFixture(prisma, createdShopIds, 'null-labels');
    const service = new PrismaDsvV1ReadQueryService(prisma, () => new Date('2026-07-22T15:30:00.000Z'));

    const customerA = await service.listCustomers(customerlessAdmin(fixture.shopId), { limit: 1 });
    const customerB = await service.listCustomers(customerlessAdmin(fixture.shopId), {
      cursor: customerA.page.nextCursor ?? null,
      limit: 1,
    });
    const destinationA = await service.listDestinations(customerlessAdmin(fixture.shopId), { limit: 1 });
    const destinationB = await service.listDestinations(customerlessAdmin(fixture.shopId), {
      cursor: destinationA.page.nextCursor ?? null,
      limit: 1,
    });

    expect([customerA.items[0]?.displayName, customerB.items[0]?.displayName]).toEqual(['Alpha Fallback', 'Bravo Name']);
    expect(customerB.page.hasMore).toBe(false);
    expect([destinationA.items[0]?.displayName, destinationB.items[0]?.displayName]).toEqual([
      fixture.nullDestinationId,
      'Zulu Destination',
    ]);
    expect(destinationB.page.hasMore).toBe(false);
  });

  test('emits endpoint-specific management cursor sort identities for every management list', async () => {
    const fixture = await createManagementCursorSortFixture(prisma, createdShopIds, 'management-sort');
    const service = new PrismaDsvV1ReadQueryService(prisma, () => new Date('2026-07-22T15:30:00.000Z'));
    const admin = customerlessAdmin(fixture.shopId);
    const results = [
      { endpoint: 'drivers', result: await service.listDrivers(admin, { limit: 1 }), sort: 'displayName:asc,id:asc' },
      { endpoint: 'vehicles', result: await service.listVehicles(admin, { limit: 1 }), sort: 'displayName:asc,id:asc' },
      { endpoint: 'customers', result: await service.listCustomers(admin, { limit: 1 }), sort: 'displayName:asc,id:asc' },
      { endpoint: 'destinations', result: await service.listDestinations(admin, { limit: 1 }), sort: 'displayName:asc,id:asc' },
      { endpoint: 'conditions', result: await service.listConditions(admin, { limit: 1 }), sort: 'name:asc,id:asc' },
    ] as const;

    for (const entry of results) {
      expect(entry.result.page.nextCursor).toEqual(expect.any(String));
      const decoded = decodeCursor(entry.result.page.nextCursor ?? '');
      expect(decoded.endpoint).toBe(entry.endpoint);
      expect(decoded.limit).toBe(1);
      expect(decoded.shopId).toBe(fixture.shopId);
      expect(decoded.sort).toBe(entry.sort);
      expect(decoded.v).toBe(1);
      expect(decoded.last).not.toBeNull();
      expect(typeof decoded.last).toBe('object');
      await expect(readManagementWithCursor(service, entry.endpoint, admin, replaceCursorSort(
        entry.result.page.nextCursor ?? '',
        'label:asc,id:asc',
      ))).rejects.toMatchObject({ code: 'BAD_REQUEST', httpStatus: 400 } satisfies Partial<DsvV1ReadQueryError>);
    }
  });

  test('hard-fails invalid and conflicting active commerce connection timezones and falls back only when none exists', async () => {
    const unique = randomUUID();
    const fallbackShop = await createShop(prisma, `fallback-${unique}`);
    const conflictShop = await createShop(prisma, `conflict-${unique}`);
    const invalidShop = await createShop(prisma, `invalid-${unique}`);
    createdShopIds.push(fallbackShop.id, conflictShop.id, invalidShop.id);
    await Promise.all([
      createCommerceConnection(prisma, conflictShop.id, conflictShop.shopDomain, 'Asia/Seoul', 'a'),
      createCommerceConnection(prisma, conflictShop.id, conflictShop.shopDomain, 'UTC', 'b'),
      createCommerceConnection(prisma, invalidShop.id, invalidShop.shopDomain, 'Not/A_Timezone', 'a'),
    ]);
    const service = new PrismaDsvV1ReadQueryService(prisma, () => new Date('2026-07-22T15:30:00.000Z'));

    await expect(service.resolveTenantDates(fallbackShop.id)).resolves.toMatchObject({
      timezone: 'Asia/Seoul',
      today: '2026-07-23',
    });
    await expect(service.resolveTenantDates(conflictShop.id)).rejects.toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
      httpStatus: 503,
    } satisfies Partial<DsvV1ReadQueryError>);
    await expect(service.resolveTenantDates(invalidShop.id)).rejects.toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
      httpStatus: 503,
    } satisfies Partial<DsvV1ReadQueryError>);
  });
});

async function createFixture(
  prisma: PrismaClient,
  createdShopIds: string[],
  name: string,
  options: { extraSameDayCustomerAOrder?: boolean; mismatchedShopEvidence?: boolean } = {},
) {
  const unique = `${name}-${randomUUID()}`;
  const shop = await createShop(prisma, unique);
  createdShopIds.push(shop.id);
  await createCommerceConnection(prisma, shop.id, shop.shopDomain, 'Asia/Seoul', 'primary');

  const [customerA, customerB, sharedDestination, driver, vehicle] = await Promise.all([
    prisma.customer.create({
      data: {
        displayName: 'Customer A',
        externalCustomerCode: `CUST-A-${unique}`,
        shopId: shop.id,
        sourceKind: 'DSV_DISPATCH_IMPORT',
        status: 'ACTIVE',
      },
    }),
    prisma.customer.create({
      data: {
        displayName: 'Customer B',
        externalCustomerCode: `CUST-B-${unique}`,
        shopId: shop.id,
        sourceKind: 'DSV_DISPATCH_IMPORT',
        status: 'ACTIVE',
      },
    }),
    prisma.deliveryCustomerProfile.create({
      data: {
        addressFingerprint: `shared-${unique}`,
        canonicalName: 'Shared Destination X',
        normalizedAddress: { address1: '1 Shared Way', city: 'Seoul' },
        shopId: shop.id,
      },
    }),
    prisma.driver.create({ data: { displayName: 'Driver A', shopId: shop.id, status: 'ACTIVE' } }),
    prisma.vehicle.create({ data: { label: `Vehicle-${unique}`, shopId: shop.id, status: 'ACTIVE' } }),
  ]);

  const routePlan = await prisma.routePlan.create({
    data: {
      constraints: {},
      driverId: driver.id,
      metrics: {},
      name: 'Route A',
      optimizerVersion: 'g005-test',
      planDate: dateOnly('2026-07-23'),
      shopId: shop.id,
      status: 'READY',
      vehicleId: vehicle.id,
    },
  });
  const grouping = await prisma.routeGrouping.create({
    data: { name: 'Grouping A', planDate: dateOnly('2026-07-23'), shopId: shop.id, status: 'READY' },
  });
  const groupingVersion = await prisma.routeGroupingVersion.create({
    data: { groupingId: grouping.id, shopId: shop.id, status: 'CURRENT', version: 1 },
  });
  const routeVersionA = await prisma.routeGroupingChildVersion.create({
    data: {
      driverId: driver.id,
      groupingId: grouping.id,
      groupingVersionId: groupingVersion.id,
      routePlanId: routePlan.id,
      shopId: shop.id,
      snapshot: {},
      status: 'CURRENT',
      version: 1,
    },
  });

  const orderAKey = `SO-A-${unique}`;
  const orderBKey = `SO-B-${unique}`;
  const [orderA, orderB, orderANone, orderAExpired] = await Promise.all([
    createOrder(prisma, shop.id, customerA.id, sharedDestination.id, orderAKey, routeVersionA.id),
    createOrder(prisma, shop.id, customerB.id, sharedDestination.id, orderBKey, routeVersionA.id),
    createOrder(prisma, shop.id, customerA.id, sharedDestination.id, `SO-A-NONE-${unique}`, routeVersionA.id, '2026-07-24'),
    createOrder(prisma, shop.id, customerA.id, sharedDestination.id, `SO-A-EXPIRED-${unique}`, routeVersionA.id, '2026-07-25'),
  ]);
  const [stopA, stopB, stopANone, stopAExpired] = await Promise.all([
    createStop(prisma, shop.id, orderA.id, 'Recipient A', '2026-07-23'),
    createStop(prisma, shop.id, orderB.id, 'Recipient B', '2026-07-23'),
    createStop(prisma, shop.id, orderANone.id, 'Recipient A None', '2026-07-24'),
    createStop(prisma, shop.id, orderAExpired.id, 'Recipient A Expired', '2026-07-25'),
  ]);
  const importRecord = await createAppliedDispatchImport(prisma, shop.id, unique, '2026-07-23');
  await Promise.all([
    createAppliedDispatchImportRow(prisma, importRecord.id, shop.id, stopA.id, orderA.id, customerA.id, sharedDestination.id, orderAKey, 1, 6),
    createAppliedDispatchImportRow(prisma, importRecord.id, shop.id, stopB.id, orderB.id, customerB.id, sharedDestination.id, orderBKey, 2, 2),
    createAppliedDispatchImportRow(prisma, importRecord.id, shop.id, stopANone.id, orderANone.id, customerA.id, sharedDestination.id, `SO-A-NONE-${unique}`, 3, 1),
    createAppliedDispatchImportRow(prisma, importRecord.id, shop.id, stopAExpired.id, orderAExpired.id, customerA.id, sharedDestination.id, `SO-A-EXPIRED-${unique}`, 4, 8),
  ]);
  // Both rows reference the same route plan through composite foreign keys.
  // Insert in sequence so the fixture cannot deadlock on competing parent-row locks.
  await prisma.routePlanStop.create({
    data: {
      deliveryStopId: stopA.id,
      estimatedArrivalAt: new Date('2026-07-23T02:00:00.000Z'),
      etaInputRouteVersionId: routeVersionA.id,
      etaSource: 'ROUTE_CALCULATION',
      etaStatus: 'READY',
      routePlanId: routePlan.id,
      shopId: shop.id,
      sequence: 1,
    },
  });
  await prisma.routePlanStop.create({
    data: {
      deliveryStopId: stopB.id,
      etaInputRouteVersionId: routeVersionA.id,
      etaStatus: 'READY',
      routePlanId: routePlan.id,
      shopId: shop.id,
      sequence: 2,
    },
  });
  const allowedEvent = await prisma.driverEvent.create({
    data: {
      deliveryStopId: stopA.id,
      driverId: driver.id,
      eventType: 'STOP_DELIVERED',
      occurredAt: new Date('2026-07-23T03:00:00.000Z'),
      payload: { privateNote: 'must-not-serialize' },
      routePlanId: routePlan.id,
      shopId: shop.id,
    },
  });
  const forbiddenEvent = await prisma.driverEvent.create({
    data: {
      deliveryStopId: stopB.id,
      driverId: driver.id,
      eventType: 'NOTE_ADDED',
      occurredAt: new Date('2026-07-23T03:30:00.000Z'),
      payload: { note: 'other customer note' },
      routePlanId: routePlan.id,
      shopId: shop.id,
    },
  });
  await Promise.all([
    createProof(prisma, shop.id, routePlan.id, stopA.id, driver.id, 'storage-key-a', null),
    createProof(prisma, shop.id, routePlan.id, stopB.id, driver.id, 'storage-key-b', null),
    createProof(prisma, shop.id, routePlan.id, stopAExpired.id, driver.id, 'storage-key-expired', new Date('2026-07-26T00:00:00.000Z')),
  ]);
  let mismatchedShopEventId = '';
  if (options.mismatchedShopEvidence === true) {
    const extraShop = await createShop(prisma, `${unique}-mismatched-evidence`);
    createdShopIds.push(extraShop.id);
    const extraRoutePlan = await prisma.routePlan.create({
      data: {
        constraints: {},
        metrics: {},
        name: 'Mismatched Evidence Route',
        optimizerVersion: 'g005-test',
        planDate: dateOnly('2026-07-23'),
        shopId: extraShop.id,
        status: 'READY',
      },
    });
    const mismatchedEvent = await prisma.driverEvent.create({
      data: {
        deliveryStopId: stopA.id,
        eventType: 'STOP_FAILED',
        occurredAt: new Date('2026-07-23T04:30:00.000Z'),
        payload: { note: 'mismatched shop event must not serialize' },
        routePlanId: extraRoutePlan.id,
        shopId: extraShop.id,
      },
    });
    await createProof(prisma, extraShop.id, extraRoutePlan.id, stopA.id, null, 'storage-key-mismatched-shop', null);
    mismatchedShopEventId = mismatchedEvent.id;
  }
  let extraCustomerAOrderId = '';
  let extraCustomerAOrderKey = '';
  if (options.extraSameDayCustomerAOrder === true) {
    extraCustomerAOrderKey = `SO-A-CURSOR-${unique}`;
    const extraOrder = await createOrder(
      prisma,
      shop.id,
      customerA.id,
      sharedDestination.id,
      extraCustomerAOrderKey,
      routeVersionA.id,
    );
    const extraStop = await createStop(prisma, shop.id, extraOrder.id, 'Recipient A Cursor', '2026-07-23');
    await createAppliedDispatchImportRow(prisma, importRecord.id, shop.id, extraStop.id, extraOrder.id, customerA.id, sharedDestination.id, extraCustomerAOrderKey, 5, 4);
    extraCustomerAOrderId = extraOrder.id;
  }

  return {
    allowedEventId: allowedEvent.id,
    customerAId: customerA.id,
    customerBId: customerB.id,
    extraCustomerAOrderId,
    extraCustomerAOrderKey,
    forbiddenEventId: forbiddenEvent.id,
    mismatchedShopEventId,
    orderAId: orderA.id,
    orderAKey,
    orderBId: orderB.id,
    orderBKey,
    routePlanId: routePlan.id,
    routeVersionAId: routeVersionA.id,
    sharedDestinationId: sharedDestination.id,
    shopId: shop.id,
    stopAId: stopA.id,
    stopBId: stopB.id,
  };
}

async function createStaleEtaFixture(
  prisma: PrismaClient,
  createdShopIds: string[],
  name: string,
) {
  const unique = `${name}-${randomUUID()}`;
  const shop = await createShop(prisma, unique);
  createdShopIds.push(shop.id);
  await createCommerceConnection(prisma, shop.id, shop.shopDomain, 'Asia/Seoul', 'primary');

  const [customer, destination, driver, vehicle] = await Promise.all([
    createCustomer(prisma, shop.id, `CUST-STALE-${unique}`, 'Stale ETA Customer'),
    createDestination(prisma, shop.id, `stale-${unique}`, 'Stale ETA Destination'),
    prisma.driver.create({ data: { displayName: 'Driver Stale', shopId: shop.id, status: 'ACTIVE' } }),
    prisma.vehicle.create({ data: { label: `Vehicle-Stale-${unique}`, shopId: shop.id, status: 'ACTIVE' } }),
  ]);
  const routePlan = await prisma.routePlan.create({
    data: {
      constraints: {},
      driverId: driver.id,
      metrics: {},
      name: 'Stale ETA Route',
      optimizerVersion: 'g005-test',
      planDate: dateOnly('2026-07-23'),
      shopId: shop.id,
      status: 'READY',
      vehicleId: vehicle.id,
    },
  });
  const grouping = await prisma.routeGrouping.create({
    data: { name: 'Stale ETA Grouping', planDate: dateOnly('2026-07-23'), shopId: shop.id, status: 'READY' },
  });
  const groupingVersion = await prisma.routeGroupingVersion.create({
    data: { groupingId: grouping.id, shopId: shop.id, status: 'CURRENT', version: 1 },
  });
  // Both rows update FK-backed state under the same grouping/route parents.
  // Serialize fixture setup so PostgreSQL lock ordering cannot obscure the read-query assertion.
  const currentRouteVersion = await prisma.routeGroupingChildVersion.create({
    data: {
      driverId: driver.id,
      groupingId: grouping.id,
      groupingVersionId: groupingVersion.id,
      routePlanId: routePlan.id,
      shopId: shop.id,
      snapshot: {},
      status: 'CURRENT',
      version: 1,
    },
  });
  const staleRouteVersion = await prisma.routeGroupingChildVersion.create({
    data: {
      driverId: driver.id,
      groupingId: grouping.id,
      groupingVersionId: groupingVersion.id,
      routePlanId: routePlan.id,
      shopId: shop.id,
      snapshot: {},
      status: 'ARCHIVED',
      version: 2,
    },
  });
  const orderKey = `SO-STALE-${unique}`;
  const order = await createOrder(prisma, shop.id, customer.id, destination.id, orderKey, currentRouteVersion.id);
  const stop = await createStop(prisma, shop.id, order.id, 'Stale ETA Recipient', '2026-07-23');
  const appliedImport = await createAppliedDispatchImport(prisma, shop.id, `stale-eta-${unique}`, '2026-07-23');
  await createAppliedDispatchImportRow(
    prisma,
    appliedImport.id,
    shop.id,
    stop.id,
    order.id,
    customer.id,
    destination.id,
    orderKey,
    1,
    1,
  );
  await prisma.routePlanStop.create({
    data: {
      deliveryStopId: stop.id,
      estimatedArrivalAt: new Date('2026-07-23T09:00:00.000Z'),
      etaInputRouteVersionId: staleRouteVersion.id,
      etaSource: 'ROUTE_CALCULATION',
      etaStatus: 'READY',
      routePlanId: routePlan.id,
      shopId: shop.id,
      sequence: 1,
    },
  });

  return {
    customerId: customer.id,
    orderKey,
    shopId: shop.id,
    staleRouteVersionId: staleRouteVersion.id,
  };
}

async function createCustomerDeliveryOrderingFixture(
  prisma: PrismaClient,
  createdShopIds: string[],
  name: string,
) {
  const unique = `${name}-${randomUUID()}`;
  const shop = await createShop(prisma, unique);
  createdShopIds.push(shop.id);
  await createCommerceConnection(prisma, shop.id, shop.shopDomain, 'Asia/Seoul', 'primary');
  const customer = await createCustomer(prisma, shop.id, `CUST-ORDER-${unique}`, 'Ordering Customer');
  const destination = await createDestination(prisma, shop.id, `ordering-${unique}`, 'Ordering Destination');
  const lowKey = `SO-001-${unique}`;
  const highKey = `SO-002-${unique}`;
  const lowOrder = await createOrder(prisma, shop.id, customer.id, destination.id, lowKey, null);
  const highOrder = await createOrder(prisma, shop.id, customer.id, destination.id, highKey, null);
  const [lowStop, highStop] = await Promise.all([
    createStop(prisma, shop.id, lowOrder.id, 'Low Key', '2026-07-23'),
    createStop(prisma, shop.id, highOrder.id, 'High Key', '2026-07-23'),
  ]);
  const appliedImport = await createAppliedDispatchImport(prisma, shop.id, `ordering-${unique}`, '2026-07-23');
  await Promise.all([
    createAppliedDispatchImportRow(
      prisma,
      appliedImport.id,
      shop.id,
      lowStop.id,
      lowOrder.id,
      customer.id,
      destination.id,
      lowKey,
      1,
      1,
    ),
    createAppliedDispatchImportRow(
      prisma,
      appliedImport.id,
      shop.id,
      highStop.id,
      highOrder.id,
      customer.id,
      destination.id,
      highKey,
      2,
      1,
    ),
  ]);
  return { customerId: customer.id, highKey, lowKey, shopId: shop.id };
}

async function createRecordPaginationFixture(
  prisma: PrismaClient,
  createdShopIds: string[],
  name: string,
) {
  const unique = `${name}-${randomUUID()}`;
  const shop = await createShop(prisma, unique);
  createdShopIds.push(shop.id);
  await createCommerceConnection(prisma, shop.id, shop.shopDomain, 'Asia/Seoul', 'primary');
  const customer = await createCustomer(prisma, shop.id, `CUST-REC-${unique}`, 'Record Customer');
  const destination = await createDestination(prisma, shop.id, `record-${unique}`, 'Record Destination');
  const stops = [];
  for (let index = 0; index < 5; index += 1) {
    const order = await createOrder(
      prisma,
      shop.id,
      customer.id,
      destination.id,
      `SO-REC-${String(index + 1).padStart(3, '0')}-${unique}`,
      null,
    );
    stops.push(await createStop(prisma, shop.id, order.id, `Record ${index + 1}`, '2026-07-23'));
  }
  const eventInputs = [
    { eventType: 'STOP_DELIVERED' as const, occurredAt: new Date('2026-07-23T06:00:00.000Z'), stopId: stops[3]?.id },
    { eventType: 'STOP_ARRIVED' as const, occurredAt: new Date('2026-07-23T05:00:00.000Z'), stopId: stops[0]?.id },
    { eventType: 'STOP_FAILED' as const, occurredAt: new Date('2026-07-23T04:00:00.000Z'), stopId: stops[4]?.id },
    { eventType: 'ROUTE_STARTED' as const, occurredAt: new Date('2026-07-23T03:00:00.000Z'), stopId: stops[1]?.id },
  ];
  for (const event of eventInputs) {
    if (event.stopId === undefined) throw new Error('record pagination fixture failed to create stops');
    await prisma.driverEvent.create({
      data: {
        deliveryStopId: event.stopId,
        eventType: event.eventType,
        occurredAt: event.occurredAt,
        payload: {},
        shopId: shop.id,
      },
    });
  }
  return {
    expectedEvents: eventInputs.map((event) => `${event.occurredAt.toISOString()}:${event.eventType}`),
    shopId: shop.id,
  };
}

async function createSyntheticRecordIsolationFixture(
  prisma: PrismaClient,
  createdShopIds: string[],
  name: string,
) {
  const unique = `${name}-${randomUUID()}`;
  const [shopA, shopB] = await Promise.all([
    createShop(prisma, `${unique}-a`),
    createShop(prisma, `${unique}-b`),
  ]);
  createdShopIds.push(shopA.id, shopB.id);
  await createCommerceConnection(prisma, shopA.id, shopA.shopDomain, 'Asia/Seoul', 'primary');
  const [customer, destination, routePlanA, routePlanB] = await Promise.all([
    createCustomer(prisma, shopA.id, `CUST-SYNTHETIC-${unique}`, 'Synthetic Record Customer'),
    createDestination(prisma, shopA.id, `synthetic-${unique}`, 'Synthetic Record Destination'),
    prisma.routePlan.create({
      data: {
        constraints: {},
        metrics: {},
        name: 'Synthetic Record Route A',
        optimizerVersion: 'g005-test',
        planDate: dateOnly('2026-07-23'),
        shopId: shopA.id,
        status: 'READY',
      },
    }),
    prisma.routePlan.create({
      data: {
        constraints: {},
        metrics: {},
        name: 'Synthetic Record Route B',
        optimizerVersion: 'g005-test',
        planDate: dateOnly('2026-07-23'),
        shopId: shopB.id,
        status: 'READY',
      },
    }),
  ]);
  const orderKey = `SO-SYNTHETIC-${unique}`;
  const order = await createOrder(prisma, shopA.id, customer.id, destination.id, orderKey, null);
  const stop = await createStop(prisma, shopA.id, order.id, 'Synthetic Record Recipient', '2026-07-23');
  const expiredAt = new Date('2026-07-24T00:00:00.000Z');
  const crossShopEvent = await prisma.driverEvent.create({
    data: {
      deliveryStopId: stop.id,
      eventType: 'STOP_DELIVERED',
      occurredAt: new Date('2026-07-23T03:00:00.000Z'),
      payload: { note: 'shop B event must not suppress shop A synthetic record' },
      routePlanId: routePlanB.id,
      shopId: shopB.id,
    },
  });
  await Promise.all([
    createProof(prisma, shopA.id, routePlanA.id, stop.id, null, `synthetic-expired-${unique}`, expiredAt),
    createProof(prisma, shopB.id, routePlanB.id, stop.id, null, `synthetic-cross-shop-active-${unique}`, null),
  ]);

  return {
    crossShopId: shopB.id,
    crossShopEventId: crossShopEvent.id,
    expiredAt,
    orderKey,
    shopId: shopA.id,
    stopId: stop.id,
  };
}

async function createRecordOrderIsolationFixture(
  prisma: PrismaClient,
  createdShopIds: string[],
  name: string,
) {
  const unique = `${name}-${randomUUID()}`;
  const [shopA, shopB] = await Promise.all([
    createShop(prisma, `${unique}-a`),
    createShop(prisma, `${unique}-b`),
  ]);
  createdShopIds.push(shopB.id, shopA.id);
  await createCommerceConnection(prisma, shopA.id, shopA.shopDomain, 'Asia/Seoul', 'primary');
  const [customerB, destinationB] = await Promise.all([
    createCustomer(prisma, shopB.id, `CUST-ORDER-ISOLATION-${unique}`, 'Order Isolation Customer'),
    createDestination(prisma, shopB.id, `order-isolation-${unique}`, 'Order Isolation Destination'),
  ]);
  const [realOrder, syntheticOrder] = await Promise.all([
    createOrder(prisma, shopB.id, customerB.id, destinationB.id, `SO-REAL-ISOLATION-${unique}`, null),
    createOrder(prisma, shopB.id, customerB.id, destinationB.id, `SO-SYNTHETIC-ISOLATION-${unique}`, null),
  ]);
  return {
    realOrderId: realOrder.id,
    shopId: shopA.id,
    syntheticOrderId: syntheticOrder.id,
  };
}

async function createNullLabelFixture(
  prisma: PrismaClient,
  createdShopIds: string[],
  name: string,
) {
  const unique = `${name}-${randomUUID()}`;
  const shop = await createShop(prisma, unique);
  createdShopIds.push(shop.id);
  await Promise.all([
    createCommerceConnection(prisma, shop.id, shop.shopDomain, 'Asia/Seoul', 'primary'),
    createCustomer(prisma, shop.id, `Alpha Fallback`, null),
    createCustomer(prisma, shop.id, `CUST-BRAVO-${unique}`, 'Bravo Name'),
  ]);
  const [nullDestination] = await Promise.all([
    createDestination(prisma, shop.id, `alpha-destination-${unique}`, null),
    createDestination(prisma, shop.id, `zulu-destination-${unique}`, 'Zulu Destination'),
  ]);
  return { nullDestinationId: nullDestination.id, shopId: shop.id };
}

async function createManagementCursorSortFixture(
  prisma: PrismaClient,
  createdShopIds: string[],
  name: string,
) {
  const unique = `${name}-${randomUUID()}`;
  const shop = await createShop(prisma, unique);
  createdShopIds.push(shop.id);
  await Promise.all([
    createCommerceConnection(prisma, shop.id, shop.shopDomain, 'Asia/Seoul', 'primary'),
    prisma.driver.create({
      data: {
        displayName: `Alpha Driver ${unique}`,
        dsvProfile: { create: { lookupName: `Alpha Driver ${unique}` } },
        shopId: shop.id,
        status: 'ACTIVE',
      },
    }),
    prisma.driver.create({
      data: {
        displayName: `Beta Driver ${unique}`,
        dsvProfile: { create: { lookupName: `Beta Driver ${unique}` } },
        shopId: shop.id,
        status: 'ACTIVE',
      },
    }),
    prisma.vehicle.create({
      data: {
        dsvProfile: { create: { note: '', typeLabel: 'Test vehicle' } },
        label: `Alpha Vehicle ${unique}`,
        licensePlate: `A-${unique}`,
        shopId: shop.id,
        status: 'ACTIVE',
      },
    }),
    prisma.vehicle.create({
      data: {
        dsvProfile: { create: { note: '', typeLabel: 'Test vehicle' } },
        label: `Beta Vehicle ${unique}`,
        licensePlate: `B-${unique}`,
        shopId: shop.id,
        status: 'ACTIVE',
      },
    }),
    createCustomer(prisma, shop.id, `A-CUSTOMER-${unique}`, `Alpha Customer ${unique}`),
    createCustomer(prisma, shop.id, `B-CUSTOMER-${unique}`, `Beta Customer ${unique}`),
    createDestination(prisma, shop.id, `alpha-management-${unique}`, `Alpha Destination ${unique}`),
    createDestination(prisma, shop.id, `beta-management-${unique}`, `Beta Destination ${unique}`),
    prisma.dsvTransportCondition.create({
      data: {
        code: `A-COND-${unique}`,
        description: 'Alpha condition',
        name: `Alpha Condition ${unique}`,
        shopId: shop.id,
        status: 'ACTIVE',
      },
    }),
    prisma.dsvTransportCondition.create({
      data: {
        code: `B-COND-${unique}`,
        description: 'Beta condition',
        name: `Beta Condition ${unique}`,
        shopId: shop.id,
        status: 'ACTIVE',
      },
    }),
  ]);
  return { shopId: shop.id };
}

async function createCustomer(
  prisma: PrismaClient,
  shopId: string,
  externalCustomerCode: string,
  displayName: string | null,
) {
  return prisma.customer.create({
    data: {
      displayName,
      externalCustomerCode,
      shopId,
      sourceKind: 'DSV_DISPATCH_IMPORT',
      status: 'ACTIVE',
    },
  });
}

async function createDestination(
  prisma: PrismaClient,
  shopId: string,
  addressFingerprint: string,
  canonicalName: string | null,
) {
  return prisma.deliveryCustomerProfile.create({
    data: {
      addressFingerprint,
      canonicalName,
      normalizedAddress: { address1: '1 Shared Way', city: 'Seoul' },
      shopId,
    },
  });
}

async function createShop(prisma: PrismaClient, unique: string) {
  return prisma.shop.create({
    data: {
      appId: 'clever',
      shopDomain: `g005-${unique}.example.test`,
      shopifyShopGid: `gid://shopify/Shop/g005-${unique}`,
    },
  });
}

async function createCommerceConnection(
  prisma: PrismaClient,
  shopId: string,
  shopDomain: string,
  timezone: string | null,
  suffix: string,
) {
  return prisma.commerceConnection.create({
    data: {
      consumerKeyCiphertext: `key-${suffix}`,
      consumerSecretCiphertext: `secret-${suffix}`,
      platform: 'WOOCOMMERCE',
      shopDomain,
      shopId,
      siteUrl: `https://${suffix}.${shopDomain}`,
      status: 'ACTIVE',
      timezone,
      webhookSecretCiphertext: `webhook-${suffix}`,
    },
  });
}

async function createOrder(
  prisma: PrismaClient,
  shopId: string,
  customerId: string,
  destinationId: string,
  sellerOrderKey: string | null,
  currentRouteVersionId: string | null,
  serviceDate = '2026-07-23',
) {
  const sourceKey = sellerOrderKey ?? `NULL-SELLER-${randomUUID()}`;
  const datedSourceKey = `${serviceDate}:${sourceKey}`;
  return prisma.order.create({
    data: {
      currentRouteVersionId,
      customerId,
      destinationId,
      name: sourceKey,
      rawPayload: {},
      sellerOrderKey,
      sellerOrderSourceKind: 'DSV_DISPATCH_IMPORT',
      serviceDate: dateOnly(serviceDate),
      shopId,
      shopifyOrderGid: `dsv:DSV_DISPATCH_IMPORT:${datedSourceKey}`,
      sourceOrderId: datedSourceKey,
      sourcePlatform: 'SHOPIFY',
    },
  });
}

async function createStop(
  prisma: PrismaClient,
  shopId: string,
  orderId: string,
  recipientName: string,
  serviceDate: string,
) {
  return prisma.deliveryStop.create({
    data: {
      address1: '1 Shared Way',
      countryCode: 'KR',
      deliveryDate: dateOnly(serviceDate),
      orderId,
      recipientName,
      shopId,
      status: 'PENDING',
    },
  });
}

function createAppliedDispatchImport(
  prisma: PrismaClient,
  shopId: string,
  unique: string,
  serviceDate: string,
) {
  return prisma.dsvDispatchImport.create({
    data: {
      appliedAt: new Date(`${serviceDate}T00:30:00.000Z`),
      fileName: `${unique}.csv`,
      planDate: dateOnly(serviceDate),
      previewHash: `preview-${unique}`,
      rowCount: 5,
      shopId,
      sourceHash: `source-${unique}`,
      status: 'APPLIED',
    },
  });
}

function createAppliedDispatchImportRow(
  prisma: PrismaClient,
  importId: string,
  shopId: string,
  deliveryStopId: string,
  sellerOrderId: string,
  customerId: string,
  destinationId: string,
  sellerOrderKey: string,
  rowNumber: number,
  shippedBoxes: number,
) {
  return prisma.dsvDispatchImportRow.create({
    data: {
      address: '1 Shared Way',
      appliedAt: new Date('2026-07-23T00:35:00.000Z'),
      conditionCode: 'AMBIENT',
      customerCode: `CUST-${rowNumber}`,
      customerId,
      deliveryStopId,
      destinationId,
      destinationName: 'Shared Destination X',
      diffKind: 'UNCHANGED',
      driverName: 'Driver A',
      importId,
      issues: [],
      normalized: { shippedBoxes },
      previewHash: `preview-row-${rowNumber}-${sellerOrderId}`,
      rowNumber,
      sellerOrderId,
      sellerOrderKey,
      shippedBoxes,
      shopId,
      sourceHash: `source-row-${rowNumber}-${sellerOrderId}`,
      status: 'APPLIED',
      vehiclePlate: '서울86바3800',
    },
  });
}

async function createProof(
  prisma: PrismaClient,
  shopId: string,
  routePlanId: string,
  deliveryStopId: string,
  driverId: string | null,
  storageKey: string,
  deletedAt: Date | null,
) {
  return prisma.driverProofMedia.create({
    data: {
      contentType: 'image/jpeg',
      deletedAt,
      deliveryStopId,
      driverId,
      kind: 'PHOTO',
      originalFilename: `${storageKey}.jpg`,
      routePlanId,
      sha256: `${storageKey}-sha256`,
      shopId,
      sizeBytes: 123,
      source: 'CAMERA',
      storageKey,
      uploadedAt: new Date('2026-07-23T04:00:00.000Z'),
    },
  });
}

function customerPrincipal(shopId: string, customerId: string): DsvCustomerUserPrincipal {
  return {
    customerId,
    principalType: 'CUSTOMER_USER',
    scopes: ['dsv:customer-deliveries:read'],
    shopId,
  };
}

function customerlessAdmin(shopId: string) {
  return {
    principalType: 'DSV_ADMIN' as const,
    scopes: ['dsv:records:read'] as const,
    shopId,
  };
}

type TestCursorPayload = {
  endpoint: string;
  last: unknown;
  limit: number;
  shopId: string;
  sort: string;
  v: number;
};

function decodeCursor(cursor: string): TestCursorPayload {
  return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as TestCursorPayload;
}

function replaceCursorSort(cursor: string, sort: string): string {
  return Buffer.from(JSON.stringify({ ...decodeCursor(cursor), sort }), 'utf8').toString('base64url');
}

function readManagementWithCursor(
  service: PrismaDsvV1ReadQueryService,
  endpoint: 'conditions' | 'customers' | 'destinations' | 'drivers' | 'vehicles',
  admin: ReturnType<typeof customerlessAdmin>,
  cursor: string,
) {
  switch (endpoint) {
    case 'conditions':
      return service.listConditions(admin, { cursor, limit: 1 });
    case 'customers':
      return service.listCustomers(admin, { cursor, limit: 1 });
    case 'destinations':
      return service.listDestinations(admin, { cursor, limit: 1 });
    case 'drivers':
      return service.listDrivers(admin, { cursor, limit: 1 });
    case 'vehicles':
      return service.listVehicles(admin, { cursor, limit: 1 });
  }
}

function dateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

async function canonicalCounts(prisma: PrismaClient, shopId: string) {
  const [orders, stops, events, proofs] = await Promise.all([
    prisma.order.count({ where: { shopId } }),
    prisma.deliveryStop.count({ where: { shopId } }),
    prisma.driverEvent.count({ where: { shopId } }),
    prisma.driverProofMedia.count({ where: { shopId } }),
  ]);
  return { events, orders, proofs, stops };
}
