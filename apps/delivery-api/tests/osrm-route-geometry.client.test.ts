import { describe, expect, test, vi } from 'vitest';

import { OsrmRouteGeometryProvider } from '../src/modules/route-plans/osrm-route-geometry.client.js';
import type { RoutePlanDetail } from '../src/modules/route-plans/route-plan.types.js';

const detail = {
  routePlan: {
    createdAt: '2026-05-07T12:30:00.000Z',
    deliveryAreas: ['Scarborough'],
    deliveryDays: ['Friday'],
    depot: { latitude: 43.6532, longitude: -79.3832 },
    id: 'route-plan-id',
    missingCoordinates: 0,
    name: 'Friday route',
    planDate: '2026-05-15',
    routeEndMode: 'END_AT_LAST_STOP',
    status: 'DRAFT',
    stopsCount: 2,
    updatedAt: '2026-05-07T12:30:00.000Z'
  },
  stops: [
    routeStop({ sequence: 1, latitude: 43.7764, longitude: -79.2571 }),
    routeStop({ sequence: 2, latitude: 43.8561, longitude: -79.3370 })
  ],
  routeGeometry: null,
  routeStopPoints: []
} satisfies RoutePlanDetail;

describe('OsrmRouteGeometryProvider', () => {
  test('requires an explicit OSRM base URL and never falls back to a public router', () => {
    expect(() => new OsrmRouteGeometryProvider({ baseUrl: '' })).toThrow('OSRM base URL must be configured explicitly.');
  });

  test('requests a full GeoJSON route through depot and ordered stops', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json(routeOkPayload()));
    const provider = new OsrmRouteGeometryProvider({ baseUrl: 'https://osrm.example', fetch });

    const result = await provider.buildRoute({
      routePlan: detail.routePlan,
      routeGeometry: null,
      routeStopPoints: [],
      stops: detail.stops
    });

    expect(fetch).toHaveBeenCalledWith(
      'https://osrm.example/route/v1/driving/-79.3832,43.6532;-79.2571,43.7764;-79.337,43.8561?overview=full&geometries=geojson&steps=false',
      expect.objectContaining({ method: 'GET' })
    );
    const requestedUrl = String(fetch.mock.calls[0]?.[0] ?? '');
    expect(requestedUrl).toContain('/route/v1/driving/');
    expect(requestedUrl).not.toContain('/trip/v1/');
    expect(requestedUrl).not.toContain('/table/v1/');
    expect(requestedUrl).not.toContain('router.project-osrm.org');
    expect(result).toEqual({
      routeGeometry: {
        type: 'LineString',
        coordinates: [
          [-79.3832, 43.6532],
          [-79.2571, 43.7764],
          [-79.337, 43.8561]
        ]
      },
      routeStopPoints: [
        {
          deliveryStopId: 'stop-1',
          inputCoordinates: [-79.2571, 43.7764],
          name: 'McCowan Road',
          sequence: 1,
          shopifyOrderGid: 'gid://shopify/Order/101',
          snapDistanceMeters: 12.3,
          snappedCoordinates: [-79.2572, 43.7765]
        },
        {
          deliveryStopId: 'stop-2',
          inputCoordinates: [-79.337, 43.8561],
          name: 'Yonge Street',
          sequence: 2,
          shopifyOrderGid: 'gid://shopify/Order/102',
          snapDistanceMeters: 54.16,
          snappedCoordinates: [-79.3372, 43.8562]
        }
      ]
    });
  });

  test('excludes the depot waypoint and matches stop waypoints by sequence order', async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        code: 'Ok',
        routes: [
          {
            geometry: {
              type: 'LineString',
              coordinates: [
                [-79.3832, 43.6532],
                [-79.337, 43.8561],
                [-79.2571, 43.7764]
              ]
            }
          }
        ],
        waypoints: [
          { distance: 0, location: [-79.3831, 43.6531], name: 'Depot Road' },
          { distance: 20, location: [-79.3372, 43.8562], name: 'Yonge Street' },
          { distance: 10, location: [-79.2572, 43.7765], name: 'McCowan Road' }
        ]
      })
    );
    const provider = new OsrmRouteGeometryProvider({ baseUrl: 'https://osrm.example', fetch });

    const result = await provider.buildRoute({
      routePlan: detail.routePlan,
      routeGeometry: null,
      routeStopPoints: [],
      stops: [
        routeStop({ sequence: 2, latitude: 43.7764, longitude: -79.2571 }),
        routeStop({ sequence: 1, latitude: 43.8561, longitude: -79.3370 })
      ]
    });

    expect(result.routeStopPoints).toEqual([
      expect.objectContaining({
        deliveryStopId: 'stop-1',
        sequence: 1,
        snappedCoordinates: [-79.3372, 43.8562]
      }),
      expect.objectContaining({
        deliveryStopId: 'stop-2',
        sequence: 2,
        snappedCoordinates: [-79.2572, 43.7765]
      })
    ]);
    expect(result.routeStopPoints).not.toContainEqual(expect.objectContaining({ name: 'Depot Road' }));
  });

  test('appends the depot as the final waypoint when route end mode returns to depot', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({
      code: 'Ok',
      routes: [
        {
          geometry: {
            type: 'LineString',
            coordinates: [
              [-79.3832, 43.6532],
              [-79.2571, 43.7764],
              [-79.337, 43.8561],
              [-79.3832, 43.6532]
            ]
          }
        }
      ],
      waypoints: [
        { distance: 0, location: [-79.3831, 43.6531], name: 'Depot Road' },
        { distance: 12, location: [-79.2572, 43.7765], name: 'McCowan Road' },
        { distance: 54, location: [-79.3372, 43.8562], name: 'Yonge Street' },
        { distance: 0, location: [-79.3831, 43.6531], name: 'Depot Road' }
      ]
    }));
    const provider = new OsrmRouteGeometryProvider({ baseUrl: 'https://osrm.example', fetch });

    const result = await provider.buildRoute({
      ...detail,
      routePlan: { ...detail.routePlan, routeEndMode: 'RETURN_TO_DEPOT' }
    });

    expect(fetch).toHaveBeenCalledWith(
      'https://osrm.example/route/v1/driving/-79.3832,43.6532;-79.2571,43.7764;-79.337,43.8561;-79.3832,43.6532?overview=full&geometries=geojson&steps=false',
      expect.objectContaining({ method: 'GET' })
    );
    expect(result.routeStopPoints).toHaveLength(2);
    expect(result.routeStopPoints).not.toContainEqual(expect.objectContaining({ name: 'Depot Road' }));
  });

  test('keeps stop point entries when OSRM waypoint data is missing or invalid', async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        code: 'Ok',
        routes: [
          {
            geometry: {
              type: 'LineString',
              coordinates: [
                [-79.3832, 43.6532],
                [-79.2571, 43.7764],
                [-79.337, 43.8561]
              ]
            }
          }
        ],
        waypoints: [
          { distance: 0, location: [-79.3831, 43.6531], name: 'Depot Road' },
          { distance: Number.NaN, location: ['bad', 43.7765], name: 'Bad Road' }
        ]
      })
    );
    const provider = new OsrmRouteGeometryProvider({ baseUrl: 'https://osrm.example', fetch });

    const result = await provider.buildRoute({
      routePlan: detail.routePlan,
      routeGeometry: null,
      routeStopPoints: [],
      stops: detail.stops
    });

    expect(result.routeStopPoints).toEqual([
      {
        deliveryStopId: 'stop-1',
        inputCoordinates: [-79.2571, 43.7764],
        name: 'Bad Road',
        sequence: 1,
        shopifyOrderGid: 'gid://shopify/Order/101',
        snapDistanceMeters: null,
        snappedCoordinates: null
      },
      {
        deliveryStopId: 'stop-2',
        inputCoordinates: [-79.337, 43.8561],
        name: null,
        sequence: 2,
        shopifyOrderGid: 'gid://shopify/Order/102',
        snapDistanceMeters: null,
        snappedCoordinates: null
      }
    ]);
  });

  test('returns null geometry and no stop points when OSRM fails', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 502 }));
    const provider = new OsrmRouteGeometryProvider({ baseUrl: 'https://osrm.example', fetch });

    const result = await provider.buildRoute({
      routePlan: detail.routePlan,
      routeGeometry: null,
      routeStopPoints: [],
      stops: detail.stops
    });

    expect(result).toEqual({ routeGeometry: null, routeStopPoints: [] });
  });

  test('returns null geometry and no stop points for invalid OSRM payloads', async () => {
    const invalidPayloads = [
      { code: 'Ok', routes: [] },
      { code: 'Ok', routes: [{ geometry: { type: 'Point', coordinates: [-79.3, 43.6] } }] },
      { code: 'Ok', routes: [{ geometry: { type: 'LineString', coordinates: [[-79.3, 43.6]] } }] },
      { code: 'NoRoute', routes: [{ geometry: { type: 'LineString', coordinates: [[-79.3, 43.6], [-79.4, 43.7]] } }] }
    ];

    for (const payload of invalidPayloads) {
      const fetch = vi.fn().mockResolvedValue(Response.json(payload));
      const provider = new OsrmRouteGeometryProvider({ baseUrl: 'https://osrm.example', fetch });

      await expect(provider.buildRoute(detail)).resolves.toEqual({ routeGeometry: null, routeStopPoints: [] });
    }
  });

  test('returns null geometry and no stop points when the OSRM provider rejects', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED'));
    const provider = new OsrmRouteGeometryProvider({ baseUrl: 'https://osrm.example', fetch });

    await expect(provider.buildRoute(detail)).resolves.toEqual({ routeGeometry: null, routeStopPoints: [] });
  });

  test('aborts slow OSRM requests and returns null geometry', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(
      (_url: string, init: { method: 'GET'; signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        })
    );
    const provider = new OsrmRouteGeometryProvider({ baseUrl: 'https://osrm.example', fetch, timeoutMs: 1 });

    try {
      const resultPromise = provider.buildRoute(detail);
      await vi.advanceTimersByTimeAsync(1000);
      await expect(resultPromise).resolves.toEqual({ routeGeometry: null, routeStopPoints: [] });
      expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test('returns null geometry and no stop points instead of calling OSRM when there are fewer than two routable points', async () => {
    const fetch = vi.fn();
    const provider = new OsrmRouteGeometryProvider({ baseUrl: 'https://osrm.example', fetch });

    const result = await provider.buildRoute({
      routePlan: { ...detail.routePlan, depot: { latitude: null, longitude: null } },
      routeGeometry: null,
      routeStopPoints: [],
      stops: [routeStop({ sequence: 1, latitude: 43.7764, longitude: -79.2571 })]
    });

    expect(result).toEqual({ routeGeometry: null, routeStopPoints: [] });
    expect(fetch).not.toHaveBeenCalled();
  });
});

