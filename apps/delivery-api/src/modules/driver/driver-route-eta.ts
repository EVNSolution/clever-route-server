export type DriverRouteEtaStop = {
  deliveryStopId: string;
  distanceFromPreviousMeters?: number | null;
  durationFromPreviousSeconds: number | null;
  etaCalculatedAt?: Date | null | undefined;
  etaFailureCode?: string | null | undefined;
  etaFailureMessage?: string | null | undefined;
  estimatedArrivalAt: Date | null;
  sequence: number;
  serviceMinutes: number | null;
  status?: string | null;
};

export type DriverRouteEtaStopUpdate = {
  deliveryStopId: string;
  estimatedArrivalAt: string | null;
  sequence: number;
};

export type DriverRouteEtaUpdate = {
  actualArrivalAt: string | null;
  deliveryStopId: string | null;
  delaySeconds: number | null;
  etaCalculatedAt: string;
  etaFailureCode: string | null;
  etaFailureMessage: string | null;
  etaSource: string;
  etaStatus: 'READY' | 'FAILED';
  inputRouteVersionId: string | null;
  previousEstimatedArrivalAt: string | null;
  serverReceivedAt: string;
  trigger: DriverRouteEtaTrigger;
  updatedStops: DriverRouteEtaStopUpdate[];
};

export type DriverRouteEtaTrigger = 'ROUTE_STARTED' | 'STOP_ARRIVED' | 'STOP_DELIVERED' | 'STOP_FAILED' | 'PICKUP_COMPLETED';

export type DriverRouteEtaSnapshot = {
  calculatedAt: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  nextStopEta: {
    deliveryStopId: string;
    distanceFromPreviousMeters: number | null;
    estimatedArrivalAt: string | null;
    sequence: number;
  } | null;
  pickupCompletedAt: string | null;
  remainingRouteEta: {
    distanceMeters: number | null;
    estimatedCompletionAt: string | null;
  } | null;
  status: 'PRE_PICKUP' | 'READY' | 'FAILED';
};

const DEFAULT_SERVICE_MINUTES = 5;

export function calculateRouteStartEtaUpdate(input: {
  eventOccurredAt: Date;
  inputRouteVersionId?: string | null;
  serverReceivedAt: Date;
  stops: DriverRouteEtaStop[];
}): DriverRouteEtaUpdate {
  return calculateFullChainEtaUpdate({
    eventOccurredAt: input.eventOccurredAt,
    inputRouteVersionId: input.inputRouteVersionId,
    serverReceivedAt: input.serverReceivedAt,
    stops: input.stops,
    trigger: 'ROUTE_STARTED'
  });
}

export function calculatePickupEtaUpdate(input: {
  eventOccurredAt: Date;
  inputRouteVersionId?: string | null;
  serverReceivedAt: Date;
  stops: DriverRouteEtaStop[];
}): DriverRouteEtaUpdate {
  return calculateFullChainEtaUpdate({
    eventOccurredAt: input.eventOccurredAt,
    inputRouteVersionId: input.inputRouteVersionId,
    serverReceivedAt: input.serverReceivedAt,
    stops: input.stops,
    trigger: 'PICKUP_COMPLETED'
  });
}

function calculateFullChainEtaUpdate(input: {
  eventOccurredAt: Date;
  inputRouteVersionId?: string | null | undefined;
  serverReceivedAt: Date;
  stops: DriverRouteEtaStop[];
  trigger: 'ROUTE_STARTED' | 'PICKUP_COMPLETED';
}): DriverRouteEtaUpdate {
  const sortedStops = [...input.stops].sort((left, right) => left.sequence - right.sequence);
  let cursorMs: number | null = effectiveEventTime(input.eventOccurredAt, input.serverReceivedAt).getTime();
  const updatedStops = sortedStops.map((stop) => {
    cursorMs = addDuration(cursorMs, stop.durationFromPreviousSeconds);
    const estimatedArrivalAt = toIsoString(cursorMs);
    cursorMs = addServiceTime(cursorMs, stop.serviceMinutes);
    return toStopUpdate(stop, estimatedArrivalAt);
  });
  const failure = etaFailureFor(updatedStops);

  return {
    actualArrivalAt: null,
    deliveryStopId: null,
    delaySeconds: null,
    etaCalculatedAt: input.serverReceivedAt.toISOString(),
    etaFailureCode: failure?.code ?? null,
    etaFailureMessage: failure?.message ?? null,
    etaSource: input.trigger,
    etaStatus: failure === null ? 'READY' : 'FAILED',
    inputRouteVersionId: input.inputRouteVersionId ?? null,
    previousEstimatedArrivalAt: null,
    serverReceivedAt: input.serverReceivedAt.toISOString(),
    trigger: input.trigger,
    updatedStops
  };
}

