import { createHash } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import { appScopedShopWhere } from '../shopify/shopify-app-scope.js';
import type { DsvTimeConstraintActor } from './dsv-time-constraint-command.service.js';
import type { PrismaDsvDriverNotificationDispatcher } from './dsv-driver-notification.dispatcher.js';

export type DsvDispatchChangeRequestCommandInput = {
  actor: DsvTimeConstraintActor;
  commandId: string;
  deliveryStopId: string;
  expectedVersion: string;
  sellerOrderId: string;
  shopDomain: string;
};

export type DsvDispatchChangeRequestCancelInput = {
  actor: DsvTimeConstraintActor;
  changeRequestId: string;
  commandId: string;
  expectedVersion?: string | null;
  shopDomain: string;
};

export type DsvDispatchChangeRequestResult = {
  changeRequestId: string;
  commandId: string;
  deliveryStopId: string;
  sellerOrderId: string;
  status: 'PENDING_ACK' | 'CANCELLED';
  type: 'TIME_CONSTRAINT_CHANGE' | 'ACTIVE_ROUTE_ORDER_REMOVAL';
};

export type DsvDispatchRecoveryInput = {
  actor: DsvTimeConstraintActor;
  commandId: string;
  sellerOrderId: string;
  shopDomain: string;
};

export type DsvDispatchRecoveryResult = {
  commandId: string;
  operationStatus: 'UNASSIGNED';
  sellerOrderId: string;
};

export type DsvDispatchChangeRequestService = {
  cancel(input: DsvDispatchChangeRequestCancelInput): Promise<DsvDispatchChangeRequestResult>;
  recoverCancelledToUnassigned(input: DsvDispatchRecoveryInput): Promise<DsvDispatchRecoveryResult>;
  requestActiveRemoval(input: DsvDispatchChangeRequestCommandInput): Promise<DsvDispatchChangeRequestResult>;
};

export class DsvDispatchChangeRequestError extends Error {
  constructor(readonly code: 'COMMAND_IN_PROGRESS' | 'IDEMPOTENCY_PAYLOAD_MISMATCH' | 'NOT_FOUND' | 'VERSION_CONFLICT', message?: string) {
    super(message ?? code);
    this.name = 'DsvDispatchChangeRequestError';
  }
}

type ChangeRequestPrismaClient = Pick<PrismaClient, '$queryRaw' | '$transaction' | 'deliveryStop' | 'driverRouteNotificationAttempt' | 'dsvCommandReceipt' | 'dsvDispatchChangeRequest' | 'order' | 'shop'>;
type Tx = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

const transactionOptions = { maxWait: 20_000, timeout: 30_000 } as const;

export class PrismaDsvDispatchChangeRequestService implements DsvDispatchChangeRequestService {
  constructor(
    private readonly prisma: ChangeRequestPrismaClient,
    private readonly driverNotificationDispatcher?: Pick<PrismaDsvDriverNotificationDispatcher, 'dispatchByIdempotencyKey'>
  ) {}

