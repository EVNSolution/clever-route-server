# Driver Route Access API

Purpose: the native driver app uses an authenticated phone account to return
that account's Ready or in-progress route choices before showing
route/stop/customer details.

This is the first driver-facing contract for `clever-routes-app`. It intentionally returns only non-sensitive company/route guidance. Consent records and assigned-route reads are implemented as separate authenticated contracts; stop detail/actions, driver session issuance, and location collection remain follow-up APIs.

## Runtime registration

The route is registered with the existing Driver API runtime dependencies when `JWT_SECRET` is configured. Driver mobile clients still call this server, not Shopify Admin APIs.

## Account-first lookup

The primary lookup uses the `clever-driver-account` bearer token returned by registration or phone + PIN login:

- client sends the account bearer token and omits `routeContext` or sends `routeContext: null`
- server finds `READY` or `IN_PROGRESS` route plans assigned to active drivers
  linked to that account; completed/cancelled routes and legacy rows with a
  prior completion event are excluded
- a vehicle-backed route plan remains selectable even when it currently has no
  route stops, so the driver can open the public delivery Space and acquire a
  destination bundle before departure
- when an active driver has a registered vehicle but no route plan, the server
  materializes one empty `READY` child route in the latest route grouping that
  still contains public unassigned orders; the normal route-scoped token and
  delivery Space contracts are then reused without granting account-wide order access
- if active route assignments exist, server returns `ROUTES_FOUND` with route choices; each choice carries company guidance, route access identifiers, and short-lived `driverAccess`
- if matching operational route plans exist but none has a registered vehicle,
  server returns `VEHICLE_REQUIRED` without issuing route access
- if the account has active driver assignments but neither an active route nor
  a public grouping to enter, server returns `ROUTES_FOUND` with an empty `routes` array
- if the account has no driver assignment, server returns `NOT_FOUND`
- if the account is linked only to inactive/suspended drivers, server returns `DISABLED` or `BLOCKED`

`routeContext` is an optional exact/narrowed lookup field:

- exact route context: an assigned `RoutePlan.id` UUID
- shared route/company scope: a non-UUID value stored at `RoutePlan.constraints.routeScope.routeScopeKey`

The current driver app does not ask drivers for external route access artifacts. Multi-company assignments are returned as route choices; company/shop guidance is attached to each route.

The phone number is not accepted in this request body. Account identity comes only from the verified bearer token.

## POST `/driver/route-access/lookup`

Request:

```http
POST /driver/route-access/lookup
Content-Type: application/json
Authorization: Bearer <driver-account-jwt>
```

```json
{
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

Account route response:

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
          "executionStatus": "READY",
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

Registered account with no active route assignments:

```json
{ "data": { "status": "ROUTES_FOUND", "routes": [] }, "error": null }
```

Exact route context lookup may return a single `INVITED` object with the same route choice fields at the top level.
Exact and shared-scope lookups apply the same operational-state filter as the account route list, so completed or cancelled routes never receive a new route token.

Safe denial statuses return `200` with no guidance payload:

```json
{ "data": { "status": "NOT_FOUND" }, "error": null }
{ "data": { "status": "DISABLED" }, "error": null }
{ "data": { "status": "BLOCKED" }, "error": null }
{ "data": { "status": "VEHICLE_REQUIRED" }, "error": null }
```

`NOT_FOUND` covers accounts without driver assignments and exact/narrowed lookups that do not belong to the authenticated account. `VEHICLE_REQUIRED` covers an otherwise matching operational route that cannot enter the delivery Space because no registered vehicle is assigned. Registered accounts with no active route assignments return `ROUTES_FOUND` with an empty `routes` array.

Ambiguous shared route/company scope response:

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
    "resolutionHint": "Use the account route list or contact dispatch."
  },
  "error": null
}
```

## Data minimization

The lookup response must not include delivery stops, customer addresses, coordinates, or order data. `ROUTES_FOUND` route choices and legacy `INVITED` only return enough non-sensitive context for the driver to confirm the company/shop/route before the consent gate, plus a short-lived bearer token for the matched account/route assignment.

`driverAccess.accessToken` is a server-signed HS256 JWT with audience `clever-delivery-driver-route`. It is scoped to the authenticated global `DriverAccount.id` and assigned `RoutePlan.id`, expires after 900 seconds, and is intended only for the next routes-app calls such as `POST /driver/consents`, `GET /driver/assigned-route`, proof media, and delivery events. The server resolves the current Store reference and Store context from that exact assignment on every request; clients do not choose Store membership through token claims or request fields. Denial responses never include `driverAccess`. SMS-based phone verification and PIN recovery remain follow-up security work.

Route tokens minted before this boundary change used the legacy `clever-delivery-driver` audience and are intentionally not accepted by route-scoped endpoints. Their lifetime is 900 seconds; a `401 DRIVER_ACCESS_TOKEN_INVALID` response tells the current app to refresh account access and run route lookup again. Account login/refresh tokens keep their existing audience and contract.

`MULTIPLE_MATCHES` responses are stricter than route choices: they must not include `driverAccess`, `driverContext`, `routeAccess`, `routePlanId`, stops, customer names, customer addresses, coordinates, orders, proof-media data, or any other route-specific bearer credential. They are display-only responses; current driver UX should use account route choices or dispatch support.

## Adjacent and follow-up APIs

Implemented adjacent contracts:

- consent record persistence: `docs/api/driver-consents.md`
- assigned route read after consent-gated app flow: `docs/api/driver-assigned-route.md`

Remaining follow-up contracts:

- stop detail read and stop action writes with assigned-driver boundary
- driver event/location update hardening and location usage/access logging
