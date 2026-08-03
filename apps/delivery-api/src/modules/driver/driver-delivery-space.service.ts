import type { PrismaClient } from '@prisma/client';
import {
  RouteGroupingConflictError,
  RouteGroupingValidationError,
  type RouteGroupingChildDto,
  type RouteGroupingDetailDto,
  type RouteGroupingDraftRouteInput,
  type RouteGroupingService
} from '../route-grouping/route-grouping.types.js';
import type { DriverRouteAccessScope } from './driver-token-access.repository.js';

export type DriverDeliveryBundle = {
  address: string;
  boxCount: number;
  conditionCodes: string[];
  destinationId: string;
  destinationName: string;
  orderCount: number;
};
export type DriverDeliverySpace = { available: DriverDeliveryBundle[]; mine: DriverDeliveryBundle[]; version: string };
export type DriverDeliverySpaceCommand = DriverRouteAccessScope & { destinationId: string; expectedVersion: string };
export type DriverDeliverySpaceCommandResult = { bundle: DriverDeliveryBundle; routePlanId: string; version: string };
export type DriverDeliverySpaceServiceContract = {
  acquire(input: DriverDeliverySpaceCommand): Promise<DriverDeliverySpaceCommandResult>;
  getSpace(input: DriverRouteAccessScope): Promise<DriverDeliverySpace>;
  release(input: DriverDeliverySpaceCommand): Promise<DriverDeliverySpaceCommandResult>;
};

type InternalBundle = DriverDeliveryBundle & { orderIds: string[] };
export type DriverDeliverySpaceRepositoryContract = {
  findRouteContext(input: Pick<DriverRouteAccessScope, 'driverId' | 'routePlanId' | 'shopId'>): Promise<{ groupingId: string; vehicleId: string | null } | null>;
  listBundleOrders(input: { orderIds: string[]; shopId: string }): Promise<Array<{
    address: string; conditionCode: string; destinationId: string; destinationName: string; orderId: string; shippedBoxes: number;
  }>>;
};
type SpacePrisma = Pick<PrismaClient, 'dsvDispatchImportRow' | 'routeGroupingChildVersion'>;

export class PrismaDriverDeliverySpaceRepository implements DriverDeliverySpaceRepositoryContract {
  constructor(private readonly prisma: SpacePrisma) {}
  async findRouteContext(input: Pick<DriverRouteAccessScope, 'driverId' | 'routePlanId' | 'shopId'>) {
    const child = await this.prisma.routeGroupingChildVersion.findFirst({
      select: { groupingId: true, routePlan: { select: { vehicleId: true } } },
      where: {
        driverId: input.driverId,
        routePlanId: input.routePlanId,
        shopId: input.shopId,
        status: 'CURRENT'
      }
    });
    return child?.routePlan === null || child === null ? null : { groupingId: child.groupingId, vehicleId: child.routePlan.vehicleId };
  }
  async listBundleOrders(input: { orderIds: string[]; shopId: string }) {
    const rows = await this.prisma.dsvDispatchImportRow.findMany({
      orderBy: { createdAt: 'desc' },
      select: { address: true, conditionCode: true, destinationId: true, destinationName: true, sellerOrderId: true, shippedBoxes: true },
      where: { destinationId: { not: null }, sellerOrderId: { in: input.orderIds }, shopId: input.shopId, status: 'APPLIED' }
    });
    const seen = new Set<string>();
    return rows.flatMap((row) => {
      if (row.destinationId === null || row.sellerOrderId === null || seen.has(row.sellerOrderId)) return [];
      seen.add(row.sellerOrderId);
      return [{ address: row.address, conditionCode: row.conditionCode, destinationId: row.destinationId, destinationName: row.destinationName, orderId: row.sellerOrderId, shippedBoxes: row.shippedBoxes }];
    });
  }
}

