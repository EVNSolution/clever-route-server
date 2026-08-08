import type { PrismaClient } from '@prisma/client';

import {
  RouteGroupingConflictError,
  RouteGroupingValidationError,
  type RouteGroupingAssignmentDto,
  type RouteGroupingChildDto,
  type RouteGroupingDetailDto,
  type RouteGroupingDraftRouteInput,
  type RouteGroupingService
} from '../route-grouping/route-grouping.types.js';
import type { DriverRouteAccessScope } from './driver-token-access.repository.js';

export type DriverSellerOrder = {
  addressLabel: string;
  itemCount: number;
  orderId: string;
  orderName: string;
  recipientName: string | null;
  sellerOrderKey: string;
  sourceSequence: number;
};

export type DriverSellerOrderAssignmentResult = {
  auditEventId?: string;
  groupingId: string;
  groupingUpdatedAt: string;
  newRouteVersionId?: string | null;
  order: DriverSellerOrder;
  previousRouteVersionId?: string | null;
  receiptId?: string;
  routePlanId: string;
};

export type DriverSellerOrderAssignmentCommandInput = DriverRouteAccessScope & {
  commandId: string;
  expectedVersion: string | null;
  orderId: string;
};

export type DriverSellerOrderAssignmentServiceContract = {
  acquire(input: DriverSellerOrderAssignmentCommandInput): Promise<DriverSellerOrderAssignmentResult>;
  listUnassigned(input: DriverRouteAccessScope): Promise<DriverSellerOrder[]>;
  release(input: DriverSellerOrderAssignmentCommandInput): Promise<DriverSellerOrderAssignmentResult>;
};

export type DriverSellerOrderAssignmentCommandKernelInput = DriverSellerOrderAssignmentCommandInput;

export type DriverSellerOrderAssignmentCommandKernel = {
  acquireDriverSellerOrder(
    input: DriverSellerOrderAssignmentCommandKernelInput
  ): Promise<DriverSellerOrderAssignmentResult>;
  releaseDriverSellerOrder(
    input: DriverSellerOrderAssignmentCommandKernelInput
  ): Promise<DriverSellerOrderAssignmentResult>;
};

type DriverSellerOrderRouteContext = {
  groupingId: string;
};

export type DriverSellerOrderContextRepositoryContract = {
  findRouteContext(input: Pick<DriverRouteAccessScope, 'driverId' | 'routePlanId' | 'shopId'>): Promise<DriverSellerOrderRouteContext | null>;
};

type DriverSellerOrderContextPrismaClient = Pick<PrismaClient, 'routeGroupingChildVersion'>;

export class PrismaDriverSellerOrderContextRepository implements DriverSellerOrderContextRepositoryContract {
  constructor(private readonly prisma: DriverSellerOrderContextPrismaClient) {}

  async findRouteContext(
    input: Pick<DriverRouteAccessScope, 'driverId' | 'routePlanId' | 'shopId'>
  ): Promise<DriverSellerOrderRouteContext | null> {
    const child = await this.prisma.routeGroupingChildVersion.findFirst({
      select: {
        groupingId: true
      },
      where: {
        driverId: input.driverId,
        routePlanId: input.routePlanId,
        shopId: input.shopId,
        status: 'CURRENT'
      }
    });

    if (child === null) return null;
    return { groupingId: child.groupingId };
  }
}

export class DriverSellerOrderNotFoundError extends Error {
  readonly code = 'SELLER_ORDER_NOT_FOUND';

  constructor(message = 'Seller order was not found in the current route group.') {
    super(message);
    this.name = 'DriverSellerOrderNotFoundError';
  }
}

export class DriverSellerOrderScopeError extends Error {
  readonly code = 'SELLER_ORDER_ROUTE_SCOPE_REJECTED';

  constructor(message = 'Seller order route scope was rejected.') {
    super(message);
    this.name = 'DriverSellerOrderScopeError';
  }
}

export class DriverSellerOrderAlreadyAcquiredError extends Error {
  readonly code = 'SELLER_ORDER_ALREADY_ACQUIRED';

  constructor(message = 'This order has already been acquired by another driver.') {
    super(message);
    this.name = 'DriverSellerOrderAlreadyAcquiredError';
  }
}

