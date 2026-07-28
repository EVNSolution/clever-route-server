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
    expect(deliveryStopsSelect?.select.driverProofMedia.where).toEqual({ shopId: 'shop-a' });
    expect(deliveryStopsSelect?.select.routePlanStops.where).toEqual({ shopId: 'shop-a' });
    expect(prisma.$transaction).toBeUndefined();
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

  test('enforces three-day customer date window and window/serviceDate mismatch', async () => {
    const service = new PrismaDsvV1ReadQueryService(prismaMock({
      commerceConnection: { findMany: vi.fn(() => Promise.resolve([{ timezone: 'Asia/Seoul' }])) },
      order: { findMany: vi.fn(() => Promise.resolve([])) },
    }) as never, () => new Date('2026-07-22T12:00:00.000Z'));

    await expect(service.listCustomerDeliveries(customerPrincipal(), { serviceDate: '2026-08-01' }))
      .resolves.toMatchObject({ emptyReason: 'DATE_OUT_OF_WINDOW', items: [], serviceDate: '2026-08-01' });
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
        { displayName: 'Alpha', externalCustomerCode: 'Alpha', id: 'customer-a', status: 'ACTIVE' },
        { displayName: 'Beta', externalCustomerCode: 'Beta', id: 'customer-b', status: 'ACTIVE' },
      ])),
    });
    const service = new PrismaDsvV1ReadQueryService(prisma as never);

    const result = await service.listCustomers(adminPrincipal(), { limit: 1 });
    const queryText = sqlText((prisma.$queryRaw as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]);

    expect(result.items).toEqual([{
      customerId: 'customer-a',
      displayName: 'Alpha',
      externalCustomerCode: 'Alpha',
      status: 'ACTIVE',
    }]);
    expect(result.page.nextCursor).toEqual(expect.any(String));
    expect(queryText).toContain('COALESCE("displayName", "externalCustomerCode") AS "displayName"');
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

  test('scopes real and synthetic records through the related order shop', async () => {
    const prisma = prismaMock({
      commerceConnection: { findMany: vi.fn(() => Promise.resolve([{ timezone: 'Asia/Seoul' }])) },
      deliveryStop: { findMany: vi.fn(() => Promise.resolve([])) },
      driverEvent: { findMany: vi.fn(() => Promise.resolve([])) },
    });
    const service = new PrismaDsvV1ReadQueryService(prisma as never, () => new Date('2026-07-22T12:00:00.000Z'));

    await service.listRecords(adminPrincipal(), { serviceDate: '2026-07-22' });

    expect(prisma.driverEvent.findMany).toHaveBeenCalledOnce();
    const eventQuery = firstMockArg<DriverEventFindManyQuery>(prisma.driverEvent.findMany);
    expect(eventQuery?.where?.shopId).toBe('shop-a');
    expect(eventQuery?.where?.deliveryStop?.shopId).toBe('shop-a');
    expect(eventQuery?.where?.deliveryStop?.order).toEqual({ shopId: 'shop-a' });
    expect(prisma.deliveryStop.findMany).toHaveBeenCalledOnce();
    const syntheticQuery = firstMockArg<DeliveryStopFindManyQuery>(prisma.deliveryStop.findMany);
    expect(syntheticQuery?.where?.shopId).toBe('shop-a');
    expect(syntheticQuery?.where?.order).toEqual({ shopId: 'shop-a' });
    expect(syntheticQuery?.where?.driverEvents?.none?.shopId).toBe('shop-a');
    expect(syntheticQuery?.where?.driverEvents?.none?.eventType.in).toContain('STOP_DELIVERED');
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
            { displayName: 'Alpha Customer', externalCustomerCode: 'A', id: 'customer-a', status: 'ACTIVE' },
            { displayName: 'Beta Customer', externalCustomerCode: 'B', id: 'customer-b', status: 'ACTIVE' },
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
            { code: 'A', id: 'condition-a', name: 'Alpha Condition', status: 'ACTIVE' },
            { code: 'B', id: 'condition-b', name: 'Beta Condition', status: 'ACTIVE' },
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

  test('vehicle list reads canonical driver assignments scoped to the shop and listed vehicles', async () => {
    const prisma = prismaMock({
      dsvVehicleDriverAssignment: { findMany: vi.fn(() => Promise.resolve([
        { driverId: 'driver-a', id: 'assignment-a', vehicleId: 'vehicle-a' },
        { driverId: 'driver-b', id: 'assignment-b', vehicleId: 'vehicle-a' },
        { driverId: 'driver-c', id: 'assignment-c', vehicleId: 'vehicle-b' },
      ])) },
      vehicle: { findMany: vi.fn(() => Promise.resolve([
        { id: 'vehicle-a', label: 'Alpha Vehicle', licensePlate: 'A', status: 'ACTIVE', vehicleType: 'VAN' },
        { id: 'vehicle-b', label: 'Beta Vehicle', licensePlate: 'B', status: 'ACTIVE', vehicleType: 'TRUCK' },
      ])) },
    });
    const service = new PrismaDsvV1ReadQueryService(prisma as never);

    const result = await service.listVehicles(adminPrincipal(), { limit: 2 });

    expect(result.items).toEqual([
      {
        displayName: 'Alpha Vehicle',
        driverAssignments: [
          { assignmentId: 'assignment-a', driverId: 'driver-a' },
          { assignmentId: 'assignment-b', driverId: 'driver-b' },
        ],
        status: 'ACTIVE',
        vehicleId: 'vehicle-a',
        vehiclePlate: 'A',
      },
      {
        displayName: 'Beta Vehicle',
        driverAssignments: [{ assignmentId: 'assignment-c', driverId: 'driver-c' }],
        status: 'ACTIVE',
        vehicleId: 'vehicle-b',
        vehiclePlate: 'B',
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
      }],
    });
    const service = new PrismaDsvV1ReadQueryService(prismaMock({
      commerceConnection: { findMany: vi.fn(() => Promise.resolve([{ timezone: 'Asia/Seoul' }])) },
      order: { findMany: vi.fn(() => Promise.resolve([row])) },
    }) as never, () => new Date('2026-07-22T12:00:00.000Z'));

    await expect(service.listCustomerDeliveries(customerPrincipal(), { serviceDate: '2026-07-22' })).resolves.toMatchObject({
      items: [{
        estimatedArrivalAt: new Date('2026-07-22T02:00:00.000Z'),
        etaInputRouteVersionId: 'route-version-a',
        etaSource: 'ROUTE_CALCULATION',
        etaStatus: 'READY',
        eventRows: [{ eventType: 'STOP_DELIVERED', occurredAt: new Date('2026-07-22T01:00:00.000Z') }],
        proofRows: [{ deletedAt: new Date('2026-07-23T00:00:00.000Z') }, { deletedAt: null }],
        sellerOrderKey: 'SO-A',
      }],
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
        routePlanId: 'route-stale',
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
    driverEvents?: { none?: { eventType: { in: string[] }; shopId: string } };
    order?: { shopId: string };
    shopId?: string;
  };
};

type DriverEventFindManyQuery = {
  where?: {
    deliveryStop?: { order?: { shopId: string }; shopId?: string };
    shopId?: string;
  };
};

type NestedDeliveryStopsSelect = {
  select: {
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
  driverEvents?: Array<{ eventType: string; id: string; occurredAt: Date }>;
  driverProofMedia?: Array<{ deletedAt: Date | null; id: string }>;
  id?: string;
  routePlanStops?: Array<{
    estimatedArrivalAt: Date | null;
    etaInputRouteVersionId: string | null;
    etaSource: string | null;
    etaStatus: string;
    id: string;
    routePlanId: string;
  }>;
  sellerOrderKey?: string | null;
} = {}) {
  return {
    currentRouteVersionId: 'route-version-a',
    customer: { displayName: 'Customer A', id: 'customer-a' },
    deliveryStatus: 'ASSIGNED',
    deliveryStops: [{
      driverEvents: input.driverEvents ?? [],
      driverProofMedia: input.driverProofMedia ?? [],
      id: `stop-${input.id ?? 'a'}`,
      recipientName: 'Recipient A',
      routePlanStops: input.routePlanStops ?? [],
      status: 'PENDING',
    }],
    destination: {
      canonicalName: 'Destination X',
      id: 'destination-x',
      normalizedAddress: { address1: '1 Shared Way' },
    },
    id: input.id ?? 'order-a',
    sellerOrderKey: input.sellerOrderKey === undefined ? 'SO-A' : input.sellerOrderKey,
    sellerOrderSourceKind: 'DSV_DISPATCH_IMPORT',
    sourceOrderNumber: null,
  };
}
