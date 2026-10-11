import type { PrismaClient } from '@prisma/client';

import {
  ROUTE_TRACKING_SCHEMA_VERSION,
  ROUTE_TRACKING_V1_POLICY
} from './route-tracking.policy.js';
import {
  toRouteTrackingPositionEvents,
  toRouteTrackingRecordedPath
} from './route-tracking.geometry.js';
import {
  buildRouteTrackingRoadMatchedPath,
} from './route-tracking.road-match.js';
import {
  loadRouteTrackingEventWindow,
  occurredAtWithinRouteTrackingEventWindow,
  type RouteTrackingEventWindow,
} from './route-tracking.event-window.js';
import type {
  RouteTrackingPositionEventV1,
  RouteExecutionEvidenceV1,
  RouteExecutionLifecycleEvidenceV1,
  RouteTrackingProgressEventType,
  RouteTrackingProgressEventV1,
  RouteTrackingProgressSnapshotV1,
  RouteTrackingService,
  RouteTrackingSnapshotV1,
  RouteTrackingStopArrivalV1,
  RouteTrackingStopCompletionEventType,
  RouteTrackingStopCompletionV1,
  RouteTrackingStatus
} from './route-tracking.types.js';

type RouteTrackingPrismaClient = Pick<PrismaClient, 'driverEvent' | 'routePlan' | 'routePlanStop' | 'routeTrackingGeometry'>;

const DEPOT_RETURN_THRESHOLD_METERS = 150;

const ROUTE_TRACKING_PROGRESS_EVENT_TYPES: RouteTrackingProgressEventType[] = [
  'ROUTE_STARTED',
  'ROUTE_PAUSED',
  'ROUTE_COMPLETED',
  'STOP_ARRIVED',
  'STOP_DELIVERED',
  'STOP_FAILED'
];

const ROUTE_TRACKING_STOP_COMPLETION_EVENT_TYPES: RouteTrackingStopCompletionEventType[] = [
  'STOP_DELIVERED',
  'STOP_FAILED'
];

const ROUTE_TRACKING_LIFECYCLE_EVENT_TYPES: RouteTrackingProgressEventType[] = [
  'ROUTE_STARTED',
  'ROUTE_PAUSED',
  'ROUTE_COMPLETED'
];

type DriverLocationEventRow = {
  createdAt: Date;
  driverId: string | null;
  id: string;
  latitude: unknown;
  longitude: unknown;
  occurredAt: Date;
  routePlanId: string | null;
};

type DriverProgressEventRow = {
  createdAt: Date;
  deliveryStopId: string | null;
  driverId: string | null;
  eventType: string;
  id: string;
  occurredAt: Date;
  routePlanId: string | null;
};

type DriverArrivalEventRow = DriverProgressEventRow & {
  latitude: unknown;
  longitude: unknown;
};

type DriverLifecycleEventRow = {
  createdAt: Date;
  eventType: string;
  id: string;
  latitude: unknown;
  longitude: unknown;
  occurredAt: Date;
};

export class PrismaRouteTrackingService implements RouteTrackingService {
  constructor(private readonly prisma: RouteTrackingPrismaClient) {}

