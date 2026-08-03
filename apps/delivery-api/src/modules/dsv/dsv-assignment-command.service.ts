import { createHash } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import {
  RouteGroupingConflictError,
  RouteGroupingValidationError,
  type RouteGroupingAssignmentDto,
  type RouteGroupingChildDto,
  type RouteGroupingDetailDto,
  type RouteGroupingDraftRouteInput,
  type RouteGroupingService,
} from '../route-grouping/route-grouping.types.js';
import type { DriverRouteAccessScope } from '../driver/driver-token-access.repository.js';
import { appScopedShopWhere } from '../shopify/shopify-app-scope.js';
import type { DsvAssignmentTransactionClient, DsvAssignmentTransactionPort } from './dsv-assignment-transaction-port.js';
import type { DsvRouteOptimizationSchedulerPort } from './dsv-route-optimization.scheduler.js';

type DsvAssignmentPrismaClient = DsvAssignmentTransactionPort & Pick<
  PrismaClient,
  'dsvAuditEvent' | 'dsvCommandReceipt' | 'dsvVehicleDriverAssignment' | 'order' | 'routeGroupingChildVersion' | 'routeGroupingOrder' | 'routePlan' | 'routePlanStop' | 'shop' | 'vehicle'
>;

type DsvAssignmentRouteGroupingService = RouteGroupingService & {
  saveDraftInTransaction?: (
    tx: DsvAssignmentTransactionClient,
    input: Parameters<RouteGroupingService['saveDraft']>[0],
  ) => Promise<RouteGroupingDetailDto | null>;
};

export type DsvAssignmentActor = {
  actorId?: string | null;
  actorType: 'DSV_ADMIN' | 'DRIVER' | 'SYSTEM_WORKER';
  principalType: 'DSV_ADMIN' | 'DRIVER' | 'SYSTEM_WORKER';
  requestId?: string | null;
};

export type DsvAssignmentCommandBaseInput = {
  actor: DsvAssignmentActor;
  commandId: string;
  expectedVersion?: string | null | undefined;
  reason?: string | null | undefined;
  sellerOrderId: string;
  shopDomain: string;
};

export type DsvAdminReassignInput = DsvAssignmentCommandBaseInput & {
  targetDriverId: string;
  targetRoutePlanId?: string | null;
  targetSequence?: number | null;
  targetVehicleId?: string | null;
};

export type DsvAdminBatchReassignInput = {
  actor: DsvAssignmentActor;
  items: Array<Pick<DsvAssignmentCommandBaseInput, 'commandId' | 'expectedVersion' | 'sellerOrderId'>>;
  reason?: string | null | undefined;
  shopDomain: string;
  targetDriverId: string;
  targetRoutePlanId?: string | null;
  targetVehicleId?: string | null;
};

export type DsvBatchAssignmentResult = {
  assignmentResults: DsvAssignmentResult[];
  routePlanId: string | null;
};

export type DsvDriverCommandInput = Omit<DsvAssignmentCommandBaseInput, 'actor' | 'shopDomain'> & DriverRouteAccessScope & {
  commandId: string;
};

export type DsvAssignmentCommandName =
  | 'acquireSellerOrder'
  | 'reassignSellerOrder'
  | 'releaseSellerOrder'
  | 'unassignSellerOrder';

export type DsvAssignmentResult = {
  assignmentStatus: 'ASSIGNED' | 'UNASSIGNED';
  auditEventId: string;
  commandId: string;
  etaStatus: 'FAILED' | 'NOT_REQUIRED' | 'PENDING';
  newRouteVersionId: string;
  previousRouteVersionId: string | null;
  receiptId: string;
  routePlanId: string | null;
  sellerOrderId: string;
};

export class DsvAssignmentCommandError extends Error {
  constructor(readonly code: DsvAssignmentCommandErrorCode, message: string = code) {
    super(message);
    this.name = 'DsvAssignmentCommandError';
  }
}

export type DsvAssignmentCommandErrorCode =
  | 'COMMAND_IN_PROGRESS'
  | 'DUPLICATE_ACTIVE_DELIVERY'
  | 'IDEMPOTENCY_PAYLOAD_MISMATCH'
  | 'SELLER_ORDER_ALREADY_ACQUIRED'
  | 'SELLER_ORDER_ASSIGNMENT_CHANGED'
  | 'SELLER_ORDER_NOT_FOUND'
  | 'SELLER_ORDER_ROUTE_SCOPE_REJECTED'
  | 'SELLER_ORDER_TARGET_VEHICLE_REQUIRED'
  | 'SELLER_ORDER_TRANSFER_CLOSED';

type ClaimedCommand = { receiptId: string } | { result: DsvAssignmentResult };

type MovementPlan = {
  assignmentStatus: 'ASSIGNED' | 'UNASSIGNED';
  etaStatus: 'FAILED' | 'NOT_REQUIRED' | 'PENDING';
  previousRoutePlanId: string | null;
  previousRouteVersionId: string | null;
  routes: RouteGroupingDraftRouteInput[];
  targetRoutePlanId: string | null;
};

type RouteOwner = RouteGroupingChildDto & { currentVersionId: string | null };
type AffectedRouteVersion = { driverId: string | null; routePlanId: string | null; routeVersionId: string };

const transactionOptions = { maxWait: 20_000, timeout: 30_000 } as const;

export class DsvAssignmentCommandService {
  constructor(
    private readonly prisma: DsvAssignmentPrismaClient,
    private readonly routeGroupingService: DsvAssignmentRouteGroupingService,
    private readonly routeOptimizationScheduler?: DsvRouteOptimizationSchedulerPort,
  ) {}

