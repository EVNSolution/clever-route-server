import { describe, expect, test } from 'vitest';
import { appendPolygonVertex, closePolygonDraft, polygonDraftToGeoJson, readPolygonVertices, removeLastPolygonVertex } from '../src/routeGrouping';
import { getRouteGroupingAssignableDrivers } from '../src/pages/RouteGroupingPage';
import type { DriverDto } from '../src/types';

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

  test('excludes drivers already used by another split polygon', () => {
    const drivers = [
      { id: 'driver-1', displayName: 'Alex Driver' },
      { id: 'driver-2', displayName: 'Minji Driver' },
      { id: 'driver-3', displayName: 'Sam Driver' },
    ] as DriverDto[];
    const assignedPolygon = { driverId: 'driver-1' };
    const unassignedPolygon = { driverId: null };
    const polygons = [
      assignedPolygon,
      unassignedPolygon,
      { driverId: 'driver-3' },
    ];

    expect(getRouteGroupingAssignableDrivers(unassignedPolygon, polygons, drivers).map((driver) => driver.id)).toEqual(['driver-2']);
    expect(getRouteGroupingAssignableDrivers(assignedPolygon, polygons, drivers).map((driver) => driver.id)).toEqual(['driver-1', 'driver-2']);
  });

});
