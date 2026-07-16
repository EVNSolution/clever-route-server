# Driver Consent API

Purpose: persist the native driver's explicit consent before the driver app can request assigned route or stop details, foreground/background location services, or delivery event collection.

This contract is intentionally narrow. It records global DriverAccount consent evidence after verifying the authenticated account/route assignment and returns only the consent status. It does not return route stops, customer addresses, coordinates, order data, or a route assignment list.

## Runtime registration

The route is registered with the Driver API runtime when `JWT_SECRET` is configured. The bearer token must be a server-issued route JWT with audience `clever-delivery-driver-route`; it binds `DriverAccount.id` to one assigned `RoutePlan.id`. The server derives the Store driver reference and Store from that assignment, so clients cannot choose a Store or driver reference in the request body.

## POST `/driver/consents`

Request:

```http
POST /driver/consents
Authorization: Bearer <server-issued driver JWT>
Content-Type: application/json
```

```json
{
  "routeContext": "11111111-1111-4111-8111-111111111111",
  "recordedAt": "2026-05-12T05:50:00.000Z",
  "deviceContext": { "platform": "ios" },
  "appContext": { "appVersion": "0.1.0" },
  "consents": [
    { "type": "LOCATION_INFORMATION", "version": "location-v1", "accepted": true },
    { "type": "PERSONAL_INFORMATION", "version": "privacy-v1", "accepted": true }
  ]
}
```

Required consent types for this slice:

- `LOCATION_INFORMATION` — driver app location-information collection/use/provision notice acceptance.
- `PERSONAL_INFORMATION` — driver app personal-information/privacy notice acceptance.

Both records must be present and `accepted: true`. Version strings are caller supplied so the mobile app and legal copy can advance without changing the enum. `routeContext` is optional, but when present it must equal the route id bound to the bearer token. `deviceContext` and `appContext` are optional evidence fields; none of these fields may contain route stops, customer addresses, coordinates, or secrets.

Responses:

```json
{
  "data": {
    "status": "CONSENT_RECORDED",
    "recordedAt": "2026-05-12T05:50:00.000Z",
    "records": [
      { "type": "LOCATION_INFORMATION", "version": "location-v1", "accepted": true },
      { "type": "PERSONAL_INFORMATION", "version": "privacy-v1", "accepted": true }
    ]
  },
  "error": null
}
```

Missing or invalid bearer tokens return:

```json
{
  "data": null,
  "error": { "code": "UNAUTHORIZED", "message": "Missing driver bearer token" }
}
```

Invalid payloads return:

```json
{
  "data": null,
  "error": { "code": "BAD_REQUEST", "message": "Invalid driver consent payload" }
}
```

An optional `routeContext` that does not match the token route returns `403 ROUTE_ASSIGNMENT_ACCOUNT_MISMATCH`. A route assignment that disappeared before persistence returns `404 ROUTE_ASSIGNMENT_NOT_FOUND`. Unexpected persistence failures return the stable `500 CONSENT_RECORD_FAILED` response while internal details remain server-side.

## Persistence model

`DriverConsentRecord` stores one upserted row per `(accountId, consentType, consentVersion)`. Re-submitting the same consent version updates the accepted flag, route context, device/app context, current Store/reference evidence, and recorded timestamp. The account remains the consent owner even if a Store later deletes its local driver reference or Store row; nullable Store and Store-reference ids are retained only as assignment evidence while those records exist.

## Data minimization

Consent records are evidence that a driver accepted the relevant notices. They are not assigned-route reads and they are not location collection ledgers by themselves. Assigned route reads and future stop/GPS APIs still need access/usage logging according to `docs/compliance/location-data-handling.md`.

## Adjacent and follow-up APIs

Implemented adjacent contract:

- assigned route read: `docs/api/driver-assigned-route.md`

Remaining follow-up contracts:

- proof media upload: `docs/api/driver-proof-media.md`
- stop detail reads and final stop action mutation semantics after assigned route read
- server-side current-consent/version enforcement for route/stop reads when the client sequence alone is not sufficient
- foreground/background location event hardening and location usage/access logging
- consent copy source-of-truth/version registry
- driver login/session issuance
