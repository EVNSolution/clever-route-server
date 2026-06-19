# Driver Assigned Route Geometry Contract

Date: 2026-06-19
Scope: `GET /driver/assigned-route` additive route guidance fields for the driver app.

## Runtime configuration

Driver assigned-route reads do **not** call OSRM/VROOM. The response may include route guidance fields only from the persisted route geometry cache produced by explicit route work:

- route creation
- shape-changing route mutation
- optimization/snapshot apply
- explicit or scheduled geometry refresh

`DRIVER_ROUTE_OSRM_BASE_URL` and `DRIVER_ROUTE_OSRM_TIMEOUT_MS` are no longer used by assigned-route reads. `OSRM_BASE_URL` belongs to explicit admin/route geometry generation only.

## Response shape

When `status` is `ASSIGNED_ROUTE`, the `route` object includes these additive fields when a fresh cache entry exists:

```json
{
  "routeGeometry": { "type": "LineString", "coordinates": [[-79.3832, 43.6532], [-79.3817, 43.6487]] },
  "routeMetrics": { "distanceMeters": 980.5, "durationSeconds": 420.25 },
  "routeStopPoints": [
    {
      "deliveryStopId": "synthetic-stop-id",
      "inputCoordinates": [-79.3817, 43.6487],
      "name": "King Street West",
      "sequence": 1,
      "snapDistanceMeters": 3.5,
      "snappedCoordinates": [-79.3818, 43.6488]
    }
  ]
}
```

Fallback behavior for missing/stale/unavailable cache:

```json
{
  "routeGeometry": null,
  "routeMetrics": null,
  "routeStopPoints": []
}
```

## Units and provenance

- `routeGeometry`: cached route GeoJSON `LineString` coordinates in `[longitude, latitude]` order.
- `routeMetrics.distanceMeters`: route distance in meters.
- `routeMetrics.durationSeconds`: route duration in seconds.
- `routeStopPoints[].snapDistanceMeters`: waypoint snap distance in meters.

## Safety constraints

- The driver route response must stay scoped to the authenticated driver and route context.
- `routeStopPoints` intentionally omits `shopifyOrderGid` from the driver-facing contract.
- Missing/stale/unavailable geometry must not fail the assigned-route read.
- Assigned-route reads must not generate geometry, mutate route/depot state, or call public routers.
- Do not add admin backdoors, auth bypasses, sample token loaders, payment/order creation, or automatic deployment behavior as part of this contract.

## Verification anchors

- OSRM parser/unit tests: `tests/osrm-route-geometry.client.test.ts`
- Driver assigned-route repository tests: `tests/driver-assigned-route.repository.test.ts`
- Driver runtime config tests: `tests/driver.dependencies.test.ts`
- Route geometry policy docs: `docs/deployment/route-ops-osrm-geometry-policy.md`
- App contract/legacy parser tests: `src/domain/route/assignedRoute.test.ts` in `clever-driver-app`
