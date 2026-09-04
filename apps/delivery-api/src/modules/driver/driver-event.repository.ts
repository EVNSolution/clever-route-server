import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { safeErrorCode } from '../security/safe-telemetry-redaction.js';
import { assertRoutePlanExecutionOwnership, RouteExecutionConflictError } from '../route-plans/route-execution-ownership.js';
import { ROUTE_ACTIVE_COMPATIBILITY_STATUSES, ROUTE_READY_COMPATIBILITY_STATUSES } from '../route-plans/route-plan-lifecycle.js';
import { readRouteStopPoints } from '../route-plans/route-plan-geometry-cache.js';
import { persistRouteTrackingGeometryPosition } from '../route-tracking/route-tracking.geometry.js';
import { persistAutomaticCustomerEmailFacts } from '../customer-email/customer-email-automatic-fact.js';
import { deriveDsvTimeConstraintState, dsvTimeConstraintAuditEvents } from '../dsv/dsv-time-constraint.js';
import {
  buildDriverRouteEtaSnapshot,
  calculateArrivalEtaUpdate,
  calculateCompletionEtaUpdate,
  calculatePickupEtaUpdate,
  calculateRouteStartEtaUpdate,
  type DriverRouteEtaStop,
  type DriverRouteEtaSnapshot,
  type DriverRouteEtaUpdate
} from './driver-route-eta.js';
import {
  completionInvariantDecision,
  DriverRouteCompletionIncompleteError,
  type DriverRouteCompletionInvariantEvidence,
  type DriverRouteCompletionInvariantMode
} from './driver-route-completion-invariant.js';

export { DriverRouteCompletionIncompleteError } from './driver-route-completion-invariant.js';

export type RecordDriverEventInput = {
  appVersion?: string | null;
  attemptId?: string | null;
  assignmentGeneration?: string | null;
  changeRequestId?: string | null;
  clientEventId: string | null;
  deliveryStopId: string | null;
  driverId: string;
  driverContractVersion?: number | null;
  eventType: string;
  expectedRouteVersionId?: string | null;
  latitude: string | null;
  longitude: string | null;
  occurredAt: Date;
  payload: unknown;
  routePlanId: string | null;
  shopDomain: string;
  shopId: string;
  requestId?: string;
  versionCode?: number | null;
};

export type DriverEventAttemptAdmissionInput = {
  appVersion: string | null;
  assignmentGeneration: string | null;
  clientEventId: string | null;
  driverContractVersion: 2;
  driverId: string;
  eventType: string | null;
  expectedRouteVersionId: string | null;
  occurredAt: Date | null;
  requestId: string;
  routePlanId: string | null;
  shopId: string;
  versionCode: number | null;
};

export type DriverEventAttemptAdmission = { attemptId: string; attemptNumber: number };

export type DriverEventAttemptReconciliationCode =
  | 'APPLIED_OUT_OF_BAND'
  | 'CONFIRMED_REJECTED'
  | 'SUPERSEDED';

export type DriverEventAttemptFinalization = {
  committedEventId?: string;
  errorCode?: string;
  failureStage?: string;
  retryable?: boolean;
  status: 'APPLIED' | 'DUPLICATE' | 'FAILED' | 'REJECTED';
};

export type RecordDriverEventResult = {
  duplicate: boolean;
  etaSnapshot?: DriverRouteEtaSnapshot;
  etaUpdate?: DriverRouteEtaUpdate;
  eventId: string;
  sequenceDeviation?: DriverStopSequenceDeviation;
};

export type CompleteDriverDeliveryDestinationInput = {
  clientEventId: string;
  deliveryStopIds: string[];
  destinationId: string;
  driverId: string;
  occurredAt: Date;
  payload: unknown;
  routePlanId: string;
  shopDomain: string;
  shopId: string;
};

export type DriverStopSequenceDeviation = {
  expectedDeliveryStopId: string;
  expectedSequence: number;
  selectedDeliveryStopId: string;
  selectedSequence: number;
};

type DriverEventPrismaClient = Pick<
  PrismaClient,
  '$queryRaw' | '$transaction' | 'customerRouteNotificationFact' | 'deliveryStop' | 'driverEvent' | 'driverEventAttempt' | 'driverRouteCompletionReview' | 'dsvDispatchChangeRequest' | 'order' | 'routeGroupingChildVersion' | 'routePlan' | 'routePlanGeometryCache' | 'routePlanStop' | 'routeTrackingGeometry' | 'shop'
>;

type DriverEventTransactionClient = Pick<
  Prisma.TransactionClient,
  '$queryRaw' | 'customerRouteNotificationFact' | 'deliveryStop' | 'driverEvent' | 'driverEventAttempt' | 'driverRouteCompletionReview' | 'dsvDispatchChangeRequest' | 'order' | 'routeGroupingChildVersion' | 'routePlan' | 'routePlanGeometryCache' | 'routePlanStop' | 'routeTrackingGeometry' | 'shop'
>;

type DriverEventSchemaCapabilities = {
  driverEventRouteVersionColumnExists: boolean;
  routePlanStopEtaOwnershipColumnsExist: boolean;
};

type DriverEventSchemaCapabilityLoader = {
  load: () => Promise<DriverEventSchemaCapabilities>;
};

type ExistingDriverEventContext = {
  createdAt?: Date;
  deliveryStopId: string | null;
  eventType: string;
  id: string;
  payload?: unknown;
  routePlanId: string | null;
};

const TERMINAL_DELIVERY_STOP_STATUSES = new Set([
  'CANCELLED',
  'DELIVERED',
  'FAILED',
  'SKIPPED'
]);

export class DriverEventContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DriverEventContextError';
  }
}

export class DriverEventScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DriverEventScopeError';
  }
}

export class DriverEventRouteNotInProgressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DriverEventRouteNotInProgressError';
  }
}

export class DriverEventExecutionConflictError extends RouteExecutionConflictError {
  constructor(conflictingRoutePlanId: string, deliveryStopId: string) {
    super(conflictingRoutePlanId, deliveryStopId);
    this.name = 'DriverEventExecutionConflictError';
  }
}

export class DriverEventEtaStaleConflictError extends Error {
  constructor(routePlanId: string) {
    super(`ETA update is stale for route plan ${routePlanId}`);
    this.name = 'DriverEventEtaStaleConflictError';
  }
}

export class DriverEventStopTransitionConflictError extends Error {
  readonly code = 'STOP_STATE_CONFLICT';

  constructor() {
    super('Delivery stop state cannot regress or change to a conflicting terminal state');
    this.name = 'DriverEventStopTransitionConflictError';
  }
}

export class DriverEventSellerOrderAssignmentChangedError extends Error {
  constructor(message = 'Seller order assignment changed before acknowledgement') {
    super(message);
    this.name = 'DriverEventSellerOrderAssignmentChangedError';
  }
}

export class DriverEventRouteVersionMismatchError extends Error {
  readonly code = 'ROUTE_VERSION_MISMATCH';
  constructor() {
    super('The route version changed after this driver session was issued');
    this.name = 'DriverEventRouteVersionMismatchError';
  }
}

export class DriverEventAssignmentChangedError extends Error {
  readonly code = 'ROUTE_ASSIGNMENT_CHANGED';
  constructor() {
    super('The route assignment changed after this driver session was issued');
    this.name = 'DriverEventAssignmentChangedError';
  }
}

export class DriverEventAdmissionUnavailableError extends Error {
  readonly code = 'DRIVER_EVENT_ADMISSION_UNAVAILABLE';
  constructor() {
    super('Driver event evidence could not be durably admitted');
    this.name = 'DriverEventAdmissionUnavailableError';
  }
}

export class PrismaDriverEventRepository {
  private readonly schemaCapabilityLoader: DriverEventSchemaCapabilityLoader;
  private readonly attemptRetentionDays: number;
  private readonly completionInvariantMode: DriverRouteCompletionInvariantMode;
  private readonly completionReviewRetentionDays: number;
  private readonly completionInvariantMonitor: {
    recordWouldReject(input: { decision: 'PERMITTED' | 'REJECTED'; mode: DriverRouteCompletionInvariantMode; receiptAware: boolean; totalStopCount: number; unresolvedStopCount: number }): void;
  };
  private readonly now: () => Date;
  private readonly finalizationMonitor: {
    recordFailure(input: { attemptId: string; errorCode: string }): void;
  };

  constructor(
    private readonly prisma: DriverEventPrismaClient,
    options: {
      attemptRetentionDays?: number;
      completionReviewRetentionDays?: number;
      completionInvariantMode?: DriverRouteCompletionInvariantMode;
      completionInvariantMonitor?: { recordWouldReject(input: { decision: 'PERMITTED' | 'REJECTED'; mode: DriverRouteCompletionInvariantMode; receiptAware: boolean; totalStopCount: number; unresolvedStopCount: number }): void };
      finalizationMonitor?: { recordFailure(input: { attemptId: string; errorCode: string }): void };
      now?: () => Date;
    } = {}
  ) {
    this.schemaCapabilityLoader = schemaCapabilityLoaderFor(prisma);
    this.attemptRetentionDays = options.attemptRetentionDays ?? 90;
    this.completionReviewRetentionDays = options.completionReviewRetentionDays ?? 365;
    this.completionInvariantMode = options.completionInvariantMode ?? 'OBSERVE';
    this.completionInvariantMonitor = options.completionInvariantMonitor ?? {
      recordWouldReject: (evidence) => process.stdout.write(`${JSON.stringify({
        ...evidence,
        event: 'driver_route_completion_invariant',
        wouldReject: true
      })}\n`)
    };
    this.now = options.now ?? (() => new Date());
    this.finalizationMonitor = options.finalizationMonitor ?? {
      recordFailure: (evidence) => process.stderr.write(`${JSON.stringify({
        ...evidence,
        event: 'driver_event_attempt_finalization_failed'
      })}\n`)
    };
  }

