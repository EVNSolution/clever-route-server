import type { PrismaClient } from '@prisma/client';

import {
  DsvAssignmentCommandError,
  type DsvAssignmentCommandService
} from '../dsv/dsv-assignment-command.service.js';
import {
  RouteGroupingValidationError,
  type RouteGroupingService
} from '../route-grouping/route-grouping.types.js';
import type { DriverRouteAccessScope } from './driver-token-access.repository.js';
import { driverServiceDate } from './driver-route-timezone.js';

export type DriverDeliveryBundle = {
  address: string;
  boxCount: number;
  conditionCodes: string[];
  destinationId: string;
  destinationName: string;
  orderCount: number;
};

export type DriverDeliveryRecipient = {
  driverId: string;
  driverName: string;
};

export type DriverDeliverySpace = {
  available: DriverDeliveryBundle[];
  mine: DriverDeliveryBundle[];
  recipients: DriverDeliveryRecipient[];
  version: string;
};

export type DriverDeliverySpaceCommand = DriverRouteAccessScope & {
  destinationId: string;
  expectedVersion: string;
};

export type DriverDeliverySpaceCommandResult = {
  bundle: DriverDeliveryBundle;
  routePlanId: string | null;
  version: string;
};

export type DriverDeliverySpaceTransferCommand = DriverDeliverySpaceCommand & {
  targetDriverId: string;
};

export type DriverDeliverySpaceServiceContract = {
  acquire(input: DriverDeliverySpaceCommand): Promise<DriverDeliverySpaceCommandResult>;
  getSpace(input: DriverRouteAccessScope): Promise<DriverDeliverySpace>;
  release(input: DriverDeliverySpaceCommand): Promise<DriverDeliverySpaceCommandResult>;
  transfer(input: DriverDeliverySpaceTransferCommand): Promise<DriverDeliverySpaceCommandResult>;
};

type BundleOrder = {
  address: string;
  conditionCode: string;
  currentRouteVersionId: string;
  destinationId: string;
  destinationName: string;
  driverId: string | null;
  orderId: string;
  routePlanId: string | null;
  shippedBoxes: number;
};

type InternalBundle = DriverDeliveryBundle & { orders: BundleOrder[] };
type InternalRecipient = DriverDeliveryRecipient & { routePlanId: string };

export type DriverDeliverySpaceRepositoryContract = {
  findRouteContext(input: Pick<DriverRouteAccessScope, 'driverId' | 'routePlanId' | 'shopId'>): Promise<{
    groupingId: string;
  } | null>;
  listBundleOrders(input: { groupingId: string; shopId: string }): Promise<BundleOrder[]>;
};

type SpacePrisma = Pick<PrismaClient, 'dsvDispatchImportRow' | 'routeGroupingChildVersion'>;
type AssignmentCommands = Pick<DsvAssignmentCommandService, 'reassignMany' | 'unassignMany'>;

export class PrismaDriverDeliverySpaceRepository implements DriverDeliverySpaceRepositoryContract {
  constructor(private readonly prisma: SpacePrisma) {}

  async findRouteContext(input: Pick<DriverRouteAccessScope, 'driverId' | 'routePlanId' | 'shopId'>) {
    const child = await this.prisma.routeGroupingChildVersion.findFirst({
      select: { groupingId: true },
      where: {
        driverId: input.driverId,
        routePlanId: input.routePlanId,
        shopId: input.shopId,
        status: 'CURRENT'
      }
    });
    return child === null ? null : { groupingId: child.groupingId };
  }

  async listBundleOrders(input: { groupingId: string; shopId: string }): Promise<BundleOrder[]> {
    const rows = await this.prisma.dsvDispatchImportRow.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        address: true,
        conditionCode: true,
        destinationId: true,
        destinationName: true,
        sellerOrder: {
          select: {
            currentRouteVersion: {
              select: { driverId: true, groupingId: true, routePlanId: true, status: true, supersededAt: true }
            },
            currentRouteVersionId: true,
            id: true
          }
        },
        shippedBoxes: true
      },
      where: {
        destinationId: { not: null },
        sellerOrder: { currentRouteVersion: { groupingId: input.groupingId, status: 'CURRENT', supersededAt: null } },
        shopId: input.shopId,
        status: 'APPLIED'
      }
    });

    const seen = new Set<string>();
    return rows.flatMap((row) => {
      const order = row.sellerOrder;
      const route = order?.currentRouteVersion;
      if (
        row.destinationId === null ||
        order === null ||
        order.currentRouteVersionId === null ||
        route === null ||
        route === undefined ||
        route.groupingId !== input.groupingId ||
        route.status !== 'CURRENT' ||
        route.supersededAt !== null ||
        seen.has(order.id)
      ) return [];

      seen.add(order.id);
      return [{
        address: row.address,
        conditionCode: row.conditionCode,
        currentRouteVersionId: order.currentRouteVersionId,
        destinationId: row.destinationId,
        destinationName: row.destinationName,
        driverId: route.driverId,
        orderId: order.id,
        routePlanId: route.routePlanId,
        shippedBoxes: row.shippedBoxes
      }];
    });
  }
}

