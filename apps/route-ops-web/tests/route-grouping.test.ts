import { describe, expect, test } from 'vitest';
import { appendPolygonVertex, closePolygonDraft, polygonDraftToGeoJson, readPolygonVertices } from '../src/routeGrouping';

describe('route grouping polygon draft helpers', () => {
  test('click appends vertices and double-click closes only valid polygons', () => {
    let draft = { closed: false, vertices: [] as Array<{ latitude: number; longitude: number }> };
    draft = appendPolygonVertex(draft, { latitude: 43, longitude: -79 });
    draft = closePolygonDraft(draft);
    expect(draft.closed).toBe(false);
    draft = appendPolygonVertex(draft, { latitude: 44, longitude: -79 });
    draft = appendPolygonVertex(draft, { latitude: 44, longitude: -78 });
    draft = closePolygonDraft(draft);
    expect(draft.closed).toBe(true);
    expect(polygonDraftToGeoJson(draft)?.coordinates[0]).toHaveLength(4);
  });

  test('reads persisted polygon geometry for UI rendering', () => {
    expect(readPolygonVertices({ type: 'Polygon', coordinates: [[[-79, 43], [-78, 43], [-78, 44], [-79, 43]]] })).toEqual([
      { latitude: 43, longitude: -79 },
      { latitude: 43, longitude: -78 },
      { latitude: 44, longitude: -78 },
      { latitude: 43, longitude: -79 },
    ]);
  });
});
