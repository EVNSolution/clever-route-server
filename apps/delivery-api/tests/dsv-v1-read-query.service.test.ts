import { describe, expect, test, vi } from 'vitest';

import {
  PrismaDsvV1ReadQueryService,
  dsvV1ReadDefaultLimit,
  dsvV1ReadFallbackTimezone,
  dsvV1ReadMaxLimit,
} from '../src/modules/dsv/dsv-v1-read-query.service.js';
import type { DsvV1ReadQueryError } from '../src/modules/dsv/dsv-v1-read-query.service.js';
import type { DsvAdminPrincipal, DsvCustomerUserPrincipal } from '../src/modules/dsv/dsv-principal.js';

describe('PrismaDsvV1ReadQueryService', () => {
  test('customer deliveries start from Order scoped by shopId and principal customerId', async () => {
    const prisma = prismaMock({
      commerceConnection: { findMany: vi.fn(() => Promise.resolve([{ timezone: 'Asia/Seoul' }])) },
      order: { findMany: vi.fn(() => Promise.resolve([])) },
    });
    const service = new PrismaDsvV1ReadQueryService(prisma as never, () => new Date('2026-07-22T12:00:00.000Z'));

    await service.listCustomerDeliveries(customerPrincipal(), { window: 'today' });

    expect(prisma.order.findMany).toHaveBeenCalledOnce();
    const firstOrderQuery = firstMockArg<OrderFindManyQuery>(prisma.order.findMany);
    expect(firstOrderQuery?.orderBy).toEqual([{ sellerOrderKey: 'asc' }, { id: 'asc' }]);
    expect(firstOrderQuery?.take).toBe(dsvV1ReadDefaultLimit + 1);
    expect(firstOrderQuery?.where).toMatchObject({ customerId: 'customer-a', shopId: 'shop-a' });
    expect(firstOrderQuery?.where).not.toHaveProperty('destinationId');
    const deliveryStopsSelect = firstOrderQuery?.select?.deliveryStops as NestedDeliveryStopsSelect | undefined;
    expect(deliveryStopsSelect?.where).toEqual({ deliveryDate: new Date('2026-07-22T00:00:00.000Z'), shopId: 'shop-a' });
    expect(deliveryStopsSelect?.select.driverEvents.where.shopId).toBe('shop-a');
    expect(deliveryStopsSelect?.select.driverEvents.where.eventType.in).toContain('STOP_DELIVERED');
    expect(deliveryStopsSelect?.select.driverEvents.where.eventType.in).not.toContain('PICKUP_COMPLETED');
    expect(deliveryStopsSelect?.select.dsvDispatchImportRows.select).toEqual({ conditionCode: true, shippedBoxes: true });
    expect(deliveryStopsSelect?.select.dsvDispatchImportRows.where).toEqual({ shopId: 'shop-a', status: 'APPLIED' });
    expect(deliveryStopsSelect?.select.driverProofMedia.where).toEqual({ shopId: 'shop-a' });
    expect(deliveryStopsSelect?.select.routePlanStops.where).toEqual({ shopId: 'shop-a' });
    expect(firstOrderQuery?.select?.orderMessages).toMatchObject({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        audience: true,
        authorId: true,
        authorType: true,
        body: true,
        createdAt: true,
        id: true,
        readByDriverAt: true,
      },
      take: 20,
      where: { shopId: 'shop-a' },
    });
    expect(firstOrderQuery?.select?.destinationId).toBe(true);
    expect(prisma.$transaction).toBeUndefined();
  });

  test('loads the complete lightweight customer route scope independently of page size', async () => {
    const prisma = prismaMock({
      order: { findMany: vi.fn(() => Promise.resolve([
        {
          currentRouteVersion: {
            routePlanId: 'route-a',
            routePlan: {
              trackingGeometry: { lastLatitude: '37.5000000', lastLongitude: '127.0000000' },
              vehicleId: 'vehicle-a',
            },
          },
          id: 'order-a',
        },
        {
          currentRouteVersion: {
            routePlanId: 'route-without-position',
            routePlan: {
              trackingGeometry: null,
              vehicleId: 'vehicle-without-position',
            },
          },
          id: 'order-without-position',
        },
        { currentRouteVersion: null, id: 'order-without-route' },
      ])) },
      uvisVehicleTelemetryCurrent: { findMany: vi.fn(() => Promise.resolve([
        {
          distanceTodayKm: null,
          id: 'fresh-gps',
          ignitionOn: true,
          latitude: '37.6000000',
          longitude: '127.1000000',
          observedAt: new Date('2026-07-22T01:00:00.000Z'),
          sourceKind: 'VEHICLE_GPS',
          speedKph: '10.00',
          staleAfter: new Date('2026-07-22T01:10:00.000Z'),
          temperatureA: null,
          temperatureB: null,
          vehicleId: 'vehicle-a',
        },
        {
          distanceTodayKm: null,
          id: 'stale-gps',
          ignitionOn: true,
          latitude: '37.7000000',
          longitude: '127.2000000',
          observedAt: new Date('2026-07-22T01:00:00.000Z'),
          sourceKind: 'VEHICLE_GPS',
          speedKph: '10.00',
          staleAfter: new Date('2026-07-22T00:59:00.000Z'),
          temperatureA: null,
          temperatureB: null,
          vehicleId: 'vehicle-without-position',
        },
      ])) },
    });
    const service = new PrismaDsvV1ReadQueryService(prisma as never, () => new Date('2026-07-22T01:05:00.000Z'));

    await expect(service.listCustomerRouteScope(customerPrincipal(), '2026-07-22')).resolves.toEqual([{
      routePlanId: 'route-a',
      sellerOrderId: 'order-a',
      vehicleId: 'vehicle-a',
      vehicleLatitude: 37.6,
      vehicleLongitude: 127.1,
    }, {
      routePlanId: 'route-without-position',
      sellerOrderId: 'order-without-position',
      vehicleId: 'vehicle-without-position',
      vehicleLatitude: null,
      vehicleLongitude: null,
    }]);
    const query = firstMockArg<OrderFindManyQuery>(prisma.order.findMany);
    expect(query?.take).toBeUndefined();
    expect(query?.where).toMatchObject({
      customerId: 'customer-a',
      deliveryStops: { some: { deliveryDate: new Date('2026-07-22T00:00:00.000Z'), shopId: 'shop-a' } },
      shopId: 'shop-a',
    });
  });

  test('resolves tenant timezone from the single active commerce connection timezone', async () => {
    const prisma = prismaMock({
      commerceConnection: { findMany: vi.fn(() => Promise.resolve([{ timezone: 'America/Toronto' }])) },
    });
    const service = new PrismaDsvV1ReadQueryService(prisma as never, () => new Date('2026-07-23T03:30:00.000Z'));

    await expect(service.resolveTenantDates('shop-a')).resolves.toEqual({
      dayAfterTomorrow: '2026-07-24',
      timezone: 'America/Toronto',
      today: '2026-07-22',
      tomorrow: '2026-07-23',
    });
  });

  test('falls back explicitly to Asia/Seoul when no active connection timezone exists', async () => {
    const prisma = prismaMock({
      commerceConnection: { findMany: vi.fn(() => Promise.resolve([])) },
    });
    const service = new PrismaDsvV1ReadQueryService(prisma as never, () => new Date('2026-07-22T15:30:00.000Z'));

    await expect(service.resolveTenantDates('shop-a')).resolves.toMatchObject({
      timezone: dsvV1ReadFallbackTimezone,
      today: '2026-07-23',
    });
  });

  test('rejects conflicting or invalid active connection timezones as typed configuration errors', async () => {
    const conflicting = new PrismaDsvV1ReadQueryService(prismaMock({
      commerceConnection: { findMany: vi.fn(() => Promise.resolve([{ timezone: 'Asia/Seoul' }, { timezone: 'UTC' }])) },
    }) as never);
    const invalid = new PrismaDsvV1ReadQueryService(prismaMock({
      commerceConnection: { findMany: vi.fn(() => Promise.resolve([{ timezone: 'Not/A_Timezone' }])) },
    }) as never);

    await expect(conflicting.resolveTenantDates('shop-a')).rejects.toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
      httpStatus: 503,
    } satisfies Partial<DsvV1ReadQueryError>);
    await expect(invalid.resolveTenantDates('shop-a')).rejects.toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
      httpStatus: 503,
    } satisfies Partial<DsvV1ReadQueryError>);
  });

  test('allows an explicit historical customer date and rejects window/serviceDate mismatch', async () => {
    const service = new PrismaDsvV1ReadQueryService(prismaMock({
      commerceConnection: { findMany: vi.fn(() => Promise.resolve([{ timezone: 'Asia/Seoul' }])) },
      order: { findMany: vi.fn(() => Promise.resolve([])) },
    }) as never, () => new Date('2026-07-22T12:00:00.000Z'));

    const historical = await service.listCustomerDeliveries(customerPrincipal(), { serviceDate: '2026-08-01' });
    expect(historical).toMatchObject({ emptyReason: 'NO_DELIVERIES', items: [], serviceDate: '2026-08-01' });
    await expect(service.listCustomerDeliveries(customerPrincipal(), {
      serviceDate: '2026-07-23',
      window: 'today',
    })).rejects.toMatchObject({ code: 'BAD_REQUEST', httpStatus: 400 });
  });

  test('enforces default and max cursor limits', async () => {
    const prisma = prismaMock({
      commerceConnection: { findMany: vi.fn(() => Promise.resolve([{ timezone: 'Asia/Seoul' }])) },
      order: { findMany: vi.fn(() => Promise.resolve([])) },
    });
    const service = new PrismaDsvV1ReadQueryService(prisma as never, () => new Date('2026-07-22T12:00:00.000Z'));

    await service.listCustomerDeliveries(customerPrincipal());
    expect(firstMockArg<OrderFindManyQuery>(prisma.order.findMany)?.take).toBe(dsvV1ReadDefaultLimit + 1);
    await expect(service.listCustomerDeliveries(customerPrincipal(), { limit: dsvV1ReadMaxLimit + 1 }))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  test('emits an opaque filter-bound cursor and rejects it under a different principal customer', async () => {
    const rows = [
      customerDeliveryOrderRow({ id: 'order-a', sellerOrderKey: 'SO-A' }),
      customerDeliveryOrderRow({ id: 'order-b', sellerOrderKey: 'SO-B' }),
    ];
    const prisma = prismaMock({
      commerceConnection: { findMany: vi.fn(() => Promise.resolve([{ timezone: 'Asia/Seoul' }])) },
      order: { findMany: vi.fn(() => Promise.resolve(rows)) },
    });
    const service = new PrismaDsvV1ReadQueryService(prisma as never, () => new Date('2026-07-22T12:00:00.000Z'));

    const first = await service.listCustomerDeliveries(customerPrincipal(), { limit: 1, serviceDate: '2026-07-22' });

    expect(first.page.nextCursor).toEqual(expect.any(String));
    expect(first.page.nextCursor).toBeDefined();
    await expect(service.listCustomerDeliveries(
      { ...customerPrincipal(), customerId: 'customer-b' },
      { cursor: first.page.nextCursor ?? null, limit: 1, serviceDate: '2026-07-22' },
    )).rejects.toMatchObject({ code: 'BAD_REQUEST', httpStatus: 400 });
  });

  test('customer delivery cursor preserves null sellerOrderKey without skipping non-null orders', async () => {
    const rows = [
      customerDeliveryOrderRow({ id: 'order-a', sellerOrderKey: null }),
      customerDeliveryOrderRow({ id: 'order-b', sellerOrderKey: 'SO-B' }),
    ];
    const prisma = prismaMock({
      commerceConnection: { findMany: vi.fn(() => Promise.resolve([{ timezone: 'Asia/Seoul' }])) },
      order: { findMany: vi.fn(() => Promise.resolve(rows)) },
    });
    const service = new PrismaDsvV1ReadQueryService(prisma as never, () => new Date('2026-07-22T12:00:00.000Z'));

    const first = await service.listCustomerDeliveries(customerPrincipal(), { limit: 1, serviceDate: '2026-07-22' });
    await service.listCustomerDeliveries(customerPrincipal(), {
      cursor: first.page.nextCursor ?? null,
      limit: 1,
      serviceDate: '2026-07-22',
    });

    expect(first.items.map((item) => item.sellerOrderKey)).toEqual(['order-a']);
    expect(first.page.nextCursor).toEqual(expect.any(String));
    expect((prisma.order.findMany as ReturnType<typeof vi.fn>).mock.calls[1]?.[0]).toMatchObject({
      where: {
        OR: [
          { sellerOrderKey: null, id: { gt: 'order-a' } },
          { sellerOrderKey: { not: null } },
        ],
      },
    });
  });

  test('customer list paginates nullable display names by the emitted fallback label', async () => {
    const prisma = prismaMock({
      $queryRaw: vi.fn(() => Promise.resolve([
        { displayName: 'Alpha', externalCustomerCode: 'Alpha', id: 'customer-a', orderCount: 3, status: 'ACTIVE' },
        { displayName: 'Beta', externalCustomerCode: 'Beta', id: 'customer-b', orderCount: 0, status: 'ACTIVE' },
      ])),
    });
    const service = new PrismaDsvV1ReadQueryService(prisma as never);

    const result = await service.listCustomers(adminPrincipal(), { limit: 1 });
    const queryText = sqlText((prisma.$queryRaw as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]);

    expect(result.items).toEqual([{
      customerId: 'customer-a',
      displayName: 'Alpha',
      externalCustomerCode: 'Alpha',
      orderCount: 3,
      status: 'ACTIVE',
    }]);
    expect(result.page.nextCursor).toEqual(expect.any(String));
    expect(queryText).toContain('COALESCE("displayName", "externalCustomerCode") AS "displayName"');
    expect(queryText).toContain('SELECT COUNT(*)::int');
    expect(queryText).toContain('orders."customerId" = customers.id');
    expect(queryText).toContain('ORDER BY LOWER(COALESCE("displayName", "externalCustomerCode")) ASC, id ASC');
  });

  test('destination list cursor uses the emitted effective label and stable id in SQL', async () => {
    const prisma = prismaMock({
      $queryRaw: vi.fn()
        .mockResolvedValueOnce([
          { displayName: '00000000-0000-4000-8000-000000000001', id: '00000000-0000-4000-8000-000000000001', normalizedAddress: {} },
          { displayName: 'Zulu Destination', id: '00000000-0000-4000-8000-000000000002', normalizedAddress: {} },
        ])
        .mockResolvedValueOnce([
          { displayName: 'Zulu Destination', id: '00000000-0000-4000-8000-000000000002', normalizedAddress: {} },
        ]),
    });
    const service = new PrismaDsvV1ReadQueryService(prisma as never);

    const first = await service.listDestinations(adminPrincipal(), { limit: 1 });
    const second = await service.listDestinations(adminPrincipal(), { cursor: first.page.nextCursor ?? null, limit: 1 });
    const secondQueryText = sqlText((prisma.$queryRaw as ReturnType<typeof vi.fn>).mock.calls[1]?.[0]);

    expect(second.items.map((item) => item.displayName)).toEqual(['Zulu Destination']);
    expect(secondQueryText).toContain('COALESCE("canonicalName", id::text) AS "displayName"');
    expect(secondQueryText).toContain('LOWER(COALESCE("canonicalName", id::text)) > LOWER(');
    expect(secondQueryText).toContain('LOWER(COALESCE("canonicalName", id::text)) = LOWER(');
    expect(secondQueryText).toContain('id::text >');
    expect(secondQueryText).toContain('ORDER BY LOWER(COALESCE("canonicalName", id::text)) ASC, id ASC');
  });

  test('scopes one record per delivery stop through the related order shop', async () => {
    const prisma = prismaMock({
      commerceConnection: { findMany: vi.fn(() => Promise.resolve([{ timezone: 'Asia/Seoul' }])) },
      deliveryStop: {
        count: vi.fn(() => Promise.resolve(0)),
        findMany: vi.fn(() => Promise.resolve([])),
      },
    });
    const service = new PrismaDsvV1ReadQueryService(prisma as never, () => new Date('2026-07-22T12:00:00.000Z'));

    await service.listRecords(adminPrincipal(), { serviceDate: '2026-07-22' });

    expect(prisma.deliveryStop.findMany).toHaveBeenCalledOnce();
    const query = firstMockArg<DeliveryStopFindManyQuery>(prisma.deliveryStop.findMany);
    expect(query?.where?.shopId).toBe('shop-a');
    expect(query?.where?.order).toEqual({ shopId: 'shop-a' });
  });

  test('lists all record dates by default and applies numbered page offsets', async () => {
    const prisma = prismaMock({
      deliveryStop: {
        count: vi.fn(() => Promise.resolve(125)),
        findMany: vi.fn(() => Promise.resolve([])),
      },
    });
    const service = new PrismaDsvV1ReadQueryService(prisma as never);

    const result = await service.listRecords(adminPrincipal(), { limit: 50, page: 2 });

    expect(prisma.deliveryStop.findMany).toHaveBeenCalledWith(expect.objectContaining({
      skip: 50,
      take: 50,
      where: {
        order: { shopId: 'shop-a' },
        shopId: 'shop-a',
      },
    }));
    expect(result.page).toEqual({
      currentPage: 2,
      hasMore: true,
      pageSize: 50,
      totalItems: 125,
      totalPages: 3,
    });
  });

  test('returns proof metadata and an ordered event timeline for each delivery record', async () => {
    const prisma = prismaMock({
      commerceConnection: { findMany: vi.fn(() => Promise.resolve([{ timezone: 'Asia/Seoul' }])) },
      deliveryStop: {
        count: vi.fn(() => Promise.resolve(1)),
        findMany: vi.fn(() => Promise.resolve([{
          address1: '퇴계로 131',
          address2: '5층',
          city: '서울 중구',
          countryCode: 'KR',
          dsvDispatchImportRows: [{
            address: '서울 중구 퇴계로 131, 5층(충무로2가, 신일빌딩)',
          }],
          driverEvents: [{
            driver: { displayName: '김도윤' },
            eventType: 'STOP_DELIVERED',
            id: 'event-1',
            latitude: '37.5600000',
            longitude: '126.9900000',
            occurredAt: new Date('2026-07-22T01:00:00.000Z'),
          }],
          driverProofMedia: [{
            contentType: 'image/jpeg',
            deletedAt: null,
            driver: { displayName: '김도윤' },
            id: 'proof-1',
            kind: 'PHOTO',
            originalFilename: 'delivery.jpg',
            sizeBytes: 2048,
            source: 'CAMERA',
            uploadedAt: new Date('2026-07-22T01:01:00.000Z'),
          }],
          id: 'stop-1',
          order: {
            currentRouteVersionId: null,
            deliveryStatus: 'OUT_FOR_DELIVERY',
            destination: { canonicalName: '명동 병원' },
            id: 'order-1',
            sellerOrderKey: 'SO-001',
            sellerOrderSourceKind: 'DSV_DISPATCH_IMPORT',
            sourceOrderNumber: null,
          },
          postalCode: '04536',
          province: '서울특별시',
          recipientName: '명동 병원',
          routePlanStops: [],
          status: 'DELIVERED',
          updatedAt: new Date('2026-07-22T01:02:00.000Z'),
        }])),
      },
    });
    const service = new PrismaDsvV1ReadQueryService(prisma as never, () => new Date('2026-07-22T12:00:00.000Z'));

    const result = await service.listRecords(adminPrincipal(), { serviceDate: '2026-07-22' });
    expect(result.items[0]?.deliveryStatus).toBe('DELIVERED');
    expect(result.items[0]?.destinationAddress).toBe('서울 중구 퇴계로 131, 5층(충무로2가, 신일빌딩)');
    expect(result.page).toEqual({
      currentPage: 1,
      hasMore: false,
      pageSize: 50,
      totalItems: 1,
      totalPages: 1,
    });
    expect(result).toMatchObject({
      items: [{
        eventRows: [{
          driverDisplayName: '김도윤',
          eventId: 'event-1',
          eventType: 'STOP_DELIVERED',
          latitude: 37.56,
          longitude: 126.99,
        }],
        proofRows: [{
          contentType: 'image/jpeg',
          driverDisplayName: '김도윤',
          proofId: 'proof-1',
          sizeBytes: 2048,
        }],
        sellerOrderId: 'order-1',
        sellerOrderKey: 'SO-001',
      }],
    });
  });

  test('management cursors bind endpoint-specific frozen sort identities', async () => {
    const cases = [
      {
        call: (service: PrismaDsvV1ReadQueryService, cursor?: string | null) =>
          service.listDrivers(adminPrincipal(), { ...(cursor === undefined ? {} : { cursor }), limit: 1 }),
        endpoint: 'drivers',
        prisma: prismaMock({
          driver: { findMany: vi.fn(() => Promise.resolve([
            { displayName: 'Alpha Driver', id: 'driver-a', phone: null, status: 'ACTIVE' },
            { displayName: 'Beta Driver', id: 'driver-b', phone: null, status: 'ACTIVE' },
          ])) },
        }),
        sort: 'displayName:asc,id:asc',
      },
      {
        call: (service: PrismaDsvV1ReadQueryService, cursor?: string | null) =>
          service.listVehicles(adminPrincipal(), { ...(cursor === undefined ? {} : { cursor }), limit: 1 }),
        endpoint: 'vehicles',
        prisma: prismaMock({
          dsvVehicleDriverAssignment: { findMany: vi.fn(() => Promise.resolve([])) },
          vehicle: { findMany: vi.fn(() => Promise.resolve([
            { id: 'vehicle-a', label: 'Alpha Vehicle', licensePlate: 'A', status: 'ACTIVE', vehicleType: 'VAN' },
            { id: 'vehicle-b', label: 'Beta Vehicle', licensePlate: 'B', status: 'ACTIVE', vehicleType: 'VAN' },
          ])) },
        }),
        sort: 'displayName:asc,id:asc',
      },
      {
        call: (service: PrismaDsvV1ReadQueryService, cursor?: string | null) =>
          service.listCustomers(adminPrincipal(), { ...(cursor === undefined ? {} : { cursor }), limit: 1 }),
        endpoint: 'customers',
        prisma: prismaMock({
          $queryRaw: vi.fn(() => Promise.resolve([
            { displayName: 'Alpha Customer', externalCustomerCode: 'A', id: 'customer-a', orderCount: 1, status: 'ACTIVE' },
            { displayName: 'Beta Customer', externalCustomerCode: 'B', id: 'customer-b', orderCount: 2, status: 'ACTIVE' },
          ])),
        }),
        sort: 'displayName:asc,id:asc',
      },
      {
        call: (service: PrismaDsvV1ReadQueryService, cursor?: string | null) =>
          service.listDestinations(adminPrincipal(), { ...(cursor === undefined ? {} : { cursor }), limit: 1 }),
        endpoint: 'destinations',
        prisma: prismaMock({
          $queryRaw: vi.fn(() => Promise.resolve([
            { displayName: 'Alpha Destination', id: 'destination-a', normalizedAddress: {} },
            { displayName: 'Beta Destination', id: 'destination-b', normalizedAddress: {} },
          ])),
        }),
        sort: 'displayName:asc,id:asc',
      },
      {
        call: (service: PrismaDsvV1ReadQueryService, cursor?: string | null) =>
          service.listConditions(adminPrincipal(), { ...(cursor === undefined ? {} : { cursor }), limit: 1 }),
        endpoint: 'conditions',
        prisma: prismaMock({
          dsvTransportCondition: { findMany: vi.fn(() => Promise.resolve([
            { code: 'A', description: 'Alpha description', id: 'condition-a', name: 'Alpha Condition', status: 'ACTIVE', temperatureAlertEnabled: true, temperatureMaxC: '8.00', temperatureMinC: '2.00' },
            { code: 'B', description: 'Beta description', id: 'condition-b', name: 'Beta Condition', status: 'ACTIVE', temperatureAlertEnabled: false, temperatureMaxC: null, temperatureMinC: null },
          ])) },
        }),
        sort: 'name:asc,id:asc',
      },
    ] as const;

    for (const entry of cases) {
      const service = new PrismaDsvV1ReadQueryService(entry.prisma as never);
      const result = await entry.call(service);
      const cursor = result.page.nextCursor;

      expect(cursor).toEqual(expect.any(String));
      const decoded = decodeCursor(cursor ?? '');
      expect(decoded.endpoint).toBe(entry.endpoint);
      expect(decoded.limit).toBe(1);
      expect(decoded.shopId).toBe('shop-a');
      expect(decoded.sort).toBe(entry.sort);
      expect(decoded.v).toBe(1);
      expect(decoded.last).not.toBeNull();
      expect(typeof decoded.last).toBe('object');
      await expect(entry.call(service, replaceCursorSort(cursor ?? '', 'label:asc,id:asc')))
        .rejects.toMatchObject({ code: 'BAD_REQUEST', httpStatus: 400 });
    }
  });

  test('driver list includes the editable DSV profile without replacing it with canonical ACTIVE status', async () => {
    const prisma = prismaMock({
      driver: { findMany: vi.fn(() => Promise.resolve([
        {
          displayName: 'Alpha Driver',
          dsvProfile: {
            age: 42,
            career: '6 years',
            gender: 'male',
            score: 'A',
            traits: ['cold-chain'],
            zone: 'Seoul',
          },
          id: 'driver-a',
          phone: '010-0000-0000',
          status: 'ACTIVE',
        },
      ])) },
    });
    const service = new PrismaDsvV1ReadQueryService(prisma as never);

    const result = await service.listDrivers(adminPrincipal(), { limit: 2 });

    expect(result.items).toEqual([{
      age: 42,
      career: '6 years',
      displayName: 'Alpha Driver',
      driverId: 'driver-a',
      gender: 'male',
      phone: '010-0000-0000',
      score: 'A',
      status: 'ACTIVE',
      traits: ['cold-chain'],
      zone: 'Seoul',
    }]);
  });

  test('vehicle list reads canonical driver assignments scoped to the shop and listed vehicles', async () => {
    const prisma = prismaMock({
      dsvVehicleDriverAssignment: { findMany: vi.fn(() => Promise.resolve([
        { driverId: 'driver-a', id: 'assignment-a', vehicleId: 'vehicle-a' },
        { driverId: 'driver-c', id: 'assignment-c', vehicleId: 'vehicle-b' },
      ])) },
      uvisTelemetryPollState: { findUnique: vi.fn(() => Promise.resolve({ activity: 'DORMANT' })) },
      uvisVehicleTelemetryCurrent: { findMany: vi.fn(() => Promise.resolve([
        {
          distanceTodayKm: '83.40',
          id: 'gps-new',
          ignitionOn: true,
          latitude: '37.5500000',
          longitude: '127.0100000',
          observedAt: new Date('2026-08-04T01:15:00.000Z'),
          sourceKind: 'VEHICLE_GPS',
          speedKph: '42.10',
          staleAfter: new Date('2026-08-04T01:20:00.000Z'),
          temperatureA: null,
          temperatureB: null,
          vehicleId: 'vehicle-a',
        },
        {
          distanceTodayKm: '12.00',
          id: 'gps-old',
          ignitionOn: false,
          latitude: '37.5000000',
          longitude: '127.0000000',
          observedAt: new Date('2026-08-04T01:10:00.000Z'),
          sourceKind: 'VEHICLE_GPS',
          speedKph: '1.00',
          staleAfter: new Date('2026-08-04T01:30:00.000Z'),
          temperatureA: null,
          temperatureB: null,
          vehicleId: 'vehicle-a',
        },
        {
          distanceTodayKm: null,
          id: 'temp-current',
          ignitionOn: null,
          latitude: null,
          longitude: null,
          observedAt: new Date('2026-08-04T01:16:00.000Z'),
          sourceKind: 'TEMPERATURE_RECORDER',
          speedKph: null,
          staleAfter: new Date('2026-08-04T01:14:00.000Z'),
          temperatureA: '-18.50',
          temperatureB: null,
          vehicleId: 'vehicle-a',
        },
      ])) },
      vehicle: { findMany: vi.fn(() => Promise.resolve([
        {
          dsvProfile: { note: 'Alpha note', typeLabel: '봉고3 1톤 EV' },
          dsvTelematicsDevice: {
            capabilities: ['LOCATION', 'TEMPERATURE', 'TACHOMETER'],
            serialNumber: '012-5273-8978',
          },
          id: 'vehicle-a',
          label: 'Alpha Vehicle',
          licensePlate: 'A',
          status: 'ACTIVE',
          vehicleType: 'VAN',
        },
        {
          dsvProfile: { note: 'Beta note', typeLabel: 'Ambient' },
          dsvTelematicsDevice: null,
          id: 'vehicle-b',
          label: 'Beta Vehicle',
          licensePlate: 'B',
          status: 'ACTIVE',
          vehicleType: 'TRUCK',
        },
      ])) },
    });
    const service = new PrismaDsvV1ReadQueryService(prisma as never, () => new Date('2026-08-04T01:15:00.000Z'));

    const result = await service.listVehicles(adminPrincipal(), { limit: 2 });

    expect(result.items).toEqual([
      {
        displayName: 'Alpha Vehicle',
        distanceTodayKm: 83.4,
        driverAssignments: [
          { assignmentId: 'assignment-a', driverId: 'driver-a' },
        ],
        ignitionOn: true,
        note: 'Alpha note',
        speedKph: 42.1,
        status: 'ACTIVE',
        telemetryActivity: 'DORMANT',
        telematicsCapabilities: ['LOCATION', 'TEMPERATURE', 'TACHOMETER'],
        telematicsSerialNumber: '012-5273-8978',
        temperatureA: -18.5,
        temperatureB: null,
        temperatureObservedAt: new Date('2026-08-04T01:16:00.000Z'),
        temperatureStale: true,
        type: '봉고3 1톤 EV',
        vehicleId: 'vehicle-a',
        vehicleLatitude: 37.55,
        vehicleLongitude: 127.01,
        vehiclePlate: 'A',
        vehiclePositionObservedAt: new Date('2026-08-04T01:15:00.000Z'),
        vehiclePositionStale: false,
        vehicleStopped: false,
        vehicleType: '봉고3 1톤 EV',
      },
      {
        displayName: 'Beta Vehicle',
        driverAssignments: [{ assignmentId: 'assignment-c', driverId: 'driver-c' }],
        note: 'Beta note',
        status: 'ACTIVE',
        type: 'Ambient',
        vehicleId: 'vehicle-b',
        vehiclePlate: 'B',
        vehicleType: 'Ambient',
      },
    ]);
    expect(prisma.dsvVehicleDriverAssignment.findMany).toHaveBeenCalledWith({
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { driverId: true, id: true, vehicleId: true },
      where: { shopId: 'shop-a', vehicleId: { in: ['vehicle-a', 'vehicle-b'] } },
    });
    expect(JSON.stringify(result.items.flatMap((item) => item.driverAssignments))).not.toMatch(
      /kind|displayName|phone|vehicleId/u
    );
    expect(JSON.stringify(result.items)).not.toMatch(/sourceDeviceIdentifier|sourceDevice|deviceId|serial-secret/u);
    expect(prisma.uvisTelemetryPollState.findUnique).toHaveBeenCalledWith({
      select: { activity: true },
      where: { shopId: 'shop-a' },
    });
  });

  test('driver and vehicle management reads are limited to DSV profiled resources', async () => {
    const driversPrisma = prismaMock({
      driver: { findMany: vi.fn(() => Promise.resolve([])) },
    });
    const vehiclesPrisma = prismaMock({
      dsvVehicleDriverAssignment: { findMany: vi.fn(() => Promise.resolve([])) },
      vehicle: { findMany: vi.fn(() => Promise.resolve([])) },
    });

    await new PrismaDsvV1ReadQueryService(driversPrisma as never).listDrivers(adminPrincipal());
    await new PrismaDsvV1ReadQueryService(vehiclesPrisma as never).listVehicles(adminPrincipal());

    expect(firstMockArg<OrderFindManyQuery>(driversPrisma.driver.findMany)?.where).toMatchObject({
      dsvProfile: { isNot: null },
      shopId: 'shop-a',
    });
    expect(firstMockArg<OrderFindManyQuery>(vehiclesPrisma.vehicle.findMany)?.where).toMatchObject({
      dsvProfile: { isNot: null },
      shopId: 'shop-a',
    });
  });

  test('reads ETA only from canonical RoutePlanStop fields and summarizes proof/event evidence', async () => {
    const row = customerDeliveryOrderRow({
      driverEvents: [
        { eventType: 'STOP_DELIVERED', id: 'event-allowed', occurredAt: new Date('2026-07-22T01:00:00.000Z') },
      ],
      driverProofMedia: [
        { deletedAt: new Date('2026-07-23T00:00:00.000Z'), id: 'proof-deleted' },
        { deletedAt: null, id: 'proof-active' },
      ],
      routePlanStops: [{
        estimatedArrivalAt: new Date('2026-07-22T02:00:00.000Z'),
        etaInputRouteVersionId: 'route-version-a',
        etaSource: 'ROUTE_CALCULATION',
        etaStatus: 'READY',
        id: 'route-stop-a',
        routePlanId: 'route-a',
        sequence: 4,
      }],
    });
    const service = new PrismaDsvV1ReadQueryService(prismaMock({
      commerceConnection: { findMany: vi.fn(() => Promise.resolve([{ timezone: 'Asia/Seoul' }])) },
      order: { findMany: vi.fn(() => Promise.resolve([row])) },
    }) as never, () => new Date('2026-07-22T12:00:00.000Z'));

    await expect(service.listCustomerDeliveries(customerPrincipal(), { serviceDate: '2026-07-22' })).resolves.toMatchObject({
      items: [{
        customerDisplayName: 'Customer A',
        destinationAddress: '1 Shared Way',
        destinationId: 'destination-x',
        estimatedArrivalAt: new Date('2026-07-22T02:00:00.000Z'),
        etaInputRouteVersionId: 'route-version-a',
        etaSource: 'ROUTE_CALCULATION',
        etaStatus: 'READY',
        eventRows: [{ eventType: 'STOP_DELIVERED', occurredAt: new Date('2026-07-22T01:00:00.000Z') }],
        proofRows: [{ deletedAt: new Date('2026-07-23T00:00:00.000Z') }, { deletedAt: null }],
        sellerOrderId: 'order-a',
        sellerOrderKey: 'SO-A',
        shippedBoxes: 6,
        vehicleDisplayName: '서울86바3800',
        vehicleId: 'vehicle-a',
        vehicleLatitude: 37.5,
        vehicleLongitude: 127,
      }],
    });
    await expect(service.listDispatches(adminPrincipal(), { serviceDate: '2026-07-22' })).resolves.toMatchObject({
      items: [{
        actualCompletedAt: new Date('2026-07-22T01:00:00.000Z'),
        conditionCode: 'COLD',
        eventRows: [{ eventType: 'STOP_DELIVERED', occurredAt: new Date('2026-07-22T01:00:00.000Z') }],
        routeStopSequence: 4,
        sellerOrderKey: 'SO-A',
        shippedBoxes: 6,
      }],
    });
  });

  test('customer delivery vehicle location prefers fresh UVIS GPS over tracking geometry', async () => {
    const row = customerDeliveryOrderRow();
    const prisma = prismaMock({
      commerceConnection: { findMany: vi.fn(() => Promise.resolve([{ timezone: 'Asia/Seoul' }])) },
      order: { findMany: vi.fn(() => Promise.resolve([row])) },
      uvisVehicleTelemetryCurrent: { findMany: vi.fn(() => Promise.resolve([
        {
          distanceTodayKm: '83.40',
          id: 'fresh-gps',
          ignitionOn: true,
          latitude: '37.6100000',
          longitude: '127.1100000',
          observedAt: new Date('2026-07-22T01:00:00.000Z'),
          sourceKind: 'VEHICLE_GPS',
          speedKph: '42.10',
          staleAfter: new Date('2026-07-22T01:10:00.000Z'),
          temperatureA: null,
          temperatureB: null,
          vehicleId: 'vehicle-a',
        },
      ])) },
    });
    const service = new PrismaDsvV1ReadQueryService(prisma as never, () => new Date('2026-07-22T01:05:00.000Z'));

    await expect(service.listCustomerDeliveries(customerPrincipal(), { serviceDate: '2026-07-22' })).resolves.toMatchObject({
      items: [{
        vehicleId: 'vehicle-a',
        vehicleLatitude: 37.61,
        vehicleLongitude: 127.11,
      }],
    });
    expect(prisma.uvisVehicleTelemetryCurrent.findMany).toHaveBeenCalledWith(expect.objectContaining({
      select: expect.not.objectContaining({
        deviceId: true,
        sourceDeviceIdentifier: true,
        temperatureA: true,
        temperatureB: true,
      }) as unknown,
      where: {
        shopId: 'shop-a',
        sourceKind: 'VEHICLE_GPS',
        staleAfter: { gt: new Date('2026-07-22T01:05:00.000Z') },
        vehicleId: { in: ['vehicle-a'] },
      },
    }));
  });

  test('keeps administrator manufacturer inquiry scoped to the selected customer and shop', async () => {
    const findMany = vi.fn(() => Promise.resolve([]));
    const service = new PrismaDsvV1ReadQueryService(prismaMock({
      commerceConnection: { findMany: vi.fn(() => Promise.resolve([{ timezone: 'Asia/Seoul' }])) },
      order: { findMany },
    }) as never, () => new Date('2026-07-22T12:00:00.000Z'));

    await service.listCustomerDeliveriesForAdmin(adminPrincipal(), 'customer-selected', {
      serviceDate: '2026-07-22',
    });

    const query = firstMockArg<OrderFindManyQuery>(findMany);
    expect(query?.where).toMatchObject({
      customerId: 'customer-selected',
      shopId: 'shop-a',
    });
  });

  test('does not serialize stale RoutePlanStop ETA when current route version has no matching ETA owner', async () => {
    const row = customerDeliveryOrderRow({
      routePlanStops: [{
        estimatedArrivalAt: new Date('2026-07-22T02:00:00.000Z'),
        etaInputRouteVersionId: 'stale-route-version',
        etaSource: 'ROUTE_CALCULATION',
        etaStatus: 'READY',
        id: 'route-stop-stale',
        routePlanId: 'route-a',
        sequence: 5,
      }],
    });
    const service = new PrismaDsvV1ReadQueryService(prismaMock({
      commerceConnection: { findMany: vi.fn(() => Promise.resolve([{ timezone: 'Asia/Seoul' }])) },
      order: { findMany: vi.fn(() => Promise.resolve([row])) },
    }) as never, () => new Date('2026-07-22T12:00:00.000Z'));

    await expect(service.listCustomerDeliveries(customerPrincipal(), { serviceDate: '2026-07-22' })).resolves.toMatchObject({
      items: [{
        etaStatus: 'PENDING',
        sellerOrderKey: 'SO-A',
      }],
    });
    const result = await service.listCustomerDeliveries(customerPrincipal(), { serviceDate: '2026-07-22' });
    expect(result.items[0]).not.toHaveProperty('estimatedArrivalAt');
    expect(result.items[0]).not.toHaveProperty('etaInputRouteVersionId');
    expect(result.items[0]).not.toHaveProperty('etaSource');
    await expect(service.listDispatches(adminPrincipal(), { serviceDate: '2026-07-22' })).resolves.toMatchObject({
      items: [{ etaStatus: 'PENDING', routeStopSequence: 5 }],
    });
  });

  test('dispatch summaries derive ownership from current child driver and keep route plan while ETA is pending', async () => {
    const row = customerDeliveryOrderRow({
      currentRouteVersion: {
        driverId: null,
        routePlan: {
          trackingGeometry: null,
          vehicle: { id: 'vehicle-a', label: '차량 A', licensePlate: null },
          vehicleId: 'vehicle-a',
        },
        routePlanId: 'route-a',
      },
      latitude: '37.1234567',
      longitude: '127.1234567',
      routePlanStops: [],
    });
    const prisma = prismaMock({
      commerceConnection: { findMany: vi.fn(() => Promise.resolve([{ timezone: 'Asia/Seoul' }])) },
      order: { findMany: vi.fn(() => Promise.resolve([row])) },
    });
    const service = new PrismaDsvV1ReadQueryService(prisma as never, () => new Date('2026-07-22T12:00:00.000Z'));

    await expect(service.listDispatches(adminPrincipal(), { serviceDate: '2026-07-22' })).resolves.toMatchObject({
      items: [{
        assignmentStatus: 'UNASSIGNED',
        destinationAddress: '1 Shared Way',
        destinationDisplayName: 'Destination X',
        driverId: null,
        etaStatus: 'NOT_REQUIRED',
        latitude: 37.1234567,
        longitude: 127.1234567,
        routePlanId: 'route-a',
        routeVersionId: 'route-version-a',
        vehicleId: 'vehicle-a',
      }],
    });

    const query = firstMockArg<OrderFindManyQuery>(prisma.order.findMany);
    expect(query?.select?.currentRouteVersion).toMatchObject({
      select: {
        driverId: true,
        routePlan: { select: { vehicleId: true } },
        routePlanId: true,
      },
    });
  });

  test.each([
    ['CANCELLED', 'CANCELLED'],
    ['DELIVERED', 'COMPLETED'],
  ] as const)('dispatch summaries derive %s as authoritative %s operation status', async (deliveryStatus, operationStatus) => {
    const row = customerDeliveryOrderRow({ deliveryStatus });
    const service = new PrismaDsvV1ReadQueryService(prismaMock({
      commerceConnection: { findMany: vi.fn(() => Promise.resolve([{ timezone: 'Asia/Seoul' }])) },
      order: { findMany: vi.fn(() => Promise.resolve([row])) },
    }) as never, () => new Date('2026-07-22T12:00:00.000Z'));

    await expect(service.listDispatches(adminPrincipal(), { serviceDate: '2026-07-22' })).resolves.toMatchObject({
      items: [{ operationStatus }],
    });
  });

  test('dispatch search applies partial order number and destination name to the same service date query', async () => {
    const prisma = prismaMock({
      commerceConnection: { findMany: vi.fn(() => Promise.resolve([{ timezone: 'Asia/Seoul' }])) },
      order: { findMany: vi.fn(() => Promise.resolve([])) },
    });
    const service = new PrismaDsvV1ReadQueryService(prisma as never, () => new Date('2026-07-22T12:00:00.000Z'));

    await service.listDispatches(adminPrincipal(), {
      destinationName: '  명동  의원 ',
      orderNumber: ' 123 ',
      serviceDate: '2026-07-22',
    });

    expect(firstMockArg<OrderFindManyQuery>(prisma.order.findMany)?.where).toMatchObject({
      OR: [
        { destination: { canonicalName: { contains: '명동 의원', mode: 'insensitive' } } },
        { deliveryStops: { some: { recipientName: { contains: '명동 의원', mode: 'insensitive' } } } },
      ],
      sellerOrderKey: { contains: '123', mode: 'insensitive' },
    });
  });

  test('control reads are unpaginated', async () => {
    const prisma = prismaMock({
      commerceConnection: { findMany: vi.fn(() => Promise.resolve([{ timezone: 'Asia/Seoul' }])) },
      order: { findMany: vi.fn(() => Promise.resolve([])) },
      routePlan: { findMany: vi.fn(() => Promise.resolve([])) },
    });
    const service = new PrismaDsvV1ReadQueryService(prisma as never, () => new Date('2026-07-22T12:00:00.000Z'));

    await service.listControl(adminPrincipal(), { serviceDate: '2026-07-22' });

    expect(firstMockArg<OrderFindManyQuery>(prisma.order.findMany)).not.toHaveProperty('take');
  });

  test('vehicle temperature history verifies tenant vehicle ownership and returns recorder samples oldest first', async () => {
    const prisma = prismaMock({
      uvisVehicleTelemetrySample: { findMany: vi.fn(() => Promise.resolve([
        {
          observedAt: new Date('2026-08-04T01:16:00.000Z'),
          temperatureA: '-18.50',
          temperatureB: null,
        },
      ])) },
      vehicle: { findFirst: vi.fn(() => Promise.resolve({ id: 'vehicle-a' })) },
    });
    const service = new PrismaDsvV1ReadQueryService(prisma as never, () => new Date('2026-08-04T02:00:00.000Z'));

    const result = await service.listVehicleTemperatureHistory(adminPrincipal(), { vehicleId: 'vehicle-a' });

    expect(prisma.vehicle.findFirst).toHaveBeenCalledWith({
      select: { id: true },
      where: { id: 'vehicle-a', shopId: 'shop-a' },
    });
    expect(prisma.uvisVehicleTelemetrySample.findMany).toHaveBeenCalledWith({
      orderBy: [{ observedAt: 'desc' }],
      select: { observedAt: true, temperatureA: true, temperatureB: true },
      take: 288,
      where: {
        observedAt: {
          gte: new Date('2026-08-03T02:00:00.000Z'),
          lte: new Date('2026-08-04T02:00:00.000Z'),
        },
        shopId: 'shop-a',
        sourceKind: 'TEMPERATURE_RECORDER',
        vehicleId: 'vehicle-a',
      },
    });
    expect(result).toEqual({
      samples: [{
        observedAt: '2026-08-04T01:16:00.000Z',
        temperatureA: -18.5,
        temperatureB: null,
      }],
      vehicleId: 'vehicle-a',
    });
  });

  test('vehicle GPS trail history builds restart sessions from UVIS GPS samples and stale gaps only', async () => {
    const prisma = prismaMock({
      commerceConnection: { findMany: vi.fn(() => Promise.resolve([{ timezone: 'Asia/Seoul' }])) },
      routePlan: { findMany: vi.fn(() => Promise.resolve([{
        constraints: { scheduledStartAt: '2026-08-04T00:00:00.000Z' },
        depotLatitude: '37.5000000',
        depotLongitude: '127.0000000',
        driverEvents: [
          { eventType: 'ROUTE_STARTED', id: 'start-1', occurredAt: new Date('2026-08-04T00:00:00.000Z') },
          { eventType: 'ROUTE_COMPLETED', id: 'complete-1', occurredAt: new Date('2026-08-04T00:08:00.000Z') },
          { eventType: 'ROUTE_STARTED', id: 'start-2', occurredAt: new Date('2026-08-04T00:30:00.000Z') },
        ],
        id: 'route-a',
        planDate: new Date('2026-08-04T00:00:00.000Z'),
      }])) },
      shop: { findUnique: vi.fn(() => Promise.resolve({ routeOpsUiSettings: { version: 1, plannedDepartureTime: '08:30' } })) },
      uvisVehicleTelemetrySample: { findMany: vi.fn(() => Promise.resolve([
        gpsSample({ observedAt: '2026-08-04T00:01:00.000Z', staleAfter: '2026-08-04T00:03:00.000Z' }),
        gpsSample({ observedAt: '2026-08-04T00:04:00.000Z', staleAfter: '2026-08-04T00:06:00.000Z' }),
        gpsSample({ observedAt: '2026-08-04T00:10:00.000Z', staleAfter: '2026-08-04T00:12:00.000Z', latitude: '37.5000000', longitude: '127.0000000' }),
        gpsSample({ observedAt: '2026-08-04T00:31:00.000Z', staleAfter: '2026-08-04T00:33:00.000Z', latitude: '37.7000000' }),
      ])) },
      vehicle: { findFirst: vi.fn(() => Promise.resolve({ id: 'vehicle-a' })) },
    });
    const service = new PrismaDsvV1ReadQueryService(prisma as never, () => new Date('2026-08-04T12:00:00.000Z'));

    const result = await service.listVehicleGpsTrailHistory(adminPrincipal(), {
      serviceDate: '2026-08-04',
      vehicleId: 'vehicle-a',
    });

    expect(prisma.vehicle.findFirst).toHaveBeenCalledWith({
      select: { id: true },
      where: { id: 'vehicle-a', shopId: 'shop-a' },
    });
    const routePlanQuery = firstMockArg<{
      select?: { driverEvents?: { where?: unknown } };
      where?: unknown;
    }>(prisma.routePlan.findMany);
    expect(routePlanQuery?.select?.driverEvents?.where).toEqual({
      eventType: { in: ['ROUTE_COMPLETED', 'ROUTE_PAUSED', 'ROUTE_STARTED'] },
      shopId: 'shop-a',
    });
    expect(routePlanQuery?.where).toEqual({
        planDate: new Date('2026-08-04T00:00:00.000Z'),
        shopId: 'shop-a',
        status: { not: 'CANCELLED' },
        vehicleId: 'vehicle-a',
    });
    expect(prisma.uvisVehicleTelemetrySample.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        latitude: { not: null },
        longitude: { not: null },
        sourceKind: 'VEHICLE_GPS',
        vehicleId: 'vehicle-a',
      }) as unknown,
    }));
    expect(JSON.stringify(prisma.uvisVehicleTelemetrySample.findMany.mock.calls)).not.toMatch(/LOCATION_UPDATED|driverEvent/u);
    expect(result).toMatchObject({
      serviceDate: '2026-08-04',
      sessions: [
        {
          completedAt: '2026-08-04T00:08:00.000Z',
          completionEventId: 'complete-1',
          endpoint: { endedAt: '2026-08-04T00:10:00.000Z', reason: 'DEPOT_RETURNED' },
          restart: { restartedAt: '2026-08-04T00:30:00.000Z', restartEventId: 'start-2' },
          routePlanId: 'route-a',
          segments: [
            { samples: [{ observedAt: '2026-08-04T00:01:00.000Z' }] },
            { samples: [{ observedAt: '2026-08-04T00:04:00.000Z' }] },
            { samples: [{ observedAt: '2026-08-04T00:10:00.000Z' }] },
          ],
          sessionIndex: 0,
          startedAt: '2026-08-04T00:00:00.000Z',
          startEventId: 'start-1',
          startSource: 'ROUTE_STARTED',
        },
        {
          completedAt: null,
          completionEventId: null,
          endpoint: { endedAt: '2026-08-04T00:31:00.000Z', reason: 'LAST_VALID_SAMPLE' },
          restart: null,
          routePlanId: 'route-a',
          segments: [{ samples: [{ observedAt: '2026-08-04T00:31:00.000Z' }] }],
          sessionIndex: 1,
          startedAt: '2026-08-04T00:30:00.000Z',
          startEventId: 'start-2',
          startSource: 'ROUTE_STARTED',
        },
      ],
      timezone: 'Asia/Seoul',
      vehicleId: 'vehicle-a',
    });
  });

  test('vehicle GPS trail history falls back to planned departure when no route start exists', async () => {
    const prisma = prismaMock({
      commerceConnection: { findMany: vi.fn(() => Promise.resolve([{ timezone: 'Asia/Seoul' }])) },
      routePlan: { findMany: vi.fn(() => Promise.resolve([{
        constraints: {},
        depotLatitude: null,
        depotLongitude: null,
        driverEvents: [],
        id: 'route-a',
        planDate: new Date('2026-08-04T00:00:00.000Z'),
      }])) },
      shop: { findUnique: vi.fn(() => Promise.resolve({ routeOpsUiSettings: { version: 1, plannedDepartureTime: '08:45' } })) },
      uvisVehicleTelemetrySample: { findMany: vi.fn(() => Promise.resolve([
        gpsSample({ observedAt: '2026-08-03T23:46:00.000Z', staleAfter: '2026-08-03T23:48:00.000Z' }),
      ])) },
      vehicle: { findFirst: vi.fn(() => Promise.resolve({ id: 'vehicle-a' })) },
    });
    const service = new PrismaDsvV1ReadQueryService(prisma as never, () => new Date('2026-08-04T12:00:00.000Z'));

    await expect(service.listVehicleGpsTrailHistory(adminPrincipal(), {
      serviceDate: '2026-08-04',
      vehicleId: 'vehicle-a',
    })).resolves.toMatchObject({
      sessions: [{
        endpoint: { endedAt: '2026-08-03T23:46:00.000Z', reason: 'LAST_VALID_SAMPLE' },
        segments: [{ samples: [{ observedAt: '2026-08-03T23:46:00.000Z' }] }],
        startedAt: '2026-08-03T23:45:00.000Z',
        startEventId: null,
        startSource: 'PLANNED_DEPARTURE',
      }],
    });
  });

  test('vehicle GPS trail history keeps UVIS movement visible when the vehicle has no route plan', async () => {
    const prisma = prismaMock({
      commerceConnection: { findMany: vi.fn(() => Promise.resolve([{ timezone: 'Asia/Seoul' }])) },
      routePlan: { findMany: vi.fn(() => Promise.resolve([])) },
      shop: { findUnique: vi.fn(() => Promise.resolve({ routeOpsUiSettings: { version: 1, plannedDepartureTime: '08:30' } })) },
      uvisVehicleTelemetrySample: { findMany: vi.fn(() => Promise.resolve([
        gpsSample({ observedAt: '2026-08-03T23:29:00.000Z', staleAfter: '2026-08-03T23:31:00.000Z' }),
        gpsSample({ observedAt: '2026-08-03T23:31:00.000Z', staleAfter: '2026-08-03T23:33:00.000Z' }),
        gpsSample({ observedAt: '2026-08-03T23:32:00.000Z', staleAfter: '2026-08-03T23:34:00.000Z' }),
        gpsSample({ observedAt: '2026-08-03T23:35:00.000Z', staleAfter: '2026-08-03T23:37:00.000Z' }),
      ])) },
      vehicle: { findFirst: vi.fn(() => Promise.resolve({ id: 'vehicle-unassigned' })) },
    });
    const service = new PrismaDsvV1ReadQueryService(prisma as never, () => new Date('2026-08-04T12:00:00.000Z'));

    const result = await service.listVehicleGpsTrailHistory(adminPrincipal(), {
      serviceDate: '2026-08-04',
      vehicleId: 'vehicle-unassigned',
    });
    expect(result.vehicleId).toBe('vehicle-unassigned');
    expect(result.sessions.flatMap((session) => session.segments.flatMap((segment) =>
      segment.samples.map((sample) => sample.observedAt)
    ))).toEqual([
      '2026-08-03T23:29:00.000Z',
      '2026-08-03T23:31:00.000Z',
      '2026-08-03T23:32:00.000Z',
      '2026-08-03T23:35:00.000Z',
    ]);
  });

  test('vehicle GPS trail history enriches segments with confident materialized lines and markers without changing samples', async () => {
    const materializedDocument = {
      generatedAt: '2026-08-04T01:00:00.000Z',
      retryable: false,
      schemaVersion: 'uvis_vehicle_trail.v1',
      segments: [{
        endedAt: '2026-08-03T23:31:30.000Z',
        roadMatchedGeometry: { type: 'MultiLineString', coordinates: [[[126.9, 37.4], [126.95, 37.45]]] },
        samples: [],
        startedAt: '2026-08-03T23:30:00.000Z',
        trailMarker: { kind: 'START', latitude: 37.4, longitude: 126.9, observedAt: '2026-08-03T23:30:00.000Z' },
      }, {
        endedAt: '2026-08-03T23:32:00.000Z',
        roadMatchedGeometry: {
          anchors: [
            { coordinateIndex: 0, lineIndex: 0, observedAt: '2026-08-03T23:31:00.000Z' },
            { coordinateIndex: 1, lineIndex: 0, observedAt: '2026-08-03T23:32:00.000Z' },
          ],
          type: 'MultiLineString',
          coordinates: [[[127.0, 37.5], [127.1, 37.6]]],
        },
        samples: [],
        startedAt: '2026-08-03T23:31:00.000Z',
        trailMarker: { kind: 'START', latitude: 37.5, longitude: 127.0, observedAt: '2026-08-03T23:31:00.000Z' },
      }, {
        endedAt: '2026-08-03T23:33:00.000Z',
        roadMatchedGeometry: {
          anchors: [
            { coordinateIndex: 0, lineIndex: 0, observedAt: '2026-08-03T23:33:00.000Z' },
          ],
          type: 'MultiLineString',
          coordinates: [[[127.2, 37.7], [127.3, 37.8]]],
        },
        samples: [],
        startedAt: '2026-08-03T23:32:30.000Z',
        trailMarker: { kind: 'RESTART', latitude: 37.7, longitude: 127.2, observedAt: '2026-08-03T23:32:30.000Z' },
      }],
      serviceDate: '2026-08-04',
      sourceSampleCount: 3,
      sourceWatermark: 'sha256:trail',
      timezone: 'Asia/Seoul',
      vehicleId: 'vehicle-unassigned',
    };
    const prisma = prismaMock({
      commerceConnection: { findMany: vi.fn(() => Promise.resolve([{ timezone: 'Asia/Seoul' }])) },
      routePlan: { findMany: vi.fn(() => Promise.resolve([])) },
      shop: { findUnique: vi.fn(() => Promise.resolve({ routeOpsUiSettings: { version: 1, plannedDepartureTime: '08:30' } })) },
      uvisVehicleTelemetrySample: { findMany: vi.fn(() => Promise.resolve([
        gpsSample({ observedAt: '2026-08-03T23:31:00.000Z', staleAfter: '2026-08-03T23:35:00.000Z' }),
        gpsSample({ observedAt: '2026-08-03T23:32:00.000Z', staleAfter: '2026-08-03T23:35:00.000Z' }),
        gpsSample({ observedAt: '2026-08-03T23:33:00.000Z', staleAfter: '2026-08-03T23:35:00.000Z' }),
      ])) },
      uvisVehicleTrailMaterialization: { findUnique: vi.fn(() => Promise.resolve({ document: materializedDocument })) },
      vehicle: { findFirst: vi.fn(() => Promise.resolve({ id: 'vehicle-unassigned' })) },
    });
    const service = new PrismaDsvV1ReadQueryService(prisma as never, () => new Date('2026-08-04T12:00:00.000Z'));

    const result = await service.listVehicleGpsTrailHistory(adminPrincipal(), {
      serviceDate: '2026-08-04',
      vehicleId: 'vehicle-unassigned',
    });

    expect(result.sessions[0]?.segments).toEqual([{
      roadMatchedGeometry: {
        anchors: [
          { coordinateIndex: 0, lineIndex: 0, observedAt: '2026-08-03T23:31:00.000Z' },
          { coordinateIndex: 1, lineIndex: 0, observedAt: '2026-08-03T23:32:00.000Z' },
          { coordinateIndex: 0, lineIndex: 1, observedAt: '2026-08-03T23:33:00.000Z' },
        ],
        coordinates: [
          [[127.0, 37.5], [127.1, 37.6]],
          [[127.2, 37.7], [127.3, 37.8]],
        ],
        type: 'MultiLineString',
      },
      samples: [
        expect.objectContaining({ observedAt: '2026-08-03T23:31:00.000Z' }),
        expect.objectContaining({ observedAt: '2026-08-03T23:32:00.000Z' }),
        expect.objectContaining({ observedAt: '2026-08-03T23:33:00.000Z' }),
      ],
      trailMarker: { kind: 'START', latitude: 37.5, longitude: 127.0, observedAt: '2026-08-03T23:31:00.000Z' },
    }]);
  });

  test('vehicle GPS trail history keeps paused stationary samples while preserving route sessions', async () => {
    const prisma = prismaMock({
      commerceConnection: { findMany: vi.fn(() => Promise.resolve([{ timezone: 'Asia/Seoul' }])) },
      routePlan: { findMany: vi.fn(() => Promise.resolve([{
        constraints: { departureTime: '08:30' },
        depotLatitude: null,
        depotLongitude: null,
        driverEvents: [
          { eventType: 'ROUTE_STARTED', id: 'start-1', occurredAt: new Date('2026-08-03T23:40:00.000Z') },
          { eventType: 'ROUTE_PAUSED', id: 'pause-1', occurredAt: new Date('2026-08-03T23:50:00.000Z') },
          { eventType: 'ROUTE_STARTED', id: 'start-2', occurredAt: new Date('2026-08-04T00:10:00.000Z') },
        ],
        id: 'route-a',
        planDate: new Date('2026-08-04T00:00:00.000Z'),
      }])) },
      shop: { findUnique: vi.fn(() => Promise.resolve({ routeOpsUiSettings: { version: 1, plannedDepartureTime: '08:45' } })) },
      uvisVehicleTelemetrySample: { findMany: vi.fn(() => Promise.resolve([
        gpsSample({ observedAt: '2026-08-03T23:31:00.000Z', staleAfter: '2026-08-03T23:33:00.000Z' }),
        gpsSample({ observedAt: '2026-08-03T23:49:00.000Z', staleAfter: '2026-08-03T23:51:00.000Z' }),
        gpsSample({ observedAt: '2026-08-03T23:55:00.000Z', staleAfter: '2026-08-03T23:57:00.000Z', ignitionOn: false, speedKph: '0' }),
        gpsSample({ observedAt: '2026-08-04T00:11:00.000Z', staleAfter: '2026-08-04T00:13:00.000Z' }),
      ])) },
      vehicle: { findFirst: vi.fn(() => Promise.resolve({ id: 'vehicle-a' })) },
    });
    const service = new PrismaDsvV1ReadQueryService(prisma as never, () => new Date('2026-08-04T12:00:00.000Z'));

    const result = await service.listVehicleGpsTrailHistory(adminPrincipal(), {
      serviceDate: '2026-08-04',
      vehicleId: 'vehicle-a',
    });

    expect(result.sessions).toMatchObject([
      {
        endpoint: { endedAt: '2026-08-03T23:49:00.000Z', reason: 'ROUTE_PAUSED' },
        restart: { restartedAt: '2026-08-04T00:10:00.000Z', restartEventId: 'start-2' },
        segments: [
          { samples: [{ observedAt: '2026-08-03T23:31:00.000Z' }] },
          { samples: [{ observedAt: '2026-08-03T23:49:00.000Z' }] },
        ],
        startedAt: '2026-08-03T23:30:00.000Z',
        startEventId: null,
        startSource: 'PLANNED_DEPARTURE',
      },
      {
        endpoint: { endedAt: '2026-08-03T23:55:00.000Z', reason: 'LAST_VALID_SAMPLE' },
        routePlanId: 'collected:vehicle-a:2026-08-04:0',
        restart: null,
        segments: [{ samples: [{ ignitionOn: false, observedAt: '2026-08-03T23:55:00.000Z', speedKph: 0 }] }],
        startedAt: '2026-08-03T23:55:00.000Z',
      },
      {
        segments: [{ samples: [{ observedAt: '2026-08-04T00:11:00.000Z' }] }],
        startedAt: '2026-08-04T00:10:00.000Z',
        startEventId: 'start-2',
        startSource: 'ROUTE_STARTED',
      },
    ]);
  });

  test('vehicle GPS trail history assigns planned start once and prevents samples overlapping route plans', async () => {
    const prisma = prismaMock({
      commerceConnection: { findMany: vi.fn(() => Promise.resolve([{ timezone: 'Asia/Seoul' }])) },
      routePlan: { findMany: vi.fn(() => Promise.resolve([{
        constraints: {},
        depotLatitude: null,
        depotLongitude: null,
        driverEvents: [
          { eventType: 'ROUTE_STARTED', id: 'start-a', occurredAt: new Date('2026-08-04T00:00:00.000Z') },
        ],
        id: 'route-a',
        planDate: new Date('2026-08-04T00:00:00.000Z'),
      }, {
        constraints: {},
        depotLatitude: null,
        depotLongitude: null,
        driverEvents: [
          { eventType: 'ROUTE_STARTED', id: 'start-b', occurredAt: new Date('2026-08-04T00:30:00.000Z') },
        ],
        id: 'route-b',
        planDate: new Date('2026-08-04T00:00:00.000Z'),
      }])) },
      shop: { findUnique: vi.fn(() => Promise.resolve({ routeOpsUiSettings: { version: 1, plannedDepartureTime: '08:30' } })) },
      uvisVehicleTelemetrySample: { findMany: vi.fn(() => Promise.resolve([
        gpsSample({ observedAt: '2026-08-03T23:40:00.000Z', staleAfter: '2026-08-03T23:42:00.000Z' }),
        gpsSample({ observedAt: '2026-08-04T00:10:00.000Z', staleAfter: '2026-08-04T00:12:00.000Z' }),
        gpsSample({ observedAt: '2026-08-04T00:31:00.000Z', staleAfter: '2026-08-04T00:33:00.000Z' }),
      ])) },
      vehicle: { findFirst: vi.fn(() => Promise.resolve({ id: 'vehicle-a' })) },
    });
    const service = new PrismaDsvV1ReadQueryService(prisma as never, () => new Date('2026-08-04T12:00:00.000Z'));

    const result = await service.listVehicleGpsTrailHistory(adminPrincipal(), {
      serviceDate: '2026-08-04',
      vehicleId: 'vehicle-a',
    });

    expect(result.sessions).toMatchObject([
      {
        endpoint: { endedAt: '2026-08-04T00:10:00.000Z', reason: 'RESTARTED' },
        restart: { restartedAt: '2026-08-04T00:30:00.000Z', restartEventId: 'start-b' },
        routePlanId: 'route-a',
        startedAt: '2026-08-03T23:30:00.000Z',
        startEventId: null,
        startSource: 'PLANNED_DEPARTURE',
      },
      {
        routePlanId: 'route-b',
        startedAt: '2026-08-04T00:30:00.000Z',
        startEventId: 'start-b',
        startSource: 'ROUTE_STARTED',
      },
    ]);
    expect(result.sessions.flatMap((session) => session.segments.flatMap((segment) =>
      segment.samples.map((sample) => sample.observedAt)
    ))).toEqual([
      '2026-08-03T23:40:00.000Z',
      '2026-08-04T00:10:00.000Z',
      '2026-08-04T00:31:00.000Z',
    ]);
  });

  test('vehicle GPS trail history clips partial materialized geometry by anchors and omits unanchored partial lines', async () => {
    const materializedDocument = {
      generatedAt: '2026-08-04T01:00:00.000Z',
      retryable: false,
      schemaVersion: 'uvis_vehicle_trail.v1',
      segments: [{
        endedAt: '2026-08-03T23:33:30.000Z',
        roadMatchedGeometry: {
          anchors: [
            { coordinateIndex: 0, lineIndex: 0, observedAt: '2026-08-03T23:31:00.000Z' },
            { coordinateIndex: 1, lineIndex: 0, observedAt: '2026-08-03T23:32:00.000Z' },
            { coordinateIndex: 2, lineIndex: 0, observedAt: '2026-08-03T23:33:00.000Z' },
            { coordinateIndex: 3, lineIndex: 0, observedAt: '2026-08-03T23:33:30.000Z' },
          ],
          type: 'MultiLineString',
          coordinates: [[[126.9, 37.4], [127.0, 37.5], [127.1, 37.6], [127.2, 37.7]]],
        },
        samples: [],
        startedAt: '2026-08-03T23:31:00.000Z',
        trailMarker: { kind: 'START', latitude: 37.4, longitude: 126.9, observedAt: '2026-08-03T23:31:00.000Z' },
      }, {
        endedAt: '2026-08-03T23:33:30.000Z',
        roadMatchedGeometry: { type: 'MultiLineString', coordinates: [[[128.0, 38.0], [128.1, 38.1]]] },
        samples: [],
        startedAt: '2026-08-03T23:32:30.000Z',
        trailMarker: { kind: 'RESTART', latitude: 38.0, longitude: 128.0, observedAt: '2026-08-03T23:32:30.000Z' },
      }],
      serviceDate: '2026-08-04',
      sourceSampleCount: 2,
      sourceWatermark: 'sha256:partial-trail',
      timezone: 'Asia/Seoul',
      vehicleId: 'vehicle-unassigned',
    };
    const prisma = prismaMock({
      commerceConnection: { findMany: vi.fn(() => Promise.resolve([{ timezone: 'Asia/Seoul' }])) },
      routePlan: { findMany: vi.fn(() => Promise.resolve([])) },
      shop: { findUnique: vi.fn(() => Promise.resolve({ routeOpsUiSettings: { version: 1, plannedDepartureTime: '08:30' } })) },
      uvisVehicleTelemetrySample: { findMany: vi.fn(() => Promise.resolve([
        gpsSample({ observedAt: '2026-08-03T23:32:00.000Z', staleAfter: '2026-08-03T23:35:00.000Z' }),
        gpsSample({ observedAt: '2026-08-03T23:33:00.000Z', staleAfter: '2026-08-03T23:35:00.000Z' }),
      ])) },
      uvisVehicleTrailMaterialization: { findUnique: vi.fn(() => Promise.resolve({ document: materializedDocument })) },
      vehicle: { findFirst: vi.fn(() => Promise.resolve({ id: 'vehicle-unassigned' })) },
    });
    const service = new PrismaDsvV1ReadQueryService(prisma as never, () => new Date('2026-08-04T12:00:00.000Z'));

    const result = await service.listVehicleGpsTrailHistory(adminPrincipal(), {
      serviceDate: '2026-08-04',
      vehicleId: 'vehicle-unassigned',
    });

    expect(result.sessions[0]?.segments).toEqual([{
      roadMatchedGeometry: {
        anchors: [
          { coordinateIndex: 0, lineIndex: 0, observedAt: '2026-08-03T23:32:00.000Z' },
          { coordinateIndex: 1, lineIndex: 0, observedAt: '2026-08-03T23:33:00.000Z' },
        ],
        coordinates: [[[127.0, 37.5], [127.1, 37.6]]],
        type: 'MultiLineString',
      },
      samples: [
        expect.objectContaining({ observedAt: '2026-08-03T23:32:00.000Z' }),
        expect.objectContaining({ observedAt: '2026-08-03T23:33:00.000Z' }),
      ],
      trailMarker: { kind: 'RESTART', latitude: 38.0, longitude: 128.0, observedAt: '2026-08-03T23:32:30.000Z' },
    }]);
  });
});