  async getRouteTrackingSnapshot(input: {
    now?: Date;
    routePlanId: string;
  }): Promise<RouteTrackingSnapshotV1> {
    const serverTime = input.now ?? new Date();
    const eventWindow = await loadRouteTrackingEventWindow(this.prisma, input.routePlanId);
    const [recordedGeometry, latestProgressRow, latestDriverStageRow, routeStops, arrivalRows] = await Promise.all([
      this.prisma.routeTrackingGeometry.findUnique({
        where: { routePlanId: input.routePlanId }
      }),
      this.prisma.driverEvent.findFirst({
        orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }],
        select: {
          createdAt: true,
          deliveryStopId: true,
          driverId: true,
          eventType: true,
          id: true,
          occurredAt: true,
          routePlanId: true
        },
        where: {
          eventType: { in: ROUTE_TRACKING_PROGRESS_EVENT_TYPES },
          routePlanId: input.routePlanId
        }
      }),
      this.prisma.driverEvent.findFirst({
        orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }],
        select: {
          createdAt: true,
          deliveryStopId: true,
          driverId: true,
          eventType: true,
          id: true,
          occurredAt: true,
          routePlanId: true
        },
        where: {
          OR: [
            {
              driverId: { not: null },
              eventType: { in: ROUTE_TRACKING_PROGRESS_EVENT_TYPES }
            },
            {
              eventType: { in: ROUTE_TRACKING_LIFECYCLE_EVENT_TYPES }
            }
          ],
          routePlanId: input.routePlanId
        }
      }),
      this.prisma.routePlanStop.findMany({
        select: {
          deliveryStop: {
            select: {
              // Completion times come with the stop status that the snapshot already reads.
              driverEvents: {
                orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
                select: {
                  createdAt: true,
                  driverId: true,
                  eventType: true,
                  id: true,
                  occurredAt: true
                },
                where: {
                  driverId: { not: null },
                  eventType: { in: ROUTE_TRACKING_STOP_COMPLETION_EVENT_TYPES },
                  routePlanId: input.routePlanId
                }
              },
              status: true
            }
          },
          deliveryStopId: true,
          sequence: true
        },
        where: { routePlanId: input.routePlanId }
      }),
      this.prisma.driverEvent.findMany({
        orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        select: {
          createdAt: true,
          deliveryStopId: true,
          driverId: true,
          eventType: true,
          id: true,
          latitude: true,
          longitude: true,
          occurredAt: true,
          routePlanId: true
        },
        where: {
          deliveryStopId: { not: null },
          driverId: { not: null },
          eventType: 'STOP_ARRIVED',
          routePlanId: input.routePlanId
        }
      })
    ]);
    const usableRecordedGeometry = recordedGeometry !== null
      && (eventWindow === null || (
        occurredAtWithinRouteTrackingEventWindow(eventWindow, recordedGeometry.firstOccurredAt)
        && occurredAtWithinRouteTrackingEventWindow(eventWindow, recordedGeometry.lastOccurredAt)
      ))
      ? recordedGeometry
      : null;
    const fallbackRows = usableRecordedGeometry === null
      ? await this.prisma.driverEvent.findMany({
          orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
          select: {
            createdAt: true,
            driverId: true,
            id: true,
            latitude: true,
            longitude: true,
            occurredAt: true,
            routePlanId: true
          },
          where: {
            eventType: 'LOCATION_UPDATED',
            latitude: { not: null },
            longitude: { not: null },
            ...(eventWindow === null ? {} : {
              occurredAt: {
                gte: eventWindow.startInclusive,
                lt: eventWindow.endExclusive,
              },
            }),
            routePlanId: input.routePlanId
          }
        })
      : [];
    const arrivalLocationRows = usableRecordedGeometry !== null && arrivalRows.some((row) => (
      readCoordinate(row.latitude, row.longitude) === null
    ))
      ? await this.prisma.driverEvent.findMany({
          orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
          select: {
            createdAt: true,
            driverId: true,
            id: true,
            latitude: true,
            longitude: true,
            occurredAt: true,
            routePlanId: true
          },
          where: {
            driverId: {
              in: [...new Set(arrivalRows.flatMap((row) => row.driverId === null ? [] : [row.driverId]))]
            },
            eventType: 'LOCATION_UPDATED',
            latitude: { not: null },
            longitude: { not: null },
            ...(eventWindow === null ? {} : {
              occurredAt: {
                gte: eventWindow.startInclusive,
                lt: eventWindow.endExclusive,
              },
            }),
            OR: arrivalRows
              .filter((row) => readCoordinate(row.latitude, row.longitude) === null)
              .map((row) => ({
                occurredAt: {
                  gte: new Date(row.occurredAt.getTime() - ROUTE_TRACKING_V1_POLICY.delayedThresholdMs),
                  lte: new Date(row.occurredAt.getTime() + ROUTE_TRACKING_V1_POLICY.delayedThresholdMs)
                }
              })),
            routePlanId: input.routePlanId
          }
        })
      : [];
    const recentPositions = usableRecordedGeometry === null
      ? fallbackRows
          .filter((row) => eventWindow === null
            || occurredAtWithinRouteTrackingEventWindow(eventWindow, row.occurredAt))
          .map((row) => toPositionEvent(row))
          .filter((position): position is RouteTrackingPositionEventV1 => position !== null)
          .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt))
      : toRouteTrackingPositionEvents(usableRecordedGeometry);
    const latestPosition = recentPositions.at(-1) ?? null;
    const arrivalPositions = arrivalLocationRows
      .filter((row) => eventWindow === null
        || occurredAtWithinRouteTrackingEventWindow(eventWindow, row.occurredAt))
      .map((row) => toPositionEvent(row))
      .filter((position): position is RouteTrackingPositionEventV1 => position !== null);
    const progress = buildProgressSnapshot(latestProgressRow, latestDriverStageRow, routeStops);
    const executionEvidence = await this.getExecutionEvidence(input.routePlanId, recentPositions, eventWindow);
    const cachedRoadMatch = buildRouteTrackingRoadMatchedPath(usableRecordedGeometry);
    const roadMatchedPath = cachedRoadMatch !== null
      && usableRecordedGeometry !== null
      && cachedRoadMatch.inputPointCount <= usableRecordedGeometry.sourcePointCount
      && (eventWindow === null
        || occurredAtWithinRouteTrackingEventWindow(eventWindow, cachedRoadMatch.lastInputOccurredAt))
      ? cachedRoadMatch
      : null;
    return {
      executionEvidence,
      latestPosition,
      policy: ROUTE_TRACKING_V1_POLICY,
      progress,
      recordedPath: toRouteTrackingRecordedPath(usableRecordedGeometry),
      roadMatchedPath,
      recentPositions,
      routePlanId: input.routePlanId,
      schemaVersion: ROUTE_TRACKING_SCHEMA_VERSION,
      serverTime: serverTime.toISOString(),
      status: getTrackingStatus(latestPosition, serverTime),
      stopArrivals: buildStopArrivals(arrivalRows, routeStops, [...recentPositions, ...arrivalPositions]),
      stopCompletions: buildStopCompletions(routeStops, input.routePlanId)
    };
  }

  private async getExecutionEvidence(
    routePlanId: string,
    positions: RouteTrackingPositionEventV1[],
    eventWindow: RouteTrackingEventWindow | null
  ): Promise<RouteExecutionEvidenceV1> {
    const lifecycleSelect = {
      createdAt: true,
      eventType: true,
      id: true,
      latitude: true,
      longitude: true,
      occurredAt: true
    } as const;
    const [startRow, completionRow] = await Promise.all([
      this.prisma.driverEvent.findFirst({
        orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }],
        select: lifecycleSelect,
        where: { eventType: 'ROUTE_STARTED', routePlanId }
      }),
      this.prisma.driverEvent.findFirst({
        orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }],
        select: lifecycleSelect,
        where: { eventType: 'ROUTE_COMPLETED', routePlanId }
      })
    ]);
    const start = startRow !== null && (eventWindow === null
      || occurredAtWithinRouteTrackingEventWindow(eventWindow, startRow.occurredAt))
      ? toLifecycleEvidence(startRow, 'ROUTE_STARTED')
      : null;
    // An earlier completion belongs to a previous execution, even on the same route.
    const completion = completionRow !== null
      && (eventWindow === null || occurredAtWithinRouteTrackingEventWindow(eventWindow, completionRow.occurredAt))
      && (startRow === null || completionRow.occurredAt.getTime() >= startRow.occurredAt.getTime())
      ? toLifecycleEvidence(completionRow, 'ROUTE_COMPLETED')
      : null;
    const firstPosition = positions[0] ?? null;
    const lastPosition = positions.at(-1) ?? null;
    if (start === null && completion === null) {
      return emptyExecutionEvidence(firstPosition, lastPosition);
    }

    const routePlan = await this.prisma.routePlan.findUnique({
      select: { constraints: true, depotLatitude: true, depotLongitude: true },
      where: { id: routePlanId }
    });
    const routeEndMode = readRouteEndMode(routePlan?.constraints);
    return {
      completion,
      firstPosition,
      lastPosition,
      returnToDepot: buildReturnEvidence({
        completion,
        depot: readCoordinate(routePlan?.depotLatitude, routePlan?.depotLongitude),
        lastPosition,
        routeEndMode
      }),
      routeEndMode,
      schemaVersion: 'route_execution_evidence.v1',
      start,
      timeSemantics: 'EVENT_TIMESTAMPS_ONLY'
    };
  }

}