  async requestActiveRemoval(input: DsvDispatchChangeRequestCommandInput): Promise<DsvDispatchChangeRequestResult> {
    const shop = await this.findShop(input.shopDomain);
    const payloadHash = sha256({ command: 'requestActiveRemoval', deliveryStopId: input.deliveryStopId, expectedVersion: input.expectedVersion, sellerOrderId: input.sellerOrderId });
    const result = await this.prisma.$transaction(async (tx) => {
      await lockCommand(tx, shop.id, input.commandId);
      const claim = await claimCommand(tx, shop.id, 'requestActiveRemoval', input, payloadHash);
      if ('result' in claim) return parseResult(claim.result);
      await lockSellerOrder(tx, shop.id, input.sellerOrderId);
      const order = await tx.order.findFirst({
        select: {
          currentRouteVersion: {
            select: {
              driverId: true,
              groupingId: true,
              id: true,
              routePlan: { select: { status: true } },
              routePlanId: true,
              version: true,
            },
          },
          currentRouteVersionId: true,
          id: true,
        },
        where: { id: input.sellerOrderId, shopId: shop.id },
      });
      if (order === null) throw new DsvDispatchChangeRequestError('VERSION_CONFLICT');
      const currentRouteVersionId = order.currentRouteVersionId;
      const currentRouteVersion = order.currentRouteVersion;
      if (currentRouteVersionId === null || currentRouteVersion === null || currentRouteVersion.routePlanId === null) throw new DsvDispatchChangeRequestError('VERSION_CONFLICT');
      if (currentRouteVersion.routePlan?.status !== 'IN_PROGRESS') {
        throw new DsvDispatchChangeRequestError('VERSION_CONFLICT', 'Active route removal is only available while the route is in progress');
      }
      if (currentRouteVersionId !== input.expectedVersion) throw new DsvDispatchChangeRequestError('VERSION_CONFLICT');
      await lockDeliveryStop(tx, shop.id, input.deliveryStopId);
      const deliveryStop = await tx.deliveryStop.findFirst({
        select: { id: true },
        where: {
          id: input.deliveryStopId,
          orderId: order.id,
          routePlanStops: { some: { routePlanId: currentRouteVersion.routePlanId, shopId: shop.id } },
          shopId: shop.id,
        },
      });
      if (deliveryStop === null) {
        throw new DsvDispatchChangeRequestError('VERSION_CONFLICT', 'Seller order stop assignment changed');
      }
      const existing = await tx.dsvDispatchChangeRequest.findFirst({
        select: { id: true },
        where: { deliveryStopId: input.deliveryStopId, routePlanId: currentRouteVersion.routePlanId, shopId: shop.id, status: 'PENDING_ACK' },
      });
      if (existing !== null) throw new DsvDispatchChangeRequestError('VERSION_CONFLICT', 'A dispatch change request is already pending driver acknowledgement');
      const request = await tx.dsvDispatchChangeRequest.create({
        data: {
          commandReceiptId: claim.receiptId,
          deliveryStopId: deliveryStop.id,
          driverId: currentRouteVersion.driverId,
          priorSnapshot: { currentRouteVersionId },
          removalReason: 'ACTIVE_ROUTE_ORDER_REMOVAL',
          requestId: input.actor.requestId ?? input.commandId,
          requestedByActorId: input.actor.actorId ?? null,
          requestedByActorType: input.actor.actorType,
          routePlanId: currentRouteVersion.routePlanId,
          routeVersionId: currentRouteVersionId,
          sellerOrderId: order.id,
          shopId: shop.id,
          type: 'ACTIVE_ROUTE_ORDER_REMOVAL',
        },
        select: { id: true },
      });
      const result = { changeRequestId: request.id, commandId: input.commandId, deliveryStopId: deliveryStop.id, sellerOrderId: order.id, status: 'PENDING_ACK' as const, type: 'ACTIVE_ROUTE_ORDER_REMOVAL' as const };
      await tx.driverRouteNotificationAttempt.upsert({
        create: {
          action: 'CHANGED',
          childVersionId: currentRouteVersion.id,
          driverId: currentRouteVersion.driverId,
          groupingId: currentRouteVersion.groupingId,
          groupingVersion: currentRouteVersion.version,
          idempotencyKey: `dsv-dispatch-change:${request.id}`,
          metadata: { changeRequestId: request.id },
          provider: 'FCM',
          routePlanId: currentRouteVersion.routePlanId,
          shopId: shop.id,
          status: 'PENDING',
        },
        update: { attemptedAt: new Date(), metadata: { changeRequestId: request.id }, status: 'PENDING' },
        where: { idempotencyKey: `dsv-dispatch-change:${request.id}` },
      });
      await completeCommand(tx, shop.id, 'requestActiveRemoval', input.commandId, payloadHash, result);
      return result;
    }, transactionOptions);
    await this.dispatchDriverNotification(`dsv-dispatch-change:${result.changeRequestId}`);
    return result;
  }

