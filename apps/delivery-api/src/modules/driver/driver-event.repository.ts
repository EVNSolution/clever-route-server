import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { assertRoutePlanExecutionOwnership, RouteExecutionConflictError } from '../route-plans/route-execution-ownership.js';
import { ROUTE_ACTIVE_COMPATIBILITY_STATUSES, ROUTE_READY_COMPATIBILITY_STATUSES } from '../route-plans/route-plan-lifecycle.js';
import { readRouteStopPoints } from '../route-plans/route-plan-geometry-cache.js';
import { persistRouteTrackingGeometryPosition } from '../route-tracking/route-tracking.geometry.js';
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

export type RecordDriverEventInput = {
  clientEventId: string | null;
  deliveryStopId: string | null;
  driverId: string;
  eventType: string;
  latitude: string | null;
  longitude: string | null;
  occurredAt: Date;
  payload: unknown;
  routePlanId: string | null;
  shopDomain: string;
  shopId: string;
};

export type RecordDriverEventResult = {
  duplicate: boolean;
  etaSnapshot?: DriverRouteEtaSnapshot;
  etaUpdate?: DriverRouteEtaUpdate;
  eventId: string;
  sequenceDeviation?: DriverStopSequenceDeviation;
};

export type DriverStopSequenceDeviation = {
  expectedDeliveryStopId: string;
  expectedSequence: number;
  selectedDeliveryStopId: string;
  selectedSequence: number;
};

type DriverEventPrismaClient = Pick<
  PrismaClient,
  '$queryRaw' | '$transaction' | 'deliveryStop' | 'driverEvent' | 'routePlan' | 'routePlanGeometryCache' | 'routePlanStop' | 'routeTrackingGeometry'
>;

type DriverEventTransactionClient = Pick<
  Prisma.TransactionClient,
  '$queryRaw' | 'deliveryStop' | 'driverEvent' | 'routePlan' | 'routePlanGeometryCache' | 'routePlanStop' | 'routeTrackingGeometry'
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

export class PrismaDriverEventRepository {
  private readonly schemaCapabilityLoader: DriverEventSchemaCapabilityLoader;

  constructor(private readonly prisma: DriverEventPrismaClient) {
    this.schemaCapabilityLoader = schemaCapabilityLoaderFor(prisma);
  }

  async recordDriverEvent(input: RecordDriverEventInput): Promise<RecordDriverEventResult> {
    const schemaCapabilities = await this.schemaCapabilityLoader.load();

    try {
      return await this.prisma.$transaction(async (transaction) => {
        const duplicate = await findMatchingDriverEvent(transaction, input);
        if (duplicate !== null) {
          return {
            duplicate: true,
            eventId: duplicate.id,
            ...(input.eventType === 'PICKUP_COMPLETED'
              ? { etaSnapshot: await buildCurrentEtaSnapshot(transaction, requireRoutePlanId(input), duplicate.createdAt ?? null) }
              : {})
          };
        }

        await validateDriverEventStateContext(transaction, input, input.shopId);
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
            payload: JSON.parse(JSON.stringify(input.payload)) as Prisma.InputJsonValue,
            routePlanId: input.routePlanId,
            ...(routeVersionId === undefined ? {} : { routeVersionId }),
            shopId: input.shopId
          }
        });

        const trackingPosition = toRouteTrackingGeometryPosition(input, event.id, event.createdAt);
        if (trackingPosition !== null) {
          await persistRouteTrackingGeometryPosition(transaction, trackingPosition);
        }

        const etaResult = await applyDriverEventStateTransition(
          transaction,
          schemaCapabilities,
          input,
          input.shopId,
          event.createdAt
        );

        return {
          duplicate: false,
          ...(etaResult.etaSnapshot === undefined ? {} : { etaSnapshot: etaResult.etaSnapshot }),
          ...(etaResult.etaUpdate === undefined ? {} : { etaUpdate: etaResult.etaUpdate }),
          eventId: event.id,
          ...(sequenceDeviation === null ? {} : { sequenceDeviation })
        };
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        const duplicate = await findDuplicateDriverEventAfterUniqueConstraint(this.prisma, input);
        if (duplicate !== null) {
          return {
            duplicate: true,
            eventId: duplicate.id,
            ...(input.eventType === 'PICKUP_COMPLETED'
              ? { etaSnapshot: await buildCurrentEtaSnapshot(this.prisma, requireRoutePlanId(input), duplicate.createdAt ?? null) }
              : {})
          };
        }
      }

