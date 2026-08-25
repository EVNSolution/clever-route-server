import { describe, expect, test, vi } from 'vitest';
import { classifyCoordinateInPolygons } from '../src/modules/route-grouping/route-grouping.geometry.js';
import { FakeDriverPushProvider } from '../src/modules/route-grouping/driver-push.provider.js';
import {
  PrismaRouteGroupingService,
  newChildRouteName,
  rebindCurrentOrdersToRouteVersion,
  replaceCurrentRouteGroupingChildVersion,
  resolveNewChildRouteIdx,
  resolveNextGlobalRouteIdx,
  syncRoutePlanStopsPreservingRows
} from '../src/modules/route-grouping/route-grouping.service.js';
import {
  RouteGroupingConflictError,
  RouteGroupingStopMembershipConflictError,
  RouteGroupingValidationError
} from '../src/modules/route-grouping/route-grouping.types.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('route grouping contracts', () => {
  test('REFERENCE copy reuses SHOPIFY order and stop ids without cloning route execution state', async () => {
    const source = copySourceFixture('SHOPIFY');
    const tx = copyTransactionHarness(source);
    const prisma = { $transaction: vi.fn((operation: (client: typeof tx) => unknown) => operation(tx)) };
    const service = new PrismaRouteGroupingService(prisma as never, new FakeDriverPushProvider());
    vi.spyOn(service, 'getGrouping').mockResolvedValue({ id: 'group-copy' } as never);

    await service.copyGrouping({
      actor: 'admin',
      expectedUpdatedAt: source.updatedAt.toISOString(),
      groupingId: source.id,
      mode: 'REFERENCE',
      shopDomain: 'tenant.example'
    });

    expect(tx.routeGroupingOrder.createMany).toHaveBeenCalledWith({
      data: [{ deliveryStopId: 'stop-source', groupingId: 'group-copy', orderId: 'order-source', shopId: 'shop-1', sourceSequence: 1 }]
    });
    expect(tx.order.create).not.toHaveBeenCalled();
    expect(tx.routeGroupingVersion.create).toHaveBeenCalledOnce();
    expect(tx.routePlan.create).not.toHaveBeenCalled();
  });

  test('REFERENCE copy rejects CUSTOM membership and started route locks before creating a group', async () => {
    const customSource = copySourceFixture('CUSTOM');
    const customTx = copyTransactionHarness(customSource);
    const customService = new PrismaRouteGroupingService({ $transaction: vi.fn((operation: (client: typeof customTx) => unknown) => operation(customTx)) } as never, new FakeDriverPushProvider());
    await expect(customService.copyGrouping({ actor: 'admin', expectedUpdatedAt: customSource.updatedAt.toISOString(), groupingId: customSource.id, mode: 'REFERENCE', shopDomain: 'tenant.example' }))
      .rejects.toMatchObject({ code: 'CUSTOM_ORDER_REFERENCE_COPY_NOT_ALLOWED' });
    expect(customTx.routeGrouping.create).not.toHaveBeenCalled();

    const lockedSource = copySourceFixture('SHOPIFY');
    const lockedTx = copyTransactionHarness(lockedSource);
    lockedTx.routePlanStop.findMany.mockResolvedValue([{ deliveryStopId: 'stop-source', routePlan: { driverEvents: [], status: 'IN_PROGRESS' } }]);
    const lockedService = new PrismaRouteGroupingService({ $transaction: vi.fn((operation: (client: typeof lockedTx) => unknown) => operation(lockedTx)) } as never, new FakeDriverPushProvider());
    await expect(lockedService.copyGrouping({ actor: 'admin', expectedUpdatedAt: lockedSource.updatedAt.toISOString(), groupingId: lockedSource.id, mode: 'REFERENCE', shopDomain: 'tenant.example' }))
      .rejects.toMatchObject({ code: 'ROUTE_GROUPING_COPY_LOCKED', orderIds: ['order-source'] });
    expect(lockedTx.routeGrouping.create).not.toHaveBeenCalled();
  });

  test('VIRTUAL copy creates independent CUSTOM ids with normalized navigation fields only', async () => {
    const source = copySourceFixture('SHOPIFY');
    const tx = copyTransactionHarness(source);
    tx.order.create.mockResolvedValue({ deliveryStops: [{ id: 'stop-virtual' }], id: 'order-virtual' });
    const service = new PrismaRouteGroupingService({ $transaction: vi.fn((operation: (client: typeof tx) => unknown) => operation(tx)) } as never, new FakeDriverPushProvider());
    vi.spyOn(service, 'getGrouping').mockResolvedValue({ id: 'group-copy' } as never);

    await service.copyGrouping({ actor: 'admin', expectedUpdatedAt: source.updatedAt.toISOString(), groupingId: source.id, mode: 'VIRTUAL', shopDomain: 'tenant.example' });

    const createArg = tx.order.create.mock.calls[0]?.[0] as unknown as { data: Record<string, unknown> } | undefined;
    const data = createArg?.data;
    expect(data).toMatchObject({
      email: 'recipient@example.test',
      name: '#1001',
      ownedRouteGroupingId: 'group-copy',
      phone: '+14165550100',
      rawPayload: { kind: 'CLEVER_VIRTUAL_ROUTE_COPY', schemaVersion: 1, sourceDeliveryStopId: 'stop-source', sourceOrderId: 'order-source' },
      shopId: 'shop-1',
      sourcePlatform: 'CUSTOM'
    });
    expect(data).not.toHaveProperty('financialStatus');
    expect(data).not.toHaveProperty('fulfillmentStatus');
    expect(data).not.toHaveProperty('shopifyOrderLegacyId');
    expect(data).not.toHaveProperty('shippingAddress');
    const deliveryStops = data?.deliveryStops as { create: unknown } | undefined;
    expect(deliveryStops?.create).toMatchObject({
      address1: '100 King St', address2: 'Dock 2', city: 'Toronto', countryCode: 'CA', latitude: 43.65,
      longitude: -79.38, postalCode: 'M5H 1J9', priority: 7, province: 'ON', serviceMinutes: 12
    });
    expect(tx.routeGroupingOrder.createMany).toHaveBeenCalledWith({
      data: [{ deliveryStopId: 'stop-virtual', groupingId: 'group-copy', orderId: 'order-virtual', shopId: 'shop-1', sourceSequence: 1 }]
    });
  });

  test('stale copy revision and a failed virtual item prevent membership and inventory writes', async () => {
    const source = copySourceFixture('SHOPIFY');
    const staleTx = copyTransactionHarness(source);
    const staleService = new PrismaRouteGroupingService({ $transaction: vi.fn((operation: (client: typeof staleTx) => unknown) => operation(staleTx)) } as never, new FakeDriverPushProvider());
    await expect(staleService.copyGrouping({ actor: 'admin', expectedUpdatedAt: '2026-08-19T13:00:00.000Z', groupingId: source.id, mode: 'VIRTUAL', shopDomain: 'tenant.example' }))
      .rejects.toBeInstanceOf(RouteGroupingConflictError);
    expect(staleTx.routeGrouping.create).not.toHaveBeenCalled();

    const failedTx = copyTransactionHarness(source);
    failedTx.order.create.mockRejectedValue(new Error('injected virtual copy failure'));
    const failedService = new PrismaRouteGroupingService({ $transaction: vi.fn((operation: (client: typeof failedTx) => unknown) => operation(failedTx)) } as never, new FakeDriverPushProvider());
    await expect(failedService.copyGrouping({ actor: 'admin', expectedUpdatedAt: source.updatedAt.toISOString(), groupingId: source.id, mode: 'VIRTUAL', shopDomain: 'tenant.example' }))
      .rejects.toThrow('injected virtual copy failure');
    expect(failedTx.routeGroupingOrder.createMany).not.toHaveBeenCalled();
    expect(failedTx.inventory.upsert).not.toHaveBeenCalled();
  });

  test('cross-tenant copy is not found and performs no source read or write', async () => {
    const source = copySourceFixture('SHOPIFY');
    const tx = copyTransactionHarness(source);
    tx.shop.findUnique.mockResolvedValue(null);
    const service = new PrismaRouteGroupingService({ $transaction: vi.fn((operation: (client: typeof tx) => unknown) => operation(tx)) } as never, new FakeDriverPushProvider());

    await expect(service.copyGrouping({
      actor: 'admin',
      expectedUpdatedAt: source.updatedAt.toISOString(),
      groupingId: source.id,
      mode: 'VIRTUAL',
      shopDomain: 'other-tenant.example'
    })).resolves.toBeNull();
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(tx.routeGrouping.findFirst).not.toHaveBeenCalled();
    expect(tx.routeGrouping.create).not.toHaveBeenCalled();
  });

  test('does not reproduce the legacy shared CUSTOM cascade when deleting another group', async () => {
    const tx = deleteGroupingTransactionHarness({ ownedRouteGroupingId: 'group-owner' });
    const service = new PrismaRouteGroupingService({ $transaction: vi.fn((operation: (client: typeof tx) => unknown) => operation(tx)) } as never, new FakeDriverPushProvider());
    await service.deleteGrouping({ groupingId: 'group-copy', shopDomain: 'tenant.example' });
    expect(tx.order.deleteMany).toHaveBeenCalledWith({
      where: { ownedRouteGroupingId: 'group-copy', shopId: 'shop-1', sourcePlatform: 'CUSTOM' }
    });
    expect(tx.routeGrouping.delete).toHaveBeenCalledWith({ where: { id: 'group-copy' } });
  });

  test('blocks group hard deletion while a CURRENT child route is in progress', async () => {
    const tx = deleteGroupingTransactionHarness({ ownedRouteGroupingId: 'group-copy' });
    tx.routeGrouping.findFirst.mockResolvedValue({
      childVersions: [{
        routePlan: { driver: null, status: 'IN_PROGRESS' }, routePlanId: 'route-plan-id',
        status: 'CURRENT', supersededAt: null, version: 1
      }],
      id: 'group-copy', orders: [], shopId: 'shop-1'
    });
    const service = new PrismaRouteGroupingService(
      { $transaction: vi.fn((operation: (client: typeof tx) => unknown) => operation(tx)) } as never,
      new FakeDriverPushProvider()
    );

    await expect(service.deleteGrouping({ groupingId: 'group-copy', shopDomain: 'tenant.example' }))
      .rejects.toThrow('in-progress child routes cannot be archived or deleted');
    expect(tx.routePlanStop.deleteMany).not.toHaveBeenCalled();
    expect(tx.routeGrouping.delete).not.toHaveBeenCalled();
  });

  test('two VIRTUAL copies receive distinct local identities and deleting one targets only its owned graph', async () => {
    const source = copySourceFixture('SHOPIFY');
    const firstTx = copyTransactionHarness(source);
    firstTx.order.create.mockResolvedValue({ deliveryStops: [{ id: 'stop-virtual-1' }], id: 'order-virtual-1' });
    const secondTx = copyTransactionHarness(source);
    secondTx.routeGrouping.create.mockResolvedValue({ id: 'group-copy-2' });
    secondTx.order.create.mockResolvedValue({ deliveryStops: [{ id: 'stop-virtual-2' }], id: 'order-virtual-2' });
    const transactions = [firstTx, secondTx];
    const service = new PrismaRouteGroupingService({
      $transaction: vi.fn((operation: (client: typeof firstTx) => unknown) => operation(transactions.shift() ?? firstTx))
    } as never, new FakeDriverPushProvider());
    vi.spyOn(service, 'getGrouping').mockResolvedValue({ id: 'copied' } as never);

    await service.copyGrouping({ actor: 'admin', expectedUpdatedAt: source.updatedAt.toISOString(), groupingId: source.id, mode: 'VIRTUAL', shopDomain: 'tenant.example' });
    await service.copyGrouping({ actor: 'admin', expectedUpdatedAt: source.updatedAt.toISOString(), groupingId: source.id, mode: 'VIRTUAL', shopDomain: 'tenant.example' });

    type VirtualOrderCreateData = { rawPayload: unknown; shopifyOrderGid: string; sourceOrderId: string };
    const firstData = (firstTx.order.create.mock.calls[0]?.[0] as unknown as { data: VirtualOrderCreateData }).data;
    const secondData = (secondTx.order.create.mock.calls[0]?.[0] as unknown as { data: VirtualOrderCreateData }).data;
    expect(firstData.shopifyOrderGid).not.toBe(secondData.shopifyOrderGid);
    expect(firstData.sourceOrderId).not.toBe(secondData.sourceOrderId);
    expect(firstData.rawPayload).toEqual(secondData.rawPayload);

    const deleteTx = deleteGroupingTransactionHarness({ ownedRouteGroupingId: 'group-copy' });
    const deleteService = new PrismaRouteGroupingService({ $transaction: vi.fn((operation: (client: typeof deleteTx) => unknown) => operation(deleteTx)) } as never, new FakeDriverPushProvider());
    await deleteService.deleteGrouping({ groupingId: 'group-copy', shopDomain: 'tenant.example' });
    expect(deleteTx.order.deleteMany).toHaveBeenCalledWith({
      where: { ownedRouteGroupingId: 'group-copy', shopId: 'shop-1', sourcePlatform: 'CUSTOM' }
    });
  });

  test('owned graph deletion failures roll back before inventory or group deletion', async () => {
    const tx = deleteGroupingTransactionHarness({ ownedRouteGroupingId: 'group-copy' });
    tx.order.deleteMany.mockRejectedValue(new Error('owned graph blocked'));
    const service = new PrismaRouteGroupingService({ $transaction: vi.fn((operation: (client: typeof tx) => unknown) => operation(tx)) } as never, new FakeDriverPushProvider());
    await expect(service.deleteGrouping({ groupingId: 'group-copy', shopDomain: 'tenant.example' })).rejects.toThrow('owned graph blocked');
    expect(tx.inventory.deleteMany).not.toHaveBeenCalled();
    expect(tx.routeGrouping.delete).not.toHaveBeenCalled();
  });

  test('foreign CUSTOM group or route-plan associations block group deletion before mutation', async () => {
    const tx = deleteGroupingTransactionHarness({ ownedRouteGroupingId: 'group-copy' });
    tx.routeGroupingOrder.findMany.mockResolvedValue([{ groupingId: 'group-foreign', orderId: 'order-custom' }]);
    tx.routePlanStop.findMany.mockResolvedValue([{ deliveryStopId: 'stop-custom', routePlanId: 'plan-foreign' }]);
    const service = new PrismaRouteGroupingService({ $transaction: vi.fn((operation: (client: typeof tx) => unknown) => operation(tx)) } as never, new FakeDriverPushProvider());

    await expect(service.deleteGrouping({ groupingId: 'group-copy', shopDomain: 'tenant.example' })).rejects.toMatchObject({
      blockers: [
        'owned CUSTOM orders are linked to another route group',
        'owned CUSTOM stops are linked to another route plan'
      ],
      code: 'ROUTE_GROUPING_DELETE_BLOCKED'
    });
    expect(tx.routePlanStop.deleteMany).not.toHaveBeenCalled();
    expect(tx.order.deleteMany).not.toHaveBeenCalled();
    expect(tx.inventory.deleteMany).not.toHaveBeenCalled();
    expect(tx.routeGrouping.delete).not.toHaveBeenCalled();
  });

  test('a group without child plans treats every owned CUSTOM route-plan stop as a delete blocker', async () => {
    const tx = deleteGroupingTransactionHarness({ ownedRouteGroupingId: 'group-copy' });
    tx.routePlanStop.findMany.mockResolvedValue([{ deliveryStopId: 'stop-custom', routePlanId: 'plan-standalone' }]);
    const service = new PrismaRouteGroupingService({ $transaction: vi.fn((operation: (client: typeof tx) => unknown) => operation(tx)) } as never, new FakeDriverPushProvider());

    await expect(service.deleteGrouping({ groupingId: 'group-copy', shopDomain: 'tenant.example' })).rejects.toMatchObject({
      blockers: ['owned CUSTOM stops are linked to another route plan'],
      code: 'ROUTE_GROUPING_DELETE_BLOCKED'
    });
    expect(tx.routePlanStop.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        deliveryStop: { order: { ownedRouteGroupingId: 'group-copy', sourcePlatform: 'CUSTOM' } },
        shopId: 'shop-1'
      }
    }));
    expect(tx.order.deleteMany).not.toHaveBeenCalled();
    expect(tx.routeGrouping.delete).not.toHaveBeenCalled();
  });

  test('creates an unassigned local custom order and stop without a commerce client', async () => {
    const orderCreate = vi.fn<(input: { data: {
      name: string;
      ownedRouteGroupingId: string;
      rawPayload: unknown;
      shopId: string;
      shopifyOrderGid: string;
      sourceOrderId: string;
      sourcePlatform: string;
    } }) => Promise<{ deliveryStops: Array<{ id: string }>; id: string; orderItems: [] }>>()
      .mockResolvedValue({ deliveryStops: [{ id: 'stop-custom' }], id: 'order-custom', orderItems: [] });
    const groupingOrderCreate = vi.fn().mockResolvedValue({ id: 'group-order-custom' });
    const tx = {
      inventory: {
        findUnique: vi.fn().mockResolvedValue({ id: 'inventory-1' }),
        update: vi.fn().mockResolvedValue({ id: 'inventory-1' })
      },
      inventoryEvent: { createMany: vi.fn() },
      inventoryOrder: {
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
        findMany: vi.fn().mockResolvedValue([])
      },
      order: {
        create: orderCreate,
        findMany: vi.fn().mockResolvedValue([{ id: 'order-custom', orderItems: [] }])
      },
      routeGrouping: {
        findFirst: vi.fn().mockResolvedValue({
          dateRangeEnd: null,
          dateRangeStart: null,
          id: 'group-1',
          name: 'Group 1',
          planDate: new Date('2026-08-19T00:00:00.000Z'),
          shopId: 'shop-1',
          updatedAt: new Date('2026-08-19T12:00:00.000Z')
        }),
        update: vi.fn().mockResolvedValue({ id: 'group-1' })
      },
      routeGroupingOrder: {
        aggregate: vi.fn().mockResolvedValue({ _max: { sourceSequence: 3 } }),
        create: groupingOrderCreate
      },
      shop: { findUnique: vi.fn().mockResolvedValue({ id: 'shop-1' }) }
    };
    const prisma = { $transaction: vi.fn((operation: (client: typeof tx) => unknown) => operation(tx)) };
    const service = new PrismaRouteGroupingService(prisma as never, new FakeDriverPushProvider());
    vi.spyOn(service, 'getGrouping').mockResolvedValue({ id: 'group-1' } as never);

    await service.createCustomStop({
      actor: 'admin-user',
      groupingId: 'group-1',
      latitude: 43.7,
      longitude: -79.4,
      shopDomain: 'tenant.example',
      stopName: 'Warehouse pickup'
    });

    const createdOrder = orderCreate.mock.calls[0]?.[0].data;
    expect(createdOrder?.name).toBe('Warehouse pickup');
    expect(createdOrder?.rawPayload).toMatchObject({ kind: 'CLEVER_CUSTOM_ROUTE_STOP' });
    expect(createdOrder?.shopId).toBe('shop-1');
    expect(createdOrder?.shopifyOrderGid).toMatch(/^gid:\/\/clever\/CustomRouteStop\//u);
    expect(createdOrder?.ownedRouteGroupingId).toBe('group-1');
    expect(createdOrder?.sourceOrderId).toMatch(/^custom-stop:/u);
    expect(createdOrder?.sourcePlatform).toBe('CUSTOM');
    expect(groupingOrderCreate).toHaveBeenCalledWith({
      data: {
        assignmentStatus: 'UNASSIGNED',
        deliveryStopId: 'stop-custom',
        groupingId: 'group-1',
        orderId: 'order-custom',
        shopId: 'shop-1',
        sourceSequence: 4
      }
    });
  });

  test('rejects zero coordinates before creating a custom route stop', async () => {
    const transaction = vi.fn();
    const service = new PrismaRouteGroupingService({ $transaction: transaction } as never, new FakeDriverPushProvider());

    const error = await service.createCustomStop({
      actor: 'admin-user',
      countryCode: 'CA',
      groupingId: 'group-1',
      latitude: 0,
      longitude: 0,
      province: 'ON',
      shopDomain: 'tenant.example',
      stopName: 'Invalid stop'
    }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(RouteGroupingValidationError);
    if (!(error instanceof RouteGroupingValidationError)) throw error;
    expect(error.blockers.some((blocker) => blocker.includes('COORDINATES_ZERO'))).toBe(true);
    expect(error.code).toBe('ROUTE_GROUPING_INVALID');
    expect(transaction).not.toHaveBeenCalled();
  });

  test('denies cross-tenant custom stop creation and rejects commerce stop edits', async () => {
    const crossTenantTx = { shop: { findUnique: vi.fn().mockResolvedValue(null) } };
    const crossTenantPrisma = { $transaction: vi.fn((operation: (client: typeof crossTenantTx) => unknown) => operation(crossTenantTx)) };
    const crossTenantService = new PrismaRouteGroupingService(crossTenantPrisma as never, new FakeDriverPushProvider());
    expect(await crossTenantService.createCustomStop({ actor: 'admin', groupingId: 'other-group', shopDomain: 'tenant.example', stopName: 'Denied' })).toBeNull();

    const editTx = {
      routeGrouping: { findFirst: vi.fn().mockResolvedValue({ id: 'group-1', shopId: 'shop-1' }) },
      routeGroupingOrder: {
        findFirst: vi.fn().mockResolvedValue({
          deliveryStop: { latitude: null, longitude: null, priority: 0, serviceMinutes: 5, timeWindowEnd: null, timeWindowStart: null },
          order: { sourcePlatform: 'SHOPIFY' }
        })
      },
      shop: { findUnique: vi.fn().mockResolvedValue({ id: 'shop-1' }) }
    };
    const editPrisma = { $transaction: vi.fn((operation: (client: typeof editTx) => unknown) => operation(editTx)) };
    const editService = new PrismaRouteGroupingService(editPrisma as never, new FakeDriverPushProvider());
    await expect(editService.updateCustomStop({
      deliveryStopId: 'shopify-stop',
      groupingId: 'group-1',
      instructions: 'do not allow',
      shopDomain: 'tenant.example'
    })).rejects.toMatchObject({ code: 'ROUTE_GROUPING_INVALID' });
  });

  test('deletes only the tenant group custom order graph', async () => {
    const orderDelete = vi.fn().mockResolvedValue({ id: 'order-custom' });
    const tx = {
      inventory: {
        findUnique: vi.fn().mockResolvedValue({ id: 'inventory-1' }),
        update: vi.fn().mockResolvedValue({ id: 'inventory-1' })
      },
      inventoryEvent: { createMany: vi.fn() },
      inventoryOrder: {
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
        findMany: vi.fn().mockResolvedValue([{ orderId: 'order-custom' }])
      },
      order: {
        delete: orderDelete,
        findMany: vi.fn().mockResolvedValue([{ id: 'order-custom', orderItems: [] }])
      },
      routeGrouping: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'group-1',
          name: 'Group 1',
          shopId: 'shop-1',
          updatedAt: new Date('2026-08-19T12:00:00.000Z')
        }),
        findUnique: vi.fn().mockResolvedValue({
          childVersions: [],
          id: 'group-1',
          orders: [{ deliveryStopId: 'stop-custom', order: { ownedRouteGroupingId: 'group-1', sourcePlatform: 'CUSTOM' }, orderId: 'order-custom' }]
        }),
        update: vi.fn().mockResolvedValue({ id: 'group-1' })
      },
      shop: { findUnique: vi.fn().mockResolvedValue({ id: 'shop-1' }) }
    };
    const prisma = { $transaction: vi.fn((operation: (client: typeof tx) => unknown) => operation(tx)) };
    const service = new PrismaRouteGroupingService(prisma as never, new FakeDriverPushProvider());
    vi.spyOn(service, 'getGrouping').mockResolvedValue({ id: 'group-1' } as never);

    await service.deleteCustomStop({ deliveryStopId: 'stop-custom', groupingId: 'group-1', shopDomain: 'tenant.example' });

    expect(orderDelete).toHaveBeenCalledWith({ where: { id: 'order-custom' } });
    expect(tx.inventoryOrder.deleteMany).toHaveBeenCalledWith({
      where: { inventoryId: 'inventory-1', orderId: { in: ['order-custom'] }, shopId: 'shop-1' }
    });
  });

  test('marks local route stops explicitly and excludes them from commerce order lists', () => {
    const schema = readFileSync(join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    const service = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.service.ts'), 'utf8');
    const orderRepository = readFileSync(join(process.cwd(), 'src/modules/shopify/order-sync.repository.ts'), 'utf8');

    expect(schema).toMatch(/enum CommerceSourcePlatform \{[\s\S]*?CUSTOM[\s\S]*?\}/u);
    expect(service).toContain("sourcePlatform: 'CUSTOM'");
    expect(service).toContain('isCustomStop: order.order.sourcePlatform ===');
    expect(orderRepository).toContain("sourcePlatform: { not: 'CUSTOM' }");
  });

  test('moves retained route stops to temporary sequences before compacting them', async () => {
    const updateMany = vi.fn<(input: { data: { sequence: number }; where: Record<string, unknown> }) => Promise<{ count: number }>>()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    const tx = {
      routePlanStop: {
        create: vi.fn(),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        updateMany
      }
    };

    await syncRoutePlanStopsPreservingRows(tx as never, 'shop-1', 'route-1', [
      { deliveryStopId: 'stop-2' },
      { deliveryStopId: 'stop-1' }
    ] as never);

    expect(updateMany.mock.calls.map(([input]) => input.data.sequence)).toEqual([
      -1_000_000_000,
      -999_999_999,
      1,
      2
    ]);
    expect(tx.routePlanStop.create).not.toHaveBeenCalled();
  });

  test('creates route plans and groups immediately in Ready state', () => {
    const schema = readFileSync(join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    const routePlanModel = /model RoutePlan \{(?<body>[\s\S]*?)\n\}/u.exec(schema)?.groups?.body ?? '';
    const routeGroupModel = /model RouteGrouping \{(?<body>[\s\S]*?)\n\}/u.exec(schema)?.groups?.body ?? '';
    expect(routePlanModel).toContain('status');
    expect(routePlanModel).toContain('@default(READY)');
    expect(routeGroupModel).toContain('status');
    expect(routeGroupModel).toContain('@default(READY)');

    const service = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.service.ts'), 'utf8');
    expect(service).toContain("status: 'READY'");
    expect(service).toContain("status: 'CANCELLED'");
    expect(service).not.toContain("status: 'OPTIMIZED'");
  });

  test('keeps parent route group date range on the canonical model', () => {
    const schema = readFileSync(join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    const modelBody = /model RouteGrouping \{(?<body>[\s\S]*?)\n\}/u.exec(schema)?.groups?.body ?? '';
    expect(modelBody).toContain('dateRangeStart       DateTime?');
    expect(modelBody).toContain('dateRangeEnd         DateTime?');
    expect(modelBody).toContain('@@index([shopId, dateRangeStart, dateRangeEnd, status])');
  });

  test('keeps branch ownership as an explicit active lock table', () => {
    const schema = readFileSync(join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    const branchBody = /model RouteGroupingBranch \{(?<body>[\s\S]*?)\n\}/u.exec(schema)?.groups?.body ?? '';
    const lockBody = /model RouteGroupingBranchOrderLock \{(?<body>[\s\S]*?)\n\}/u.exec(schema)?.groups?.body ?? '';
    expect(branchBody).toContain('orderLocks');
    expect(lockBody).toContain('@@unique([groupingId, orderId])');
    expect(lockBody).not.toContain('@@unique([shopId, orderId])');
    expect(lockBody).not.toContain('releasedAt');
    expect(lockBody).not.toContain('status');
  });

  test('links route groups to inventory without child branch deltas', () => {
    const schema = readFileSync(join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    const inventoryBody = /model Inventory \{(?<body>[\s\S]*?)\n\}/u.exec(schema)?.groups?.body ?? '';
    const routeGroupBody = /model RouteGrouping \{(?<body>[\s\S]*?)\n\}/u.exec(schema)?.groups?.body ?? '';
    expect(inventoryBody).toContain('routeGroupingId');
    expect(inventoryBody).toContain('@unique');
    expect(inventoryBody).toContain('onDelete: SetNull');
    expect(routeGroupBody).toContain('inventory');

    const source = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.service.ts'), 'utf8');
    const types = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.types.ts'), 'utf8');
    expect(source).toContain('createRouteGroupingInventory(tx');
    expect(source).toContain('syncRouteGroupingInventoryOrders(tx');
    expect(source).toContain('inventory: { select: { id: true } }');
    expect(source).toContain('linkedInventoryId: group.inventory?.id ?? null');
    expect(types).toContain('linkedInventoryId: string | null');
    expect(source).toContain('await recomputeAssignments(tx, group.id)');
    expect(source).not.toContain('syncRouteGroupingInventoryOrders(tx, input.branch');
  });

  test('keeps inventory history after order item replacement', () => {
    const schema = readFileSync(join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    const eventBody = /model InventoryEvent \{(?<body>[\s\S]*?)\n\}/u.exec(schema)?.groups?.body ?? '';
    expect(eventBody).toMatch(/orderItemId\s+String\?/u);
    expect(eventBody).toContain('onDelete: SetNull');
    expect(eventBody).toContain('quantityDelta Int?');

    const source = readFileSync(join(process.cwd(), 'src/modules/shopify/order-sync.repository.ts'), 'utf8');
    expect(source).toContain('const previousItems = await input.tx.orderItem.findMany');
    expect(source).toContain('recordInventorySourceItemDeltas(input.tx');
    expect(source).toContain('actor: "order-sync"');
  });


  test('backfills existing route groups into linked inventories during migration', () => {
    const migration = readFileSync(join(process.cwd(), 'prisma/migrations/20260629183000_link_route_grouping_inventory/migration.sql'), 'utf8');
    expect(migration).toContain('WITH missing_group_inventories AS');
    expect(migration).toContain('FROM "route_groupings" rg');
    expect(migration).toContain('JOIN "route_grouping_orders" rgo');
    expect(migration).toContain('ON CONFLICT ("inventoryId", "orderId") DO NOTHING');
  });

  test('allows standalone inventory creation while keeping route-group inventory sync separate', () => {
    const source = readFileSync(join(process.cwd(), 'src/modules/inventory/inventory.service.ts'), 'utf8');
    const routes = readFileSync(join(process.cwd(), 'src/routes/admin-inventories.routes.ts'), 'utf8');
    expect(source).toContain('async createInventory(input: CreateInventoryInput)');
    expect(source).toContain('routeGroupingId: null');
    expect(source).toContain('route group inventory is managed by route groups');
    expect(routes).toContain('inventoryService.createInventory');
    expect(routes).not.toContain('inventory is managed by route groups');
  });

  test('classifies overlapping split polygons by latest draw order', () => {
    const first = { id: 'a', vertices: [{ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 10 }, { latitude: 10, longitude: 10 }, { latitude: 10, longitude: 0 }] };
    const second = { id: 'b', vertices: [{ latitude: 5, longitude: 5 }, { latitude: 5, longitude: 15 }, { latitude: 15, longitude: 15 }, { latitude: 15, longitude: 5 }] };
    expect(classifyCoordinateInPolygons({ latitude: 1, longitude: 1 }, [first, second])).toEqual({ status: 'ASSIGNED', polygonIds: ['a'] });
    expect(classifyCoordinateInPolygons({ latitude: 20, longitude: 20 }, [first, second])).toEqual({ status: 'UNASSIGNED', polygonIds: [] });
    expect(classifyCoordinateInPolygons({ latitude: 6, longitude: 6 }, [first, second])).toEqual({ status: 'ASSIGNED', polygonIds: ['b'] });
    expect(classifyCoordinateInPolygons({ latitude: 0, longitude: 5 }, [first])).toEqual({ status: 'ASSIGNED', polygonIds: ['a'] });
  });


  test('lets re-optimization persist visible route slots without a pre-save blocker', () => {
    const source = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.service.ts'), 'utf8');
    expect(source).not.toContain('save route changes before re-optimizing new routes');
    expect(source).toContain('const routeSlotCount = Math.max(routeAssignmentGroups.length, currentChildren.length)');
    expect(source).toContain('const numberedCandidate = { ...candidate, name: `#${routeIdx}`, routeIdx }');
    expect(source).toContain('const routePlan = await createChildRoutePlan(tx, loaded, numberedCandidate, input.actor)');
  });

  test('allows pickup facts through shared route group create/add validation', () => {
    const source = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.service.ts'), 'utf8');
    const validatorBody = source.slice(source.indexOf('function validateCreateFacts'), source.indexOf('async function recomputeAssignments'));

    expect(source).toContain('const blockers = validateCreateFacts({ dateRange, facts, orderIds });');
    expect(source).toContain('const blockers = validateCreateFacts({ dateRange: loadedGroupDateRange(group), facts, orderIds: newOrderIds });');
    expect(validatorBody).not.toContain('pickup orders cannot be grouped into driver delivery routes');
    expect(validatorBody).not.toContain('isPickupService');
  });

  test('defaults generated route groups to loop back to the depot', () => {
    const source = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.service.ts'), 'utf8');
    expect(source).toContain("const DEFAULT_ROUTE_GROUPING_ROUTE_END_MODE = 'RETURN_TO_DEPOT'");
    expect(source).toContain('routeEndMode: DEFAULT_ROUTE_GROUPING_ROUTE_END_MODE');
    expect(source).toContain('constraints: mergeRouteConstraintsForReoptimization(');
    expect(source).toContain('routeConstraints(loaded, candidate.depot)');
  });

  test('leaves generated child start date and time unset until explicitly saved', () => {
    const source = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.service.ts'), 'utf8');
    const constraintsBody = source.slice(source.indexOf('function routeConstraints('), source.indexOf('function routeMetrics('));

    expect(constraintsBody).not.toContain('departureTime');
    expect(constraintsBody).not.toContain('scheduledStartAt');
    expect(source).toContain('scheduledStartAt: readScheduledStartAt(routePlan.constraints)');
  });

  test('keeps draft saves child-only without root or branch rows', () => {
    const source = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.service.ts'), 'utf8');
    expect(source).toContain('assertChildOnlyDraftRouteEnvelope(routes)');
    expect(source).toContain('routePlanId !== null ? `routePlan:${routePlanId}`');
    expect(source).toContain('tempId !== null ? `temp:${tempId}`');
    expect(source).toContain('routeIdx !== undefined ? `routeIdx:${routeIdx}`');
    expect(source).toContain("route draft must not include a root route row");
    expect(source).toContain("route draft must include child routes only");
    expect(source).toContain("'route draft route keys must be unique'");
  });

  test('rebinds unassigned or same-group orders without stealing another group assignment', async () => {
    const updates: unknown[] = [];
    const count = await rebindCurrentOrdersToRouteVersion({
      order: {
        updateMany: (args: unknown) => {
          updates.push(args);
          return Promise.resolve({ count: 2 });
        }
      }
    }, {
      groupingId: 'grouping-a',
      nextRouteVersionId: 'version-next',
      orderIds: ['order-a', 'order-b', 'order-a'],
      shopId: 'shop-a'
    });

    expect(count).toBe(2);
    expect(updates).toEqual([{
      data: { currentRouteVersionId: 'version-next' },
      where: {
        OR: [
          { currentRouteVersionId: null },
          { currentRouteVersion: { is: { groupingId: 'grouping-a' } } }
        ],
        id: { in: ['order-a', 'order-b'] },
        shopId: 'shop-a'
      }
    }]);

    await expect(rebindCurrentOrdersToRouteVersion({
      order: { updateMany: () => Promise.resolve({ count: 1 }) }
    }, {
      groupingId: 'grouping-a',
      nextRouteVersionId: 'version-next',
      orderIds: ['order-a', 'order-b'],
      shopId: 'shop-a'
    })).rejects.toMatchObject({ code: 'ROUTE_GROUPING_STALE_WRITE' });
  });

  test('rebinds current order ownership across every child-version replacement path', () => {
    const source = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.service.ts'), 'utf8');
    const calls = source.match(/await replaceCurrentRouteGroupingChildVersion\(tx,/gu) ?? [];

    expect(calls).toHaveLength(6);
    expect(source).not.toMatch(/routeGroupingChildVersion\.update\(\{\s*data:\s*\{\s*(?:driverId|snapshot):/u);
  });

  test('archives the prior child snapshot before creating and rebinding its immutable successor', async () => {
    const calls: string[] = [];
    const oldSnapshot = { stops: [{ orderId: 'order-old' }] };
    const nextSnapshot = { stops: [{ orderId: 'order-old' }, { orderId: 'order-new' }] };
    const prisma = {
      order: { updateMany: vi.fn(() => { calls.push('rebind'); return Promise.resolve({ count: 2 }); }) },
      routeGroupingChildVersion: {
        create: vi.fn((...args: [unknown]) => { void args; calls.push('create'); return Promise.resolve({ id: 'child-next' }); }),
        updateMany: vi.fn((...args: [unknown]) => { void args; calls.push('archive'); return Promise.resolve({ count: 1 }); })
      }
    };

    await expect(replaceCurrentRouteGroupingChildVersion(prisma as never, {
      currentChildId: 'child-old', driverId: 'driver-id', groupingId: 'group-id', groupingVersionId: 'group-version-id',
      notificationStatus: 'SENT', orderIds: ['order-old', 'order-new'], publishedAt: new Date('2026-08-25T00:00:00Z'),
      routePlanId: 'route-id', shopId: 'shop-id', snapshot: nextSnapshot, version: 7
    })).resolves.toBe('child-next');

    expect(calls).toEqual(['archive', 'create', 'rebind']);
    expect(oldSnapshot).toEqual({ stops: [{ orderId: 'order-old' }] });
    const archiveCall: unknown = prisma.routeGroupingChildVersion.updateMany.mock.calls[0]?.[0];
    const createCall: unknown = prisma.routeGroupingChildVersion.create.mock.calls[0]?.[0];
    expect(archiveCall).toMatchObject({
      data: { status: 'ARCHIVED' },
      where: { id: 'child-old', status: 'CURRENT', supersededAt: null }
    });
    expect(createCall).toMatchObject({ data: { snapshot: nextSnapshot, status: 'CURRENT', supersededAt: null } });
  });

  test('allows draft saves to persist a validated vehicle on child route plans', () => {
    const source = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.service.ts'), 'utf8');
    const types = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.types.ts'), 'utf8');

    expect(types).toContain('vehicleId?: string | null');
    expect(source).toContain('async function readRouteVehicleId');
    expect(source).toContain("throw new RouteGroupingValidationError(['vehicle must belong to the current shop'])");
    expect(source).toContain('vehicleIdByRoute.set(route, route.vehicleId === undefined');
    expect(source).toContain('vehicleId: input.vehicleId ?? null');
  });

  test('server fills missing draft-save OSRM cache instead of relying on frontend optimized payloads', () => {
    const source = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.service.ts'), 'utf8');
    expect(source).toContain('await lockRouteGroupingDraftSave(tx, group.id)');
    expect(source).toContain('const draftOptimizations = await this.prepareDraftRouteOptimizations(input, baseline, routes)');
    expect(source).toContain('shouldPrepareDraftRouteResult(input.mode, group, route, typedAssignments)');
    expect(source).toContain('routeAssignmentsChanged(targetChild, assignments)');
    expect(source).toContain('readExactChildRouteMetricsFromRoutePlan(targetChild.routePlan, detail) === null');
    expect(source).toContain('await createDraftRouteGeometryCache(tx, targetChild.routePlanId, draftOptimization)');
    expect(source).toContain('if (route.optimized !== undefined && targetChild.routePlanId !== null)');
    expect(source).toContain('optimized: route.optimized ?? toDraftOptimizedSnapshot(draftOptimization)');
    expect(source).toContain('logIgnoredExistingRouteOptimizedPayload(group.id, targetChild.routePlanId, route.routeKey ?? null)');
    expect(source).toContain('function routeAssignmentsChanged(child: LoadedChild, assignments: LoadedAssignment[]): boolean');
    expect(source).not.toContain('logPreservedExistingRouteGeometryCache');
    expect(source).toContain('errorName: reason instanceof Error ? reason.name : typeof reason');
    expect(source).not.toContain('errorMessage: reason instanceof Error ? reason.message : String(reason)');
  });

  test('manual-order draft saves rebuild route geometry without invoking optimization', () => {
    const source = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.service.ts'), 'utf8');
    const prepareStart = source.indexOf('private async prepareDraftRouteOptimizations(');
    const prepareEnd = source.indexOf('async savePolygons(', prepareStart);
    const prepareBody = source.slice(prepareStart, prepareEnd);

    expect(prepareBody).toContain("input.mode === 'MANUAL_ORDER'");
    expect(prepareBody).toContain('const orderedAssignments = input.mode ===');
    expect(prepareBody).toContain('? assignments');
    expect(prepareBody).toContain(': orderAssignmentsByOptimizationResult');
    expect(source).toContain('function shouldPrepareDraftRouteResult(');
    expect(source).toContain("if (mode === 'MANUAL_ORDER') return shouldBuildManualDraftRouteResult(group, route, assignments)");
    expect(source).toContain('function shouldBuildManualDraftRouteResult(');
  });

  test('first global save can materialize route metrics without a re-optimize action', () => {
    const source = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.service.ts'), 'utf8');
    const saveDraftBody = source.slice(source.indexOf('async saveDraft('), source.indexOf('async savePolygons('));

    expect(saveDraftBody).toContain('await lockRouteGroupingDraftSave(tx, group.id)');
    expect(saveDraftBody).toContain('const draftOptimizations = await this.prepareDraftRouteOptimizations(input, baseline, routes)');
    expect(saveDraftBody.indexOf('const draftOptimizations = await this.prepareDraftRouteOptimizations(input, baseline, routes)'))
      .toBeLessThan(saveDraftBody.indexOf('const groupingId = await this.prisma.$transaction'));
    expect(saveDraftBody).toContain('const draftOptimization = draftOptimizations.get(route)');
    expect(saveDraftBody).toContain('const assignments = draftOptimization?.assignments');
    expect(source).toContain('if (this.routeOptimizationService === undefined) throw new RouteGroupingValidationError');
    expect(source).toContain('if (this.routeGeometryProvider === undefined) throw new RouteGroupingValidationError');
    expect(source).toContain('const routeResult = await buildChildRouteGeometry(this.routeGeometryProvider, optimizedDetail)');
    expect(source).toContain('optimizedRoutes.set(route, {');
    expect(source).toContain('&& optimized.routeGeometry !== null');
    expect(source).toContain('async function lockRouteGroupingDraftSave(tx: Tx, groupingId: string): Promise<void>');
    expect(source).toContain('function toDraftOptimizedSnapshot(route: OptimizedDraftRoute | undefined)');
  });

  test('materializes child draft rows with server-assigned routeIdx', () => {
    const source = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.service.ts'), 'utf8');
    expect(source).toContain('async function createDraftChildRoutePlan(');
    expect(source).toContain('const routeIdx = resolveNewChildRouteIdx(route.routeIdx, await nextGlobalRouteIdx(tx, group.shopId))');
    expect(source).toContain('name: newChildRouteName(route.label, routeIdx)');
    expect(source).toContain('routeIdx,');
    expect(source).toContain('routePlanId: routePlan.id');
    expect(source).toContain('snapshot: createChildSnapshot(group, input.assignments, input.driverId, routePlan.name, group.currentVersion, input.color ?? null, input.sortOrder, input.routeIdx)');
  });

  test('accepts queried routeIdx for generated new child labels', () => {
    const serverRouteIdx = 7;
    const acceptedRouteIdx = resolveNewChildRouteIdx(7, serverRouteIdx);

    expect({ name: newChildRouteName('#1', acceptedRouteIdx), routeIdx: acceptedRouteIdx }).toEqual({ name: '#7', routeIdx: 7 });
    expect(newChildRouteName(undefined, acceptedRouteIdx)).toBe('#7');
    expect(newChildRouteName(null, acceptedRouteIdx)).toBe('#7');
    expect(newChildRouteName('Downtown express', acceptedRouteIdx)).toBe('Downtown express');
  });

  test('rejects stale requested new child routeIdx', () => {
    expect(() => resolveNewChildRouteIdx(6, 7)).toThrow(RouteGroupingConflictError);
  });

  test('does not replace a single generated child route when no split exists', () => {
    const source = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.service.ts'), 'utf8');
    expect(source).toContain('if (candidates.length < 2)');
    expect(source).toContain('if (routeAssignmentGroups.length < 2) return []');
    expect(source).toContain('createDraftChildRoutePlan(tx, loaded');
    expect(source).toContain('name: `#${routeIdx}`');
  });

  test('keeps child colors and routeIdx attached when re-optimization recreates child routes', () => {
    const source = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.service.ts'), 'utf8');
    expect(source).toContain('color: readChildSnapshot(child.snapshot).color ?? null');
    expect(source).toContain('color: effectiveGroup.color ?? null');
    expect(source).toContain('const existingRouteIdx = existingChildSnapshot.routeIdx ?? await nextGlobalRouteIdx(tx, loaded.shopId)');
    expect(source).toContain('snapshot: createChildSnapshot(loaded, numberedCandidate.assignments, numberedCandidate.driverId, routePlan.name, loaded.currentVersion, numberedCandidate.color, routeIdx, routeIdx)');
  });

  test('assigns a global routeIdx when rolling back a legacy child snapshot', () => {
    const source = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.service.ts'), 'utf8');
    const rollbackBody = source.slice(source.indexOf('async rollback('), source.indexOf('private async refreshChildRouteGeometry'));

    expect(rollbackBody).toContain('const routeIdx = snapshot.routeIdx ?? await nextGlobalRouteIdx(tx, loaded.shopId)');
    expect(rollbackBody).toContain('assignments: archivedChildAssignments(loaded, child)');
    expect(rollbackBody).toContain('const canonicalSnapshot = createChildSnapshot(');
    expect(rollbackBody).toContain('snapshot: canonicalSnapshot');
  });

  test('persists global routeIdx separately from editable names', () => {
    const source = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.service.ts'), 'utf8');
    const types = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.types.ts'), 'utf8');

    expect(source).toContain('routeIdx?: number;');
    expect(source).toContain('sortOrder?: number;');
    expect(source).toContain('routeIdx: snapshot.routeIdx ?? null');
    expect(source).toContain('sortOrder: snapshot.sortOrder ?? null');
    expect(source).toContain('function nextGlobalRouteIdx');
    expect(source).not.toContain('return Math.max(max._max.sortOrder ?? 1, 1) + 1');
    expect(types).toContain('routeIdx: number | null');
    expect(types).toContain('sortOrder: number | null');
  });


  test('allocates child route indexes globally instead of per-group sort order', () => {
    const source = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.service.ts'), 'utf8');
    const types = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.types.ts'), 'utf8');

    expect(types).toContain('routeIdx: number | null');
    expect(source).toContain('routeIdx?: number;');
    expect(source).toContain('function nextGlobalRouteIdx');
    expect(source).toContain('pg_advisory_xact_lock');
    expect(source).toContain('SELECT 1 AS locked FROM lock');
    expect(source).not.toContain('await tx.$queryRaw`SELECT pg_advisory_xact_lock');
    expect(source).toContain('routeIdx: snapshot.routeIdx ?? null');
    expect(source).not.toContain('return Math.max(max._max.sortOrder ?? 1, 1) + 1');
  });

  test('keeps next route indexes globally increasing from the snapshot maximum and row count', () => {
    expect(resolveNextGlobalRouteIdx({ maxRouteIdx: null, rowCount: 0 })).toBe(1);
    expect(resolveNextGlobalRouteIdx({ maxRouteIdx: 3, rowCount: 10 })).toBe(11);
    expect(resolveNextGlobalRouteIdx({ maxRouteIdx: 17, rowCount: 10 })).toBe(18);
  });

  test('aggregates valid snapshot route indexes in PostgreSQL instead of loading every snapshot', () => {
    const source = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.service.ts'), 'utf8');
    const nextRouteIdxBody = source.slice(source.indexOf('async function nextGlobalRouteIdx'), source.indexOf('async function claimBranchOrders'));

    expect(nextRouteIdxBody).toContain('pg_advisory_xact_lock');
    expect(nextRouteIdxBody.match(/\$queryRaw/gu)).toHaveLength(2);
    expect(nextRouteIdxBody).toContain('COUNT(*)::INTEGER AS "rowCount"');
    expect(nextRouteIdxBody).toContain('MAX(');
    expect(nextRouteIdxBody).toContain('jsonb_typeof("snapshot"->\'routeIdx\') = \'number\'');
    expect(nextRouteIdxBody).toContain('trunc(("snapshot"->>\'routeIdx\')::NUMERIC)');
    expect(nextRouteIdxBody).toContain('BETWEEN -2147483648 AND 2147483647');
    expect(nextRouteIdxBody).toContain("\"snapshot\"->>'routeIdx'");
    expect(nextRouteIdxBody).toContain('WHERE "shopId" = ${shopId}::UUID');
    expect(nextRouteIdxBody).not.toContain('findMany({\n    select: { snapshot: true },\n    where: { shopId }');
    expect(nextRouteIdxBody).not.toContain('readChildSnapshot(row.snapshot)');
    expect(nextRouteIdxBody).not.toContain('routeGroupingChildVersion.aggregate');
  });

  test('keeps a new route group childless until the first route is explicitly added', () => {
    const source = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.service.ts'), 'utf8');
    const start = source.indexOf('async createGrouping(');
    const end = source.indexOf('async getGrouping(', start);
    const createGroupingBody = source.slice(start, end);

    expect(createGroupingBody).not.toContain('const routeIdx = await nextGlobalRouteIdx');
    expect(createGroupingBody).not.toContain('createDraftChildRoutePlan');
    expect(createGroupingBody).toContain('routeGroupingVersion.create');
    expect(createGroupingBody).toContain('createRouteGroupingInventory');
  });

  test('allows an order to participate in more than one route group', () => {
    const source = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.service.ts'), 'utf8');
    const validateCreateFactsBody = source.slice(
      source.indexOf('function validateCreateFacts('),
      source.indexOf('async function recomputeAssignments(', source.indexOf('function validateCreateFacts('))
    );
    const validateGenerationBody = source.slice(
      source.indexOf('function validateReadyForChildGeneration('),
      source.indexOf('function childGenerationSnapshotSignature(', source.indexOf('function validateReadyForChildGeneration('))
    );

    expect(validateCreateFactsBody).not.toContain('active route ownership');
    expect(validateCreateFactsBody).not.toContain('routePlanStops.length');
    expect(validateGenerationBody).not.toContain('externallyOwnedStops');
    expect(validateGenerationBody).not.toContain('active route ownership');
    expect(source).toContain('where: { groupingId: group.id, orderId: { in: orderIds }, shopId: group.shopId }');
    const embeddedRouteOpsSource = readFileSync(join(process.cwd(), 'src/routes/admin-commerce-connections-ui.routes.ts'), 'utf8');
    expect(embeddedRouteOpsSource).toContain('error instanceof RouteGroupingBranchLockConflictError');
    expect(embeddedRouteOpsSource).toContain('createRouteOpsHttpError(error.code, error.message, 409)');
  });

  test('keeps draft save child-only and rejects stale route indexes', () => {
    const source = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.service.ts'), 'utf8');
    const start = source.indexOf('async saveDraft(');
    const end = source.indexOf('async savePolygons(', start);
    const saveDraftBody = source.slice(start, end);

    expect(saveDraftBody).toContain('assertChildOnlyDraftRouteEnvelope(routes)');
    expect(saveDraftBody).toContain('route draft routeIdx changed; reload and retry');
    expect(saveDraftBody).toContain('routeIdx: readChildSnapshot(targetChild.snapshot).routeIdx');
    expect(saveDraftBody).not.toContain('routeGroupingBranch.create');
    expect(saveDraftBody).not.toContain('routeGroupingBranch.update');
    expect(saveDraftBody).not.toContain('routeGroupingBranchOrderLock.createMany');
    expect(saveDraftBody).not.toContain('routeBranchId');
  });

  test('persists scheduled start changes inside the global draft transaction', () => {
    const source = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.service.ts'), 'utf8');
    const saveDraftBody = source.slice(source.indexOf('async saveDraft('), source.indexOf('async savePolygons('));

    expect(saveDraftBody).toContain('route.scheduledStartAt === undefined && route.scheduledStartTimeZone === undefined');
    expect(saveDraftBody).toContain('updateRouteConstraintsSchedule(');
    expect(saveDraftBody).toContain('scheduledStartAt: route.scheduledStartAt');
    expect(saveDraftBody).toContain('scheduledStartTimeZone: route.scheduledStartTimeZone');
    expect(source).toContain('function normalizeDraftScheduledStartAt(value: string | null)');
    expect(source).toContain('function updateRouteConstraintsSchedule(');
    expect(source).toContain('scheduledStartTimeZone: readScheduledStartTimeZone(routePlan.constraints)');
  });

  test('only removes route group orders explicitly listed in removedOrderIds', () => {
    const source = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.service.ts'), 'utf8');
    const start = source.indexOf('async saveDraft(');
    const end = source.indexOf('async savePolygons(', start);
    const saveDraftBody = source.slice(start, end);

    expect(saveDraftBody).toContain("const removedOrderIds = normalizeExplicitDraftIds(input.removedOrderIds ?? [], 'removedOrderIds')");
    expect(saveDraftBody).toContain('assertDraftOrderPartition(loaded, routes, removedOrderIds)');
    expect(saveDraftBody).toContain('await deleteBranchOrderLocks(tx, group, undefined, removedOrderIds)');
    expect(saveDraftBody).toContain('await tx.routeGroupingOrder.deleteMany({ where: { groupingId: group.id, orderId: { in: removedOrderIds } } })');
    expect(saveDraftBody).toContain('addOrderIds: []');
    expect(saveDraftBody).toContain('removeOrderIds: removedOrderIds');
    expect(source).toContain('route draft orders cannot be both routed and removed');
  });

  test('adds selected orders to a ready or in-progress child route in the membership transaction', () => {
    const source = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.service.ts'), 'utf8');
    const start = source.indexOf('async updateGroupingOrders(');
    const end = source.indexOf('async previewOptimization(', start);
    const body = source.slice(start, end);

    expect(body).toContain('input.targetRoutePlanId');
    expect(body).toContain('await appendGroupingOrdersToChildRoute(tx, loaded, input.targetRoutePlanId, addOrderIds)');
    expect(body).toContain('await recomputeAssignments(tx, group.id)');
    expect(body.indexOf('await appendGroupingOrdersToChildRoute'))
      .toBeLessThan(body.indexOf('await recomputeAssignments'));
    expect(source).toContain("selected orders are already assigned to another child route");
    expect(source).toContain("targetStatus !== 'READY' && targetStatus !== 'IN_PROGRESS'");
    expect(source).toContain("orders can only be added to a Ready or in-progress child route");
    const appendBody = source.slice(
      source.indexOf('async function appendGroupingOrdersToChildRoute'),
      source.indexOf('async function rewriteRoutePlanStops')
    );
    expect(appendBody).toContain('await replaceCurrentRouteGroupingChildVersion(tx, {');
    expect(appendBody).toContain('currentChildId: targetChild.id');
    expect(appendBody).not.toContain('data: {\n      snapshot: createChildSnapshot');
  });

  test('allows additions to in-progress routes but blocks restricted membership changes before inventory sync', () => {
    const source = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.service.ts'), 'utf8');
    const types = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.types.ts'), 'utf8');
    const start = source.indexOf('async saveDraft(');
    const end = source.indexOf('async savePolygons(', start);
    const saveDraftBody = source.slice(start, end);
    const guardBody = source.slice(
      source.indexOf('function assertDraftRestrictedChildStopMembershipChanges'),
      source.indexOf('function assertDraftExpectedRevisions')
    );
    const conflict = new RouteGroupingStopMembershipConflictError(['order-1'], ['route-plan-1']);

    expect(conflict).toBeInstanceOf(RouteGroupingConflictError);
    expect(conflict.code).toBe('ROUTE_GROUPING_STOP_MEMBERSHIP_CONFLICT');
    expect(types).toContain('class RouteGroupingStopMembershipConflictError extends RouteGroupingConflictError');
    expect(saveDraftBody).toContain('assertDraftRestrictedChildStopMembershipChanges(baseline, routes, removedOrderIds)');
    expect(saveDraftBody).toContain('assertDraftRestrictedChildStopMembershipChanges(loaded, routes, removedOrderIds)');
    expect(saveDraftBody.indexOf('assertDraftRestrictedChildStopMembershipChanges(loaded, routes, removedOrderIds)'))
      .toBeLessThan(saveDraftBody.indexOf('await deleteBranchOrderLocks(tx, group, undefined, removedOrderIds)'));
    expect(saveDraftBody.indexOf('assertDraftRestrictedChildStopMembershipChanges(loaded, routes, removedOrderIds)'))
      .toBeLessThan(saveDraftBody.indexOf('await syncRouteGroupingInventoryOrders(tx, {'));
    expect(guardBody).toContain("displayStatus === 'READY'");
    expect(guardBody).toContain('sameStringSet(currentOrderIds, draftOrderIds)');
    expect(guardBody).toContain("displayStatus === 'IN_PROGRESS'");
    expect(saveDraftBody).toContain('await replaceCurrentRouteGroupingChildVersion(tx, {');
    expect(saveDraftBody).toContain('currentChildId: targetChild.id');
    expect(guardBody).toContain('currentOrderIds.every');
    expect(guardBody).toContain('removedOrderIdSet.has(orderId)');
    expect(guardBody).toContain('throw new RouteGroupingStopMembershipConflictError');
  });

  test('saves driver assignment, staged deletion, and revisions inside the draft transaction', () => {
    const source = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.service.ts'), 'utf8');
    const saveDraftBody = source.slice(source.indexOf('async saveDraft('), source.indexOf('async savePolygons('));

    expect(saveDraftBody).toContain('assertDraftBaselineUnchanged(baseline, loaded, routes, deletedRoutePlanIds)');
    expect(saveDraftBody).toContain('assertDraftExpectedRevisions(loaded, routes, deletedRoutePlanIds, input.expectedUpdatedAt)');
    expect(saveDraftBody).toContain('await readBranchDriverId(tx, group.shopId, route.driverId)');
    expect(saveDraftBody).toContain('driverId,');
    expect(saveDraftBody).toContain('await tx.routeGroupingChildVersion.delete');
    expect(saveDraftBody).toContain('await tx.routePlan.delete');
    expect(source).toContain("only Ready child routes can be deleted");
  });

  test('clears current and archived child-version route-plan refs before route-plan deletes', () => {
    const source = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.service.ts'), 'utf8');
    const deleteGroupingBody = source.slice(source.indexOf('async deleteGrouping'), source.indexOf('async listGroupings'));
    const saveDraftBody = source.slice(source.indexOf('async saveDraft('), source.indexOf('async savePolygons('));
    const clearRefsBody = source.slice(
      source.indexOf('async function clearRouteGroupingChildVersionRoutePlanRefs'),
      source.indexOf('type GroupingDateRange')
    );

    expect(deleteGroupingBody).toContain('await clearRouteGroupingChildVersionRoutePlanRefs(tx, {');
    expect(deleteGroupingBody.indexOf('await clearRouteGroupingChildVersionRoutePlanRefs(tx, {'))
      .toBeLessThan(deleteGroupingBody.indexOf('await tx.routePlan.deleteMany'));
    expect(saveDraftBody).toContain('await clearRouteGroupingChildVersionRoutePlanRefs(tx, {');
    expect(saveDraftBody.indexOf('await clearRouteGroupingChildVersionRoutePlanRefs(tx, {'))
      .toBeLessThan(saveDraftBody.indexOf('await tx.routePlan.delete({ where: { id: routePlanId } })'));
    expect(clearRefsBody).toContain('data: { routePlanId: null }');
    expect(clearRefsBody).toContain('routePlanId: { in: input.routePlanIds }');
    expect(clearRefsBody).toContain('shopId: input.shopId');
    expect(clearRefsBody).not.toContain('status');
  });

  test('uses numbered child route names before dispatch', () => {
    const source = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.service.ts'), 'utf8');
    expect(source).toContain("assignment.assignmentStatus === 'ASSIGNED' ? assignment.assignedDriverId : null");
    expect(source).toContain("assignment.assignmentStatus !== 'ASSIGNED' && assignment.assignmentStatus !== 'UNASSIGNED'");
    expect(source).toContain('name: `#${index + 1}`');
    expect(source).not.toContain('return `${group.name} — ${driverName}`');
  });

  test('hard-deletes linked inventory when deleting a route group', () => {
    const source = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.service.ts'), 'utf8');
    const deleteBody = source.slice(source.indexOf('async deleteGrouping'), source.indexOf('async listGroupings'));

    expect(deleteBody).toContain('tx.inventory.deleteMany');
    expect(deleteBody).toContain('where: { routeGroupingId: group.id, shopId: group.shopId }');
    expect(deleteBody.indexOf('tx.inventory.deleteMany')).toBeLessThan(deleteBody.indexOf('tx.routeGrouping.delete'));
  });

  test('keeps route group deletion free of child-route status blockers', () => {
    const source = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.service.ts'), 'utf8');
    expect(source).not.toContain('child route status no longer allows delete');
    expect(source).not.toContain('assertGroupingDeleteAllowed');
  });

  test('notifies only unique current route assignments after delete or release mutations', () => {
    const source = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.service.ts'), 'utf8');
    const deleteBody = source.slice(source.indexOf('async deleteGrouping'), source.indexOf('async listGroupings'));

    expect(deleteBody).toContain("child.status !== 'CURRENT' || child.supersededAt !== null");
    expect(deleteBody).toContain('dedupeDriverNotificationTargets');
    expect(source).toContain("sendRouteNotificationsBestEffort('cancelled'");
    expect(source).toContain("sendRouteNotificationsBestEffort('released'");
    expect(source).toContain('driver route notification was not sent after route mutation');
  });

  test('keeps the parent route group Ready when the legacy child publish endpoint is called', () => {
    const source = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.service.ts'), 'utf8');
    expect(source).toContain("this.prisma.routeGrouping.updateMany({ data: { status: 'READY' }");
    expect(source).toContain("where: { id: child.groupingId, status: { not: 'CANCELLED' } }");
  });

  test('keeps parent switch route on the group id, not the first child route', () => {
    const source = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.service.ts'), 'utf8');
    const types = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.types.ts'), 'utf8');

    expect(source).toContain('add(group.name, null, group.id)');
    expect(source).not.toContain('add(group.name, currentChildren.find');
    expect(types).toContain('routeGroupId?: string | null');
  });

  test('exposes fresh OSRM route geometry on current child route DTOs through the geometry cache contract', () => {
    const source = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.service.ts'), 'utf8');
    const types = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.types.ts'), 'utf8');

    expect(types).toContain('routeGeometry: RoutePlanRouteGeometry | null');
    expect(types).toContain('routeMetrics: RoutePlanRouteMetrics | null');
    expect(types).toContain('routeStopPoints: RoutePlanRouteStopPoint[]');
    expect(source).toContain('routeGeometryCaches: {');
    expect(source).toContain('select: routeGeometryCacheSummarySelect()');
    expect(source).toContain('function readChildRouteGeometry(child: LoadedChild, group: LoadedGrouping): ChildRouteGeometrySnapshot');
    expect(source).toContain('return readExactChildRouteGeometryFromRoutePlan(child.routePlan, detail)');
    expect(source).toContain('applyCachedRouteGeometry(detail, toRouteGeometrySummaryCacheRead(cache))');
    expect(source).toContain('const childRouteGeometry = readChildRouteGeometry(child, group)');
    expect(source).toContain('routeGeometry: childRouteGeometry.routeGeometry');
    expect(source).toContain('routeMetrics: childRouteMetrics');
    expect(source).toContain('routeStopPoints: childRouteGeometry.routeStopPoints');
    expect(source).toContain('routePlan: child.routePlan === null ? null : toMinimalRoutePlanSummary(child.routePlan, childRouteMetrics, assignments)');
    expect(source).toContain('const cache = caches.find((entry) => entry.shapeSignature === shapeSignature) ?? null');
    expect(source).toContain('const applied = applyCachedRouteGeometry(detail, toRouteGeometrySummaryCacheRead(cache))');
    expect(source).toContain('if (applied.routeGeometry === null) return emptyChildRouteGeometrySnapshot()');
    expect(source).toContain('routeMetrics,');
    expect(source).toContain('geometry: true,');
    expect(source).toContain('stopPoints: true');
  });

  test('exposes child route item counts from order item quantities', () => {
    const source = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.service.ts'), 'utf8');
    const groupingTypes = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.types.ts'), 'utf8');
    const routePlanTypes = readFileSync(join(process.cwd(), 'src/modules/route-plans/route-plan.types.ts'), 'utf8');

    expect(source).toContain("import { aggregateOrderItems, toOrderItemDto } from '../order-items/order-items.js'");
    expect(source).toContain('function assignmentItemCount(assignment: LoadedAssignment): number');
    expect(source).toContain('return assignmentOrderItems(assignment).reduce((sum, item) => sum + item.quantity, 0)');
    expect(source).toContain('itemCount: assignmentItemCount(order)');
    expect(source).toContain('itemSummary: routeItemSummary(assignments)');
    expect(source).toContain('itemSummary: routeItemSummary(input.assignments)');
    expect(groupingTypes).toContain('itemCount: number');
    expect(routePlanTypes).toContain('itemCount?: number');
  });

  test('fake FCM provider records string-safe route payload fields', async () => {
    const provider = new FakeDriverPushProvider();
    const result = await provider.sendRouteNotification({
      action: 'changed',
      childVersion: 2,
      devicePushToken: 'token',
      metadata: { changeRequestId: 'change-request-id', orderMessageId: 'message-id' },
      routeGroupingId: 'group',
      routePlanId: 'route'
    });
    expect(result.status).toBe('SENT');
    expect(provider.sentMessages).toHaveLength(1);
    expect(provider.sentMessages[0]?.childVersion).toBe(2);
    expect(provider.sentMessages[0]?.metadata).toEqual({ changeRequestId: 'change-request-id', orderMessageId: 'message-id' });
  });
});

function copySourceFixture(sourcePlatform: 'SHOPIFY' | 'CUSTOM') {
  return {
    branches: [],
    childVersions: [],
    createdAt: new Date('2026-08-19T11:00:00.000Z'),
    createdBy: 'source-admin',
    currentVersion: 1,
    dateRangeEnd: new Date('2026-08-20T00:00:00.000Z'),
    dateRangeStart: new Date('2026-08-19T00:00:00.000Z'),
    deliverySession: 'DAY',
    id: 'group-source',
    inventory: null,
    name: 'Source Group',
    orders: [{
      assignedDriver: null,
      assignedDriverId: null,
      assignedPolygon: null,
      assignedPolygonId: null,
      assignmentStatus: 'UNASSIGNED',
      createdAt: new Date('2026-08-19T11:00:00.000Z'),
      deliveryStop: {
        address1: '100 King St',
        address2: 'Dock 2',
        city: 'Toronto',
        countryCode: 'CA',
        deliveryDate: new Date('2026-08-19T00:00:00.000Z'),
        geocodeStatus: 'RESOLVED',
        id: 'stop-source',
        instructions: 'Use loading dock',
        latitude: 43.65,
        longitude: -79.38,
        order: {},
        orderId: 'order-source',
        phone: '+14165550100',
        postalCode: 'M5H 1J9',
        priority: 7,
        province: 'ON',
        recipientName: 'Receiving',
        routePlanStops: [],
        serviceMinutes: 12,
        shopId: 'shop-1',
        status: 'PENDING',
        timeWindowEnd: new Date('2026-08-19T16:00:00.000Z'),
        timeWindowStart: new Date('2026-08-19T14:00:00.000Z')
      },
      deliveryStopId: 'stop-source',
      groupingId: 'group-source',
      id: 'membership-source',
      order: {
        customerRouteNotifications: [],
        email: 'recipient@example.test',
        id: 'order-source',
        name: '#1001',
        orderItems: [],
        ownedRouteGroupingId: sourcePlatform === 'CUSTOM' ? 'group-source' : null,
        phone: '+14165550100',
        shopifyOrderGid: sourcePlatform === 'CUSTOM' ? 'gid://clever/CustomRouteStop/source' : 'gid://shopify/Order/1001',
        sourcePlatform
      },
      orderId: 'order-source',
      shopId: 'shop-1',
      sourceSequence: 1,
      updatedAt: new Date('2026-08-19T11:00:00.000Z')
    }],
    planDate: new Date('2026-08-19T00:00:00.000Z'),
    polygons: [],
    routeScopeKey: 'scope-1',
    serviceType: 'DELIVERY',
    shop: {},
    shopId: 'shop-1',
    status: 'READY',
    updatedAt: new Date('2026-08-19T12:00:00.000Z'),
    versions: []
  };
}

function copyTransactionHarness(source: ReturnType<typeof copySourceFixture>) {
  return {
    $queryRaw: vi.fn().mockResolvedValue([{ id: source.id }]),
    inventory: {
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({ id: 'inventory-copy' }),
      upsert: vi.fn().mockResolvedValue({ id: 'inventory-copy' })
    },
    inventoryEvent: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
    inventoryOrder: {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
      findMany: vi.fn().mockResolvedValue([])
    },
    order: {
      create: vi.fn().mockResolvedValue({ deliveryStops: [{ id: 'stop-virtual' }], id: 'order-virtual' }),
      findMany: vi.fn((input: { where: { id: { in: string[] } } }) => Promise.resolve(
        input.where.id.in.map((id) => ({ id, orderItems: [] }))
      ))
    },
    routeGrouping: {
      create: vi.fn().mockResolvedValue({ id: 'group-copy' }),
      findFirst: vi.fn().mockResolvedValue(source)
    },
    routeGroupingOrder: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
    routeGroupingVersion: { create: vi.fn().mockResolvedValue({ id: 'version-copy' }) },
    routePlan: { create: vi.fn() },
    routePlanStop: { findMany: vi.fn().mockResolvedValue([]) },
    shop: { findUnique: vi.fn().mockResolvedValue({ id: 'shop-1' }) }
  };
}

function deleteGroupingTransactionHarness(input: { ownedRouteGroupingId: string }) {
  return {
    inventory: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    order: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    routeGrouping: {
      delete: vi.fn().mockResolvedValue({ id: 'group-copy' }),
      findFirst: vi.fn().mockResolvedValue({
        childVersions: [],
        id: 'group-copy',
        orders: [{ order: { id: 'order-custom', ownedRouteGroupingId: input.ownedRouteGroupingId, sourcePlatform: 'CUSTOM' } }],
        shopId: 'shop-1'
      })
    },
    routeGroupingChildVersion: { updateMany: vi.fn() },
    routeGroupingOrder: { findMany: vi.fn().mockResolvedValue([]) },
    routePlan: { deleteMany: vi.fn() },
    routePlanStop: { deleteMany: vi.fn(), findMany: vi.fn().mockResolvedValue([]) }
  };
}
