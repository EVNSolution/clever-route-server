import { createHash } from 'node:crypto';

import { Prisma, type PrismaClient } from '@prisma/client';

import { createDsvDeliveryExceptionEmailSnapshot } from './dsv-delivery-exception-email.service.js';

import type {
  DriverEventTransactionClient,
  PrismaDriverEventRepository,
  RecordDriverEventInput,
  RecordDriverEventResult,
} from '../driver/driver-event.repository.js';

const MAX_SIGNED_BIGINT = 9_223_372_036_854_775_807n;

export type DsvExecutionFence = {
  accountId: string;
  assignmentEpoch: string;
  assignmentGeneration: string;
  driverId: string;
  executionContextId: string;
  expectedRouteVersionId: string;
  routeVersion: number;
  shopDomain: string;
  shopId: string;
};

export type DsvStartExecutionInput = DsvExecutionFence & {
  commandId: string;
  occurredAt: Date;
};

export type DsvReportDeliveryExceptionInput = DsvExecutionFence & {
  commandId: string;
  explanation?: string | null;
  occurredAt: Date;
  reason?: string;
  reasonCode?: string;
  targetStopId: string;
};

export type DsvStartExecutionResult = {
  assignmentEpoch: string;
  commandId: string;
  duplicate: boolean;
  executionContextId: string;
  pickupCompletedEventId: string;
  routeStartedEventId: string;
  routeVersion: number;
};

export type DsvReportDeliveryExceptionResult = {
  assignmentEpoch: string;
  commandId: string;
  duplicate: boolean;
  exceptionId: string;
  executionContextId: string;
  emailStatus: string;
  reportStatus: 'ACCEPTED';
  notificationId: string;
  routeVersion: number;
};

export type DsvDeliveryExceptionView = {
  acknowledgedAt: string | null;
  assignmentEpoch: string;
  createdAt: string;
  driverId: string;
  executionContextId: string;
  explanation: string | null;
  emailStatus: string;
  emailSentAt: string | null;
  id: string;
  reason: string;
  reasonCode: string;
  resolvedAt: string | null;
  routeVersion: number;
  status: string;
  targetStopId: string;
};

export type DsvExecutionCommandErrorCode =
  | 'ASSIGNMENT_CHANGED'
  | 'COMMAND_CONFLICT'
  | 'CONTEXT_CLOSED'
  | 'CONTEXT_NOT_FOUND'
  | 'INVALID_INPUT'
  | 'REPORT_NOT_FOUND'
  | 'ROUTE_VERSION_CHANGED'
  | 'TARGET_NOT_FOUND'
  | 'TARGET_TERMINAL'
  | 'UNAUTHORIZED';

export class DsvExecutionCommandError extends Error {
  constructor(readonly code: DsvExecutionCommandErrorCode, message: string = code) {
    super(message);
    this.name = 'DsvExecutionCommandError';
  }
}

type ExecutionCommandPrisma = Pick<PrismaClient, '$transaction' | 'dsvDeliveryException'>;
type ExecutionCommandTx = Pick<
  Prisma.TransactionClient,
  | '$queryRaw'
  | 'driver'
  | 'driverEvent'
  | 'dsvDeliveryException'
  | 'dsvExecutionCommand'
  | 'dsvExecutionContext'
  | 'dsvOperationalNotification'
  | 'routeGroupingChildVersion'
  | 'routePlan'
  | 'routePlanStop'
>;

export type DsvExecutionDriverEventPort = Pick<PrismaDriverEventRepository, 'recordDriverEventInTransaction'>;

type LockedExecution = {
  assignmentEpoch: bigint;
  driverId: string | null;
  recipientAccountId: string | null;
  routePlanId: string;
  routeVersion: number;
  serviceDate: Date;
  status: string;
};

export class PrismaDsvExecutionCommandsService {
  constructor(
    private readonly prisma: ExecutionCommandPrisma,
    private readonly driverEvents: DsvExecutionDriverEventPort,
  ) {}

