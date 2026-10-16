import type { RouteDepotEvidenceV1 } from './route-tracking.types.js';

// Same radius that decides a return to the depot.
export const DEPOT_RETURN_THRESHOLD_METERS = 150;

export type DepotPoint = { latitude: number; longitude: number };
export type DepotDepartureSample = DepotPoint & { id: string; observedAt: Date };

export type DepotDeparture = {
  arrivedAt: Date | null;
  departedAt: Date | null;
  evidence: RouteDepotEvidenceV1;
};

export function haversineMeters(left: DepotPoint, right: DepotPoint): number {
  const radians = (degrees: number): number => degrees * Math.PI / 180;
  const latitudeDelta = radians(right.latitude - left.latitude);
  const longitudeDelta = radians(right.longitude - left.longitude);
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(radians(left.latitude)) * Math.cos(radians(right.latitude)) * Math.sin(longitudeDelta / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Derives when a vehicle reached the depot and when it left it, from the route start and later positions.
 * The ROUTE_STARTED event itself is never changed; this is a derived value.
 * - Arrival: the first position inside the radius at or after the start. A start pressed inside the radius arrives at
 *   the start time.
 * - Departure: the first position outside the radius after that arrival.
 * `endAt` (the route completion) closes the window, so the final return to the depot is not read as a departure.
 * `samples` must be sorted by `observedAt` ascending.
 */
export function resolveDepotDeparture(input: {
  depot: DepotPoint | null;
  endAt: Date | null;
  samples: readonly DepotDepartureSample[];
  startedAt: Date | null;
  startedPosition: DepotPoint | null;
}): DepotDeparture {
  if (input.depot === null || input.startedAt === null) return depotDeparture(null, null, null, 'UNAVAILABLE');
  const { depot, endAt, startedAt } = input;
  const inside = (point: DepotPoint): boolean => haversineMeters(depot, point) <= DEPOT_RETURN_THRESHOLD_METERS;
  const inWindow = input.samples.filter((sample) =>
    sample.observedAt.getTime() >= startedAt.getTime()
    && (endAt === null || sample.observedAt.getTime() < endAt.getTime()));
  const startedInside = input.startedPosition !== null && inside(input.startedPosition);
  const arrival = startedInside ? null : inWindow.find((sample) => inside(sample)) ?? null;
  const arrivedAt = startedInside ? startedAt : arrival?.observedAt ?? null;
  if (arrivedAt === null) return depotDeparture(null, null, null, 'UNCONFIRMED');
  const departure = inWindow.find((sample) =>
    sample.observedAt.getTime() >= arrivedAt.getTime() && !inside(sample)) ?? null;
  return departure === null
    ? depotDeparture(arrivedAt, null, null, 'UNCONFIRMED')
    : depotDeparture(arrivedAt, departure.observedAt, { depot, sample: departure }, 'CONFIRMED');
}

function depotDeparture(
  arrivedAt: Date | null,
  departedAt: Date | null,
  confirmed: { depot: DepotPoint; sample: DepotDepartureSample } | null,
  status: RouteDepotEvidenceV1['status'],
): DepotDeparture {
  return {
    arrivedAt,
    departedAt,
    evidence: confirmed === null
      ? {
          distanceToDepotMeters: null,
          evidenceEventId: null,
          observedAt: null,
          source: 'NONE',
          status,
          thresholdMeters: DEPOT_RETURN_THRESHOLD_METERS,
        }
      : {
          distanceToDepotMeters: Math.round(haversineMeters(confirmed.depot, confirmed.sample) * 10) / 10,
          evidenceEventId: confirmed.sample.id,
          observedAt: confirmed.sample.observedAt.toISOString(),
          source: 'LOCATION_UPDATED',
          status,
          thresholdMeters: DEPOT_RETURN_THRESHOLD_METERS,
        },
  };
}