  async completeDeliveryDestination(
    input: CompleteDriverDeliveryDestinationInput
  ): Promise<RecordDriverEventResult[]> {
    const deliveryStopIds = [...new Set(input.deliveryStopIds)];
    if (
      deliveryStopIds.length === 0
      || deliveryStopIds.length !== input.deliveryStopIds.length
      || deliveryStopIds.length > 50
    ) {
      throw new DriverEventContextError('Destination completion requires 1 to 50 unique delivery stops');
    }
    const eligibleStops = await this.prisma.deliveryStop.findMany({
      select: { id: true },
      where: {
        id: { in: deliveryStopIds },
        order: { destinationId: input.destinationId },
        routePlanStops: { some: { routePlanId: input.routePlanId } },
        shopId: input.shopId
      }
    });
    const eligibleStopIds = new Set(eligibleStops.map(({ id }) => id));
    if (deliveryStopIds.some((deliveryStopId) => !eligibleStopIds.has(deliveryStopId))) {
      throw new DriverEventScopeError('All delivery stops must belong to the selected destination and route');
    }

    const results: RecordDriverEventResult[] = [];
    for (const deliveryStopId of deliveryStopIds) {
      results.push(await this.recordDriverEvent({
        clientEventId: `${input.clientEventId}:${deliveryStopId}`,
        deliveryStopId,
        driverId: input.driverId,
        eventType: 'STOP_DELIVERED',
        latitude: null,
        longitude: null,
        occurredAt: input.occurredAt,
        payload: input.payload,
        routePlanId: input.routePlanId,
        shopDomain: input.shopDomain,
        shopId: input.shopId
      }));
    }
    return results;
  }

  async recordDriverEvent(input: RecordDriverEventInput): Promise<RecordDriverEventResult> {
    const schemaCapabilities = await this.schemaCapabilityLoader.load();
    const admission = input.attemptId === undefined
      ? await this.admitVersionedAttempt(input)
      : input.attemptId === null ? null : { attemptId: input.attemptId, attemptNumber: 0 };
    const attemptId = admission?.attemptId ?? null;
    try {
      const result = await this.prisma.$transaction(async (transaction) => {
        const duplicate = await findMatchingDriverEvent(transaction, input);
        if (duplicate !== null) {
          return {
            completionInvariant: null,
            duplicate: true,
            eventId: duplicate.id,
            ...(isEtaSnapshotRecoveryEvent(input.eventType)
              ? { etaSnapshot: await buildCurrentEtaSnapshotForDuplicate(transaction, input) }
              : {})
          };
        }

        await lockRoutePlanForSerializedEvent(transaction, input);
        await validateVersionedOrderedContract(transaction, input);
        await validateDriverEventStateContext(transaction, input, input.shopId);
        const completionInvariant = await evaluateCompletionInvariant(transaction, input, this.completionInvariantMode);
        if (completionInvariant?.decision === 'REJECTED') {
          if (attemptId !== null) {
            await transaction.driverEventAttempt.update({
              data: {
                committedEventId: null,
                errorCode: 'ROUTE_COMPLETION_INCOMPLETE',
                failureStage: 'BUSINESS_VALIDATION',
                retryable: false,
                status: 'REJECTED'
              },
              where: { id: attemptId }
            });
          }
          await transaction.driverRouteCompletionReview.create({
            data: completionReviewData(input, attemptId, null, completionInvariant, this.reviewRetainedUntil())
          });
          return { completionRejected: completionInvariant };
        }
        const sequenceDeviation = await detectStopSequenceDeviation(transaction, input);
        const routeVersionId = input.routePlanId === null
          ? null
          : await loadCurrentRouteVersionIdForDriverEvent(transaction, schemaCapabilities, input.routePlanId, input.shopId);

        const event = await transaction.driverEvent.create({
          data: {
            clientEventId: input.clientEventId,
            deliveryStopId: input.deliveryStopId,
            driverId: input.driverId,
            eventType: input.eventType as never,
            latitude: input.latitude,
            longitude: input.longitude,
            occurredAt: input.occurredAt,
            payload: persistedDriverEventPayload(input, completionInvariant),
            routePlanId: input.routePlanId,
            ...(input.driverContractVersion === undefined || input.driverContractVersion === null
              ? {}
              : {
                  assignmentGeneration: BigInt(requireAssignmentGeneration(input)),
                  driverContractVersion: input.driverContractVersion,
                  expectedRouteVersionId: requireExpectedRouteVersionId(input)
                }),
            ...(routeVersionId === undefined ? {} : { routeVersionId }),
            shopId: input.shopId
          }
        });

        if (completionInvariant !== null) {
          await transaction.driverRouteCompletionReview.create({
            data: completionReviewData(input, attemptId, event.id, completionInvariant, this.reviewRetainedUntil())
          });
        }

        const trackingPosition = toRouteTrackingGeometryPosition(input, event.id, event.createdAt);
        if (trackingPosition !== null) {
          await persistRouteTrackingGeometryPosition(transaction, trackingPosition);
        }
        await applyDispatchChangeRequestAck(transaction, input, event.id, event.createdAt);

        const etaResult = await applyDriverEventStateTransition(
          transaction,
          schemaCapabilities,
          input,
          input.shopId,
          event.createdAt,
          routeVersionId,
          event.id
        );
        if (transaction.customerRouteNotificationFact !== undefined && transaction.shop !== undefined) {
          await persistAutomaticCustomerEmailFacts(transaction, {
            deliveryStopId: input.deliveryStopId,
            driverEventId: event.id,
            eventType: input.eventType,
            occurredAt: input.occurredAt,
            routePlanId: input.routePlanId,
            shopId: input.shopId
          });
        }

        return {
          completionInvariant,
          duplicate: false,
          ...(etaResult.etaSnapshot === undefined ? {} : { etaSnapshot: etaResult.etaSnapshot }),
          ...(etaResult.etaUpdate === undefined ? {} : { etaUpdate: etaResult.etaUpdate }),
          eventId: event.id,
          ...(sequenceDeviation === null ? {} : { sequenceDeviation })
        };
      });
      const committedCompletionEvidence = 'completionRejected' in result
        ? result.completionRejected
        : 'completionInvariant' in result ? result.completionInvariant : null;
      if (committedCompletionEvidence?.wouldReject === true) {
        try {
          this.completionInvariantMonitor.recordWouldReject({
            decision: committedCompletionEvidence.decision,
            mode: committedCompletionEvidence.mode,
            receiptAware: committedCompletionEvidence.receiptAware,
            totalStopCount: committedCompletionEvidence.totalStopCount,
            unresolvedStopCount: committedCompletionEvidence.unresolvedStopCount
          });
        } catch (error) {
          process.stderr.write(`${JSON.stringify({
            errorCode: safeErrorCode(error),
            event: 'driver_route_completion_invariant_monitor_failure'
          })}\n`);
        }
      }
      if ('completionRejected' in result) {
        throw new DriverRouteCompletionIncompleteError(result.completionRejected);
      }
      const publicResult = publicRecordDriverEventResult(result);
      await this.finalizeAttempt(attemptId, {
        committedEventId: publicResult.eventId,
        status: publicResult.duplicate ? 'DUPLICATE' : 'APPLIED'
      });
      return publicResult;
    } catch (error) {
      if (error instanceof DriverRouteCompletionIncompleteError) {
        throw error;
      }
      if (isUniqueConstraintError(error)) {
        const duplicate = await findDuplicateDriverEventAfterUniqueConstraint(this.prisma, input);
        if (duplicate !== null) {
          await this.finalizeAttempt(attemptId, {
            committedEventId: duplicate.id,
            status: 'DUPLICATE'
          });
          return {
            duplicate: true,
            eventId: duplicate.id,
            ...(isEtaSnapshotRecoveryEvent(input.eventType)
              ? { etaSnapshot: await buildCurrentEtaSnapshotForDuplicate(this.prisma, input) }
              : {})
          };
        }
      }

      await this.finalizeAttempt(attemptId, attemptFailureFor(error));

      throw error;
    }
  }

  private reviewRetainedUntil(): Date {
    return new Date(this.now().getTime() + this.completionReviewRetentionDays * 24 * 60 * 60 * 1000);
  }

  async admitDriverEventAttempt(input: DriverEventAttemptAdmissionInput): Promise<DriverEventAttemptAdmission> {
    try {
      return await this.createDriverEventAttempt(input);
    } catch (error) {
      if (error instanceof DriverEventAdmissionUnavailableError) throw error;
      throw new DriverEventAdmissionUnavailableError();
    }
  }