function emptyExecutionEvidence(
  firstPosition: RouteTrackingPositionEventV1 | null,
  lastPosition: RouteTrackingPositionEventV1 | null
): RouteExecutionEvidenceV1 {
  return {
    completion: null,
    firstPosition,
    lastPosition,
    returnToDepot: {
      distanceToDepotMeters: null,
      evidenceEventId: null,
      observedAt: null,
      source: 'NONE',
      status: 'UNAVAILABLE',
      thresholdMeters: DEPOT_RETURN_THRESHOLD_METERS
    },
    routeEndMode: null,
    schemaVersion: 'route_execution_evidence.v1',
    start: null,
    timeSemantics: 'EVENT_TIMESTAMPS_ONLY'
  };
}

function toLifecycleEvidence(
  row: DriverLifecycleEventRow | null,
  expectedType: 'ROUTE_COMPLETED' | 'ROUTE_STARTED'
): RouteExecutionLifecycleEvidenceV1 | null {
  if (row === null || row.eventType !== expectedType) return null;
  const coordinates = readCoordinate(row.latitude, row.longitude);
  return {
    eventId: row.id,
    latitude: coordinates?.latitude ?? null,
    longitude: coordinates?.longitude ?? null,
    occurredAt: row.occurredAt.toISOString(),
    receivedAt: row.createdAt.toISOString()
  };
}

