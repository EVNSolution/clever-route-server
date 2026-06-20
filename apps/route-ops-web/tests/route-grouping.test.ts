import { describe, expect, test } from 'vitest';
import { ROUTE_GROUPING_POLYGON_COLORS, appendPolygonVertex, closePolygonDraft, polygonDraftToGeoJson, readPolygonVertices, removeLastPolygonVertex, routeGroupingPolygonColor } from '../src/routeGrouping';

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

  test('removes the latest draft vertex and reopens a closed draft for editing', () => {
    const draft = closePolygonDraft({
      closed: false,
      vertices: [
        { latitude: 43, longitude: -79 },
        { latitude: 44, longitude: -79 },
        { latitude: 44, longitude: -78 },
      ],
    });

    expect(removeLastPolygonVertex(draft)).toEqual({
      closed: false,
      vertices: [
        { latitude: 43, longitude: -79 },
        { latitude: 44, longitude: -79 },
      ],
    });
  });

  test('uses a stable route-group color palette for generated polygon splits', () => {
    expect(ROUTE_GROUPING_POLYGON_COLORS).toHaveLength(8);
    expect(routeGroupingPolygonColor(0)).toBe(ROUTE_GROUPING_POLYGON_COLORS[0]);
    expect(routeGroupingPolygonColor(ROUTE_GROUPING_POLYGON_COLORS.length)).toBe(ROUTE_GROUPING_POLYGON_COLORS[0]);
  });
});