  async reassignMany(input: DsvAdminBatchReassignInput): Promise<DsvBatchAssignmentResult> {
    const shop = await this.prisma.shop.findUnique({
      select: { id: true },
      where: appScopedShopWhere({ shopDomain: normalizeShopDomain(input.shopDomain) }),
    });
    if (shop === null) throw new DsvAssignmentCommandError('SELLER_ORDER_NOT_FOUND');

    const commands = input.items.map((item) => {
      const commandInput: DsvAdminReassignInput = {
        actor: input.actor,
        commandId: item.commandId,
        expectedVersion: item.expectedVersion,
        reason: input.reason,
        sellerOrderId: item.sellerOrderId,
        shopDomain: input.shopDomain,
        targetDriverId: input.targetDriverId,
        ...(input.targetRoutePlanId === undefined ? {} : { targetRoutePlanId: input.targetRoutePlanId }),
        ...(input.targetVehicleId === undefined ? {} : { targetVehicleId: input.targetVehicleId }),
      };
      return {
        input: commandInput,
        payloadHash: sha256CanonicalJson(assignmentPayload('reassignSellerOrder', commandInput)),
      };
    });

    const execution = await this.prisma.$transaction(async (tx) => {
      const claims: ClaimedCommand[] = [];
      for (const command of commands) {
        await lockAssignmentCommand(tx, shop.id, command.input.commandId);
        claims.push(await this.claimCommand(
          tx,
          shop.id,
          'reassignSellerOrder',
          command.input,
          command.payloadHash,
        ));
      }
      const replayed = claims.flatMap((claim) => 'result' in claim ? [claim.result] : []);
      if (replayed.length === claims.length) {
        return { assignmentResults: replayed, routePlanIds: [] as Array<string | null>, scheduleOptimization: false };
      }
      if (replayed.length > 0) throw new DsvAssignmentCommandError('SELLER_ORDER_ASSIGNMENT_CHANGED');

      const lockedOrders: Array<{ currentRouteVersionId: string | null }> = [];
      for (const command of commands) lockedOrders.push(await this.lockSellerOrder(tx, shop.id, command.input.sellerOrderId));
      const firstOrder = lockedOrders[0];
      const firstCommand = commands[0];
      if (firstOrder === undefined || firstCommand === undefined) throw new DsvAssignmentCommandError('SELLER_ORDER_NOT_FOUND');
      const grouping = await this.loadGroupingForSellerOrder(
        tx,
        shop.id,
        input.shopDomain,
        firstCommand.input.sellerOrderId,
        firstOrder.currentRouteVersionId,
      );
      const owners: RouteOwner[] = [];
      for (const [index, command] of commands.entries()) {
        const order = lockedOrders[index];
        if (order === undefined) throw new DsvAssignmentCommandError('SELLER_ORDER_NOT_FOUND');
        assertExpectedVersion(command.input.expectedVersion, order.currentRouteVersionId);
        const owner = await this.requireOwner(tx, command.input.sellerOrderId, grouping, order.currentRouteVersionId);
        assertTransferOpen(owner);
        owners.push(owner);
      }

      const target = await this.resolveAdminTargetRoute(tx, grouping, shop.id, firstCommand.input);
      if (target.driverId !== input.targetDriverId) throw new DsvAssignmentCommandError('SELLER_ORDER_ROUTE_SCOPE_REJECTED');
      assertTransferOpen(target);
      if (target.routePlanId === null) {
        await this.assertNewRouteTargetVehicle(tx, shop.id, input.targetDriverId, input.targetVehicleId);
      } else {
        await this.assertTargetVehicle(tx, shop.id, target, input.targetVehicleId);
      }

      const sellerOrderIds = commands.map((command) => command.input.sellerOrderId);
      const saved = await this.saveDraft(tx, {
        expectedUpdatedAt: grouping.updatedAt,
        groupingId: grouping.id,
        routes: moveOrdersToDriverRoute(grouping, sellerOrderIds, target, input.targetVehicleId),
        shopDomain: input.shopDomain,
      });
      if (saved === null) throw new DsvAssignmentCommandError('SELLER_ORDER_NOT_FOUND');

      const results: DsvAssignmentResult[] = [];
      for (const [index, command] of commands.entries()) {
        const order = lockedOrders[index];
        const owner = owners[index];
        const claim = claims[index];
        if (order === undefined || owner === undefined || claim === undefined || 'result' in claim) {
          throw new DsvAssignmentCommandError('SELLER_ORDER_ASSIGNMENT_CHANGED');
        }
        const nextOwner = await this.requireOwner(tx, command.input.sellerOrderId, saved, null);
        if (nextOwner.driverId !== input.targetDriverId || nextOwner.currentVersionId === null) {
          throw new DsvAssignmentCommandError('SELLER_ORDER_ASSIGNMENT_CHANGED');
        }
        await tx.order.updateMany({
          data: { currentRouteVersionId: nextOwner.currentVersionId },
          where: {
            currentRouteVersionId: order.currentRouteVersionId,
            id: command.input.sellerOrderId,
            shopId: shop.id,
          },
        }).then((updated) => {
          if (updated.count !== 1) throw new DsvAssignmentCommandError('SELLER_ORDER_ASSIGNMENT_CHANGED');
        });
        const movement: MovementPlan = {
          assignmentStatus: 'ASSIGNED',
          etaStatus: 'PENDING',
          previousRoutePlanId: owner.routePlanId,
          previousRouteVersionId: owner.currentVersionId,
          routes: [],
          targetRoutePlanId: nextOwner.routePlanId,
        };
        results.push(await this.completeCommand(
          tx,
          shop.id,
          'reassignSellerOrder',
          command.input,
          command.payloadHash,
          claim.receiptId,
          movement,
          {
            assignmentStatus: 'ASSIGNED',
            auditEventId: '',
            commandId: command.input.commandId,
            etaStatus: 'PENDING',
            newRouteVersionId: nextOwner.currentVersionId,
            previousRouteVersionId: owner.currentVersionId,
            receiptId: claim.receiptId,
            routePlanId: nextOwner.routePlanId,
            sellerOrderId: command.input.sellerOrderId,
          },
        ));
      }

      const routePlanIds = [...new Set([...owners.map((owner) => owner.routePlanId), results[0]?.routePlanId ?? null])];
      const affectedRouteVersions: AffectedRouteVersion[] = [];
      for (const routePlanId of routePlanIds) {
        const version = await tx.routeGroupingChildVersion.findFirst({
          orderBy: { updatedAt: 'desc' },
          select: { driverId: true, id: true, routePlanId: true },
          where: { groupingId: grouping.id, routePlanId, shopId: shop.id, status: 'CURRENT', supersededAt: null },
        });
        if (version !== null) affectedRouteVersions.push({ driverId: version.driverId, routePlanId: version.routePlanId, routeVersionId: version.id });
      }
      await this.invalidateAffectedEtas(tx, affectedRouteVersions);
      return { assignmentResults: results, routePlanIds, scheduleOptimization: true };
    }, transactionOptions).catch((error: unknown) => {
      if (isPrismaTransactionConflict(error)) throw new DsvAssignmentCommandError('SELLER_ORDER_ASSIGNMENT_CHANGED');
      throw error;
    });

    if (execution.scheduleOptimization) {
      try {
        this.routeOptimizationScheduler?.schedule({ routePlanIds: execution.routePlanIds, shopDomain: input.shopDomain });
      } catch {
        // Assignment success must not depend on background route optimization scheduling.
      }
    }
    return {
      assignmentResults: execution.assignmentResults,
      routePlanId: execution.assignmentResults[0]?.routePlanId ?? input.targetRoutePlanId ?? null,
    };
  }