function buildReturnEvidence(input: {
  completion: RouteExecutionLifecycleEvidenceV1 | null;
  depot: { latitude: number; longitude: number } | null;
  lastPosition: RouteTrackingPositionEventV1 | null;
  routeEndMode: 'END_AT_LAST_STOP' | 'RETURN_TO_DEPOT';
}): RouteExecutionEvidenceV1['returnToDepot'] {
  if (input.routeEndMode === 'END_AT_LAST_STOP') {
    return {
      distanceToDepotMeters: null,
      evidenceEventId: null,
      observedAt: null,
      source: 'NONE',
      status: 'NOT_REQUIRED',
      thresholdMeters: DEPOT_RETURN_THRESHOLD_METERS
    };
  }
  if (input.completion === null || input.depot === null) {
    return unavailableReturnEvidence();
  }
  const completionCoordinates = input.completion.latitude === null || input.completion.longitude === null
    ? null
    : { latitude: input.completion.latitude, longitude: input.completion.longitude };
  const lastPositionAgeMs = input.lastPosition === null
    ? Number.POSITIVE_INFINITY
    : Math.abs(Date.parse(input.completion.occurredAt) - Date.parse(input.lastPosition.occurredAt));
  const positionCoordinates = input.lastPosition === null || lastPositionAgeMs > ROUTE_TRACKING_V1_POLICY.delayedThresholdMs
    ? null
    : { latitude: input.lastPosition.latitude, longitude: input.lastPosition.longitude };
  const coordinates = completionCoordinates ?? positionCoordinates;
  if (coordinates === null) return unavailableReturnEvidence();
  const distanceToDepotMeters = Math.round(haversineMeters(input.depot, coordinates) * 10) / 10;
  const usesCompletion = completionCoordinates !== null;
  return {
    distanceToDepotMeters,
    evidenceEventId: usesCompletion ? input.completion.eventId : input.lastPosition!.eventId,
    observedAt: usesCompletion ? input.completion.occurredAt : input.lastPosition!.occurredAt,
    source: usesCompletion ? 'ROUTE_COMPLETED' : 'LOCATION_UPDATED',
    status: distanceToDepotMeters <= DEPOT_RETURN_THRESHOLD_METERS ? 'CONFIRMED' : 'UNCONFIRMED',
    thresholdMeters: DEPOT_RETURN_THRESHOLD_METERS
  };
}