export class DriverSellerOrderTransferClosedError extends Error {
  readonly code = 'SELLER_ORDER_TRANSFER_CLOSED';

  constructor(message = 'Orders can only be transferred before route departure.') {
    super(message);
    this.name = 'DriverSellerOrderTransferClosedError';
  }
}

export class DriverSellerOrderVehicleRequiredError extends Error {
  readonly code = 'SELLER_ORDER_TARGET_VEHICLE_REQUIRED';

  constructor(message = 'The target driver route must have a vehicle before acquiring an order.') {
    super(message);
    this.name = 'DriverSellerOrderVehicleRequiredError';
  }
}

export class DriverSellerOrderAssignmentConflictError extends Error {
  readonly code = 'SELLER_ORDER_ASSIGNMENT_CHANGED';

  constructor(message = 'Seller order assignment changed. Refresh and try again.') {
    super(message);
    this.name = 'DriverSellerOrderAssignmentConflictError';
  }
}

export class DriverSellerOrderRecalculationError extends Error {
  readonly code = 'SELLER_ORDER_ROUTE_RECALCULATION_FAILED';

  constructor(message = 'Seller order transfer could not recalculate the affected routes.') {
    super(message);
    this.name = 'DriverSellerOrderRecalculationError';
  }
}

export class DriverSellerOrderRecalculationUnavailableError extends Error {
  readonly code = 'SELLER_ORDER_ROUTE_RECALCULATION_UNAVAILABLE';

  constructor(message = 'Seller order transfer is temporarily unavailable because route recalculation is not configured.') {
    super(message);
    this.name = 'DriverSellerOrderRecalculationUnavailableError';
  }
}

export class DriverSellerOrderAssignmentService implements DriverSellerOrderAssignmentServiceContract {
  constructor(
    private readonly contextRepository: DriverSellerOrderContextRepositoryContract,
    private readonly routeGroupingService: RouteGroupingService,
    private readonly commandKernel?: DriverSellerOrderAssignmentCommandKernel
  ) {}

  async listUnassigned(input: DriverRouteAccessScope): Promise<DriverSellerOrder[]> {
    const { grouping } = await this.loadScopedGrouping(input);
    const assignments = assignmentMap(grouping);

    return grouping.children
      .filter((child) => child.driverId === null && child.displayStatus === 'READY' && child.routePlanId !== null)
      .flatMap((child) => child.orderIds)
      .map((orderId) => assignments.get(orderId))
      .filter((assignment): assignment is RouteGroupingAssignmentDto => assignment !== undefined)
      .sort((left, right) => left.sourceSequence - right.sourceSequence)
      .map(toDriverSellerOrder);
  }

  async acquire(input: DriverSellerOrderAssignmentCommandInput): Promise<DriverSellerOrderAssignmentResult> {
    if (this.commandKernel !== undefined) {
      await this.loadBearerRouteContext(input);
      return this.commandKernel.acquireDriverSellerOrder(input);
    }

    const { grouping } = await this.loadScopedGrouping(input);

    const target = requireDriverRoute(grouping, input);
    assertTransferOpen(target);
    const owner = requireOrderOwner(grouping, input.orderId);
    if (owner.driverId !== null) throw new DriverSellerOrderAlreadyAcquiredError();
    if (owner.routePlanId === null) throw new DriverSellerOrderAssignmentConflictError('Unassigned order route is not ready.');
    assertTransferOpen(owner);

    const routes = moveOrder(grouping, input.orderId, owner, target);
    try {
      const saved = await this.routeGroupingService.saveDraft({
        expectedUpdatedAt: input.expectedVersion ?? grouping.updatedAt,
        groupingId: grouping.id,
        routes,
        shopDomain: input.shopDomain
      });
      if (saved === null) throw new DriverSellerOrderNotFoundError();
      return assignmentResult(saved, input.orderId, target.routePlanId ?? input.routePlanId);
    } catch (error) {
      if (!(error instanceof RouteGroupingConflictError)) throw translateRouteSaveError(error);
      const refreshed = await this.routeGroupingService.getGrouping({
        groupingId: grouping.id,
        shopDomain: input.shopDomain
      });
      if (refreshed !== null) {
        const refreshedOwner = findOrderOwner(refreshed, input.orderId);
        if (refreshedOwner !== null && refreshedOwner.driverId !== null) {
          throw new DriverSellerOrderAlreadyAcquiredError();
        }
      }
      throw new DriverSellerOrderAssignmentConflictError();
    }
  }