export class DriverDeliverySpaceError extends Error {
  constructor(readonly code:
    | 'DESTINATION_BUNDLE_ALREADY_ACQUIRED' | 'DESTINATION_BUNDLE_ASSIGNMENT_CHANGED' | 'DESTINATION_BUNDLE_NOT_FOUND'
    | 'DESTINATION_BUNDLE_ROUTE_RECALCULATION_FAILED' | 'DESTINATION_BUNDLE_ROUTE_RECALCULATION_UNAVAILABLE'
    | 'DESTINATION_BUNDLE_ROUTE_SCOPE_REJECTED' | 'DESTINATION_BUNDLE_TARGET_VEHICLE_REQUIRED'
    | 'DESTINATION_BUNDLE_TRANSFER_CLOSED', message: string) {
    super(message);
    this.name = 'DriverDeliverySpaceError';
  }
}

export class DriverDeliverySpaceService implements DriverDeliverySpaceServiceContract {
  constructor(private readonly repository: DriverDeliverySpaceRepositoryContract, private readonly groupingService: RouteGroupingService) {}
  async getSpace(input: DriverRouteAccessScope): Promise<DriverDeliverySpace> {
    const { grouping } = await this.context(input);
    const bundles = await this.bundles(grouping, input.shopId);
    const mine = driverRoute(grouping, input);
    const availableIds = new Set(grouping.children.filter(isAvailable).flatMap((route) => route.orderIds));
    return {
      available: bundles.filter((bundle) => bundle.orderIds.every((id) => availableIds.has(id))).map(expose),
      mine: bundles.filter((bundle) => bundle.orderIds.every((id) => mine.orderIds.includes(id))).map(expose),
      version: grouping.updatedAt
    };
  }
  async release(input: DriverDeliverySpaceCommand): Promise<DriverDeliverySpaceCommandResult> {
    const { grouping } = await this.context(input);
    const bundle = await this.bundle(grouping, input.shopId, input.destinationId);
    const source = owner(grouping, bundle.orderIds);
    if (source.driverId !== input.driverId || source.routePlanId !== input.routePlanId) throw error('DESTINATION_BUNDLE_ROUTE_SCOPE_REJECTED', '내 배송지만 반납할 수 있습니다.');
    assertOpen(source);
    const target = grouping.children.filter(isAvailable).sort(bySort)[0];
    const saved = await this.save(grouping, target === undefined ? releaseNew(grouping, bundle.orderIds, source) : move(grouping, bundle.orderIds, source, target), input);
    const next = owner(saved, bundle.orderIds);
    if (next.driverId !== null || next.routePlanId === null) throw error('DESTINATION_BUNDLE_ASSIGNMENT_CHANGED', '배송 반납 결과를 확인할 수 없습니다.');
    return { bundle: expose(bundle), routePlanId: next.routePlanId, version: saved.updatedAt };
  }
  async acquire(input: DriverDeliverySpaceCommand): Promise<DriverDeliverySpaceCommandResult> {
    const { context, grouping } = await this.context(input);
    if (context.vehicleId === null) throw error('DESTINATION_BUNDLE_TARGET_VEHICLE_REQUIRED', '차량이 연결된 경로에서만 배송을 가져올 수 있습니다.');
    const bundle = await this.bundle(grouping, input.shopId, input.destinationId);
    const source = owner(grouping, bundle.orderIds);
    if (source.driverId !== null) throw error('DESTINATION_BUNDLE_ALREADY_ACQUIRED', '다른 배송원이 먼저 가져간 배송입니다.');
    if (!isAvailable(source)) throw error('DESTINATION_BUNDLE_ASSIGNMENT_CHANGED', '공용 배송 상태가 변경되었습니다.');
    const target = driverRoute(grouping, input);
    assertOpen(source); assertOpen(target);
    try {
      const saved = await this.save(grouping, move(grouping, bundle.orderIds, source, target), input);
      const next = owner(saved, bundle.orderIds);
      if (next.driverId !== input.driverId || next.routePlanId !== input.routePlanId) throw error('DESTINATION_BUNDLE_ASSIGNMENT_CHANGED', '배송 확보 결과를 확인할 수 없습니다.');
      return { bundle: expose(bundle), routePlanId: next.routePlanId, version: saved.updatedAt };
    } catch (cause) {
      if (!(cause instanceof DriverDeliverySpaceError) || cause.code !== 'DESTINATION_BUNDLE_ASSIGNMENT_CHANGED') throw cause;
      const latest = await this.groupingService.getGrouping({ groupingId: grouping.id, shopDomain: input.shopDomain });
      const next = latest === null ? null : findOwner(latest, bundle.orderIds);
      if (next?.driverId !== null && next?.driverId !== undefined) throw error('DESTINATION_BUNDLE_ALREADY_ACQUIRED', '다른 배송원이 먼저 가져간 배송입니다.');
      throw cause;
    }
  }
  private async context(input: DriverRouteAccessScope) {
    const context = await this.repository.findRouteContext(input);
    if (context === null) throw error('DESTINATION_BUNDLE_ROUTE_SCOPE_REJECTED', '현재 배송 경로를 확인할 수 없습니다.');
    const grouping = await this.groupingService.getGrouping({ groupingId: context.groupingId, shopDomain: input.shopDomain });
    if (grouping === null) throw error('DESTINATION_BUNDLE_NOT_FOUND', '현재 배송 그룹을 찾을 수 없습니다.');
    if (grouping.children.some((route) => route.routePlanId === null)) throw error('DESTINATION_BUNDLE_ASSIGNMENT_CHANGED', '목록을 새로고침해 주세요.');
    driverRoute(grouping, input);
    return { context, grouping };
  }
  private async bundles(grouping: RouteGroupingDetailDto, shopId: string): Promise<InternalBundle[]> {
    const rows = await this.repository.listBundleOrders({ orderIds: grouping.assignments.map((item) => item.orderId), shopId });
    const grouped = new Map<string, typeof rows>();
    for (const row of rows) grouped.set(row.destinationId, [...(grouped.get(row.destinationId) ?? []), row]);
    return [...grouped.entries()].map(([destinationId, items]) => {
      const first = items[0];
      if (first === undefined) throw error('DESTINATION_BUNDLE_NOT_FOUND', '배송지 묶음이 비어 있습니다.');
      return { address: first.address, boxCount: items.reduce((sum, item) => sum + item.shippedBoxes, 0), conditionCodes: [...new Set(items.map((item) => item.conditionCode))].sort(), destinationId, destinationName: first.destinationName, orderCount: items.length, orderIds: items.map((item) => item.orderId) };
    });
  }
  private async bundle(grouping: RouteGroupingDetailDto, shopId: string, destinationId: string) {
    const found = (await this.bundles(grouping, shopId)).find((item) => item.destinationId === destinationId);
    if (found === undefined) throw error('DESTINATION_BUNDLE_NOT_FOUND', '배송지 묶음을 찾을 수 없습니다.');
    return found;
  }
  private async save(grouping: RouteGroupingDetailDto, routes: RouteGroupingDraftRouteInput[], input: DriverDeliverySpaceCommand) {
    try {
      const saved = await this.groupingService.saveDraft({ expectedUpdatedAt: input.expectedVersion, groupingId: grouping.id, routes, shopDomain: input.shopDomain });
      if (saved === null) throw error('DESTINATION_BUNDLE_NOT_FOUND', '배송 그룹을 찾을 수 없습니다.');
      return saved;
    } catch (cause) {
      if (cause instanceof RouteGroupingConflictError) throw error('DESTINATION_BUNDLE_ASSIGNMENT_CHANGED', '배송 배정이 변경되었습니다.');
      if (cause instanceof RouteGroupingValidationError) {
        const unavailable = cause.blockers.some((blocker) => blocker.includes('not configured'));
        throw error(unavailable ? 'DESTINATION_BUNDLE_ROUTE_RECALCULATION_UNAVAILABLE' : 'DESTINATION_BUNDLE_ROUTE_RECALCULATION_FAILED', unavailable ? '경로 재계산 서비스에 연결할 수 없습니다.' : '변경된 배송 경로를 계산하지 못했습니다.');
      }
      throw cause;
    }
  }
}