function unavailableReturnEvidence(): RouteExecutionEvidenceV1['returnToDepot'] {
  return {
    distanceToDepotMeters: null,
    evidenceEventId: null,
    observedAt: null,
    source: 'NONE',
    status: 'UNAVAILABLE',
    thresholdMeters: DEPOT_RETURN_THRESHOLD_METERS
  };
}

function readRouteEndMode(value: unknown): 'END_AT_LAST_STOP' | 'RETURN_TO_DEPOT' {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'END_AT_LAST_STOP';
  return (value as Record<string, unknown>).routeEndMode === 'RETURN_TO_DEPOT'
    ? 'RETURN_TO_DEPOT'
    : 'END_AT_LAST_STOP';
}

function haversineMeters(
  left: { latitude: number; longitude: number },
  right: { latitude: number; longitude: number }
): number {
  const radians = (degrees: number): number => degrees * Math.PI / 180;
  const latitudeDelta = radians(right.latitude - left.latitude);
  const longitudeDelta = radians(right.longitude - left.longitude);
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(radians(left.latitude)) * Math.cos(radians(right.latitude)) * Math.sin(longitudeDelta / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function createRouteTrackingProgressEvent(input: {
  deliveryStopId: string | null;
  driverId: string | null;
  eventId: string;
  eventType: string;
  occurredAt: Date;
  receivedAt?: Date;
  routePlanId: string | null;
}): RouteTrackingProgressEventV1 | null {
  if (
    input.routePlanId === null ||
    !isRouteTrackingProgressEventType(input.eventType)
  ) {
    return null;
  }

  return {
    deliveryStopId: input.deliveryStopId,
    driverId: input.driverId,
    eventId: input.eventId,
    eventType: input.eventType,
    occurredAt: input.occurredAt.toISOString(),
    receivedAt: (input.receivedAt ?? new Date()).toISOString(),
    routePlanId: input.routePlanId,
    schemaVersion: ROUTE_TRACKING_SCHEMA_VERSION
  };
}

export function createRouteTrackingPositionEvent(input: {
  driverId: string | null;
  eventId: string;
  latitude: string | null;
  longitude: string | null;
  occurredAt: Date;
  receivedAt?: Date;
  routePlanId: string | null;
}): RouteTrackingPositionEventV1 | null {
  if (
    input.driverId === null ||
    input.routePlanId === null ||
    input.latitude === null ||
    input.longitude === null
  ) {
    return null;
  }

  const latitude = Number(input.latitude);
  const longitude = Number(input.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  return {
    driverId: input.driverId,
    eventId: input.eventId,
    latitude,
    longitude,
    occurredAt: input.occurredAt.toISOString(),
    receivedAt: (input.receivedAt ?? new Date()).toISOString(),
    routePlanId: input.routePlanId,
    schemaVersion: ROUTE_TRACKING_SCHEMA_VERSION
  };
}

function toPositionEvent(row: DriverLocationEventRow): RouteTrackingPositionEventV1 | null {
  return createRouteTrackingPositionEvent({
    driverId: row.driverId,
    eventId: row.id,
    latitude: stringifyCoordinate(row.latitude),
    longitude: stringifyCoordinate(row.longitude),
    occurredAt: row.occurredAt,
    receivedAt: row.createdAt,
    routePlanId: row.routePlanId
  });
}

function toProgressEvent(row: DriverProgressEventRow | null): RouteTrackingProgressEventV1 | null {
  if (row === null) return null;
  return createRouteTrackingProgressEvent({
    deliveryStopId: row.deliveryStopId,
    driverId: row.driverId,
    eventId: row.id,
    eventType: row.eventType,
    occurredAt: row.occurredAt,
    receivedAt: row.createdAt,
    routePlanId: row.routePlanId
  });
}

function buildProgressSnapshot(
  latestProgressRow: DriverProgressEventRow | null,
  latestDriverStageRow: DriverProgressEventRow | null,
  routeStops: Array<{ deliveryStop: { status: string }; deliveryStopId: string; sequence: number }>
): RouteTrackingProgressSnapshotV1 {
  const latestEvent = toProgressEvent(latestProgressRow);
  const latestDriverStageEvent = toProgressEvent(latestDriverStageRow);
  return {
    completedStopIds: routeStops
      .filter((routeStop) => routeStop.deliveryStop.status === 'DELIVERED')
      .map((routeStop) => routeStop.deliveryStopId),
    currentStage: getDriverStage(latestDriverStageEvent),
    currentStopId: latestDriverStageEvent?.eventType === 'STOP_ARRIVED'
      ? latestDriverStageEvent.deliveryStopId
      : null,
    failedStopIds: routeStops
      .filter((routeStop) => routeStop.deliveryStop.status === 'FAILED')
      .map((routeStop) => routeStop.deliveryStopId),
    latestEvent
  };
}

type DriverStopCompletionEventRow = {
  createdAt: Date;
  driverId: string | null;
  eventType: string;
  id: string;
  occurredAt: Date;
};

const COMPLETION_EVENT_TYPE_BY_STOP_STATUS: Record<string, RouteTrackingStopCompletionEventType> = {
  DELIVERED: 'STOP_DELIVERED',
  FAILED: 'STOP_FAILED'
};

/**
 * One entry per stop that is Delivered or Failed now: the latest driver event
 * of the matching type. An event that no longer matches the stop status (the
 * office moved the stop back, or the other outcome came later) is not shown.
 */
function buildStopCompletions(
  routeStops: Array<{
    deliveryStop: { driverEvents?: DriverStopCompletionEventRow[]; status: string };
    deliveryStopId: string;
    sequence: number;
  }>,
  routePlanId: string
): RouteTrackingStopCompletionV1[] {
  return routeStops.flatMap((routeStop) => {
    const eventType = COMPLETION_EVENT_TYPE_BY_STOP_STATUS[routeStop.deliveryStop.status];
    if (eventType === undefined) return [];
    const event = (routeStop.deliveryStop.driverEvents ?? [])
      .filter((candidate) => candidate.eventType === eventType && candidate.driverId !== null)
      .reduce<DriverStopCompletionEventRow | null>((latest, candidate) => (
        latest === null || isLaterDriverEvent(candidate, latest) ? candidate : latest
      ), null);
    if (event === null || event.driverId === null) return [];

    return [{
      deliveryStopId: routeStop.deliveryStopId,
      driverId: event.driverId,
      eventId: event.id,
      eventType,
      occurredAt: event.occurredAt.toISOString(),
      receivedAt: event.createdAt.toISOString(),
      routePlanId,
      schemaVersion: 'route_tracking_completion.v1' as const,
      stopSequence: routeStop.sequence
    }];
  }).sort((left, right) => (
    left.occurredAt.localeCompare(right.occurredAt) || left.stopSequence - right.stopSequence
  ));
}

function isLaterDriverEvent(candidate: DriverStopCompletionEventRow, current: DriverStopCompletionEventRow): boolean {
  return candidate.occurredAt.getTime() > current.occurredAt.getTime()
    || (candidate.occurredAt.getTime() === current.occurredAt.getTime()
      && (candidate.createdAt.getTime() > current.createdAt.getTime()
        || (candidate.createdAt.getTime() === current.createdAt.getTime() && candidate.id > current.id)));
}

function buildStopArrivals(
  arrivalRows: DriverArrivalEventRow[],
  routeStops: Array<{ deliveryStopId: string; sequence: number }>,
  positions: RouteTrackingPositionEventV1[]
): RouteTrackingStopArrivalV1[] {
  const stopSequenceById = new Map(routeStops.map((routeStop) => [routeStop.deliveryStopId, routeStop.sequence]));
  return arrivalRows.flatMap((row) => {
    if (row.deliveryStopId === null || row.driverId === null || row.routePlanId === null) return [];
    const stopSequence = stopSequenceById.get(row.deliveryStopId);
    if (stopSequence === undefined) return [];

    const directCoordinate = readCoordinate(row.latitude, row.longitude);
    const nearestPosition = directCoordinate === null
      ? findNearestPosition(positions, row.occurredAt, row.driverId)
      : null;
    const positionAgeMs = nearestPosition === null
      ? directCoordinate === null ? null : 0
      : Math.abs(row.occurredAt.getTime() - Date.parse(nearestPosition.occurredAt));
    const canUseNearestPosition = nearestPosition !== null
      && positionAgeMs !== null
      && positionAgeMs <= ROUTE_TRACKING_V1_POLICY.delayedThresholdMs;

    return [{
      deliveryStopId: row.deliveryStopId,
      driverId: row.driverId,
      eventId: row.id,
      latitude: directCoordinate?.latitude ?? (canUseNearestPosition ? nearestPosition.latitude : null),
      longitude: directCoordinate?.longitude ?? (canUseNearestPosition ? nearestPosition.longitude : null),
      occurredAt: row.occurredAt.toISOString(),
      positionAgeMs,
      positionSource: directCoordinate !== null
        ? 'event'
        : canUseNearestPosition ? 'nearest_location' : 'unavailable',
      receivedAt: row.createdAt.toISOString(),
      routePlanId: row.routePlanId,
      schemaVersion: 'route_tracking_arrival.v1',
      stopSequence
    }];
  });
}

function readCoordinate(latitudeValue: unknown, longitudeValue: unknown): { latitude: number; longitude: number } | null {
  const latitudeText = stringifyCoordinate(latitudeValue);
  const longitudeText = stringifyCoordinate(longitudeValue);
  if (latitudeText === null || longitudeText === null) return null;
  const latitude = Number(latitudeText);
  const longitude = Number(longitudeText);
  if (
    !Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
    !Number.isFinite(longitude) || longitude < -180 || longitude > 180
  ) {
    return null;
  }
  return { latitude, longitude };
}

function findNearestPosition(
  positions: RouteTrackingPositionEventV1[],
  occurredAt: Date,
  driverId: string
): RouteTrackingPositionEventV1 | null {
  const targetTimestamp = occurredAt.getTime();
  return positions.filter((position) => position.driverId === driverId).reduce<RouteTrackingPositionEventV1 | null>((nearest, position) => {
    if (nearest === null) return position;
    const currentDistance = Math.abs(Date.parse(position.occurredAt) - targetTimestamp);
    const nearestDistance = Math.abs(Date.parse(nearest.occurredAt) - targetTimestamp);
    return currentDistance < nearestDistance ? position : nearest;
  }, null);
}

function getDriverStage(event: RouteTrackingProgressEventV1 | null): RouteTrackingProgressSnapshotV1['currentStage'] {
  if (event === null) return 'READY';
  if (event.eventType === 'ROUTE_COMPLETED') return 'COMPLETED';
  if (event.eventType === 'ROUTE_PAUSED') return 'PAUSED';
  if (event.eventType === 'STOP_ARRIVED') return 'AT_STOP';
  return 'DRIVING';
}

function isRouteTrackingProgressEventType(value: string): value is RouteTrackingProgressEventType {
  return ROUTE_TRACKING_PROGRESS_EVENT_TYPES.includes(value as RouteTrackingProgressEventType);
}

function stringifyCoordinate(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value === 'number' || typeof value === 'string') return String(value);
  if (hasToNumber(value)) return String(value.toNumber());
  return null;
}

function hasToNumber(value: unknown): value is { toNumber(): number } {
  return typeof value === 'object' && value !== null && 'toNumber' in value && typeof value.toNumber === 'function';
}

function getTrackingStatus(
  latestPosition: RouteTrackingPositionEventV1 | null,
  serverTime: Date
): RouteTrackingStatus {
  if (latestPosition === null) return 'NO_POSITION';
  const ageMs = serverTime.getTime() - new Date(latestPosition.occurredAt).getTime();
  if (ageMs <= ROUTE_TRACKING_V1_POLICY.liveThresholdMs) return 'LIVE';
  if (ageMs <= ROUTE_TRACKING_V1_POLICY.delayedThresholdMs) return 'DELAYED';
  return 'STALE';
}
