import { createHash } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import { appScopedShopWhere } from '../shopify/shopify-app-scope.js';
import type { DsvRouteOptimizationSchedulerPort } from './dsv-route-optimization.scheduler.js';
import type { PrismaDsvDriverNotificationDispatcher } from './dsv-driver-notification.dispatcher.js';
import {
  deriveDsvTimeConstraintState,
  dsvCanonicalNoteHash,
  dsvTimeOnlyMinutes,
  formatTimeOnly,
  normalizeRawNote,
  parseTimeOnlyAsUtcDate,
  type DsvCanonicalTimeConstraintState,
} from './dsv-time-constraint.js';

export type DsvTimeConstraintActor = {
  actorId?: string | null;
  actorType: 'DSV_ADMIN';
  principalType: 'DSV_ADMIN';
  requestId?: string | null;
};

export type DsvTimeConstraintCommandInput = {
  actor: DsvTimeConstraintActor;
  commandId: string;
  deliveryStopId: string;
  expectedVersion?: string | null | undefined;
  sellerOrderId: string;
  shopDomain: string;
};

export type DsvConfirmTimeConstraintInput = DsvTimeConstraintCommandInput & {
  timeWindowEnd: string;
  timeWindowStart: string;
};

export type DsvClearTimeConstraintInput = DsvTimeConstraintCommandInput & {
  reason?: string | null | undefined;
};

export type DsvTimeConstraintRecalculation = {
  reason: 'ACTIVE_ROUTE_PENDING_DRIVER_ACK' | 'ASSIGNED_ROUTE_TIME_CONSTRAINT_CLEARED' | 'ASSIGNED_ROUTE_TIME_CONSTRAINT_CONFIRMED' | 'SCHEDULER_UNAVAILABLE' | 'TIME_CONSTRAINT_CLEARED' | 'UNASSIGNED_ORDER';
  retryable: boolean;
  routePlanId: string | null;
  status: 'FAILED_TO_SCHEDULE' | 'NOT_REQUIRED' | 'PENDING_DRIVER_ACK' | 'SCHEDULED';
};

export type DsvTimeConstraintCommandResult = DsvCanonicalTimeConstraintState & {
  auditEventId: string;
  clearedAt?: string;
  clearedBy?: string;
  commandId: string;
  changeRequestId?: string;
  deliveryStopId: string;
  recalculation: DsvTimeConstraintRecalculation;
  sellerOrderId: string;
  sellerOrderKey: string;
};

export type DsvTimeConstraintCommandService = {
  clear(input: DsvClearTimeConstraintInput): Promise<DsvTimeConstraintCommandResult>;
  confirm(input: DsvConfirmTimeConstraintInput): Promise<DsvTimeConstraintCommandResult>;
};

export class DsvTimeConstraintCommandError extends Error {
  constructor(readonly code: DsvTimeConstraintCommandErrorCode, message: string = code) {
    super(message);
    this.name = 'DsvTimeConstraintCommandError';
  }
}

export type DsvTimeConstraintCommandErrorCode =
  | 'COMMAND_IN_PROGRESS'
  | 'IDEMPOTENCY_PAYLOAD_MISMATCH'
  | 'SELLER_ORDER_ASSIGNMENT_CHANGED'
  | 'SELLER_ORDER_NOT_FOUND'
  | 'VALIDATION_FAILED';

type TimeConstraintCommandName = 'clearTimeConstraint' | 'confirmTimeConstraint';
type TimeConstraintEventType = 'TIME_CONSTRAINT_CLEARED' | 'TIME_CONSTRAINT_CONFIRMED';
type AssignedRouteRecalculationReason = Extract<
  DsvTimeConstraintRecalculation['reason'],
  'ASSIGNED_ROUTE_TIME_CONSTRAINT_CLEARED' | 'ASSIGNED_ROUTE_TIME_CONSTRAINT_CONFIRMED'
>;
type ClaimedCommand = { receiptId: string } | { result: DsvTimeConstraintCommandResult };

export type DsvTimeConstraintCommandLogger = {
  warn(bindings: Record<string, unknown>, message: string): void;
};