export class DriverDeliverySpaceError extends Error {
  constructor(readonly code:
    | 'DESTINATION_BUNDLE_ALREADY_ACQUIRED'
    | 'DESTINATION_BUNDLE_ASSIGNMENT_CHANGED'
    | 'DESTINATION_BUNDLE_NOT_FOUND'
    | 'DESTINATION_BUNDLE_ROUTE_RECALCULATION_FAILED'
    | 'DESTINATION_BUNDLE_ROUTE_RECALCULATION_UNAVAILABLE'
    | 'DESTINATION_BUNDLE_ROUTE_SCOPE_REJECTED'
    | 'DESTINATION_BUNDLE_TARGET_VEHICLE_REQUIRED'
    | 'DESTINATION_BUNDLE_TRANSFER_CLOSED', message: string) {
    super(message);
    this.name = 'DriverDeliverySpaceError';
  }
}

export class DriverDeliverySpaceService implements DriverDeliverySpaceServiceContract {
  constructor(
    private readonly repository: DriverDeliverySpaceRepositoryContract,
    private readonly groupingService: RouteGroupingService,
    private readonly assignmentCommands: AssignmentCommands,
    private readonly now: () => Date = () => new Date()
  ) {}

  async getSpace(input: DriverRouteAccessScope): Promise<DriverDeliverySpace> {
    const { bundles, grouping } = await this.context(input);
    const visibleBundles = isToday(grouping.planDate, this.now()) ? bundles : [];
    return {
      available: visibleBundles.filter(isAvailable).map(expose),
      mine: visibleBundles.filter((bundle) => isMine(bundle, input)).map(expose),
      recipients: isToday(grouping.planDate, this.now())
        ? deliveryRecipients(grouping.children, input.driverId).map(({ driverId, driverName }) => ({ driverId, driverName }))
        : [],
      version: grouping.updatedAt
    };
  }

  async release(input: DriverDeliverySpaceCommand): Promise<DriverDeliverySpaceCommandResult> {
    const { bundles, grouping } = await this.context(input);
    assertToday(grouping.planDate, this.now());
    assertVersion(grouping.updatedAt, input.expectedVersion);
    const bundle = requireBundle(bundles, input.destinationId);
    if (!isMine(bundle, input)) {
      throw error('DESTINATION_BUNDLE_ROUTE_SCOPE_REJECTED', '내 배송지만 반납할 수 있습니다.');
    }

    const result = await this.runCommand(() => this.assignmentCommands.unassignMany({
      actor: { actorId: input.driverId, actorType: 'DRIVER', principalType: 'DRIVER' },
      items: bundle.orders.map((order) => ({
        commandId: commandId('release', input, order.orderId),
        expectedVersion: order.currentRouteVersionId,
        sellerOrderId: order.orderId
      })),
      reason: 'DRIVER_DESTINATION_BUNDLE_RELEASE',
      shopDomain: input.shopDomain
    }));
    const version = await this.latestVersion(input);
    return { bundle: expose(bundle), routePlanId: result.routePlanId, version };
  }