  async start(input: DsvStartExecutionInput): Promise<DsvStartExecutionResult> {
    validateFence(input);
    validateCommandId(input.commandId);
    validateOccurredAt(input.occurredAt);
    const payloadHash = commandHash('START_EXECUTION', input);

    return this.prisma.$transaction(async (tx) => {
      const transaction = tx as ExecutionCommandTx;
      await lockCommand(transaction, input.shopId, 'START_EXECUTION', input.commandId);
      const replay = await readCommandReplay<DsvStartExecutionResult>(transaction, input, 'START_EXECUTION', payloadHash);
      if (replay !== null) return { ...replay, duplicate: true };

      const execution = await lockAndValidateExecution(transaction, input);
      const legacyEvents = await findExistingStartEvents(transaction, execution.routePlanId, input);
      const startOccurredAt = legacyEvents.routeStarted?.occurredAt ?? input.occurredAt;
      const eventBase: Omit<RecordDriverEventInput, 'clientEventId' | 'eventType'> = {
        assignmentGeneration: input.assignmentGeneration,
        deliveryStopId: null,
        driverContractVersion: 2,
        driverId: input.driverId,
        expectedRouteVersionId: input.expectedRouteVersionId,
        latitude: null,
        longitude: null,
        occurredAt: startOccurredAt,
        payload: {
          assignmentEpoch: input.assignmentEpoch,
          commandId: input.commandId,
          executionContextId: input.executionContextId,
          routeVersion: input.routeVersion,
          schema: 'dsv_execution_start_v1',
        },
        routePlanId: execution.routePlanId,
        shopDomain: input.shopDomain,
        shopId: input.shopId,
      };
      const started = legacyEvents.routeStarted?.result ?? await this.recordEvent(transaction, {
        ...eventBase,
        clientEventId: deterministicEventId(input.commandId, 'route-started'),
        eventType: 'ROUTE_STARTED',
      });
      // A legacy client may already have committed ROUTE_STARTED. The second
      // deterministic event repairs only the missing pickup transition.
      const pickup = legacyEvents.pickupCompleted?.result ?? await this.recordEvent(transaction, {
        ...eventBase,
        clientEventId: deterministicEventId(input.commandId, 'pickup-completed'),
        eventType: 'PICKUP_COMPLETED',
      });

      await transaction.dsvExecutionContext.update({
        data: {
          reminderDueAt: null,
          reminderStatus: 'RESOLVED_START',
          startedAt: startOccurredAt,
        },
        where: { id_shopId: { id: input.executionContextId, shopId: input.shopId } },
      });
      await transaction.dsvOperationalNotification.updateMany({
        data: { businessStatus: 'RESOLVED', resolutionReason: 'ROUTE_STARTED', resolvedAt: input.occurredAt },
        where: {
          assignmentEpoch: BigInt(input.assignmentEpoch),
          businessStatus: 'OPEN',
          executionContextId: input.executionContextId,
          kind: { in: ['N04', 'N05'] },
          shopId: input.shopId,
        },
      });
      const result: DsvStartExecutionResult = {
        assignmentEpoch: input.assignmentEpoch,
        commandId: input.commandId,
        duplicate: false,
        executionContextId: input.executionContextId,
        pickupCompletedEventId: pickup.eventId,
        routeStartedEventId: started.eventId,
        routeVersion: input.routeVersion,
      };
      await storeCommandResult(transaction, input, 'START_EXECUTION', payloadHash, result);
      return result;
    });
  }