function expose(bundle: InternalBundle): DriverDeliveryBundle {
  return {
    address: bundle.address,
    boxCount: bundle.boxCount,
    conditionCodes: bundle.conditionCodes,
    destinationId: bundle.destinationId,
    destinationName: bundle.destinationName,
    orderCount: bundle.orderCount
  };
}
function driverRoute(grouping: RouteGroupingDetailDto, input: Pick<DriverRouteAccessScope, 'driverId' | 'routePlanId'>) { const route = grouping.children.find((item) => item.routePlanId === input.routePlanId); if (route === undefined || route.driverId !== input.driverId) throw error('DESTINATION_BUNDLE_ROUTE_SCOPE_REJECTED', '현재 배송 경로에 접근할 수 없습니다.'); return route; }
function findOwner(grouping: RouteGroupingDetailDto, ids: string[]) { const routes = grouping.children.filter((route) => ids.some((id) => route.orderIds.includes(id))); return routes.length === 1 && ids.every((id) => routes[0]?.orderIds.includes(id)) ? routes[0] ?? null : null; }
function owner(grouping: RouteGroupingDetailDto, ids: string[]) { const route = findOwner(grouping, ids); if (route === null) throw error('DESTINATION_BUNDLE_ASSIGNMENT_CHANGED', '배송지 묶음 배정이 분리되어 있습니다.'); return route; }
function isAvailable(route: RouteGroupingChildDto) { return route.driverId === null && route.displayStatus === 'READY' && route.routePlanId !== null; }
function bySort(a: RouteGroupingChildDto, b: RouteGroupingChildDto) { return (a.sortOrder ?? 999999) - (b.sortOrder ?? 999999); }
function assertOpen(route: RouteGroupingChildDto) { if (route.displayStatus !== 'READY') throw error('DESTINATION_BUNDLE_TRANSFER_CLOSED', '배송 시작 후에는 변경할 수 없습니다.'); }
function move(grouping: RouteGroupingDetailDto, ids: string[], source: RouteGroupingChildDto, target: RouteGroupingChildDto) { const moved = new Set(ids); return grouping.children.map((route) => route.routePlanId === source.routePlanId ? draft(route, route.orderIds.filter((id) => !moved.has(id))) : route.routePlanId === target.routePlanId ? draft(route, [...route.orderIds, ...ids]) : draft(route, route.orderIds)); }
function releaseNew(grouping: RouteGroupingDetailDto, ids: string[], source: RouteGroupingChildDto): RouteGroupingDraftRouteInput[] { const moved = new Set(ids); return [...grouping.children.map((route) => draft(route, route.routePlanId === source.routePlanId ? route.orderIds.filter((id) => !moved.has(id)) : route.orderIds)), { branchId: null, driverId: null, label: '공용 배송', orderIds: ids, routePlanId: null, sortOrder: grouping.children.reduce((max, route) => Math.max(max, route.sortOrder ?? 0), 0) + 1, tempId: 'driver-delivery-space' }]; }
function draft(route: RouteGroupingChildDto, orderIds: string[]): RouteGroupingDraftRouteInput { return { branchId: null, color: route.color, driverId: route.driverId, expectedChildUpdatedAt: route.updatedAt, ...(route.routePlan?.updatedAt === undefined ? {} : { expectedRoutePlanUpdatedAt: route.routePlan.updatedAt }), orderIds, ...(route.routeIdx === null ? {} : { routeIdx: route.routeIdx }), routePlanId: route.routePlanId, ...(route.sortOrder === null ? {} : { sortOrder: route.sortOrder }) }; }
function error(code: DriverDeliverySpaceError['code'], message: string) { return new DriverDeliverySpaceError(code, message); }