  private async createDriverEventAttempt(input: DriverEventAttemptAdmissionInput): Promise<DriverEventAttemptAdmission> {
    const retainedUntil = new Date(this.now().getTime() + this.attemptRetentionDays * 24 * 60 * 60 * 1000);
    for (let retry = 0; retry < 5; retry += 1) {
      const latest = input.clientEventId === null ? null : await this.prisma.driverEventAttempt.findFirst({
        orderBy: { attemptNumber: 'desc' },
        select: { attemptNumber: true },
        where: { clientEventId: input.clientEventId, driverId: input.driverId }
      });
      const attemptNumber = (latest?.attemptNumber ?? 0) + 1;
      try {
        const attempt = await this.prisma.driverEventAttempt.create({
          data: {
            appVersion: input.appVersion,
            assignmentGeneration: input.assignmentGeneration === null ? null : BigInt(input.assignmentGeneration),
            attemptNumber,
            clientEventId: input.clientEventId,
            driverContractVersion: input.driverContractVersion,
            driverId: input.driverId,
            eventType: input.eventType,
            expectedRouteVersionId: input.expectedRouteVersionId,
            occurredAt: input.occurredAt,
            requestId: randomUUID(),
            retainedUntil,
            routePlanId: input.routePlanId,
            shopId: input.shopId,
            transportRequestId: input.requestId,
            versionCode: input.versionCode
          },
          select: { attemptNumber: true, id: true }
        });
        return { attemptId: attempt.id, attemptNumber: attempt.attemptNumber };
      } catch (error) {
        if (isUniqueConstraintError(error) && retry < 4) continue;
        throw new DriverEventAdmissionUnavailableError();
      }
    }
    throw new DriverEventAdmissionUnavailableError();
  }

  async finalizeDriverEventAttempt(attemptId: string, result: DriverEventAttemptFinalization): Promise<void> {
    await this.finalizeAttempt(attemptId, result);
  }

  async reconcileRejectedDriverEventAttempt(input: {
    attemptId: string;
    reconciliationCode: DriverEventAttemptReconciliationCode;
    shopId: string;
  }): Promise<boolean> {
    const result = await this.prisma.driverEventAttempt.updateMany({
      data: { reconciledAt: this.now(), reconciliationCode: input.reconciliationCode },
      where: { id: input.attemptId, reconciledAt: null, shopId: input.shopId, status: 'REJECTED' }
    });
    return result.count === 1;
  }

  private async admitVersionedAttempt(input: RecordDriverEventInput): Promise<DriverEventAttemptAdmission | null> {
    if (!isVersionedOrderedEvent(input)) return null;
    return this.admitDriverEventAttempt({
      appVersion: input.appVersion ?? null,
      assignmentGeneration: requireAssignmentGeneration(input),
      clientEventId: requireClientEventId(input),
      driverContractVersion: 2,
      driverId: input.driverId,
      eventType: input.eventType,
      expectedRouteVersionId: requireExpectedRouteVersionId(input),
      occurredAt: input.occurredAt,
      requestId: input.requestId ?? randomUUID(),
      routePlanId: requireRoutePlanId(input),
      shopId: input.shopId,
      versionCode: input.versionCode ?? null
    });
  }

  private async finalizeAttempt(
    attemptId: string | null,
    result: DriverEventAttemptFinalization
  ): Promise<void> {
    if (attemptId === null) return;
    try {
      await this.prisma.driverEventAttempt.update({
        data: {
          committedEventId: result.committedEventId ?? null,
          errorCode: result.errorCode ?? null,
          failureStage: result.failureStage ?? null,
          retryable: result.retryable ?? null,
          status: result.status
        },
        where: { id: attemptId }
      });
    } catch (error) {
      // The accepted row deliberately remains ACCEPTED. Receipt lookup resolves a
      // committed DriverEvent first, so a response/update gap is never misreported.
      this.finalizationMonitor.recordFailure({
        attemptId,
        errorCode: safeErrorCode(error instanceof Error ? error.name : 'UNKNOWN')
      });
    }
  }

}

function publicRecordDriverEventResult(result: RecordDriverEventResult): RecordDriverEventResult {
  return {
    duplicate: result.duplicate,
    ...(result.etaSnapshot === undefined ? {} : { etaSnapshot: result.etaSnapshot }),
    ...(result.etaUpdate === undefined ? {} : { etaUpdate: result.etaUpdate }),
    eventId: result.eventId,
    ...(result.sequenceDeviation === undefined ? {} : { sequenceDeviation: result.sequenceDeviation })
  };
}

function isVersionedOrderedEvent(input: RecordDriverEventInput): boolean {
  return input.driverContractVersion !== undefined
    && input.driverContractVersion !== null
    && input.driverContractVersion >= 2
    && input.eventType !== 'LOCATION_UPDATED';
}

function requireClientEventId(input: RecordDriverEventInput): string {
  if (input.clientEventId === null) throw new DriverEventContextError('Versioned ordered events require clientEventId');
  return input.clientEventId;
}

function requireExpectedRouteVersionId(input: RecordDriverEventInput): string {
  if (input.expectedRouteVersionId === undefined || input.expectedRouteVersionId === null) {
    throw new DriverEventContextError('Versioned ordered events require expectedRouteVersionId');
  }
  return input.expectedRouteVersionId;
}

function requireAssignmentGeneration(input: RecordDriverEventInput): string {
  const value = input.assignmentGeneration;
  if (value === undefined || value === null || !/^[1-9]\d*$/u.test(value)) {
    throw new DriverEventContextError('Versioned ordered events require canonical assignmentGeneration');
  }
  const parsed = BigInt(value);
  if (parsed > 9223372036854775807n) throw new DriverEventContextError('assignmentGeneration is out of range');
  return value;
}

