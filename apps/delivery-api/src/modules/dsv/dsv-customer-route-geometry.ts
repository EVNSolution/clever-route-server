export type DsvV1LngLat = [number, number];

export type CutCustomerScopedRouteGeometryInput = {
  coordinates: readonly DsvV1LngLat[];
  end: DsvV1LngLat;
  maxSnapDistanceMeters?: number;
  start: DsvV1LngLat;
};

const defaultMaxSnapDistanceMeters = 500;
const earthRadiusMeters = 6_371_000;

export function cutCustomerScopedRouteGeometry(
  input: CutCustomerScopedRouteGeometryInput,
): DsvV1LngLat[] | null {
  if (input.coordinates.length < 2 || !isCoordinate(input.start) || !isCoordinate(input.end)) return null;
  const coordinates = input.coordinates.filter(isCoordinate);
  if (coordinates.length !== input.coordinates.length || coordinates.length < 2) return null;

  const maxSnapDistanceMeters = input.maxSnapDistanceMeters ?? defaultMaxSnapDistanceMeters;
  const startProjection = nearestRouteProjection(coordinates, input.start);
  const endProjection = nearestRouteProjection(coordinates, input.end);
  if (
    startProjection === null
    || endProjection === null
    || startProjection.distanceMeters > maxSnapDistanceMeters
    || endProjection.distanceMeters > maxSnapDistanceMeters
  ) return null;
  if (linearPosition(endProjection) <= linearPosition(startProjection)) return null;

  const scoped: DsvV1LngLat[] = [input.start];
  for (let index = startProjection.segmentIndex + 1; index <= endProjection.segmentIndex; index += 1) {
    scoped.push(coordinates[index]!);
  }
  scoped.push(input.end);
  const deduped = dedupeAdjacentCoordinates(scoped);
  return deduped.length >= 2 ? deduped : null;
}

type RouteProjection = {
  distanceMeters: number;
  projected: DsvV1LngLat;
  segmentIndex: number;
  t: number;
};

function nearestRouteProjection(coordinates: readonly DsvV1LngLat[], point: DsvV1LngLat): RouteProjection | null {
  let nearest: RouteProjection | null = null;
  for (let index = 0; index < coordinates.length - 1; index += 1) {
    const projection = projectToSegment(point, coordinates[index]!, coordinates[index + 1]!, index);
    if (nearest === null || projection.distanceMeters < nearest.distanceMeters) nearest = projection;
  }
  return nearest;
}

function projectToSegment(
  point: DsvV1LngLat,
  start: DsvV1LngLat,
  end: DsvV1LngLat,
  segmentIndex: number,
): RouteProjection {
  const originLatitude = toRadians(point[1]);
  const startPoint = toPlanarMeters(start, originLatitude);
  const endPoint = toPlanarMeters(end, originLatitude);
  const targetPoint = toPlanarMeters(point, originLatitude);
  const dx = endPoint.x - startPoint.x;
  const dy = endPoint.y - startPoint.y;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0
    ? 0
    : clamp(((targetPoint.x - startPoint.x) * dx + (targetPoint.y - startPoint.y) * dy) / lengthSquared, 0, 1);
  const projectedPoint = {
    x: startPoint.x + dx * t,
    y: startPoint.y + dy * t,
  };
  const projected: DsvV1LngLat = [
    start[0] + (end[0] - start[0]) * t,
    start[1] + (end[1] - start[1]) * t,
  ];
  return {
    distanceMeters: Math.hypot(targetPoint.x - projectedPoint.x, targetPoint.y - projectedPoint.y),
    projected,
    segmentIndex,
    t,
  };
}

function toPlanarMeters(coordinate: DsvV1LngLat, originLatitudeRadians: number): { x: number; y: number } {
  return {
    x: earthRadiusMeters * toRadians(coordinate[0]) * Math.cos(originLatitudeRadians),
    y: earthRadiusMeters * toRadians(coordinate[1]),
  };
}

function linearPosition(projection: RouteProjection): number {
  return projection.segmentIndex + projection.t;
}

function dedupeAdjacentCoordinates(coordinates: readonly DsvV1LngLat[]): DsvV1LngLat[] {
  return coordinates.filter((coordinate, index) => {
    if (index === 0) return true;
    const previous = coordinates[index - 1];
    return coordinate[0] !== previous![0] || coordinate[1] !== previous![1];
  });
}

function isCoordinate(value: unknown): value is DsvV1LngLat {
  return (
    Array.isArray(value)
    && value.length === 2
    && value.every((item) => typeof item === 'number' && Number.isFinite(item))
    && value[0] >= -180
    && value[0] <= 180
    && value[1] >= -90
    && value[1] <= 90
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function toRadians(degrees: number): number {
  return degrees * Math.PI / 180;
}