type DsvTimeConstraintPrismaClient = Pick<
  PrismaClient,
  '$queryRaw' | '$transaction' | 'deliveryStop' | 'driverRouteNotificationAttempt' | 'dsvAuditEvent' | 'dsvCommandReceipt' | 'dsvDispatchChangeRequest' | 'order' | 'shop'
>;

type Tx = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

const transactionOptions = { maxWait: 20_000, timeout: 30_000 } as const;
const consoleLogger: DsvTimeConstraintCommandLogger = {
  warn: (bindings, message) => { console.warn(message, bindings); },
};

export class PrismaDsvTimeConstraintCommandService implements DsvTimeConstraintCommandService {
  constructor(
    private readonly prisma: DsvTimeConstraintPrismaClient,
    private readonly routeOptimizationScheduler?: DsvRouteOptimizationSchedulerPort,
    private readonly logger: DsvTimeConstraintCommandLogger = consoleLogger,
    private readonly driverNotificationDispatcher?: Pick<PrismaDsvDriverNotificationDispatcher, 'dispatchByIdempotencyKey'>,
  ) {}

  async confirm(input: DsvConfirmTimeConstraintInput): Promise<DsvTimeConstraintCommandResult> {
    const start = parseTimeOnlyAsUtcDate(input.timeWindowStart);
    const end = parseTimeOnlyAsUtcDate(input.timeWindowEnd);
    const startMinutes = dsvTimeOnlyMinutes(input.timeWindowStart);
    const endMinutes = dsvTimeOnlyMinutes(input.timeWindowEnd);
    if (start === null || end === null || startMinutes === null || endMinutes === null || startMinutes >= endMinutes) {
      throw new DsvTimeConstraintCommandError('VALIDATION_FAILED', 'timeWindowStart and timeWindowEnd must be HH:mm with start before end');
    }
    return this.execute({
      commandName: 'confirmTimeConstraint',
      input,
      nextWindow: { timeWindowEnd: end, timeWindowStart: start },
    });
  }

  async clear(input: DsvClearTimeConstraintInput): Promise<DsvTimeConstraintCommandResult> {
    return this.execute({
      commandName: 'clearTimeConstraint',
      input,
      nextWindow: { timeWindowEnd: null, timeWindowStart: null },
    });
  }