  async release(input: DriverSellerOrderAssignmentCommandInput): Promise<DriverSellerOrderAssignmentResult> {
    if (this.commandKernel !== undefined) {
      await this.loadBearerRouteContext(input);
      return this.commandKernel.releaseDriverSellerOrder(input);
    }

    const { grouping } = await this.loadScopedGrouping(input);
    const source = requireOrderOwner(grouping, input.orderId);
    if (source.routePlanId !== input.routePlanId || source.driverId !== input.driverId) {
      throw new DriverSellerOrderScopeError();
    }
    assertTransferOpen(source);

    const existingUnassigned = grouping.children
      .filter((child) => child.driverId === null && child.displayStatus === 'READY' && child.routePlanId !== null)
      .sort((left, right) => (left.sortOrder ?? Number.MAX_SAFE_INTEGER) - (right.sortOrder ?? Number.MAX_SAFE_INTEGER))[0];
    const routes = existingUnassigned === undefined
      ? releaseToNewUnassignedRoute(grouping, input.orderId, source)
      : moveOrder(grouping, input.orderId, source, existingUnassigned);

    try {
      const saved = await this.routeGroupingService.saveDraft({
        expectedUpdatedAt: input.expectedVersion ?? grouping.updatedAt,
        groupingId: grouping.id,
        routes,
        shopDomain: input.shopDomain
      });
      if (saved === null) throw new DriverSellerOrderNotFoundError();
      const releasedOwner = requireOrderOwner(saved, input.orderId);
      if (releasedOwner.routePlanId === null) throw new DriverSellerOrderAssignmentConflictError();
      return assignmentResult(saved, input.orderId, releasedOwner.routePlanId);
    } catch (error) {
      if (error instanceof RouteGroupingConflictError) throw new DriverSellerOrderAssignmentConflictError();
      throw translateRouteSaveError(error);
    }
  }

  private async loadScopedGrouping(input: DriverRouteAccessScope): Promise<{
    context: DriverSellerOrderRouteContext;
    grouping: RouteGroupingDetailDto;
  }> {
    const context = await this.contextRepository.findRouteContext(input);
    if (context === null) throw new DriverSellerOrderScopeError();
    const grouping = await this.routeGroupingService.getGrouping({
      groupingId: context.groupingId,
      shopDomain: input.shopDomain
    });
    if (grouping === null) throw new DriverSellerOrderNotFoundError('Current route group was not found.');
    if (grouping.children.some((child) => child.routePlanId === null)) {
      throw new DriverSellerOrderAssignmentConflictError('Current route group contains an unmaterialized route.');
    }
    requireDriverRoute(grouping, input);
    return { context, grouping };
  }

  private async loadBearerRouteContext(input: DriverRouteAccessScope): Promise<DriverSellerOrderRouteContext> {
    const context = await this.contextRepository.findRouteContext(input);
    if (context === null) throw new DriverSellerOrderScopeError();
    return context;
  }
}

function assignmentMap(grouping: RouteGroupingDetailDto): Map<string, RouteGroupingAssignmentDto> {
  return new Map(grouping.assignments.map((assignment) => [assignment.orderId, assignment]));
}

function requireDriverRoute(
  grouping: RouteGroupingDetailDto,
  input: Pick<DriverRouteAccessScope, 'driverId' | 'routePlanId'>
): RouteGroupingChildDto {
  const route = grouping.children.find((child) => child.routePlanId === input.routePlanId);
  if (route === undefined || route.driverId !== input.driverId) throw new DriverSellerOrderScopeError();
  return route;
}

function findOrderOwner(grouping: RouteGroupingDetailDto, orderId: string): RouteGroupingChildDto | null {
  const owners = grouping.children.filter((child) => child.orderIds.includes(orderId));
  if (owners.length === 0) return null;
  if (owners.length > 1) throw new DriverSellerOrderAssignmentConflictError('Seller order belongs to multiple routes.');
  return owners[0] ?? null;
}

