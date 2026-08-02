import { describe, expect, test, vi } from 'vitest';

import { OsrmTripRouteOptimizationClient } from '../src/modules/route-plans/osrm-trip-route-optimizer.client.js';
import type { RoutePlanDetail } from '../src/modules/route-plans/route-plan.types.js';

type TestFetchLike = (
  url: string,
  init: { method: 'GET'; signal?: AbortSignal },
) => Promise<Response>;

const detail = {
  routePlan: {
    createdAt: '2026-07-31T00:00:00.000Z',
    deliveryAreas: ['서울'],
    deliveryDays: ['Friday'],
    depot: { latitude: 37.4563, longitude: 126.7052 },
    driverId: 'driver-1',
    id: 'route-plan-id',
    missingCoordinates: 1,
    name: '서울 배송',
    planDate: '2026-07-31',
    routeEndMode: 'END_AT_LAST_STOP',
    status: 'DRAFT',
    stopsCount: 3,
    updatedAt: '2026-07-31T00:00:00.000Z',
  },
  routeGeometry: null,
  routeMetrics: null,
  routeStopPoints: [],
  stops: [
    routeStop({ deliveryStopId: 'stop-1', latitude: 37.5665, longitude: 126.978, sequence: 1 }),
    routeStop({ deliveryStopId: 'stop-2', latitude: 37.5172, longitude: 127.0473, sequence: 2 }),
    routeStop({ deliveryStopId: 'stop-3', latitude: null, longitude: null, sequence: 3 }),
  ],
} satisfies RoutePlanDetail;

describe('OsrmTripRouteOptimizationClient', () => {
  test('uses Trip with a fixed depot and maps waypoint_index to the optimized stop order', async () => {
    const fetch = vi.fn<TestFetchLike>().mockResolvedValue(Response.json({
      code: 'Ok',
      trips: [{ distance: 1_000, duration: 300 }],
      waypoints: [
        { trips_index: 0, waypoint_index: 0 },
        { trips_index: 0, waypoint_index: 2 },
        { trips_index: 0, waypoint_index: 1 },
      ],
    }));
    const client = new OsrmTripRouteOptimizationClient({
      baseUrl: 'https://router.example.test/',
      fetch,
    });

    const result = await client.optimizeStopOrder({ detail, shopDomain: 'dsv-demo.local' });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(init?.method).toBe('GET');
    expect(url).toBe(
      'https://router.example.test/trip/v1/driving/126.7052,37.4563;126.978,37.5665;127.0473,37.5172?roundtrip=false&source=first&destination=any&overview=false&steps=false',
    );
    expect(result).toEqual({
      missingCoordinateStops: 1,
      source: 'osrm-trip',
      stops: [
        { deliveryStopId: 'stop-2', sequence: 1, shopifyOrderGid: 'gid://dsv/Order/1002' },
        { deliveryStopId: 'stop-1', sequence: 2, shopifyOrderGid: 'gid://dsv/Order/1001' },
        { deliveryStopId: 'stop-3', sequence: 3, shopifyOrderGid: 'gid://dsv/Order/1003' },
      ],
    });
  });

  test('uses roundtrip mode for return-to-depot routes', async () => {
    const fetch = vi.fn<TestFetchLike>().mockResolvedValue(Response.json({
      code: 'Ok',
      trips: [{}],
      waypoints: [
        { trips_index: 0, waypoint_index: 0 },
        { trips_index: 0, waypoint_index: 1 },
        { trips_index: 0, waypoint_index: 2 },
      ],
    }));
    const client = new OsrmTripRouteOptimizationClient({ baseUrl: 'https://router.example.test', fetch });

    await client.optimizeStopOrder({
      detail: { ...detail, routePlan: { ...detail.routePlan, routeEndMode: 'RETURN_TO_DEPOT' } },
      shopDomain: 'dsv-demo.local',
    });

    expect(fetch.mock.calls[0]?.[0]).toContain('roundtrip=true&source=first&destination=any');
  });

  test('fails closed when OSRM cannot connect all stops', async () => {
    const fetch = vi.fn<TestFetchLike>().mockResolvedValue(
      Response.json({ code: 'NoTrips', message: 'No trip found' }, { status: 400 }),
    );
    const client = new OsrmTripRouteOptimizationClient({ baseUrl: 'https://router.example.test', fetch });

    const outcome = await client.optimizeStopOrderWithDiagnostics({
      detail,
      shopDomain: 'dsv-demo.local',
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('Expected OSRM Trip failure.');
    expect(outcome.failure.code).toBe('graph_not_ready');
    await expect(client.optimizeStopOrder({ detail, shopDomain: 'dsv-demo.local' })).resolves.toBeNull();
  });

  test('does not call OSRM without a depot or at least two routable stops', async () => {
    const fetch = vi.fn<TestFetchLike>();
    const client = new OsrmTripRouteOptimizationClient({ baseUrl: 'https://router.example.test', fetch });

    const outcome = await client.optimizeStopOrderWithDiagnostics({
      detail: {
        ...detail,
        routePlan: { ...detail.routePlan, depot: { latitude: null, longitude: null } },
      },
      shopDomain: 'dsv-demo.local',
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('Expected OSRM Trip invalid input.');
    expect(outcome.failure.code).toBe('invalid_input');
    expect(fetch).not.toHaveBeenCalled();
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
      address1: '서울특별시',
      address2: null,
      city: '서울',
      countryCode: 'KR',
      postalCode: null,
      province: null,
    },
    attributes: [],
    coordinates: { latitude: input.latitude, longitude: input.longitude },
    deliveryArea: '서울',
    deliveryDay: 'Friday',
    deliveryStopId: input.deliveryStopId,
    financialStatus: null,
    fulfillmentStatus: null,
    orderId: `order-${input.sequence}`,
    orderName: `#${orderNumber}`,
    paymentStatus: null,
    recipientName: null,
    sequence: input.sequence,
    shopifyOrderGid: `gid://dsv/Order/${orderNumber}`,
    status: 'PENDING',
  };
}
