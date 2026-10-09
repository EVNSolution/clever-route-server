import { describe, expect, test, vi } from 'vitest';

import { VroomRouteOptimizationClient } from '../src/modules/route-plans/vroom-route-optimizer.client.js';
import type { RoutePlanDetail } from '../src/modules/route-plans/route-plan.types.js';

type TestFetchInit = {
  body: string;
  headers: Record<string, string>;
  method: 'POST';
  redirect: 'error';
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
    updatedAt: '2026-06-08T12:30:00.000Z',
  },
  routeGeometry: null,
  routeMetrics: null,
  routeStopPoints: [],
  stops: [
    routeStop({ deliveryStopId: 'stop-1', latitude: 43.7764, longitude: -79.2571, sequence: 1 }),
    routeStop({ deliveryStopId: 'stop-2', latitude: 43.8561, longitude: -79.337, sequence: 2 }),
    routeStop({ deliveryStopId: 'stop-3', latitude: null, longitude: null, sequence: 3 }),
  ],
} satisfies RoutePlanDetail;

describe('VroomRouteOptimizationClient', () => {
  test('uses the toll-avoiding table as a custom matrix with contiguous indexes including return depot', async () => {
    const matrixFetch = vi.fn().mockResolvedValue(Response.json({ code: 'Ok',
      durations: [[0, 10.2, 20.6], [11, 0, 33], [22, 34, 0]],
      distances: [[0, 100, 200], [110, 0, 330], [220, 340, 0]] }));
    const fetch = vi.fn<TestFetchLike>().mockResolvedValue(Response.json({ code: 0,
      routes: [{ steps: [{ type: 'start' }, { type: 'job', job: 2 }, { type: 'job', job: 1 }, { type: 'end' }] }], unassigned: [] }));
    const client = new VroomRouteOptimizationClient({ baseUrl: 'http://vroom:3000', osrmBaseUrl: 'http://osrm-ontario:5000', matrixFetch, fetch });
    const result = await client.optimizeStopOrder({ detail: { ...detail, routePlan: { ...detail.routePlan, tollPolicy: 'AVOID_TOLLS', routeEndMode: 'RETURN_TO_DEPOT' } }, shopDomain: 'tenant-a.example.test' });
    expect(matrixFetch.mock.calls[0]?.[0]).toBe('http://osrm-ontario:5000/table/v1/driving/-79.3832,43.6532;-79.2571,43.7764;-79.337,43.8561?annotations=duration,distance&exclude=toll');
    const request: unknown = JSON.parse(fetch.mock.calls[0]![1].body);
    expect(request).toMatchObject({
      matrices: { car: {
        durations: [[0, 10, 21], [11, 0, 33], [22, 34, 0]],
        distances: [[0, 100, 200], [110, 0, 330], [220, 340, 0]]
      } },
      jobs: [{ location_index: 1 }, { location_index: 2 }],
      vehicles: [{ start_index: 0, end_index: 0 }]
    });
    expect(result?.stops[0]?.deliveryStopId).toBe('stop-2');
  });

  test.each([
    { code: 'InvalidValue' },
    { code: 'Ok', durations: [[0, null, 1], [1, 0, 2], [1, 2, 0]], distances: [[0, 1, 1], [1, 0, 2], [1, 2, 0]] },
    { code: 'Ok', durations: [[0]], distances: [[0]] },
    { code: 'Ok', durations: [[0, 1, 2], [1, 0, 2], [1, 2, 0]], distances: [[0, 1, 2], [1, 0, 2], [1, 2, 0]], fallback_speed_cells: [[0, 1]] },
  ])('never calls VROOM or allows tolls when the constrained matrix is incomplete: %j', async (payload) => {
    const matrixFetch = vi.fn().mockResolvedValue(Response.json(payload));
    const fetch = vi.fn<TestFetchLike>();
    const client = new VroomRouteOptimizationClient({ baseUrl: 'http://vroom:3000', osrmBaseUrl: 'http://osrm-ontario:5000', matrixFetch, fetch });
    const outcome = await client.optimizeStopOrderWithDiagnostics({ detail: { ...detail, routePlan: { ...detail.routePlan, tollPolicy: 'AVOID_TOLLS' } }, shopDomain: 'tenant-a.example.test' });
    expect(outcome.ok).toBe(false);
    expect(matrixFetch).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  test('requires the matching OSRM graph when avoiding tolls', async () => {
    const fetch = vi.fn<TestFetchLike>();
    const outcome = await new VroomRouteOptimizationClient({ baseUrl: 'http://vroom:3000', fetch }).optimizeStopOrderWithDiagnostics({
      detail: { ...detail, routePlan: { ...detail.routePlan, tollPolicy: 'AVOID_TOLLS' } }, shopDomain: 'tenant-a.example.test' });
    expect(outcome).toMatchObject({ ok: false, failure: { code: 'optimizer_unavailable' } });
    expect(fetch).not.toHaveBeenCalled();
  });

  test('requires explicit VROOM base URL configuration', () => {
    expect(() => new VroomRouteOptimizationClient({ baseUrl: '' })).toThrow(
      'VROOM base URL must be configured explicitly.',
    );
  });

  test('posts VROOM solve contract with [lng,lat] locations and maps the returned job sequence', async () => {
    const fetch = vi.fn<TestFetchLike>().mockResolvedValue(
      Response.json({
        code: 0,
        routes: [
          {
            steps: [
              { type: 'start', location: [-79.3832, 43.6532] },
              { type: 'job', id: 2, job: 2, location: [-79.337, 43.8561] },
              { type: 'job', id: 1, job: 1, location: [-79.2571, 43.7764] },
            ],
          },
        ],
        summary: { cost: 1000, duration: 1000 },
        unassigned: [],
      }),
    );
    const client = new VroomRouteOptimizationClient({ baseUrl: 'http://vroom:3000/', fetch, timeoutMs: 2500 });

    const result = await client.optimizeStopOrder({ detail, shopDomain: 'tenant-a.example.test' });

    const fetchCall = fetch.mock.calls[0];
    if (fetchCall === undefined) throw new Error('VROOM fetch was not called');
    const [url, init] = fetchCall;
    expect(url).toBe('http://vroom:3000/');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect(init.headers).toEqual({ Accept: 'application/json', 'Content-Type': 'application/json' });
    const requestBody = JSON.parse(init.body) as Record<string, unknown>;
    expect(requestBody).toEqual({
      jobs: [
        { delivery: [1], id: 1, location: [-79.2571, 43.7764], service: 0 },
        { delivery: [1], id: 2, location: [-79.337, 43.8561], service: 0 },
      ],
      vehicles: [
        {
          capacity: [2],
          id: 1,
          profile: 'car',
          start: [-79.3832, 43.6532],
        },
      ],
    });
    expect(result).toEqual({
      missingCoordinateStops: 1,
      source: 'vroom',
      stops: [
        { deliveryStopId: 'stop-2', sequence: 1, shopifyOrderGid: 'gid://woocommerce/Order/1002' },
        { deliveryStopId: 'stop-1', sequence: 2, shopifyOrderGid: 'gid://woocommerce/Order/1001' },
        { deliveryStopId: 'stop-3', sequence: 3, shopifyOrderGid: 'gid://woocommerce/Order/1003' },
      ],
    });
  });

  test('maps return-to-store mode to the VROOM vehicle end without adding a delivery stop', async () => {
    const fetch = vi.fn<TestFetchLike>().mockResolvedValue(
      Response.json({
        code: 0,
        routes: [{ steps: [{ type: 'start' }, { type: 'job', job: 1 }, { type: 'job', job: 2 }, { type: 'end' }] }],
        unassigned: [],
      }),
    );
    const client = new VroomRouteOptimizationClient({ baseUrl: 'http://vroom:3000', fetch });

    const result = await client.optimizeStopOrder({
      detail: { ...detail, routePlan: { ...detail.routePlan, routeEndMode: 'RETURN_TO_DEPOT' } },
      shopDomain: 'tenant-a.example.test',
    });

    const requestBody = JSON.parse(fetch.mock.calls[0]?.[1].body ?? '{}') as { vehicles?: Array<Record<string, unknown>> };
    expect(requestBody.vehicles?.[0]?.end).toEqual([-79.3832, 43.6532]);
    expect(result?.stops.map((stop) => stop.deliveryStopId)).toEqual(['stop-1', 'stop-2', 'stop-3']);
  });

  test('returns typed diagnostics when VROOM leaves jobs unassigned', async () => {
    const fetch = vi.fn<TestFetchLike>().mockResolvedValue(
      Response.json({
        code: 0,
        routes: [{ steps: [{ type: 'start' }, { type: 'job', job: 1 }] }],
        unassigned: [{ id: 2 }],
      }),
    );
    const client = new VroomRouteOptimizationClient({ baseUrl: 'http://vroom:3000', fetch });

    const outcome = await client.optimizeStopOrderWithDiagnostics({ detail, shopDomain: 'tenant-a.example.test' });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('Expected VROOM unassigned failure.');
    expect(outcome.failure.code).toBe('invalid_engine_payload');
    expect(outcome.failure.message).toContain('unassigned jobs');
    await expect(client.optimizeStopOrder({ detail, shopDomain: 'tenant-a.example.test' })).resolves.toBeNull();
  });

  test('fails closed when VROOM omits an assigned job from route steps', async () => {
    const fetch = vi.fn<TestFetchLike>().mockResolvedValue(
      Response.json({
        code: 0,
        routes: [{ steps: [{ type: 'start' }, { type: 'job', job: 1 }] }],
        unassigned: [],
      }),
    );
    const client = new VroomRouteOptimizationClient({ baseUrl: 'http://vroom:3000', fetch });

    const outcome = await client.optimizeStopOrderWithDiagnostics({ detail, shopDomain: 'tenant-a.example.test' });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('Expected VROOM incomplete route failure.');
    expect(outcome.failure.code).toBe('invalid_engine_payload');
    expect(outcome.failure.message).toContain('did not produce an applicable stop sequence');
    await expect(client.optimizeStopOrder({ detail, shopDomain: 'tenant-a.example.test' })).resolves.toBeNull();
  });

  test('returns invalid-input diagnostics without calling VROOM when required depot coordinates are missing', async () => {
    const fetch = vi.fn<TestFetchLike>();
    const client = new VroomRouteOptimizationClient({ baseUrl: 'http://vroom:3000', fetch });

    const outcome = await client.optimizeStopOrderWithDiagnostics({
      detail: { ...detail, routePlan: { ...detail.routePlan, depot: { latitude: null, longitude: null } } },
      shopDomain: 'tenant-a.example.test',
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('Expected VROOM invalid-input failure.');
    expect(outcome.failure.code).toBe('invalid_input');
    expect(fetch).not.toHaveBeenCalled();
  });

  test('classifies VROOM HTTP validation and timeout responses', async () => {
    const validationFetch = vi.fn<TestFetchLike>().mockResolvedValue(Response.json({ error: 'bad request' }, { status: 400 }));
    const timeoutFetch = vi.fn<TestFetchLike>().mockResolvedValue(new Response(null, { status: 504 }));

    const validationOutcome = await new VroomRouteOptimizationClient({
      baseUrl: 'http://vroom:3000',
      fetch: validationFetch,
    }).optimizeStopOrderWithDiagnostics({ detail, shopDomain: 'tenant-a.example.test' });
    const timeoutOutcome = await new VroomRouteOptimizationClient({
      baseUrl: 'http://vroom:3000',
      fetch: timeoutFetch,
    }).optimizeStopOrderWithDiagnostics({ detail, shopDomain: 'tenant-a.example.test' });

    expect(validationOutcome.ok).toBe(false);
    expect(timeoutOutcome.ok).toBe(false);
    if (validationOutcome.ok || timeoutOutcome.ok) throw new Error('Expected VROOM failure outcomes.');
    expect(validationOutcome.failure.code).toBe('invalid_input');
    expect(timeoutOutcome.failure.code).toBe('solver_timeout');
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
      province: 'ON',
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
    status: 'PENDING',
  };
}
