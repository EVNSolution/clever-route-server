# Admin Route Plans API

Purpose: the Shopify embedded UI saves selected delivery orders into the delivery
server as the route/order/delivery source of truth. The first MVP optimizer keeps
the user-selected order sequence and stores a route plan that is immediately
`READY`.

## Route lifecycle

- A direct route or route-group child is `READY` as soon as it is created.
- Driver assignment, stop count, optimization, and the legacy publish endpoint
  do not gate or advance lifecycle state.
- An authenticated driver's `ROUTE_STARTED` event moves the assigned route to
  `IN_PROGRESS`.
- `ROUTE_COMPLETED` moves it to `COMPLETED`; cancellation remains `CANCELLED`.
- Legacy `DRAFT`, `PUBLISHED`, `OPTIMIZED`, and `ASSIGNED` database values are
  read as `READY`. Existing start/completion events recover the corresponding
  execution state without reopening completed work.

## Authentication

All routes require a Shopify embedded app session token:

```http
Authorization: Bearer <shopify-session-token>
```

The server verifies the token against configured Shopify app credentials:
`SHOPIFY_API_KEY`/`SHOPIFY_API_SECRET` for the default `clever` app,
`SHOPIFY_DEV_API_KEY`/`SHOPIFY_DEV_API_SECRET` for `clever-route-dev`, or
additional `SHOPIFY_APP_CREDENTIALS` entries. `shopDomain` and `appId` are
derived from the token, not from request payload. The embedded UI can also send
`x-clever-app-id` to make admin routes reject tokens for the wrong app. If the
embedded UI runs from another origin, configure `SHOPIFY_APP_URL` so CORS allows
that app origin.

## POST `/admin/route-plans`

Creates a Ready route plan for the authenticated shop.

Request:

```json
{
  "name": "CLEVER route draft",
  "planDate": "2026-05-08",
  "depot": {
    "address": "Shopify departure location",
    "latitude": 43.6532,
    "longitude": -79.3832
  },
  "orders": [
    {
      "shopifyOrderGid": "gid://shopify/Order/123",
      "name": "#1035",
      "email": "customer@example.com",
      "phone": "+14165550000",
      "financialStatus": "PENDING",
      "fulfillmentStatus": "UNFULFILLED",
      "processedAt": "2026-05-07T12:00:00.000Z",
      "totalPriceAmount": "95.00",
      "currencyCode": "CAD",
      "recipientName": "Noah Yoon",
      "shippingAddress": {
        "address1": "300 City Centre Dr",
        "address2": "#08",
        "city": "Mississauga",
        "province": "ON",
        "postalCode": "L5B 3C1",
        "countryCode": "CA"
      },
      "latitude": 43.589,
      "longitude": -79.644,
      "deliveryArea": "Mississauga",
      "deliveryDay": "Thursday",
      "attributes": [{ "key": "Delivery Area", "value": "Mississauga" }],
      "rawPayload": {}
    }
  ]
}
```

Persistence contract:

- `Shop` is upserted by token-derived `(appId, shopDomain)`.
- `Order` is upserted by `(shopId, shopifyOrderGid)`.
- `DeliveryStop` is upserted by `(shopId, orderId)`.
- `RoutePlan` is created with `status=READY`,
  `optimizerVersion=manual-sequence-mvp`, depot coordinates, constraints, and
  metrics JSON.
- `RoutePlanStop.sequence` is assigned from request order, starting at `1`.

Response `201`:

```json
{
  "data": {
    "routePlan": {
      "id": "uuid",
      "name": "CLEVER route draft",
      "status": "READY",
      "planDate": "2026-05-08",
      "stopsCount": 1,
      "missingCoordinates": 0,
      "deliveryAreas": ["Mississauga"],
      "deliveryDays": ["Thursday"],
      "depot": {
        "latitude": 43.6532,
        "longitude": -79.3832
      },
      "createdAt": "2026-05-07T12:30:00.000Z",
      "updatedAt": "2026-05-07T12:30:00.000Z"
    }
  },
  "error": null
}
```

## GET `/admin/route-plans`

Returns route plans for the authenticated shop only.

Response `200`:

```json
{
  "data": {
    "routePlans": [
      {
        "id": "uuid",
        "name": "CLEVER route draft",
        "status": "READY",
        "planDate": "2026-05-08",
        "stopsCount": 1,
        "missingCoordinates": 0,
        "deliveryAreas": ["Mississauga"],
        "deliveryDays": ["Thursday"],
        "depot": { "latitude": 43.6532, "longitude": -79.3832 },
        "createdAt": "2026-05-07T12:30:00.000Z",
        "updatedAt": "2026-05-07T12:30:00.000Z"
      }
    ]
  },
  "error": null
}
```