function routeOkPayload(): unknown {
  return {
    code: 'Ok',
    routes: [
      {
        geometry: {
          type: 'LineString',
          coordinates: [
            [-79.3832, 43.6532],
            [-79.2571, 43.7764],
            [-79.337, 43.8561]
          ]
        }
      }
    ],
    waypoints: [
      { distance: 0, location: [-79.3831, 43.6531], name: 'Depot Road' },
      { distance: 12.3, location: [-79.2572, 43.7765], name: 'McCowan Road' },
      { distance: 54.16, location: [-79.3372, 43.8562], name: 'Yonge Street' }
    ]
  };
}

function legacyRouteGeometry(): unknown {
  return {
    code: 'Ok',
    routes: [
      {
        geometry: {
          type: 'LineString',
          coordinates: [
            [-79.3832, 43.6532],
            [-79.2571, 43.7764],
            [-79.337, 43.8561]
          ]
        }
      }
    ]
  };
}

describe('OsrmRouteGeometryProvider legacy compatibility', () => {
  test('keeps returning only route geometry through the legacy method', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json(legacyRouteGeometry()));
    const provider = new OsrmRouteGeometryProvider({ baseUrl: 'https://osrm.example', fetch });

    const geometry = await provider.buildRouteGeometry({
      routePlan: detail.routePlan,
      routeGeometry: null,
      routeStopPoints: [],
      stops: detail.stops
    });

    expect(geometry).toEqual({
      type: 'LineString',
      coordinates: [
        [-79.3832, 43.6532],
        [-79.2571, 43.7764],
        [-79.337, 43.8561]
      ]
    });
  });
});

function routeStop(input: { latitude: number; longitude: number; sequence: number }): RoutePlanDetail['stops'][number] {
  return {
    address: {
      address1: '200 Town Centre Ct',
      address2: null,
      city: 'Scarborough',
      countryCode: 'CA',
      postalCode: 'M1P 4Y7',
      province: 'ON'
    },
    attributes: [],
    coordinates: { latitude: input.latitude, longitude: input.longitude },
    deliveryArea: 'Scarborough',
    deliveryDay: 'Friday',
    deliveryStopId: `stop-${input.sequence}`,
    financialStatus: 'PAID',
    fulfillmentStatus: 'OPEN',
    orderId: `order-${input.sequence}`,
    orderName: `#10${input.sequence}`,
    paymentStatus: 'PAID',
    recipientName: 'Customer',
    sequence: input.sequence,
    shopifyOrderGid: `gid://shopify/Order/10${input.sequence}`,
    status: 'PENDING'
  };
}