      throw error;
    }
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
        select: { createdAt: true, deliveryStopId: true, eventType: true, id: true, routePlanId: true },
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

  if (
    input.clientEventId === null
    || (input.eventType !== 'ROUTE_COMPLETED' && input.eventType !== 'ROUTE_PAUSED')
  ) {
    return null;
  }

  const event = await prisma.driverEvent.findUnique({
    select: { deliveryStopId: true, eventType: true, id: true, routePlanId: true },
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
    select: { createdAt: true, deliveryStopId: true, eventType: true, id: true, routePlanId: true },
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
  return (
    event.eventType === input.eventType
    && event.routePlanId === input.routePlanId
    && event.deliveryStopId === input.deliveryStopId
  );
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
}

async function applyDriverEventStateTransition(
  prisma: DriverEventTransactionClient,
  schemaCapabilities: DriverEventSchemaCapabilities,
  input: RecordDriverEventInput,
  shopId: string,
  serverReceivedAt: Date
): Promise<{ etaSnapshot?: DriverRouteEtaSnapshot; etaUpdate?: DriverRouteEtaUpdate }> {
  if (input.eventType === 'STOP_ARRIVED') {
    const routePlanId = requireRoutePlanId(input);
    const deliveryStopId = requireDeliveryStopId(input);
    await prisma.deliveryStop.updateMany({
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
        shopId
      }
    });
    const stops = await loadRouteEtaStops(prisma, routePlanId);
    const pickupCompletedAt = await loadPickupCompletedAt(prisma, input.driverId, routePlanId);
    const inputRouteVersionId = await loadCurrentRouteVersionIdForEta(prisma, schemaCapabilities, routePlanId, shopId);
    const etaUpdate = calculateArrivalEtaUpdate({
      arrivedDeliveryStopId: deliveryStopId,
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
    await prisma.deliveryStop.updateMany({
      data: {
        status: input.eventType === 'STOP_DELIVERED' ? 'DELIVERED' : 'FAILED'
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
        shopId
      }
    });
    if (input.eventType === 'STOP_FAILED') {
      return {};
    }

    const stops = await loadRouteEtaStops(prisma, routePlanId);
    const pickupCompletedAt = await loadPickupCompletedAt(prisma, input.driverId, routePlanId);
    const inputRouteVersionId = await loadCurrentRouteVersionIdForEta(prisma, schemaCapabilities, routePlanId, shopId);
    const etaUpdate = calculateCompletionEtaUpdate({
      completedDeliveryStopId: requireDeliveryStopId(input),
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
    const etaUpdate = calculateRouteStartEtaUpdate({
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
    const etaUpdate = calculatePickupEtaUpdate({
      inputRouteVersionId,
      serverReceivedAt,
      stops
    });
    await persistEtaUpdate(prisma, schemaCapabilities, shopId, routePlanId, etaUpdate);
    return {
      etaSnapshot: buildDriverRouteEtaSnapshot({
        pickupCompletedAt: serverReceivedAt,
        stops: applyEtaUpdateToStops(stops, etaUpdate)
      }),
      etaUpdate
    };
  }

  if (input.eventType === 'ROUTE_COMPLETED') {
    await prisma.routePlan.updateMany({
      data: { status: 'COMPLETED' },
      where: {
        driverId: input.driverId,
        id: requireRoutePlanId(input),
        shopId,
        status: { not: 'CANCELLED' }
      }
    });
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

async function loadPickupCompletedAt(
  prisma: Pick<DriverEventPrismaClient, 'driverEvent'>,
  driverId: string,
  routePlanId: string
): Promise<Date | null> {
  const event = await prisma.driverEvent.findFirst({
    orderBy: { createdAt: 'asc' },
    select: { createdAt: true },
    where: {
      driverId,
      eventType: 'PICKUP_COMPLETED',
      routePlanId
    }
  });
  return event?.createdAt ?? null;
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

function requireRoutePlanId(input: RecordDriverEventInput): string {
  if (input.routePlanId === null || input.routePlanId.trim().length === 0) {
    throw new DriverEventContextError('Driver event requires routePlanId for terminal route state changes');
  }

  return input.routePlanId;
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
