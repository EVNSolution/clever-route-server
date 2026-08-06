# DSV Vehicle GPS Trail History API

`GET /api/dsv/v1/vehicles/{vehicleId}/gps-trail-history`

Returns vehicle trail sessions for a DSV service date. The endpoint requires
`dsv:control:read` and reads only `UvisVehicleTelemetrySample` rows with
`sourceKind=VEHICLE_GPS`; it must not use driver `LOCATION_UPDATED` events or
Shopify location data.

Query:

- `serviceDate` optional `YYYY-MM-DD`; defaults to the tenant-local current date.

Response:

- `sessions[]` is derived from the vehicle's non-cancelled route plans on the
  service date.
- Multiple `ROUTE_STARTED` events produce multiple sessions and `restart`
  metadata on the previous session.
- The first session begins at the earlier of the configured departure time and
  the first `ROUTE_STARTED` event.
- `ROUTE_PAUSED` closes the current session so paused movement is not joined to
  a later restart.
- If no `ROUTE_STARTED` event exists, the session starts from route
  `scheduledStartAt`, route `departureTime`, or the shop planned departure time.
- `segments[]` are split when the previous GPS sample's persisted `staleAfter`
  is before the next sample's `observedAt`.
- Completion does not force the GPS trail to stop. When depot coordinates are
  available, the endpoint continues through the first depot-return sample; when
  that is not available, it ends at the last valid UVIS GPS sample in the
  service-date window.