async function lockRoutePlanForSerializedEvent(
  prisma: DriverEventTransactionClient,
  input: RecordDriverEventInput
): Promise<void> {
  if (
    input.eventType !== 'ROUTE_STARTED'
    && input.eventType !== 'PICKUP_COMPLETED'
    && input.eventType !== 'STOP_ARRIVED'
    && input.eventType !== 'STOP_DELIVERED'
    && input.eventType !== 'ROUTE_COMPLETED'
  ) {
    return;
  }
  const routePlanId = requireRoutePlanId(input);
  const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "route_plans"
    WHERE "id" = ${routePlanId}::uuid
      AND "shopId" = ${input.shopId}::uuid
    FOR UPDATE
  `);
  if (rows[0] === undefined) throw new DriverEventAssignmentChangedError();
}

async function validateVersionedOrderedContract(
  prisma: DriverEventTransactionClient,
  input: RecordDriverEventInput
): Promise<void> {
  if (!isVersionedOrderedEvent(input)) return;
  const routePlanId = requireRoutePlanId(input);
  const rows = await prisma.$queryRaw<Array<{ assignmentGeneration: bigint; driverId: string | null }>>(Prisma.sql`
    SELECT "assignmentGeneration", "driverId"
    FROM "route_plans"
    WHERE "id" = ${routePlanId}::uuid
      AND "shopId" = ${input.shopId}::uuid
    FOR UPDATE
  `);
  const route = rows[0];
  if (route === undefined || route.driverId !== input.driverId) {
    throw new DriverEventAssignmentChangedError();
  }
  if (route.assignmentGeneration.toString() !== requireAssignmentGeneration(input)) {
    throw new DriverEventAssignmentChangedError();
  }
  const currentRouteVersionId = await loadCurrentRouteVersionIdForDriverEvent(
    prisma,
    { driverEventRouteVersionColumnExists: true, routePlanStopEtaOwnershipColumnsExist: true },
    routePlanId,
    input.shopId
  );
  if (currentRouteVersionId !== requireExpectedRouteVersionId(input)) {
    throw new DriverEventRouteVersionMismatchError();
  }
}

function attemptFailureFor(error: unknown): {
  errorCode: string;
  failureStage: string;
  retryable: boolean;
  status: 'FAILED' | 'REJECTED';
} {
  if (error instanceof DriverEventRouteVersionMismatchError || error instanceof DriverEventAssignmentChangedError) {
    return { errorCode: error.code, failureStage: 'CONTRACT_VALIDATION', retryable: false, status: 'REJECTED' };
  }
  if (error instanceof DriverEventContextError || error instanceof DriverEventScopeError) {
    return { errorCode: 'DRIVER_EVENT_CONTEXT_REJECTED', failureStage: 'BUSINESS_VALIDATION', retryable: false, status: 'REJECTED' };
  }
  if (error instanceof DriverEventRouteNotInProgressError) {
    return { errorCode: 'ROUTE_NOT_IN_PROGRESS', failureStage: 'BUSINESS_VALIDATION', retryable: false, status: 'REJECTED' };
  }
  if (error instanceof DriverEventExecutionConflictError) {
    return { errorCode: 'ROUTE_EXECUTION_CONFLICT', failureStage: 'BUSINESS_VALIDATION', retryable: false, status: 'REJECTED' };
  }
  if (error instanceof DriverEventEtaStaleConflictError) {
    return { errorCode: 'ETA_STALE_CONFLICT', failureStage: 'BUSINESS_TRANSACTION', retryable: false, status: 'REJECTED' };
  }
  if (error instanceof DriverEventStopTransitionConflictError) {
    return { errorCode: error.code, failureStage: 'BUSINESS_VALIDATION', retryable: false, status: 'REJECTED' };
  }
  if (error instanceof DriverEventSellerOrderAssignmentChangedError) {
    return { errorCode: 'SELLER_ORDER_ASSIGNMENT_CHANGED', failureStage: 'BUSINESS_VALIDATION', retryable: false, status: 'REJECTED' };
  }
  return { errorCode: 'DRIVER_EVENT_TRANSIENT_FAILURE', failureStage: 'BUSINESS_TRANSACTION', retryable: true, status: 'FAILED' };
}

async function applyDispatchChangeRequestAck(
  prisma: Pick<DriverEventTransactionClient, '$queryRaw' | 'deliveryStop' | 'dsvDispatchChangeRequest' | 'order'>,
  input: RecordDriverEventInput,
  driverEventId: string,
  appliedAt: Date
): Promise<void> {
  if (input.eventType !== 'DISPATCH_CHANGE_ACKNOWLEDGED') return;
  if (prisma.dsvDispatchChangeRequest === undefined) return;
  const routePlanId = requireRoutePlanId(input);
  const changeRequestId = requireChangeRequestId(input);
  await prisma.$queryRaw`
    SELECT id
    FROM dsv_dispatch_change_requests
    WHERE id = ${changeRequestId}::uuid
      AND "shopId" = ${input.shopId}::uuid
    FOR UPDATE
  `;
  const request = await prisma.dsvDispatchChangeRequest.findFirst({
    select: { deliveryStopId: true, id: true, routeVersionId: true, sellerOrderId: true, timeWindowEnd: true, timeWindowStart: true, type: true },
    where: {
      id: changeRequestId,
      routePlanId,
      shopId: input.shopId,
      status: 'PENDING_ACK'
    }
  });
  if (request === null) throw new DriverEventContextError('Dispatch change request is not pending acknowledgement');
  const assignment = await prisma.order.findFirst({
    select: { currentRouteVersionId: true },
    where: { id: request.sellerOrderId, shopId: input.shopId }
  });
  if (assignment?.currentRouteVersionId !== request.routeVersionId) {
    throw new DriverEventSellerOrderAssignmentChangedError();
  }
  if (request.type === 'TIME_CONSTRAINT_CHANGE') {
    const updated = await prisma.deliveryStop.updateMany({
      data: {
        timeWindowEnd: request.timeWindowEnd,
        timeWindowStart: request.timeWindowStart
      },
      where: { id: request.deliveryStopId, shopId: input.shopId }
    });
    if (updated.count !== 1) throw new DriverEventContextError('Dispatch change request stop is unavailable');
  } else if (request.type === 'ACTIVE_ROUTE_ORDER_REMOVAL') {
    // Acknowledging this request used to mutate live membership while leaving the
    // CURRENT child-version snapshot unchanged. Reject until the operation is
    // routed through the immutable successor-version transaction.
    throw new DriverEventExecutionConflictError(routePlanId, request.deliveryStopId);
  }
  const applied = await prisma.dsvDispatchChangeRequest.updateMany({
    data: {
      appliedAt,
      appliedDriverEventId: driverEventId,
      status: 'APPLIED'
    },
    where: {
      id: request.id,
      shopId: input.shopId,
      status: 'PENDING_ACK'
    }
  });
  if (applied.count !== 1) {
    throw new DriverEventContextError('Dispatch change request acknowledgement already applied');
  }
}

async function detectStopSequenceDeviation(
  prisma: DriverEventTransactionClient,
  input: RecordDriverEventInput
): Promise<DriverStopSequenceDeviation | null> {
  if (
    input.eventType !== 'STOP_ARRIVED'
    && input.eventType !== 'STOP_DELIVERED'
    && input.eventType !== 'STOP_FAILED'
  ) {
    return null;
  }

  const selectedDeliveryStopId = requireDeliveryStopId(input);
  const routePlanId = requireRoutePlanId(input);
  const routeStops = await prisma.routePlanStop.findMany({
    orderBy: { sequence: 'asc' },
    select: {
      deliveryStop: { select: { status: true } },
      deliveryStopId: true,
      sequence: true
    },
    where: { routePlanId }
  });
  const expectedStop = routeStops.find(
    (stop) => !TERMINAL_DELIVERY_STOP_STATUSES.has(stop.deliveryStop.status)
  );
  const selectedStop = routeStops.find(
    (stop) => stop.deliveryStopId === selectedDeliveryStopId
  );
  if (
    expectedStop === undefined
    || selectedStop === undefined
    || TERMINAL_DELIVERY_STOP_STATUSES.has(selectedStop.deliveryStop.status)
    || expectedStop.deliveryStopId === selectedStop.deliveryStopId
  ) {
    return null;
  }

  return {
    expectedDeliveryStopId: expectedStop.deliveryStopId,
    expectedSequence: expectedStop.sequence,
    selectedDeliveryStopId: selectedStop.deliveryStopId,
    selectedSequence: selectedStop.sequence
  };
}

function toRouteTrackingGeometryPosition(
  input: RecordDriverEventInput,
  eventId: string,
  receivedAt: Date
) {
  if (input.eventType !== 'LOCATION_UPDATED' || input.routePlanId === null) return null;
  const latitude = input.latitude === null ? Number.NaN : Number(input.latitude);
  const longitude = input.longitude === null ? Number.NaN : Number(input.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return {
    driverId: input.driverId,
    eventId,
    latitude,
    longitude,
    occurredAt: input.occurredAt.toISOString(),
    receivedAt: receivedAt.toISOString(),
    routePlanId: input.routePlanId
  };
}

async function findMatchingDriverEvent(
  prisma: DriverEventTransactionClient,
  input: RecordDriverEventInput
): Promise<{ createdAt?: Date; id: string } | null> {
  if (input.eventType === 'PICKUP_COMPLETED') {
    if (input.clientEventId !== null) {
      const event = await prisma.driverEvent.findUnique({
        select: { createdAt: true, deliveryStopId: true, eventType: true, id: true, payload: true, routePlanId: true },
        where: {
          driverId_clientEventId: {
            clientEventId: input.clientEventId,
            driverId: input.driverId
          }
        }
      });
      if (event !== null) {
        if (!driverEventContextMatchesInput(event, input)) {
          throw new DriverEventContextError('clientEventId is already used by a different driver event');
        }
        return { createdAt: event.createdAt, id: event.id };
      }
    }

    return prisma.driverEvent.findFirst({
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true, id: true },
      where: {
        driverId: input.driverId,
        eventType: 'PICKUP_COMPLETED',
        routePlanId: requireRoutePlanId(input)
      }
    });
  }

  if (input.eventType === 'STOP_ARRIVED') {
    return prisma.driverEvent.findFirst({
      select: { id: true },
      where: {
        deliveryStopId: requireDeliveryStopId(input),
        driverId: input.driverId,
        eventType: 'STOP_ARRIVED',
        routePlanId: requireRoutePlanId(input)
      }
    });
  }

  if ((input.eventType === 'TIME_CONSTRAINT_ACKNOWLEDGED' || input.eventType === 'DISPATCH_CHANGE_ACKNOWLEDGED') && input.clientEventId !== null) {
    const event = await prisma.driverEvent.findUnique({
      select: { deliveryStopId: true, eventType: true, id: true, payload: true, routePlanId: true },
      where: {
        driverId_clientEventId: {
          clientEventId: input.clientEventId,
          driverId: input.driverId
        }
      }
    });
    if (event === null) {
      return null;
    }
    if (!driverEventContextMatchesInput(event, input)) {
      throw new DriverEventContextError('clientEventId is already used by a different driver event');
    }

    return { id: event.id };
  }

  if (
    input.clientEventId === null
    || (input.eventType !== 'ROUTE_COMPLETED' && input.eventType !== 'ROUTE_PAUSED')
  ) {
    return null;
  }

  const event = await prisma.driverEvent.findUnique({
    select: { deliveryStopId: true, eventType: true, id: true, payload: true, routePlanId: true },
    where: {
      driverId_clientEventId: {
        clientEventId: input.clientEventId,
        driverId: input.driverId
      }
    }
  });
  if (event === null) {
    return null;
  }
  if (!driverEventContextMatchesInput(event, input)) {
    throw new DriverEventContextError('clientEventId is already used by a different driver event');
  }

  return { id: event.id };
}

async function findDuplicateDriverEventAfterUniqueConstraint(
  prisma: DriverEventPrismaClient,
  input: RecordDriverEventInput
): Promise<{ createdAt?: Date; id: string } | null> {
  if (input.clientEventId === null) {
    return null;
  }

  const event = await prisma.driverEvent.findUnique({
    select: { createdAt: true, deliveryStopId: true, eventType: true, id: true, payload: true, routePlanId: true },
    where: {
      driverId_clientEventId: {
        clientEventId: input.clientEventId,
        driverId: input.driverId
      }
    }
  });
  if (event !== null && !driverEventContextMatchesInput(event, input)) {
    throw new DriverEventContextError('clientEventId is already used by a different driver event');
  }

  if (event !== null) {
    return { createdAt: event.createdAt, id: event.id };
  }

  if (input.eventType !== 'PICKUP_COMPLETED') {
    return null;
  }

  return prisma.driverEvent.findFirst({
    orderBy: { createdAt: 'asc' },
    select: { createdAt: true, id: true },
    where: {
      driverId: input.driverId,
      eventType: 'PICKUP_COMPLETED',
      routePlanId: requireRoutePlanId(input)
    }
  });
}

function driverEventContextMatchesInput(
  event: ExistingDriverEventContext,
  input: RecordDriverEventInput
): boolean {
  const baseContextMatches = (
    event.eventType === input.eventType
    && event.routePlanId === input.routePlanId
    && event.deliveryStopId === input.deliveryStopId
  );
  if (!baseContextMatches) return false;
  if (input.eventType !== 'DISPATCH_CHANGE_ACKNOWLEDGED') return true;
  return driverEventPayloadChangeRequestId(event.payload) === input.changeRequestId;
}

function driverEventPayloadChangeRequestId(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const changeRequestId = (payload as Record<string, unknown>).changeRequestId;
  return typeof changeRequestId === 'string' ? changeRequestId : null;
}

function persistedDriverEventPayload(
  input: RecordDriverEventInput,
  completionInvariant: DriverRouteCompletionInvariantEvidence | null = null
): Prisma.InputJsonValue {
  const payload = JSON.parse(JSON.stringify(input.payload)) as Prisma.InputJsonValue;
  const serverObservation = completionInvariant === null
    ? null
    : { completionInvariant: JSON.parse(JSON.stringify(completionInvariant)) as Prisma.InputJsonValue };
  const withServerObservation = completionInvariant === null
    ? payload
    : typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? { ...payload, serverObservation }
      : { payload, serverObservation };
  if (input.eventType !== 'DISPATCH_CHANGE_ACKNOWLEDGED' || input.changeRequestId === null || input.changeRequestId === undefined) {
    return withServerObservation;
  }
  if (typeof withServerObservation === 'object' && withServerObservation !== null && !Array.isArray(withServerObservation)) {
    return { ...withServerObservation, changeRequestId: input.changeRequestId };
  }
  return { changeRequestId: input.changeRequestId, payload: withServerObservation };
}

async function evaluateCompletionInvariant(
  prisma: DriverEventTransactionClient,
  input: RecordDriverEventInput,
  mode: DriverRouteCompletionInvariantMode
): Promise<DriverRouteCompletionInvariantEvidence | null> {
  if (input.eventType !== 'ROUTE_COMPLETED') return null;
  const routeVersion = await prisma.routeGroupingChildVersion.findFirst({
    select: { id: true, snapshot: true },
    where: {
      ...(input.driverContractVersion === 2 ? { id: requireExpectedRouteVersionId(input) } : {}),
      routePlanId: requireRoutePlanId(input),
      shopId: input.shopId,
      status: 'CURRENT'
    }
  });
  if (routeVersion === null) throw new DriverEventContextError('Current route version snapshot is unavailable');
  const deliveryStopIds = readCompletionSnapshotStopIds(routeVersion.snapshot);
  const stops = deliveryStopIds.length === 0 ? [] : await prisma.deliveryStop.findMany({
    select: { id: true, status: true },
    where: { id: { in: deliveryStopIds }, shopId: input.shopId }
  });
  if (stops.length !== deliveryStopIds.length) throw new DriverEventContextError('Route version snapshot stop is unavailable');
  const unresolvedStopCount = stops.filter(({ status }) => !TERMINAL_DELIVERY_STOP_STATUSES.has(status)).length;
  const rolloutDecision = completionInvariantDecision({
    driverContractVersion: input.driverContractVersion ?? null,
    mode,
    unresolvedStopCount
  });
  return {
    decision: rolloutDecision.reject ? 'REJECTED' : 'PERMITTED',
    driverContractVersion: input.driverContractVersion ?? null,
    mode,
    receiptAware: input.driverContractVersion === 2 && input.clientEventId !== null,
    routeVersionId: routeVersion.id,
    terminalStatuses: [...TERMINAL_DELIVERY_STOP_STATUSES],
    totalStopCount: stops.length,
    unresolvedStopCount,
    wouldReject: rolloutDecision.wouldReject
  };
}

function completionReviewData(
  input: RecordDriverEventInput,
  attemptId: string | null,
  driverEventId: string | null,
  evidence: DriverRouteCompletionInvariantEvidence,
  retainedUntil: Date
) {
  return {
    attemptId,
    decision: evidence.decision,
    driverContractVersion: evidence.driverContractVersion,
    driverEventId,
    mode: evidence.mode,
    receiptAware: evidence.receiptAware,
    retainedUntil,
    routePlanId: requireRoutePlanId(input),
    routeVersionId: evidence.routeVersionId,
    shopId: input.shopId,
    totalStopCount: evidence.totalStopCount,
    unresolvedStopCount: evidence.unresolvedStopCount,
    wouldReject: evidence.wouldReject
  };
}

function readCompletionSnapshotStopIds(snapshot: Prisma.JsonValue): string[] {
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) {
    throw new DriverEventContextError('Route version snapshot is invalid');
  }
  const stops = (snapshot as Record<string, unknown>).stops;
  if (!Array.isArray(stops)) throw new DriverEventContextError('Route version snapshot stops are invalid');
  const ids = stops.map((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
    const id = (entry as Record<string, unknown>).deliveryStopId;
    return typeof id === 'string' && id !== '' ? id : null;
  });
  if (ids.some((id) => id === null)) throw new DriverEventContextError('Route version snapshot stop is invalid');
  const unique = new Set(ids as string[]);
  if (unique.size !== ids.length) throw new DriverEventContextError('Route version snapshot contains duplicate stops');
  return [...unique];
}

async function validateDriverEventStateContext(
  prisma: DriverEventTransactionClient,
  input: RecordDriverEventInput,
  shopId: string
): Promise<void> {
  if (input.eventType === 'ROUTE_STARTED') {
    const routePlanId = requireRoutePlanId(input);
    await requireStartableOwnedRoutePlan(prisma, {
      driverId: input.driverId,
      routePlanId,
      shopId
    });
    return;
  }

  const routePlanId = requireRoutePlanId(input);
  const routePlan = await requireOwnedRoutePlan(prisma, { driverId: input.driverId, routePlanId, shopId });
  if (
    routePlan.status !== 'IN_PROGRESS'
    && (
      input.eventType === 'PICKUP_COMPLETED'
      || input.eventType === 'LOCATION_UPDATED'
      || input.eventType === 'STOP_ARRIVED'
      || input.eventType === 'STOP_DELIVERED'
      || input.eventType === 'STOP_FAILED'
    )
  ) {
    throw new DriverEventRouteNotInProgressError('Route must be in progress before accepting execution events');
  }

  if (input.eventType === 'STOP_ARRIVED' || input.eventType === 'STOP_DELIVERED' || input.eventType === 'STOP_FAILED') {
    await requireOwnedRoutePlanStop(prisma, {
      deliveryStopId: requireDeliveryStopId(input),
      driverId: input.driverId,
      routePlanId,
      shopId
    });
  }

  if (input.eventType === 'TIME_CONSTRAINT_ACKNOWLEDGED') {
    await requireOwnedConfirmedTimeConstraintStop(prisma, {
      deliveryStopId: requireDeliveryStopId(input),
      driverId: input.driverId,
      routePlanId,
      shopId
    });
  }

  if (input.eventType === 'DISPATCH_CHANGE_ACKNOWLEDGED') {
    await requireOwnedDispatchChangeRequest(prisma, {
      changeRequestId: requireChangeRequestId(input),
      driverId: input.driverId,
      routePlanId,
      shopId
    });
  }
}

async function applyDriverEventStateTransition(
  prisma: DriverEventTransactionClient,
  schemaCapabilities: DriverEventSchemaCapabilities,
  input: RecordDriverEventInput,
  shopId: string,
  serverReceivedAt: Date,
  eventRouteVersionId: string | null | undefined,
  eventId: string
): Promise<{ etaSnapshot?: DriverRouteEtaSnapshot; etaUpdate?: DriverRouteEtaUpdate }> {
  if (input.eventType === 'STOP_ARRIVED') {
    const routePlanId = requireRoutePlanId(input);
    const deliveryStopId = requireDeliveryStopId(input);
    const updated = await prisma.deliveryStop.updateMany({
      data: { status: 'ARRIVED' },
      where: {
        id: deliveryStopId,
        routePlanStops: {
          some: {
            routePlan: {
              driverId: input.driverId,
              id: routePlanId,
              shopId
            },
            routePlanId
          }
        },
        shopId,
        status: { in: ['PENDING', 'ASSIGNED', 'EN_ROUTE', 'ARRIVED'] }
      }
    });
    if (updated.count !== 1) throw new DriverEventStopTransitionConflictError();
    const stops = await loadRouteEtaStops(prisma, routePlanId);
    const inputRouteVersionId = await loadCurrentRouteVersionIdForEta(prisma, schemaCapabilities, routePlanId, shopId);
    if (!await isCurrentEtaProgressEvent(prisma, schemaCapabilities, input, eventRouteVersionId, eventId)) {
      return {};
    }
    const pickupCompletedAt = await loadPickupCompletedAt(prisma, schemaCapabilities, input.driverId, routePlanId, shopId, eventRouteVersionId);
    const etaUpdate = calculateArrivalEtaUpdate({
      arrivedDeliveryStopId: deliveryStopId,
      eventOccurredAt: input.occurredAt,
      inputRouteVersionId,
      serverReceivedAt,
      stops
    });
    await persistEtaUpdate(prisma, schemaCapabilities, shopId, routePlanId, etaUpdate);
    if (pickupCompletedAt === null) {
      return { etaUpdate };
    }
    return {
      etaSnapshot: buildDriverRouteEtaSnapshot({
        pickupCompletedAt,
        stops: applyEtaUpdateToStops(stops, etaUpdate)
      }),
      etaUpdate
    };
  }

  if (input.eventType === 'STOP_DELIVERED' || input.eventType === 'STOP_FAILED') {
    const routePlanId = requireRoutePlanId(input);
    const targetStatus = input.eventType === 'STOP_DELIVERED' ? 'DELIVERED' : 'FAILED';
    const updated = await prisma.deliveryStop.updateMany({
      data: {
        status: targetStatus
      },
      where: {
        id: requireDeliveryStopId(input),
        routePlanStops: {
          some: {
            routePlan: {
              driverId: input.driverId,
              id: routePlanId,
              shopId
            },
            routePlanId
          }
        },
        shopId,
        status: { in: ['PENDING', 'ASSIGNED', 'EN_ROUTE', 'ARRIVED', targetStatus] }
      }
    });
    if (updated.count !== 1) throw new DriverEventStopTransitionConflictError();
    const stops = await loadRouteEtaStops(prisma, routePlanId);
    const inputRouteVersionId = await loadCurrentRouteVersionIdForEta(prisma, schemaCapabilities, routePlanId, shopId);
    if (!await isCurrentEtaProgressEvent(prisma, schemaCapabilities, input, eventRouteVersionId, eventId)) {
      return {};
    }
    const pickupCompletedAt = await loadPickupCompletedAt(prisma, schemaCapabilities, input.driverId, routePlanId, shopId, eventRouteVersionId);
    const arrivedAt = await loadStopArrivalAt(
      prisma,
      input.driverId,
      routePlanId,
      requireDeliveryStopId(input),
      shopId,
      schemaCapabilities,
      eventRouteVersionId
    );
    const etaUpdate = calculateCompletionEtaUpdate({
      arrivedAt,
      completedDeliveryStopId: requireDeliveryStopId(input),
      eventOccurredAt: input.occurredAt,
      inputRouteVersionId,
      serverReceivedAt,
      stops,
      trigger: input.eventType
    });
    await persistEtaUpdate(prisma, schemaCapabilities, shopId, routePlanId, etaUpdate);
    if (pickupCompletedAt === null) {
      return { etaUpdate };
    }
    return {
      etaSnapshot: buildDriverRouteEtaSnapshot({
        pickupCompletedAt,
        stops: applyEtaUpdateToStops(stops, etaUpdate)
      }),
      etaUpdate
    };
  }

  if (input.eventType === 'ROUTE_STARTED') {
    const routePlanId = requireRoutePlanId(input);
    await prisma.routePlan.updateMany({
      data: { status: 'IN_PROGRESS' },
      where: {
        driverId: input.driverId,
        driverEvents: { none: { eventType: 'ROUTE_COMPLETED' } },
        id: routePlanId,
        shopId,
        status: { in: [...ROUTE_READY_COMPATIBILITY_STATUSES] }
      }
    });
    const inputRouteVersionId = await loadCurrentRouteVersionIdForEta(prisma, schemaCapabilities, routePlanId, shopId);
    if (!await isCurrentEtaProgressEvent(prisma, schemaCapabilities, input, eventRouteVersionId, eventId)) {
      return {};
    }
    const etaUpdate = calculateRouteStartEtaUpdate({
      eventOccurredAt: input.occurredAt,
      inputRouteVersionId,
      serverReceivedAt,
      stops: await loadRouteEtaStops(prisma, routePlanId)
    });
    await persistEtaUpdate(prisma, schemaCapabilities, shopId, routePlanId, etaUpdate);
    return { etaUpdate };
  }

  if (input.eventType === 'PICKUP_COMPLETED') {
    const routePlanId = requireRoutePlanId(input);
    const stops = await loadRouteEtaStops(prisma, routePlanId);
    const inputRouteVersionId = await loadCurrentRouteVersionIdForEta(prisma, schemaCapabilities, routePlanId, shopId);
    if (!await isCurrentEtaProgressEvent(prisma, schemaCapabilities, input, eventRouteVersionId, eventId)) {
      return {};
    }
    const etaUpdate = calculatePickupEtaUpdate({
      eventOccurredAt: input.occurredAt,
      inputRouteVersionId,
      serverReceivedAt,
      stops
    });
    await persistEtaUpdate(prisma, schemaCapabilities, shopId, routePlanId, etaUpdate);
    return {
      etaSnapshot: buildDriverRouteEtaSnapshot({
        pickupCompletedAt: effectiveOccurredAt(input.occurredAt, serverReceivedAt),
        stops: applyEtaUpdateToStops(stops, etaUpdate)
      }),
      etaUpdate
    };
  }

  if (input.eventType === 'ROUTE_COMPLETED') {
    const completed = await prisma.routePlan.updateMany({
      data: { status: 'COMPLETED' },
      where: {
        driverId: input.driverId,
        id: requireRoutePlanId(input),
        shopId,
        status: 'IN_PROGRESS'
      }
    });
    if (completed.count !== 1) throw new DriverEventRouteNotInProgressError('Route must be in progress before completion');
    return {};
  }

  if (input.eventType === 'ROUTE_PAUSED') {
    await prisma.routePlan.updateMany({
      data: { status: 'READY' },
      where: {
        driverId: input.driverId,
        id: requireRoutePlanId(input),
        shopId,
        status: 'IN_PROGRESS'
      }
    });
    return {};
  }

  return {};
}

async function buildCurrentEtaSnapshot(
  prisma: Pick<DriverEventPrismaClient, 'routePlanStop' | 'routePlanGeometryCache'>,
  routePlanId: string,
  pickupCompletedAt: Date | null
): Promise<DriverRouteEtaSnapshot> {
  return buildDriverRouteEtaSnapshot({
    pickupCompletedAt,
    stops: await loadRouteEtaStops(prisma, routePlanId, { hydrateGeometryCache: false })
  });
}

function isEtaSnapshotRecoveryEvent(eventType: string): boolean {
  return eventType === 'PICKUP_COMPLETED'
    || eventType === 'STOP_ARRIVED'
    || eventType === 'STOP_DELIVERED'
    || eventType === 'STOP_FAILED';
}

async function buildCurrentEtaSnapshotForDuplicate(
  prisma: Pick<DriverEventPrismaClient, 'driverEvent' | 'routePlanStop' | 'routePlanGeometryCache'>,
  input: RecordDriverEventInput
): Promise<DriverRouteEtaSnapshot> {
  const pickup = await prisma.driverEvent.findFirst({
    orderBy: { createdAt: 'asc' },
    select: { createdAt: true, occurredAt: true },
    where: {
      driverId: input.driverId,
      eventType: 'PICKUP_COMPLETED',
      routePlanId: requireRoutePlanId(input),
      shopId: input.shopId
    }
  });
  const pickupCompletedAt = pickup === null
    ? null
    : effectiveOccurredAt(pickup.occurredAt ?? pickup.createdAt, pickup.createdAt);
  return buildCurrentEtaSnapshot(prisma, requireRoutePlanId(input), pickupCompletedAt);
}

async function loadPickupCompletedAt(
  prisma: Pick<DriverEventPrismaClient, 'driverEvent'>,
  schemaCapabilities: DriverEventSchemaCapabilities,
  driverId: string,
  routePlanId: string,
  shopId: string,
  eventRouteVersionId: string | null | undefined
): Promise<Date | null> {
  const event = await prisma.driverEvent.findFirst({
    orderBy: { createdAt: 'asc' },
    select: { createdAt: true, occurredAt: true },
    where: {
      driverId,
      eventType: 'PICKUP_COMPLETED',
      routePlanId,
      shopId,
      ...(schemaCapabilities.driverEventRouteVersionColumnExists
        ? { routeVersionId: eventRouteVersionId ?? null }
        : {})
    }
  });
  return event === null ? null : effectiveOccurredAt(event.occurredAt ?? event.createdAt, event.createdAt);
}

async function loadStopArrivalAt(
  prisma: Pick<DriverEventPrismaClient, 'driverEvent'>,
  driverId: string,
  routePlanId: string,
  deliveryStopId: string,
  shopId: string,
  schemaCapabilities: DriverEventSchemaCapabilities,
  eventRouteVersionId: string | null | undefined
): Promise<Date | null> {
  const event = await prisma.driverEvent.findFirst({
    orderBy: { occurredAt: 'asc' },
    select: { createdAt: true, occurredAt: true },
    where: {
      deliveryStopId,
      driverId,
      eventType: 'STOP_ARRIVED',
      routePlanId,
      shopId,
      ...(schemaCapabilities.driverEventRouteVersionColumnExists
        ? { routeVersionId: eventRouteVersionId ?? null }
        : {})
    }
  });
  return event === null ? null : effectiveOccurredAt(event.occurredAt, event.createdAt);
}

async function isCurrentEtaProgressEvent(
  prisma: Pick<DriverEventPrismaClient, '$queryRaw'>,
  schemaCapabilities: DriverEventSchemaCapabilities,
  input: RecordDriverEventInput,
  eventRouteVersionId: string | null | undefined,
  eventId: string
): Promise<boolean> {
  const routePlanId = requireRoutePlanId(input);
  const routeVersionPredicate = !schemaCapabilities.driverEventRouteVersionColumnExists
    ? Prisma.empty
    : eventRouteVersionId === null || eventRouteVersionId === undefined
      ? Prisma.sql`AND "routeVersionId" IS NULL`
      : Prisma.sql`AND "routeVersionId" = ${eventRouteVersionId}::uuid`;
  const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id
    FROM driver_events
    WHERE "routePlanId" = ${routePlanId}::uuid
      AND "shopId" = ${input.shopId}::uuid
      AND "driverId" = ${input.driverId}::uuid
      ${routeVersionPredicate}
      AND "eventType" IN ('ROUTE_STARTED', 'PICKUP_COMPLETED', 'STOP_ARRIVED', 'STOP_DELIVERED')
    ORDER BY LEAST("occurredAt", "createdAt") DESC, "createdAt" DESC, id DESC
    LIMIT 1
  `);
  return rows[0]?.id === eventId;
}

