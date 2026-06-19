export type Coordinate = { latitude: number; longitude: number };
export type PolygonDraft = { closed: boolean; vertices: Coordinate[] };

export function appendPolygonVertex(draft: PolygonDraft, vertex: Coordinate): PolygonDraft {
  if (draft.closed) return draft;
  return { ...draft, vertices: [...draft.vertices, vertex] };
}

export function closePolygonDraft(draft: PolygonDraft): PolygonDraft {
  return { ...draft, closed: draft.vertices.length >= 3 };
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
