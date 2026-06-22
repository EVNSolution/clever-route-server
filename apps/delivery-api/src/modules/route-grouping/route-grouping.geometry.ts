export type Coordinate = { latitude: number; longitude: number };
export type PolygonRing = Coordinate[];

export type PolygonClassification =
  | { status: 'UNASSIGNED'; polygonIds: [] }
  | { status: 'ASSIGNED'; polygonIds: [string] }
  | { status: 'OVERLAP'; polygonIds: string[] };

export type PolygonForClassification = {
  id: string;
  vertices: PolygonRing;
};

export function classifyCoordinateInPolygons(
  coordinate: Coordinate,
  polygons: PolygonForClassification[]
): PolygonClassification {
  const matches = polygons
    .filter((polygon) => isPointInPolygon(coordinate, polygon.vertices))
    .map((polygon) => polygon.id);
  if (matches.length === 0) return { status: 'UNASSIGNED', polygonIds: [] };
  return { status: 'ASSIGNED', polygonIds: [matches[matches.length - 1] as string] };
}

export function isPointInPolygon(point: Coordinate, vertices: PolygonRing): boolean {
  if (vertices.length < 3) return false;
  const x = point.longitude;
  const y = point.latitude;
  let inside = false;

  for (let index = 0, previousIndex = vertices.length - 1; index < vertices.length; previousIndex = index++) {
    const current = vertices[index];
    const previous = vertices[previousIndex];
    if (current === undefined || previous === undefined) continue;
    const xi = current.longitude;
    const yi = current.latitude;
    const xj = previous.longitude;
    const yj = previous.latitude;

    if (pointOnSegment(x, y, xi, yi, xj, yj)) return true;

    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }

  return inside;
}

function pointOnSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): boolean {
  const cross = (px - ax) * (by - ay) - (py - ay) * (bx - ax);
  if (Math.abs(cross) > 1e-10) return false;
  const dot = (px - ax) * (px - bx) + (py - ay) * (py - by);
  return dot <= 1e-10;
}

export function coordinatesFromGeoJsonPolygon(value: unknown): PolygonRing {
  if (value === null || typeof value !== 'object') return [];
  const candidate = value as { type?: unknown; coordinates?: unknown };
  if (candidate.type !== 'Polygon' || !Array.isArray(candidate.coordinates)) return [];
  const coordinates = candidate.coordinates as unknown[];
  const ring = coordinates[0];
  if (!Array.isArray(ring)) return [];
  return ring
    .map((entry) => {
      if (!Array.isArray(entry) || entry.length < 2) return null;
      const longitude = Number(entry[0]);
      const latitude = Number(entry[1]);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
      return { latitude, longitude };
    })
    .filter((entry): entry is Coordinate => entry !== null);
}

export function geoJsonPolygonFromCoordinates(vertices: PolygonRing): { type: 'Polygon'; coordinates: number[][][] } {
  const ring = vertices.map((vertex) => [vertex.longitude, vertex.latitude]);
  const first = ring[0];
  const last = ring[ring.length - 1];
  const closed =
    first !== undefined &&
    last !== undefined &&
    first[0] === last[0] &&
    first[1] === last[1]
      ? ring
      : first === undefined
        ? ring
        : [...ring, first];
  return { type: 'Polygon', coordinates: [closed] };
}