function effectiveOccurredAt(occurredAt: Date, serverReceivedAt: Date): Date {
  return occurredAt.getTime() > serverReceivedAt.getTime() ? serverReceivedAt : occurredAt;
}

function applyEtaUpdateToStops(stops: DriverRouteEtaStop[], etaUpdate: DriverRouteEtaUpdate): DriverRouteEtaStop[] {
  const updates = new Map(etaUpdate.updatedStops.map((stop) => [stop.deliveryStopId, stop]));
  return stops.map((stop) => {
    const update = updates.get(stop.deliveryStopId);
    return update === undefined ? stop : {
      ...stop,
      etaCalculatedAt: new Date(etaUpdate.etaCalculatedAt),
      etaFailureCode: etaUpdate.etaFailureCode,
      etaFailureMessage: etaUpdate.etaFailureMessage,
      estimatedArrivalAt: update.estimatedArrivalAt === null ? null : new Date(update.estimatedArrivalAt)
    };
  });
}

async function loadRouteEtaStops(
  prisma: Pick<DriverEventPrismaClient, 'routePlanStop' | 'routePlanGeometryCache'>,
  routePlanId: string,
  options: { hydrateGeometryCache?: boolean } = {}
): Promise<DriverRouteEtaStop[]> {
  const rows = await prisma.routePlanStop.findMany({
    orderBy: { sequence: 'asc' },
    select: {
      deliveryStop: { select: { serviceMinutes: true, status: true } },
      deliveryStopId: true,
      distanceFromPreviousMeters: true,
      durationFromPreviousSeconds: true,
      etaCalculatedAt: true,
      etaFailureCode: true,
      etaFailureMessage: true,
      estimatedArrivalAt: true,
      sequence: true
    },
    where: { routePlanId }
  });
  if (rows.every((row) => row.durationFromPreviousSeconds !== null) || options.hydrateGeometryCache === false) {
    return rows.map(toEtaStop);
  }

  const cache = await prisma.routePlanGeometryCache.findFirst({
    orderBy: { generatedAt: 'desc' },
    select: { stopPoints: true },
    where: { routePlanId }
  });
  const stopPoints = readRouteStopPoints(cache?.stopPoints);
  const stopPointById = new Map(stopPoints.map((point) => [point.deliveryStopId, point]));
  const cacheMatchesRoute = rows.length > 0 && rows.every((row) => {
    const point = stopPointById.get(row.deliveryStopId);
    return point?.sequence === row.sequence;
  });
  if (!cacheMatchesRoute) {
    return rows.map(toEtaStop);
  }

  const hydratedRows = rows.map((row) => {
    const point = stopPointById.get(row.deliveryStopId)!;
    return {
      ...row,
      distanceFromPreviousMeters: normalizedInteger(point.distanceFromPreviousMeters),
      durationFromPreviousSeconds: normalizedInteger(point.durationFromPreviousSeconds)
    };
  });
  await Promise.all(hydratedRows.map((row) => prisma.routePlanStop.update({
    data: {
      distanceFromPreviousMeters: row.distanceFromPreviousMeters,
      durationFromPreviousSeconds: row.durationFromPreviousSeconds
    },
    where: {
      routePlanId_deliveryStopId: {
        deliveryStopId: row.deliveryStopId,
        routePlanId
      }
    }
  })));
  return hydratedRows.map(toEtaStop);
}

