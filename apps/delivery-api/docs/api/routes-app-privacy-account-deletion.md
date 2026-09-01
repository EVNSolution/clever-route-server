# CLEVER Routes privacy and account deletion

This document records the server-backed public disclosure for the **CLEVER Routes**
mobile app operated by **EV&Solution Co., Ltd.** It does not reuse or replace the
separate CLEVER Driver/DSV disclosure.

## Public URLs

All three pages are unauthenticated HTML routes served by `delivery-api`:

- `GET /routes-app/privacy`
- `GET /routes-app/support`
- `GET /routes-app/account-deletion`

Production URLs use the `https://clever-route-api.cleversystem.ai` origin.

## Data handling matrix

| Data | Purpose and scope | Processor or handoff | Default retention |
| --- | --- | --- | --- |
| Account name, registered phone, account id, login/session evidence | Authenticate the driver, scope assigned work, protect access, and provide support | CLEVER server and database | Active account lifetime; direct identifiers are deleted or de-identified after a verified deletion request unless an exception applies |
| Foreground and background precise location, timestamp, accuracy | Show current position and support route progress, arrival, safety, and dispute handling during an active delivery route | CLEVER server; configured map, geocoding, and routing providers | Raw `LOCATION_UPDATED` coordinates are minimized after their operational purpose; the compliance baseline is 90 days |
| Proof photo and metadata | Confirm delivery or failure | Access-controlled private storage; an optional configured scanner can inspect sanitized bytes | 180 days by default (`DRIVER_PROOF_MEDIA_RETENTION_DAYS`), unless a dispute, incident, contract, or legal hold applies |
| Signature, recipient name, and delivery notes | Confirm delivery outcome and provide stop context | CLEVER server and database | Delivery/operational retention policy, separated from direct account identity after deletion where possible |
| Route/stop events and ordered attempt evidence | Synchronize progress, enforce ordering/idempotency, and support audit/reconciliation | CLEVER server and database | Resolved ordered attempt evidence defaults to 90 days; unresolved or reconciliation-needed records can remain until resolved |
| Push token, device id or hashed device instance, app/platform version | Deliver operational notifications, secure sessions, detect duplicate devices, and troubleshoot sync | CLEVER server and Firebase Cloud Messaging (FCM) | Removed or revoked when the account is fulfilled for deletion; short-lived sync/session evidence follows its own operational policy |
| Destination address or coordinates chosen for navigation | Hand off navigation requested by the driver | The selected external map app, including Google Maps or Waze | Controlled by the selected provider after handoff; CLEVER retains its route/stop source under the policies above |

JPEG proof uploads have EXIF APP1 metadata removed before byte persistence and
before stored hash/size values are calculated. The public notice describes the
storage as private and access-controlled; it must not imply that proof bytes are
publicly addressable.

## External deletion intake

The public page deliberately has no destructive form, phone-only lookup, or PIN
field. A person who cannot use the signed-in app can email the privacy contact
shown on the page. The configured `PRIVACY_CONTACT_EMAIL` is used when valid;
otherwise the current EV&Solution privacy contact is displayed.

The email is only an intake channel. Operators must:

1. avoid requesting a password, PIN, bearer/refresh token, or proof photo by email;
2. use the account's already registered contact channel for a separate one-time
   verification instead of trusting email content or a supplied phone number;
3. resolve the verified person to the internal account/request identifier without
   copying phone, name, token, or proof data into command arguments or evidence;
4. converge retries on the same account-level deletion request;
5. defer fulfillment while an active route still requires safe completion or
   release; and
6. target completion within 30 days after verification and operational clearance,
   or communicate the reason and expected timing when a legal/contract review is
   required.

## Fulfillment boundary

Verified fulfillment removes or de-identifies account credentials and direct
identifiers, revokes login/refresh sessions, removes push tokens, and prevents the
deleted account from logging in again. Route, stop, delivery, consent timing,
proof, dispute, security, and non-identifying audit records can be retained when
needed for an active operational, contractual, dispute, security, or legal purpose.
They should remain separated from direct account identity and be deleted or
further de-identified when the exception ends.

Only status, timestamps, bounded reason codes, and other non-identifying audit
fields should remain on the completed deletion request. Do not store free-form
failure/rejection text containing personal data.

## Operator command boundary

Run the compiled command from `apps/delivery-api` after `npm run build`, or from
the deployed delivery API image. Arguments accept only internal UUIDs and a
non-identifying operator label. A request or fulfillment mutation requires both
`--execute true` and an exact matching confirmation UUID.

```bash
npm run routes-app:account-deletion -- --action request --account-id <account-uuid> --actor <operator-label> --execute false
npm run routes-app:account-deletion -- --action request --account-id <account-uuid> --confirm-account-id <same-account-uuid> --actor <operator-label> --execute true
npm run routes-app:account-deletion -- --action inspect --request-id <request-uuid>
npm run routes-app:account-deletion -- --action fulfill --request-id <request-uuid> --actor <operator-label> --execute false
npm run routes-app:account-deletion -- --action fulfill --request-id <request-uuid> --confirm-request-id <same-request-uuid> --actor <operator-label> --execute true
```

Do not pass a phone number, name, email, PIN, password, token, proof reference, or
free-form support content on the command line. Rejection accepts only the bounded
codes implemented by the service. Command output contains identifiers, status,
and aggregate counts only.

Deployment rollback may restore the previous application image. It must not
reverse a completed deletion or downgrade the database enum/columns. A failed or
expired processing lease can be retried through the same request identifier.

## Verification and release checks

Before release:

1. run `npm test -- privacy.routes.test.ts` from `apps/delivery-api`;
2. confirm each public path returns `200` without a cookie or authorization header;
3. confirm the privacy page names CLEVER Routes and EV&Solution and covers active
   route location, proof safeguards, FCM/device data, processors, retention, and
   map handoff;
4. confirm the deletion page contains an email link and no `<form>` or `<input>`;
5. use only synthetic accounts for deletion lifecycle tests; and
6. in production, verify page content and health only. Do not fulfill a real
   account deletion as a deployment smoke test.

Application rollback can return to the previous image/SHA. Public-page rollback
does not authorize deleting or reversing deletion lifecycle database records.