export function calculateArrivalEtaUpdate(input: {
  arrivedDeliveryStopId: string;
  eventOccurredAt: Date;
  inputRouteVersionId?: string | null;
  serverReceivedAt: Date;
  stops: DriverRouteEtaStop[];
}): DriverRouteEtaUpdate {
  const sortedStops = [...input.stops].sort((left, right) => left.sequence - right.sequence);
  const arrivedIndex = sortedStops.findIndex((stop) => stop.deliveryStopId === input.arrivedDeliveryStopId);
  if (arrivedIndex < 0) {
    throw new Error(`Route ETA stop not found: ${input.arrivedDeliveryStopId}`);
  }

  const arrivedStop = sortedStops[arrivedIndex]!;
  const previousEstimatedArrivalAt = arrivedStop.estimatedArrivalAt;
  const actualArrivalAt = effectiveEventTime(input.eventOccurredAt, input.serverReceivedAt);
  let cursorMs: number | null = addServiceTime(actualArrivalAt.getTime(), arrivedStop.serviceMinutes);
  const updatedStops = sortedStops.slice(arrivedIndex + 1).map((stop) => {
    cursorMs = addDuration(cursorMs, stop.durationFromPreviousSeconds);
    const estimatedArrivalAt = toIsoString(cursorMs);
    cursorMs = addServiceTime(cursorMs, stop.serviceMinutes);
    return toStopUpdate(stop, estimatedArrivalAt);
  });
  const failure = etaFailureFor(updatedStops);

  return {
    actualArrivalAt: actualArrivalAt.toISOString(),
    deliveryStopId: input.arrivedDeliveryStopId,
    delaySeconds: previousEstimatedArrivalAt === null
      ? null
      : Math.round((actualArrivalAt.getTime() - previousEstimatedArrivalAt.getTime()) / 1000),
    etaCalculatedAt: input.serverReceivedAt.toISOString(),
    etaFailureCode: failure?.code ?? null,
    etaFailureMessage: failure?.message ?? null,
    etaSource: 'STOP_ARRIVED',
    etaStatus: failure === null ? 'READY' : 'FAILED',
    inputRouteVersionId: input.inputRouteVersionId ?? null,
    previousEstimatedArrivalAt: previousEstimatedArrivalAt?.toISOString() ?? null,
    serverReceivedAt: input.serverReceivedAt.toISOString(),
    trigger: 'STOP_ARRIVED',
    updatedStops
  };
}

export function calculateCompletionEtaUpdate(input: {
  arrivedAt?: Date | null;
  completedDeliveryStopId: string;
  eventOccurredAt: Date;
  inputRouteVersionId?: string | null;
  serverReceivedAt: Date;
  stops: DriverRouteEtaStop[];
  trigger?: 'STOP_DELIVERED' | 'STOP_FAILED';
}): DriverRouteEtaUpdate {
  const sortedStops = [...input.stops].sort((left, right) => left.sequence - right.sequence);
  const completedIndex = sortedStops.findIndex((stop) => stop.deliveryStopId === input.completedDeliveryStopId);
  if (completedIndex < 0) {
    throw new Error(`Route ETA stop not found: ${input.completedDeliveryStopId}`);
  }

  const completedStop = sortedStops[completedIndex]!;
  const previousEstimatedArrivalAt = completedStop.estimatedArrivalAt;
  const previousEstimatedCompletionMs = previousEstimatedArrivalAt === null
    ? null
    : addServiceTime(previousEstimatedArrivalAt.getTime(), completedStop.serviceMinutes);
  const deliveredAt = effectiveEventTime(input.eventOccurredAt, input.serverReceivedAt);
  const arrivalServiceCompletedMs = input.arrivedAt === undefined || input.arrivedAt === null
    ? null
    : addServiceTime(input.arrivedAt.getTime(), completedStop.serviceMinutes);
  const completionAnchorMs = arrivalServiceCompletedMs ?? deliveredAt.getTime();
  const trigger = input.trigger ?? 'STOP_DELIVERED';
  let cursorMs: number | null = completionAnchorMs;
  const updatedStops = sortedStops.slice(completedIndex + 1).map((stop) => {
    cursorMs = addDuration(cursorMs, stop.durationFromPreviousSeconds);
    const estimatedArrivalAt = toIsoString(cursorMs);
    cursorMs = addServiceTime(cursorMs, stop.serviceMinutes);
    return toStopUpdate(stop, estimatedArrivalAt);
  });
  const failure = etaFailureFor(updatedStops);

  return {
    actualArrivalAt: null,
    deliveryStopId: input.completedDeliveryStopId,
    delaySeconds: previousEstimatedCompletionMs === null
      ? null
      : Math.round((completionAnchorMs - previousEstimatedCompletionMs) / 1000),
    etaCalculatedAt: input.serverReceivedAt.toISOString(),
    etaFailureCode: failure?.code ?? null,
    etaFailureMessage: failure?.message ?? null,
    etaSource: trigger,
    etaStatus: failure === null ? 'READY' : 'FAILED',
    inputRouteVersionId: input.inputRouteVersionId ?? null,
    previousEstimatedArrivalAt: previousEstimatedArrivalAt?.toISOString() ?? null,
    serverReceivedAt: input.serverReceivedAt.toISOString(),
    trigger,
    updatedStops
  };
}

