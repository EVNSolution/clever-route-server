# Route Ops OSRM geometry policy

Route detail reads must stay side-effect-free. OSRM/VROOM work is allowed only
when the server is intentionally creating, changing, optimizing, snapshotting, or
refreshing route artifacts.

## Runtime contract

Read paths must not call OSRM/VROOM and must not write route data:

- `GET /admin/ui/app/api/routes/:routePlanId`
- route list reads
- route optimization latest/status reads
- Route Builder page refresh/read preflights

Allowed geometry generation paths:

- route creation
- stop order/coordinate changes
- depot or return-to-store changes
- VROOM optimization apply/snapshot projection
- explicit geometry refresh
- bounded periodic geometry refresh

Driver assignment, publish/status-only changes, notifications, and job status
polling are not shape mutations and must not refresh geometry.

## Cache/freshness rule

Route geometry is a persisted artifact keyed by the route shape signature:
ordered stop ids/coordinates/sequence, depot coordinates, and route end mode.
If the persisted signature does not match the current route shape, reads return
markers/stops normally but do not serve the stale line and do not regenerate it.

## Deployment verification

After a release touching route geometry policy, verify:

1. Repeated route detail reads do not increase OSRM/VROOM request logs.
2. Repeated optimization latest/status reads do not increase OSRM/VROOM request logs.
3. Route detail still returns title/date/stops/coordinates quickly even when
   `routeGeometry` is `null`, `missing`, or `stale`.
4. Route create or stop-order mutation can generate and persist fresh geometry
   when OSRM is configured.

## Rollback guard

Rolling back to a pre-policy build while `OSRM_BASE_URL` is configured can
reintroduce the old read-time path:

`getRoutePlanDetail() -> withRouteGeometry() -> routeGeometryProvider.buildRoute()`

Before or immediately after rollback:

- Prefer a build/config that keeps read enrichment disabled.
- If forced to run a pre-policy build, treat `OSRM_BASE_URL` as a rollback risk
  and verify route detail/latest reads do not generate OSRM traffic.
- Do not drop `route_plan_geometry_caches` during rollback; it is additive cache
  data and can be reused by the forward fix.
- If read-time OSRM traffic resumes, forward-fix to the policy build or disable
  the OSRM-backed enrichment path until a policy-compliant build is restored.