  private async execute(input: {
    commandName: TimeConstraintCommandName;
    input: DsvTimeConstraintCommandInput;
    nextWindow: { timeWindowEnd: Date | null; timeWindowStart: Date | null };
  }): Promise<DsvTimeConstraintCommandResult> {
    const shop = await this.prisma.shop.findUnique({
      select: { id: true },
      where: appScopedShopWhere({ shopDomain: normalizeShopDomain(input.input.shopDomain) }),
    });
    if (shop === null) throw new DsvTimeConstraintCommandError('SELLER_ORDER_NOT_FOUND');

    const payloadHash = sha256CanonicalJson(commandPayload(input.commandName, input.input, input.nextWindow));
    const persisted = await this.prisma.$transaction(async (tx) => {
      await lockCommand(tx, shop.id, input.input.commandId);
      const claim = await this.claimCommand(tx, shop.id, input.commandName, input.input, payloadHash);
      if ('result' in claim) return { receipt: null, result: claim.result, schedule: null };

      await lockSellerOrder(tx, shop.id, input.input.sellerOrderId);
      const order = await tx.order.findFirst({
        select: {
          currentRouteVersionId: true,
          currentRouteVersion: {
            select: {
              createdAt: true,
              driverId: true,
              groupingId: true,
              id: true,
              routePlan: { select: { status: true } },
              routePlanId: true,
              version: true,
            },
          },
          id: true,
          sellerOrderKey: true,
        },
        where: { id: input.input.sellerOrderId, shopId: shop.id },
      });
      if (order === null) throw new DsvTimeConstraintCommandError('SELLER_ORDER_NOT_FOUND');
      assertExpectedVersion(input.input.expectedVersion, order.currentRouteVersionId);

      const stop = await tx.deliveryStop.findFirst({
        select: {
          id: true,
          instructions: true,
          timeWindowEnd: true,
          timeWindowStart: true,
        },
        where: {
          id: input.input.deliveryStopId,
          orderId: input.input.sellerOrderId,
          shopId: shop.id,
        },
      });
      if (stop === null) throw new DsvTimeConstraintCommandError('SELLER_ORDER_NOT_FOUND');

      const rawNote = normalizeRawNote(stop.instructions);
      const noteHash = rawNote === null ? dsvCanonicalNoteHash('') : dsvCanonicalNoteHash(rawNote);
      const eventType = timeConstraintEventType(input.commandName);
      const activeRouteVersionId = order.currentRouteVersionId;
      const activeRoutePlanId = order.currentRouteVersion?.routePlanId ?? null;
      const assignedRoute = activeRouteVersionId !== null && activeRoutePlanId !== null;
      const activeRoute = assignedRoute && order.currentRouteVersion?.routePlan?.status === 'IN_PROGRESS';
      const changeRequestDelegate = (tx as { dsvDispatchChangeRequest?: Tx['dsvDispatchChangeRequest'] }).dsvDispatchChangeRequest;
      const deferForDriverAck = activeRoute && activeRoutePlanId !== null && changeRequestDelegate !== undefined;
      if (deferForDriverAck) {
        const existingChangeRequest = await changeRequestDelegate.findFirst({
          select: { id: true },
          where: {
            deliveryStopId: stop.id,
            routePlanId: activeRoutePlanId,
            shopId: shop.id,
            status: 'PENDING_ACK',
          },
        });
        if (existingChangeRequest !== null) {
          throw new DsvTimeConstraintCommandError('SELLER_ORDER_ASSIGNMENT_CHANGED', 'A dispatch change request is already pending driver acknowledgement');
        }
      }
      if (!deferForDriverAck) {
        await tx.deliveryStop.updateMany({
          data: input.nextWindow,
          where: { id: stop.id, orderId: order.id, shopId: shop.id },
        }).then((updated) => {
          if (updated.count !== 1) throw new DsvTimeConstraintCommandError('SELLER_ORDER_ASSIGNMENT_CHANGED');
        });
      }
      const audit = await tx.dsvAuditEvent.create({
        data: {
          actorId: input.input.actor.actorId ?? null,
          actorType: input.input.actor.actorType,
          commandReceiptId: claim.receiptId,
          entityId: stop.id,
          entityType: 'DeliveryStop',
          eventType,
          nextRoutePlanId: order.currentRouteVersion?.routePlanId ?? null,
          nextRouteVersionId: order.currentRouteVersionId,
          previousRoutePlanId: order.currentRouteVersion?.routePlanId ?? null,
          previousRouteVersionId: order.currentRouteVersionId,
          principalType: input.input.actor.principalType,
          redactedDiff: {
            commandId: input.input.commandId,
            deliveryStopId: stop.id,
            newTimeWindowEnd: formatTimeOnly(input.nextWindow.timeWindowEnd),
            newTimeWindowStart: formatTimeOnly(input.nextWindow.timeWindowStart),
            noteHash,
            priorTimeWindowEnd: formatTimeOnly(stop.timeWindowEnd),
            priorTimeWindowStart: formatTimeOnly(stop.timeWindowStart),
            sellerOrderId: order.id,
            sourceNotePresent: rawNote !== null,
          },
          requestId: input.input.actor.requestId ?? input.input.commandId,
          sellerOrderId: order.id,
          shopId: shop.id,
        },
        select: { actorId: true, eventType: true, id: true, occurredAt: true, redactedDiff: true },
      });

      const state = deriveDsvTimeConstraintState({
        audits: [audit],
        currentRouteVersionCreatedAt: order.currentRouteVersion?.createdAt ?? null,
        currentRouteVersionId: order.currentRouteVersionId,
        rawNote,
        timeWindowEnd: deferForDriverAck ? stop.timeWindowEnd : input.nextWindow.timeWindowEnd,
        timeWindowStart: deferForDriverAck ? stop.timeWindowStart : input.nextWindow.timeWindowStart,
      });
      const changeRequest = deferForDriverAck && activeRouteVersionId !== null && activeRoutePlanId !== null
        ? await changeRequestDelegate.create({
            data: {
              commandReceiptId: claim.receiptId,
              deliveryStopId: stop.id,
              driverId: order.currentRouteVersion?.driverId ?? null,
              priorSnapshot: {
                timeWindowEnd: formatTimeOnly(stop.timeWindowEnd),
                timeWindowStart: formatTimeOnly(stop.timeWindowStart),
              },
              requestId: input.input.actor.requestId ?? input.input.commandId,
              requestedByActorId: input.input.actor.actorId ?? null,
              requestedByActorType: input.input.actor.actorType,
              routePlanId: activeRoutePlanId,
              routeVersionId: activeRouteVersionId,
              sellerOrderId: order.id,
              shopId: shop.id,
              status: 'PENDING_ACK',
              timeWindowEnd: input.nextWindow.timeWindowEnd,
              timeWindowStart: input.nextWindow.timeWindowStart,
              type: 'TIME_CONSTRAINT_CHANGE',
            },
            select: { id: true },
          })
        : null;
      if (changeRequest !== null && order.currentRouteVersion !== null && activeRoutePlanId !== null) {
        await tx.driverRouteNotificationAttempt.upsert({
          create: {
            action: 'CHANGED',
            childVersionId: order.currentRouteVersion.id,
            driverId: order.currentRouteVersion.driverId,
            groupingId: order.currentRouteVersion.groupingId,
            groupingVersion: order.currentRouteVersion.version,
            idempotencyKey: `dsv-dispatch-change:${changeRequest.id}`,
            metadata: { changeRequestId: changeRequest.id },
            provider: 'FCM',
            routePlanId: activeRoutePlanId,
            shopId: shop.id,
            status: 'PENDING',
          },
          update: { attemptedAt: new Date(), metadata: { changeRequestId: changeRequest.id }, status: 'PENDING' },
          where: { idempotencyKey: `dsv-dispatch-change:${changeRequest.id}` },
        });
      }
      const baseResult: DsvTimeConstraintCommandResult = {
        ...state,
        auditEventId: audit.id,
        ...(changeRequest === null ? {} : { changeRequestId: changeRequest.id }),
        ...(eventType === 'TIME_CONSTRAINT_CLEARED'
          ? {
              clearedAt: audit.occurredAt.toISOString(),
              ...(audit.actorId === null ? {} : { clearedBy: audit.actorId }),
            }
          : {}),
        commandId: input.input.commandId,
        deliveryStopId: stop.id,
        recalculation: deferForDriverAck
          ? {
              reason: 'ACTIVE_ROUTE_PENDING_DRIVER_ACK',
              retryable: false,
              routePlanId: order.currentRouteVersion?.routePlanId ?? null,
              status: 'PENDING_DRIVER_ACK',
            }
          : recalculationNotRequired(eventType, order.currentRouteVersionId, order.currentRouteVersion?.routePlanId ?? null),
        sellerOrderId: order.id,
        sellerOrderKey: order.sellerOrderKey ?? order.id,
      };

      return {
        receipt: {
          id: claim.receiptId,
          routePlanId: order.currentRouteVersion?.routePlanId ?? null,
          routeVersionId: order.currentRouteVersionId,
        },
        result: baseResult,
        schedule: assignedRoute && !deferForDriverAck
          ? { eventType, routePlanId: activeRoutePlanId }
          : null,
      };
    }, transactionOptions).catch((error: unknown) => {
      if (isPrismaTransactionConflict(error)) throw new DsvTimeConstraintCommandError('SELLER_ORDER_ASSIGNMENT_CHANGED');
      throw error;
    });

    if (persisted.receipt === null) return persisted.result;
    const result = persisted.schedule === null
      ? persisted.result
      : {
          ...persisted.result,
          recalculation: this.scheduleRecalculation({
            commandId: input.input.commandId,
            deliveryStopId: input.input.deliveryStopId,
            eventType: persisted.schedule.eventType,
            routePlanId: persisted.schedule.routePlanId,
            sellerOrderId: input.input.sellerOrderId,
            shopDomain: input.input.shopDomain,
            shopId: shop.id,
          }),
          routeConstraintStatus: 'PENDING_RECALCULATION' as const,
        };
    await this.completeCommandReceipt({
      payloadHash,
      receiptId: persisted.receipt.id,
      result,
      routePlanId: persisted.receipt.routePlanId,
      routeVersionId: persisted.receipt.routeVersionId,
      sellerOrderId: input.input.sellerOrderId,
      shopId: shop.id,
    });
    if (result.changeRequestId !== undefined) {
      await this.driverNotificationDispatcher
        ?.dispatchByIdempotencyKey(`dsv-dispatch-change:${result.changeRequestId}`)
        .catch(() => undefined);
    }
    return result;
  }