  async unassign(input: DsvAssignmentCommandBaseInput): Promise<DsvAssignmentResult> {
    return this.execute({
      commandName: 'unassignSellerOrder',
      input,
      payload: assignmentPayload('unassignSellerOrder', input),
      plan: async (tx, grouping, _shopId, currentRouteVersionId) => {
        const source = await this.requireOwner(tx, input.sellerOrderId, grouping, currentRouteVersionId);
        assertTransferOpen(source);
        const target = firstUnassignedRoute(grouping) ?? null;
        return {
          assignmentStatus: 'UNASSIGNED',
          etaStatus: 'NOT_REQUIRED',
          previousRoutePlanId: source.routePlanId,
          previousRouteVersionId: source.currentVersionId,
          routes: target === null
            ? releaseToNewUnassignedRoute(grouping, input.sellerOrderId, source)
            : moveOrder(grouping, input.sellerOrderId, source, target),
          targetRoutePlanId: target?.routePlanId ?? null,
        };
      },
    });
  }

  async reassign(input: DsvAdminReassignInput): Promise<DsvAssignmentResult> {
    return this.execute({
      commandName: 'reassignSellerOrder',
      input,
      payload: assignmentPayload('reassignSellerOrder', input),
      plan: async (tx, grouping, shopId, currentRouteVersionId) => {
        const source = await this.requireOwner(tx, input.sellerOrderId, grouping, currentRouteVersionId);
        const target = await this.resolveAdminTargetRoute(tx, grouping, shopId, input);
        if (target.driverId !== input.targetDriverId) throw new DsvAssignmentCommandError('SELLER_ORDER_ROUTE_SCOPE_REJECTED');
        assertTransferOpen(source);
        assertTransferOpen(target);
        if (target.routePlanId === null) {
          await this.assertNewRouteTargetVehicle(tx, shopId, input.targetDriverId, input.targetVehicleId);
        } else {
          await this.assertTargetVehicle(tx, shopId, target, input.targetVehicleId);
        }
        return {
          assignmentStatus: 'ASSIGNED',
          etaStatus: 'PENDING',
          previousRoutePlanId: source.routePlanId,
          previousRouteVersionId: source.currentVersionId,
          routes: target.routePlanId === null
            ? moveOrderToNewDriverRoute(grouping, input.sellerOrderId, source, target, input.targetVehicleId, input.targetSequence)
            : moveOrder(grouping, input.sellerOrderId, source, target, input.targetSequence),
          targetRoutePlanId: target.routePlanId,
        };
      },
    });
  }

  async release(input: DsvDriverCommandInput): Promise<DsvAssignmentResult> {
    return this.execute({
      commandName: 'releaseSellerOrder',
      input: driverCommandBase(input),
      payload: assignmentPayload('releaseSellerOrder', input),
      plan: async (tx, grouping, _shopId, currentRouteVersionId) => {
        const source = await this.requireOwner(tx, input.sellerOrderId, grouping, currentRouteVersionId);
        if (source.routePlanId !== input.routePlanId || source.driverId !== input.driverId) {
          throw new DsvAssignmentCommandError('SELLER_ORDER_ROUTE_SCOPE_REJECTED');
        }
        assertTransferOpen(source);
        const target = firstUnassignedRoute(grouping) ?? null;
        return {
          assignmentStatus: 'UNASSIGNED',
          etaStatus: 'NOT_REQUIRED',
          previousRoutePlanId: source.routePlanId,
          previousRouteVersionId: source.currentVersionId,
          routes: target === null
            ? releaseToNewUnassignedRoute(grouping, input.sellerOrderId, source)
            : moveOrder(grouping, input.sellerOrderId, source, target),
          targetRoutePlanId: target?.routePlanId ?? null,
        };
      },
    });
  }

  async acquire(input: DsvDriverCommandInput): Promise<DsvAssignmentResult> {
    return this.execute({
      commandName: 'acquireSellerOrder',
      input: driverCommandBase(input),
      payload: assignmentPayload('acquireSellerOrder', input),
      plan: async (tx, grouping, shopId, currentRouteVersionId) => {
        const target = requireDriverRoute(grouping, input);
        assertTransferOpen(target);
        await this.assertTargetVehicle(tx, shopId, target, null);
        const source = await this.requireOwner(tx, input.sellerOrderId, grouping, currentRouteVersionId);
        if (source.driverId !== null) throw new DsvAssignmentCommandError('SELLER_ORDER_ALREADY_ACQUIRED');
        assertTransferOpen(source);
        return {
          assignmentStatus: 'ASSIGNED',
          etaStatus: 'PENDING',
          previousRoutePlanId: source.routePlanId,
          previousRouteVersionId: source.currentVersionId,
          routes: moveOrder(grouping, input.sellerOrderId, source, target),
          targetRoutePlanId: target.routePlanId,
        };
      },
    });
  }