  async reportDeliveryException(
    input: DsvReportDeliveryExceptionInput,
  ): Promise<DsvReportDeliveryExceptionResult> {
    validateFence(input);
    validateCommandId(input.commandId);
    validateOccurredAt(input.occurredAt);
    validateUuid(input.targetStopId, 'targetStopId');
    const reasonCode = input.reasonCode === undefined ? 'FREE_TEXT' : requiredBoundedText(input.reasonCode, 'reasonCode', 80);
    const explanation = optionalBoundedText(input.explanation, 'explanation', 1_000);
    const reason = input.reason === undefined
      ? explanation ?? (input.reasonCode === undefined ? null : reasonCode)
      : requiredBoundedText(input.reason, 'reason', 1_000, true);
    if (reason === null) throw new DsvExecutionCommandError('INVALID_INPUT', 'reason is required');
    // Preserve the exact legacy request fingerprint so pre-upgrade retries replay.
    const payloadHash = commandHash('REPORT_DELIVERY_EXCEPTION', {
      ...input, ...(input.reason === undefined ? {} : { reason }), explanation, reasonCode,
    });

    return this.prisma.$transaction(async (tx) => {
      const transaction = tx as ExecutionCommandTx;
      await lockCommand(transaction, input.shopId, 'REPORT_DELIVERY_EXCEPTION', input.commandId);
      const replay = await readCommandReplay<DsvReportDeliveryExceptionResult>(
        transaction,
        input,
        'REPORT_DELIVERY_EXCEPTION',
        payloadHash,
      );
      if (replay !== null) return { ...replay, duplicate: true, reportStatus: 'ACCEPTED', emailStatus: replay.emailStatus ?? 'NOT_PREPARED' };

      const execution = await lockAndValidateExecution(transaction, input);
      const stop = await transaction.routePlanStop.findFirst({
        select: { deliveryStopId: true, deliveryStop: { select: {
          address1: true, address2: true, city: true, province: true, recipientName: true, status: true,
        } } },
        where: { deliveryStopId: input.targetStopId, routePlanId: execution.routePlanId, shopId: input.shopId },
      });
      if (stop === null) throw new DsvExecutionCommandError('TARGET_NOT_FOUND');
      if (['DELIVERED', 'FAILED', 'SKIPPED', 'CANCELLED'].includes(stop.deliveryStop.status)) {
        throw new DsvExecutionCommandError('TARGET_TERMINAL');
      }

      const driver = await transaction.driver.findFirst({
        select: { displayName: true }, where: { id: input.driverId, shopId: input.shopId },
      });
      if (driver === null) throw new DsvExecutionCommandError('UNAUTHORIZED');
      const emailSnapshot = createDsvDeliveryExceptionEmailSnapshot({
        destination: [stop.deliveryStop.recipientName, stop.deliveryStop.province, stop.deliveryStop.city,
          stop.deliveryStop.address1, stop.deliveryStop.address2].filter(Boolean).join(' ') || input.targetStopId,
        driver: driver.displayName,
        reason,
        reportedAt: input.occurredAt,
        serviceDate: execution.serviceDate,
      });
      const report = await transaction.dsvDeliveryException.create({
        data: {
          assignmentEpoch: BigInt(input.assignmentEpoch),
          driverId: input.driverId,
          executionContextId: input.executionContextId,
          explanation: input.reason === undefined ? explanation : reason,
          emailSnapshot,
          emailStatus: 'PREPARED',
          reasonCode,
          recipientAccountId: input.accountId,
          routeVersion: input.routeVersion,
          shopId: input.shopId,
          targetStopId: input.targetStopId,
        },
        select: { id: true },
      });
      const notification = await transaction.dsvOperationalNotification.create({
        data: {
          assignmentEpoch: BigInt(input.assignmentEpoch),
          audience: 'OPS',
          businessStatus: 'OPEN',
          dueAt: input.occurredAt,
          eventId: report.id,
          executionContextId: input.executionContextId,
          expiresAt: new Date(input.occurredAt.getTime() + 30 * 24 * 60 * 60 * 1_000),
          kind: 'N07',
          logicalKey: `N07:${input.executionContextId}:${input.assignmentEpoch}:${input.commandId}`,
          payload: { reasonCode, schema: 'dsv_delivery_exception_v1' },
          routeVersion: input.routeVersion,
          shopId: input.shopId,
          targetStopId: input.targetStopId,
        },
        select: { id: true },
      });
      const result: DsvReportDeliveryExceptionResult = {
        assignmentEpoch: input.assignmentEpoch,
        commandId: input.commandId,
        duplicate: false,
        exceptionId: report.id,
        executionContextId: input.executionContextId,
        emailStatus: 'PREPARED',
        reportStatus: 'ACCEPTED',
        notificationId: notification.id,
        routeVersion: input.routeVersion,
      };
      await storeCommandResult(transaction, input, 'REPORT_DELIVERY_EXCEPTION', payloadHash, result);
      return result;
    });
  }

