import { PrismaDsvDispatchImportService } from '../src/modules/dsv/dsv-dispatch-import.service.js';
import { PrismaDsvResourceService } from '../src/modules/dsv/dsv-resource.service.js';
import type { Prisma } from '@prisma/client';
import { describe, expect, test, vi } from 'vitest';
import { dsvReviewedTestExclusions as excluded } from '../src/modules/dsv/dsv-reviewed-test-exclusions.js';
import {
  hasDsvTestExclusions, visibleDsvOrderWhere, visibleDsvRouteWhere,
  visibleDsvVehicleWhere, visibleDsvOrderCountSql, projectVisibleDsvGrouping,
} from '../src/modules/dsv/dsv-test-visibility.js';
import { PrismaDsvV1ReadQueryService } from '../src/modules/dsv/dsv-v1-read-query.service.js';
import { PrismaDsvStoreReviewAccess } from '../src/modules/dsv/dsv-store-review-access.js';
import { createDsvAdminPrincipal, dsvOperatorScopes, DsvForbiddenError } from '../src/modules/dsv/dsv-principal.js';
import { PrismaDriverProofMediaRepository } from '../src/modules/driver/driver-proof-media.repository.js';
import { toCanonicalOrderWhere } from '../src/modules/shopify/order-sync.repository.js';
import type { RouteGroupingDetailDto } from '../src/modules/route-grouping/route-grouping.types.js';

const developer = createDsvAdminPrincipal({ shopId: excluded.shopId });
const operator = createDsvAdminPrincipal({ shopId: excluded.shopId, scopes: dsvOperatorScopes });
const customer = { principalType: 'CUSTOMER_USER' as const, customerId: 'formal-customer', shopId: excluded.shopId, scopes: ['dsv:customer-deliveries:read' as const] };