  private async execute(input: {
    commandName: DsvAssignmentCommandName;
    input: DsvAssignmentCommandBaseInput;
    payload: unknown;
    plan: (
      tx: DsvAssignmentTransactionClient,
      grouping: RouteGroupingDetailDto,
      shopId: string,
      currentRouteVersionId: string | null,
    ) => Promise<MovementPlan>;
  }): Promise<DsvAssignmentResult> {
    const shop = await this.prisma.shop.findUnique({
      select: { id: true },
      where: appScopedShopWhere({ shopDomain: normalizeShopDomain(input.input.shopDomain) }),
    });
    if (shop === null) throw new DsvAssignmentCommandError('SELLER_ORDER_NOT_FOUND');
    const payloadHash = sha256CanonicalJson(input.payload);
    const execution = await this.prisma.$transaction(async (tx) => {
      await lockAssignmentCommand(tx, shop.id, input.input.commandId);
      const claim = await this.claimCommand(tx, shop.id, input.commandName, input.input, payloadHash);
      if ('result' in claim) {
        return {
          result: claim.result,
          routePlanIds: [] as Array<string | null>,
          scheduleOptimization: false,
        };
      }

      const order = await this.lockSellerOrder(tx, shop.id, input.input.sellerOrderId);
      const grouping = await this.loadGroupingForSellerOrder(tx, shop.id, input.input.shopDomain, input.input.sellerOrderId, order.currentRouteVersionId);
      assertExpectedVersion(input.input.expectedVersion, order.currentRouteVersionId);
      const movement = await input.plan(tx, grouping, shop.id, order.currentRouteVersionId);
      const saved = await this.saveDraft(tx, {
        expectedUpdatedAt: grouping.updatedAt,
        groupingId: grouping.id,
        routes: movement.routes,
        shopDomain: input.input.shopDomain,
      });
      if (saved === null) throw new DsvAssignmentCommandError('SELLER_ORDER_NOT_FOUND');
      const nextOwner = await this.requireOwner(tx, input.input.sellerOrderId, saved, null);
      if (movement.assignmentStatus === 'ASSIGNED' && nextOwner.driverId === null) {
        throw new DsvAssignmentCommandError('SELLER_ORDER_ASSIGNMENT_CHANGED');
      }
      if (movement.assignmentStatus === 'UNASSIGNED' && nextOwner.driverId !== null) {
        throw new DsvAssignmentCommandError('SELLER_ORDER_ASSIGNMENT_CHANGED');
      }
      const newRouteVersionId = nextOwner.currentVersionId;
      if (newRouteVersionId === null) throw new DsvAssignmentCommandError('SELLER_ORDER_ASSIGNMENT_CHANGED');
      await tx.order.updateMany({
        data: { currentRouteVersionId: newRouteVersionId },
        where: { currentRouteVersionId: order.currentRouteVersionId, id: input.input.sellerOrderId, shopId: shop.id },
      }).then((updated) => {
        if (updated.count !== 1) throw new DsvAssignmentCommandError('SELLER_ORDER_ASSIGNMENT_CHANGED');
      });
      const affectedRouteVersions = await this.readAffectedRouteVersions(tx, grouping.id, shop.id, {
        ...movement,
        targetRoutePlanId: movement.targetRoutePlanId ?? nextOwner.routePlanId,
      });
      await this.invalidateAffectedEtas(tx, affectedRouteVersions);

      const resultWithoutAudit = {
        assignmentStatus: movement.assignmentStatus,
        auditEventId: '',
        commandId: input.input.commandId,
        etaStatus: movement.etaStatus,
        newRouteVersionId,
        previousRouteVersionId: movement.previousRouteVersionId,
        receiptId: claim.receiptId,
        routePlanId: nextOwner.routePlanId,
        sellerOrderId: input.input.sellerOrderId,
      } satisfies DsvAssignmentResult;
      const result = await this.completeCommand(
        tx,
        shop.id,
        input.commandName,
        input.input,
        payloadHash,
        claim.receiptId,
        movement,
        resultWithoutAudit,
      );
      return {
        result,
        routePlanIds: [movement.previousRoutePlanId, nextOwner.routePlanId],
        scheduleOptimization: true,
      };
    }, transactionOptions).catch((error: unknown) => {
      if (isPrismaTransactionConflict(error)) {
        throw new DsvAssignmentCommandError('SELLER_ORDER_ASSIGNMENT_CHANGED');
      }
      throw error;
    });
    if (execution.scheduleOptimization) {
      try {
        this.routeOptimizationScheduler?.schedule({
          routePlanIds: execution.routePlanIds,
          shopDomain: input.input.shopDomain,
        });
      } catch {
        // Assignment success must not depend on background route optimization scheduling.
      }
    }
    return execution.result;
  }

  private async claimCommand(
    tx: DsvAssignmentTransactionClient,
    shopId: string,
    commandName: DsvAssignmentCommandName,
    input: DsvAssignmentCommandBaseInput,
    payloadHash: string,
  ): Promise<ClaimedCommand> {
    const existing = await tx.dsvCommandReceipt.findUnique({
      where: { shopId_commandName_commandId: { commandId: input.commandId, commandName, shopId } },
    });
    if (existing !== null) {
      if (existing.payloadHash !== payloadHash) throw new DsvAssignmentCommandError('IDEMPOTENCY_PAYLOAD_MISMATCH');
      if (existing.status === 'STARTED') throw new DsvAssignmentCommandError('COMMAND_IN_PROGRESS');
      const replayResult = parseAssignmentResultBody(existing.responseBodyRef);
      if (existing.status === 'SUCCEEDED' && replayResult !== null) {
        return { result: replayResult };
      }
      throw new DsvAssignmentCommandError('SELLER_ORDER_ASSIGNMENT_CHANGED');
    }
    const receipt = await tx.dsvCommandReceipt.create({
      data: {
        actorId: input.actor.actorId ?? null,
        actorType: input.actor.actorType,
        commandId: input.commandId,
        commandName,
        payloadHash,
        principalType: input.actor.principalType,
        requestId: input.actor.requestId ?? input.commandId,
        sellerOrderId: input.sellerOrderId,
        shopId,
        status: 'STARTED',
      },
      select: { id: true },
    });
    return { receiptId: receipt.id };
  }

