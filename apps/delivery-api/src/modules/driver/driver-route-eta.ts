export type DriverRouteEtaStop = {
  deliveryStopId: string;
  durationFromPreviousSeconds: number | null;
  estimatedArrivalAt: Date | null;
  sequence: number;
  serviceMinutes: number | null;
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
  trigger: 'ROUTE_STARTED' | 'STOP_ARRIVED';
  updatedStops: DriverRouteEtaStopUpdate[];
};

const DEFAULT_SERVICE_MINUTES = 5;

export function calculateRouteStartEtaUpdate(input: {
  inputRouteVersionId?: string | null;
  serverReceivedAt: Date;
  stops: DriverRouteEtaStop[];
}): DriverRouteEtaUpdate {
  const sortedStops = [...input.stops].sort((left, right) => left.sequence - right.sequence);
  let cursorMs: number | null = input.serverReceivedAt.getTime();
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
    etaSource: 'ROUTE_STARTED',
    etaStatus: failure === null ? 'READY' : 'FAILED',
    inputRouteVersionId: input.inputRouteVersionId ?? null,
    previousEstimatedArrivalAt: null,
    serverReceivedAt: input.serverReceivedAt.toISOString(),
    trigger: 'ROUTE_STARTED',
    updatedStops
  };
}

export function calculateArrivalEtaUpdate(input: {
  arrivedDeliveryStopId: string;
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
  let cursorMs: number | null = addServiceTime(input.serverReceivedAt.getTime(), arrivedStop.serviceMinutes);
  const updatedStops = sortedStops.slice(arrivedIndex + 1).map((stop) => {
    cursorMs = addDuration(cursorMs, stop.durationFromPreviousSeconds);
    const estimatedArrivalAt = toIsoString(cursorMs);
    cursorMs = addServiceTime(cursorMs, stop.serviceMinutes);
    return toStopUpdate(stop, estimatedArrivalAt);
  });
  const failure = etaFailureFor(updatedStops);

  return {
    actualArrivalAt: input.serverReceivedAt.toISOString(),
    deliveryStopId: input.arrivedDeliveryStopId,
    delaySeconds: previousEstimatedArrivalAt === null
      ? null
      : Math.round((input.serverReceivedAt.getTime() - previousEstimatedArrivalAt.getTime()) / 1000),
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