  async acquire(input: DriverDeliverySpaceCommand): Promise<DriverDeliverySpaceCommandResult> {
    const { bundles, grouping } = await this.context(input);
    assertToday(grouping.planDate, this.now());
    assertVersion(grouping.updatedAt, input.expectedVersion);
    const bundle = requireBundle(bundles, input.destinationId);
    if (!isAvailable(bundle)) {
      const ownedByAnotherDriver = bundle.orders.some((order) => order.driverId !== null && order.driverId !== input.driverId);
      throw error(
        ownedByAnotherDriver ? 'DESTINATION_BUNDLE_ALREADY_ACQUIRED' : 'DESTINATION_BUNDLE_ASSIGNMENT_CHANGED',
        ownedByAnotherDriver ? '다른 배송원이 먼저 가져간 배송입니다.' : '공용 배송 상태가 변경되었습니다.'
      );
    }

    const result = await this.runCommand(() => this.assignmentCommands.reassignMany({
      actor: { actorId: input.driverId, actorType: 'DRIVER', principalType: 'DRIVER' },
      items: bundle.orders.map((order) => ({
        commandId: commandId('acquire', input, order.orderId),
        expectedVersion: order.currentRouteVersionId,
        sellerOrderId: order.orderId
      })),
      reason: 'DRIVER_DESTINATION_BUNDLE_ACQUIRE',
      shopDomain: input.shopDomain,
      targetDriverId: input.driverId,
      targetRoutePlanId: input.routePlanId
    }));
    const version = await this.latestVersion(input);
    return { bundle: expose(bundle), routePlanId: result.routePlanId, version };
  }

  async transfer(input: DriverDeliverySpaceTransferCommand): Promise<DriverDeliverySpaceCommandResult> {
    const { bundles, grouping } = await this.context(input);
    assertToday(grouping.planDate, this.now());
    assertVersion(grouping.updatedAt, input.expectedVersion);
    const bundle = requireBundle(bundles, input.destinationId);
    if (!isMine(bundle, input)) {
      throw error('DESTINATION_BUNDLE_ROUTE_SCOPE_REJECTED', '내 배송지만 전달할 수 있습니다.');
    }
    const recipient = deliveryRecipients(grouping.children, input.driverId)
      .find((candidate) => candidate.driverId === input.targetDriverId);
    if (recipient === undefined) {
      throw error('DESTINATION_BUNDLE_ROUTE_SCOPE_REJECTED', '현재 배차의 다른 배송원에게만 전달할 수 있습니다.');
    }

    const result = await this.runCommand(() => this.assignmentCommands.reassignMany({
      actor: { actorId: input.driverId, actorType: 'DRIVER', principalType: 'DRIVER' },
      items: bundle.orders.map((order) => ({
        commandId: `driver-delivery-space:transfer:${input.destinationId}:${order.orderId}:${input.targetDriverId}:${input.expectedVersion}`,
        expectedVersion: order.currentRouteVersionId,
        sellerOrderId: order.orderId
      })),
      reason: 'DRIVER_DESTINATION_BUNDLE_TRANSFER',
      shopDomain: input.shopDomain,
      targetDriverId: recipient.driverId,
      targetRoutePlanId: recipient.routePlanId
    }));
    const version = await this.latestVersion(input);
    return { bundle: expose(bundle), routePlanId: result.routePlanId, version };
  }

  private async context(input: DriverRouteAccessScope) {
    const context = await this.repository.findRouteContext(input);
    if (context === null) {
      throw error('DESTINATION_BUNDLE_ROUTE_SCOPE_REJECTED', '현재 배송 경로를 확인할 수 없습니다.');
    }
    const grouping = await this.groupingService.getGrouping({
      groupingId: context.groupingId,
      shopDomain: input.shopDomain
    });
    if (grouping === null) throw error('DESTINATION_BUNDLE_NOT_FOUND', '현재 배송 그룹을 찾을 수 없습니다.');
    const orders = await this.repository.listBundleOrders({ groupingId: context.groupingId, shopId: input.shopId });
    return { bundles: groupOrders(orders), context, grouping };
  }

  private async latestVersion(input: DriverRouteAccessScope): Promise<string> {
    const { grouping } = await this.context(input);
    return grouping.updatedAt;
  }

  private async runCommand<T>(command: () => Promise<T>): Promise<T> {
    try {
      return await command();
    } catch (cause) {
      if (cause instanceof DsvAssignmentCommandError) throw translateAssignmentError(cause);
      if (cause instanceof RouteGroupingValidationError) {
        const unavailable = cause.blockers.some((blocker) => blocker.includes('not configured'));
        throw error(
          unavailable ? 'DESTINATION_BUNDLE_ROUTE_RECALCULATION_UNAVAILABLE' : 'DESTINATION_BUNDLE_ROUTE_RECALCULATION_FAILED',
          unavailable ? '경로 재계산 서비스에 연결할 수 없습니다.' : '변경된 배송 경로를 계산하지 못했습니다.'
        );
      }
      throw cause;
    }
  }
}