  private async completeCommand(
    tx: DsvAssignmentTransactionClient,
    shopId: string,
    commandName: DsvAssignmentCommandName,
    input: DsvAssignmentCommandBaseInput,
    payloadHash: string,
    receiptId: string,
    movement: MovementPlan,
    result: DsvAssignmentResult,
  ): Promise<DsvAssignmentResult> {
    const order = await tx.order.findFirst({
      select: { customerId: true, destinationId: true },
      where: { id: input.sellerOrderId, shopId },
    });
    if (order === null) throw new DsvAssignmentCommandError('SELLER_ORDER_NOT_FOUND');
    const audit = await tx.dsvAuditEvent.create({
      data: {
        actorId: input.actor.actorId ?? null,
        actorType: input.actor.actorType,
        afterSnapshotRef: canonicalJson({ result }),
        beforeSnapshotRef: canonicalJson({
          previousRoutePlanId: movement.previousRoutePlanId,
          previousRouteVersionId: movement.previousRouteVersionId,
        }),
        commandReceiptId: receiptId,
        customerId: order.customerId,
        destinationId: order.destinationId,
        entityId: input.sellerOrderId,
        entityType: 'SellerOrder',
        eventType: commandName,
        nextRoutePlanId: result.routePlanId,
        nextRouteVersionId: result.newRouteVersionId,
        previousRoutePlanId: movement.previousRoutePlanId,
        previousRouteVersionId: movement.previousRouteVersionId,
        principalType: input.actor.principalType,
        reason: input.reason ?? null,
        redactedDiff: {
          assignmentStatus: result.assignmentStatus,
          commandId: input.commandId,
          etaStatus: result.etaStatus,
          reasonPresent: input.reason !== undefined && input.reason !== null && input.reason.trim() !== '',
        },
        requestId: input.actor.requestId ?? input.commandId,
        sellerOrderId: input.sellerOrderId,
        shopId,
      },
      select: { id: true },
    });
    const completed: DsvAssignmentResult = { ...result, auditEventId: audit.id };
    const updated = await tx.dsvCommandReceipt.updateMany({
      data: {
        completedAt: new Date(),
        nextRoutePlanId: result.routePlanId,
        nextRouteVersionId: result.newRouteVersionId,
        previousRoutePlanId: movement.previousRoutePlanId,
        previousRouteVersionId: movement.previousRouteVersionId,
        responseBodyRef: canonicalJson(completed),
        responseStatus: 200,
        resultEntityId: input.sellerOrderId,
        resultEntityType: 'SellerOrder',
        status: 'SUCCEEDED',
      },
      where: { id: receiptId, payloadHash, shopId, status: 'STARTED' },
    });
    if (updated.count !== 1) throw new DsvAssignmentCommandError('SELLER_ORDER_ASSIGNMENT_CHANGED');
    return completed;
  }

  private async loadGroupingForSellerOrder(
    tx: DsvAssignmentTransactionClient,
    shopId: string,
    shopDomain: string,
    sellerOrderId: string,
    currentRouteVersionId: string | null,
  ): Promise<RouteGroupingDetailDto> {
    const groupingRef = currentRouteVersionId === null
      ? await tx.routeGroupingOrder.findFirst({
        orderBy: { createdAt: 'desc' },
        select: { groupingId: true },
        where: { orderId: sellerOrderId, shopId },
      })
      : await tx.routeGroupingChildVersion.findFirst({
        select: { groupingId: true },
        where: {
          id: currentRouteVersionId,
          shopId,
          status: 'CURRENT',
          supersededAt: null,
        },
      });
    if (groupingRef === null) throw new DsvAssignmentCommandError('SELLER_ORDER_NOT_FOUND');
    const grouping = await this.routeGroupingService.getGrouping({ groupingId: groupingRef.groupingId, shopDomain });
    if (grouping === null) throw new DsvAssignmentCommandError('SELLER_ORDER_NOT_FOUND');
    return withUnassignedAssignments(grouping);
  }

  private async requireOwner(
    tx: DsvAssignmentTransactionClient,
    sellerOrderId: string,
    grouping: RouteGroupingDetailDto,
    currentRouteVersionId: string | null,
  ): Promise<RouteOwner> {
    if (currentRouteVersionId === null && assignmentMap(grouping).has(sellerOrderId)) {
      const groupedOwner = grouping.children.find((child) => child.orderIds.includes(sellerOrderId));
      if (groupedOwner === undefined) return nullRouteOwner(grouping, sellerOrderId);
    }
    const owners = grouping.children.filter((child) => child.orderIds.includes(sellerOrderId));
    if (owners.length === 0) throw new DsvAssignmentCommandError('SELLER_ORDER_NOT_FOUND');
    if (owners.length > 1) throw new DsvAssignmentCommandError('DUPLICATE_ACTIVE_DELIVERY');
    const owner = owners[0];
    if (owner === undefined) throw new DsvAssignmentCommandError('SELLER_ORDER_NOT_FOUND');
    const currentVersionId = currentRouteVersionId ?? await this.currentChildVersionId(tx, grouping, owner);
    if (currentVersionId !== null && owner.routePlanId !== null) {
      const currentChild = await tx.routeGroupingChildVersion.findFirst({
        select: { routePlanId: true },
        where: { groupingId: grouping.id, id: currentVersionId, status: 'CURRENT', supersededAt: null },
      });
      if (currentChild !== null && currentChild.routePlanId !== owner.routePlanId) {
        throw new DsvAssignmentCommandError('SELLER_ORDER_ASSIGNMENT_CHANGED');
      }
    }
    return { ...owner, currentVersionId };
  }