async function persistEtaUpdate(
  prisma: DriverEventTransactionClient,
  schemaCapabilities: DriverEventSchemaCapabilities,
  shopId: string,
  routePlanId: string,
  etaUpdate: DriverRouteEtaUpdate
): Promise<void> {
  if (schemaCapabilities.routePlanStopEtaOwnershipColumnsExist) {
    if (etaUpdate.updatedStops.length === 0) {
      return;
    }
    if (etaUpdate.inputRouteVersionId === null) {
      const updatedRows = await Promise.all(etaUpdate.updatedStops.map(async (stop) => {
        return prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          UPDATE route_plan_stops
          SET
            "estimatedArrivalAt" = ${stop.estimatedArrivalAt === null ? null : new Date(stop.estimatedArrivalAt)},
            "etaStatus" = ${etaUpdate.etaStatus}::"DsvEtaStatus",
            "etaInputRouteVersionId" = NULL,
            "etaSource" = ${etaUpdate.etaSource},
            "etaCalculatedAt" = ${new Date(etaUpdate.etaCalculatedAt)},
            "etaFailureCode" = ${etaUpdate.etaFailureCode},
            "etaFailureMessage" = ${etaUpdate.etaFailureMessage}
          WHERE
            "shopId" = ${shopId}::uuid
            AND
            "routePlanId" = ${routePlanId}::uuid
            AND "deliveryStopId" = ${stop.deliveryStopId}::uuid
            AND "etaInputRouteVersionId" IS NULL
            AND NOT EXISTS (
              SELECT 1
              FROM route_grouping_child_versions current_route_version
              WHERE current_route_version."shopId" = route_plan_stops."shopId"
                AND current_route_version."routePlanId" = route_plan_stops."routePlanId"
                AND current_route_version.status = 'CURRENT'
            )
          RETURNING id
        `);
      }));
      if (updatedRows.some((rows) => rows.length === 0)) {
        throw new DriverEventEtaStaleConflictError(routePlanId);
      }
      return;
    }

    const updatedRows = await Promise.all(etaUpdate.updatedStops.map(async (stop) => {
      return prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        UPDATE route_plan_stops
        SET
          "estimatedArrivalAt" = ${stop.estimatedArrivalAt === null ? null : new Date(stop.estimatedArrivalAt)},
          "etaStatus" = ${etaUpdate.etaStatus}::"DsvEtaStatus",
          "etaInputRouteVersionId" = ${etaUpdate.inputRouteVersionId}::uuid,
          "etaSource" = ${etaUpdate.etaSource},
          "etaCalculatedAt" = ${new Date(etaUpdate.etaCalculatedAt)},
          "etaFailureCode" = ${etaUpdate.etaFailureCode},
          "etaFailureMessage" = ${etaUpdate.etaFailureMessage}
        WHERE
          "shopId" = ${shopId}::uuid
          AND
          "routePlanId" = ${routePlanId}::uuid
          AND "deliveryStopId" = ${stop.deliveryStopId}::uuid
          AND EXISTS (
            SELECT 1
            FROM route_grouping_child_versions current_route_version
            WHERE current_route_version.id = ${etaUpdate.inputRouteVersionId}::uuid
              AND current_route_version."shopId" = route_plan_stops."shopId"
              AND current_route_version."routePlanId" = route_plan_stops."routePlanId"
              AND current_route_version.status = 'CURRENT'
          )
          AND (
            "etaInputRouteVersionId" IS NULL
            OR "etaInputRouteVersionId" = ${etaUpdate.inputRouteVersionId}::uuid
          )
        RETURNING id
      `);
    }));
    if (updatedRows.some((rows) => rows.length === 0)) {
      throw new DriverEventEtaStaleConflictError(routePlanId);
    }
    return;
  }

  await Promise.all(etaUpdate.updatedStops.map((stop) => prisma.routePlanStop.update({
    data: {
      estimatedArrivalAt: stop.estimatedArrivalAt === null ? null : new Date(stop.estimatedArrivalAt)
    },
    where: {
      routePlanId_deliveryStopId: {
        deliveryStopId: stop.deliveryStopId,
        routePlanId
      }
    }
  })));
}