function adminPrincipal(): DsvAdminPrincipal {
  return {
    principalType: 'DSV_ADMIN',
    scopes: ['dsv:dispatches:read'],
    shopId: 'shop-a',
  };
}

function customerPrincipal(): DsvCustomerUserPrincipal {
  return {
    customerId: 'customer-a',
    principalType: 'CUSTOMER_USER',
    scopes: ['dsv:customer-deliveries:read'],
    shopId: 'shop-a',
  };
}

function gpsSample(overrides: Partial<{
  distanceTodayKm: string | null;
  ignitionOn: boolean | null;
  latitude: string | null;
  longitude: string | null;
  observedAt: string;
  speedKph: string | null;
  staleAfter: string;
}> = {}) {
  return {
    distanceTodayKm: overrides.distanceTodayKm ?? '10.00',
    ignitionOn: overrides.ignitionOn ?? true,
    latitude: overrides.latitude ?? '37.6000000',
    longitude: overrides.longitude ?? '127.1000000',
    observedAt: new Date(overrides.observedAt ?? '2026-08-04T00:00:00.000Z'),
    speedKph: overrides.speedKph ?? '30.00',
    staleAfter: new Date(overrides.staleAfter ?? '2026-08-04T00:02:00.000Z'),
  };
}

function prismaMock<T extends Record<string, unknown>>(overrides: T): T & { $transaction?: unknown } {
  return overrides;
}