## GET `/admin/route-plans/:routePlanId`

Returns a route plan detail for the authenticated shop. A route plan ID owned by
another shop returns `404`.

Response `200`:

```json
{
  "data": {
    "routePlan": {
      "id": "uuid",
      "name": "CLEVER route draft",
      "status": "READY",
      "planDate": "2026-05-08",
      "stopsCount": 1,
      "missingCoordinates": 0,
      "deliveryAreas": ["Mississauga"],
      "deliveryDays": ["Thursday"],
      "depot": { "latitude": 43.6532, "longitude": -79.3832 },
      "createdAt": "2026-05-07T12:30:00.000Z",
      "updatedAt": "2026-05-07T12:30:00.000Z"
    },
    "routeGeometry": {
      "type": "LineString",
      "coordinates": [
        [-79.3832, 43.6532],
        [-79.643565, 43.589371]
      ]
    },
    "routeStopPoints": [
      {
        "deliveryStopId": "uuid",
        "shopifyOrderGid": "gid://shopify/Order/123",
        "sequence": 1,
        "inputCoordinates": [-79.644, 43.589],
        "snappedCoordinates": [-79.643565, 43.589371],
        "snapDistanceMeters": 54.16,
        "name": "Duke of York Boulevard"
      }
    ],
    "stops": [
      {
        "sequence": 1,
        "deliveryStopId": "uuid",
        "orderId": "uuid",
        "shopifyOrderGid": "gid://shopify/Order/123",
        "orderName": "#1035",
        "recipientName": "Noah Yoon",
        "address": {
          "address1": "300 City Centre Dr",
          "address2": "#08",
          "city": "Mississauga",
          "province": "ON",
          "postalCode": "L5B 3C1",
          "countryCode": "CA"
        },
        "financialStatus": "PENDING",
        "fulfillmentStatus": "UNFULFILLED",
        "paymentStatus": "PENDING",
        "status": "PENDING",
        "attributes": [{ "key": "Delivery Area", "value": "Mississauga" }],
        "coordinates": { "latitude": 43.589, "longitude": -79.644 },
        "deliveryArea": "Mississauga",
        "deliveryDay": "Thursday"
      }
    ]
  },
  "error": null
}
```

`routeGeometry` is the OSRM route `routes[0].geometry` GeoJSON LineString.
`routeStopPoints` is additive metadata for the ordered stops. It excludes the
depot waypoint and maps OSRM waypoint data back to route stops by stop sequence.
If OSRM is unavailable, the route detail still succeeds with
`routeGeometry: null` and `routeStopPoints: []`. If an individual waypoint is
missing or malformed, that stop keeps its `inputCoordinates` and receives
`snappedCoordinates: null`.

## POST `/admin/route-plans/:routePlanId/refresh-order-data`

Rebuilds the stored route geometry, stop snap points, drive metrics, and ETAs
from the route's current canonical `Order` and `DeliveryStop` rows. The caller
must synchronize the latest commerce order snapshot first. Route membership,
stop sequence, driver, and execution status are preserved.

The response uses the same detail shape as
`GET /admin/route-plans/:routePlanId`. A route owned by another shop returns
`404`.

## PATCH `/admin/route-plans/:routePlanId/stops`

Replaces the route plan's stop links with the provided ordered Shopify orders
for the authenticated shop, then returns the same detail shape as
`GET /admin/route-plans/:routePlanId`, including `routeGeometry` and
`routeStopPoints`.

Request:

```json
{
  "stops": [
    {
      "deliveryStopId": "optional-existing-delivery-stop-id-or-null",
      "shopifyOrderGid": "gid://shopify/Order/123",
      "sequence": 1
    }
  ]
}
```

The server validates that all referenced orders belong to the token shop, share
the route delivery date, are not already assigned to another route plan, and do
not contain duplicate `shopifyOrderGid` values.

Common errors:

- `401` with `UNAUTHORIZED`: missing or invalid Shopify session token.
- `400` with `BAD_REQUEST`: invalid create payload.
- `404` with `NOT_FOUND`: route plan does not exist for the token shop.
- `409` with `ROUTE_ORDER_ALREADY_PLANNED`: an order is already assigned to a
  different route plan.

## POST `/admin/route-plans/:routePlanId/stops/:deliveryStopId/transition`

Transitions one child stop for the authenticated shop without mutating Shopify
or reusing the bulk route stop reorder endpoint.

Request:

```json
{
  "status": "COMPLETED",
  "idempotencyKey": "admin-stop-action-key"
}
```

Status mapping:

- `READY` -> `DeliveryStop.status=PENDING`
- `IN_PROGRESS` -> `DeliveryStop.status=EN_ROUTE`
- `COMPLETED` -> `DeliveryStop.status=DELIVERED`

