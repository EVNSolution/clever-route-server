# KFood single completion and first Cash receipt

This contract extends `POST /driver/events`. It does not add an arrival step.
Base: PR #486, `9bd6e7b8408508c83b1e4255a62c37ee9b983bf0`.
The separate stacked PR must remain a draft until reviewed. No production activation is included.

## Client flow and compatibility

1. Read `GET /driver/assigned-route` with the current route bearer token.
2. Display `data.route.stops[].payment.methodTitle`, `expectedAmount`, and `currencyCode`.
   Keep existing address, phone, recipient, and order information in the stop detail.
3. If `completion` exists, display that first receipt. Do not request another first collection.
4. If `payment.requiresCashInput` is true, ask for the actual Cash amount in the completion input.
   Keep zero distinct from an empty input. Do not assume an unknown currency.
5. Persist the complete request, original assignment, original route/publication version,
   occurrence time, and globally unique `clientEventId` before sending it.
6. Submit one `STOP_DELIVERED` event. Do not synthesize `STOP_ARRIVED` or an arrival time.
7. Retry the saved request unchanged after response loss. Clear the pending item only after
   its accepted response or account receipt lookup confirms `APPLIED`.

`completion.version: 1` is an explicit opt-in for the KFood shop and `driverContractVersion: 2`.
It requires the existing v2 client event ID, assignment generation, and route/publication version.
Requests without `completion` keep the legacy path, including old KFood apps and DSV.
Those requests do not create a Cash receipt and do not mean that zero Cash was received.
This API does not make a rollout mandatory or enable a production feature.

eTransfer has no Cash input and no new required confirmation. Unknown methods are not classified as Cash.
This change adds no photo/signature requirement, upload feature, or proof setting.
Only separately configured ON requirements belong in the same future completion flow.
Proof OFF must not add input. This PR does not claim to implement the separate proof-policy work.

## Request

All IDs below are synthetic. Use the actual stop and v2 identity returned by the server.
`completion` is a **top-level event-body field**, not inside the existing optional `payload` field.

```http
POST /driver/events
Authorization: Bearer <route-token>
Content-Type: application/json
```

```json
{
  "clientEventId": "1ca60000-0000-4000-8000-000000000001",
  "eventType": "STOP_DELIVERED",
  "deliveryStopId": "1ca60000-0000-4000-8000-000000000002",
  "occurredAt": "2026-10-08T07:00:00.000Z",
  "driverContractVersion": 2,
  "assignmentGeneration": "2",
  "expectedRouteVersionId": "1ca60000-0000-4000-8000-000000000003",
  "completion": {
    "version": 1,
    "cashReceived": { "amount": "122.00", "currency": "CAD" }
  }
}
```

Money must be a nonnegative decimal **string**, up to 16 integer digits and two decimal places.
`"122"`, `"122.0"`, and `"122.00"` normalize to `"122.00"`. Numbers, negatives,
exponents, more than two decimal places, unsupported completion fields, and currency mismatch are rejected.
The currency must match the server source. This v1 contract supports two-decimal amounts.
The client cannot submit the expected amount or difference.

For eTransfer, unknown methods, paid Cash, and zero-outstanding Cash:

```json
{ "completion": { "version": 1 } }
```

This fragment accompanies the same required event identity fields.
Cash input is rejected for non-Cash methods. Paid or noncollectible Cash permits omitted input or explicit zero,
but never an unsolicited positive collection. If Cash has no usable source currency, correct the source before
using this opt-in contract; do not invent CAD. Legacy clients remain compatible.

## Success and exact amounts

First acceptance returns HTTP 202. The response contains `data.eventId`, `data.duplicate: false`,
the existing ETA fields where applicable, and the following `data.completion` shape:

