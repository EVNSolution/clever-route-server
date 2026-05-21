# Admin Route Plans API

Purpose: the Shopify embedded UI saves selected delivery orders into the delivery
server as the route/order/delivery source of truth. The first MVP optimizer keeps
the user-selected order sequence and stores a `DRAFT` route plan.

## Authentication

All routes require a Shopify embedded app session token:

```http
Authorization: Bearer <shopify-session-token>
```

The server verifies the token with `SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET`.
`shopDomain` is derived from the token, not from request payload. If the embedded
UI runs from another origin, configure `SHOPIFY_APP_URL` so CORS allows that app
origin.

## POST `/admin/route-plans`

Creates a draft route plan for the authenticated shop.

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

- `Shop` is upserted by token-derived `shopDomain`.
- `Order` is upserted by `(shopId, shopifyOrderGid)`.
- `DeliveryStop` is upserted by `(shopId, orderId)`.
- `RoutePlan` is created with `status=DRAFT`,
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
      "status": "DRAFT",
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
        "status": "DRAFT",
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
      "status": "DRAFT",
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