  private async currentChildVersionId(tx: DsvAssignmentTransactionClient, grouping: RouteGroupingDetailDto, child: RouteGroupingChildDto): Promise<string | null> {
    if (child.routePlanId === null) {
      const current = await tx.routeGroupingChildVersion.findFirst({
        select: { id: true },
        where: {
          groupingId: grouping.id,
          routePlanId: null,
          status: 'CURRENT',
          supersededAt: null,
          updatedAt: new Date(child.updatedAt),
        },
      });
      return current?.id ?? null;
    }
    const current = await tx.routeGroupingChildVersion.findFirst({
      select: { id: true },
      where: { groupingId: grouping.id, routePlanId: child.routePlanId, status: 'CURRENT', supersededAt: null },
    });
    return current?.id ?? null;
  }

  private async assertTargetVehicle(tx: DsvAssignmentTransactionClient, shopId: string, route: RouteGroupingChildDto, targetVehicleId: string | null | undefined): Promise<void> {
    if (route.routePlanId === null) throw new DsvAssignmentCommandError('SELLER_ORDER_TARGET_VEHICLE_REQUIRED');
    const routePlan = await tx.routePlan.findFirst({
      select: { vehicleId: true },
      where: { id: route.routePlanId, shopId },
    });
    const routeVehicleId = routePlan?.vehicleId ?? null;
    if (routeVehicleId === null && (targetVehicleId === undefined || targetVehicleId === null)) {
      throw new DsvAssignmentCommandError('SELLER_ORDER_TARGET_VEHICLE_REQUIRED');
    }
    if (routeVehicleId !== null && targetVehicleId !== undefined && targetVehicleId !== null && routeVehicleId !== targetVehicleId) {
      throw new DsvAssignmentCommandError('SELLER_ORDER_TARGET_VEHICLE_REQUIRED');
    }
  }

  private async assertNewRouteTargetVehicle(
    tx: DsvAssignmentTransactionClient,
    shopId: string,
    targetDriverId: string,
    targetVehicleId: string | null | undefined,
  ): Promise<void> {
    if (targetVehicleId === undefined || targetVehicleId === null) {
      throw new DsvAssignmentCommandError('SELLER_ORDER_TARGET_VEHICLE_REQUIRED');
    }
    const [vehicle, assignment] = await Promise.all([
      tx.vehicle.findFirst({
        select: { id: true },
        where: { id: targetVehicleId, shopId },
      }),
      tx.dsvVehicleDriverAssignment.findFirst({
        select: { id: true },
        where: { driverId: targetDriverId, shopId, vehicleId: targetVehicleId },
      }),
    ]);
    if (vehicle === null || assignment === null) {
      throw new DsvAssignmentCommandError('SELLER_ORDER_TARGET_VEHICLE_REQUIRED');
    }
  }

  private async resolveAdminTargetRoute(
    tx: DsvAssignmentTransactionClient,
    grouping: RouteGroupingDetailDto,
    shopId: string,
    input: DsvAdminReassignInput,
  ): Promise<RouteGroupingChildDto> {
    if (input.targetRoutePlanId !== undefined && input.targetRoutePlanId !== null) {
      return requireTargetRoute(grouping, input.targetRoutePlanId);
    }
    const existingReadyRoute = grouping.children
      .filter((child) => child.driverId === input.targetDriverId && child.displayStatus === 'READY' && child.routePlanId !== null)
      .sort((left, right) => (left.sortOrder ?? Number.MAX_SAFE_INTEGER) - (right.sortOrder ?? Number.MAX_SAFE_INTEGER))[0];
    if (existingReadyRoute !== undefined) return existingReadyRoute;
    await this.assertNewRouteTargetVehicle(tx, shopId, input.targetDriverId, input.targetVehicleId);
    return newDriverRoute(grouping, input.targetDriverId);
  }

  private async lockSellerOrder(
    tx: DsvAssignmentTransactionClient,
    shopId: string,
    sellerOrderId: string,
  ): Promise<{ currentRouteVersionId: string | null }> {
    await lockSellerOrder(tx, shopId, sellerOrderId);
    const order = await tx.order.findFirst({
      select: { currentRouteVersionId: true },
      where: { id: sellerOrderId, shopId },
    });
    if (order === null) throw new DsvAssignmentCommandError('SELLER_ORDER_NOT_FOUND');
    return order;
  }

  private async saveDraft(
    tx: DsvAssignmentTransactionClient,
    input: Parameters<RouteGroupingService['saveDraft']>[0],
  ): Promise<RouteGroupingDetailDto | null> {
    try {
      if (this.routeGroupingService.saveDraftInTransaction !== undefined) {
        return await this.routeGroupingService.saveDraftInTransaction(tx, input);
      }
      return await this.routeGroupingService.saveDraft(input);
    } catch (error: unknown) {
      if (error instanceof RouteGroupingConflictError) {
        throw new DsvAssignmentCommandError('SELLER_ORDER_ASSIGNMENT_CHANGED');
      }
      if (error instanceof RouteGroupingValidationError) {
        throw new DsvAssignmentCommandError('SELLER_ORDER_ASSIGNMENT_CHANGED', error.blockers.join(', '));
      }
      throw error;
    }
  }

  private async invalidateAffectedEtas(
    tx: DsvAssignmentTransactionClient,
    affectedRouteVersions: AffectedRouteVersion[],
  ): Promise<void> {
    for (const route of affectedRouteVersions) {
      if (route.routePlanId === null) continue;
      const routeEtaStatus = route.driverId === null ? 'NOT_REQUIRED' : 'PENDING';
      await tx.routePlanStop.updateMany({
        data: {
          estimatedArrivalAt: null,
          etaCalculatedAt: null,
          etaFailureCode: null,
          etaFailureMessage: null,
          etaInputRouteVersionId: route.routeVersionId,
          etaSource: null,
          etaStatus: routeEtaStatus,
        },
        where: { routePlanId: route.routePlanId },
      });
    }
  }

