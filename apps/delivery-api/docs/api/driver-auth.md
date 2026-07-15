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

## Security boundary

The invitation code proves that a shop assigned the phone. The PIN protects later app access but is not SMS-based proof that the user owns the phone number. SMS verification can replace the invitation step later without changing the phone-owned account or normal phone + PIN login contract.