  async listDeliveryExceptions(input: {
    cursor?: string;
    limit?: number;
    shopId: string;
  }): Promise<{ items: DsvDeliveryExceptionView[]; nextCursor: string | null }> {
    validateUuid(input.shopId, 'shopId');
    const limit = Math.max(1, Math.min(input.limit ?? 30, 100));
    const cursor = decodeReportCursor(input.cursor);
    const rows = await this.prisma.dsvDeliveryException.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      where: {
        shopId: input.shopId,
        ...(cursor === null ? {} : {
          OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }],
        }),
      },
    });
    const page = rows.slice(0, limit);
    return {
      items: page.map(toDeliveryExceptionView),
      nextCursor: rows.length > limit && page.length > 0
        ? encodeReportCursor(page[page.length - 1]!)
        : null,
    };
  }

  async getDeliveryException(input: { id: string; shopId: string }): Promise<DsvDeliveryExceptionView> {
    validateUuid(input.id, 'id');
    validateUuid(input.shopId, 'shopId');
    const report = await this.prisma.dsvDeliveryException.findFirst({ where: { id: input.id, shopId: input.shopId } });
    if (report === null) throw new DsvExecutionCommandError('REPORT_NOT_FOUND');
    return toDeliveryExceptionView(report);
  }

  acknowledgeDeliveryException(input: { id: string; now?: Date; shopId: string }): Promise<DsvDeliveryExceptionView> {
    return this.transitionDeliveryException({ ...input, transition: 'ACKNOWLEDGE' });
  }

  resolveDeliveryException(input: { id: string; now?: Date; shopId: string }): Promise<DsvDeliveryExceptionView> {
    return this.transitionDeliveryException({ ...input, transition: 'RESOLVE' });
  }

  private async transitionDeliveryException(input: {
    id: string;
    now?: Date;
    shopId: string;
    transition: 'ACKNOWLEDGE' | 'RESOLVE';
  }): Promise<DsvDeliveryExceptionView> {
    validateUuid(input.id, 'id');
    validateUuid(input.shopId, 'shopId');
    const now = input.now ?? new Date();
    validateOccurredAt(now);
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw`
        SELECT id FROM dsv_delivery_exceptions
        WHERE id = ${input.id}::uuid AND "shopId" = ${input.shopId}::uuid
        FOR UPDATE
      `;
      const existing = await transaction.dsvDeliveryException.findFirst({ where: { id: input.id, shopId: input.shopId } });
      if (existing === null) throw new DsvExecutionCommandError('REPORT_NOT_FOUND');
      const report = input.transition === 'ACKNOWLEDGE'
        ? existing.acknowledgedAt === null && existing.resolvedAt === null
          ? await transaction.dsvDeliveryException.update({
              data: { acknowledgedAt: now, status: 'ACKNOWLEDGED' }, where: { id: existing.id },
            })
          : existing
        : existing.resolvedAt === null
          ? await transaction.dsvDeliveryException.update({
              data: { acknowledgedAt: existing.acknowledgedAt ?? now, resolvedAt: now, status: 'RESOLVED' },
              where: { id: existing.id },
            })
          : existing;
      if (input.transition === 'RESOLVE') {
        await transaction.dsvOperationalNotification.updateMany({
          data: { businessStatus: 'RESOLVED', resolutionReason: 'OPERATIONS_RESOLVED', resolvedAt: report.resolvedAt ?? now },
          where: { audience: 'OPS', businessStatus: 'OPEN', eventId: existing.id, kind: 'N07', shopId: input.shopId },
        });
      }
      return toDeliveryExceptionView(report);
    });
  }

  private recordEvent(
    transaction: ExecutionCommandTx,
    input: RecordDriverEventInput,
  ): Promise<RecordDriverEventResult> {
    return this.driverEvents.recordDriverEventInTransaction(
      transaction as unknown as DriverEventTransactionClient,
      input,
      { skipDsvExecutionSync: true },
    );
  }
}