The command is scoped by token shop, `routePlanId`, and `deliveryStopId`.
`source=ADMIN` is recorded in the admin stop action audit metadata. For
`COMPLETED`, the server records a nullable-driver `STOP_DELIVERED` execution
event and publishes one live `tracking_progress` SSE event through the route
tracking stream hub, so route tracking/progress reads observe the same terminal
stop effect without creating a fake driver identity.

The endpoint creates or reuses a `CustomerRouteNotificationFact` with a unique
notification idempotency key in the same transaction as the stop update. The
request path only persists the notification as `QUEUED`; it does not wait for
the remote notification provider.

When Brevo and the outbox worker are configured, the worker claims only facts
whose shop explicitly activated automatic email. It renders the durable signal
with the same tenant templates used by manual sends, submits the stable
idempotency key to Brevo, and recovers expired leases after process restarts.
Retryable failures use bounded exponential backoff. Provider acceptance records
`SENT`; delivery, bounce, block, and related outcomes are later attached by the
authenticated Brevo webhook. Missing recipients and disabled templates are
recorded as `SKIPPED`. Historical facts for an inactive shop stay unclaimed and
surface as degraded operational evidence instead of being sent retroactively.

Customer email is snapshotted from CLEVER canonical `Order.email` when the fact
is created. Shopify source data remains read-only and no Shopify mutation is
performed. Delivery is at-least-once across worker crashes, so the notification
provider must deduplicate the stable notification idempotency key.

Duplicate requests with the same `idempotencyKey` and same route stop return
the current route with `duplicate=true`, report the persisted notification state
(`QUEUED`, `PROCESSING`, `SENT`, `SKIPPED`, or `DEAD`), and do not create another stop
update, driver event, notification fact, audit row, tracking SSE publish, or
worker send. Reusing an idempotency key for a different route stop returns
`409 ROUTE_PLAN_CONFLICT`.

## PATCH `/admin/route-plans/:routePlanId/stops/:deliveryStopId/override`

Updates CLEVER DB operational override fields for one delivery stop. The server
does not mutate Shopify source order/customer data.

Request fields are flat and owned by the server:

```json
{
  "recipientName": "Jane Admin",
  "phone": "+14165550100",
  "address1": "42 Admin Rd",
  "address2": null,
  "city": "Toronto",
  "province": "ON",
  "postalCode": "M5V 2T6",
  "countryCode": "CA",
  "latitude": 43.6426,
  "longitude": -79.3871,
  "timeWindowStart": "14:00",
  "timeWindowEnd": "18:00",
  "serviceMinutes": 8,
  "instructions": "Leave with concierge"
}
```

Address, coordinate, or service-time edits invalidate stored route geometry and
mark route stop ETA fields `STALE` for rebuild. Non-geometry notes/contact edits
preserve the current geometry cache.
Passing `null` for `serviceMinutes` resets the CLEVER stop to the database
default of 5 minutes.

## GET `/admin/route-plans/:routePlanId/tracking`

Returns the current tracking snapshot and opens the same route-scoped SSE
stream used by the embedded admin app. The snapshot keeps `recentPositions`
for backward compatibility and adds `recordedPath` as the canonical historical
GPS path.

`recordedPath` is one route-scoped projection:

- `geometry` is a GeoJSON `LineString` containing the server-compressed path.
- `samples` is aligned by index with `geometry.coordinates` and retains the
  event, driver, recorded, and received timestamps needed for inspection.
- `sourcePointCount` is the number of valid raw GPS events represented by the
  projection; `geometryPointCount` is the number of coordinates retained after
  compression.
- No fixed event-count or point-count tail limit is applied. The complete
  retained route history is returned even when it exceeds 1,000 points.
- Compression preserves the first and latest points and does not simplify
  across a tracking gap. Raw `DriverEvent` rows remain the audit and rebuild
  source; `recordedPath` is the read-optimized route projection.

If a route has not yet been projected, the server temporarily rebuilds the
response from every retained raw location event for that route without a
count limit. New location writes update both the raw event and the route-level
projection in one database transaction before the event is published to SSE.

The snapshot also includes `stopArrivals`, one durable entry for every
`STOP_ARRIVED` event. An arrival uses coordinates recorded on the event when
available. Otherwise, the server may associate the nearest retained GPS event
only when it is within the route tracking delayed threshold (three minutes by
default). Entries outside that window remain auditable with
`positionSource: "unavailable"` and null coordinates; clients must not invent a
map position for them. `stopSequence` is the route's Stop number at the time the
snapshot is read.

Road matching splits input at tracking gaps and physically implausible jumps
before calling the matching provider. This prevents a single corrupted GPS
sample from creating long straight connectors or contaminating adjacent route
segments.
