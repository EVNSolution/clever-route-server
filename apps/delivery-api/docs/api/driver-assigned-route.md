# Driver Assigned Route API

Purpose: after route+phone lookup and consent recording, the native driver app can read only the route assigned to the authenticated driver under the authenticated shop boundary.

This endpoint is the first route/stop read contract for `clever-driver-app`. Unlike route access lookup and consent submission, it can return stop address and coordinate context needed for delivery work. Treat successful responses as location-information provision from an engineering compliance standpoint.

## Runtime registration

The route is registered with the Driver API runtime when `JWT_SECRET` is configured. The bearer token must be a server-issued driver JWT with audience `clever-delivery-driver`; the token provides `driverId` and `shopDomain` so clients cannot choose the tenant or driver in the request body. Production rollout still needs the route+phone session/token issuance path and, if client-side sequencing is not sufficient, server-side current-consent/version enforcement before route/stop reads.

## GET `/driver/assigned-route`

Request:

```http
GET /driver/assigned-route?routeContext=11111111-1111-4111-8111-111111111111
Authorization: Bearer <server-issued driver JWT>
```

`routeContext` is optional for the contract, but the driver app should pass the route context returned by `POST /driver/route-access/lookup` whenever it has one. When present, the server binds the read to that route plan id as well as to the bearer-token driver and shop.

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

No assigned route, route context mismatch, wrong driver, wrong shop, completed/cancelled route, or missing route should return a safe empty status without leaking which part matched:

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

Invalid query values return `400` before repository lookup.

## Data boundary

The query is scoped by all of the following:

- bearer-token `shopDomain`
- bearer-token `driverId`
- optional `routeContext` / `RoutePlan.id`
- assigned route status currently limited to `ASSIGNED`, `IN_PROGRESS`, and `OPTIMIZED`

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
