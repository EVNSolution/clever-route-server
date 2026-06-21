import { describe, expect, test } from 'vitest';
import { appendPolygonVertex, closePolygonDraft, coordinateInPolygon, insertPolygonVertex, movePolygonVertex, polygonDraftToGeoJson, readEditablePolygonVertices, readPolygonVertices, removeLastPolygonVertex } from '../src/routeGrouping';
import { buildRouteGroupingAssignmentResults, canGenerateRouteGroupingChildRoutes, getRouteGroupingAssignableDrivers, getRouteGroupingDuplicateDriverPolygonIds, releaseDriverFromOtherRouteGroupingPolygons, sortRouteGroupingAssignments } from '../src/pages/RouteGroupingPage';
import type { DriverDto, RouteGroupingAssignmentDto, RouteGroupingDetailDto, RouteGroupingPolygonDto } from '../src/types';

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


  test('detects orders inside the active split polygon draft', () => {
    const polygon = [
      { latitude: 43, longitude: -80 },
      { latitude: 44, longitude: -80 },
      { latitude: 44, longitude: -79 },
      { latitude: 43, longitude: -79 },
    ];

    expect(coordinateInPolygon({ latitude: 43.5, longitude: -79.5 }, polygon)).toBe(true);
    expect(coordinateInPolygon({ latitude: 44.5, longitude: -79.5 }, polygon)).toBe(false);
  });

  test('reads persisted polygon geometry for UI rendering', () => {
    expect(readPolygonVertices({ type: 'Polygon', coordinates: [[[-79, 43], [-78, 43], [-78, 44], [-79, 43]]] })).toEqual([
      { latitude: 43, longitude: -79 },
      { latitude: 43, longitude: -78 },
      { latitude: 44, longitude: -78 },
      { latitude: 43, longitude: -79 },
    ]);
  });

  test('edits existing polygon vertices without preserving the closing duplicate', () => {
    const geometry = { type: 'Polygon', coordinates: [[[-79, 43], [-78, 43], [-78, 44], [-79, 43]]] };
    let draft = { closed: true, vertices: readEditablePolygonVertices(geometry) };
    expect(draft.vertices).toEqual([
      { latitude: 43, longitude: -79 },
      { latitude: 43, longitude: -78 },
      { latitude: 44, longitude: -78 },
    ]);

    draft = movePolygonVertex(draft, 1, { latitude: 43.5, longitude: -78.5 });
    draft = insertPolygonVertex(draft, 2, { latitude: 43.7, longitude: -78.2 });
    expect(polygonDraftToGeoJson(draft)?.coordinates[0]).toEqual([
      [-79, 43],
      [-78.5, 43.5],
      [-78.2, 43.7],
      [-78, 44],
      [-79, 43],
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
    const assignedPolygon = { id: 'polygon-1', driverId: 'driver-1' };
    const unassignedPolygon = { id: 'polygon-2', driverId: null };
    const polygons = [
      assignedPolygon,
      unassignedPolygon,
      { id: 'polygon-3', driverId: 'driver-3' },
    ];

    expect(getRouteGroupingAssignableDrivers(unassignedPolygon, polygons, drivers).map((driver) => driver.id)).toEqual(['driver-2']);
    expect(getRouteGroupingAssignableDrivers(assignedPolygon, polygons, drivers).map((driver) => driver.id)).toEqual(['driver-1', 'driver-2']);
  });

  test('marks repeated driver polygons as duplicates after the first occurrence', () => {
    expect(
      Array.from(getRouteGroupingDuplicateDriverPolygonIds([
        { id: 'polygon-1', driverId: 'driver-1' },
        { id: 'polygon-2', driverId: 'driver-2' },
        { id: 'polygon-3', driverId: 'driver-1' },
      ])),
    ).toEqual(['polygon-3']);
  });

  test('allows child route generation only after every order is uniquely grouped', () => {
    const ready = routeGroupingDetailFixture({
      polygons: [
        { closed: true, color: '#2563eb', drawOrder: 1, driverId: 'driver-1', geometry: {}, id: 'polygon-1', label: 'Alex' },
        { closed: true, color: '#16a34a', drawOrder: 2, driverId: 'driver-2', geometry: {}, id: 'polygon-2', label: 'Minji' },
      ],
      unresolvedOrders: 0,
    });

    expect(canGenerateRouteGroupingChildRoutes(ready)).toBe(true);
    expect(canGenerateRouteGroupingChildRoutes(routeGroupingDetailFixture({ polygons: [], unresolvedOrders: 0 }))).toBe(false);
    expect(canGenerateRouteGroupingChildRoutes(routeGroupingDetailFixture({ polygons: ready.polygons, unresolvedOrders: 1 }))).toBe(false);
    expect(
      canGenerateRouteGroupingChildRoutes(
        routeGroupingDetailFixture({
          polygons: [
            { closed: true, color: '#2563eb', drawOrder: 1, driverId: 'driver-1', geometry: {}, id: 'polygon-1', label: 'Alex' },
            { closed: true, color: '#16a34a', drawOrder: 2, driverId: 'driver-1', geometry: {}, id: 'polygon-2', label: 'Alex' },
          ],
          unresolvedOrders: 0,
        }),
      ),
    ).toBe(false);
  });


  test('moves a selected driver away from other polygons before saving an edited polygon', () => {
    const polygons = [
      { closed: true, color: '#2563eb', driverId: 'driver-1', geometry: {}, id: 'polygon-1', label: 'Alex' },
      { closed: true, color: '#16a34a', driverId: 'driver-1', geometry: {}, id: 'polygon-2', label: 'Alex' },
      { closed: true, color: '#f97316', driverId: 'driver-2', geometry: {}, id: 'polygon-3', label: 'Minji' },
    ];

    expect(releaseDriverFromOtherRouteGroupingPolygons(polygons, 'polygon-2', 'driver-1')).toEqual([
      { closed: true, color: '#2563eb', driverId: null, geometry: {}, id: 'polygon-1', label: 'Unassigned' },
      { closed: true, color: '#16a34a', driverId: 'driver-1', geometry: {}, id: 'polygon-2', label: 'Alex' },
      { closed: true, color: '#f97316', driverId: 'driver-2', geometry: {}, id: 'polygon-3', label: 'Minji' },
    ]);
  });

  test('labels route grouping order assignments by driver and split sequence', () => {
    const drivers = [
      { id: 'driver-1', displayName: '임 지인' },
      { id: 'driver-2', displayName: 'Alex Driver' },
    ] as DriverDto[];
    const polygons = [
      { closed: true, color: '#2563eb', drawOrder: 1, driverId: 'driver-1', geometry: {}, id: 'polygon-1', label: '임 지인' },
      { closed: true, color: '#16a34a', drawOrder: 2, driverId: null, geometry: {}, id: 'polygon-2', label: 'Unassigned' },
    ] as RouteGroupingPolygonDto[];
    const assignments = [
      { assignedDriverId: 'driver-1', assignedPolygonId: 'polygon-1', assignmentStatus: 'ASSIGNED', coordinates: { latitude: 43, longitude: -79 }, deliveryStopId: 'stop-1', items: [], orderId: 'order-1', orderName: '#1001', sourceOrderId: 'source-1', sourceSequence: 1 },
      { assignedDriverId: 'driver-1', assignedPolygonId: 'polygon-1', assignmentStatus: 'ASSIGNED', coordinates: { latitude: 44, longitude: -79 }, deliveryStopId: 'stop-2', items: [], orderId: 'order-2', orderName: '#1002', sourceOrderId: 'source-2', sourceSequence: 2 },
      { assignedDriverId: null, assignedPolygonId: null, assignmentStatus: 'UNASSIGNED', coordinates: { latitude: 45, longitude: -79 }, deliveryStopId: 'stop-3', items: [], orderId: 'order-3', orderName: '#1003', sourceOrderId: 'source-3', sourceSequence: 3 },
      { assignedDriverId: null, assignedPolygonId: null, assignmentStatus: 'OVERLAP', coordinates: { latitude: 46, longitude: -79 }, deliveryStopId: 'stop-4', items: [], orderId: 'order-4', orderName: '#1004', sourceOrderId: 'source-4', sourceSequence: 4 },
    ] as RouteGroupingAssignmentDto[];

    const results = buildRouteGroupingAssignmentResults(assignments, polygons, drivers, 'ko-KR');
    expect(Object.fromEntries(results)).toEqual({
      'order-1': { driverLabel: '임 지인', groupSortOrder: 1, sequenceLabel: '1', sequenceNumber: 1 },
      'order-2': { driverLabel: '임 지인', groupSortOrder: 1, sequenceLabel: '2', sequenceNumber: 2 },
      'order-3': { driverLabel: '미배정', groupSortOrder: Number.MAX_SAFE_INTEGER, sequenceLabel: null, sequenceNumber: null },
      'order-4': { driverLabel: '중복', groupSortOrder: Number.MAX_SAFE_INTEGER - 2, sequenceLabel: null, sequenceNumber: null },
    });
    expect(sortRouteGroupingAssignments([assignments[2]!, assignments[1]!, assignments[3]!, assignments[0]!], results).map((assignment) => assignment.orderId)).toEqual([
      'order-1',
      'order-2',
      'order-4',
      'order-3',
    ]);
  });

});

function routeGroupingDetailFixture(overrides: Partial<RouteGroupingDetailDto> = {}): RouteGroupingDetailDto {
  return {
    assignments: [],
    children: [],
    currentVersion: 1,
    displayStatus: 'DRAFT',
    id: 'group-1',
    name: 'Route 2026-06-21',
    planDate: '2026-06-21',
    polygons: [],
    status: 'DRAFT',
    totalOrders: 0,
    unresolvedOrders: 0,
    updatedAt: '2026-06-21T00:00:00.000Z',
    warningState: [],
    ...overrides,
  };
}