  private async readAffectedRouteVersions(
    tx: DsvAssignmentTransactionClient,
    groupingId: string,
    shopId: string,
    movement: MovementPlan,
  ): Promise<AffectedRouteVersion[]> {
    const routePlanIds = [...new Set([movement.previousRoutePlanId, movement.targetRoutePlanId])];
    const versions: AffectedRouteVersion[] = [];
    for (const routePlanId of routePlanIds) {
      const row = await tx.routeGroupingChildVersion.findFirst({
        orderBy: { updatedAt: 'desc' },
        select: { driverId: true, id: true, routePlanId: true },
        where: {
          groupingId,
          routePlanId,
          shopId,
          status: 'CURRENT',
          supersededAt: null,
        },
      });
      if (row !== null) versions.push({ driverId: row.driverId, routePlanId: row.routePlanId, routeVersionId: row.id });
    }
    return versions;
  }
}

function driverCommandBase(input: DsvDriverCommandInput): DsvAssignmentCommandBaseInput {
  return {
    actor: {
      actorId: input.driverId,
      actorType: 'DRIVER',
      principalType: 'DRIVER',
      requestId: input.commandId,
    },
    commandId: input.commandId,
    sellerOrderId: input.sellerOrderId,
    shopDomain: input.shopDomain,
    ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }),
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  };
}

function assertExpectedVersion(expectedVersion: string | null | undefined, currentRouteVersionId: string | null): void {
  if (expectedVersion === undefined || expectedVersion === null) return;
  const actual = currentRouteVersionId ?? 'UNASSIGNED';
  if (expectedVersion !== actual) throw new DsvAssignmentCommandError('SELLER_ORDER_ASSIGNMENT_CHANGED');
}

function assertTransferOpen(route: RouteGroupingChildDto): void {
  if (route.displayStatus !== 'READY') throw new DsvAssignmentCommandError('SELLER_ORDER_TRANSFER_CLOSED');
}

function requireDriverRoute(grouping: RouteGroupingDetailDto, input: Pick<DriverRouteAccessScope, 'driverId' | 'routePlanId'>): RouteGroupingChildDto {
  const route = grouping.children.find((child) => child.routePlanId === input.routePlanId);
  if (route === undefined || route.driverId !== input.driverId) throw new DsvAssignmentCommandError('SELLER_ORDER_ROUTE_SCOPE_REJECTED');
  return route;
}

function requireTargetRoute(grouping: RouteGroupingDetailDto, routePlanId: string): RouteGroupingChildDto {
  const target = grouping.children.find((child) => child.routePlanId === routePlanId);
  if (target === undefined) throw new DsvAssignmentCommandError('SELLER_ORDER_NOT_FOUND');
  return target;
}

function newDriverRoute(grouping: RouteGroupingDetailDto, driverId: string): RouteGroupingChildDto {
  const sortOrder = nextSortOrder(grouping.children);
  return {
    childVersion: 0,
    color: null,
    displayStatus: 'READY',
    driverId,
    driverName: null,
    notificationStatus: 'NOT_REQUIRED',
    orderIds: [],
    routeGeometry: null,
    routeIdx: sortOrder,
    routeMetrics: null,
    routePlan: null,
    routePlanId: null,
    routeStopPoints: [],
    sortOrder,
    stops: [],
    stopsCount: 0,
    updatedAt: grouping.updatedAt,
  };
}

function firstUnassignedRoute(grouping: RouteGroupingDetailDto): RouteGroupingChildDto | undefined {
  return grouping.children
    .filter((child) => child.driverId === null && child.displayStatus === 'READY')
    .sort((left, right) => (left.sortOrder ?? Number.MAX_SAFE_INTEGER) - (right.sortOrder ?? Number.MAX_SAFE_INTEGER))[0];
}

function moveOrder(
  grouping: RouteGroupingDetailDto,
  orderId: string,
  source: RouteGroupingChildDto,
  target: RouteGroupingChildDto,
  targetSequence?: number | null,
): RouteGroupingDraftRouteInput[] {
  return grouping.children.map((child) => {
    if (source.routePlanId === null && child.routePlanId === target.routePlanId) {
      const orderIds = child.orderIds.filter((candidate) => candidate !== orderId);
      return childToDraftRoute(child, placeOrderInRoute(orderIds, orderId, targetSequence));
    }
    if (child.routePlanId === source.routePlanId) {
      return childToDraftRoute(child, child.orderIds.filter((candidate) => candidate !== orderId));
    }
    if (child.routePlanId === target.routePlanId) {
      const orderIds = child.orderIds.filter((candidate) => candidate !== orderId);
      return childToDraftRoute(child, placeOrderInRoute(orderIds, orderId, targetSequence));
    }
    return childToDraftRoute(child, child.orderIds);
  });
}

function moveOrderToNewDriverRoute(
  grouping: RouteGroupingDetailDto,
  orderId: string,
  source: RouteGroupingChildDto,
  target: RouteGroupingChildDto,
  targetVehicleId: string | null | undefined,
  targetSequence?: number | null,
): RouteGroupingDraftRouteInput[] {
  return [
    ...grouping.children.map((child) => childToDraftRoute(
      child,
      child.routePlanId === source.routePlanId ? child.orderIds.filter((candidate) => candidate !== orderId) : child.orderIds,
    )),
    {
      branchId: null,
      driverId: target.driverId,
      label: null,
      orderIds: placeOrderInRoute([], orderId, targetSequence),
      routePlanId: null,
      sortOrder: target.sortOrder ?? nextSortOrder(grouping.children),
      tempId: `driver:${target.driverId ?? 'unassigned'}:${target.sortOrder ?? nextSortOrder(grouping.children)}`,
      vehicleId: targetVehicleId ?? null,
    },
  ];
}

function moveOrdersToDriverRoute(
  grouping: RouteGroupingDetailDto,
  orderIds: string[],
  target: RouteGroupingChildDto,
  targetVehicleId: string | null | undefined,
): RouteGroupingDraftRouteInput[] {
  const selected = new Set(orderIds);
  const routes = grouping.children.map((child) => {
    const remaining = child.orderIds.filter((orderId) => !selected.has(orderId));
    return childToDraftRoute(
      child,
      child.routePlanId === target.routePlanId && target.routePlanId !== null
        ? [...remaining, ...orderIds]
        : remaining,
    );
  });
  if (target.routePlanId !== null) return routes;
  return [
    ...routes,
    {
      branchId: null,
      driverId: target.driverId,
      label: null,
      orderIds,
      routePlanId: null,
      sortOrder: target.sortOrder ?? nextSortOrder(grouping.children),
      tempId: `driver:${target.driverId ?? 'unassigned'}:${target.sortOrder ?? nextSortOrder(grouping.children)}`,
      vehicleId: targetVehicleId ?? null,
    },
  ];
}