function toDeliveryExceptionView(report: {
  acknowledgedAt: Date | null;
  assignmentEpoch: bigint;
  createdAt: Date;
  driverId: string;
  executionContextId: string;
  explanation: string | null;
  emailStatus: string;
  emailSentAt: Date | null;
  id: string;
  reasonCode: string;
  resolvedAt: Date | null;
  routeVersion: number;
  status: string;
  targetStopId: string;
}): DsvDeliveryExceptionView {
  return {
    acknowledgedAt: report.acknowledgedAt?.toISOString() ?? null,
    assignmentEpoch: report.assignmentEpoch.toString(),
    createdAt: report.createdAt.toISOString(),
    driverId: report.driverId,
    executionContextId: report.executionContextId,
    explanation: report.explanation,
    emailStatus: report.emailStatus,
    emailSentAt: report.emailSentAt?.toISOString() ?? null,
    id: report.id,
    reason: report.explanation ?? report.reasonCode,
    reasonCode: report.reasonCode,
    resolvedAt: report.resolvedAt?.toISOString() ?? null,
    routeVersion: report.routeVersion,
    status: report.status,
    targetStopId: report.targetStopId,
  };
}

function decodeReportCursor(value: string | undefined): { createdAt: Date; id: string } | null {
  if (value === undefined) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('invalid cursor');
    const record = parsed as Record<string, unknown>;
    if (Object.keys(record).length !== 2 || !validateUuidValue(record.id) || typeof record.createdAt !== 'string') throw new Error('invalid cursor');
    const createdAt = new Date(record.createdAt);
    if (!Number.isFinite(createdAt.getTime()) || createdAt.toISOString() !== record.createdAt) throw new Error('invalid cursor');
    return { createdAt, id: record.id };
  } catch {
    throw new DsvExecutionCommandError('INVALID_INPUT', 'cursor is invalid');
  }
}

function encodeReportCursor(value: { createdAt: Date; id: string }): string {
  return Buffer.from(JSON.stringify({ createdAt: value.createdAt.toISOString(), id: value.id })).toString('base64url');
}