  private async completeCommandReceipt(input: {
    payloadHash: string;
    receiptId: string;
    result: DsvTimeConstraintCommandResult;
    routePlanId: string | null;
    routeVersionId: string | null;
    sellerOrderId: string;
    shopId: string;
  }): Promise<void> {
    const updated = await this.prisma.dsvCommandReceipt.updateMany({
      data: {
        completedAt: new Date(),
        nextRoutePlanId: input.routePlanId,
        nextRouteVersionId: input.routeVersionId,
        previousRoutePlanId: input.routePlanId,
        previousRouteVersionId: input.routeVersionId,
        responseBodyRef: canonicalJson(input.result),
        responseStatus: 200,
        resultEntityId: input.sellerOrderId,
        resultEntityType: 'SellerOrder',
        status: 'SUCCEEDED',
      },
      where: {
        id: input.receiptId,
        payloadHash: input.payloadHash,
        shopId: input.shopId,
        status: 'STARTED',
      },
    });
    if (updated.count !== 1) throw new DsvTimeConstraintCommandError('SELLER_ORDER_ASSIGNMENT_CHANGED');
  }

  private async claimCommand(
    tx: Tx,
    shopId: string,
    commandName: TimeConstraintCommandName,
    input: DsvTimeConstraintCommandInput,
    payloadHash: string,
  ): Promise<ClaimedCommand> {
    const existing = await tx.dsvCommandReceipt.findUnique({
      where: { shopId_commandName_commandId: { commandId: input.commandId, commandName, shopId } },
    });
    if (existing !== null) {
      if (existing.payloadHash !== payloadHash) throw new DsvTimeConstraintCommandError('IDEMPOTENCY_PAYLOAD_MISMATCH');
      if (existing.status === 'STARTED') throw new DsvTimeConstraintCommandError('COMMAND_IN_PROGRESS');
      const result = parseCommandResult(existing.responseBodyRef);
      if (existing.status === 'SUCCEEDED' && result !== null) return { result };
      throw new DsvTimeConstraintCommandError('SELLER_ORDER_ASSIGNMENT_CHANGED');
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

  private scheduleRecalculation(input: {
    commandId: string;
    deliveryStopId: string;
    eventType: TimeConstraintEventType;
    routePlanId: string | null;
    sellerOrderId: string;
    shopDomain: string;
    shopId: string;
  }): DsvTimeConstraintRecalculation {
    try {
      if (this.routeOptimizationScheduler === undefined) {
        throw new Error('routeOptimizationScheduler unavailable');
      }
      this.routeOptimizationScheduler.schedule({ routePlanIds: [input.routePlanId], shopDomain: input.shopDomain });
      return {
        reason: assignedRouteRecalculationReason(input.eventType),
        retryable: false,
        routePlanId: input.routePlanId,
        status: 'SCHEDULED',
      };
    } catch (error) {
      this.logSchedulerFailure(input, error);
      return {
        reason: 'SCHEDULER_UNAVAILABLE',
        retryable: true,
        routePlanId: input.routePlanId,
        status: 'FAILED_TO_SCHEDULE',
      };
    }
  }

  private logSchedulerFailure(
    input: {
      commandId: string;
      deliveryStopId: string;
      routePlanId: string | null;
      sellerOrderId: string;
      shopId: string;
    },
    error: unknown,
  ): void {
    try {
      this.logger.warn({
        commandId: input.commandId,
        deliveryStopId: input.deliveryStopId,
        errorType: error instanceof Error ? error.name : 'UnknownError',
        event: 'dsv_time_constraint_recalculation_schedule_failed',
        routePlanId: input.routePlanId,
        sellerOrderId: input.sellerOrderId,
        shopId: input.shopId,
      }, 'DSV time constraint recalculation scheduling failed');
    } catch {
      // Logging must not change the persisted command outcome.
    }
  }
}

function recalculationNotRequired(
  eventType: TimeConstraintEventType,
  currentRouteVersionId: string | null,
  routePlanId: string | null,
): DsvTimeConstraintRecalculation {
  if (currentRouteVersionId !== null) {
    return {
      reason: assignedRouteRecalculationReason(eventType),
      retryable: false,
      routePlanId,
      status: 'SCHEDULED',
    };
  }
  return {
    reason: eventType === 'TIME_CONSTRAINT_CLEARED' ? 'TIME_CONSTRAINT_CLEARED' : 'UNASSIGNED_ORDER',
    retryable: false,
    routePlanId: null,
    status: 'NOT_REQUIRED',
  };
}

function timeConstraintEventType(commandName: TimeConstraintCommandName): TimeConstraintEventType {
  switch (commandName) {
    case 'clearTimeConstraint':
      return 'TIME_CONSTRAINT_CLEARED';
    case 'confirmTimeConstraint':
      return 'TIME_CONSTRAINT_CONFIRMED';
  }
}

function assignedRouteRecalculationReason(eventType: TimeConstraintEventType): AssignedRouteRecalculationReason {
  switch (eventType) {
    case 'TIME_CONSTRAINT_CLEARED':
      return 'ASSIGNED_ROUTE_TIME_CONSTRAINT_CLEARED';
    case 'TIME_CONSTRAINT_CONFIRMED':
      return 'ASSIGNED_ROUTE_TIME_CONSTRAINT_CONFIRMED';
  }
}

function assertExpectedVersion(expectedVersion: string | null | undefined, currentRouteVersionId: string | null): void {
  if (expectedVersion === undefined || expectedVersion === null) {
    throw new DsvTimeConstraintCommandError('SELLER_ORDER_ASSIGNMENT_CHANGED');
  }
  const actual = currentRouteVersionId ?? 'UNASSIGNED';
  if (expectedVersion !== actual) throw new DsvTimeConstraintCommandError('SELLER_ORDER_ASSIGNMENT_CHANGED');
}

function commandPayload(
  commandName: TimeConstraintCommandName,
  input: DsvTimeConstraintCommandInput,
  nextWindow: { timeWindowEnd: Date | null; timeWindowStart: Date | null },
): unknown {
  return {
    commandName,
    deliveryStopId: input.deliveryStopId,
    expectedVersion: input.expectedVersion,
    nextTimeWindowEnd: formatTimeOnly(nextWindow.timeWindowEnd),
    nextTimeWindowStart: formatTimeOnly(nextWindow.timeWindowStart),
    sellerOrderId: input.sellerOrderId,
  };
}

function parseCommandResult(value: string | null): DsvTimeConstraintCommandResult | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value) as Partial<DsvTimeConstraintCommandResult>;
    if (typeof parsed.commandId !== 'string') return null;
    if (typeof parsed.deliveryStopId !== 'string') return null;
    if (typeof parsed.sellerOrderId !== 'string') return null;
    if (typeof parsed.auditEventId !== 'string') return null;
    if (parsed.recalculation === undefined) return null;
    return parsed as DsvTimeConstraintCommandResult;
  } catch {
    return null;
  }
}

function normalizeShopDomain(value: string): string {
  return value.trim().toLowerCase();
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

async function lockCommand(tx: Pick<Tx, '$queryRaw'>, shopId: string, commandId: string): Promise<void> {
  await tx.$queryRaw<{ locked: number }[]>`WITH lock AS (SELECT pg_advisory_xact_lock(hashtextextended(${`dsv-time-constraint-command:${shopId}:${commandId}`}, 0))) SELECT 1 AS locked FROM lock`;
}

async function lockSellerOrder(tx: Pick<Tx, '$queryRaw'>, shopId: string, sellerOrderId: string): Promise<void> {
  await tx.$queryRaw<{ id: string }[]>`SELECT id FROM orders WHERE id = ${sellerOrderId}::uuid AND "shopId" = ${shopId}::uuid FOR UPDATE`;
}

function isPrismaTransactionConflict(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const record = error as { code?: unknown; meta?: { code?: unknown } };
  return record.code === 'P2034'
    || (record.code === 'P2010' && (record.meta?.code === '40P01' || record.meta?.code === '40001'));
}
