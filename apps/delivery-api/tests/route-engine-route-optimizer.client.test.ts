import { describe, expect, test, vi } from 'vitest';

import { RouteEngineRouteOptimizationClient } from '../src/modules/route-plans/route-engine-route-optimizer.client.js';
import type { RoutePlanDetail } from '../src/modules/route-plans/route-plan.types.js';

type TestFetchInit = {
  body: string;
  headers: Record<string, string>;
  method: 'POST';
  signal?: AbortSignal;
};
type TestFetchLike = (url: string, init: TestFetchInit) => Promise<Response>;

const detail = {
  routePlan: {
    createdAt: '2026-06-08T12:30:00.000Z',
    deliveryAreas: ['Scarborough'],
    deliveryDays: ['Friday'],
    depot: { latitude: 43.6532, longitude: -79.3832 },
    id: 'route-plan-id',
    missingCoordinates: 1,
    name: 'Friday route',
    planDate: '2026-06-12',
    routeEndMode: 'END_AT_LAST_STOP',
    status: 'DRAFT',
    stopsCount: 3,
    updatedAt: '2026-06-08T12:30:00.000Z'
  },
  routeGeometry: null,
  routeMetrics: null,
  routeStopPoints: [],
  stops: [
    routeStop({ deliveryStopId: 'stop-1', latitude: 43.7764, longitude: -79.2571, sequence: 1 }),
    routeStop({ deliveryStopId: 'stop-2', latitude: 43.8561, longitude: -79.3370, sequence: 2 }),
    routeStop({ deliveryStopId: 'stop-3', latitude: null, longitude: null, sequence: 3 })
  ]
} satisfies RoutePlanDetail;

