# KFood delivery options and office Cash confirmation

Change control: EVNSolution/clever-change-control#317. Server: EVNSolution/clever-route-server#490.
Implementation contract; release requires integration verification and compatible app acceptance.

## Route options

`PATCH /admin/route-plans/:routePlanId/options` uses the existing office bearer/app/shop authorization.
Existing `routeEndMode` remains optional for additive option patches.

```json
{
  "expectedUpdatedAt": "2026-10-09T00:00:00.000Z",
  "routeEndMode": "END_AT_LAST_STOP",
  "deliveryProof": { "photoRequired": false, "signatureRequired": false },
  "tollPolicy": "ALLOW_TOLLS"
}
```

`routePlan.deliveryProof` and `routePlan.tollPolicy` appear in office route summaries/detail;
`data.route.deliveryProof` and `.tollPolicy` appear in driver assigned-route.
Defaults are both proof requirements OFF and `ALLOW_TOLLS`.
`AVOID_TOLLS` must be supported by the selected routing provider or return an explicit error.
Proof/toll changes are rejected after driver assignment or publication, and after the route starts (`DELIVERY_OPTIONS_LOCKED`, HTTP 409).
This keeps the policy fixed for existing Dispatch/Apply and offline completion requests.
Proof ON additionally requires the explicit server rollout configuration `KFOOD_DELIVERY_PROOF_ENABLED=true`.
The default is false. Enable only after the compatible app release is verified; existing 1.3.6/42 cannot collect required signatures.
No option changes Shopify order/customer source data.

## Driver proof

Existing `POST /driver/proof-media` remains multipart with `routePlanId`, `deliveryStopId`, `source`, and `file`.
Optional `kind` is `photo` (default) or `signature`. Signature uses `source=signature` and PNG bytes.
Response `kind` is `photo` or `signature`; existing scanner/storage/idempotency/scope rules remain.

The existing single `POST /driver/events` STOP_DELIVERED request carries:

```json
{
  "versionCode": 43,
  "deliveryProofCapability": "delivery-proof-v1",
  "proof": { "photoMediaId": "uploaded-photo-uuid", "signatureMediaId": "uploaded-signature-uuid" },
  "completion": { "version": 1, "cashReceived": { "amount": "122.00", "currency": "CAD" } }
}
```

Only required proof is mandatory. No photo/signature OFF setting adds a step.
Required IDs must reference READY media of the matching kind, tenant, driver, route and stop.
A missing/wrong reference returns HTTP 400 `DELIVERY_PROOF_REQUIRED` or `DELIVERY_PROOF_INVALID` before committing delivery/Cash.
The accepted request, including proof IDs, retains the existing exact retry identity.
Signature is an image drawn by the recipient and uploaded through the normal proof pipeline; no customer messages or external signature service.

## Office Cash records

`GET /admin/route-plans/:routePlanId/cash-settlements` returns `{data:{routePlanId,receipts:[...]},error:null}`.
Each receipt includes its immutable `completion`, latest `settlement` (null when unconfirmed), `revision` (0 initially), and `history` (newest first).
Settlement fields: `id`, `commandId`, `receiptId`, `revision`, `confirmedAmount`, `currency`, `differenceFromActual`, `differenceFromExpected`, `reason`, `actor`, `recordedAt`.
All money is exact two-decimal text. No mixed-currency aggregate is returned.

`POST /admin/route-plans/:routePlanId/cash-settlements`:

```json
{
  "commandId": "uuid",
  "receiptId": "first-cash-receipt-uuid",
  "expectedRevision": 0,
  "confirmedAmount": "122.00",
  "currency": "CAD",
  "reason": null
}
```

The office confirms one existing Cash receipt at a time. Zero is valid; negative and invalid amounts are rejected.
First confirmation may omit a reason. A correction (`expectedRevision>0`) requires a nonempty reason.
Exact command retries return the original record. Changed content under the same command returns HTTP 409 `SETTLEMENT_CONFLICT`.
Stale revision returns HTTP 409 `SETTLEMENT_CONFLICT`. Existing office authorization, route locks and receipt scope apply.
Records are append-only. Original driver receipts and Shopify totals are unchanged. This does not add tips, discounts, refunds or general accounting.


### Driver capability registration

Before route lookup, the new production app calls `POST /driver/capabilities` with its account bearer and
`{refreshToken,capability:"delivery-proof-v1",versionCode:43,packageId:"com.evnsolution.clever.routes"}`.
The refresh token binds this report to the current unrevoked account session; never log the body.
The server verifies account status/tokenVersion, refresh hash and session expiry before storing the report.
Dispatch of proof-ON routes requires at least one currently valid account session of the assigned driver to report
this explicit capability, production package and versionCode >=43. An old second session does not block a compatible session.
Ordinary proof-OFF routes remain compatible. The new app registers after login, session restore and refresh, before route lookup.
Revoked, expired and stale-tokenVersion capability reports cannot authorize Dispatch.
Each ROUTE_STARTED, PICKUP_COMPLETED and STOP_DELIVERED request for a proof-ON route must include
versionCode >=43 and top-level deliveryProofCapability: "delivery-proof-v1". Otherwise the server returns
HTTP 400 DELIVERY_PROOF_APP_UPDATE_REQUIRED. This per-request guard also rejects an old second device.
This is compatibility gating, not a claim of Play Integrity device attestation.


Office list/detail `routePlan.cashSettlementSummary` contains one row per currency:
`{currency,expectedAmount,actualAmount,confirmedAmount,receiptCount,confirmedCount}`.
Expected is null if any included receipt lacks an expected amount. Confirmed is null when no receipt is confirmed;
partial confirmed totals must be displayed with the confirmed/receipt counts.

Orders group creation accepts `{initialRoute:{requestId,deliveryProof,tollPolicy}}` in the existing
`POST /admin/route-groups` contract. The initial route options and route creation are one transaction;
AVOID routing failure must leave no partially committed route/options. Standalone route creation also accepts
`deliveryProof` and `tollPolicy` at payload top level. Patch proof/toll changes require current `expectedUpdatedAt`.