```json
{
  "id": "1ca60000-0000-4000-8000-000000000004",
  "eventId": "1ca60000-0000-4000-8000-000000000005",
  "deliveryStopId": "1ca60000-0000-4000-8000-000000000002",
  "routePlanId": "1ca60000-0000-4000-8000-000000000006",
  "driverId": "1ca60000-0000-4000-8000-000000000007",
  "assignmentGeneration": "2",
  "expectedRouteVersionId": "1ca60000-0000-4000-8000-000000000003",
  "method": "CASH",
  "payment": {
    "method": "CASH",
    "methodTitle": "Cash",
    "gatewayNames": ["Cash"],
    "financialStatus": "PENDING",
    "expectedAmount": "122.25",
    "currencyCode": "CAD",
    "expectedAmountSource": "SHOPIFY_OUTSTANDING",
    "requiresCashInput": true
  },
  "expectedAmount": "122.25",
  "actualAmount": "122.00",
  "differenceAmount": "-0.25",
  "currencyCode": "CAD",
  "occurredAt": "2026-10-08T07:00:00.000Z",
  "recordedAt": "2026-10-08T07:00:02.000Z"
}
```

| Expected CAD | Actual input | Stored actual | Stored difference |
| --- | --- | --- | --- |
| 122.25 | `"122"` | `"122.00"` | `"-0.25"` |
| 122.25 | `"122.25"` | `"122.25"` | `"0.00"` |
| 122.25 | `"123"` | `"123.00"` | `"0.75"` |
| 122.25 | `"0"` | `"0.00"` | `"-122.25"` |
| 122.25 Cash | omitted | HTTP 400 in v1 | no completion or receipt committed |
| unknown partial Cash | `"22.00"` | `"22.00"` | `null` |
| paid / eTransfer | omitted | `null` | `null` |

The order total remains unchanged. `occurredAt` is the original client event time.
`recordedAt` is the server event creation time. The receipt contains the original driver, event,
assignment, and source publication/version. It is not a settlement approval, discount, or tip.

## Payment source rules

Both driver and office APIs use `resolveOrderPayment()` against the same order source.
Named gateway methods take precedence. A generic manual gateway can use the explicit manual method.
Legacy `cleverManualPaymentStatus` values `CASH`/`ETRANSFER` and title/method fields remain supported.
Unrecognized names are preserved; mixed or missing methods are never guessed to be Cash.