function effectiveEventTime(eventOccurredAt: Date, serverReceivedAt: Date): Date {
  return eventOccurredAt.getTime() > serverReceivedAt.getTime() ? serverReceivedAt : eventOccurredAt;
}

export function buildDriverRouteEtaSnapshot(input: {
  pickupCompletedAt: Date | null;
  stops: DriverRouteEtaStop[];
}): DriverRouteEtaSnapshot {
  if (input.pickupCompletedAt === null) {
    return {
      calculatedAt: null,
      failureCode: null,
      failureMessage: null,
      nextStopEta: null,
      pickupCompletedAt: null,
      remainingRouteEta: null,
      status: 'PRE_PICKUP'
    };
  }

  const remainingStops = [...input.stops]
    .sort((left, right) => left.sequence - right.sequence)
    .filter((stop) => !isPastEtaStopStatus(stop.status));
  const nextStop = remainingStops[0] ?? null;
  const finalStop = remainingStops[remainingStops.length - 1] ?? null;
  const calculatedAt = latestCalculatedAt(remainingStops);
  const failure = etaSnapshotFailureFor(remainingStops);
  const completionMs = finalStop?.estimatedArrivalAt === null || finalStop === null
    ? null
    : addServiceTime(finalStop.estimatedArrivalAt.getTime(), finalStop.serviceMinutes);

  return {
    calculatedAt,
    failureCode: failure?.code ?? null,
    failureMessage: failure?.message ?? null,
    nextStopEta: nextStop === null ? null : {
      deliveryStopId: nextStop.deliveryStopId,
      distanceFromPreviousMeters: nextStop.distanceFromPreviousMeters ?? null,
      estimatedArrivalAt: nextStop.estimatedArrivalAt?.toISOString() ?? null,
      sequence: nextStop.sequence
    },
    pickupCompletedAt: input.pickupCompletedAt.toISOString(),
    remainingRouteEta: finalStop === null ? null : {
      distanceMeters: totalDistanceMeters(remainingStops),
      estimatedCompletionAt: toIsoString(completionMs)
    },
    status: failure === null ? 'READY' : 'FAILED'
  };
}

function addDuration(cursorMs: number | null, durationSeconds: number | null): number | null {
  if (cursorMs === null || durationSeconds === null || !Number.isFinite(durationSeconds) || durationSeconds < 0) {
    return null;
  }
  return cursorMs + durationSeconds * 1000;
}

function addServiceTime(cursorMs: number | null, serviceMinutes: number | null): number | null {
  if (cursorMs === null) return null;
  const normalizedMinutes = serviceMinutes === null || !Number.isFinite(serviceMinutes) || serviceMinutes < 0
    ? DEFAULT_SERVICE_MINUTES
    : serviceMinutes;
  return cursorMs + normalizedMinutes * 60_000;
}

function toIsoString(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function toStopUpdate(stop: DriverRouteEtaStop, estimatedArrivalAt: string | null): DriverRouteEtaStopUpdate {
  return {
    deliveryStopId: stop.deliveryStopId,
    estimatedArrivalAt,
    sequence: stop.sequence
  };
}

function etaFailureFor(updatedStops: DriverRouteEtaStopUpdate[]): { code: string; message: string } | null {
  return updatedStops.some((stop) => stop.estimatedArrivalAt === null)
    ? {
        code: 'ETA_INPUT_DURATION_UNAVAILABLE',
        message: 'ETA could not be calculated because route leg durations are unavailable.'
      }
    : null;
}

function etaSnapshotFailureFor(stops: DriverRouteEtaStop[]): { code: string; message: string } | null {
  return stops.length === 0 || stops.some((stop) => stop.estimatedArrivalAt === null)
    ? {
        code: 'ETA_INPUT_DURATION_UNAVAILABLE',
        message: 'ETA could not be calculated because route leg durations are unavailable.'
      }
    : null;
}

function latestCalculatedAt(stops: DriverRouteEtaStop[]): string | null {
  const calculatedTimes = stops
    .map((stop) => stop.etaCalculatedAt?.getTime() ?? null)
    .filter((value): value is number => value !== null);
  if (calculatedTimes.length === 0) return null;
  return new Date(Math.max(...calculatedTimes)).toISOString();
}

function totalDistanceMeters(stops: DriverRouteEtaStop[]): number | null {
  let total = 0;
  for (const stop of stops) {
    if (stop.distanceFromPreviousMeters === null || stop.distanceFromPreviousMeters === undefined) return null;
    total += stop.distanceFromPreviousMeters;
  }
  return total;
}

function isPastEtaStopStatus(status: string | null | undefined): boolean {
  return status === 'ARRIVED'
    || status === 'DELIVERED'
    || status === 'FAILED'
    || status === 'CANCELLED'
    || status === 'SKIPPED';
}