  async cancel(input: DsvDispatchChangeRequestCancelInput): Promise<DsvDispatchChangeRequestResult> {
    const shop = await this.findShop(input.shopDomain);
    const payloadHash = sha256({ changeRequestId: input.changeRequestId, command: 'cancelDispatchChangeRequest', expectedVersion: input.expectedVersion });
    return this.prisma.$transaction(async (tx) => {
      await lockCommand(tx, shop.id, input.commandId);
      const claim = await claimCommand(tx, shop.id, 'cancelDispatchChangeRequest', { ...input, sellerOrderId: null }, payloadHash);
      if ('result' in claim) return parseResult(claim.result);
      await lockChangeRequest(tx, shop.id, input.changeRequestId);
      const request = await tx.dsvDispatchChangeRequest.findFirst({
        select: { deliveryStopId: true, id: true, routeVersionId: true, sellerOrderId: true, status: true, type: true },
        where: { id: input.changeRequestId, shopId: shop.id },
      });
      if (request === null) throw new DsvDispatchChangeRequestError('NOT_FOUND');
      if (request.status !== 'PENDING_ACK') throw new DsvDispatchChangeRequestError('VERSION_CONFLICT');
      if (input.expectedVersion !== undefined && input.expectedVersion !== null && input.expectedVersion !== request.routeVersionId) throw new DsvDispatchChangeRequestError('VERSION_CONFLICT');
      const cancelled = await tx.dsvDispatchChangeRequest.updateMany({ data: { status: 'CANCELLED' }, where: { id: request.id, shopId: shop.id, status: 'PENDING_ACK' } });
      if (cancelled.count !== 1) throw new DsvDispatchChangeRequestError('VERSION_CONFLICT');
      const result = { changeRequestId: request.id, commandId: input.commandId, deliveryStopId: request.deliveryStopId, sellerOrderId: request.sellerOrderId, status: 'CANCELLED' as const, type: request.type };
      await completeCommand(tx, shop.id, 'cancelDispatchChangeRequest', input.commandId, payloadHash, result);
      return result;
    }, transactionOptions);
  }

  async recoverCancelledToUnassigned(input: DsvDispatchRecoveryInput): Promise<DsvDispatchRecoveryResult> {
    const shop = await this.findShop(input.shopDomain);
    const payloadHash = sha256({ command: 'recoverCancelledToUnassigned', sellerOrderId: input.sellerOrderId });
    return this.prisma.$transaction(async (tx) => {
      await lockCommand(tx, shop.id, input.commandId);
      const claim = await claimCommand(tx, shop.id, 'recoverCancelledToUnassigned', input, payloadHash);
      if ('result' in claim) return JSON.parse(claim.result) as DsvDispatchRecoveryResult;
      await lockSellerOrder(tx, shop.id, input.sellerOrderId);
      const order = await tx.order.findFirst({
        select: { currentRouteVersionId: true, deliveryStatus: true, id: true },
        where: { id: input.sellerOrderId, shopId: shop.id },
      });
      if (order === null) throw new DsvDispatchChangeRequestError('NOT_FOUND');
      if (order.currentRouteVersionId !== null || order.deliveryStatus === 'ASSIGNED' || order.deliveryStatus === 'OUT_FOR_DELIVERY' || order.deliveryStatus === 'DELIVERED') {
        throw new DsvDispatchChangeRequestError('VERSION_CONFLICT');
      }
      if (order.deliveryStatus !== 'CANCELLED') throw new DsvDispatchChangeRequestError('VERSION_CONFLICT');
      await tx.order.updateMany({
        data: { deliveryStatus: 'READY' },
        where: { currentRouteVersionId: null, deliveryStatus: 'CANCELLED', id: order.id, shopId: shop.id },
      });
      const result = { commandId: input.commandId, operationStatus: 'UNASSIGNED' as const, sellerOrderId: order.id };
      await completeRecoveryCommand(tx, shop.id, 'recoverCancelledToUnassigned', input.commandId, payloadHash, result);
      return result;
    }, transactionOptions);
  }

  private async findShop(shopDomain: string): Promise<{ id: string }> {
    const shop = await this.prisma.shop.findUnique({ select: { id: true }, where: appScopedShopWhere({ shopDomain: shopDomain.trim().toLowerCase() }) });
    if (shop === null) throw new DsvDispatchChangeRequestError('NOT_FOUND');
    return shop;
  }