function validateUuidValue(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

async function lockAndValidateExecution(
  tx: ExecutionCommandTx,
  input: DsvExecutionFence,
): Promise<LockedExecution> {
  const contextReference = await tx.dsvExecutionContext.findUnique({
    select: { routePlanId: true },
    where: { id_shopId: { id: input.executionContextId, shopId: input.shopId } },
  });
  if (contextReference === null) throw new DsvExecutionCommandError('CONTEXT_NOT_FOUND');
  const lockedRoutes = await tx.$queryRaw<Array<{ assignmentGeneration: bigint; driverId: string | null; id: string }>>(Prisma.sql`
    SELECT "assignmentGeneration", "driverId", "id"
    FROM "route_plans"
    WHERE "id" = ${contextReference.routePlanId}::uuid AND "shopId" = ${input.shopId}::uuid
    FOR UPDATE
  `);
  const lockedRoute = lockedRoutes[0];
  if (lockedRoute === undefined || lockedRoute.driverId !== input.driverId) {
    throw new DsvExecutionCommandError('ASSIGNMENT_CHANGED');
  }
  const rows = await tx.$queryRaw<LockedExecution[]>(Prisma.sql`
    SELECT "assignmentEpoch", "driverId", "recipientAccountId", "routePlanId", "routeVersion", "serviceDate", "status"
    FROM "dsv_execution_contexts"
    WHERE "id" = ${input.executionContextId}::uuid AND "shopId" = ${input.shopId}::uuid
    FOR UPDATE
  `);
  const execution = rows[0];
  if (execution === undefined) throw new DsvExecutionCommandError('CONTEXT_NOT_FOUND');
  if (execution.status !== 'ACTIVE') throw new DsvExecutionCommandError('CONTEXT_CLOSED');
  if (execution.routeVersion !== input.routeVersion) throw new DsvExecutionCommandError('ROUTE_VERSION_CHANGED');
  if (execution.assignmentEpoch !== BigInt(input.assignmentEpoch)) throw new DsvExecutionCommandError('ASSIGNMENT_CHANGED');
  if (execution.driverId !== input.driverId || execution.recipientAccountId !== input.accountId) {
    throw new DsvExecutionCommandError('UNAUTHORIZED');
  }
  if (execution.routePlanId !== lockedRoute.id
    || lockedRoute.assignmentGeneration !== BigInt(input.assignmentGeneration)) {
    throw new DsvExecutionCommandError('ASSIGNMENT_CHANGED');
  }

  const [driver, currentVersion] = await Promise.all([
    tx.driver.findFirst({
      select: { id: true },
      where: {
        account: { id: input.accountId, status: 'ACTIVE' },
        accountId: input.accountId,
        id: input.driverId,
        isStoreReviewData: false,
        shopId: input.shopId,
        status: 'ACTIVE',
      },
    }),
    tx.routeGroupingChildVersion.findFirst({
      select: { id: true },
      where: {
        id: input.expectedRouteVersionId,
        routePlanId: execution.routePlanId,
        shopId: input.shopId,
        status: 'CURRENT',
        supersededAt: null,
      },
    }),
  ]);
  if (driver === null) throw new DsvExecutionCommandError('UNAUTHORIZED');
  if (currentVersion === null) throw new DsvExecutionCommandError('ROUTE_VERSION_CHANGED');
  return execution;
}

async function lockCommand(
  tx: ExecutionCommandTx,
  shopId: string,
  commandName: string,
  commandId: string,
): Promise<void> {
  await tx.$queryRaw<Array<{ locked: number }>>(Prisma.sql`
    WITH command_lock AS (
      SELECT pg_advisory_xact_lock(hashtextextended(${`${shopId}:${commandName}:${commandId}`}, 0))
    )
    SELECT 1 AS locked FROM command_lock
  `);
}

async function findExistingStartEvents(
  tx: ExecutionCommandTx,
  routePlanId: string,
  input: DsvExecutionFence,
): Promise<{
  pickupCompleted: { occurredAt: Date; result: RecordDriverEventResult } | null;
  routeStarted: { occurredAt: Date; result: RecordDriverEventResult } | null;
}> {
  const events = await tx.driverEvent.findMany({
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    select: { eventType: true, id: true, occurredAt: true },
    where: {
      driverId: input.driverId,
      eventType: { in: ['ROUTE_STARTED', 'PICKUP_COMPLETED'] },
      routePlanId,
      shopId: input.shopId,
    },
  });
  const routeStarted = events.find((event) => event.eventType === 'ROUTE_STARTED');
  const pickupCompleted = events.find((event) => event.eventType === 'PICKUP_COMPLETED');
  return {
    pickupCompleted: pickupCompleted === undefined ? null : {
      occurredAt: pickupCompleted.occurredAt,
      result: { duplicate: true, eventId: pickupCompleted.id },
    },
    routeStarted: routeStarted === undefined ? null : {
      occurredAt: routeStarted.occurredAt,
      result: { duplicate: true, eventId: routeStarted.id },
    },
  };
}

async function readCommandReplay<T extends { duplicate: boolean }>(
  tx: ExecutionCommandTx,
  input: DsvExecutionFence & { commandId: string },
  commandName: string,
  payloadHash: string,
): Promise<T | null> {
  const existing = await tx.dsvExecutionCommand.findUnique({
    select: { payloadHash: true, result: true },
    where: { shopId_commandName_commandId: { commandId: input.commandId, commandName, shopId: input.shopId } },
  });
  if (existing === null) return null;
  if (existing.payloadHash !== payloadHash) throw new DsvExecutionCommandError('COMMAND_CONFLICT');
  return existing.result as T;
}

async function storeCommandResult(
  tx: ExecutionCommandTx,
  input: DsvExecutionFence & { commandId: string },
  commandName: string,
  payloadHash: string,
  result: DsvStartExecutionResult | DsvReportDeliveryExceptionResult,
): Promise<void> {
  await tx.dsvExecutionCommand.create({
    data: {
      commandId: input.commandId,
      commandName,
      payloadHash,
      result,
      shopId: input.shopId,
    },
  });
}

function commandHash(commandName: string, input: object): string {
  const canonical = JSON.stringify(input, (_key, value: unknown) => value instanceof Date ? value.toISOString() : value);
  return createHash('sha256').update(`${commandName}\n${canonical}`).digest('hex');
}

function deterministicEventId(commandId: string, suffix: string): string {
  return `dsv:${commandId}:${suffix}`;
}

function validateFence(input: DsvExecutionFence): void {
  validateUuid(input.accountId, 'accountId');
  validateUuid(input.driverId, 'driverId');
  validateUuid(input.executionContextId, 'executionContextId');
  validateUuid(input.expectedRouteVersionId, 'expectedRouteVersionId');
  validateUuid(input.shopId, 'shopId');
  if (!Number.isSafeInteger(input.routeVersion) || input.routeVersion < 1) {
    throw new DsvExecutionCommandError('INVALID_INPUT', 'routeVersion is invalid');
  }
  validatePositiveBigint(input.assignmentEpoch, 'assignmentEpoch');
  validatePositiveBigint(input.assignmentGeneration, 'assignmentGeneration');
  if (input.shopDomain.trim() === '' || input.shopDomain.length > 255) {
    throw new DsvExecutionCommandError('INVALID_INPUT', 'shopDomain is invalid');
  }
}

function validatePositiveBigint(value: string, field: string): void {
  if (!/^[1-9]\d{0,18}$/u.test(value) || BigInt(value) > MAX_SIGNED_BIGINT) {
    throw new DsvExecutionCommandError('INVALID_INPUT', `${field} is invalid`);
  }
}

function validateCommandId(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new DsvExecutionCommandError('INVALID_INPUT', 'commandId is invalid');
  }
}

function validateUuid(value: string, field: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new DsvExecutionCommandError('INVALID_INPUT', `${field} is invalid`);
  }
}

function validateOccurredAt(value: Date): void {
  if (!Number.isFinite(value.getTime())) throw new DsvExecutionCommandError('INVALID_INPUT', 'occurredAt is invalid');
}

function requiredBoundedText(value: string, field: string, max: number, multiline = false): string {
  const normalized = value.trim();
  const checked = multiline ? normalized.replace(/[\t\n\r]/gu, '') : normalized;
  if (normalized === '' || normalized.length > max || containsControlCharacter(checked)) {
    throw new DsvExecutionCommandError('INVALID_INPUT', `${field} is invalid`);
  }
  return normalized;
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
}

function optionalBoundedText(value: string | null | undefined, field: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  return requiredBoundedText(value, field, max);
}
