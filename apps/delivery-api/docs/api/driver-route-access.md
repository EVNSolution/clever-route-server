# Driver Route Access API

Purpose: the native driver app verifies an E.164 phone number against registered drivers and returns the active route choices assigned to that phone before showing route/stop/customer details.

This is the first driver-facing contract for `clever-driver-app`. It intentionally returns only non-sensitive company/route guidance. Consent records and assigned-route reads are implemented as separate authenticated contracts; stop detail/actions, driver session issuance, and location collection remain follow-up APIs.

## Runtime registration

The route is registered with the existing Driver API runtime dependencies when `JWT_SECRET` is configured. Driver mobile clients still call this server, not Shopify Admin APIs.

## Phone-first lookup

The primary lookup shape is phone-only:

- client sends `phoneE164` and omits `routeContext` or sends `routeContext: null`
- server finds active route plans assigned to active drivers with that phone number
- if active route assignments exist, server returns `ROUTES_FOUND` with route choices; each choice carries company guidance, route access identifiers, and short-lived `driverAccess`
- if the phone belongs to an active driver but no active route is assigned, server returns `ROUTES_FOUND` with an empty `routes` array
- if the phone is not registered, server returns `NOT_FOUND`
- if the phone is registered only to inactive/suspended drivers, server returns `DISABLED` or `BLOCKED`

`routeContext` remains accepted only as a backward-compatible exact/narrowed lookup field for internal clients and older app builds:

- exact route context: an assigned `RoutePlan.id` UUID
- shared route/company scope: a non-UUID value stored at `RoutePlan.constraints.routeScope.routeScopeKey`

The current driver app does not ask drivers for external route access artifacts. Multi-company assignments are returned as route choices; company/shop guidance is attached to each route.

Phone numbers must be normalized to E.164 before request.

## POST `/driver/route-access/lookup`

Request:

```http
POST /driver/route-access/lookup
Content-Type: application/json
```

```json
{
  "phoneE164": "+14165550123",
  "routeContext": null
}
```

Validation failures return `400` before repository lookup:

```json
{
  "data": null,
  "error": {
    "code": "BAD_REQUEST",
    "message": "Invalid route access lookup payload"
  }
}
```

Phone-first active route response:

```json
{
  "data": {
    "status": "ROUTES_FOUND",
    "routes": [
      {
        "routeAccess": {
          "routeContext": "11111111-1111-4111-8111-111111111111",
          "routePlanId": "11111111-1111-4111-8111-111111111111",
          "nextState": "consent_required"
        },
        "driverAccess": {
          "accessToken": "<short-lived-driver-jwt>",
          "tokenType": "Bearer",
          "expiresAt": "2026-05-12T06:55:00.000Z",
          "ttlSeconds": 900,
          "use": "consent_and_assigned_route"
        },
        "companyGuidance": {
          "companyDisplayName": "Tomatono Toronto",
          "shopDomain": "tomatono.myshopify.com",
          "routeName": "Tuesday AM Route",
          "deliveryDate": "2026-05-12",
          "timezone": "America/Toronto",
          "pickupGuidance": "Meet at dispatch desk by 9:00 AM",
          "operatorSupportContact": "+14165550000",
          "driverInstructions": ["Bring insulated bag"]
        }
      }
    ]
  },
  "error": null
}
```

Registered active phone with no active route assignments:

```json
{ "data": { "status": "ROUTES_FOUND", "routes": [] }, "error": null }
```

Backward-compatible exact route context lookup may return a single `INVITED` object with the same route choice fields at the top level.

Safe denial statuses return `200` with no guidance payload:

```json
{ "data": { "status": "NOT_FOUND" }, "error": null }
{ "data": { "status": "DISABLED" }, "error": null }
{ "data": { "status": "BLOCKED" }, "error": null }
```

`NOT_FOUND` covers unregistered phones and backward-compatible exact/narrowed lookups that do not match the supplied phone. Registered active phones with no active route assignments return `ROUTES_FOUND` with an empty `routes` array.

Backward-compatible ambiguous shared route/company scope response:

```json
{
  "data": {
    "status": "MULTIPLE_MATCHES",
    "matches": [
      {
        "companyDisplayName": "Tomatono Toronto",
        "shopDomain": "tomatono.myshopify.com",
        "routeName": "Tuesday AM Route",
        "deliveryDate": "2026-05-12",
        "timezone": "America/Toronto",
        "pickupGuidance": "Meet at dispatch desk by 9:00 AM",
        "operatorSupportContact": "+14165550000"
      }
    ],
    "resolutionHint": "Use the phone-only route list or contact dispatch."
  },
  "error": null
}
```

## Data minimization

The lookup response must not include delivery stops, customer addresses, coordinates, or order data. `ROUTES_FOUND` route choices and legacy `INVITED` only return enough non-sensitive context for the driver to confirm the company/shop/route before the consent gate, plus a short-lived bearer token for the matched driver/shop boundary.

`driverAccess.accessToken` is a server-signed HS256 JWT with audience `clever-delivery-driver`. It is scoped to the matched `driverId` and `shopDomain`, expires after 900 seconds, and is intended only for the next driver-app calls such as `POST /driver/consents` and `GET /driver/assigned-route`. Denial responses never include `driverAccess`. OTP/deep-link hardening, refresh sessions, and token rotation remain follow-up security work.

`MULTIPLE_MATCHES` responses are stricter than route choices: they must not include `driverAccess`, `driverContext`, `routeAccess`, `routePlanId`, stops, customer names, customer addresses, coordinates, orders, proof-media data, or any other route-specific bearer credential. They are legacy display-only responses; current driver UX should use phone-only route choices or dispatch support.

## Adjacent and follow-up APIs

Implemented adjacent contracts:

- consent record persistence: `docs/api/driver-consents.md`
- assigned route read after consent-gated app flow: `docs/api/driver-assigned-route.md`

Remaining follow-up contracts:

- stop detail read and stop action writes with assigned-driver boundary
- driver event/location update hardening and location usage/access logging
