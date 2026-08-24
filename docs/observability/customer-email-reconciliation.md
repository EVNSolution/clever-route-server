# Customer email historical reconciliation runbook

Status: guarded operator tooling for Server issue
[`EVNSolution/clever-route-server#319`](https://github.com/EVNSolution/clever-route-server/issues/319)
under change control
[`EVNSolution/clever-change-control#265`](https://github.com/EVNSolution/clever-change-control/issues/265).

## Current decision state

The current production observation is seven overdue queued customer-email facts
while the automatic worker and sender are disabled. Their disposition remains an
operator decision. Monitoring and the development of this tool did not mutate
those rows, did not create delivery attempts, and did not send or re-send email.
Do not infer recipient consent or authorization to send from a queued historical
fact.

This CLI has no HTTP replay endpoint and does not discover work by age, status,
tenant, or free-form query. An operator must provide every notification fact ID
or manual dispatch ID explicitly. Its only supported disposition is
`do-not-send`. Requeue and send are intentionally absent because the current
domain contract does not prove that historical recipient consent and
idempotency remain valid.

## Safety contract

- Dry-run is the default and produces `mutationCount: 0`.
- Apply requires `--apply`, a PII-free actor token, the reviewed manifest file,
  its exact SHA-256, the exact app/shop scope, and `--disposition do-not-send`.
- Apply refuses missing or duplicate selections, wrong scope, succeeded rows,
  active leases, any prior attempt, non-pending state, and rows changed since the
  manifest was generated.
- Apply is transactionally all-or-nothing. Repeating the same reviewed manifest
  is idempotent and reports the already-applied items without adding audit rows.
- Cancellation clears recipient and rendered-content snapshots, writes a
  terminal `OPERATOR_DO_NOT_SEND` state, and appends an immutable attempt record.
  Existing attempt history is never updated or deleted.
- CLI output and reconciliation attempt rows contain identifiers, state hashes,
  timestamps, disposition, and a pseudonymous actor token only. They must not
  contain recipient addresses, subject/body content, provider payloads, or raw
  error messages.

## Create and review a dry-run manifest

Run from `apps/delivery-api` with the intended database connection supplied by
the approved operator environment. Repeat `--fact-id` or `--dispatch-id` for
each explicitly reviewed row:

```bash
npm run customer-email:reconcile -- \
  --app-id clever \
  --shop-id <shop-uuid> \
  --fact-id <fact-uuid-1> \
  --fact-id <fact-uuid-2> \
  --disposition do-not-send \
  > /secure/operator-path/customer-email-reconciliation.json
```

The generated document includes `manifestSha256`. Review all identifiers, the
scope, disposition, generated timestamp, per-row state hashes, and the
top-level hash. Store it only in an approved restricted operator location; do
not commit it or attach it to tickets. The manifest is PII-free, but it remains
internal operational evidence.

Any refusal exits with code `2` and emits only a stable `errorCode`. Do not work
around a refusal by editing the manifest. Generate a new dry run after resolving
the state or scope discrepancy.

## Apply an approved do-not-send decision

Apply is a separately approved production change. Do not run this command merely
because a dry run succeeded. After the operator has recorded the disposition and
reviewed hash in the change-control decision, use the same app/shop scope and a
non-personal actor token:

```bash
npm run customer-email:reconcile -- \
  --apply \
  --manifest /secure/operator-path/customer-email-reconciliation.json \
  --reviewed-manifest-sha256 <64-character-sha256> \
  --actor <pseudonymous-operator-token> \
  --app-id clever \
  --shop-id <shop-uuid> \
  --disposition do-not-send
```

Record only the PII-free JSON result and the reviewed hash in the change-control
evidence. Never record the source row's recipient, subject, body, provider
payload, or error text.

## Verification and recovery

After an approved apply, verify that the result reports the expected
`appliedItems`, `alreadyAppliedItems`, and `auditRows`; the selected facts are
`DEAD` or dispatch recipients are `SKIPPED`; recipient/rendered snapshots are
null; and each newly applied item has append-only `TERMINAL_FAILURE` attempt
evidence with `OPERATOR_DO_NOT_SEND`, correlated to the reviewed manifest hash.

`do-not-send` is terminal in this tool. There is no automated rollback to send
or requeue. If the decision was wrong, preserve the audit evidence and open a
new approved change that re-establishes recipient consent and an idempotent
delivery contract. Do not delete or edit reconciliation attempt history.

For the currently observed seven overdue facts, the stop condition remains:
decision pending, production mutation count zero, and email send count zero.
