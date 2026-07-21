import { describe, expect, test, vi } from 'vitest';

import {
  OsrmRouteTrackingRoadMatchProvider,
  buildRouteTrackingRoadMatchedPath,
  shouldRefreshRouteTrackingRoadMatchedPath,
} from '../src/modules/route-tracking/route-tracking.road-match.js';
import type { RouteTrackingGeometryDocumentV1, RouteTrackingGeometryRecord } from '../src/modules/route-tracking/route-tracking.geometry.js';

describe('route tracking road matching', () => {
  test('matches GPS samples against OSRM without closing the path or exposing point markers', async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      code: 'Ok',
      matchings: [{
        confidence: 0.92,
        geometry: {
          coordinates: [
            [126.9000, 37.5000],
            [126.9010, 37.5004],
            [126.9020, 37.5008],
            [126.9000, 37.5000],
          ],
          type: 'LineString',
        },
      }],
      tracepoints: [{}, {}, {}],
    }))));
    const provider = new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { korea: 'https://osrm-korea.example', ontario: 'https://osrm-ontario.example' },
      fetch,
    });

    const result = await provider.match(document([
      [126.9000, 37.5000],
      [126.9010, 37.5004],
      [126.9020, 37.5008],
    ]));

    expect(fetch).toHaveBeenCalledTimes(1);
    const requestedUrl = String((fetch.mock.calls as unknown as Array<[string, { method: 'GET'; signal?: AbortSignal }]>)[0]![0]);
    expect(requestedUrl).toContain('https://osrm-korea.example/match/v1/driving/');
    expect(requestedUrl).toContain('overview=full');
    expect(requestedUrl).toContain('geometries=geojson');
    expect(requestedUrl).toContain('gaps=split');
    expect(requestedUrl).toContain('tidy=true');
    expect(requestedUrl).toContain('timestamps=1784592000%3B1784592030%3B1784592060');
    expect(result?.coverage).toBe('korea');
    expect(result?.matchedGeometry?.type).toBe('MultiLineString');
    expect(result?.matchedGeometry?.coordinates).toEqual([[
      [126.9000, 37.5000],
      [126.9010, 37.5004],
      [126.9020, 37.5008],
    ]]);
    expect(result?.uncertainGeometry).toBeNull();
    expect(result?.inputPointCount).toBe(3);
    expect(result?.matchedPointCount).toBe(3);
    expect(result?.lastMatchedPosition).toEqual({
      latitude: 37.5008,
      longitude: 126.9020,
      occurredAt: '2026-07-21T00:01:00.000Z',
    });
    expect(result?.watermark).toContain('route_tracking_road_match.v1:korea:3:3:2026-07-21T00:01:00.000Z');
  });

  test('splits by GPS gaps and by 80-point OSRM match request limit', async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      code: 'Ok',
      matchings: [{
        confidence: 0.8,
        geometry: {
          coordinates: [[126.9, 37.5], [126.91, 37.51]],
          type: 'LineString',
        },
      }],
      tracepoints: [{}, {}],
    }))));
    const provider = new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { korea: 'https://osrm-korea.example' },
      fetch,
    });
    const firstSegment = Array.from({ length: 81 }, (_, index) => [126.9 + index * 0.0001, 37.5] as [number, number]);
    const secondSegment: [number, number][] = [[126.92, 37.52], [126.921, 37.521]];

    await provider.match(document([...firstSegment, ...secondSegment], {
      gapBeforeIndex: 81,
    }));

    expect(fetch).toHaveBeenCalledTimes(3);
    const requestPointCounts = (fetch.mock.calls as unknown as Array<[string, { method: 'GET'; signal?: AbortSignal }]>)
      .map((call) => decodeURIComponent(String(call[0])).split('/driving/')[1]!.split('?')[0]!.split(';').length);
    expect(requestPointCounts).toEqual([80, 2, 2]);
  });

  test('returns uncertain geometry when OSRM confidence is below the display threshold', async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      code: 'Ok',
      matchings: [{
        confidence: 0.49,
        geometry: {
          coordinates: [[-79.4, 43.65], [-79.41, 43.66]],
          type: 'LineString',
        },
      }],
      tracepoints: [{}, {}],
    }))));
    const provider = new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { ontario: 'https://osrm-ontario.example' },
      fetch,
    });

    const result = await provider.match(document([[-79.4, 43.65], [-79.41, 43.66]]));

    expect(result?.matchedGeometry).toBeNull();
    expect(result?.uncertainGeometry?.coordinates).toEqual([[[-79.4, 43.65], [-79.41, 43.66]]]);
  });

  test('keeps the actual last matched tracepoint so unmatched live GPS can remain dashed', async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      code: 'Ok',
      matchings: [{
        confidence: 0.9,
        geometry: {
          coordinates: [[126.9, 37.5], [126.901, 37.501]],
          type: 'LineString',
        },
      }],
      tracepoints: [
        { location: [126.9, 37.5], matchings_index: 0, waypoint_index: 0 },
        { location: [126.901, 37.501], matchings_index: 0, waypoint_index: 1 },
        null,
      ],
    }))));
    const provider = new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { korea: 'https://osrm-korea.example' },
      fetch,
    });

    const result = await provider.match(document([
      [126.9, 37.5],
      [126.901, 37.501],
      [126.902, 37.502],
    ]));

    expect(result?.lastInputOccurredAt).toBe('2026-07-21T00:01:00.000Z');
    expect(result?.lastMatchedPosition).toEqual({
      latitude: 37.501,
      longitude: 126.901,
      occurredAt: '2026-07-21T00:00:30.000Z',
    });
  });

  test('ignores an out-of-coverage GPS outlier instead of discarding the Korea path', async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      code: 'Ok',
      matchings: [{
        confidence: 0.9,
        geometry: {
          coordinates: [[126.9, 37.5], [126.901, 37.501]],
          type: 'LineString',
        },
      }],
      tracepoints: [{}, {}],
    }))));
    const provider = new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { korea: 'https://osrm-korea.example', ontario: 'https://osrm-ontario.example' },
      fetch,
    });

    const result = await provider.match(document([
      [126.9, 37.5],
      [126.901, 37.501],
      [-79.4, 43.65],
    ]));

    expect(result?.coverage).toBe('korea');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String((fetch.mock.calls as unknown as Array<[string]>)[0]![0])).not.toContain('-79.4');
  });

  test('does not refresh from cache when the watermark already covers the latest input', () => {
    const record = trackingRecord({
      roadMatchedLastInputOccurredAt: new Date('2026-07-21T00:02:00.000Z'),
      roadMatchedSchemaVersion: 'route_tracking_road_match.v1',
      roadMatchedSourcePointCount: 3,
      roadMatchedWatermark: 'route_tracking_road_match.v1:korea:3:2:2026-07-21T00:02:00.000Z:abc',
      sourcePointCount: 3,
    });

    expect(shouldRefreshRouteTrackingRoadMatchedPath(record)).toBe(false);
    expect(shouldRefreshRouteTrackingRoadMatchedPath(trackingRecord({
      roadMatchedLastInputOccurredAt: new Date('2026-07-21T00:01:00.000Z'),
      roadMatchedSchemaVersion: 'route_tracking_road_match.v1',
      roadMatchedSourcePointCount: 2,
      roadMatchedWatermark: 'route_tracking_road_match.v1:korea:2:2:2026-07-21T00:01:00.000Z:abc',
      sourcePointCount: 3,
    }))).toBe(true);
  });

  test('serializes cached road-matched geometry into the snapshot contract', () => {
    const path = buildRouteTrackingRoadMatchedPath(trackingRecord({
      roadMatchedCoverage: 'korea',
      roadMatchedGeometry: { coordinates: [[[126.9, 37.5], [126.91, 37.51]]], type: 'MultiLineString' },
      roadMatchedLastInputOccurredAt: new Date('2026-07-21T00:01:00.000Z'),
      roadMatchedLastPosition: { latitude: 37.51, longitude: 126.91, occurredAt: '2026-07-21T00:01:00.000Z' },
      roadMatchedPointCount: 2,
      roadMatchedSchemaVersion: 'route_tracking_road_match.v1',
      roadMatchedSourcePointCount: 3,
      roadMatchedUncertainGeometry: null,
      roadMatchedWatermark: 'route_tracking_road_match.v1:korea:3:2:2026-07-21T00:01:00.000Z:abc',
    }));

    expect(path).toEqual({
      coverage: 'korea',
      inputPointCount: 3,
      lastInputOccurredAt: '2026-07-21T00:01:00.000Z',
      lastMatchedPosition: { latitude: 37.51, longitude: 126.91, occurredAt: '2026-07-21T00:01:00.000Z' },
      matchedGeometry: { coordinates: [[[126.9, 37.5], [126.91, 37.51]]], type: 'MultiLineString' },
      matchedPointCount: 2,
      schemaVersion: 'route_tracking_road_match.v1',
      uncertainGeometry: null,
      watermark: 'route_tracking_road_match.v1:korea:3:2:2026-07-21T00:01:00.000Z:abc',
    });
  });
});