async function routePlanStopEtaOwnershipColumnsExist(prisma: Pick<DriverEventPrismaClient, '$queryRaw'>): Promise<boolean> {
  const columns = await prisma.$queryRaw<Array<{ column_name: string }>>(Prisma.sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'route_plan_stops'
      AND column_name IN (
        'etaStatus',
        'etaInputRouteVersionId',
        'etaSource',
        'etaCalculatedAt',
        'etaFailureCode',
        'etaFailureMessage'
      )
  `);
  const columnNames = new Set(columns.map((column) => column.column_name));
  return (
    columnNames.has('etaStatus')
    && columnNames.has('etaInputRouteVersionId')
    && columnNames.has('etaSource')
    && columnNames.has('etaCalculatedAt')
    && columnNames.has('etaFailureCode')
    && columnNames.has('etaFailureMessage')
  );
}

async function loadCurrentRouteVersionIdForEta(
  prisma: DriverEventTransactionClient,
  schemaCapabilities: DriverEventSchemaCapabilities,
  routePlanId: string,
  shopId: string
): Promise<string | null> {
  if (!schemaCapabilities.routePlanStopEtaOwnershipColumnsExist) {
    return null;
  }

  return loadCurrentRouteVersionId(prisma, routePlanId, shopId);
}

async function loadCurrentRouteVersionIdForDriverEvent(
  prisma: DriverEventTransactionClient,
  schemaCapabilities: DriverEventSchemaCapabilities,
  routePlanId: string,
  shopId: string
): Promise<string | null | undefined> {
  if (!schemaCapabilities.driverEventRouteVersionColumnExists) {
    return undefined;
  }

  return loadCurrentRouteVersionId(prisma, routePlanId, shopId);
}

async function loadCurrentRouteVersionId(
  prisma: DriverEventTransactionClient,
  routePlanId: string,
  shopId: string
): Promise<string | null> {
  const routeVersions = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id
    FROM route_grouping_child_versions
    WHERE "routePlanId" = ${routePlanId}::uuid
      AND "shopId" = ${shopId}::uuid
      AND status = 'CURRENT'
    ORDER BY "createdAt" DESC
    LIMIT 1
  `);
  return routeVersions[0]?.id ?? null;
}

