import type { PrismaClient } from '@prisma/client';

import {
  DsvAssignmentCommandError,
  type DsvAssignmentCommandService
} from '../dsv/dsv-assignment-command.service.js';
import type { PrismaDsvDriverNotificationDispatcher } from '../dsv/dsv-driver-notification.dispatcher.js';
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

export type DriverBundleHandoffRequest = {
  bundle?: DriverDeliveryBundle;
  destinationId: string;
  expiresAt: string;
  requestId: string;
  senderDriverName?: string;
  status: 'APPLIED' | 'CANCELLED' | 'INVALIDATED' | 'PROPOSED' | 'REJECTED';
  targetDriverName?: string;
};

export type DriverDeliverySpace = {
  available: DriverDeliveryBundle[];
  incomingHandoffs: DriverBundleHandoffRequest[];
  mine: DriverDeliveryBundle[];
  outgoingHandoffs: DriverBundleHandoffRequest[];
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

export type DriverDeliverySpaceHandoffDecision = DriverRouteAccessScope & {
  requestId: string;
};

export type DriverDeliverySpaceServiceContract = {
  acquire(input: DriverDeliverySpaceCommand): Promise<DriverDeliverySpaceCommandResult>;
  acceptHandoff(input: DriverDeliverySpaceHandoffDecision): Promise<DriverDeliverySpaceCommandResult>;
  cancelHandoff(input: DriverDeliverySpaceHandoffDecision): Promise<DriverBundleHandoffRequest>;
  getSpace(input: DriverRouteAccessScope): Promise<DriverDeliverySpace>;
  proposeHandoff(input: DriverDeliverySpaceTransferCommand): Promise<DriverBundleHandoffRequest>;
  rejectHandoff(input: DriverDeliverySpaceHandoffDecision): Promise<DriverBundleHandoffRequest>;
  release(input: DriverDeliverySpaceCommand): Promise<DriverDeliverySpaceCommandResult>;
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

type StoredHandoff = {
  createdAt: Date;
  destinationId: string;
  expectedVersion: string;
  expiresAt: Date;
  groupingId: string;
  id: string;
  sourceDriverId: string;
  sourceRoutePlanId: string;
  status: 'PROPOSED' | 'PROCESSING' | 'REJECTED' | 'APPLIED' | 'CANCELLED' | 'INVALIDATED';
  targetDriverId: string;
  targetRoutePlanId: string;
};

type InternalBundle = DriverDeliveryBundle & { orders: BundleOrder[] };
type InternalRecipient = DriverDeliveryRecipient & { routePlanId: string };

export type DriverDeliverySpaceRepositoryContract = {
  createHandoff(input: {
    destinationId: string;
    expectedVersion: string;
    expiresAt: Date;
    groupingId: string;
    shopId: string;
    sourceDriverId: string;
    sourceRoutePlanId: string;
    targetDriverId: string;
    targetRoutePlanId: string;
  }): Promise<StoredHandoff>;
  findRouteContext(input: Pick<DriverRouteAccessScope, 'driverId' | 'routePlanId' | 'shopId'>): Promise<{
    childVersionId: string;
    groupingId: string;
    groupingVersion: number;
  } | null>;
  getHandoff(input: { requestId: string; shopId: string }): Promise<StoredHandoff | null>;
  listActiveHandoffs(input: { driverId: string; groupingId: string; shopId: string }): Promise<StoredHandoff[]>;
  listBundleOrders(input: { groupingId: string; shopId: string }): Promise<BundleOrder[]>;
  recordHandoffNotification(input: {
    childVersionId: string;
    driverId: string;
    event: 'applied' | 'cancelled' | 'invalidated' | 'proposed' | 'rejected';
    groupingId: string;
    groupingVersion: number;
    requestId: string;
    routePlanId: string;
    shopId: string;
  }): Promise<void>;
  updateHandoffStatus(input: {
    fromStatus: 'PROCESSING' | 'PROPOSED';
    requestId: string;
    shopId: string;
    status: 'APPLIED' | 'CANCELLED' | 'INVALIDATED' | 'PROCESSING' | 'REJECTED';
  }): Promise<StoredHandoff>;
};

type SpacePrisma = Pick<PrismaClient, 'driverBundleHandoffRequest' | 'driverRouteNotificationAttempt' | 'dsvDispatchImportRow' | 'routeGroupingChildVersion'>;
type AssignmentCommands = Pick<DsvAssignmentCommandService, 'reassignMany' | 'unassignMany'>;

export class PrismaDriverDeliverySpaceRepository implements DriverDeliverySpaceRepositoryContract {
  constructor(private readonly prisma: SpacePrisma) {}

  async createHandoff(input: Parameters<DriverDeliverySpaceRepositoryContract['createHandoff']>[0]): Promise<StoredHandoff> {
    try {
      return await this.prisma.driverBundleHandoffRequest.create({ data: input });
    } catch (cause) {
      if (isPrismaUniqueConstraintError(cause)) {
        throw error('DESTINATION_BUNDLE_ASSIGNMENT_CHANGED', '이미 대기 중인 전달 요청이 있습니다.');
      }
      throw cause;
    }
  }

  async findRouteContext(input: Pick<DriverRouteAccessScope, 'driverId' | 'routePlanId' | 'shopId'>) {
    const child = await this.prisma.routeGroupingChildVersion.findFirst({
      select: { groupingId: true, id: true, version: true },
      where: {
        driverId: input.driverId,
        routePlanId: input.routePlanId,
        shopId: input.shopId,
        status: 'CURRENT'
      }
    });
    return child === null ? null : {
      childVersionId: child.id,
      groupingId: child.groupingId,
      groupingVersion: child.version
    };
  }

  async getHandoff(input: { requestId: string; shopId: string }): Promise<StoredHandoff | null> {
    return this.prisma.driverBundleHandoffRequest.findFirst({
      where: { id: input.requestId, shopId: input.shopId }
    });
  }

  async listActiveHandoffs(input: { driverId: string; groupingId: string; shopId: string }): Promise<StoredHandoff[]> {
    const handoffs = await this.prisma.driverBundleHandoffRequest.findMany({
      orderBy: { createdAt: 'desc' },
      where: {
        groupingId: input.groupingId,
        shopId: input.shopId,
        status: { in: ['PROPOSED', 'PROCESSING'] },
        OR: [{ sourceDriverId: input.driverId }, { targetDriverId: input.driverId }]
      }
    });
    const now = this.prismaNow();
    const expired = handoffs.filter((handoff) => handoff.status === 'PROPOSED' && handoff.expiresAt.getTime() <= now.getTime());
    await Promise.all(expired.map((handoff) => this.updateHandoffStatus({
      fromStatus: 'PROPOSED',
      requestId: handoff.id,
      shopId: input.shopId,
      status: 'INVALIDATED'
    }).catch(() => undefined)));
    return handoffs.filter((handoff) => handoff.status === 'PROCESSING' || handoff.expiresAt.getTime() > now.getTime());
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

  async recordHandoffNotification(input: Parameters<DriverDeliverySpaceRepositoryContract['recordHandoffNotification']>[0]): Promise<void> {
    const idempotencyKey = `driver-bundle-handoff:${input.requestId}:${input.event}`;
    await this.prisma.driverRouteNotificationAttempt.upsert({
      create: {
        action: 'CHANGED',
        childVersionId: input.childVersionId,
        driverId: input.driverId,
        groupingId: input.groupingId,
        groupingVersion: input.groupingVersion,
        idempotencyKey,
        metadata: {
          handoffEvent: input.event,
          handoffRequestId: input.requestId
        },
        provider: 'FCM',
        routePlanId: input.routePlanId,
        shopId: input.shopId,
        status: 'PENDING'
      },
      update: {},
      where: { idempotencyKey }
    });
  }

  async updateHandoffStatus(input: Parameters<DriverDeliverySpaceRepositoryContract['updateHandoffStatus']>[0]): Promise<StoredHandoff> {
    const updatedCount = await this.prisma.driverBundleHandoffRequest.updateMany({
      data: { respondedAt: this.prismaNow(), status: input.status },
      where: { id: input.requestId, shopId: input.shopId, status: input.fromStatus }
    });
    if (updatedCount.count !== 1) {
      throw error('HANDOFF_REQUEST_NOT_FOUND', '처리 가능한 전달 요청을 찾을 수 없습니다.');
    }
    const updated = await this.getHandoff(input);
    if (updated === null) throw error('HANDOFF_REQUEST_NOT_FOUND', '전달 요청을 찾을 수 없습니다.');
    return updated;
  }

  private prismaNow(): Date {
    return new Date();
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
    | 'DESTINATION_BUNDLE_TRANSFER_CLOSED'
    | 'DRIVER_BUNDLE_HANDOFF_EXPIRED'
    | 'HANDOFF_REQUEST_NOT_FOUND', message: string) {
    super(message);
    this.name = 'DriverDeliverySpaceError';
  }
}

export class DriverDeliverySpaceService implements DriverDeliverySpaceServiceContract {
  constructor(
    private readonly repository: DriverDeliverySpaceRepositoryContract,
    private readonly groupingService: RouteGroupingService,
    private readonly assignmentCommands: AssignmentCommands,
    private readonly now: () => Date = () => new Date(),
    private readonly driverNotificationDispatcher?: Pick<PrismaDsvDriverNotificationDispatcher, 'dispatchByIdempotencyKey'>
  ) {}

  async getSpace(input: DriverRouteAccessScope): Promise<DriverDeliverySpace> {
    const { bundles, grouping } = await this.context(input);
    const visibleBundles = isToday(grouping.planDate, this.now()) ? bundles : [];
    const handoffs = visibleBundles.length === 0 ? [] : await this.repository.listActiveHandoffs({
      driverId: input.driverId,
      groupingId: grouping.id,
      shopId: input.shopId
    });
    return {
      available: visibleBundles.filter(isAvailable).map(expose),
      incomingHandoffs: exposeHandoffs(
        handoffs,
        visibleBundles,
        grouping.children,
        input.driverId,
        'incoming'
      ),
      mine: visibleBundles.filter((bundle) => isMine(bundle, input)).map(expose),
      outgoingHandoffs: exposeHandoffs(
        handoffs,
        visibleBundles,
        grouping.children,
        input.driverId,
        'outgoing'
      ),
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

  async proposeHandoff(input: DriverDeliverySpaceTransferCommand): Promise<DriverBundleHandoffRequest> {
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
    const activeHandoffs = await this.repository.listActiveHandoffs({
      driverId: input.driverId,
      groupingId: grouping.id,
      shopId: input.shopId
    });
    if (activeHandoffs.some((handoff) => handoff.destinationId === input.destinationId)) {
      throw error('DESTINATION_BUNDLE_ASSIGNMENT_CHANGED', '이미 대기 중인 전달 요청이 있습니다.');
    }

    const request = await this.repository.createHandoff({
      destinationId: input.destinationId,
      expectedVersion: input.expectedVersion,
      expiresAt: new Date(this.now().getTime() + 10 * 60 * 1000),
      groupingId: grouping.id,
      shopId: input.shopId,
      sourceDriverId: input.driverId,
      sourceRoutePlanId: input.routePlanId,
      targetDriverId: recipient.driverId,
      targetRoutePlanId: recipient.routePlanId
    });
    const targetContext = await this.repository.findRouteContext({
      driverId: recipient.driverId,
      routePlanId: recipient.routePlanId,
      shopId: input.shopId
    });
    if (targetContext !== null) {
      await this.recordHandoffNotification({
        childVersionId: targetContext.childVersionId,
        driverId: recipient.driverId,
        event: 'proposed',
        groupingId: grouping.id,
        groupingVersion: targetContext.groupingVersion,
        requestId: request.id,
        routePlanId: recipient.routePlanId,
        shopId: input.shopId
      });
    }
    return exposeHandoff(request, bundle, grouping.children, 'outgoing');
  }

  async acceptHandoff(input: DriverDeliverySpaceHandoffDecision): Promise<DriverDeliverySpaceCommandResult> {
    let request = await this.requireHandoffForTarget(input, true);
    const isRecovery = request.status === 'PROCESSING';
    if (request.status === 'PROPOSED' && request.expiresAt.getTime() <= this.now().getTime()) {
      await this.repository.updateHandoffStatus({ fromStatus: 'PROPOSED', requestId: request.id, shopId: input.shopId, status: 'INVALIDATED' });
      await this.recordSourceHandoffNotification(input, request, 'invalidated');
      throw error('DRIVER_BUNDLE_HANDOFF_EXPIRED', '전달 요청이 만료되었습니다.');
    }
    if (request.status === 'PROPOSED') {
      request = await this.repository.updateHandoffStatus({
        fromStatus: 'PROPOSED',
        requestId: request.id,
        shopId: input.shopId,
        status: 'PROCESSING'
      });
    }
    try {
      const result = await this.applyTransfer({
        ...input,
        destinationId: request.destinationId,
        expectedVersion: request.expectedVersion,
        targetDriverId: request.targetDriverId
      }, request.sourceDriverId, request.sourceRoutePlanId, `driver-delivery-space:handoff:${request.id}`, isRecovery);
      await this.repository.updateHandoffStatus({ fromStatus: 'PROCESSING', requestId: request.id, shopId: input.shopId, status: 'APPLIED' });
      await this.recordSourceHandoffNotification(input, request, 'applied');
      return result;
    } catch (cause) {
      if (cause instanceof DriverDeliverySpaceError) {
        await this.repository.updateHandoffStatus({ fromStatus: 'PROCESSING', requestId: request.id, shopId: input.shopId, status: 'INVALIDATED' })
          .catch(() => undefined);
        await this.recordSourceHandoffNotification(input, request, 'invalidated');
      }
      throw cause;
    }
  }

  async rejectHandoff(input: DriverDeliverySpaceHandoffDecision): Promise<DriverBundleHandoffRequest> {
    const request = await this.requireHandoffForTarget(input);
    const { bundles, grouping } = await this.context(input);
    const bundle = requireBundle(bundles, request.destinationId);
    const updated = await this.repository.updateHandoffStatus({ fromStatus: 'PROPOSED', requestId: request.id, shopId: input.shopId, status: 'REJECTED' });
    await this.recordSourceHandoffNotification(input, request, 'rejected');
    return exposeHandoff(
      updated,
      bundle,
      grouping.children,
      'incoming'
    );
  }

  async cancelHandoff(input: DriverDeliverySpaceHandoffDecision): Promise<DriverBundleHandoffRequest> {
    const request = await this.requireHandoffForSource(input);
    const { bundles, grouping } = await this.context(input);
    const bundle = requireBundle(bundles, request.destinationId);
    const updated = await this.repository.updateHandoffStatus({ fromStatus: 'PROPOSED', requestId: request.id, shopId: input.shopId, status: 'CANCELLED' });
    const targetContext = await this.repository.findRouteContext({
      driverId: request.targetDriverId,
      routePlanId: request.targetRoutePlanId,
      shopId: input.shopId
    });
    if (targetContext !== null) {
      await this.recordHandoffNotification({
        childVersionId: targetContext.childVersionId,
        driverId: request.targetDriverId,
        event: 'cancelled',
        groupingId: request.groupingId,
        groupingVersion: targetContext.groupingVersion,
        requestId: request.id,
        routePlanId: request.targetRoutePlanId,
        shopId: input.shopId
      });
    }
    return exposeHandoff(
      updated,
      bundle,
      grouping.children,
      'outgoing'
    );
  }

  private async applyTransfer(
    input: DriverDeliverySpaceTransferCommand,
    sourceDriverId: string,
    sourceRoutePlanId: string,
    idPrefix: string,
    allowAlreadyApplied = false
  ): Promise<DriverDeliverySpaceCommandResult> {
    const { bundles, grouping } = await this.context(input);
    assertToday(grouping.planDate, this.now());
    const bundle = requireBundle(bundles, input.destinationId);
    if (allowAlreadyApplied && isOwnedBy(bundle, input.targetDriverId, input.routePlanId)) {
      return { bundle: expose(bundle), routePlanId: input.routePlanId, version: grouping.updatedAt };
    }
    assertVersion(grouping.updatedAt, input.expectedVersion);
    if (!isOwnedBy(bundle, sourceDriverId, sourceRoutePlanId)) {
      throw error('DESTINATION_BUNDLE_ROUTE_SCOPE_REJECTED', '내 배송지만 전달할 수 있습니다.');
    }
    const recipient = deliveryRecipients(grouping.children, sourceDriverId)
      .find((candidate) => candidate.driverId === input.targetDriverId);
    if (recipient === undefined) {
      throw error('DESTINATION_BUNDLE_ROUTE_SCOPE_REJECTED', '현재 배차의 다른 배송원에게만 전달할 수 있습니다.');
    }

    const result = await this.runCommand(() => this.assignmentCommands.reassignMany({
      actor: { actorId: input.driverId, actorType: 'DRIVER', principalType: 'DRIVER' },
      items: bundle.orders.map((order) => ({
        commandId: `${idPrefix}:${input.destinationId}:${order.orderId}:${input.targetDriverId}:${input.expectedVersion}`,
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

  private async requireHandoffForTarget(input: DriverDeliverySpaceHandoffDecision, allowProcessing = false): Promise<StoredHandoff> {
    const request = await this.repository.getHandoff({ requestId: input.requestId, shopId: input.shopId });
    if (
      request === null ||
      (request.status !== 'PROPOSED' && (!allowProcessing || request.status !== 'PROCESSING')) ||
      request.targetDriverId !== input.driverId ||
      request.targetRoutePlanId !== input.routePlanId
    ) {
      throw error('HANDOFF_REQUEST_NOT_FOUND', '전달 요청을 찾을 수 없습니다.');
    }
    return request;
  }

  private async requireHandoffForSource(input: DriverDeliverySpaceHandoffDecision): Promise<StoredHandoff> {
    const request = await this.repository.getHandoff({ requestId: input.requestId, shopId: input.shopId });
    if (
      request === null ||
      request.status !== 'PROPOSED' ||
      request.sourceDriverId !== input.driverId ||
      request.sourceRoutePlanId !== input.routePlanId
    ) {
      throw error('HANDOFF_REQUEST_NOT_FOUND', '전달 요청을 찾을 수 없습니다.');
    }
    return request;
  }

  private async recordSourceHandoffNotification(
    input: DriverRouteAccessScope,
    request: StoredHandoff,
    event: 'applied' | 'invalidated' | 'rejected'
  ): Promise<void> {
    const sourceContext = await this.repository.findRouteContext({
      driverId: request.sourceDriverId,
      routePlanId: request.sourceRoutePlanId,
      shopId: input.shopId
    });
    if (sourceContext === null) return;
    await this.recordHandoffNotification({
      childVersionId: sourceContext.childVersionId,
      driverId: request.sourceDriverId,
      event,
      groupingId: request.groupingId,
      groupingVersion: sourceContext.groupingVersion,
      requestId: request.id,
      routePlanId: request.sourceRoutePlanId,
      shopId: input.shopId
    });
  }

  private async recordHandoffNotification(
    input: Parameters<DriverDeliverySpaceRepositoryContract['recordHandoffNotification']>[0]
  ): Promise<void> {
    await this.repository.recordHandoffNotification(input);
    await this.driverNotificationDispatcher
      ?.dispatchByIdempotencyKey(`driver-bundle-handoff:${input.requestId}:${input.event}`)
      .catch(() => undefined);
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

function isOwnedBy(bundle: InternalBundle, driverId: string, routePlanId: string): boolean {
  return bundle.orders.every((order) => order.driverId === driverId && order.routePlanId === routePlanId);
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

function exposeHandoffs(
  handoffs: StoredHandoff[],
  bundles: InternalBundle[],
  children: Array<{ driverId: string | null; driverName: string | null }>,
  driverId: string,
  direction: 'incoming' | 'outgoing'
): DriverBundleHandoffRequest[] {
  return handoffs.flatMap((handoff) => {
    if (direction === 'incoming' && handoff.targetDriverId !== driverId) return [];
    if (direction === 'outgoing' && handoff.sourceDriverId !== driverId) return [];
    const bundle = bundles.find((candidate) => candidate.destinationId === handoff.destinationId);
    if (bundle === undefined) return [];
    return [exposeHandoff(handoff, bundle, children, direction)];
  });
}

function exposeHandoff(
  handoff: StoredHandoff,
  bundle: InternalBundle,
  children: Array<{ driverId: string | null; driverName: string | null }>,
  direction: 'incoming' | 'outgoing'
): DriverBundleHandoffRequest {
  const request: DriverBundleHandoffRequest = {
    bundle: expose(bundle),
    destinationId: handoff.destinationId,
    expiresAt: handoff.expiresAt.toISOString(),
    requestId: handoff.id,
    status: handoff.status === 'PROCESSING' ? 'PROPOSED' : handoff.status
  };
  const driverName = children.find((child) => child.driverId === (
    direction === 'incoming' ? handoff.sourceDriverId : handoff.targetDriverId
  ))?.driverName ?? '이름 없는 배송원';
  if (direction === 'incoming') request.senderDriverName = driverName;
  else request.targetDriverName = driverName;
  return request;
}

function isPrismaUniqueConstraintError(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'P2002';
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
