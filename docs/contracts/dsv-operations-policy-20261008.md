# DSV confirmed operations policy — 2026-10-08

This server change implements the user's October 8 policy. It builds on PR483
`44e6d880684609f7d075f3102c634a999b5c24ca` and PR487
`18ea784934ec3cf511f56646b708d141617c404b`. Both upstream PRs remain separate.
The implementation base is PR487. This document does not authorize deployment,
production migration, actual push/email sending, or device operation.

## Notification behavior

| Kind | Confirmed behavior |
| --- | --- |
| N01 / N02 | Start the sending procedure after successful publication/material change at any hour. Unpublished, failed, unchanged, or replayed commands do not create another intent. Existing recipient and capability checks remain. |
| N04 | Use valid vehicle GPS on the execution's business day. No 06:00 gate. Notify once per execution before start. Recent valid depot dwell can establish arrival when publication happens while the vehicle is already inside. Reassignment requires fresh attribution evidence. |
| N05 | First due time is confirmed departure + five minutes. Subsequent due times are actual reminder creation + five minutes. No count limit. At service-date 12:00 Asia/Seoul, stop creation, sending, and retries. |
| N06 | Existing destination notification behavior remains. N05's noon cutoff does not apply. |
| N07 | Separate undelivered report. It does not set a delivery outcome. Existing operations endpoints remain compatible; acknowledgement/resolution is not a required reporting step. |

`serviceDate` is the immutable PostgreSQL date for the execution. Its Seoul
business day starts at 00:00 and ends at the next 00:00. Noon is 03:00 UTC on
that calendar date. Start, cancellation, unassignment/reassignment, and execution
closure stop N05 earlier. Recovery creates at most one current reminder; it does
not send missed time slots. The next business day cannot revive an expired N05.

GPS identity, vehicle/tenant attribution, active assignment, distinct sample
counts, dwell, freshness, speed, mapping and ambiguous-execution checks remain.
GPS never starts or completes delivery automatically. Runtime switches and
allowlists remain default OFF. Existing policy cap fields are compatibility
inputs, not business limits. Provider retry budgets remain technical limits.

## App report contract

`POST /api/dsv/driver/executions/:executionContextId/delivery-exceptions`

Authenticate with the existing DSV driver session. The server derives the
account, driver, and shop. Send the existing execution fences and command ID:

```json
{
  "commandId": "e5e4ba79-1820-4224-a46a-af63270488c4",
  "assignmentEpoch": "1",
  "assignmentGeneration": "1",
  "expectedRouteVersionId": "77bf6bfa-7821-4aae-913a-df0f334a40b2",
  "routeVersion": 1,
  "targetStopId": "b284612b-506a-440b-9b2d-d2d65e717a86",
  "occurredAt": "2026-10-08T01:15:00.000Z",
  "reason": "수취인 부재로 배송할 수 없습니다."
}
```

- `reason` is trimmed, nonblank free text with a 1,000-character limit. Line breaks and tabs are accepted; other control characters are rejected.
- A reason catalog and photo are not required. Photo-free completion remains supported.
- Legacy `reasonCode` (80 characters) and optional `explanation` (1,000 characters)
  remain accepted. Reason precedence is `reason`, then `explanation`, then legacy
  `reasonCode` text. New apps should send `reason` only.
- Keep the command ID, occurredAt, fences, and payload stable on retry. A changed
  payload with the same command ID returns `409 COMMAND_CONFLICT`.
- First acceptance returns 201; a replay returns 200 with `duplicate: true`.
- The existing result IDs/fences remain. Additive fields are
  `reportStatus: "ACCEPTED"` and `emailStatus: "PREPARED"`.
- The command result is an immutable acceptance receipt. Its emailStatus is the
  acceptance snapshot, not a live delivery receipt. Pre-upgrade receipt replay
  uses `NOT_PREPARED` and does not enqueue historical mail.
- Current report state is available to authorized operations users through
  `/api/dsv/v1/operations/delivery-exceptions[/:id]` and execution detail. These
  responses add `reason`, `emailStatus`, and `emailSentAt`.

Existing authentication, tenant isolation, assignment/version fences, terminal
target rejection, and command replay behavior remain. A report creates no
`STOP_FAILED`, `FAILED`, `DELIVERED`, or automatic route completion.

## Prepared staff email

The existing `DsvDeliveryException` row is also its one mail job. The report,
immutable mail snapshot, N07, and command receipt commit in one transaction.
The snapshot contains the dispatch date, driver name, destination, report time,
and full reason. Report time is the submitted occurredAt; the DB createdAt
retains server acceptance time.

The additive migration is `20261008090000_dsv_delivery_exception_email`.
Existing reports receive `NOT_PREPARED`; there is no historical mail backfill.
New reports receive `PREPARED`. Recipient address and sender address are explicit
constructor configuration. The sender reuses the existing
`DsvManualEmailService.send` interface. There is no runtime registration,
scheduled sender, production recipient, or live provider connection in this change.

An isolated sender test exercises `PREPARED → SENDING → SENT`. Compare-and-set
allows one sender to claim the report. The stable report ID is the provider
idempotency key. Transport ambiguity becomes `UNKNOWN`; a crash can leave
`SENDING`. Neither state is automatically resent. Provider connection and any
future recovery policy require separate configuration and verification. Saving
the report always remains distinct from a confirmed email send.

## History and follow-up boundaries

Notification/report history has no age-based deletion or anonymization policy.
Expiry changes send eligibility and business status, not stored history.
The live inbox can hide expired items; authorized execution/report detail retains
history. Existing explicit account/tenant erasure behavior remains unchanged.
This policy does not change raw GPS, photo, or general technical-log retention.

App follow-up: replace the report reason catalog with a free-text field, preserve
the draft and command identity during retries, show “report accepted” separately
from mail status, and keep photos optional. No new operations confirmation screen
is required. Operations web may display the additive reason/mail status fields.
Neither frontend is modified here.

Real vehicle GPS validation remains scheduled for after next week's app release.
Actual FCM/email delivery, production migration, merging, deployment, and device
tests are outside this change. C1 stays closed and is not investigated.
