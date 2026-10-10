import { describe, expect, test, vi } from 'vitest';

import {
  OsrmRouteTrackingRoadMatchProvider,
  buildRouteTrackingRoadMatchCacheWrite,
  buildRouteTrackingRoadMatchedPath,
} from '../src/modules/route-tracking/route-tracking.road-match.js';
import type {
  RouteTrackingGeometryDocumentV1,
  RouteTrackingGeometryPositionInput,
  RouteTrackingGeometryRecord,
} from '../src/modules/route-tracking/route-tracking.geometry.js';

describe('route tracking road matching', () => {
  test('matches GPS samples against OSRM without closing the path or exposing point markers', async () => {
    const coordinates: Array<[number, number]> = [
      [126.9000, 37.5000], [126.9010, 37.5004], [126.9020, 37.5008],
    ];
    const fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify(osrmMatchResponse(coordinates, {
      confidence: 0.92,
      geometry: [...coordinates, coordinates[0]!],
    })))));
    const provider = new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { korea: 'http://osrm-korea:5000', ontario: 'http://osrm-ontario:5000' },
      fetch,
    });

    const result = await provider.match(document(coordinates));

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
    expect(requestedUrl).toContain('tidy=false');
    expect(requestedUrl).toContain('timestamps=1784592000%3B1784592030%3B1784592060');
    expect(requestedUrl).toContain('radiuses=25%3B25%3B25');
    expect(requestedUrl).toContain('steps=true');
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
    const input = document([[126.9, 37.5], [126.901, 37.501]]);
    input.samples.forEach((sample) => { delete sample.accuracyMeters; });

    await provider.match(input);

    const requestedUrl = String((fetch.mock.calls as unknown as Array<[string]>)[0]![0]);
    expect(requestedUrl).toContain('radiuses=75%3B75');
  });

  test('preserves legacy whole-match geometry only for an explicit no-accuracy consumer', async () => {
    const input = document([[126.9, 37.5], [126.901, 37.501]]);
    input.samples.forEach((sample) => { delete sample.accuracyMeters; });
    const payload = osrmMatchResponse(input.coordinates, { confidence: 0.9 });
    const defaultFetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify(payload))));
    const legacyFetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify(payload))));

    const defaultResult = await new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { korea: 'http://osrm-korea:5000' },
      fetch: defaultFetch,
      gpsPrecisionMeters: 75,
    }).match(input);
    const legacyResult = await new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { korea: 'http://osrm-korea:5000' },
      classificationMode: 'legacy-whole-match',
      fetch: legacyFetch,
      gpsPrecisionMeters: 75,
    }).match(input);

    expect(defaultResult?.matchedGeometry).toBeNull();
    expect(defaultResult?.inferredRanges).toEqual([expect.objectContaining({ interpolationLevel: 1 })]);
    expect(legacyResult?.matchedGeometry?.coordinates).toEqual([input.coordinates]);
    expect(legacyResult?.matchedRanges).toEqual([expect.objectContaining({ interpolationLevel: 0 })]);
    expect(legacyResult?.qualityVersion).toBe('gps_quality.v3');
    const legacyUrl = String((legacyFetch.mock.calls as unknown as Array<[string]>)[0]![0]);
    expect(legacyUrl).toContain('radiuses=75%3B75');
    expect(legacyUrl).toContain('tidy=true');
  });

  test('can infer only tightly corroborated short legs when GPS accuracy was not recorded', async () => {
    const coordinates: Array<[number, number]> = [
      [126.9, 37.5], [126.9001, 37.5], [126.9002, 37.5],
    ];
    const input = document(coordinates);
    input.samples.forEach((sample) => { sample.accuracyMeters = null; });
    const provider = new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { korea: 'http://osrm-korea:5000' },
      allowUnmeasuredAccuracyInference: true,
      fetch: vi.fn(() => Promise.resolve(new Response(JSON.stringify(osrmMatchResponse(coordinates, { confidence: 0.98 }))))),
    });

    const result = await provider.match(input);

    expect(result?.matchedGeometry).toBeNull();
    expect(result?.inferredGeometry?.coordinates).toHaveLength(1);
    expect(result?.inferredRanges).toEqual([expect.objectContaining({ interpolationLevel: 1 })]);
  });

  test('accepts missing-accuracy legs as level 1 without the opt-in, even over a long sampling interval', async () => {
    const coordinates: Array<[number, number]> = [
      [126.9, 37.5], [126.9001, 37.5], [126.9002, 37.5],
    ];
    const input = document(coordinates, { intervalMs: 45_000 });
    input.samples.forEach((sample) => { sample.accuracyMeters = null; });
    const result = await new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { korea: 'http://osrm-korea:5000' },
      fetch: vi.fn(() => Promise.resolve(new Response(JSON.stringify(osrmMatchResponse(coordinates, { confidence: 0.98 }))))),
    }).match(input);

    expect(result?.matchedGeometry).toBeNull();
    expect(result?.inferredGeometry?.coordinates).toHaveLength(1);
    expect(result?.inferredRanges).toEqual([expect.objectContaining({ interpolationLevel: 1, startSourceIndex: 0, endSourceIndex: 2 })]);
  });

  test('accepts missing-accuracy legs regardless of confidence or alternatives, but not an implausible snap', async () => {
    const coordinates: Array<[number, number]> = [
      [126.9, 37.5], [126.9001, 37.5], [126.9002, 37.5],
    ];
    const input = document(coordinates);
    input.samples.forEach((sample) => { sample.accuracyMeters = null; });
    const confident = osrmMatchResponse(coordinates, { confidence: 0.98 });
    const ambiguous = structuredClone(confident);
    ambiguous.tracepoints[1]!.alternatives_count = 1;
    const lowConfidence = osrmMatchResponse(coordinates, { confidence: 0.3 });
    const invalidConfidence = osrmMatchResponse(coordinates, { confidence: 1.01 });

    for (const response of [ambiguous, lowConfidence, invalidConfidence]) {
      const result = await new OsrmRouteTrackingRoadMatchProvider({
        baseUrls: { korea: 'http://osrm-korea:5000' },
        fetch: vi.fn(() => Promise.resolve(new Response(JSON.stringify(response)))),
      }).match(input);

      expect(result?.matchedGeometry).toBeNull();
      expect(result?.inferredGeometry?.coordinates).toHaveLength(1);
    }

    // About 220 m between the fix and its snapped location: three times the assumed 25 m plus 10 m is exceeded.
    const displaced = structuredClone(confident);
    displaced.tracepoints[1]!.location = [126.9001, 37.502];
    const rejected = await new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { korea: 'http://osrm-korea:5000' },
      fetch: vi.fn(() => Promise.resolve(new Response(JSON.stringify(displaced)))),
    }).match(input);

    expect(rejected?.inferredGeometry).toBeNull();
    expect(rejected?.uncertainRanges).toEqual([expect.objectContaining({ interpolationLevel: 2, startSourceIndex: 0, endSourceIndex: 2 })]);
  });

  test('keeps the legacy whole-match input accuracy cap at 100 meters', async () => {
    const input = document([[126.9, 37.5], [126.901, 37.501]]);
    input.samples.forEach((sample) => { sample.accuracyMeters = 100.01; });
    const fetch = vi.fn();

    const result = await new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { korea: 'http://osrm-korea:5000' },
      classificationMode: 'legacy-whole-match',
      fetch,
      gpsPrecisionMeters: 75,
    }).match(input);

    expect(fetch).not.toHaveBeenCalled();
    expect(result?.matchedGeometry).toBeNull();
  });

  test('uses per-sample GPS accuracy as OSRM radiuses with a 25 m floor and a bounded fallback', async () => {
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
    expect(requestedUrl).toContain('radiuses=25%3B25%3B40');
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

  test('accepts a leg whose whole-trace OSRM confidence is low when its own distance, speed and snap checks pass', async () => {
    const coordinates: Array<[number, number]> = [[-79.4, 43.65], [-79.4003, 43.6502]];
    const fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify(osrmMatchResponse(coordinates, { confidence: 0.12 })))));
    const provider = new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { ontario: 'http://osrm-ontario:5000' },
      fetch,
    });

    const result = await provider.match(document(coordinates));

    expect(result?.matchedGeometry?.coordinates).toEqual([coordinates]);
    expect(result?.matchedRanges).toEqual([expect.objectContaining({ interpolationLevel: 0 })]);
    expect(result?.uncertainGeometry).toBeNull();
  });

  test('classifies OSRM transport failures as retryable without changing match null behavior', async () => {
    const fetch = vi.fn(() => Promise.reject(new Error('OSRM unavailable')));
    const provider = new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { korea: 'http://osrm-korea:5000' },
      fetch,
    });

    await expect(provider.match(document([[126.9, 37.5], [126.901, 37.501]]))).resolves.toBeNull();
    const outcome = await provider.matchWithStatus(document([[126.9, 37.5], [126.901, 37.501]]));
    expect(outcome.retryable).toBe(true);
    expect(outcome.path).toEqual(expect.objectContaining({
      matchedGeometry: null,
      matchedPointCount: 0,
      qualityVersion: 'gps_quality.v4',
    }));
  });

  test('classifies completed OSRM NoMatch responses as non-retryable', async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ code: 'NoMatch' }))));
    const provider = new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { korea: 'http://osrm-korea:5000' },
      fetch,
    });

    const outcome = await provider.matchWithStatus(document([[126.9, 37.5], [126.901, 37.501]]));
    expect(outcome.retryable).toBe(false);
    expect(outcome.path).toEqual(expect.objectContaining({
      matchedGeometry: null,
      matchedPointCount: 0,
      qualityVersion: 'gps_quality.v4',
    }));
    expect(outcome.path?.unmatchedRanges).toEqual([expect.objectContaining({ interpolationLevel: 2 })]);
  });

  test('preserves retryable status when one OSRM chunk succeeds and a later chunk fails', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ...osrmMatchResponse([[126.9, 37.5], [126.901, 37.501]]),
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
    const coordinates: Array<[number, number]> = [[126.9, 37.5], [126.901, 37.501], [126.902, 37.502]];
    const fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify(osrmMatchResponse(coordinates, { nullIndexes: [2] })))));
    const provider = new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { korea: 'http://osrm-korea:5000' },
      fetch,
    });

    const result = await provider.match(document(coordinates));

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

  test('joins the neighbours of a null tracepoint with the OSRM leg between them as level 1', async () => {
    const coordinates: Array<[number, number]> = [
      [-79.4, 43.65], [-79.401, 43.651], [-79.402, 43.652], [-79.403, 43.653],
    ];
    const fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify(osrmMatchResponse(coordinates, {
      confidence: 0.91,
      nullIndexes: [2],
    })))));
    const provider = new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { ontario: 'http://osrm-ontario:5000' },
      fetch,
    });

    const result = await provider.match(document(coordinates));

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result?.matchedRanges).toEqual([expect.objectContaining({
      startSourceIndex: 0,
      endSourceIndex: 1,
      interpolationLevel: 0,
    })]);
    expect(result?.inferredRanges).toEqual([expect.objectContaining({
      startSourceIndex: 1,
      endSourceIndex: 3,
      interpolationLevel: 1,
      reason: 'NO_MATCH',
    })]);
    expect(result?.inferredGeometry?.coordinates).toEqual([[coordinates[1], coordinates[3]]]);
    expect(result?.unmatchedRanges).toEqual([]);
  });

  test('leaves a null tracepoint span disconnected when a skipped fix lies outside the leg corridor', async () => {
    const coordinates: Array<[number, number]> = [
      [-79.4, 43.65], [-79.401, 43.651], [-79.402, 43.655], [-79.403, 43.653],
    ];
    const fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify(osrmMatchResponse(coordinates, {
      nullIndexes: [2],
    })))));
    const result = await new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { ontario: 'http://osrm-ontario:5000' },
      fetch,
    }).match(document(coordinates));

    expect(result?.matchedRanges).toEqual([expect.objectContaining({ startSourceIndex: 0, endSourceIndex: 1 })]);
    expect(result?.inferredRanges).toEqual([]);
    expect(result?.uncertainRanges).toEqual([expect.objectContaining({ startSourceIndex: 1, endSourceIndex: 3, interpolationLevel: 2 })]);
  });

  test('never lets a matched source range cross an actual acquisition gap', async () => {
    const fetch = vi.fn((url: string) => Promise.resolve(new Response(JSON.stringify(
      osrmMatchResponse(readRequestedCoordinates(url)),
    ))));
    const provider = new OsrmRouteTrackingRoadMatchProvider({ baseUrls: { ontario: 'http://osrm-ontario:5000' }, fetch });

    const result = await provider.match(document([
      [-79.4, 43.65], [-79.401, 43.651], [-79.402, 43.652], [-79.403, 43.653]
    ], { gapBeforeIndex: 2 }));

    expect(result?.matchedRanges).toEqual([
      expect.objectContaining({ startSourceIndex: 0, endSourceIndex: 1 }),
      expect.objectContaining({ startSourceIndex: 2, endSourceIndex: 3 }),
    ]);
  });

  test('leaves a fix above 200 m out and joins its neighbours with a level-1 leg instead of splitting the trace', async () => {
    const fetch = vi.fn((url: string) => Promise.resolve(new Response(JSON.stringify(
      osrmMatchResponse(readRequestedCoordinates(url)),
    ))));
    const provider = new OsrmRouteTrackingRoadMatchProvider({ baseUrls: { ontario: 'http://osrm-ontario:5000' }, fetch });
    const input = document([
      [-79.4, 43.65], [-79.401, 43.651], [-79.8, 43.9], [-79.402, 43.652], [-79.403, 43.653]
    ]);
    input.samples[2]!.accuracyMeters = 292.87;

    const result = await provider.match(input);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String((fetch.mock.calls as unknown as Array<[string]>)[0]![0])).not.toContain('-79.8');
    expect(result?.matchedRanges).toEqual([
      expect.objectContaining({ startSourceIndex: 0, endSourceIndex: 1, interpolationLevel: 0 }),
      expect.objectContaining({ startSourceIndex: 3, endSourceIndex: 4, interpolationLevel: 0 }),
    ]);
    expect(result?.inferredRanges).toEqual([expect.objectContaining({
      startSourceIndex: 1,
      endSourceIndex: 3,
      interpolationLevel: 1,
      reason: 'LOW_ACCURACY',
    })]);
    expect(result?.unmatchedRanges).toEqual([]);
  });

  test.each([
    [100, 0],
    [100.01, 1],
    [200, 1],
  ])('classifies accepted OSRM geometry at %s meter accuracy as level %s', async (accuracyMeters, level) => {
    const input = document([[-79.4, 43.65], [-79.3995, 43.6502]]);
    input.samples.forEach((sample) => { sample.accuracyMeters = accuracyMeters; });
    const fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify(osrmMatchResponse(input.coordinates)))));
    const result = await new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { ontario: 'http://osrm-ontario:5000' },
      fetch,
    }).match(input);

    const ranges = level === 0 ? result?.matchedRanges : result?.inferredRanges;
    expect(ranges).toEqual([expect.objectContaining({ interpolationLevel: level })]);
  });

  test('rejects accuracy above 200 meters without sending it to OSRM', async () => {
    const input = document([[-79.4, 43.65], [-79.3995, 43.6502]]);
    input.samples.forEach((sample) => { sample.accuracyMeters = 200.01; });
    const fetch = vi.fn();
    const result = await new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { ontario: 'http://osrm-ontario:5000' },
      fetch,
    }).match(input);

    expect(fetch).not.toHaveBeenCalled();
    expect(result?.matchedPointCount).toBe(0);
    expect(result?.unmatchedRanges).toEqual([expect.objectContaining({ interpolationLevel: 2, reason: 'LOW_ACCURACY' })]);
  });

  test.each([0.9, 0.79, 0.3])('accepts a locally ambiguous leg as level 1 regardless of matching confidence (%s)', async (confidence) => {
    const input = document([[-79.4, 43.65], [-79.3995, 43.6502]]);
    const payload = osrmMatchResponse(input.coordinates, { confidence });
    payload.tracepoints[0]!.alternatives_count = 1;
    const result = await new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { ontario: 'http://osrm-ontario:5000' },
      fetch: vi.fn(() => Promise.resolve(new Response(JSON.stringify(payload)))),
    }).match(input);

    expect(result?.inferredRanges).toEqual([expect.objectContaining({ interpolationLevel: 1 })]);
    expect(result?.uncertainRanges).toEqual([]);
  });

  test('uses bounded GPS uncertainty for a high-confidence level-1 detour', async () => {
    const input = document([[-79.4, 43.65], [-79.3995, 43.6502]]);
    input.samples.forEach((sample) => { sample.accuracyMeters = 50; });
    const payload = osrmMatchResponse(input.coordinates, { confidence: 0.9 });
    payload.matchings[0]!.legs[0]!.distance = 240;
    const result = await new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { ontario: 'http://osrm-ontario:5000' },
      fetch: vi.fn(() => Promise.resolve(new Response(JSON.stringify(payload)))),
    }).match(input);

    expect(result?.inferredRanges).toEqual([expect.objectContaining({ interpolationLevel: 1 })]);
    expect(result?.uncertainRanges).toEqual([]);
  });

  test('keeps nominal-duration mismatch at level 1 only with high global confidence', async () => {
    const input = document([[-79.4, 43.65], [-79.3995, 43.6502]]);
    const payload = osrmMatchResponse(input.coordinates, { confidence: 0.9 });
    payload.matchings[0]!.legs[0]!.duration = 90;
    const result = await new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { ontario: 'http://osrm-ontario:5000' },
      fetch: vi.fn(() => Promise.resolve(new Response(JSON.stringify(payload)))),
    }).match(input);

    expect(result?.inferredRanges).toEqual([expect.objectContaining({ interpolationLevel: 1 })]);
    expect(result?.uncertainRanges).toEqual([]);
  });

  test('classifies each OSRM leg independently and retains GPS vertices as leg boundaries', async () => {
    const input = document([
      [-79.4000, 43.6500], [-79.3997, 43.6500], [-79.3994, 43.6500], [-79.3991, 43.6500],
    ]);
    input.samples[1]!.accuracyMeters = 150;
    const legs = input.coordinates.slice(0, -1).map((coordinate, index) => ({
      distance: 30,
      duration: 20,
      steps: [{ geometry: { coordinates: [coordinate, input.coordinates[index + 1]], type: 'LineString' } }],
    }));
    const fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      code: 'Ok',
      matchings: [{ confidence: 0.9, distance: 90, duration: 60, geometry: { coordinates: input.coordinates, type: 'LineString' }, legs }],
      tracepoints: input.coordinates.map((location, waypoint_index) => ({
        alternatives_count: 0, location, matchings_index: 0, waypoint_index,
      })),
    }))));
    const result = await new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { ontario: 'http://osrm-ontario:5000' }, fetch,
    }).match(input);

    expect(result?.inferredRanges).toEqual([expect.objectContaining({
      interpolationLevel: 1, startSourceIndex: 0, endSourceIndex: 2,
    })]);
    expect(result?.matchedRanges).toEqual([expect.objectContaining({
      interpolationLevel: 0, startSourceIndex: 2, endSourceIndex: 3,
    })]);
  });

  test('preserves a legitimate closed OSRM leg while skipping a duplicate arrival step', async () => {
    const start: [number, number] = [-79.4, 43.65];
    const input = document([start, start]);
    const loop: Array<[number, number]> = [start, [-79.3998, 43.6501], [-79.4001, 43.6502], start];
    const payload = osrmMatchResponse(input.coordinates);
    payload.matchings[0]!.geometry.coordinates = loop;
    payload.matchings[0]!.legs[0] = {
      distance: 30,
      duration: 20,
      steps: [
        { geometry: { coordinates: loop, type: 'LineString' } },
        { geometry: { coordinates: [start, start], type: 'LineString' } },
      ],
    };
    const result = await new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { ontario: 'http://osrm-ontario:5000' },
      fetch: vi.fn(() => Promise.resolve(new Response(JSON.stringify(payload)))),
    }).match(input);

    expect(result?.matchedGeometry?.coordinates).toEqual([loop]);
  });

  test.each(['missing-alternatives', 'out-of-range-matching-index'])(
    'rejects %s middle evidence between valid anchors and leaves the span to a plain connector',
    async (malformation) => {
    const input = document([
      [-79.4000, 43.6500], [-79.3998, 43.6500], [-79.3996, 43.6500],
      [-79.3994, 43.6500], [-79.3992, 43.6500],
    ]);
    const payload = osrmMatchResponse(input.coordinates);
    if (malformation === 'missing-alternatives') {
      delete (payload.tracepoints[2] as unknown as Record<string, unknown>).alternatives_count;
    } else {
      (payload.tracepoints[2] as unknown as Record<string, unknown>).matchings_index = 99;
    }
    const fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify(payload))));
    const result = await new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { ontario: 'http://osrm-ontario:5000' }, fetch,
    }).match(input);

    // One match request, then one road bridge attempt that this match-shaped answer cannot satisfy.
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String((fetch.mock.calls as unknown as Array<[string]>)[1]![0])).toContain('/route/v1/driving/');
    expect(result?.uncertainRanges).toEqual([expect.objectContaining({
      interpolationLevel: 2, startSourceIndex: 1, endSourceIndex: 3,
    })]);
    expect(result?.inferredRanges).toEqual([]);
    },
  );

  test.each(['gap', 'driver', 'reverse-time', 'invalid-time'])('breaks OSRM chunks at a %s boundary', async (boundary) => {
    const input = document([
      [-79.4000, 43.6500], [-79.3998, 43.6500], [-79.3996, 43.6500], [-79.3994, 43.6500],
    ]);
    if (boundary === 'gap') input.samples[2]!.gapBefore = true;
    if (boundary === 'driver') input.samples[2]!.driverId = 'driver-2';
    if (boundary === 'reverse-time') input.samples[2]!.occurredAt = '2026-07-20T23:59:59.000Z';
    if (boundary === 'invalid-time') input.samples[2]!.occurredAt = 'invalid';
    const requestPointCounts: number[] = [];
    const fetch = vi.fn((url: string) => {
      const coordinates = decodeURIComponent(new URL(url).pathname.split('/').at(-1) ?? '').split(';');
      requestPointCounts.push(coordinates.length);
      return Promise.resolve(new Response(JSON.stringify({
        code: 'Ok',
        matchings: [{ confidence: 0.9, geometry: { coordinates: coordinates.map((value) => value.split(',').map(Number)), type: 'LineString' } }],
        tracepoints: coordinates.map(() => ({})),
      })));
    });
    await new OsrmRouteTrackingRoadMatchProvider({ baseUrls: { ontario: 'http://osrm-ontario:5000' }, fetch }).match(input);

    expect(requestPointCounts.every((count) => count <= 2)).toBe(true);
  });

  test('supplements a short moderate-accuracy span with a constrained OSRM match', async () => {
    const input = supplementInput();
    const fetch = supplementFetch();
    const provider = new OsrmRouteTrackingRoadMatchProvider({ baseUrls: { ontario: 'http://osrm-ontario:5000' }, fetch });

    const result = await provider.match(input);

    const matchUrls = (fetch.mock.calls as unknown as Array<[string]>).map(([url]) => String(url))
      .filter((url) => url.includes('/match/v1/driving/'));
    expect(matchUrls).toHaveLength(2);
    expect(matchUrls[1]).toContain('radiuses=25%3B150%3B25');
    expect(matchUrls[1]).toContain('timestamps=1784592030%3B1784592060%3B1784592090');
    expect(result?.inferredGeometry?.coordinates).toEqual([supplementRouteCoordinates()]);
    expect(result?.inferredRanges).toEqual([expect.objectContaining({
      startEventId: 'event-1',
      endEventId: 'event-3',
      startSourceIndex: 1,
      endSourceIndex: 3,
      interpolationLevel: 1,
      reason: 'LOW_ACCURACY',
    })]);
    expect(result?.unmatchedRanges).toEqual([expect.objectContaining({
      startEventId: 'event-2',
      endEventId: 'event-2',
      reason: 'LOW_ACCURACY',
    })]);
    expect(result?.qualityVersion).toBe('gps_quality.v4');
  });

  test('routes only the missing adjacent edge between confident OSRM ranges', async () => {
    const input = document([
      [-79.4000, 43.6500], [-79.3997, 43.6500], [-79.3994, 43.6500], [-79.3991, 43.6500],
    ]);
    let call = 0;
    const fetch = vi.fn(() => {
      if (call++ === 0) {
        const left = osrmMatchResponse(input.coordinates.slice(0, 2));
        const right = osrmMatchResponse(input.coordinates.slice(2, 4));
        return Promise.resolve(new Response(JSON.stringify({
        code: 'Ok',
        matchings: [left.matchings[0], right.matchings[0]],
        tracepoints: [
          { alternatives_count: 0, location: input.coordinates[0], matchings_index: 0, waypoint_index: 0 },
          { alternatives_count: 0, location: input.coordinates[1], matchings_index: 0, waypoint_index: 1 },
          { alternatives_count: 0, location: input.coordinates[2], matchings_index: 1, waypoint_index: 0 },
          { alternatives_count: 0, location: input.coordinates[3], matchings_index: 1, waypoint_index: 1 },
        ],
        })));
      }
      return Promise.resolve(new Response(JSON.stringify({
        code: 'Ok',
        routes: [{
          distance: 30,
          duration: 20,
          geometry: { coordinates: [input.coordinates[1], input.coordinates[2]], type: 'LineString' },
        }],
        waypoints: [{ location: input.coordinates[1] }, { location: input.coordinates[2] }],
      })));
    });
    const result = await new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { ontario: 'http://osrm-ontario:5000' }, fetch,
    }).match(input);

    expect(String((fetch.mock.calls as unknown as Array<[string]>)[1]![0])).toContain('/route/v1/driving/');
    expect(result?.inferredRanges).toEqual([expect.objectContaining({
      interpolationLevel: 1, startSourceIndex: 1, endSourceIndex: 2,
    })]);
  });

  test('does not supplement across an already approved level-1 range', async () => {
    const input = document([
      [-79.4000, 43.6500], [-79.3998, 43.6500], [-79.3996, 43.6500],
      [-79.3994, 43.6500], [-79.3992, 43.6500], [-79.3990, 43.6500],
    ]);
    input.samples[2]!.accuracyMeters = 150;
    input.samples[3]!.accuracyMeters = 150;
    const fetch = vi.fn(() => {
      const left = osrmMatchResponse(input.coordinates.slice(0, 2));
      const moderate = osrmMatchResponse(input.coordinates.slice(2, 4));
      const right = osrmMatchResponse(input.coordinates.slice(4, 6));
      return Promise.resolve(new Response(JSON.stringify({
      code: 'Ok',
      matchings: [left.matchings[0], moderate.matchings[0], right.matchings[0]],
      tracepoints: [
        { alternatives_count: 0, location: input.coordinates[0], matchings_index: 0, waypoint_index: 0 },
        { alternatives_count: 0, location: input.coordinates[1], matchings_index: 0, waypoint_index: 1 },
        { alternatives_count: 0, location: input.coordinates[2], matchings_index: 1, waypoint_index: 0 },
        { alternatives_count: 0, location: input.coordinates[3], matchings_index: 1, waypoint_index: 1 },
        { alternatives_count: 0, location: input.coordinates[4], matchings_index: 2, waypoint_index: 0 },
        { alternatives_count: 0, location: input.coordinates[5], matchings_index: 2, waypoint_index: 1 },
      ],
      })));
    });
    const result = await new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { ontario: 'http://osrm-ontario:5000' }, fetch,
    }).match(input);

    // One match request plus a bridge attempt for each matching boundary (refused by the match-shaped answer).
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(result?.inferredRanges).toEqual([expect.objectContaining({
      interpolationLevel: 1, startSourceIndex: 2, endSourceIndex: 3,
    })]);
  });

  test('accepts a low-confidence matching on its leg evidence and tries to bridge the matching boundaries', async () => {
    const input = document([
      [-79.4000, 43.6500], [-79.3998, 43.6500], [-79.3996, 43.6500],
      [-79.3994, 43.6500], [-79.3992, 43.6500], [-79.3990, 43.6500],
    ]);
    const left = osrmMatchResponse(input.coordinates.slice(0, 2));
    const rejected = osrmMatchResponse(input.coordinates.slice(2, 4), { confidence: 0.49 });
    const right = osrmMatchResponse(input.coordinates.slice(4, 6));
    const tracepoints = [left, rejected, right].flatMap((response, matchingIndex) => (
      response.tracepoints.map((tracepoint) => ({ ...tracepoint, matchings_index: matchingIndex }))
    ));
    const fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      code: 'Ok',
      matchings: [left.matchings[0], rejected.matchings[0], right.matchings[0]],
      tracepoints,
    }))));
    const result = await new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { ontario: 'http://osrm-ontario:5000' }, fetch,
    }).match(input);

    // One match, a strict supplement and a bridge attempt per matching boundary (both refused by the match-shaped stub).
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(result?.matchedRanges).toEqual([
      expect.objectContaining({ interpolationLevel: 0, startSourceIndex: 0, endSourceIndex: 1 }),
      expect.objectContaining({ interpolationLevel: 0, startSourceIndex: 2, endSourceIndex: 3 }),
      expect.objectContaining({ interpolationLevel: 0, startSourceIndex: 4, endSourceIndex: 5 }),
    ]);
    expect(result?.uncertainRanges).toEqual([]);
    expect(result?.inferredRanges).toEqual([]);
  });

  test('bridges an explicit recorded GPS gap between measured adjacent raw anchors', async () => {
    const input = recordedGapInput();
    const fetch = recordedGapFetch(input);

    const result = await new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { ontario: 'http://osrm-ontario:5000' }, fetch,
    }).matchWithStatus(input, rawEvidenceFromDocument(input));

    // The recorded-gap request plus two bridge attempts for the null spans beside it; the stubbed
    // answer carries the recorded-gap waypoints, so only the recorded gap is accepted.
    expect((fetch.mock.calls as unknown as Array<[string]>).filter(([url]) => (
      String(url).includes('/route/v1/driving/')
    ))).toHaveLength(3);
    expect(result.path?.matchedRanges).toEqual([
      expect.objectContaining({ startSourceIndex: 0, endSourceIndex: 1 }),
      expect.objectContaining({ startSourceIndex: 6, endSourceIndex: 7 }),
    ]);
    expect(result.path?.inferredRanges).toEqual([expect.objectContaining({
      interpolationLevel: 1,
      reason: 'GPS_GAP',
      startSourceIndex: 3,
      endSourceIndex: 4,
    })]);
    expect(result.path?.inferredGeometry?.coordinates).toEqual([recordedGapRoute(input)]);
  });

  test('keeps matcher-counted moderate lines before an earlier supplemental GPS gap', async () => {
    const input = recordedGapInput();
    input.samples[6]!.accuracyMeters = 150;
    input.samples[7]!.accuracyMeters = 150;
    const fetch = vi.fn((url: string) => {
      if (url.includes('/route/v1/driving/')) {
        const coordinates = recordedGapRoute(input);
        return Promise.resolve(new Response(JSON.stringify({
          code: 'Ok',
          routes: [{ distance: 1_500, duration: 200, geometry: { coordinates, type: 'LineString' } }],
          waypoints: [{ location: input.coordinates[3] }, { location: input.coordinates[4] }],
        })));
      }
      const requested = readRequestedCoordinates(url);
      return Promise.resolve(new Response(JSON.stringify(osrmMatchResponse(requested))));
    });

    const result = await new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { ontario: 'http://osrm-ontario:5000' }, fetch,
    }).matchWithStatus(input, rawEvidenceFromDocument(input));

    expect(result.path?.inferredRanges).toEqual([
      expect.objectContaining({ interpolationLevel: 1, startSourceIndex: 5, endSourceIndex: 7 }),
      expect.objectContaining({ reason: 'GPS_GAP', startSourceIndex: 3, endSourceIndex: 4 }),
    ]);
    expect(result.path?.matchedPointCount).toBeGreaterThan(0);
  });

  test('does not bridge an explicit GPS gap across an unexamined raw fix', async () => {
    const input = recordedGapInput();
    input.samples.slice(4).forEach((sample) => { sample.sourceIndex! += 1; });
    input.sourcePointCount += 1;
    const rawEvidence = rawEvidenceFromDocument(input);
    rawEvidence.splice(4, 0, {
      accuracyMeters: 20,
      driverId: 'driver-1',
      eventId: 'filtered-event',
      latitude: 43.66,
      longitude: -79.39,
      occurredAt: '2026-07-21T00:02:00.000Z',
      receivedAt: '2026-07-21T00:02:01.000Z',
      routePlanId: 'route-1',
    });
    const fetch = recordedGapFetch(input);

    const result = await new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { ontario: 'http://osrm-ontario:5000' }, fetch,
    }).matchWithStatus(input, rawEvidence);

    expect(result.path?.inferredRanges).toEqual([]);
    // Only the general bridge attempt remains; the recorded-gap pass never asked.
    expect((fetch.mock.calls as unknown as Array<[string]>).filter(([url]) => (
      String(url).includes('/route/v1/driving/')
    ))).toHaveLength(1);
  });

  test.each([
    ['route ID', (raw: RouteTrackingGeometryPositionInput[]) => { raw[4]!.routePlanId = 'route-2'; }],
    ['coordinate', (raw: RouteTrackingGeometryPositionInput[]) => { raw[4]!.longitude += 0.001; }],
    ['time', (raw: RouteTrackingGeometryPositionInput[]) => { raw[4]!.occurredAt = '2026-07-21T00:05:05.000Z'; }],
    ['accuracy', (raw: RouteTrackingGeometryPositionInput[]) => { raw[4]!.accuracyMeters = 30; }],
  ] as const)('does not bridge an explicit GPS gap when raw %s differs from the retained anchor', async (_field, mutate) => {
    const input = recordedGapInput();
    const rawEvidence = rawEvidenceFromDocument(input);
    mutate(rawEvidence);
    const fetch = recordedGapFetch(input);

    const result = await new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { ontario: 'http://osrm-ontario:5000' }, fetch,
    }).matchWithStatus(input, rawEvidence);

    expect(result.path?.inferredRanges).toEqual([]);
    expect((fetch.mock.calls as unknown as Array<[string]>).filter(([url]) => (
      String(url).includes('/route/v1/driving/')
    ))).toHaveLength(1);
  });

  test('keeps an explicit GPS gap disconnected when OSRM returns an equally supported alternative', async () => {
    const input = recordedGapInput();
    const fetch = recordedGapFetch(input, { ambiguous: true });

    const result = await new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { ontario: 'http://osrm-ontario:5000' }, fetch,
    }).matchWithStatus(input, rawEvidenceFromDocument(input));

    expect(result.path?.inferredRanges).toEqual([]);
  });

  test('rejects an explicit GPS gap route whose polyline exceeds its plausible distance and speed', async () => {
    const input = recordedGapInput();
    const fetch = recordedGapFetch(input, { dishonestGeometry: true });

    const result = await new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { ontario: 'http://osrm-ontario:5000' }, fetch,
    }).matchWithStatus(input, rawEvidenceFromDocument(input));

    expect(result.path?.inferredRanges).toEqual([]);
  });

  test('keeps an explicit GPS gap disconnected when anchor speed is implausible', async () => {
    const input = recordedGapInput();
    input.samples.slice(4).forEach((sample, offset) => {
      sample.occurredAt = new Date(Date.parse('2026-07-21T00:01:50.000Z') + offset * 30_000).toISOString();
      sample.receivedAt = new Date(Date.parse('2026-07-21T00:01:51.000Z') + offset * 30_000).toISOString();
    });
    const fetch = recordedGapFetch(input);

    const result = await new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { ontario: 'http://osrm-ontario:5000' }, fetch,
    }).matchWithStatus(input, rawEvidenceFromDocument(input));

    expect(result.path?.inferredRanges).toEqual([]);
    // The general bridge still asks once; the stubbed recorded-gap answer does not fit its anchors.
    expect((fetch.mock.calls as unknown as Array<[string]>).filter(([url]) => (
      String(url).includes('/route/v1/driving/')
    ))).toHaveLength(1);
  });

  test('joins an observed short NO_MATCH corridor with the OSRM leg between its confident anchors', async () => {
    const input = document([
      [-79.4000, 43.6500], [-79.3998, 43.6500], [-79.3996, 43.6500],
      [-79.3994, 43.6500], [-79.3992, 43.6500], [-79.3990, 43.6500],
    ], { intervalMs: 10_000 });
    input.samples.forEach((sample, index) => { if (index > 0) sample.gapBefore = false; sample.sourceIndex = index; });
    const fetch = observedNoMatchFetch(input);
    const result = await new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { ontario: 'http://osrm-ontario:5000' }, fetch,
    }).matchWithStatus(input, rawEvidenceFromDocument(input));

    expect((fetch.mock.calls as unknown as Array<[string]>).map(([url]) => String(url))
      .filter((url) => url.includes('/route/v1/driving/'))).toHaveLength(0);
    expect(result.path?.matchedRanges).toEqual([
      expect.objectContaining({ startSourceIndex: 0, endSourceIndex: 1 }),
      expect.objectContaining({ startSourceIndex: 4, endSourceIndex: 5 }),
    ]);
    expect(result.path?.inferredRanges).toEqual([expect.objectContaining({
      interpolationLevel: 1, reason: 'NO_MATCH', startSourceIndex: 1, endSourceIndex: 4,
    })]);
    expect(result.path?.inferredGeometry?.coordinates).toEqual([[input.coordinates[1], input.coordinates[4]]]);
  });

  test('joins null tracepoints in the normal durable worker without raw evidence or Route requests', async () => {
    const input = document([
      [-79.4000, 43.6500], [-79.3998, 43.6500], [-79.3996, 43.6500],
      [-79.3994, 43.6500], [-79.3992, 43.6500], [-79.3990, 43.6500],
    ], { intervalMs: 10_000 });
    input.samples.forEach((sample, index) => { sample.gapBefore = false; sample.sourceIndex = index; });
    const fetch = observedNoMatchFetch(input);

    const result = await new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { ontario: 'http://osrm-ontario:5000' }, fetch,
    }).matchWithStatus(input);

    expect(result.retryable).toBe(false);
    expect(result.path?.inferredRanges).toEqual([expect.objectContaining({
      interpolationLevel: 1, reason: 'NO_MATCH', startSourceIndex: 1, endSourceIndex: 4,
    })]);
    expect((fetch.mock.calls as unknown as Array<[string]>).filter(([url]) =>
      String(url).includes('/route/v1/driving/'))).toHaveLength(0);
  });

  test('recovers only the safe windows of a long continuous NO_MATCH range', async () => {
    const input = continuousNoMatchInput(45);
    let routeRequest = 0;
    const fetch = continuousNoMatchFetch(input, () => ({ ambiguous: routeRequest++ === 1 }));

    const result = await new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { ontario: 'http://osrm-ontario:5000' }, fetch,
    }).matchWithStatus(input, rawEvidenceFromDocument(input));

    // The raw windows stay as they were; the ambiguous window between them is closed by the general bridge.
    expect(result.path?.inferredRanges).toEqual([
      expect.objectContaining({ reason: 'NO_MATCH', startSourceIndex: 0, endSourceIndex: 19 }),
      expect.objectContaining({ reason: 'NO_MATCH', startSourceIndex: 19, endSourceIndex: 38 }),
      expect.objectContaining({ reason: 'NO_MATCH', startSourceIndex: 38, endSourceIndex: 44 }),
    ]);
    expect(result.path?.unmatchedRanges).toEqual([
      expect.objectContaining({ reason: 'NO_MATCH', startSourceIndex: 0, endSourceIndex: 44 }),
    ]);
  });

  test('bridges around an unknown-accuracy raw fix after the raw windows refused it', async () => {
    const input = continuousNoMatchInput(31);
    delete input.samples[5]!.accuracyMeters;
    const fetch = continuousNoMatchFetch(input);

    const result = await new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { ontario: 'http://osrm-ontario:5000' }, fetch,
    }).matchWithStatus(input, rawEvidenceFromDocument(input));

    expect(result.path?.inferredRanges).toContainEqual(expect.objectContaining({
      reason: 'NO_MATCH', startSourceIndex: 4, endSourceIndex: 6,
    }));
  });

  test('does not infer across an acquisition gap inside a continuous NO_MATCH range', async () => {
    const input = continuousNoMatchInput(31);
    input.samples[6]!.gapBefore = true;
    const fetch = continuousNoMatchFetch(input);

    const result = await new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { ontario: 'http://osrm-ontario:5000' }, fetch,
    }).matchWithStatus(input, rawEvidenceFromDocument(input));

    expect(result.path?.inferredRanges?.some((range) => (
      range.startSourceIndex < 6 && range.endSourceIndex >= 6
    ))).toBe(false);
  });

  test('requires complete contiguous raw evidence for long NO_MATCH recovery', async () => {
    const input = continuousNoMatchInput(31);
    const rawEvidence = rawEvidenceFromDocument(input);
    rawEvidence.splice(5, 1);
    const fetch = continuousNoMatchFetch(input);

    const result = await new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { ontario: 'http://osrm-ontario:5000' }, fetch,
    }).matchWithStatus(input, rawEvidence);

    expect(result.path?.inferredRanges).toEqual([]);
    expect((fetch.mock.calls as unknown as Array<[string]>).filter(([url]) => (
      String(url).includes('/route/v1/driving/')
    ))).toHaveLength(0);
  });

  test.each([
    ['ambiguous road alternatives', { ambiguous: true }],
    ['a route whose interior contradicts the raw evidence corridor', { interiorOffCorridor: true }],
  ])('keeps a continuous NO_MATCH window disconnected for %s', async (_label, routeOptions) => {
    const input = continuousNoMatchInput(21);
    const fetch = continuousNoMatchFetch(input, () => routeOptions);

    const result = await new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { ontario: 'http://osrm-ontario:5000' }, fetch,
    }).matchWithStatus(input, rawEvidenceFromDocument(input));

    expect(result.path?.inferredRanges).toEqual([]);
  });

  test('does not overlap an already accepted road range during continuous NO_MATCH recovery', async () => {
    const input = continuousNoMatchInput(30);
    const fetch = continuousNoMatchFetch(input, undefined, 5);

    const result = await new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { ontario: 'http://osrm-ontario:5000' }, fetch,
    }).matchWithStatus(input, rawEvidenceFromDocument(input));

    expect(result.path?.matchedRanges).toEqual([
      expect.objectContaining({ startSourceIndex: 0, endSourceIndex: 4 }),
    ]);
    expect(result.path?.inferredRanges?.every((range) => range.startSourceIndex >= 5)).toBe(true);
  });

  test('recovers bounded windows from sparse retained samples using the complete raw source range', async () => {
    const complete = continuousNoMatchInput(31);
    const rawEvidence = rawEvidenceFromDocument(complete);
    const retainedIndexes = [0, 10, 20, 30];
    const input: RouteTrackingGeometryDocumentV1 = {
      coordinates: retainedIndexes.map((index) => complete.coordinates[index]!),
      samples: retainedIndexes.map((index) => complete.samples[index]!),
      sourcePointCount: complete.sourcePointCount,
    };
    const fetch = continuousNoMatchFetch(input);

    const result = await new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { ontario: 'http://osrm-ontario:5000' }, fetch,
    }).matchWithStatus(input, rawEvidence);

    expect(result.path?.inferredRanges).toEqual([
      expect.objectContaining({ reason: 'NO_MATCH', startSourceIndex: 0, endSourceIndex: 19 }),
      expect.objectContaining({ reason: 'NO_MATCH', startSourceIndex: 19, endSourceIndex: 30 }),
    ]);
  });

  test('spends the bounded recovery budget on the longest continuous NO_MATCH range first', async () => {
    const coordinates: Array<[number, number]> = [];
    const accuracies: number[] = [];
    for (let range = 0; range < 70; range += 1) {
      for (let point = 0; point < 21; point += 1) {
        coordinates.push([-81.2500 + coordinates.length * 0.0001, 42.9800]);
        accuracies.push(20);
      }
      coordinates.push([-81.2500 + coordinates.length * 0.0001, 42.9800]);
      accuracies.push(150);
    }
    const longRangeStart = coordinates.length;
    for (let point = 0; point < 41; point += 1) {
      coordinates.push([-81.2500 + coordinates.length * 0.0001, 42.9800]);
      accuracies.push(20);
    }
    const input = document(coordinates, { intervalMs: 5_000 });
    input.samples.forEach((sample, index) => {
      sample.accuracyMeters = accuracies[index]!;
      sample.gapBefore = false;
      sample.sourceIndex = index;
    });
    const fetch = continuousNoMatchFetch(input);

    const result = await new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { ontario: 'http://osrm-ontario:5000' }, fetch,
    }).matchWithStatus(input, rawEvidenceFromDocument(input));

    // 64 bounded raw windows, then the general bridge closes the gaps between them.
    expect((fetch.mock.calls as unknown as Array<[string]>).filter(([url]) => (
      String(url).includes('/route/v1/driving/')
    )).length).toBeGreaterThanOrEqual(64);
    expect(result.path?.inferredRanges).toEqual(
      [...(result.path?.inferredRanges ?? [])].sort((left, right) => (
        left.startSourceIndex - right.startSourceIndex || left.endSourceIndex - right.endSourceIndex
      )),
    );
    expect(result.path?.inferredRanges).toEqual(expect.arrayContaining([
      expect.objectContaining({ startSourceIndex: longRangeStart, endSourceIndex: longRangeStart + 19 }),
      expect.objectContaining({ startSourceIndex: longRangeStart + 19, endSourceIndex: longRangeStart + 38 }),
      expect.objectContaining({ startSourceIndex: longRangeStart + 38, endSourceIndex: longRangeStart + 40 }),
    ]));
  });

  test('joins a null run inside a matching and tries a road bridge across the matching boundary', async () => {
    const input = document([
      [-79.4000, 43.6500], [-79.3998, 43.6500], [-79.3996, 43.6500],
      [-79.3994, 43.6500], [-79.3992, 43.6500], [-79.3990, 43.6500],
    ], { intervalMs: 10_000 });
    input.samples.forEach((sample, index) => { if (index > 0) sample.gapBefore = false; sample.sourceIndex = index; });
    const left = osrmMatchResponse(input.coordinates.slice(0, 4), { nullIndexes: [2] });
    const right = osrmMatchResponse(input.coordinates.slice(4));
    const fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      code: 'Ok',
      matchings: [left.matchings[0], right.matchings[0]],
      tracepoints: [
        ...left.tracepoints.map((tracepoint) => tracepoint === null ? null : { ...tracepoint, matchings_index: 0 }),
        ...right.tracepoints.map((tracepoint) => ({ ...tracepoint, matchings_index: 1 })),
      ],
    }))));

    const result = await new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { ontario: 'http://osrm-ontario:5000' }, fetch,
    }).matchWithStatus(input, rawEvidenceFromDocument(input));

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String((fetch.mock.calls as unknown as Array<[string]>)[1]![0])).toContain('/route/v1/driving/');
    expect(result.path?.matchedRanges).toEqual([
      expect.objectContaining({ startSourceIndex: 0, endSourceIndex: 1 }),
      expect.objectContaining({ startSourceIndex: 4, endSourceIndex: 5 }),
    ]);
    expect(result.path?.inferredRanges).toEqual([expect.objectContaining({
      interpolationLevel: 1, reason: 'NO_MATCH', startSourceIndex: 1, endSourceIndex: 3,
    })]);
  });

  test('tries a road bridge across a null-only run between different OSRM matching identities', async () => {
    const input = document([
      [-79.4000, 43.6500], [-79.3998, 43.6500], [-79.3996, 43.6500],
      [-79.3994, 43.6500], [-79.3992, 43.6500], [-79.3990, 43.6500],
    ], { intervalMs: 10_000 });
    input.samples.forEach((sample, index) => { sample.gapBefore = false; sample.sourceIndex = index; });
    const left = osrmMatchResponse(input.coordinates.slice(0, 2));
    const right = osrmMatchResponse(input.coordinates.slice(4));
    const fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      code: 'Ok',
      matchings: [left.matchings[0], right.matchings[0]],
      tracepoints: [
        ...left.tracepoints.map((point) => ({ ...point, matchings_index: 0 })),
        null, null,
        ...right.tracepoints.map((point) => ({ ...point, matchings_index: 1 })),
      ],
    }))));

    const result = await new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { ontario: 'http://osrm-ontario:5000' }, fetch,
    }).matchWithStatus(input, rawEvidenceFromDocument(input));

    expect(result.path?.matchedRanges).toEqual([
      expect.objectContaining({ startSourceIndex: 0, endSourceIndex: 1 }),
      expect.objectContaining({ startSourceIndex: 4, endSourceIndex: 5 }),
    ]);
    expect(result.path?.inferredRanges).toEqual([]);
    // One match, then the strict four-point supplement match and the general road bridge, both refused by the stub.
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(String((fetch.mock.calls as unknown as Array<[string]>)[1]![0])).toContain('/match/v1/driving/');
    expect(String((fetch.mock.calls as unknown as Array<[string]>)[2]![0])).toContain('/route/v1/driving/');
  });

  test.each([
    ['valid', 0],
    ['invalid-waypoint', 1],
    ['ambiguous', 0],
  ])('joins a null run around an interior %s tracepoint (%s road bridge request)', async (variant, routeRequests) => {
    const input = document([
      [-79.4000, 43.6500], [-79.3998, 43.6500], [-79.3996, 43.6500],
      [-79.3994, 43.6500], [-79.3992, 43.6500], [-79.3990, 43.6500],
      [-79.3988, 43.6500],
    ], { intervalMs: 10_000 });
    input.samples.forEach((sample, index) => { if (index > 0) sample.gapBefore = false; sample.sourceIndex = index; });
    const payload = osrmMatchResponse(input.coordinates, { nullIndexes: [2, 4] });
    const interior = payload.tracepoints[3] as Record<string, unknown>;
    if (variant === 'invalid-waypoint') interior.waypoint_index = 99;
    if (variant === 'ambiguous') interior.alternatives_count = 1;
    const fetch = vi.fn((url: string) => {
      if (url.includes('/route/v1/driving/')) {
        return Promise.resolve(new Response(JSON.stringify({
          code: 'Ok',
          routes: [{ distance: 90, duration: 40, geometry: {
            coordinates: input.coordinates.slice(1, 6), type: 'LineString',
          } }],
          waypoints: [{ location: input.coordinates[1] }, { location: input.coordinates[5] }],
        })));
      }
      return Promise.resolve(new Response(JSON.stringify(payload)));
    });

    const result = await new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { ontario: 'http://osrm-ontario:5000' }, fetch,
    }).matchWithStatus(input, rawEvidenceFromDocument(input));

    // A malformed interior tracepoint rejects the OSRM legs; the general bridge then asks for a road.
    expect((fetch.mock.calls as unknown as Array<[string]>).filter(([url]) =>
      String(url).includes('/route/v1/driving/'))).toHaveLength(routeRequests);
    expect(result.path?.inferredRanges).toEqual([expect.objectContaining({
      interpolationLevel: 1, reason: 'NO_MATCH', startSourceIndex: 1, endSourceIndex: 5,
    })]);
  });

  test.each([
    ['a real acquisition gap', (input: RouteTrackingGeometryDocumentV1) => {
      input.samples.slice(3).forEach((sample) => {
        sample.occurredAt = new Date(Date.parse(sample.occurredAt) + 200_000).toISOString();
        sample.receivedAt = new Date(Date.parse(sample.receivedAt) + 200_000).toISOString();
      });
      input.samples[3]!.gapBefore = true;
    }, {}],
    ['a driver change', (input: RouteTrackingGeometryDocumentV1) => { input.samples[3]!.driverId = 'driver-2'; }, {}],
  ])('keeps a short NO_MATCH corridor disconnected for %s', async (_label, mutate, options) => {
    const input = document([
      [-79.4000, 43.6500], [-79.3998, 43.6500], [-79.3996, 43.6500],
      [-79.3994, 43.6500], [-79.3992, 43.6500], [-79.3990, 43.6500],
    ], { intervalMs: 10_000 });
    input.samples.forEach((sample, index) => { if (index > 0) sample.gapBefore = false; sample.sourceIndex = index; });
    mutate(input);
    const fetch = observedNoMatchFetch(input, options);
    const result = await new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { ontario: 'http://osrm-ontario:5000' }, fetch,
    }).matchWithStatus(input, rawEvidenceFromDocument(input));

    expect(result.path?.inferredRanges).not.toContainEqual(expect.objectContaining({
      reason: 'NO_MATCH', startSourceIndex: 1,
    }));
  });

  test.each([
    ['an unexamined raw GPS point', (input: RouteTrackingGeometryDocumentV1) => {
      input.samples.slice(3).forEach((sample) => { sample.sourceIndex! += 1; });
      input.sourcePointCount += 1;
    }, {}, 5],
    ['an equally supported alternative road', () => {}, { alternate: true }, 4],
  ])('joins a short NO_MATCH corridor across %s with the OSRM leg', async (_label, mutate, options, endSourceIndex) => {
    const input = document([
      [-79.4000, 43.6500], [-79.3998, 43.6500], [-79.3996, 43.6500],
      [-79.3994, 43.6500], [-79.3992, 43.6500], [-79.3990, 43.6500],
    ], { intervalMs: 10_000 });
    input.samples.forEach((sample, index) => { if (index > 0) sample.gapBefore = false; sample.sourceIndex = index; });
    mutate(input);
    const fetch = observedNoMatchFetch(input, options);
    const result = await new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { ontario: 'http://osrm-ontario:5000' }, fetch,
    }).matchWithStatus(input, rawEvidenceFromDocument(input));

    expect(result.path?.inferredRanges).toEqual([expect.objectContaining({
      interpolationLevel: 1, reason: 'NO_MATCH', startSourceIndex: 1, endSourceIndex,
    })]);
    expect((fetch.mock.calls as unknown as Array<[string]>).filter(([url]) =>
      String(url).includes('/route/v1/driving/'))).toHaveLength(0);
  });

  test.each([
    ['supported', [-79.3993, 43.6500]],
    ['backtracking', [-79.3998, 43.6500]],
    ['off-road', [-79.3993, 43.6520]],
  ] as const)('joins null tracepoints without consulting a filtered raw GPS point: %s', async (_label, omitted) => {
    const input = document([
      [-79.4000, 43.6500], [-79.3998, 43.6500], [-79.3996, 43.6500],
      [-79.3994, 43.6500], [-79.3992, 43.6500], [-79.3990, 43.6500],
    ], { intervalMs: 10_000 });
    input.samples.forEach((sample, index) => {
      sample.gapBefore = false;
      sample.sourceIndex = index >= 4 ? index + 1 : index;
    });
    input.sourcePointCount = 7;
    const rawEvidence: RouteTrackingGeometryPositionInput[] = input.samples.map((sample, index) => ({
      ...(sample.accuracyMeters === undefined ? {} : { accuracyMeters: sample.accuracyMeters }),
      driverId: sample.driverId,
      eventId: sample.eventId,
      latitude: input.coordinates[index]![1],
      longitude: input.coordinates[index]![0],
      occurredAt: sample.occurredAt,
      receivedAt: sample.receivedAt,
      routePlanId: 'route-1',
    }));
    rawEvidence.splice(4, 0, {
      accuracyMeters: 20,
      driverId: 'driver-1',
      eventId: 'filtered-event',
      latitude: omitted[1],
      longitude: omitted[0],
      occurredAt: '2026-07-21T00:00:35.000Z',
      receivedAt: '2026-07-21T00:00:36.000Z',
      routePlanId: 'route-1',
    });
    const fetch = observedNoMatchFetch(input);
    const result = await new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { ontario: 'http://osrm-ontario:5000' }, fetch,
    }).matchWithStatus(input, rawEvidence);

    expect(result.retryable).toBe(false);
    expect(omitted).toHaveLength(2);
    expect(result.path?.matchedRanges).toEqual([
      expect.objectContaining({ startSourceIndex: 0, endSourceIndex: 1 }),
      expect.objectContaining({ startSourceIndex: 5, endSourceIndex: 6 }),
    ]);
    expect(result.path?.inferredRanges).toEqual([expect.objectContaining({
      interpolationLevel: 1, reason: 'NO_MATCH', startSourceIndex: 1, endSourceIndex: 5,
    })]);
  });

  test('bridges the span left by fixes above 200 m with a bounded road route', async () => {
    const input = contextualSupplementInput();
    const fetch = contextualSupplementFetch(input);

    const result = await new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { ontario: 'http://osrm-ontario:5000' },
      fetch,
    }).match(input);

    // Leaving three 60 s fixes out opens a 240 s gap, so the trace is matched in two parts and the
    // general bridge joins them.
    const urls = (fetch.mock.calls as unknown as Array<[string]>).map(([url]) => String(url));
    expect(urls.filter((url) => url.includes('/match/v1/driving/'))).toHaveLength(2);
    expect(urls.filter((url) => url.includes('/route/v1/driving/'))).toHaveLength(1);
    expect(urls.some((url) => url.includes('-79.404,'))).toBe(false);
    expect(result?.inferredRanges).toEqual([expect.objectContaining({
      interpolationLevel: 1,
      reason: 'LOW_ACCURACY',
      startSourceIndex: 1,
      endSourceIndex: 5,
    })]);
    expect(result?.inferredGeometry?.coordinates).toEqual([contextualSupplementRoute()]);
  });

  test('drops a single GPS spike instead of cutting the trace twice', async () => {
    const coordinates: Array<[number, number]> = [
      [-79.4000, 43.6500], [-79.3997, 43.6500], [-79.3800, 43.6700], [-79.3991, 43.6500], [-79.3988, 43.6500],
    ];
    const fetch = vi.fn((url: string) => Promise.resolve(new Response(JSON.stringify(
      osrmMatchResponse(readRequestedCoordinates(url)),
    ))));
    const result = await new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { ontario: 'http://osrm-ontario:5000' }, fetch,
    }).match(document(coordinates, { intervalMs: 10_000 }));

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(readRequestedCoordinates(String((fetch.mock.calls as unknown as Array<[string]>)[0]![0]))).toEqual([
      coordinates[0], coordinates[1], coordinates[3], coordinates[4],
    ]);
    expect(result?.matchedRanges).toEqual([
      expect.objectContaining({ startSourceIndex: 0, endSourceIndex: 1, interpolationLevel: 0 }),
      expect.objectContaining({ startSourceIndex: 3, endSourceIndex: 4, interpolationLevel: 0 }),
    ]);
    expect(result?.inferredRanges).toEqual([expect.objectContaining({
      startSourceIndex: 1, endSourceIndex: 3, interpolationLevel: 1, reason: 'NO_MATCH',
    })]);
    expect(result?.unmatchedRanges).toEqual([]);
  });

  test('drops a slow drift fix once the next fix shows it was the outlier', async () => {
    // 540 m west in 10 s (54 m/s) passes as plausible; the way back (588 m in 10 s) does not, and the fix before
    // the drift explains the next fix, so the drift is the outlier.
    const coordinates: Array<[number, number]> = [
      [-79.4000, 43.6500], [-79.3997, 43.6500], [-79.4064, 43.6500], [-79.3991, 43.6500], [-79.3988, 43.6500],
    ];
    const fetch = vi.fn((url: string) => Promise.resolve(new Response(JSON.stringify(
      osrmMatchResponse(readRequestedCoordinates(url)),
    ))));
    const result = await new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { ontario: 'http://osrm-ontario:5000' }, fetch,
    }).match(document(coordinates, { intervalMs: 10_000 }));

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(readRequestedCoordinates(String((fetch.mock.calls as unknown as Array<[string]>)[0]![0]))).toEqual([
      coordinates[0], coordinates[1], coordinates[3], coordinates[4],
    ]);
    expect(result?.inferredRanges).toEqual([expect.objectContaining({ startSourceIndex: 1, endSourceIndex: 3 })]);
  });

  test('bridges the span between two matched parts with the fastest bounded road, even beside a similar alternative', async () => {
    const input = document([
      [-79.4000, 43.6500], [-79.3997, 43.6500], [-79.3990, 43.6500],
      [-79.3983, 43.6500], [-79.3980, 43.6500], [-79.3977, 43.6500],
    ], { intervalMs: 70_000 });
    input.samples[2]!.accuracyMeters = 250;
    input.samples[3]!.accuracyMeters = 250;
    const bridge: Array<[number, number]> = [input.coordinates[1]!, [-79.3990, 43.6503], input.coordinates[4]!];
    const fetch = vi.fn((url: string) => {
      if (url.includes('/route/v1/driving/')) {
        return Promise.resolve(new Response(JSON.stringify({
          code: 'Ok',
          routes: [
            { distance: 200, duration: 40, geometry: { coordinates: bridge, type: 'LineString' } },
            { distance: 210, duration: 42, geometry: { coordinates: [bridge[0], [-79.3990, 43.6497], bridge[2]], type: 'LineString' } },
          ],
          waypoints: [{ location: input.coordinates[1] }, { location: input.coordinates[4] }],
        })));
      }
      return Promise.resolve(new Response(JSON.stringify(osrmMatchResponse(readRequestedCoordinates(url)))));
    });

    const result = await new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { ontario: 'http://osrm-ontario:5000' }, fetch,
    }).match(input);

    // The contextual supplement refuses the similar alternative; the general bridge takes the fastest road.
    const urls = (fetch.mock.calls as unknown as Array<[string]>).map(([url]) => String(url));
    expect(urls.filter((url) => url.includes('/match/v1/driving/'))).toHaveLength(2);
    expect(urls.filter((url) => url.includes('/route/v1/driving/'))).toHaveLength(2);
    expect(result?.matchedRanges).toEqual([
      expect.objectContaining({ startSourceIndex: 0, endSourceIndex: 1 }),
      expect.objectContaining({ startSourceIndex: 4, endSourceIndex: 5 }),
    ]);
    expect(result?.inferredRanges).toEqual([expect.objectContaining({
      interpolationLevel: 1, reason: 'LOW_ACCURACY', startSourceIndex: 1, endSourceIndex: 4,
    })]);
    expect(result?.inferredGeometry?.coordinates).toEqual([bridge]);
  });

  test.each([
    ['a span longer than 20 minutes', (input: RouteTrackingGeometryDocumentV1) => {
      input.samples.slice(2).forEach((sample) => {
        sample.occurredAt = new Date(Date.parse(sample.occurredAt) + 25 * 60_000).toISOString();
      });
    }],
    ['the legacy whole-match provider', () => {}, 'legacy-whole-match' as const],
  ])('does not bridge %s', async (_label, mutate, classificationMode?: 'legacy-whole-match') => {
    const input = document([
      [-79.4000, 43.6500], [-79.3997, 43.6500], [-79.3990, 43.6500], [-79.3987, 43.6500],
    ], { gapBeforeIndex: 2 });
    mutate(input);
    const fetch = vi.fn((url: string) => Promise.resolve(new Response(JSON.stringify(
      url.includes('/route/v1/driving/')
        ? routeResponse()
        : osrmMatchResponse(readRequestedCoordinates(url)),
    ))));

    const result = await new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { ontario: 'http://osrm-ontario:5000' }, fetch,
      ...(classificationMode === undefined ? {} : { classificationMode }),
    }).match(input);

    expect((fetch.mock.calls as unknown as Array<[string]>).filter(([url]) => (
      String(url).includes('/route/v1/driving/')
    ))).toHaveLength(0);
    expect(result?.inferredRanges ?? []).toEqual([]);
  });

  test.each(['missing-alternatives', 'string-waypoint'])('rejects malformed %s tracepoint metadata', async (kind) => {
    const input = document([[-79.4, 43.65], [-79.3995, 43.6502]]);
    const payload = osrmMatchResponse(input.coordinates);
    if (kind === 'missing-alternatives') {
      delete (payload.tracepoints[0] as unknown as Record<string, unknown>).alternatives_count;
    }
    if (kind === 'string-waypoint') {
      (payload.tracepoints[1] as unknown as Record<string, unknown>).waypoint_index = '1';
    }
    const result = await new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { ontario: 'http://osrm-ontario:5000' },
      fetch: vi.fn(() => Promise.resolve(new Response(JSON.stringify(payload)))),
    }).match(input);

    expect(result?.matchedGeometry).toBeNull();
    expect(result?.unmatchedRanges).toEqual([expect.objectContaining({ interpolationLevel: 2 })]);
  });

  test('requires a known nonempty driver before supplementing a missing edge', async () => {
    const input = supplementInput();
    input.samples.forEach((sample) => { sample.driverId = null; });
    const fetch = supplementFetch();
    const result = await new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { ontario: 'http://osrm-ontario:5000' }, fetch,
    }).match(input);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result?.inferredRanges).toEqual([]);
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
    const fetch = supplementFetch();
    const provider = new OsrmRouteTrackingRoadMatchProvider({ baseUrls: { ontario: 'http://osrm-ontario:5000' }, fetch });

    const result = await provider.match(input);

    expect(result?.inferredRanges).not.toContainEqual(expect.objectContaining({
      startSourceIndex: 1,
      endSourceIndex: 3,
    }));
  });

  test('falls back to a road bridge request when a retained anchor is too poor for the strict supplement', async () => {
    const input = supplementInput();
    input.samples[1]!.accuracyMeters = 51;
    const fetch = supplementFetch();
    const provider = new OsrmRouteTrackingRoadMatchProvider({ baseUrls: { ontario: 'http://osrm-ontario:5000' }, fetch });

    const result = await provider.match(input);

    const urls = (fetch.mock.calls as unknown as Array<[string]>).map(([url]) => String(url));
    expect(urls.filter((url) => url.includes('/match/v1/driving/'))).toHaveLength(1);
    expect(urls.filter((url) => url.includes('/route/v1/driving/'))).toHaveLength(1);
    expect(result?.inferredGeometry).toBeNull();
  });

  test('leaves a fix above 200 m out of the request and reports the unmatched tail by reason', async () => {
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
      const left = osrmMatchResponse(input.coordinates.slice(0, 2));
      const right = osrmMatchResponse(input.coordinates.slice(4, 6));
      const payload = matchCall++ === 0
        ? left
        : { ...right, tracepoints: [null, ...right.tracepoints] };
      return Promise.resolve(new Response(JSON.stringify(payload)));
    });
    const provider = new OsrmRouteTrackingRoadMatchProvider({ baseUrls: { ontario: 'http://osrm-ontario:5000' }, fetch });

    const result = await provider.match(input);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String((fetch.mock.calls as unknown as Array<[string]>)[0]![0])).not.toContain('-79.3994,43.6501');
    expect(result?.matchedRanges).toEqual([expect.objectContaining({ startSourceIndex: 0, endSourceIndex: 1 })]);
    expect(result?.unmatchedRanges).toEqual([
      expect.objectContaining({ startEventId: 'event-2', endEventId: 'event-2', reason: 'LOW_ACCURACY' }),
      expect.objectContaining({ startEventId: 'event-3', endEventId: 'event-5', reason: 'NO_MATCH' }),
    ]);
    expect(result?.inferredGeometry).toBeNull();
  });

  test.each([
    ['low-confidence', supplementMatchResponse({ confidence: 0.49 })],
    ['ambiguous', supplementMatchResponse({ ambiguous: true })],
    ['partial', supplementMatchResponse({ partial: true })],
  ])('rejects a %s multi-point match supplement', async (_label, matchPayload) => {
    const fetch = supplementFetch(matchPayload);
    const provider = new OsrmRouteTrackingRoadMatchProvider({ baseUrls: { ontario: 'http://osrm-ontario:5000' }, fetch });

    const result = await provider.match(supplementInput());

    // Match, strict supplement, then the general bridge attempt that the stub cannot satisfy.
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(result?.inferredGeometry).toBeNull();
    expect(result?.inferredRanges).toEqual([]);
  });

  test('does not publish a partial cache candidate when a supplement request is retryable', async () => {
    const baseFetch = supplementFetch();
    let call = 0;
    const fetch = vi.fn((url: string) => (
      call++ === 0 ? baseFetch(url) : Promise.reject(new Error('temporary OSRM failure'))
    ));
    const provider = new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { ontario: 'http://osrm-ontario:5000' }, fetch,
    });

    await expect(provider.match(supplementInput())).resolves.toBeNull();
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
      fetch: supplementFetch(),
    });
    const path = await provider.match(supplementInput());
    expect(path).not.toBeNull();
    const write = buildRouteTrackingRoadMatchCacheWrite(path!);

    const restored = buildRouteTrackingRoadMatchedPath(trackingRecord(write));

    expect(write.roadMatchedSchemaVersion).toBe('route_tracking_road_match.v5');
    expect(restored?.qualityVersion).toBe('gps_quality.v4');
    expect(restored?.inferredGeometry?.coordinates).toEqual([supplementRouteCoordinates()]);
    expect(restored?.inferredRanges).toEqual([expect.objectContaining({
      startEventId: 'event-1', endEventId: 'event-3', reason: 'LOW_ACCURACY',
    })]);
  });

  test('round-trips a v4 rejection-only payload without reviving raw fallback', async () => {
    const provider = new OsrmRouteTrackingRoadMatchProvider({
      baseUrls: { ontario: 'http://osrm-ontario:5000' },
      fetch: vi.fn(() => Promise.resolve(new Response(JSON.stringify({ code: 'NoMatch' })))),
    });
    const outcome = await provider.matchWithStatus(document([[-79.4, 43.65], [-79.3995, 43.6502]]));
    expect(outcome.path).not.toBeNull();

    const write = buildRouteTrackingRoadMatchCacheWrite(outcome.path!);
    const restored = buildRouteTrackingRoadMatchedPath(trackingRecord(write));

    expect(restored).toEqual(expect.objectContaining({
      matchedGeometry: null,
      matchedPointCount: 0,
      qualityVersion: 'gps_quality.v4',
      uncertainGeometry: null,
    }));
    expect(restored?.unmatchedRanges).toEqual([expect.objectContaining({ interpolationLevel: 2 })]);
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
      accuracyMeters: 20,
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

function rawEvidenceFromDocument(input: RouteTrackingGeometryDocumentV1): RouteTrackingGeometryPositionInput[] {
  return input.samples.map((sample, index) => ({
    ...(sample.accuracyMeters === undefined ? {} : { accuracyMeters: sample.accuracyMeters }),
    driverId: sample.driverId,
    eventId: sample.eventId,
    latitude: input.coordinates[index]![1],
    longitude: input.coordinates[index]![0],
    occurredAt: sample.occurredAt,
    receivedAt: sample.receivedAt,
    routePlanId: 'route-1',
  }));
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

function observedNoMatchFetch(input: RouteTrackingGeometryDocumentV1, options: { alternate?: boolean } = {}) {
  return vi.fn((url: string) => {
    if (url.includes('/route/v1/driving/')) {
      const coordinates = input.coordinates.slice(1, 5);
      return Promise.resolve(new Response(JSON.stringify({
        code: 'Ok',
        routes: [
          { distance: 70, duration: 30, geometry: { coordinates, type: 'LineString' } },
          ...(options.alternate ? [{
            distance: 75,
            duration: 32,
            geometry: { coordinates: [coordinates[0], [-79.3996, 43.6501], coordinates.at(-1)], type: 'LineString' },
          }] : []),
        ],
        waypoints: [{ location: coordinates[0] }, { location: coordinates.at(-1) }],
      })));
    }
    return Promise.resolve(new Response(JSON.stringify(osrmMatchResponse(input.coordinates, { nullIndexes: [2, 3] }))));
  });
}

function continuousNoMatchInput(pointCount: number): RouteTrackingGeometryDocumentV1 {
  const input = document(Array.from({ length: pointCount }, (_, index): [number, number] => (
    [-81.2500 + index * 0.0001, 42.9800]
  )), { intervalMs: 5_000 });
  input.samples.forEach((sample, index) => {
    sample.gapBefore = false;
    sample.sourceIndex = index;
  });
  return input;
}

function continuousNoMatchFetch(
  input: RouteTrackingGeometryDocumentV1,
  routeOptions?: (coordinates: Array<[number, number]>) => {
    ambiguous?: boolean;
    interiorOffCorridor?: boolean;
  },
  matchedPrefix = 0,
) {
  return vi.fn((url: string) => {
    if (url.includes('/route/v1/driving/')) {
      const requested = readRequestedCoordinates(url);
      const options = routeOptions?.(requested) ?? {};
      const geometry = options.interiorOffCorridor
        ? [
            requested[0]!,
            [(requested[0]![0] + requested.at(-1)![0]) / 2, requested[0]![1] + 0.0007] as [number, number],
            requested.at(-1)!,
          ]
        : requested;
      const distance = options.interiorOffCorridor ? 180 : Math.max(20, (requested.length - 1) * 9);
      const duration = Math.max(10, (requested.length - 1) * 4);
      return Promise.resolve(new Response(JSON.stringify({
        code: 'Ok',
        routes: [
          { distance, duration, geometry: { coordinates: geometry, type: 'LineString' } },
          ...(options.ambiguous ? [{
            distance: distance * 1.1,
            duration: duration * 1.1,
            geometry: {
              coordinates: [requested[0], [requested[1]![0], requested[1]![1] + 0.0001], requested.at(-1)],
              type: 'LineString',
            },
          }] : []),
        ],
        waypoints: [{ location: requested[0] }, { location: requested.at(-1) }],
      })));
    }
    const requested = readRequestedCoordinates(url);
    const firstSourceIndex = input.coordinates.findIndex(([longitude, latitude]) => (
      longitude === requested[0]?.[0] && latitude === requested[0]?.[1]
    ));
    const nullIndexes = requested.map((_, index) => index).filter((index) => (
      firstSourceIndex + index >= matchedPrefix
    ));
    return Promise.resolve(new Response(JSON.stringify(osrmMatchResponse(requested, { nullIndexes }))));
  });
}

function recordedGapInput(): RouteTrackingGeometryDocumentV1 {
  const input = document([
    [-79.4110, 43.6500],
    [-79.4105, 43.6500],
    [-79.4100, 43.6500],
    [-79.4095, 43.6500],
    [-79.3920, 43.6500],
    [-79.3915, 43.6500],
    [-79.3910, 43.6500],
    [-79.3905, 43.6500],
  ], { intervalMs: 30_000 });
  input.samples.forEach((sample, index) => {
    sample.accuracyMeters = index === 3 ? 2.12 : index === 4 ? 27.92 : 20;
    sample.gapBefore = index === 4;
    sample.sourceIndex = index;
  });
  input.samples.slice(4).forEach((sample, offset) => {
    sample.occurredAt = new Date(Date.parse('2026-07-21T00:05:04.000Z') + offset * 30_000).toISOString();
    sample.receivedAt = new Date(Date.parse('2026-07-21T00:05:05.000Z') + offset * 30_000).toISOString();
  });
  return input;
}

function recordedGapRoute(input: RouteTrackingGeometryDocumentV1): Array<[number, number]> {
  return [
    input.coordinates[3]!,
    [-79.4005, 43.6504],
    input.coordinates[4]!,
  ];
}

function recordedGapFetch(
  input: RouteTrackingGeometryDocumentV1,
  options: { ambiguous?: boolean; dishonestGeometry?: boolean } = {},
) {
  return vi.fn((url: string) => {
    if (url.includes('/route/v1/driving/')) {
      const coordinates = options.dishonestGeometry
        ? [
            input.coordinates[3]!,
            [-79.4095, 44.0000] as [number, number],
            [-79.3920, 44.0000] as [number, number],
            input.coordinates[4]!,
          ]
        : recordedGapRoute(input);
      return Promise.resolve(new Response(JSON.stringify({
        code: 'Ok',
        routes: [
          { distance: 1_500, duration: 200, geometry: { coordinates, type: 'LineString' } },
          ...(options.ambiguous ? [{
            distance: 1_550,
            duration: 205,
            geometry: {
              coordinates: [coordinates[0], [-79.4005, 43.6496], coordinates.at(-1)],
              type: 'LineString',
            },
          }] : []),
        ],
        waypoints: [
          { location: input.coordinates[3] },
          { location: input.coordinates[4] },
        ],
      })));
    }
    const requested = readRequestedCoordinates(url);
    const isLeft = requested[0]?.[0] === input.coordinates[0]?.[0];
    return Promise.resolve(new Response(JSON.stringify(osrmMatchResponse(requested, {
      nullIndexes: isLeft ? [2, 3] : [0, 1],
    }))));
  });
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
    sample.accuracyMeters = index === 2 ? 150 : 20;
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

function contextualSupplementInput(): RouteTrackingGeometryDocumentV1 {
  const input = document([
    [-79.4060, 43.6500],
    [-79.4055, 43.6500],
    [-79.4048, 43.6501],
    [-79.4040, 43.6502],
    [-79.4032, 43.6501],
    [-79.4025, 43.6500],
    [-79.4020, 43.6500],
  ], { intervalMs: 60_000 });
  input.samples.forEach((sample, index) => {
    sample.accuracyMeters = index >= 2 && index <= 4 ? 260 : 20;
    sample.gapBefore = false;
    sample.sourceIndex = index;
  });
  return input;
}

function contextualSupplementRoute(): Array<[number, number]> {
  return [
    [-79.4055, 43.6500],
    [-79.4048, 43.6501],
    [-79.4040, 43.6502],
    [-79.4032, 43.6501],
    [-79.4025, 43.6500],
  ];
}

function contextualSupplementFetch(
  input: RouteTrackingGeometryDocumentV1,
  options: { ambiguous?: boolean; offCorridor?: boolean } = {},
) {
  return vi.fn((url: string) => {
    if (url.includes('/route/v1/driving/')) {
      const coordinates = options.offCorridor
        ? [
            [-79.4055, 43.6500],
            [-79.4040, 43.7000],
            [-79.4025, 43.6500],
          ]
        : contextualSupplementRoute();
      return Promise.resolve(new Response(JSON.stringify({
        code: 'Ok',
        routes: [
          { distance: 260, duration: 180, geometry: { coordinates, type: 'LineString' } },
          ...(options.ambiguous ? [{
            distance: 275,
            duration: 185,
            geometry: {
              coordinates: [
                [-79.4055, 43.6500],
                [-79.4040, 43.6490],
                [-79.4025, 43.6500],
              ],
              type: 'LineString',
            },
          }] : []),
        ],
        waypoints: [
          { location: input.coordinates[1] },
          { location: input.coordinates[5] },
        ],
      })));
    }
    const requested = readRequestedCoordinates(url);
    return Promise.resolve(new Response(JSON.stringify(osrmMatchResponse(requested))));
  });
}

function supplementFetch(supplementPayload: unknown = supplementMatchResponse()) {
  let matchCall = 0;
  return vi.fn((url: string) => {
    const coordinateText = decodeURIComponent(new URL(url).pathname.split('/').at(-1) ?? '');
    const requestedCoordinates = coordinateText.split(';').map((coordinate) => (
      coordinate.split(',').map(Number) as [number, number]
    ));
    const pointCount = requestedCoordinates.length;
    if (pointCount === 2 || (pointCount === 3 && matchCall === 0)) {
      return Promise.resolve(new Response(JSON.stringify(osrmMatchResponse(requestedCoordinates))));
    }
    if (matchCall++ > 0) return Promise.resolve(new Response(JSON.stringify(supplementPayload)));
    const left = osrmMatchResponse(requestedCoordinates.slice(0, 2));
    const right = osrmMatchResponse(requestedCoordinates.slice(3, 5));
    const middle = requestedCoordinates[2]!;
    return Promise.resolve(new Response(JSON.stringify({
      code: 'Ok',
      matchings: [
        left.matchings[0],
        right.matchings[0],
        { confidence: 0.9, distance: 0, duration: 0, geometry: { coordinates: [middle, middle], type: 'LineString' }, legs: [] },
      ],
      tracepoints: [
        { alternatives_count: 0, location: [-79.4000, 43.6500], matchings_index: 0, waypoint_index: 0 },
        { alternatives_count: 0, location: [-79.3995, 43.6500], matchings_index: 0, waypoint_index: 1 },
        { alternatives_count: 0, location: [-79.3990, 43.6501], matchings_index: 2, waypoint_index: 0 },
        { alternatives_count: 0, location: [-79.3985, 43.6500], matchings_index: 1, waypoint_index: 0 },
        { alternatives_count: 0, location: [-79.3980, 43.6500], matchings_index: 1, waypoint_index: 1 },
      ],
    })));
  });
}

function supplementMatchResponse(options: { ambiguous?: boolean; confidence?: number; partial?: boolean } = {}) {
  return {
    code: 'Ok',
    matchings: [{
      confidence: options.confidence ?? 0.9,
      distance: 100,
      duration: 60,
      geometry: { coordinates: supplementRouteCoordinates(), type: 'LineString' },
    }],
    tracepoints: [
      { alternatives_count: options.ambiguous ? 1 : 0, location: [-79.3995, 43.6500], matchings_index: 0, waypoint_index: 0 },
      ...(options.partial ? [null] : [{ alternatives_count: 0, location: [-79.3990, 43.6502], matchings_index: 0, waypoint_index: 1 }]),
      { alternatives_count: 0, location: [-79.3985, 43.6500], matchings_index: 0, waypoint_index: 2 },
    ],
  };
}

function osrmMatchResponse(
  coordinates: Array<[number, number]>,
  options: {
    confidence?: number;
    geometry?: Array<[number, number]>;
    nullIndexes?: number[];
  } = {},
) {
  const nullIndexes = new Set(options.nullIndexes ?? []);
  const retained = coordinates.flatMap((coordinate, index) => nullIndexes.has(index) ? [] : [{ coordinate, index }]);
  return {
    code: 'Ok',
    matchings: [{
      confidence: options.confidence ?? 0.9,
      distance: Math.max(1, retained.length - 1) * 30,
      duration: Math.max(1, retained.length - 1) * 20,
      geometry: { coordinates: options.geometry ?? retained.map(({ coordinate }) => coordinate), type: 'LineString' },
      legs: retained.slice(0, -1).map(({ coordinate }, waypointIndex) => ({
        distance: 30,
        duration: 20,
        steps: [
          { geometry: { coordinates: [coordinate, retained[waypointIndex + 1]!.coordinate], type: 'LineString' } },
          { geometry: { coordinates: [retained[waypointIndex + 1]!.coordinate, retained[waypointIndex + 1]!.coordinate], type: 'LineString' } },
        ],
      })),
    }],
    tracepoints: coordinates.map((location, index) => nullIndexes.has(index) ? null : {
      alternatives_count: 0,
      location,
      matchings_index: 0,
      waypoint_index: retained.findIndex((item) => item.index === index),
    }),
  };
}

function readRequestedCoordinates(url: string): Array<[number, number]> {
  return decodeURIComponent(new URL(url).pathname.split('/').at(-1) ?? '')
    .split(';')
    .map((coordinate) => coordinate.split(',').map(Number) as [number, number]);
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
