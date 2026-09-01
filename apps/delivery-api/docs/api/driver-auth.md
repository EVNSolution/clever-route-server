# Driver Authentication API

The driver account belongs to one E.164 phone number across shops. Shopify keeps creating and displaying the existing six-character invitation code; it does not own the driver's PIN or normal login session.

## First registration

An unregistered phone must first be invited by a shop. The app collects the phone, invitation code, and a new six-digit numeric PIN, then submits them together:

```http
POST /driver/auth/verify-invite
Content-Type: application/json
```

```json
{
  "phone": "+14165550123",
  "inviteCode": "ABC123",
  "pin": "012345"
}
```

The server consumes the invitation, creates one global phone account, links every active driver assignment with that phone, and returns a short-lived driver-account access token plus a 30-day refresh token. The PIN is stored only as a salted `scrypt` hash.

If a shop later assigns a route to a phone that already has an account, the server links that shop driver immediately. No new invitation code or registration step is required.

A shop administrator cannot reset the phone-owned PIN or revoke the global account session. Re-requesting an invitation for an already linked account keeps it linked and does not issue another registration code.

## Normal login

Registered drivers log in without an invitation code:

```http
POST /driver/auth/login
Content-Type: application/json
```

```json
{
  "phone": "+14165550123",
  "pin": "012345"
}
```

Five consecutive invalid PIN attempts lock the account for 15 minutes. Responses do not disclose whether the phone or PIN was incorrect.

Both successful endpoints return the same account session shape:

```json
{
  "data": {
    "accessToken": "<short-lived-account-jwt>",
    "expiresAt": "2026-07-14T07:15:00.000Z",
    "refreshToken": "<refresh-token>",
    "refreshTokenExpiresAt": "2026-08-13T07:00:00.000Z",
    "tokenType": "Bearer",
    "ttlSeconds": 900,
    "use": "driver_account"
  },
  "error": null
}
```

The account access token uses audience `clever-driver-account`. The app sends it to `POST /driver/route-access/lookup`; the server then issues the existing shop-and-driver-scoped access token for the selected route.

## Account profile name

The driver's self-chosen app name belongs to the phone account and is independent from every shop's merchant-managed `Driver.displayName`. Existing accounts start with no account name; store aliases are not copied or synchronized.

```http
GET /driver/account/profile
Authorization: Bearer <driver-account-access-token>
```

```http
PATCH /driver/account/profile
Authorization: Bearer <driver-account-access-token>
Content-Type: application/json
```

```json
{
  "name": "Jiin"
}
```

Both endpoints return only the account phone and nullable name. The account JWT must still match an active account and its current token version.

## Global account deletion request

The app requests deletion with the phone-account bearer, not a selected Store
route token:

```http
POST /driver/account-deletion-requests
Authorization: Bearer <driver-account-access-token>
Content-Type: application/json
```

The body requires `confirmation: "DELETE"` and accepts an optional `reason`.
The endpoint creates one idempotent `REQUESTED` audit record for the global
`DriverAccount`. A legacy route bearer converges on the same account request when
the driver is linked to an account. It returns `409
ACCOUNT_DELETION_ACTIVE_ROUTE` while any linked route is `IN_PROGRESS`.

Request intake does not immediately delete records. A verified operator runs the
bounded lifecycle separately. Fulfillment moves through `PROCESSING` and ends in
`COMPLETED`, or moves to `DEFERRED` while an active route exists. Transaction
failure is recorded as retryable `FAILED`; policy refusal uses a bounded
`REJECTED` reason code. Completed/rejected requests are idempotent on retry.

Successful fulfillment revokes account and driver refresh sessions, removes push
tokens, invalidates access-token versions, clears authentication secrets and
direct account/driver identifiers, clears consent device context, and redacts
free-form route feedback. Delivery, route, consent timing, proof, dispute,
security, and non-identifying audit records remain under their documented
retention and legal/contract exceptions.

The public external intake is `GET /routes-app/account-deletion`. Email intake is
not identity proof. An operator must use the already registered contact channel
for one-time verification before creating an `OPERATOR_VERIFIED_CONTACT` request.

## Security boundary

The invitation code proves that a shop assigned the phone. The PIN protects later app access but is not SMS-based proof that the user owns the phone number. SMS verification can replace the invitation step later without changing the phone-owned account or normal phone + PIN login contract.
