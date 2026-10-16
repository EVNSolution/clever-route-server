# DSV Vehicle GPS Trail History API

`GET /api/dsv/v1/vehicles/{vehicleId}/gps-trail-history`

Returns vehicle trail sessions for a DSV service date. The endpoint requires
`dsv:control:read` and reads only `UvisVehicleTelemetrySample` rows with
`sourceKind=VEHICLE_GPS`; it must not use driver `LOCATION_UPDATED` events or
Shopify location data.

Query:

- `serviceDate` optional `YYYY-MM-DD`; defaults to the tenant-local current date.
- `includeDailyRoute=true` optionally includes a continuous daily `LineString` with
  sample anchors and bridge reasons. The default response is unchanged.
- `window=service` optionally returns only the service window (rules below).
  Without it the response is unchanged. Any other value is a 400.

Response:

- `sessions[]` is derived from the vehicle's non-cancelled route plans on the
  service date.
- Multiple `ROUTE_STARTED` events produce multiple sessions and `restart`
  metadata on the previous session.
- The first session begins at the earlier of the configured departure time and
  the first `ROUTE_STARTED` event.
- `ROUTE_PAUSED` closes the current session so paused movement is not joined to
  a later restart.
- Every valid UVIS GPS sample in the service-date window is returned. Samples
  collected before departure, while route execution is paused, or while
  telemetry polling is dormant are preserved in collection-only sessions.
- If no `ROUTE_STARTED` event exists, the session starts from route
  `scheduledStartAt`, route `departureTime`, or the shop planned departure time.
- `segments[]` are split when the previous GPS sample's persisted `staleAfter`
  is before the next sample's `observedAt`, or the two raw coordinates imply
  more than 55 m/s. Raw samples on both sides remain in the response.
- `segments[].roadMatchedGeometry` is additive and optional. When present, it
  keeps the existing GeoJSON `MultiLineString` shape and may include
  `anchors: Array<{ observedAt: string; lineIndex: number; coordinateIndex:
  number }>` sorted by `observedAt` ascending. Each anchor points directly into
  `roadMatchedGeometry.coordinates[lineIndex][coordinateIndex]` for raw UVIS
  sample replay. Partially overlapping materialized lines are returned only when
  anchors allow clipping to the segment sample window; otherwise raw samples
  remain the fallback.
- Road anchors more than 25 m from repeated stationary or ignition-off GPS
  samples are discarded. Road lines without two retained anchors are omitted.
- `dailyRoute.bridges[]` marks `GPS_GAP`, `IMPLAUSIBLE_JUMP`, or `NO_MATCH`.
  The daily line retains raw endpoints across these bridges for continuity;
  a bridge does not establish that the vehicle drove along the connecting line.
- An `IMPLAUSIBLE_JUMP` bridge can additionally contain `inferredTunnel` when
  frozen, inconsistent UVIS GPS is bracketed at normal sample cadence by
  progressing road anchors on exactly one reviewed eastbound tunnel corridor:
  Hongjimun–Jeongneung or Suam–Suri. The Suam–Suri corridor has a Sanbon IC
  exit branch; inference requires the resumed raw point and road anchor on the
  mainline beyond that decision, followed by a later progressing road anchor.
  Up to two consecutive invalid-speed heartbeats immediately after the exit can be skipped.
  A later observation confirms the candidate only with valid cadence, no stale GPS gap,
  no sentinel speed, and at least 50 m of matched-road progress;
  `confirmedByObservedAt` records that observation
  needed for that decision. Until it and its materialized anchor exist, a
  current-day response keeps the bridge as an evidence gap. The separate
  LineString is an **inferred candidate for a dotted display** from
  `fromObservedAt` to the raw resume at `toObservedAt`; it is not raw GPS or
  proof of the exact travel time or road driven. Other tunnels and ambiguous
  cases keep the original bridge without inferred geometry. Both corridors
  are 2026-09-30 OpenStreetMap snapshots (© OpenStreetMap contributors, ODbL 1.0).
- Completion does not force the GPS trail to stop. When depot coordinates are
  available, the endpoint continues through the first depot-return sample; when
  that is not available, it ends at the last valid UVIS GPS sample in the
  service-date window.

## Service window (`window=service`)

Service window = center arrival to arrival at the last stop. Raw GPS samples
are not deleted; the window only limits what this response returns.

Rules:

1. Center: the settings departure location (`departureLatitude`,
   `departureLongitude` in operation settings). Both names are
   `shops.defaultDepotLatitude` and `shops.defaultDepotLongitude`; there is one
   source, so no value can differ.
2. Center arrival: the first point of the first stay within 300 m that lasted
   10 minutes or more. A stay lasts from its first point to the first point
   outside the radius, or to the last point inside when no point is outside.
   A pass-by is not an arrival.
3. End: the arrival event (`STOP_ARRIVED`) time of the last stop. A stop with
   no arrival event uses its `STOP_DELIVERED` or `STOP_FAILED` time. If any
   stop is not reached yet, the end is `null` (open). Return to the center is
   not part of the window. With no stops the end is `null`.
4. No center arrival (no departure location, or no qualifying stay): nothing is
   trimmed, the whole trail is returned, and `serviceWindow` is `null`.
5. Live telemetry (`telemetry current`) is not affected.

When the window is found:

- `sessions[].segments[].samples`, `roadMatchedGeometry`, and `trailMarker`
  keep only what lies inside the window. A marker outside it becomes `null`.
- `dailyRoute` keeps only anchors inside the window, cuts `coordinates` from
  the first to the last kept anchor, and renumbers `coordinateIndex`.
  `bridges` keep only those with both ends inside. When fewer than two anchors
  remain, `dailyRoute` is `null`.
- `roadMatchedGeometry` drops lines with fewer than two anchors inside, cuts
  `coordinates`, and renumbers `coordinateIndex` and `lineIndex`. When no line
  remains it is `null`.
- Segments left without samples and sessions left without segments are removed.

`serviceWindow`:

```json
{
  "startedAt": "2026-10-13T21:20:00.000Z",
  "endedAt": "2026-10-14T05:41:00.000Z",
  "startSource": "CENTER_STAY",
  "endSource": "STOP_ARRIVED"
}
```

`endedAt` and `endSource` are `null` while a stop is not reached yet.
`endSource` is `STOP_RESULT` when the last stop used a delivered or failed
event. `serviceWindow` is `null` when no center arrival was found.
