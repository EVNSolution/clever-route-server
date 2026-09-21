import { describe, expect, test, vi } from 'vitest';

import {
  OsrmRouteTrackingRoadMatchProvider,
  buildRouteTrackingRoadMatchCacheWrite,
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
      baseUrls: { korea: 'http://osrm-korea:5000', ontario: 'http://osrm-ontario:5000' },
      fetch,
    });

    const result = await provider.match(document([
      [126.9000, 37.5000],
      [126.9010, 37.5004],
      [126.9020, 37.5008],
    ]));

    expect(fetch).toHaveBeenCalledTimes(1);
    const [requestedUrlValue, requestInit] = (fetch.mock.calls as unknown as Array<[
      string,
      { method: 'GET'; redirect: 'error'; signal?: AbortSignal },
    ]>)[0]!;
    const requestedUrl = String(requestedUrlValue);
    expect(requestInit.redirect).toBe('error');
    expect(requestedUrl).toContain('http://osrm-korea:5000/match/v1/driving/');
    expect(requestedUrl).toContain('overview=full');
    expect(requestedUrl).toContain('geometries=geojson');
    expect(requestedUrl).toContain('gaps=split');
    expect(requestedUrl).toContain('tidy=true');
    expect(requestedUrl).toContain('timestamps=1784592000%3B1784592030%3B1784592060');
    expect(requestedUrl).not.toContain('radiuses=');
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

  test('applies an explicit GPS precision only for callers that configure one', async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      code: 'Ok',
      matchings: [{
        confidence: 0.9,
        geometry: { coordinates: [[126.9, 37.5], [126.901, 37.501]], type: 'LineString' },
      }],
      tracepoints: [{}, {}],
    }))));
    const provider = new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { korea: 'http://osrm-korea:5000' },
      fetch,
      gpsPrecisionMeters: 75,
    });

    await provider.match(document([[126.9, 37.5], [126.901, 37.501]]));

    const requestedUrl = String((fetch.mock.calls as unknown as Array<[string]>)[0]![0]);
    expect(requestedUrl).toContain('radiuses=75%3B75');
  });

  test('uses per-sample GPS accuracy as OSRM radiuses with a bounded fallback', async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      code: 'Ok',
      matchings: [{
        confidence: 0.9,
        geometry: { coordinates: [[126.9, 37.5], [126.901, 37.501], [126.902, 37.502]], type: 'LineString' },
      }],
      tracepoints: [{}, {}, {}],
    }))));
    const provider = new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { korea: 'http://osrm-korea:5000' },
      fetch,
      gpsPrecisionMeters: 40,
    });
    const input = document([[126.9, 37.5], [126.901, 37.501], [126.902, 37.502]]);
    input.samples[0]!.accuracyMeters = 8.4;
    input.samples[1]!.accuracyMeters = 25;
    input.samples[2]!.accuracyMeters = null;

    await provider.match(input);

    const requestedUrl = String((fetch.mock.calls as unknown as Array<[string]>)[0]![0]);
    expect(requestedUrl).toContain('radiuses=8.4%3B25%3B40');
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
      baseUrls: { korea: 'http://osrm-korea:5000' },
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

  test('allows UVIS callers to use smaller overlapping match chunks without changing the default', async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      code: 'Ok',
      matchings: [{
        confidence: 0.8,
        geometry: { coordinates: [[126.9, 37.5], [126.91, 37.51]], type: 'LineString' },
      }],
      tracepoints: [{}, {}],
    }))));
    const provider = new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { korea: 'http://osrm-korea:5000' },
      fetch,
      maxMatchPoints: 16,
    });
    const coordinates = Array.from({ length: 65 }, (_, index) => [126.9 + index * 0.0001, 37.5] as [number, number]);

    await provider.match(document(coordinates));

    const requestPointCounts = (fetch.mock.calls as unknown as Array<[string]>)
      .map((call) => decodeURIComponent(String(call[0])).split('/driving/')[1]!.split('?')[0]!.split(';').length);
    expect(requestPointCounts).toEqual([16, 16, 16, 16, 5]);
  });

  test('keeps caller-provided match chunk sizes inside OSRM trace limits', async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      code: 'Ok',
      matchings: [{
        confidence: 0.8,
        geometry: { coordinates: [[126.9, 37.5], [126.91, 37.51]], type: 'LineString' },
      }],
      tracepoints: [{}, {}],
    }))));
    const provider = new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { korea: 'http://osrm-korea:5000' },
      fetch,
      maxMatchPoints: 500,
    });
    const coordinates = Array.from({ length: 101 }, (_, index) => [126.9 + index * 0.0001, 37.5] as [number, number]);

    await provider.match(document(coordinates));

    const requestPointCounts = (fetch.mock.calls as unknown as Array<[string]>)
      .map((call) => decodeURIComponent(String(call[0])).split('/driving/')[1]!.split('?')[0]!.split(';').length);
    expect(requestPointCounts).toEqual([100, 2]);
  });

  test('splits implausible GPS jumps before asking OSRM to match the path', async () => {
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
      baseUrls: { korea: 'http://osrm-korea:5000' },
      fetch,
    });

    await provider.match(document([
      [126.9, 37.5],
      [126.901, 37.501],
      [127.1, 37.7],
      [127.101, 37.701],
    ], { intervalMs: 10_000 }));

    expect(fetch).toHaveBeenCalledTimes(2);
    const requestPointCounts = (fetch.mock.calls as unknown as Array<[string]>)
      .map((call) => decodeURIComponent(String(call[0])).split('/driving/')[1]!.split('?')[0]!.split(';').length);
    expect(requestPointCounts).toEqual([2, 2]);
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
      baseUrls: { ontario: 'http://osrm-ontario:5000' },
      fetch,
    });

    const result = await provider.match(document([[-79.4, 43.65], [-79.41, 43.66]]));

    expect(result?.matchedGeometry).toBeNull();
    expect(result?.uncertainGeometry?.coordinates).toEqual([[[-79.4, 43.65], [-79.41, 43.66]]]);
  });

  test('classifies OSRM transport failures as retryable without changing match null behavior', async () => {
    const fetch = vi.fn(() => Promise.reject(new Error('OSRM unavailable')));
    const provider = new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { korea: 'http://osrm-korea:5000' },
      fetch,
    });

    await expect(provider.match(document([[126.9, 37.5], [126.901, 37.501]]))).resolves.toBeNull();
    await expect(provider.matchWithStatus(document([[126.9, 37.5], [126.901, 37.501]]))).resolves.toEqual({
      path: null,
      retryable: true,
    });
  });

  test('classifies completed OSRM NoMatch responses as non-retryable', async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ code: 'NoMatch' }))));
    const provider = new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { korea: 'http://osrm-korea:5000' },
      fetch,
    });

    await expect(provider.matchWithStatus(document([[126.9, 37.5], [126.901, 37.501]]))).resolves.toEqual({
      path: null,
      retryable: false,
    });
  });

  test('preserves retryable status when one OSRM chunk succeeds and a later chunk fails', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 'Ok',
        matchings: [{
          confidence: 0.9,
          geometry: { coordinates: [[126.9, 37.5], [126.901, 37.501]], type: 'LineString' },
        }],
        tracepoints: [{}, {}],
      })))
      .mockRejectedValueOnce(new Error('OSRM unavailable'));
    const provider = new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { korea: 'http://osrm-korea:5000' },
      fetch,
    });

    const outcome = await provider.matchWithStatus(document([
      [126.9, 37.5],
      [126.901, 37.501],
      [126.902, 37.502],
      [126.903, 37.503],
    ], { gapBeforeIndex: 2 }));

    expect(outcome.retryable).toBe(true);
    expect(outcome.path?.matchedGeometry?.coordinates).toEqual([[[126.9, 37.5], [126.901, 37.501]]]);
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
      baseUrls: { korea: 'http://osrm-korea:5000' },
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
    expect(result?.matchedRanges).toEqual([expect.objectContaining({
      startEventId: 'event-0',
      endEventId: 'event-1',
      startSourceIndex: 0,
      endSourceIndex: 1,
    })]);
    expect(result?.unmatchedRanges).toEqual([expect.objectContaining({
      startEventId: 'event-2',
      endEventId: 'event-2',
      reason: 'NO_MATCH',
    })]);
  });

  test('keeps a confident matching when one internal tracepoint is an OSRM outlier', async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      code: 'Ok',
      matchings: [{
        confidence: 0.91,
        geometry: {
          coordinates: [[-79.4, 43.65], [-79.401, 43.651], [-79.403, 43.653]],
          type: 'LineString',
        },
      }],
      tracepoints: [
        { location: [-79.4, 43.65], matchings_index: 0, waypoint_index: 0 },
        { location: [-79.401, 43.651], matchings_index: 0, waypoint_index: 1 },
        null,
        { location: [-79.403, 43.653], matchings_index: 0, waypoint_index: 2 },
      ],
    }))));
    const provider = new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { ontario: 'http://osrm-ontario:5000' },
      fetch,
    });

    const result = await provider.match(document([
      [-79.4, 43.65], [-79.401, 43.651], [-79.402, 43.652], [-79.403, 43.653]
    ]));

    expect(result?.matchedGeometry?.coordinates).toHaveLength(1);
    expect(result?.matchedRanges).toEqual([expect.objectContaining({
      startSourceIndex: 0,
      endSourceIndex: 3,
    })]);
    expect(result?.unmatchedRanges).toEqual([]);
  });

  test('never lets a matched source range cross an actual acquisition gap', async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      code: 'Ok',
      matchings: [{
        confidence: 0.9,
        geometry: { coordinates: [[-79.4, 43.65], [-79.401, 43.651]], type: 'LineString' },
      }],
      tracepoints: [{}, {}],
    }))));
    const provider = new OsrmRouteTrackingRoadMatchProvider({ baseUrls: { ontario: 'http://osrm-ontario:5000' }, fetch });

    const result = await provider.match(document([
      [-79.4, 43.65], [-79.401, 43.651], [-79.402, 43.652], [-79.403, 43.653]
    ], { gapBeforeIndex: 2 }));

    expect(result?.matchedRanges).toEqual([
      expect.objectContaining({ startSourceIndex: 0, endSourceIndex: 1 }),
      expect.objectContaining({ startSourceIndex: 2, endSourceIndex: 3 }),
    ]);
  });

  test('excludes low-accuracy samples from confident road matching and reports their raw range', async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      code: 'Ok',
      matchings: [{
        confidence: 0.9,
        geometry: { coordinates: [[-79.4, 43.65], [-79.401, 43.651]], type: 'LineString' },
      }],
      tracepoints: [
        { location: [-79.4, 43.65], matchings_index: 0, waypoint_index: 0 },
        { location: [-79.401, 43.651], matchings_index: 0, waypoint_index: 1 },
      ],
    }))));
    const provider = new OsrmRouteTrackingRoadMatchProvider({ baseUrls: { ontario: 'http://osrm-ontario:5000' }, fetch });
    const input = document([
      [-79.4, 43.65], [-79.401, 43.651], [-79.8, 43.9], [-79.402, 43.652], [-79.403, 43.653]
    ]);
    input.samples[2]!.accuracyMeters = 292.87;

    const result = await provider.match(input);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String((fetch.mock.calls as unknown as Array<[string]>)[0]![0])).not.toContain('-79.8');
    expect(result?.unmatchedRanges).toEqual([expect.objectContaining({
      startEventId: 'event-2',
      endEventId: 'event-2',
      reason: 'LOW_ACCURACY',
    })]);
  });

  test('supplements a short low-accuracy span with a conservative OSRM road route', async () => {
    const input = supplementInput();
    const fetch = supplementFetch(routeResponse());
    const provider = new OsrmRouteTrackingRoadMatchProvider({ baseUrls: { ontario: 'http://osrm-ontario:5000' }, fetch });

    const result = await provider.match(input);

    const routeUrl = (fetch.mock.calls as unknown as Array<[string]>).map(([url]) => String(url))
      .find((url) => url.includes('/route/v1/driving/'));
    expect(routeUrl).toContain('alternatives=true');
    expect(routeUrl).toContain('overview=full');
    expect(routeUrl).toContain('geometries=geojson');
    expect(routeUrl).toContain('radiuses=50%3B50');
    expect(result?.inferredGeometry?.coordinates).toEqual([supplementRouteCoordinates()]);
    expect(result?.inferredRanges).toEqual([expect.objectContaining({
      startEventId: 'event-1',
      endEventId: 'event-3',
      startSourceIndex: 1,
      endSourceIndex: 3,
      reason: 'LOW_ACCURACY',
    })]);
    expect(result?.unmatchedRanges).toEqual([expect.objectContaining({
      startEventId: 'event-2',
      endEventId: 'event-2',
      reason: 'LOW_ACCURACY',
    })]);
    expect(result?.qualityVersion).toBe('gps_quality.v3');
  });

  test.each([
    ['true acquisition gap', (input: RouteTrackingGeometryDocumentV1) => { input.samples[2]!.gapBefore = true; }],
    ['long elapsed span', (input: RouteTrackingGeometryDocumentV1) => {
      input.samples[3]!.occurredAt = '2026-07-21T00:03:01.000Z';
      input.samples[4]!.occurredAt = '2026-07-21T00:03:31.000Z';
    }],
  ])('does not supplement a LOW_ACCURACY span across a %s', async (_label, mutate) => {
    const input = supplementInput();
    mutate(input);
    const fetch = supplementFetch(routeResponse());
    const provider = new OsrmRouteTrackingRoadMatchProvider({ baseUrls: { ontario: 'http://osrm-ontario:5000' }, fetch });

    const result = await provider.match(input);

    expect((fetch.mock.calls as unknown as Array<[string]>).some(([url]) => String(url).includes('/route/v1/driving/'))).toBe(false);
    expect(result?.inferredGeometry).toBeNull();
    expect(result?.inferredRanges).toEqual([]);
  });

  test('does not supplement when either retained anchor has poor or unknown accuracy', async () => {
    const input = supplementInput();
    input.samples[1]!.accuracyMeters = 51;
    const fetch = supplementFetch(routeResponse());
    const provider = new OsrmRouteTrackingRoadMatchProvider({ baseUrls: { ontario: 'http://osrm-ontario:5000' }, fetch });

    const result = await provider.match(input);

    expect((fetch.mock.calls as unknown as Array<[string]>).some(([url]) => String(url).includes('/route/v1/driving/'))).toBe(false);
    expect(result?.inferredGeometry).toBeNull();
  });

  test('does not widen a LOW_ACCURACY supplement across an adjacent good-accuracy NO_MATCH sample', async () => {
    const input = document([
      [-79.4000, 43.6500], [-79.3997, 43.6500], [-79.3994, 43.6501],
      [-79.3991, 43.6501], [-79.3988, 43.6500], [-79.3985, 43.6500],
    ]);
    input.samples.forEach((sample, index) => {
      sample.accuracyMeters = index === 2 ? 250 : 20;
      sample.gapBefore = false;
      sample.sourceIndex = index;
    });
    let matchCall = 0;
    const fetch = vi.fn((url: string) => {
      if (url.includes('/route/v1/driving/')) return Promise.resolve(new Response(JSON.stringify(routeResponse())));
      const payload = matchCall++ === 0
        ? {
            code: 'Ok',
            matchings: [{ confidence: 0.9, geometry: { coordinates: input.coordinates.slice(0, 2), type: 'LineString' } }],
            tracepoints: [{}, {}],
          }
        : {
            code: 'Ok',
            matchings: [{ confidence: 0.9, geometry: { coordinates: input.coordinates.slice(4, 6), type: 'LineString' } }],
            tracepoints: [null, { location: input.coordinates[4], matchings_index: 0 }, { location: input.coordinates[5], matchings_index: 0 }],
          };
      return Promise.resolve(new Response(JSON.stringify(payload)));
    });
    const provider = new OsrmRouteTrackingRoadMatchProvider({ baseUrls: { ontario: 'http://osrm-ontario:5000' }, fetch });

    const result = await provider.match(input);

    expect(result?.unmatchedRanges).toEqual([
      expect.objectContaining({ startEventId: 'event-2', endEventId: 'event-2', reason: 'LOW_ACCURACY' }),
      expect.objectContaining({ startEventId: 'event-3', endEventId: 'event-3', reason: 'NO_MATCH' }),
    ]);
    expect(result?.inferredGeometry).toBeNull();
    expect((fetch.mock.calls as unknown as Array<[string]>).some(([url]) => String(url).includes('/route/v1/driving/'))).toBe(false);
  });

  test.each([
    ['implausible speed', routeResponse({ distance: 150, duration: 3 })],
    ['excessive detour', routeResponse({ distance: 1_000, duration: 60 })],
    ['ambiguous alternatives', routeResponse({ ambiguous: true })],
  ])('rejects a %s road supplement', async (_label, routePayload) => {
    const fetch = supplementFetch(routePayload);
    const provider = new OsrmRouteTrackingRoadMatchProvider({ baseUrls: { ontario: 'http://osrm-ontario:5000' }, fetch });

    const result = await provider.match(supplementInput());

    expect((fetch.mock.calls as unknown as Array<[string]>).some(([url]) => String(url).includes('/route/v1/driving/'))).toBe(true);
    expect(result?.inferredGeometry).toBeNull();
    expect(result?.inferredRanges).toEqual([]);
  });

  test('rejects a road detour that exceeds the observed-gap speed despite plausible OSRM travel speed', async () => {
    const input = supplementInput();
    input.samples[0]!.occurredAt = '2026-07-21T00:00:00.000Z';
    input.samples[1]!.occurredAt = '2026-07-21T00:00:02.500Z';
    input.samples[2]!.occurredAt = '2026-07-21T00:00:03.500Z';
    input.samples[3]!.occurredAt = '2026-07-21T00:00:05.000Z';
    input.samples[4]!.occurredAt = '2026-07-21T00:00:07.500Z';
    const fetch = supplementFetch(routeResponse({ distance: 150, duration: 5 }));
    const provider = new OsrmRouteTrackingRoadMatchProvider({ baseUrls: { ontario: 'http://osrm-ontario:5000' }, fetch });

    const result = await provider.match(input);

    expect((fetch.mock.calls as unknown as Array<[string]>).some(([url]) => String(url).includes('/route/v1/driving/'))).toBe(true);
    expect(result?.inferredGeometry).toBeNull();
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
      baseUrls: { korea: 'http://osrm-korea:5000', ontario: 'http://osrm-ontario:5000' },
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
      roadMatchedSchemaVersion: 'route_tracking_road_match.v3',
      roadMatchedSourcePointCount: 3,
      roadMatchedWatermark: 'route_tracking_road_match.v1:korea:3:2:2026-07-21T00:02:00.000Z:abc',
      sourcePointCount: 3,
    });

    expect(shouldRefreshRouteTrackingRoadMatchedPath(record)).toBe(false);
    expect(shouldRefreshRouteTrackingRoadMatchedPath(trackingRecord({
      roadMatchedLastInputOccurredAt: new Date('2026-07-21T00:01:00.000Z'),
      roadMatchedSchemaVersion: 'route_tracking_road_match.v3',
      roadMatchedSourcePointCount: 2,
      roadMatchedWatermark: 'route_tracking_road_match.v1:korea:2:2:2026-07-21T00:01:00.000Z:abc',
      sourcePointCount: 3,
    }))).toBe(true);
  });

  test('serializes cached road-matched geometry into the snapshot contract', () => {
    const path = buildRouteTrackingRoadMatchedPath(trackingRecord({
      roadMatchedCoverage: 'korea',
      roadMatchedGeometry: {
        anchors: [
          { observedAt: '2026-07-21T00:01:00.000Z', lineIndex: 0, coordinateIndex: 1 },
          { observedAt: '2026-07-21T00:00:00.000Z', lineIndex: 0, coordinateIndex: 0 },
        ],
        coordinates: [[[126.9, 37.5], [126.91, 37.51]]],
        inferredGeometry: {
          coordinates: [[[126.905, 37.505], [126.906, 37.506]]],
          sourceRanges: [{
            startEventId: 'event-0', startOccurredAt: '2026-07-21T00:00:00.000Z', startSourceIndex: 0,
            endEventId: 'event-1', endOccurredAt: '2026-07-21T00:01:00.000Z', endSourceIndex: 1,
            reason: 'LOW_ACCURACY',
          }],
          type: 'MultiLineString',
        },
        inferredRanges: [{
          startEventId: 'event-0', startOccurredAt: '2026-07-21T00:00:00.000Z', startSourceIndex: 0,
          endEventId: 'event-1', endOccurredAt: '2026-07-21T00:01:00.000Z', endSourceIndex: 1,
          reason: 'LOW_ACCURACY',
        }],
        type: 'MultiLineString',
      },
      roadMatchedLastInputOccurredAt: new Date('2026-07-21T00:01:00.000Z'),
      roadMatchedLastPosition: { latitude: 37.51, longitude: 126.91, occurredAt: '2026-07-21T00:01:00.000Z' },
      roadMatchedPointCount: 2,
      roadMatchedSchemaVersion: 'route_tracking_road_match.v3',
      roadMatchedSourcePointCount: 3,
      roadMatchedUncertainGeometry: null,
      roadMatchedWatermark: 'route_tracking_road_match.v1:korea:3:2:2026-07-21T00:01:00.000Z:abc',
    }));

    expect(path).toEqual({
      coverage: 'korea',
      inputPointCount: 3,
      inferredGeometry: {
        coordinates: [[[126.905, 37.505], [126.906, 37.506]]],
        sourceRanges: [{
          startEventId: 'event-0', startOccurredAt: '2026-07-21T00:00:00.000Z', startSourceIndex: 0,
          endEventId: 'event-1', endOccurredAt: '2026-07-21T00:01:00.000Z', endSourceIndex: 1,
          reason: 'LOW_ACCURACY',
        }],
        type: 'MultiLineString',
      },
      inferredRanges: [{
        startEventId: 'event-0', startOccurredAt: '2026-07-21T00:00:00.000Z', startSourceIndex: 0,
        endEventId: 'event-1', endOccurredAt: '2026-07-21T00:01:00.000Z', endSourceIndex: 1,
        reason: 'LOW_ACCURACY',
      }],
      lastInputOccurredAt: '2026-07-21T00:01:00.000Z',
      lastMatchedPosition: { latitude: 37.51, longitude: 126.91, occurredAt: '2026-07-21T00:01:00.000Z' },
      matchedGeometry: {
        anchors: [
          { observedAt: '2026-07-21T00:00:00.000Z', lineIndex: 0, coordinateIndex: 0 },
          { observedAt: '2026-07-21T00:01:00.000Z', lineIndex: 0, coordinateIndex: 1 },
        ],
        coordinates: [[[126.9, 37.5], [126.91, 37.51]]],
        type: 'MultiLineString',
      },
      matchedRanges: [],
      matchedPointCount: 2,
      qualityVersion: 'gps_quality.v3',
      schemaVersion: 'route_tracking_road_match.v1',
      uncertainGeometry: null,
      uncertainRanges: [],
      unmatchedRanges: [],
      watermark: 'route_tracking_road_match.v1:korea:3:2:2026-07-21T00:01:00.000Z:abc',
    });
  });

  test('round-trips inferred road supplements through the existing cache JSON columns', async () => {
    const provider = new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { ontario: 'http://osrm-ontario:5000' },
      fetch: supplementFetch(routeResponse()),
    });
    const path = await provider.match(supplementInput());
    expect(path).not.toBeNull();
    const write = buildRouteTrackingRoadMatchCacheWrite(path!);

    const restored = buildRouteTrackingRoadMatchedPath(trackingRecord(write));

    expect(write.roadMatchedSchemaVersion).toBe('route_tracking_road_match.v3');
    expect(restored?.qualityVersion).toBe('gps_quality.v3');
    expect(restored?.inferredGeometry?.coordinates).toEqual([supplementRouteCoordinates()]);
    expect(restored?.inferredRanges).toEqual([expect.objectContaining({
      startEventId: 'event-1', endEventId: 'event-3', reason: 'LOW_ACCURACY',
    })]);
  });
});