function document(
  coordinates: Array<[number, number]>,
  options: { gapBeforeIndex?: number } = {},
): RouteTrackingGeometryDocumentV1 {
  return {
    coordinates,
    samples: coordinates.map((_, index) => ({
      driverId: 'driver-1',
      eventId: `event-${index}`,
      occurredAt: new Date(Date.parse('2026-07-21T00:00:00.000Z') + (
        options.gapBeforeIndex !== undefined && index >= options.gapBeforeIndex
          ? 600_000 + index * 30_000
          : index * 30_000
      )).toISOString(),
      receivedAt: new Date(Date.parse('2026-07-21T00:00:01.000Z') + index * 30_000).toISOString(),
    })),
    sourcePointCount: coordinates.length,
  };
}

function trackingRecord(overrides: Partial<RouteTrackingGeometryRecord> = {}): RouteTrackingGeometryRecord {
  return {
    firstOccurredAt: new Date('2026-07-21T00:00:00.000Z'),
    geometry: { coordinates: [[126.9, 37.5], [126.91, 37.51], [126.92, 37.52]], type: 'LineString' },
    geometryPointCount: 3,
    lastDriverId: 'driver-1',
    lastEventId: 'event-2',
    lastLatitude: 37.52,
    lastLongitude: 126.92,
    lastOccurredAt: new Date('2026-07-21T00:02:00.000Z'),
    lastReceivedAt: new Date('2026-07-21T00:02:01.000Z'),
    routePlanId: 'route-1',
    sampleMetadata: [
      { driverId: 'driver-1', eventId: 'event-0', occurredAt: '2026-07-21T00:00:00.000Z', receivedAt: '2026-07-21T00:00:01.000Z' },
      { driverId: 'driver-1', eventId: 'event-1', occurredAt: '2026-07-21T00:01:00.000Z', receivedAt: '2026-07-21T00:01:01.000Z' },
      { driverId: 'driver-1', eventId: 'event-2', occurredAt: '2026-07-21T00:02:00.000Z', receivedAt: '2026-07-21T00:02:01.000Z' },
    ],
    sourcePointCount: 3,
    ...overrides,
  };
}