describe('RouteEngineRouteOptimizationClient', () => {
  test('requires explicit base URL and bearer token configuration', () => {
    expect(() => new RouteEngineRouteOptimizationClient({ baseUrl: '', internalToken: 'secret' })).toThrow(
      'ROUTE_ENGINE_BASE_URL must be configured explicitly.'
    );
    expect(() => new RouteEngineRouteOptimizationClient({ baseUrl: 'http://route-engine:8080', internalToken: '' })).toThrow(
      'ROUTE_ENGINE_INTERNAL_TOKEN is required when ROUTE_ENGINE_BASE_URL is set.'
    );
  });

  test('posts the committed route_engine solve contract and maps the returned stop sequence', async () => {
    const fetch = vi.fn<TestFetchLike>().mockResolvedValue(
      Response.json({
        request_id: 'route-plan:route-plan-id:optimize',
        status: 'solved',
        result: {
          routes: [
            {
              driver_id: 'driver-1',
              stop_sequence: [
                { stop_id: 'route-stop-2', sequence: 1 },
                { stop_id: 'route-stop-1', sequence: 2 }
              ],
              summary: { total_stops: 2, total_distance_meters: 1000, total_duration_seconds: 300 }
            }
          ],
          unassigned_stop_ids: [],
          summary: { total_stops: 2, total_distance_meters: 1000, total_duration_seconds: 300 }
        },
        engine: {
          name: 'route_engine',
          version: '0.1.0',
          graph_status: 'ready',
          external_calls: false
        }
      })
    );
    const client = new RouteEngineRouteOptimizationClient({
      baseUrl: 'http://route-engine.internal:8080/',
      fetch,
      internalToken: 'internal-token',
      serviceRegion: 'ontario',
      timeoutMs: 2500
    });

    const result = await client.optimizeStopOrder({ detail, shopDomain: 'tenant-a.example.test' });

    const fetchCall = fetch.mock.calls[0];
    if (fetchCall === undefined) {
      throw new Error('route_engine fetch was not called');
    }
    const [url, init] = fetchCall;
    expect(url).toBe('http://route-engine.internal:8080/v1/solve');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      Accept: 'application/json',
      Authorization: 'Bearer internal-token',
      'Content-Type': 'application/json',
      'X-Request-Id': 'route-plan:route-plan-id:optimize',
      'X-Request-Timeout-Ms': '2500'
    });
    const requestBody = JSON.parse(init.body) as Record<string, unknown>;
    expect(requestBody).toMatchObject({
      request_id: 'route-plan:route-plan-id:optimize',
      tenant: { tenant_id: 'tenant-a.example.test', service_region: 'ontario' },
      depot: { depot_id: 'depot:route-plan-id', lat: 43.6532, lng: -79.3832 },
      drivers: [{ capacity: 2, driver_id: 'driver-1' }],
      options: { mode: 'road_graph', objective: 'minimize_duration', timeout_ms: 2500 }
    });
    expect((requestBody.options as Record<string, unknown>).return_to_depot).toBeUndefined();
    expect(requestBody).not.toHaveProperty('address_hint');
    expect(requestBody.stops).toEqual([
      { demand: 1, lat: 43.7764, lng: -79.2571, service_seconds: 0, stop_id: 'route-stop-1' },
      { demand: 1, lat: 43.8561, lng: -79.337, service_seconds: 0, stop_id: 'route-stop-2' }
    ]);
    expect(result).toEqual({
      missingCoordinateStops: 1,
      source: 'route_engine',
      stops: [
        { deliveryStopId: 'stop-2', sequence: 1, shopifyOrderGid: 'gid://woocommerce/Order/1002' },
        { deliveryStopId: 'stop-1', sequence: 2, shopifyOrderGid: 'gid://woocommerce/Order/1001' },
        { deliveryStopId: 'stop-3', sequence: 3, shopifyOrderGid: 'gid://woocommerce/Order/1003' }
      ]
    });
  });

  test('maps return-to-depot route end mode to route_engine without adding a delivery stop', async () => {
    const fetch = vi.fn<TestFetchLike>().mockResolvedValue(
      Response.json({
        request_id: 'route-plan:route-plan-id:optimize',
        status: 'solved',
        result: {
          routes: [
            {
              driver_id: 'driver-1',
              stop_sequence: [
                { stop_id: 'route-stop-1', sequence: 1 },
                { stop_id: 'route-stop-2', sequence: 2 }
              ],
              summary: { total_stops: 2, total_distance_meters: 5000, total_duration_seconds: 1500 }
            }
          ],
          unassigned_stop_ids: [],
          summary: { total_stops: 2, total_distance_meters: 5000, total_duration_seconds: 1500 }
        },
        engine: { name: 'route_engine', version: '0.1.0', graph_status: 'ready', external_calls: false }
      })
    );
    const client = new RouteEngineRouteOptimizationClient({ baseUrl: 'http://route-engine', fetch, internalToken: 'token' });

    const result = await client.optimizeStopOrder({
      detail: { ...detail, routePlan: { ...detail.routePlan, routeEndMode: 'RETURN_TO_DEPOT' } },
      shopDomain: 'tenant-a.example.test'
    });

    const requestBody = JSON.parse(fetch.mock.calls[0]?.[1].body ?? '{}') as Record<string, { return_to_depot?: boolean }>;
    expect(requestBody.options?.return_to_depot).toBe(true);
    expect(result?.stops).toHaveLength(3);
    expect(result?.stops.map((stop) => stop.deliveryStopId)).toEqual(['stop-1', 'stop-2', 'stop-3']);
  });

  test('defaults route_engine solve timeout to the route_engine contract maximum', async () => {
    const fetch = vi.fn<TestFetchLike>().mockResolvedValue(
      Response.json({
        request_id: 'route-plan:route-plan-id:optimize',
        status: 'solved',
        result: { routes: [{ driver_id: 'driver-1', stop_sequence: [] }], unassigned_stop_ids: [], summary: {} },
        engine: { name: 'route_engine', version: '0.1.0', graph_status: 'ready', external_calls: false }
      })
    );
    const client = new RouteEngineRouteOptimizationClient({ baseUrl: 'http://route-engine', fetch, internalToken: 'token' });

    await client.optimizeStopOrder({ detail, shopDomain: 'tenant-a.example.test' });

    const init = fetch.mock.calls[0]?.[1];
    expect(init?.headers['X-Request-Timeout-Ms']).toBe('180000');
    expect(JSON.parse(init?.body ?? '{}')).toMatchObject({ options: { timeout_ms: 180000 } });
  });

  test('appends unassigned and omitted routable stops after assigned route_engine stops', async () => {
    const fetch = vi.fn<TestFetchLike>().mockResolvedValue(
      Response.json({
        request_id: 'route-plan:route-plan-id:optimize',
        status: 'solved',
        result: {
          routes: [{ driver_id: 'driver-1', stop_sequence: [{ stop_id: 'route-stop-2', sequence: 1 }], summary: {} }],
          unassigned_stop_ids: ['route-stop-1'],
          summary: {}
        },
        engine: { name: 'route_engine', version: '0.1.0', graph_status: 'ready', external_calls: false }
      })
    );
    const client = new RouteEngineRouteOptimizationClient({ baseUrl: 'http://route-engine', fetch, internalToken: 'token' });

    const result = await client.optimizeStopOrder({ detail, shopDomain: 'tenant-a.example.test' });

    expect(result?.stops.map((stop) => stop.deliveryStopId)).toEqual(['stop-2', 'stop-1', 'stop-3']);
  });

  test('returns null without calling route_engine when required depot coordinates are missing', async () => {
    const fetch = vi.fn<TestFetchLike>();
    const client = new RouteEngineRouteOptimizationClient({ baseUrl: 'http://route-engine', fetch, internalToken: 'token' });

    await expect(
      client.optimizeStopOrder({
        detail: { ...detail, routePlan: { ...detail.routePlan, depot: { latitude: null, longitude: null } } },
        shopDomain: 'tenant-a.example.test'
      })
    ).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });



  test('returns typed graph-not-ready diagnostics for job-backed optimization', async () => {
    const fetch = vi.fn<TestFetchLike>().mockResolvedValue(
      Response.json({ detail: 'GRAPH_NOT_READY' }, { status: 503 })
    );
    const client = new RouteEngineRouteOptimizationClient({ baseUrl: 'http://route-engine', fetch, internalToken: 'token' });

    const outcome = await client.optimizeStopOrderWithDiagnostics({ detail, shopDomain: 'tenant-a.example.test' });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('Expected route_engine graph-not-ready failure.');
    expect(outcome.failure.code).toBe('graph_not_ready');
    expect(outcome.failure.httpStatus).toBe(503);
    await expect(client.optimizeStopOrder({ detail, shopDomain: 'tenant-a.example.test' })).resolves.toBeNull();
  });

  test('returns invalid-input diagnostics with route_engine validation details', async () => {
    const fetch = vi.fn<TestFetchLike>().mockResolvedValue(
      Response.json(
        {
          error: {
            code: 'VALIDATION_FAILED',
            message: 'Request does not satisfy the route_engine solve contract.',
            details: { fields: ['options.return_to_depot is not allowed'] }
          }
        },
        { status: 422 }
      )
    );
    const client = new RouteEngineRouteOptimizationClient({ baseUrl: 'http://route-engine', fetch, internalToken: 'token' });

    const outcome = await client.optimizeStopOrderWithDiagnostics({ detail, shopDomain: 'tenant-a.example.test' });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('Expected route_engine invalid-input failure.');
    expect(outcome.failure.code).toBe('invalid_input');
    expect(outcome.failure.httpStatus).toBe(422);
    expect(outcome.failure.message).toContain('options.return_to_depot is not allowed');
  });

  test('returns typed invalid-input diagnostics when route cannot be sent to route_engine', async () => {
    const fetch = vi.fn<TestFetchLike>();
    const client = new RouteEngineRouteOptimizationClient({ baseUrl: 'http://route-engine', fetch, internalToken: 'token' });

    const outcome = await client.optimizeStopOrderWithDiagnostics({
      detail: { ...detail, routePlan: { ...detail.routePlan, depot: { latitude: null, longitude: null } } },
      shopDomain: 'tenant-a.example.test'
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('Expected route_engine invalid-input failure.');
    expect(outcome.failure.code).toBe('invalid_input');
    expect(fetch).not.toHaveBeenCalled();
  });

  test('returns null for route_engine HTTP or payload failures', async () => {
    const failingResponses = [new Response(null, { status: 503 }), Response.json({ status: 'solved', result: { routes: 'bad' } })];

    for (const response of failingResponses) {
      const fetch = vi.fn<TestFetchLike>().mockResolvedValue(response);
      const client = new RouteEngineRouteOptimizationClient({ baseUrl: 'http://route-engine', fetch, internalToken: 'token' });
      await expect(client.optimizeStopOrder({ detail, shopDomain: 'tenant-a.example.test' })).resolves.toBeNull();
    }
  });
});

function routeStop(input: {
  deliveryStopId: string;
  latitude: number | null;
  longitude: number | null;
  sequence: number;
}): RoutePlanDetail['stops'][number] {
  const orderNumber = input.sequence + 1000;
  return {
    address: {
      address1: '123 Private Street',
      address2: null,
      city: 'Toronto',
      countryCode: 'CA',
      postalCode: 'M1M 1M1',
      province: 'ON'
    },
    attributes: [],
    coordinates: { latitude: input.latitude, longitude: input.longitude },
    deliveryArea: 'Scarborough',
    deliveryDay: 'Friday',
    deliveryStopId: input.deliveryStopId,
    financialStatus: 'paid',
    fulfillmentStatus: null,
    orderId: `order-${input.sequence}`,
    orderName: `#${orderNumber}`,
    paymentStatus: 'PAID',
    recipientName: 'Private Recipient',
    sequence: input.sequence,
    shopifyOrderGid: `gid://woocommerce/Order/${orderNumber}`,
    status: 'PENDING'
  };
}