function requireOrderOwner(grouping: RouteGroupingDetailDto, orderId: string): RouteGroupingChildDto {
  const owner = findOrderOwner(grouping, orderId);
  if (owner === null) throw new DriverSellerOrderNotFoundError();
  return owner;
}

function assertTransferOpen(route: RouteGroupingChildDto): void {
  if (route.displayStatus !== 'READY') throw new DriverSellerOrderTransferClosedError();
}

function moveOrder(
  grouping: RouteGroupingDetailDto,
  orderId: string,
  source: RouteGroupingChildDto,
  target: RouteGroupingChildDto
): RouteGroupingDraftRouteInput[] {
  return grouping.children.map((child) => {
    if (child.routePlanId === source.routePlanId) {
      return childToDraftRoute(child, child.orderIds.filter((candidate) => candidate !== orderId));
    }
    if (child.routePlanId === target.routePlanId) {
      return childToDraftRoute(child, [...child.orderIds, orderId]);
    }
    return childToDraftRoute(child, child.orderIds);
  });
}

function releaseToNewUnassignedRoute(
  grouping: RouteGroupingDetailDto,
  orderId: string,
  source: RouteGroupingChildDto
): RouteGroupingDraftRouteInput[] {
  return [
    ...grouping.children.map((child) => childToDraftRoute(
      child,
      child.routePlanId === source.routePlanId
        ? child.orderIds.filter((candidate) => candidate !== orderId)
        : child.orderIds
    )),
    {
      branchId: null,
      driverId: null,
      label: '미배정',
      orderIds: [orderId],
      routePlanId: null,
      sortOrder: nextSortOrder(grouping.children),
      tempId: 'unassigned'
    }
  ];
}

function childToDraftRoute(child: RouteGroupingChildDto, orderIds: string[]): RouteGroupingDraftRouteInput {
  return {
    branchId: null,
    color: child.color,
    driverId: child.driverId,
    expectedChildUpdatedAt: child.updatedAt,
    ...(child.routePlan?.updatedAt === undefined ? {} : { expectedRoutePlanUpdatedAt: child.routePlan.updatedAt }),
    orderIds,
    ...(child.routeIdx === null ? {} : { routeIdx: child.routeIdx }),
    routePlanId: child.routePlanId,
    ...(child.routePlan?.scheduledStartAt === undefined
      ? {}
      : { scheduledStartAt: child.routePlan.scheduledStartAt ?? null }),
    ...(child.routePlan?.scheduledStartTimeZone === undefined
      ? {}
      : { scheduledStartTimeZone: child.routePlan.scheduledStartTimeZone ?? null }),
    ...(child.sortOrder === null ? {} : { sortOrder: child.sortOrder })
  };
}

function nextSortOrder(children: RouteGroupingChildDto[]): number {
  return children.reduce((highest, child) => Math.max(highest, child.sortOrder ?? 0), 0) + 1;
}

function assignmentResult(
  grouping: RouteGroupingDetailDto,
  orderId: string,
  routePlanId: string
): DriverSellerOrderAssignmentResult {
  const assignment = assignmentMap(grouping).get(orderId);
  if (assignment === undefined) throw new DriverSellerOrderNotFoundError();
  return {
    groupingId: grouping.id,
    groupingUpdatedAt: grouping.updatedAt,
    order: toDriverSellerOrder(assignment),
    routePlanId
  };
}

function toDriverSellerOrder(assignment: RouteGroupingAssignmentDto): DriverSellerOrder {
  return {
    addressLabel: assignment.addressLabel,
    itemCount: assignment.itemCount,
    orderId: assignment.orderId,
    orderName: assignment.orderName,
    recipientName: assignment.recipientName,
    sellerOrderKey: assignment.sourceOrderId,
    sourceSequence: assignment.sourceSequence
  };
}

function translateRouteSaveError(error: unknown): Error {
  if (!(error instanceof RouteGroupingValidationError)) {
    return error instanceof Error ? error : new DriverSellerOrderRecalculationError();
  }
  return error.blockers.some((blocker) => blocker.includes('not configured'))
    ? new DriverSellerOrderRecalculationUnavailableError()
    : new DriverSellerOrderRecalculationError();
}