type OrderFindManyQuery = {
  orderBy?: unknown;
  select?: Record<string, unknown>;
  take?: number;
  where?: Record<string, unknown>;
};

type DeliveryStopFindManyQuery = {
  where?: {
    order?: { shopId: string };
    shopId?: string;
  };
};

type NestedDeliveryStopsSelect = {
  select: {
    dsvDispatchImportRows: {
      select: { shippedBoxes: true };
      where: { shopId: string; status: string };
    };
    driverEvents: { where: { eventType: { in: string[] }; shopId: string } };
    driverProofMedia: { where: { shopId: string } };
    routePlanStops: { where: { shopId: string } };
  };
  where: { deliveryDate: Date; shopId: string };
};

function firstMockArg<T>(mock: { mock: { calls: unknown[][] } }): T | undefined {
  return mock.mock.calls[0]?.[0] as T | undefined;
}

function sqlText(query: unknown): string {
  const sql = query as { sql?: string; strings?: string[] };
  return sql.sql ?? sql.strings?.join('') ?? String(query);
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

function customerDeliveryOrderRow(input: {
  currentRouteVersion?: {
    driverId: string | null;
    routePlan: {
      trackingGeometry: { lastLatitude: unknown; lastLongitude: unknown } | null;
      vehicle: { id: string; label: string; licensePlate: string | null } | null;
      vehicleId: string | null;
    } | null;
    routePlanId: string | null;
  } | null;
  driverEvents?: Array<{ eventType: string; id: string; occurredAt: Date }>;
  driverProofMedia?: Array<{ deletedAt: Date | null; id: string }>;
  deliveryStatus?: string;
  id?: string;
  latitude?: unknown;
  longitude?: unknown;
  routePlanStops?: Array<{
    estimatedArrivalAt: Date | null;
    etaInputRouteVersionId: string | null;
    etaSource: string | null;
    etaStatus: string;
    id: string;
    routePlanId: string;
    sequence?: number;
  }>;
  sellerOrderKey?: string | null;
} = {}) {
  return {
    currentRouteVersionId: 'route-version-a',
    currentRouteVersion: input.currentRouteVersion === undefined
      ? {
          driverId: 'driver-a',
          routePlan: {
            trackingGeometry: { lastLatitude: '37.5000000', lastLongitude: '127.0000000' },
            vehicle: { id: 'vehicle-a', label: '1톤 냉장탑차', licensePlate: '서울86바3800' },
            vehicleId: 'vehicle-a',
          },
          routePlanId: 'route-a',
        }
      : input.currentRouteVersion,
    customer: { displayName: 'Customer A', id: 'customer-a' },
    deliveryStatus: input.deliveryStatus ?? 'ASSIGNED',
    deliveryStops: [{
      dsvDispatchImportRows: [{ conditionCode: 'COLD', shippedBoxes: 6 }],
      driverEvents: input.driverEvents ?? [],
      driverProofMedia: input.driverProofMedia ?? [],
      id: `stop-${input.id ?? 'a'}`,
      address1: '1 Shared Way',
      address2: null,
      city: null,
      countryCode: null,
      latitude: input.latitude ?? null,
      longitude: input.longitude ?? null,
      postalCode: null,
      province: null,
      recipientName: 'Recipient A',
      routePlanStops: input.routePlanStops ?? [],
      status: 'PENDING',
    }],
    destination: {
      canonicalName: 'Destination X',
      id: 'destination-x',
      normalizedAddress: { address1: '1 Shared Way' },
    },
    destinationId: 'destination-x',
    dsvAuditEvents: [],
    id: input.id ?? 'order-a',
    orderMessages: [],
    sellerOrderKey: input.sellerOrderKey === undefined ? 'SO-A' : input.sellerOrderKey,
    sellerOrderSourceKind: 'DSV_DISPATCH_IMPORT',
    sourceOrderNumber: null,
  };
}