describe('reviewed DSV presentation exclusions', () => {
  test('scope and exact root IDs are fixed; removed records and other tenants are outside this policy', () => {
    expect(excluded.sellerOrderIds).toHaveLength(90);
    expect(new Set(excluded.sellerOrderIds).size).toBe(90);
    expect(excluded.routePlanIds).toHaveLength(7);
    expect(excluded.vehicleIds).toHaveLength(2);
    expect(excluded.routePlanIds).not.toContain('f283d11b-a55d-40cb-a31d-08ed64e46faf');
    expect(excluded.vehicleIds).not.toContain('02474c14-da85-4c17-847f-2fd1d34ad18a');
    expect(hasDsvTestExclusions({ appId: 'clever', shopDomain: ' DSV-DEMO.LOCAL ' })).toBe(true);
    expect(hasDsvTestExclusions({ appId: 'other', shopDomain: excluded.shopDomain })).toBe(false);
    for (const scope of ['kfood', 'meatbox', { appId: 'clever', shopDomain: 'formal.example' }]) {
      expect(visibleDsvOrderWhere(scope)).toEqual({});
      expect(visibleDsvRouteWhere(scope)).toEqual({});
      expect(visibleDsvVehicleWhere(scope)).toEqual({});
    }
    expect(visibleDsvOrderCountSql('kfood').values).toEqual([]);
    expect(visibleDsvOrderCountSql(excluded.shopId).values).toEqual([...excluded.sellerOrderIds]);
    expect(visibleDsvOrderCountSql(excluded.shopId).text).not.toContain(excluded.sellerOrderIds[0]);
  });

  test.each([developer, operator, customer])('direct excluded references are blocked for $principalType regardless of scopes', async principal => {
    const access = new PrismaDsvStoreReviewAccess({} as never);
    await expect(access.assertAccessible(principal, { orderIds: [excluded.sellerOrderIds[0]] })).rejects.toBeInstanceOf(DsvForbiddenError);
    await expect(access.assertAccessible(principal, { routePlanIds: [excluded.routePlanIds[0]] })).rejects.toBeInstanceOf(DsvForbiddenError);
  });

  test('canonical list/search/facet/map counts share the database predicate before paging', () => {
    for (const filters of [{}, { search: 'formal' }, { deliveryState: 'planned' as const }]) {
      const query = toCanonicalOrderWhere(excluded.shopId, filters);
      expect(query.AND).toEqual(expect.arrayContaining([visibleDsvOrderWhere(excluded.shopId)]));
      expect(JSON.stringify(toCanonicalOrderWhere('kfood', filters))).not.toContain(excluded.sellerOrderIds[0]);
    }
  });

  test('v1 list, control, records and raw customer counts apply the same IDs for operator and developer', async () => {
    const orderFind = vi.fn().mockResolvedValue([]);
    const stopFind = vi.fn().mockResolvedValue([]);
    const stopCount = vi.fn().mockResolvedValue(0);
    const vehicleFind = vi.fn().mockResolvedValue([]);
    const sql = vi.fn<(query: Prisma.Sql) => Promise<unknown[]>>().mockResolvedValue([]);
    const service = new PrismaDsvV1ReadQueryService({
      order: { findMany: orderFind }, deliveryStop: { findMany: stopFind, count: stopCount },
      vehicle: { findMany: vehicleFind }, $queryRaw: sql,
      commerceConnection: { findMany: vi.fn().mockResolvedValue([]) },
    } as never);
    for (const principal of [developer, operator]) {
      await service.listDispatches(principal, { serviceDate: '2026-07-23', limit: 1 });
      await service.listControl(principal, { serviceDate: '2026-07-23' });
      await service.listRecords(principal, { serviceDate: '2026-07-23', limit: 1 });
      await service.listVehicles(principal, { limit: 1 });
      await service.listCustomers(principal, { limit: 1 });
    }
    for (const [query] of orderFind.mock.calls) expect(query).toMatchObject({ where: visibleDsvOrderWhere(excluded.shopId) });
    for (const fn of [stopFind, stopCount]) for (const [query] of fn.mock.calls) expect(query).toMatchObject({ where: { order: visibleDsvOrderWhere(excluded.shopId) } });
    for (const [query] of vehicleFind.mock.calls) expect(query).toMatchObject({ take: 2, where: visibleDsvVehicleWhere(excluded.shopId) });
    for (const [query] of sql.mock.calls) expect(query.values).toEqual(expect.arrayContaining([...excluded.sellerOrderIds]));
  });

  test('legacy resources keep driver accounts while excluding vehicle and assignment candidates', async () => {
    const driverFind = vi.fn().mockResolvedValue([]);
    const vehicleFind = vi.fn().mockResolvedValue([]);
    const assignmentFind = vi.fn().mockResolvedValue([]);
    const service = new PrismaDsvResourceService({
      shop: { findUnique: vi.fn().mockResolvedValue({ id: excluded.shopId }) },
      driver: { findMany: driverFind }, vehicle: { findMany: vehicleFind },
      dsvVehicleDriverAssignment: { findMany: assignmentFind },
    } as never);
    await service.list({ principal: developer, shopDomain: excluded.shopDomain });
    expect(driverFind).toHaveBeenCalledWith(expect.objectContaining({ where: { dsvProfile: { isNot: null }, shopId: excluded.shopId, isStoreReviewData: false } }));
    expect(vehicleFind).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining(visibleDsvVehicleWhere(excluded.shopId)) as unknown }));
    expect(assignmentFind).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ NOT: { vehicleId: { in: [...excluded.vehicleIds] } } }) as unknown }));
  });

  test('mixed original upload responses preserve formal and unlinked rows and omit only reviewed order rows', async () => {
    const row = (sellerOrderId: string | null) => ({ sellerOrderId, sellerOrderKey: sellerOrderId ?? 'unlinked', rowNumber: 1,
      address: '', conditionCode: '', customerCode: '', destinationName: '', driverId: null, driverName: '', issues: [],
      latitude: null, longitude: null, notes: null, shippedBoxes: 1, status: 'APPLIED', vehicleId: null, vehiclePlate: '' });
    const original = { id: 'mixed-import', fileName: 'original.csv', createdAt: new Date(), planDate: new Date(), rowCount: 3, status: 'APPLIED',
      rows: [row(excluded.sellerOrderIds[0]), row('formal-order'), row(null)] };
    const saved = structuredClone(original);
    const findFirst = vi.fn().mockResolvedValue(original);
    const service = new PrismaDsvDispatchImportService({ shop: { findUnique: vi.fn().mockResolvedValue({ id: excluded.shopId }) }, dsvDispatchImport: { findFirst } } as never);
    const view = await service.getImport({ importId: 'mixed-import', shopDomain: excluded.shopDomain });
    expect(view).toMatchObject({ rowCount: 2, rows: [{ sellerOrderId: 'formal-order' }, { sellerOrderId: null }] });
    expect(original).toEqual(saved);
    findFirst.mockResolvedValue({ ...original, rows: [row(excluded.sellerOrderIds[0])] });
    expect(await service.getImport({ importId: 'mixed-import', shopDomain: excluded.shopDomain })).toBeNull();
  });

  test('mixed groups preserve formal rows and remove nested test references without changing mutation authority', () => {
    const hiddenOrder = excluded.sellerOrderIds[0];
    const hiddenRoute = excluded.routePlanIds[0];
    const group = {
      id: 'shared-group', status: 'READY', totalOrders: 87, unresolvedOrders: 0,
      children: [
        { routePlanId: 'formal-route', stopsCount: 86, displayStatus: 'READY' },
        { routePlanId: hiddenRoute, stopsCount: 1, displayStatus: 'IN_PROGRESS' },
      ],
      assignments: [...Array.from({ length: 86 }, (_, i) => ({ orderId: `formal-${i}`, assignmentStatus: 'ASSIGNED' })), { orderId: hiddenOrder, assignmentStatus: 'ASSIGNED' }],
      branches: [{ orderIds: ['formal-0', hiddenOrder], ordersCount: 2, optimized: { orderIds: ['formal-0', hiddenOrder] } }],
      warningState: [{ code: 'DRIVER_ASSIGNED', orderIds: [hiddenOrder], routePlanIds: [hiddenRoute] }],
      switchRoutes: [{ routePlanId: hiddenRoute }, { routePlanId: 'formal-route' }],
    } as unknown as RouteGroupingDetailDto;
    const original = structuredClone(group);
    const projected = projectVisibleDsvGrouping(excluded.shopId, group);
    expect(projected).toMatchObject({ totalOrders: 86, displayStatus: 'READY', warningState: [], branches: [{ orderIds: ['formal-0'], ordersCount: 1, optimized: null }] });
    expect(JSON.stringify(projected)).not.toContain(hiddenRoute);
    expect(JSON.stringify(projected)).not.toContain(hiddenOrder);
    expect(group).toEqual(original);
    expect(projectVisibleDsvGrouping('kfood', group)).toBe(group);
    expect(projectVisibleDsvGrouping(excluded.shopId, { ...group, totalOrders: 1, children: [group.children[1]!] })).toBeNull();
  });

  test('excluded proof cannot issue a storage read URL or perform any storage write', async () => {
    const createReadAccess = vi.fn();
    const findFirst = vi.fn().mockResolvedValue(null);
    const repository = new PrismaDriverProofMediaRepository({ driverProofMedia: { findFirst } } as never,
      { storage: { write: vi.fn(), remove: vi.fn(), createReadAccess } });
    await expect(repository.createAdminProofMediaReadAccess({ shopId: excluded.shopId, mediaId: 'reviewed-proof' })).rejects.toThrow();
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ OR: expect.any(Array) as unknown }) as unknown }));
    expect(createReadAccess).not.toHaveBeenCalled();
  });
});