function groupOrders(rows: BundleOrder[]): InternalBundle[] {
  const grouped = new Map<string, BundleOrder[]>();
  for (const row of rows) grouped.set(row.destinationId, [...(grouped.get(row.destinationId) ?? []), row]);
  return [...grouped.entries()].map(([destinationId, orders]) => {
    const first = orders[0];
    if (first === undefined) throw error('DESTINATION_BUNDLE_NOT_FOUND', '배송지 묶음이 비어 있습니다.');
    return {
      address: first.address,
      boxCount: orders.reduce((sum, order) => sum + order.shippedBoxes, 0),
      conditionCodes: [...new Set(orders.map((order) => order.conditionCode))].sort(),
      destinationId,
      destinationName: first.destinationName,
      orderCount: orders.length,
      orders
    };
  });
}

function deliveryRecipients(
  children: Array<{ displayStatus: string; driverId: string | null; driverName: string | null; routePlanId: string | null }>,
  currentDriverId: string
): InternalRecipient[] {
  return children.flatMap((child) => child.displayStatus === 'READY'
    && child.driverId !== null
    && child.driverId !== currentDriverId
    && child.routePlanId !== null
    ? [{ driverId: child.driverId, driverName: child.driverName ?? '이름 없는 배송원', routePlanId: child.routePlanId }]
    : []).sort((left, right) => left.driverName.localeCompare(right.driverName, 'ko'));
}

function isMine(bundle: InternalBundle, input: Pick<DriverRouteAccessScope, 'driverId' | 'routePlanId'>): boolean {
  return bundle.orders.every((order) => order.driverId === input.driverId && order.routePlanId === input.routePlanId);
}

function isAvailable(bundle: InternalBundle): boolean {
  return bundle.orders.every((order) => order.driverId === null);
}

function requireBundle(bundles: InternalBundle[], destinationId: string): InternalBundle {
  const bundle = bundles.find((candidate) => candidate.destinationId === destinationId);
  if (bundle === undefined) throw error('DESTINATION_BUNDLE_NOT_FOUND', '배송지 묶음을 찾을 수 없습니다.');
  return bundle;
}

function assertVersion(actual: string, expected: string): void {
  if (actual !== expected) throw error('DESTINATION_BUNDLE_ASSIGNMENT_CHANGED', '배송 배정이 변경되었습니다.');
}

function assertToday(planDate: string, now: Date): void {
  if (!isToday(planDate, now)) {
    throw error('DESTINATION_BUNDLE_TRANSFER_CLOSED', '공용 배송은 당일 배차에서만 변경할 수 있습니다.');
  }
}

function isToday(planDate: string, now: Date): boolean {
  return planDate === driverServiceDate(now);
}

function commandId(action: 'acquire' | 'release', input: DriverDeliverySpaceCommand, orderId: string): string {
  return `driver-delivery-space:${action}:${input.destinationId}:${orderId}:${input.expectedVersion}`;
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

function translateAssignmentError(cause: DsvAssignmentCommandError): DriverDeliverySpaceError {
  switch (cause.code) {
    case 'SELLER_ORDER_ALREADY_ACQUIRED':
      return error('DESTINATION_BUNDLE_ALREADY_ACQUIRED', '다른 배송원이 먼저 가져간 배송입니다.');
    case 'SELLER_ORDER_NOT_FOUND':
      return error('DESTINATION_BUNDLE_NOT_FOUND', '배송지 묶음을 찾을 수 없습니다.');
    case 'SELLER_ORDER_ROUTE_SCOPE_REJECTED':
      return error('DESTINATION_BUNDLE_ROUTE_SCOPE_REJECTED', '현재 배송 경로에서 변경할 수 없습니다.');
    case 'SELLER_ORDER_TARGET_VEHICLE_REQUIRED':
      return error('DESTINATION_BUNDLE_TARGET_VEHICLE_REQUIRED', '차량이 연결된 경로에서만 배송을 가져올 수 있습니다.');
    case 'SELLER_ORDER_TRANSFER_CLOSED':
      return error('DESTINATION_BUNDLE_TRANSFER_CLOSED', '진행 중인 배송은 반납할 수 없고 종료된 경로에는 추가할 수 없습니다.');
    default:
      return error('DESTINATION_BUNDLE_ASSIGNMENT_CHANGED', '배송 배정이 변경되었습니다.');
  }
}

function error(code: DriverDeliverySpaceError['code'], message: string): DriverDeliverySpaceError {
  return new DriverDeliverySpaceError(code, message);
}