async function driverEventRouteVersionColumnExists(prisma: Pick<DriverEventPrismaClient, '$queryRaw'>): Promise<boolean> {
  const columns = await prisma.$queryRaw<Array<{ column_name: string }>>(Prisma.sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'driver_events'
      AND column_name = 'routeVersionId'
  `);
  return columns.length > 0;
}

const schemaCapabilityLoadersByClient = new WeakMap<object, DriverEventSchemaCapabilityLoader>();

function schemaCapabilityLoaderFor(prisma: DriverEventPrismaClient): DriverEventSchemaCapabilityLoader {
  const existing = schemaCapabilityLoadersByClient.get(prisma);
  if (existing !== undefined) {
    return existing;
  }

  let capabilitiesResult: Promise<DriverEventSchemaCapabilities> | undefined;
  const loader = {
    load: () => {
      capabilitiesResult ??= Promise.all([
        driverEventRouteVersionColumnExists(prisma),
        routePlanStopEtaOwnershipColumnsExist(prisma)
      ])
        .then(([driverEventRouteVersionColumnExistsValue, routePlanStopEtaOwnershipColumnsExistValue]) => ({
          driverEventRouteVersionColumnExists: driverEventRouteVersionColumnExistsValue,
          routePlanStopEtaOwnershipColumnsExist: routePlanStopEtaOwnershipColumnsExistValue
        }))
        .catch((error: unknown) => {
          capabilitiesResult = undefined;
          throw error;
        });
      return capabilitiesResult;
    }
  };
  schemaCapabilityLoadersByClient.set(prisma, loader);
  return loader;
}

function toEtaStop(row: {
  deliveryStop: { serviceMinutes: number | null; status?: string | null };
  deliveryStopId: string;
  distanceFromPreviousMeters: number | null;
  durationFromPreviousSeconds: number | null;
  estimatedArrivalAt: Date | null;
  etaCalculatedAt?: Date | null;
  etaFailureCode?: string | null;
  etaFailureMessage?: string | null;
  sequence: number;
  status?: string | null;
}): DriverRouteEtaStop {
  return {
    deliveryStopId: row.deliveryStopId,
    distanceFromPreviousMeters: row.distanceFromPreviousMeters,
    durationFromPreviousSeconds: row.durationFromPreviousSeconds,
    etaCalculatedAt: row.etaCalculatedAt,
    etaFailureCode: row.etaFailureCode,
    etaFailureMessage: row.etaFailureMessage,
    estimatedArrivalAt: row.estimatedArrivalAt,
    sequence: row.sequence,
    serviceMinutes: row.deliveryStop.serviceMinutes,
    status: row.deliveryStop.status ?? row.status ?? null
  };
}

function normalizedInteger(value: number | null | undefined): number | null {
  return value === null || value === undefined || !Number.isFinite(value) || value < 0
    ? null
    : Math.round(value);
}

async function requireStartableOwnedRoutePlan(
  prisma: DriverEventTransactionClient,
  input: { driverId: string; routePlanId: string; shopId: string }
): Promise<void> {
  const routePlan = await prisma.routePlan.findFirst({
    select: { id: true },
    where: {
      driverId: input.driverId,
      driverEvents: { none: { eventType: 'ROUTE_COMPLETED' } },
      id: input.routePlanId,
      shopId: input.shopId,
      status: { in: [...ROUTE_ACTIVE_COMPATIBILITY_STATUSES] }
    }
  });
  if (routePlan === null) {
    throw new DriverEventScopeError('Completed or unavailable routes cannot be started');
  }
  await assertRoutePlanExecutionOwnership(prisma, {
    createConflictError: (conflict) => new DriverEventExecutionConflictError(conflict.routePlanId, conflict.deliveryStopId),
    routePlanId: input.routePlanId,
    shopId: input.shopId
  });
}

async function requireOwnedRoutePlan(
  prisma: DriverEventTransactionClient,
  input: { driverId: string; routePlanId: string; shopId: string }
): Promise<{ status: string }> {
  const routePlan = await prisma.routePlan.findFirst({
    select: { id: true, status: true },
    where: {
      driverId: input.driverId,
      driverEvents: { none: { eventType: 'ROUTE_COMPLETED' } },
      id: input.routePlanId,
      shopId: input.shopId,
      status: { in: [...ROUTE_ACTIVE_COMPATIBILITY_STATUSES] }
    }
  });
  if (routePlan === null) {
    throw new DriverEventScopeError('Driver route context is outside the authenticated driver scope');
  }

  return { status: routePlan.status };
}

async function requireOwnedRoutePlanStop(
  prisma: DriverEventTransactionClient,
  input: { deliveryStopId: string; driverId: string; routePlanId: string; shopId: string }
): Promise<void> {
  const routePlanStop = await prisma.routePlanStop.findFirst({
    select: { id: true },
    where: {
      deliveryStopId: input.deliveryStopId,
      routePlan: {
        driverId: input.driverId,
        id: input.routePlanId,
        shopId: input.shopId
      }
    }
  });
  if (routePlanStop === null) {
    throw new DriverEventScopeError('Driver stop context is outside the authenticated route scope');
  }
}

async function requireOwnedConfirmedTimeConstraintStop(
  prisma: DriverEventTransactionClient,
  input: { deliveryStopId: string; driverId: string; routePlanId: string; shopId: string }
): Promise<void> {
  const routePlanStop = await prisma.routePlanStop.findFirst({
    select: {
      deliveryStop: {
        select: {
          dsvDispatchChangeRequests: {
            select: { id: true },
            take: 1,
            where: {
              routePlanId: input.routePlanId,
              shopId: input.shopId,
              status: 'PENDING_ACK',
              type: 'TIME_CONSTRAINT_CHANGE'
            }
          },
          instructions: true,
          order: {
            select: {
              currentRouteVersion: { select: { createdAt: true } },
              currentRouteVersionId: true,
              dsvAuditEvents: {
                orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
                select: {
                  actorId: true,
                  eventType: true,
                  id: true,
                  occurredAt: true,
                  redactedDiff: true
                },
                where: { eventType: { in: dsvTimeConstraintAuditEvents.slice() }, shopId: input.shopId }
              }
            }
          },
          timeWindowEnd: true,
          timeWindowStart: true
        }
      },
      id: true
    },
    where: {
      deliveryStopId: input.deliveryStopId,
      routePlan: {
        driverId: input.driverId,
        id: input.routePlanId,
        shopId: input.shopId
      },
      routePlanId: input.routePlanId,
      shopId: input.shopId
    }
  });
  if (routePlanStop === null) {
    throw new DriverEventScopeError('Driver stop context is outside the authenticated route scope');
  }
  if ((routePlanStop.deliveryStop.dsvDispatchChangeRequests ?? []).length > 0) return;

  const state = deriveDsvTimeConstraintState({
    audits: routePlanStop.deliveryStop.order.dsvAuditEvents,
    currentRouteVersionCreatedAt: routePlanStop.deliveryStop.order.currentRouteVersion?.createdAt ?? null,
    currentRouteVersionId: routePlanStop.deliveryStop.order.currentRouteVersionId,
    rawNote: routePlanStop.deliveryStop.instructions,
    timeWindowEnd: routePlanStop.deliveryStop.timeWindowEnd,
    timeWindowStart: routePlanStop.deliveryStop.timeWindowStart
  });
  if (state.reviewStatus !== 'CONFIRMED' || state.timeConstraint === null) {
    throw new DriverEventContextError('Time constraint acknowledgement requires a confirmed stop window');
  }
}

async function requireOwnedDispatchChangeRequest(
  prisma: DriverEventTransactionClient,
  input: { changeRequestId: string; driverId: string; routePlanId: string; shopId: string }
): Promise<void> {
  const request = await prisma.dsvDispatchChangeRequest.findFirst({
    select: { id: true },
    where: {
      id: input.changeRequestId,
      routePlanId: input.routePlanId,
      shopId: input.shopId,
      status: 'PENDING_ACK',
      OR: [{ driverId: input.driverId }, { driverId: null }]
    }
  });
  if (request === null) throw new DriverEventScopeError('Dispatch change request is outside the authenticated route scope');
}

function requireRoutePlanId(input: RecordDriverEventInput): string {
  if (input.routePlanId === null || input.routePlanId.trim().length === 0) {
    throw new DriverEventContextError('Driver event requires routePlanId for terminal route state changes');
  }

  return input.routePlanId;
}

function requireChangeRequestId(input: RecordDriverEventInput): string {
  const changeRequestId = input.changeRequestId?.trim();
  if (changeRequestId === undefined || changeRequestId === '') {
    throw new DriverEventContextError('Driver event requires changeRequestId for dispatch change acknowledgement');
  }
  return changeRequestId;
}

function requireDeliveryStopId(input: RecordDriverEventInput): string {
  if (input.deliveryStopId === null || input.deliveryStopId.trim().length === 0) {
    throw new DriverEventContextError('Driver event requires deliveryStopId for terminal stop state changes');
  }

  return input.deliveryStopId;
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
