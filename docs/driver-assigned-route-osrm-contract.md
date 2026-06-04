# Driver Assigned Route OSRM Contract

Date: 2026-06-04  
Scope: `GET /driver/assigned-route` additive route guidance fields for the driver app.

## Runtime configuration

- `DRIVER_ROUTE_OSRM_BASE_URL`: preferred driver-assigned-route OSRM base URL.
- `OSRM_BASE_URL`: fallback shared OSRM base URL when the driver-specific value is absent.
- `DRIVER_ROUTE_OSRM_TIMEOUT_MS`: optional positive integer timeout in milliseconds.
- No public router fallback is allowed. If no explicit base URL is configured, route guidance fields remain safe fallbacks.

## Response shape

When `status` is `ASSIGNED_ROUTE`, the `route` object includes these additive fields:

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

Fallback behavior:

```json
{
  "routeGeometry": null,
  "routeMetrics": null,
  "routeStopPoints": []
}
```

## Units and provenance

- `routeGeometry`: OSRM route GeoJSON `LineString` coordinates in `[longitude, latitude]` order.
- `routeMetrics.distanceMeters`: OSRM `routes[0].distance`, in meters.
- `routeMetrics.durationSeconds`: OSRM `routes[0].duration`, in seconds.
- `routeStopPoints[].snapDistanceMeters`: OSRM waypoint snap distance, in meters.

## Safety constraints

- The driver route response must stay scoped to the authenticated driver and route context.
- `routeStopPoints` intentionally omits `shopifyOrderGid` from the driver-facing contract.
- OSRM errors, invalid payloads, missing coordinates, or timeouts must not fail the assigned-route read.
- Do not add admin backdoors, auth bypasses, sample token loaders, payment/order creation, or automatic deployment behavior as part of this contract.

## Verification anchors

- OSRM parser/unit tests: `tests/osrm-route-geometry.client.test.ts`
- Driver assigned-route repository tests: `tests/driver-assigned-route.repository.test.ts`
- Driver runtime config tests: `tests/driver.dependencies.test.ts`
- App contract/legacy parser tests: `src/domain/route/assignedRoute.test.ts` in `clever-driver-app`