function document(
  coordinates: Array<[number, number]>,
  options: { gapBeforeIndex?: number; intervalMs?: number } = {},
): RouteTrackingGeometryDocumentV1 {
  const intervalMs = options.intervalMs ?? 30_000;
  return {
    coordinates,
    samples: coordinates.map((_, index) => ({
      driverId: 'driver-1',
      eventId: `event-${index}`,
      occurredAt: new Date(Date.parse('2026-07-21T00:00:00.000Z') + (
        options.gapBeforeIndex !== undefined && index >= options.gapBeforeIndex
          ? 600_000 + index * intervalMs
          : index * intervalMs
      )).toISOString(),
      receivedAt: new Date(Date.parse('2026-07-21T00:00:01.000Z') + index * intervalMs).toISOString(),
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

function supplementInput(): RouteTrackingGeometryDocumentV1 {
  const input = document([
    [-79.4000, 43.6500],
    [-79.3995, 43.6500],
    [-79.3990, 43.6501],
    [-79.3985, 43.6500],
    [-79.3980, 43.6500],
  ]);
  input.samples.forEach((sample, index) => {
    sample.accuracyMeters = index === 2 ? 220 : 20;
    sample.gapBefore = false;
    sample.sourceIndex = index;
  });
  return input;
}

function supplementRouteCoordinates(): Array<[number, number]> {
  return [
    [-79.3995, 43.6500],
    [-79.3990, 43.6502],
    [-79.3985, 43.6500],
  ];
}

function supplementFetch(routePayload: unknown) {
  let matchCall = 0;
  return vi.fn((url: string) => {
    if (url.includes('/route/v1/driving/')) {
      return Promise.resolve(new Response(JSON.stringify(routePayload)));
    }
    const coordinates: Array<[number, number]> = matchCall === 0
      ? [[-79.4000, 43.6500], [-79.3995, 43.6500]]
      : [[-79.3985, 43.6500], [-79.3980, 43.6500]];
    matchCall += 1;
    return Promise.resolve(new Response(JSON.stringify({
      code: 'Ok',
      matchings: [{ confidence: 0.9, geometry: { coordinates, type: 'LineString' } }],
      tracepoints: [{}, {}],
    })));
  });
}

function routeResponse(options: { ambiguous?: boolean; distance?: number; duration?: number } = {}) {
  const distance = options.distance ?? 100;
  const duration = options.duration ?? 60;
  return {
    code: 'Ok',
    routes: [
      { distance, duration, geometry: { coordinates: supplementRouteCoordinates(), type: 'LineString' } },
      ...(options.ambiguous ? [{
        distance: distance * 1.1,
        duration: duration * 1.08,
        geometry: {
          coordinates: [
            [-79.3995, 43.6500],
            [-79.3991, 43.6498],
            [-79.3985, 43.6500],
          ],
          type: 'LineString',
        },
      }] : []),
    ],
    waypoints: [
      { location: [-79.3995, 43.6500] },
      { location: [-79.3985, 43.6500] },
    ],
  };
}
