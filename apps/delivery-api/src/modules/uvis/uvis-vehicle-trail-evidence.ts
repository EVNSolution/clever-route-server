export const MAX_PLAUSIBLE_SPEED_METERS_PER_SECOND = 55;

type GpsPoint = {
  latitude: number;
  longitude: number;
};

type TimedGpsPoint = GpsPoint & { observedAt: string | Date };

export function distanceMeters(left: GpsPoint, right: GpsPoint): number {
  const earthRadiusMeters = 6_371_000;
  const leftLat = degreesToRadians(left.latitude);
  const rightLat = degreesToRadians(right.latitude);
  const deltaLat = degreesToRadians(right.latitude - left.latitude);
  const deltaLng = degreesToRadians(right.longitude - left.longitude);
  const a = Math.sin(deltaLat / 2) ** 2
    + Math.cos(leftLat) * Math.cos(rightLat) * Math.sin(deltaLng / 2) ** 2;
  return 2 * earthRadiusMeters * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function impliedSpeedMetersPerSecond(
  previous: TimedGpsPoint,
  current: TimedGpsPoint,
): number {
  const elapsedSeconds = (observedAtMs(current) - observedAtMs(previous)) / 1000;
  return elapsedSeconds > 0 ? distanceMeters(previous, current) / elapsedSeconds : Number.POSITIVE_INFINITY;
}

export function hasImplausibleGpsJump(
  previous: TimedGpsPoint,
  current: TimedGpsPoint,
): boolean {
  return impliedSpeedMetersPerSecond(previous, current) > MAX_PLAUSIBLE_SPEED_METERS_PER_SECOND;
}

function observedAtMs(point: TimedGpsPoint): number {
  return point.observedAt instanceof Date ? point.observedAt.getTime() : Date.parse(point.observedAt);
}

function degreesToRadians(value: number): number {
  return value * Math.PI / 180;
}
