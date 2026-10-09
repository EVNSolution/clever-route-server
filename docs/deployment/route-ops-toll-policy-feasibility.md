# Toll-road policy feasibility

Research only, 2026-10-02. No routing setting, graph, or runtime has been changed.
Repository baseline: `90827faf60133e7df3b53779d1c2dc8acd286f8f`.

## Finding

A toll-road preference is feasible, but it must affect both VROOM optimization
and the OSRM geometry used to display the result. Adding `exclude=toll` only to
the geometry request would leave stop order and travel-time calculations using
the existing unrestricted routing matrix.

Use the product concepts **Allow toll roads** and **Avoid toll roads**. Allowing
tolls does not force their use; avoiding tolls must not exclude free highways.
The policy depends on the toll tags in the routing dataset, so it is not a
guarantee about eventual charges.

## Current boundaries

- `vroom-route-optimizer.client.ts` sends vehicle profile `car` without a custom
  matrix. `infra/vroom/config.yml` maps it to one Ontario OSRM service.
- `osrm-route-geometry.client.ts` and the OSRM Trip client have no toll option.
- `route-plan-geometry-cache.ts` identifies depot, end mode, ordered stops, and
  coordinates; it does not identify a toll policy or graph revision.
- VROOM is pinned to v1.15.0. The Ontario OSRM compose image uses `latest`, and
  `scripts/osrm-ontario.sh` extracts with the image's `/opt/car.lua`. The actual
  running image, graph provenance, and supported exclusions were not probed.

[OSRM API general options](https://project-osrm.org/docs/v5.24.0/api/) support
class exclusion, subject to the classes prepared in the graph. The
[profile documentation](https://github.com/Project-OSRM/osrm-backend/blob/master/docs/profiles.md)
explains those preprocessing requirements. The
[VROOM v1.15 OSRM wrapper](https://github.com/VROOM-Project/vroom/blob/v1.15.0/src/routing/osrm_routed_wrapper.cpp)
constructs its own Table and Route requests and does not forward an arbitrary
OSRM exclusion from this service's solve input.

## Options for a separately approved implementation

| Option | Benefit | Work to evaluate |
| --- | --- | --- |
| Normal and toll-avoiding OSRM graphs, with matching VROOM routing configuration | Optimization and geometry use the same road network | Additional graph preprocessing, memory/storage, and service lifecycle |
| OSRM Table with exclusion, supplied as VROOM custom matrices, plus matching OSRM Route requests | Can use supported exclusions on one prepared graph | Matrix request limits, vehicle profiles, geometry consistency, and failure handling |

[VROOM's API](https://github.com/VROOM-Project/vroom/blob/v1.15.0/docs/API.md)
supports custom matrices. Neither option has been selected or benchmarked here.
Persist the effective policy on each route plan so later settings changes do not
silently rewrite existing routes. Include policy and graph revision in cached
results, and carry the same policy through every optimizer fallback. If no
compliant route is found, report that failure without silently allowing tolls.

## Ontario 407 distinction

[407 ETR](https://www.407etr.com/en/travel-with-us) describes its tolled QEW–Brock
Road section. [Ontario Regulation 76/25](https://www.ontario.ca/laws/regulation/r25076)
removes tolls on Highway 407 East from June 1, 2025. A road-number-wide “avoid
407” rule would incorrectly conflate these sections. Verify current segment
tags in the actual Ontario dataset before enabling the preference.

## Required evidence before enabling

1. Identify and pin the actual OSRM version, profile, dataset, and graph revision;
   probe supported exclusions using both Table and Route.
2. Compare fixed GTA fixtures where unrestricted routing can use 407 ETR and
   toll avoidance excludes that tolled section while allowing free highways.
3. Verify VROOM order/durations, displayed geometry, ETA, and cache all use the
   same policy, including reoptimization and fallback paths.
4. Verify default compatibility for existing plans, cache invalidation when
   policy changes, and explicit no-route handling.
5. Measure resource costs and complete a separate deployment/rollback review.

Real driver navigation in an external maps app is a separate integration; this
research establishes only the server-side route-generation boundary.


## Implementation contract (2026-10-09)

The selected implementation uses the existing OSRM graph. This change does not
modify Ontario preprocessing, container settings, or the graph.

- Persist `tollPolicy` as `ALLOW_TOLLS` or `AVOID_TOLLS` on the route. Missing
  policy means `ALLOW_TOLLS`, preserving existing requests and cache signatures.
- For avoidance, fetch OSRM Table with `annotations=duration,distance&exclude=toll`.
  Supply the validated integer matrices as `matrices.car` to VROOM. Depot index
  is zero and each routable job has a contiguous `location_index`. Return-to-depot
  uses `end_index: 0`; open routes omit an end index.
- A missing matching OSRM URL, unsupported exclusion, unreachable/null matrix
  cell, incomplete matrix, or synthetic fallback-speed cell fails the solve.
  No unrestricted matrix or straight-line fallback is used.
- OSRM Route and the alternative OSRM Trip path also send `exclude=toll`.
  Distances, displayed geometry, and leg ETA therefore use the same policy.
- Avoidance has a distinct geometry signature. An old unrestricted cache cannot
  supply its geometry, metrics, or derived leg ETA to the avoiding route.
- Changing policy or the order of an avoiding route requires complete geometry
  before persistence. The repository receives the original shape signature and
  commits the mutation, geometry, and ETA atomically after rechecking that guard.
  Initial avoiding-route creation computes geometry inside the creation
  transaction; an exception rolls the creation back.
- Failure does not delete or replace a valid previous cache. The server reports
  the failure and does not silently change the policy to `ALLOW_TOLLS`.

The driver assignment exposes the same enum. Navigation integrations must pass
that policy through supported external-map parameters. An external app that
cannot enforce the preference must show that limitation; a road-number-wide
407 exclusion is not an acceptable substitute.

Unit tests cover custom-matrix indexes, depot return, integer units, unreachable
cells, unsupported exclusions, absence of fallback, geometry/Trip consistency,
legacy cache compatibility, and mutation rejection before persistence.
These tests do not establish the current production graph or publication state.
The fixed Ontario route comparison and runtime checks above remain release
acceptance evidence.


### Provider capability recheck — 2026-10-09

Read-only requests against the existing Ontario OSRM v26.5.0 and VROOM 1.15.0
passed using three fixed public-coordinate pairs. This is provider evidence,
not evidence that the new server implementation has been deployed.

| Public fixture | Allow tolls | Avoid tolls | Road result |
| --- | --- | --- | --- |
| Vaughan–Markham | 39,409.2 m / 2,081 s | 35,040.9 m / 2,851.4 s | Tolled 407 ETR removed |
| North Toronto–Oshawa | 65,498.3 m / 3,477.9 s | 66,161.1 m / 3,622.8 s | Tolled 407 ETR removed |
| Highway 407 East | 20,492.5 m / 1,006 s | 20,492.5 m / 1,006 s | Free 407 retained; identical geometry |

All six Route/Table distance and duration comparisons agreed. All six synthetic
VROOM depot-return calculations exactly matched the supplied integer matrices.
A syntactically valid unknown exclusion returned HTTP 400 `InvalidValue`.
No business records, containers, or routing configuration were changed.
The graph timestamp field was empty; image IDs and metadata-file hashes were
recorded instead of claiming a known source-data timestamp.