Paid means expected zero. A valid, matching-currency `totalOutstandingSet.shopMoney` supplies the
outstanding amount. The server's read-only Shopify query now requests this field.
Shopify documents negative outstanding as money owed back to the customer; this is not a Cash collection.
See [Shopify Order.totalOutstandingSet](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/Order#field-Order.fields.totalOutstandingSet).

Only explicit unpaid/pending source status can use the order total as a fallback.
Partial, conflicting, invalid, and unknown source balances remain `null`; no blind total substitution occurs.
An invalid explicit outstanding amount or mismatched currency does not fall back to the total.
Older cached orders can lack the new field. No backfill, production sync, or upstream payment mutation runs here.
The expected amount is fixed from server data in the first completion transaction, not the client's display value.

## Retry, authorization, and errors

The transaction uses the existing route lock and PR486 authorization/version checks.
Completion state, event, ETA changes, notification facts, and first receipt commit or roll back together.
The receipt stores the result including original ETA data. An exact retry returns HTTP 200 with
`duplicate: true` and the original event, completion, and ETA result, even after server recreation.
It does not recalculate money or ETA from subsequent order changes.

The v1 receipt's `clientEventId` is globally unique; generate a UUID and never reuse it.
Changing the body, amount, actor, shop, route, stop, assignment, or original version cannot replace the receipt.
Equivalent decimal strings and JSON key order normalize for comparison. Save all other request fields unchanged.
A different event ID for an already completed stop cannot create a second receipt or backfill a legacy completion.
The client must present a conflict for office review; it must not silently drop or rewrite pending money.

| HTTP | Code | Meaning |
| --- | --- | --- |
| 400 | `CASH_RECEIVED_REQUIRED` | opt-in Cash completion has no actual amount |
| 400 | `CASH_COMPLETION_INVALID` | malformed/unsupported contract, method, amount, or currency |
| 409 | `CASH_COMPLETION_CONFLICT` | event identity/payload conflict or previous first completion |
| 409 | `ROUTE_ASSIGNMENT_CHANGED` | original assignment no longer permits a new write |
| 409 | `ROUTE_VERSION_MISMATCH` | PR486 does not permit this old-version stop write |
| 401/403 | existing authentication/scope code | route/account/stop access rejected |
| 5xx | existing server error | retry the saved request; do not manufacture a replacement ID |

Existing start, dispatch ownership, sequence handling, and stop transition validation remain in effect.
PR486 permits an unchanged stop's queued completion across unrelated publications under the same assignment.
Changed stops and obsolete assignments remain rejected. Merely fetching or applying a publication creates no collection.

The POST keeps existing route-token expiry, assignment access, and KFood navigation-grace rules.
If those rules prevent a retry, use the existing **account-token** receipt lookup:

```http
GET /driver/event-receipts/1ca60000-0000-4000-8000-000000000006/1ca60000-0000-4000-8000-000000000001
Authorization: Bearer <account-token>
```

An accepted result returns `data.status: "APPLIED"` and the same `data.completion` object.
`UNKNOWN` is not proof of failure. A different account cannot read the original driver's receipt.
Token renewal is still required for expired account authentication.

## Office and driver reads

| API | Field |
| --- | --- |
| `GET /driver/assigned-route` | `data.route.stops[].payment` and `.completion` |
| `GET /driver/event-receipts/:routePlanId/:clientEventId` | `data.completion` for accepted v1 events |
| `GET /admin/inventories` | `data.inventories[].orders[].payment` and `.completion` |
| `GET /admin/inventories/:inventoryId` | `data.inventory.orders[].payment` and `.completion` |
| `GET /admin/inventories/:inventoryId/order-view` | `data.inventory.orders[].payment` and `.completion` |

Existing bearer and app/shop gates are unchanged. `payment` represents current source data.
`completion` represents the immutable original collection snapshot. It is null on the stop/order when unrecorded.
Do not display current `payment.expectedAmount` as the historical expected amount after completion.
There is no settlement/adjustment endpoint in this change.

## Migration, rollout, and rollback

Apply `20261008090000_driver_stop_completion_receipts` before running this backend revision.
It adds one table, unique/index constraints, composite tenant foreign keys, an amount check,
and an UPDATE rejection trigger. It adds a unique `(id, shopId)` index to `driver_events`.
It rewrites no order amount or historical completion. Index creation needs a production lock window assessment.
Existing privacy deletion may cascade receipts with their event or stop; immutability governs updates, not a new retention exemption.

Stage migration and backend first, verify these APIs, then enable the app's opt-in flow in a separately reviewed release.
Rollback the application first and retain the additive table and accepted receipts. Disable the app opt-in flow
before an old backend can accept and ignore its new field. Do not drop receipts or replay Cash as a legacy event.
Any future correction must use a separate audited office contract. No correction or settlement authority is inferred here.

## Verification and release limits

`CLEVER_RUN_DISPOSABLE_DB_TESTS=1 bash apps/delivery-api/scripts/test-cash-completion-db.sh`
creates a named temporary loopback PostgreSQL database, applies migrations, and runs real socket HTTP tests.
The runner rejects production URLs and removes only its own cluster/container. The existing disposable CI lane calls it.
Unit tests cover source extraction and driver/office consistency. The full backend checks remain required.

These are server checks. They do not certify app UI, Shopify iframe, a physical device, photo upload, or production behavior.
PR297 audit, existing SQLite failures, and app termination immediately after ACK/completion response loss remain app release gates.
No app/Shopify repository changes, merge, deploy, AWS/DNS changes, or production data changes are included.