function releaseToNewUnassignedRoute(
  grouping: RouteGroupingDetailDto,
  orderId: string,
  source: RouteGroupingChildDto,
): RouteGroupingDraftRouteInput[] {
  return [
    ...grouping.children.map((child) => childToDraftRoute(
      child,
      child.routePlanId === source.routePlanId ? child.orderIds.filter((candidate) => candidate !== orderId) : child.orderIds,
    )),
    {
      branchId: null,
      driverId: null,
      label: '미배정',
      orderIds: [orderId],
      routePlanId: null,
      sortOrder: nextSortOrder(grouping.children),
      tempId: 'unassigned',
    },
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
    ...(child.routePlanId === null ? { tempId: `child:${child.updatedAt}:${child.sortOrder ?? child.routeIdx ?? 'null-route'}` } : {}),
    ...(child.routeIdx === null ? {} : { routeIdx: child.routeIdx }),
    routePlanId: child.routePlanId,
    ...(child.sortOrder === null ? {} : { sortOrder: child.sortOrder }),
  };
}

function insertAtOneBasedSequence(orderIds: string[], orderId: string, sequence: number): string[] {
  const copy = [...orderIds];
  copy.splice(Math.max(0, Math.min(copy.length, sequence - 1)), 0, orderId);
  return copy;
}

function placeOrderInRoute(orderIds: string[], orderId: string, sequence: number | null | undefined): string[] {
  if (sequence === undefined || sequence === null) return [...orderIds, orderId];
  return insertAtOneBasedSequence(orderIds, orderId, sequence);
}

function nextSortOrder(children: RouteGroupingChildDto[]): number {
  return children.reduce((highest, child) => Math.max(highest, child.sortOrder ?? 0), 0) + 1;
}

function assignmentPayload(commandName: DsvAssignmentCommandName, input: unknown): unknown {
  return { commandName, input: stableAssignmentInput(input) };
}

function stableAssignmentInput(input: unknown): unknown {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return input;
  const record = input as Record<string, unknown>;
  const actor = record.actor;
  const stableActor = actor !== null && typeof actor === 'object' && !Array.isArray(actor)
    ? Object.fromEntries(Object.entries(actor as Record<string, unknown>).filter(([key]) => key !== 'requestId'))
    : actor;
  return {
    ...record,
    actor: stableActor,
  };
}

function sha256CanonicalJson(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortJson);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJson(entry)]),
  );
}

function parseAssignmentResultBody(value: string | null): DsvAssignmentResult | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value) as Partial<DsvAssignmentResult>;
    return typeof parsed.commandId === 'string'
      && typeof parsed.receiptId === 'string'
      && typeof parsed.sellerOrderId === 'string'
      && (parsed.assignmentStatus === 'ASSIGNED' || parsed.assignmentStatus === 'UNASSIGNED')
      ? parsed as DsvAssignmentResult
      : null;
  } catch {
    return null;
  }
}

function isPrismaTransactionConflict(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const record = error as { code?: unknown; meta?: { code?: unknown } };
  return record.code === 'P2034'
    || (record.code === 'P2010' && (record.meta?.code === '40P01' || record.meta?.code === '40001'));
}

async function lockAssignmentCommand(tx: Pick<DsvAssignmentTransactionClient, '$queryRaw'>, shopId: string, commandId: string): Promise<void> {
  await tx.$queryRaw<{ locked: number }[]>`WITH lock AS (SELECT pg_advisory_xact_lock(hashtextextended(${`dsv-assignment-command:${shopId}:${commandId}`}, 0))) SELECT 1 AS locked FROM lock`;
}

async function lockSellerOrder(tx: Pick<DsvAssignmentTransactionClient, '$queryRaw'>, shopId: string, sellerOrderId: string): Promise<void> {
  await tx.$queryRaw<{ id: string }[]>`SELECT id FROM orders WHERE id = ${sellerOrderId}::uuid AND "shopId" = ${shopId}::uuid FOR UPDATE`;
}

function normalizeShopDomain(value: string): string {
  return value.trim().toLowerCase();
}

function nullRouteOwner(grouping: RouteGroupingDetailDto, sellerOrderId: string): RouteOwner {
  return {
    childVersion: 0,
    color: null,
    currentVersionId: null,
    displayStatus: 'READY',
    driverId: null,
    driverName: null,
    notificationStatus: 'NOT_REQUIRED',
    orderIds: [sellerOrderId],
    routeGeometry: null,
    routeIdx: null,
    routeMetrics: null,
    routePlan: null,
    routePlanId: null,
    routeStopPoints: [],
    sortOrder: null,
    stops: [],
    stopsCount: 1,
    updatedAt: grouping.updatedAt,
  };
}

function withUnassignedAssignments(grouping: RouteGroupingDetailDto): RouteGroupingDetailDto {
  const routedOrderIds = new Set(grouping.children.flatMap((child) => child.orderIds));
  const unassignedOrderIds = grouping.assignments
    .map((assignment) => assignment.orderId)
    .filter((orderId) => !routedOrderIds.has(orderId));
  const firstUnassignedOrderId = unassignedOrderIds[0];
  if (firstUnassignedOrderId === undefined) return grouping;
  const route = {
    ...nullRouteOwner(grouping, firstUnassignedOrderId),
    orderIds: unassignedOrderIds,
    sortOrder: nextSortOrder(grouping.children),
    stopsCount: unassignedOrderIds.length,
  };
  return { ...grouping, children: [...grouping.children, route] };
}

export function assignmentMap(grouping: RouteGroupingDetailDto): Map<string, RouteGroupingAssignmentDto> {
  return new Map(grouping.assignments.map((assignment) => [assignment.orderId, assignment]));
}
