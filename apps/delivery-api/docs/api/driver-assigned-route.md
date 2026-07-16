# Driver Assigned Route API

Purpose: after account route lookup and consent recording, the native driver app can read only the route assigned to the authenticated global DriverAccount.

This endpoint is the first route/stop read contract for `clever-driver-app`. Unlike route access lookup and consent submission, it can return stop address and coordinate context needed for delivery work. Treat successful responses as location-information provision from an engineering compliance standpoint.

## Runtime registration

The route is registered with the Driver API runtime when `JWT_SECRET` is configured. The bearer token must be a server-issued route JWT with audience `clever-delivery-driver-route`; it binds `DriverAccount.id` to one assigned `RoutePlan.id`. The server verifies that the route's current Store driver reference is still linked to that account and derives Store context from the route. Production rollout still needs server-side current-consent/version enforcement before route/stop reads if client-side sequencing is not sufficient.

## GET `/driver/assigned-route`

Request:

```http
GET /driver/assigned-route?routeContext=11111111-1111-4111-8111-111111111111
Authorization: Bearer <server-issued driver JWT>
```

`routeContext` is optional for the contract, but the driver app should pass the route context returned by `POST /driver/route-access/lookup` whenever it has one. When present, it must equal the route plan id already bound to the bearer token; a client-supplied value can only narrow or reject the request, never select another route.

Success with an assigned route:

```json
{
  "data": {
    "status": "ASSIGNED_ROUTE",
    "route": {
      "id": "11111111-1111-4111-8111-111111111111",
      "name": "Tuesday AM Route",
      "deliveryDate": "2026-05-12",
      "shopDomain": "example.myshopify.com",
      "timezone": "America/Toronto",
      "stops": [
        {
          "deliveryStopId": "22222222-2222-4222-8222-222222222222",
          "sequence": 1,
          "status": "ASSIGNED",
          "orderName": "#1001",
          "recipientName": "Recipient One",
          "phone": "+14165550123",
          "address": {
            "address1": "100 King St W",
            "address2": null,
            "city": "Toronto",
            "province": "ON",
            "postalCode": "M5X 1A9",
            "countryCode": "CA"
          },
          "coordinates": {
            "latitude": 43.6487,
            "longitude": -79.3817
          }
        }
      ]
    }
  },
  "error": null
}
```

No assigned route, completed/cancelled route, or missing route returns a safe empty status without leaking which part matched:

```json
{
  "data": { "status": "NO_ASSIGNED_ROUTE" },
  "error": null
}
```

Missing or invalid bearer tokens return `401`:

```json
{
  "data": null,
  "error": { "code": "UNAUTHORIZED", "message": "Missing driver bearer token" }
}
```

An optional `routeContext` that differs from the token route returns `403 ROUTE_ASSIGNMENT_ACCOUNT_MISMATCH`. An expired token or one whose current account assignment no longer resolves returns `401 DRIVER_ACCESS_TOKEN_INVALID`, allowing the app to refresh its route choices.

Invalid query values return `400` before repository lookup.

## Data boundary

The query is scoped by all of the following:

- bearer-token `DriverAccount.id`
- bearer-token `RoutePlan.id`
- current RoutePlan → Store driver reference → DriverAccount linkage
- Store id derived from that RoutePlan
- optional matching `routeContext`
- route execution state is `READY` before start and `IN_PROGRESS` after the
  driver's explicit start event; legacy pre-execution values remain readable
- persisted `COMPLETED`/`CANCELLED` routes and legacy rows with a prior
  `ROUTE_COMPLETED` event are excluded from operational assigned-route reads

The response must not include other drivers' routes, unrelated orders, raw Shopify payloads, or admin-only planning metadata. Stop address, recipient, phone, and coordinates are intentionally returned only after the driver boundary is verified.

## Compliance note

A successful assigned route read provides stop address/location context to the driver app, so it is classified as `PROVIDE` in `docs/compliance/location-data-handling.md`. Dedicated `LocationAccessLog` / `LocationUsageRecord` persistence remains a follow-up hardening slice.

## Follow-up APIs

- proof media upload: `docs/api/driver-proof-media.md`
- stop detail read and final proof-of-delivery status mutation semantics
- driver session/access token issuance after route+phone lookup
- server-side current-consent/version enforcement for route/stop reads when required by the production access model
- dedicated location access/usage logging for route/stop reads
- foreground/background GPS collection after explicit delivery start
