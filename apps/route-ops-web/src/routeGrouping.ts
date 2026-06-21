export type Coordinate = { latitude: number; longitude: number };
export type PolygonDraft = { closed: boolean; vertices: Coordinate[] };

export function appendPolygonVertex(draft: PolygonDraft, vertex: Coordinate): PolygonDraft {
  if (draft.closed) return draft;
  return { ...draft, vertices: [...draft.vertices, vertex] };
}

export function insertPolygonVertex(draft: PolygonDraft, index: number, vertex: Coordinate): PolygonDraft {
  if (!draft.closed || draft.vertices.length < 3) return draft;
  const nextIndex = Math.max(0, Math.min(index, draft.vertices.length));
  return { ...draft, vertices: [...draft.vertices.slice(0, nextIndex), vertex, ...draft.vertices.slice(nextIndex)] };
}

export function movePolygonVertex(draft: PolygonDraft, index: number, vertex: Coordinate): PolygonDraft {
  if (index < 0 || index >= draft.vertices.length) return draft;
  return { ...draft, vertices: draft.vertices.map((current, currentIndex) => currentIndex === index ? vertex : current) };
}

export function closePolygonDraft(draft: PolygonDraft): PolygonDraft {
  return { ...draft, closed: draft.vertices.length >= 3 };
}

export function removeLastPolygonVertex(draft: PolygonDraft): PolygonDraft {
  if (draft.vertices.length === 0) return draft;
  return { closed: false, vertices: draft.vertices.slice(0, -1) };
}

export function polygonDraftToGeoJson(draft: PolygonDraft): { type: "Polygon"; coordinates: number[][][] } | null {
  if (!draft.closed || draft.vertices.length < 3) return null;
  const ring = draft.vertices.map((vertex) => [vertex.longitude, vertex.latitude]);
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first !== undefined && last !== undefined && (first[0] !== last[0] || first[1] !== last[1])) {
    ring.push(first);
  }
  return { type: "Polygon", coordinates: [ring] };
}

export function readPolygonVertices(geometry: unknown): Coordinate[] {
  if (geometry === null || typeof geometry !== "object" || Array.isArray(geometry)) return [];
  const candidate = geometry as { coordinates?: unknown; type?: unknown };
  if (candidate.type !== "Polygon" || !Array.isArray(candidate.coordinates)) return [];
  const ring = candidate.coordinates[0];
  if (!Array.isArray(ring)) return [];
  return ring
    .map((entry) => {
      if (!Array.isArray(entry) || entry.length < 2) return null;
      const longitude = Number(entry[0]);
      const latitude = Number(entry[1]);
      return Number.isFinite(latitude) && Number.isFinite(longitude) ? { latitude, longitude } : null;
    })
    .filter((entry): entry is Coordinate => entry !== null);
}

export function readEditablePolygonVertices(geometry: unknown): Coordinate[] {
  const vertices = readPolygonVertices(geometry);
  const first = vertices[0];
  const last = vertices[vertices.length - 1];
  if (first !== undefined && last !== undefined && first.latitude === last.latitude && first.longitude === last.longitude) {
    return vertices.slice(0, -1);
  }
  return vertices;
}

export function coordinateInPolygon(point: Coordinate, polygonVertices: Coordinate[]): boolean {
  if (polygonVertices.length < 3) return false;
  let inside = false;
  for (let currentIndex = 0, previousIndex = polygonVertices.length - 1; currentIndex < polygonVertices.length; previousIndex = currentIndex++) {
    const current = polygonVertices[currentIndex];
    const previous = polygonVertices[previousIndex];
    if (current === undefined || previous === undefined) continue;
    const crossesLatitude = current.latitude > point.latitude !== previous.latitude > point.latitude;
    if (!crossesLatitude) continue;
    const longitudeAtLatitude = ((previous.longitude - current.longitude) * (point.latitude - current.latitude)) / (previous.latitude - current.latitude) + current.longitude;
    if (point.longitude < longitudeAtLatitude) inside = !inside;
  }
  return inside;
}