  private async dispatchDriverNotification(idempotencyKey: string): Promise<void> {
    if (this.driverNotificationDispatcher === undefined) return;
    await this.driverNotificationDispatcher.dispatchByIdempotencyKey(idempotencyKey).catch(() => undefined);
  }
}

async function claimCommand(tx: Tx, shopId: string, commandName: string, input: { actor: DsvTimeConstraintActor; commandId: string; sellerOrderId?: string | null }, payloadHash: string): Promise<{ receiptId: string } | { result: string }> {
  const existing = await tx.dsvCommandReceipt.findUnique({ where: { shopId_commandName_commandId: { commandId: input.commandId, commandName, shopId } } });
  if (existing !== null) {
    if (existing.payloadHash !== payloadHash) throw new DsvDispatchChangeRequestError('IDEMPOTENCY_PAYLOAD_MISMATCH');
    if (existing.status === 'STARTED') throw new DsvDispatchChangeRequestError('COMMAND_IN_PROGRESS');
    if (existing.status === 'SUCCEEDED' && existing.responseBodyRef !== null) return { result: existing.responseBodyRef };
    throw new DsvDispatchChangeRequestError('VERSION_CONFLICT');
  }
  const receipt = await tx.dsvCommandReceipt.create({ data: {
    actorId: input.actor.actorId ?? null,
    actorType: input.actor.actorType,
    commandId: input.commandId,
    commandName,
    payloadHash,
    principalType: input.actor.principalType,
    requestId: input.actor.requestId ?? input.commandId,
    sellerOrderId: input.sellerOrderId ?? null,
    shopId,
    status: 'STARTED',
  }, select: { id: true } });
  return { receiptId: receipt.id };
}

async function completeCommand(tx: Tx, shopId: string, commandName: string, commandId: string, payloadHash: string, result: DsvDispatchChangeRequestResult): Promise<void> {
  const updated = await tx.dsvCommandReceipt.updateMany({ data: {
    completedAt: new Date(),
    responseBodyRef: JSON.stringify(result),
    responseStatus: 200,
    resultEntityId: result.changeRequestId,
    resultEntityType: 'DsvDispatchChangeRequest',
    status: 'SUCCEEDED',
  }, where: { commandId, commandName, payloadHash, shopId, status: 'STARTED' } });
  if (updated.count !== 1) throw new DsvDispatchChangeRequestError('VERSION_CONFLICT');
}

async function completeRecoveryCommand(tx: Tx, shopId: string, commandName: string, commandId: string, payloadHash: string, result: DsvDispatchRecoveryResult): Promise<void> {
  const updated = await tx.dsvCommandReceipt.updateMany({ data: {
    completedAt: new Date(),
    responseBodyRef: JSON.stringify(result),
    responseStatus: 200,
    resultEntityId: result.sellerOrderId,
    resultEntityType: 'Order',
    status: 'SUCCEEDED',
  }, where: { commandId, commandName, payloadHash, shopId, status: 'STARTED' } });
  if (updated.count !== 1) throw new DsvDispatchChangeRequestError('VERSION_CONFLICT');
}

function parseResult(value: string): DsvDispatchChangeRequestResult {
  return JSON.parse(value) as DsvDispatchChangeRequestResult;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function lockCommand(tx: Pick<Tx, '$queryRaw'>, shopId: string, commandId: string): Promise<void> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`dsv-dispatch-change-request:${shopId}:${commandId}`}, 0))`;
}

async function lockSellerOrder(tx: Pick<Tx, '$queryRaw'>, shopId: string, sellerOrderId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM orders WHERE id = ${sellerOrderId}::uuid AND "shopId" = ${shopId}::uuid FOR UPDATE`;
}

async function lockChangeRequest(tx: Pick<Tx, '$queryRaw'>, shopId: string, changeRequestId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM dsv_dispatch_change_requests WHERE id = ${changeRequestId}::uuid AND "shopId" = ${shopId}::uuid FOR UPDATE`;
}

async function lockDeliveryStop(tx: Pick<Tx, '$queryRaw'>, shopId: string, deliveryStopId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM delivery_stops WHERE id = ${deliveryStopId}::uuid AND "shopId" = ${shopId}::uuid FOR UPDATE`;
}
