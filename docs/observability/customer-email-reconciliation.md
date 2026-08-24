# Customer email historical reconciliation runbook

Status: guarded fact-only operator tooling for Server issue
[`EVNSolution/clever-route-server#319`](https://github.com/EVNSolution/clever-route-server/issues/319)
under
[`EVNSolution/clever-change-control#265`](https://github.com/EVNSolution/clever-change-control/issues/265).

## Current decision state

Production monitoring observed seven overdue queued customer-email facts while
the automatic worker and sender were disabled. Their disposition remains
pending. Investigation and development performed no production query through
this CLI, no mutation, no apply, and no email send or re-send.

The CLI accepts notification fact IDs only. Manual dispatch reconciliation is
deliberately unsupported because the existing synchronous send path cannot
prove a safe cancellation fence against an in-flight provider call. There is no
HTTP replay endpoint, tenant/status/age discovery query, requeue, or send mode.
The maximum explicit batch is 100 facts.

## Safety contract

- Dry-run is the default and reports `mutationCount: 0`.
- Both dry-run and apply require a canonical change-control reference and a
  PII-free reason code. The reviewed hash proves manifest integrity; it is not
  approval. Apply still requires the recorded change-control decision.
- Apply additionally requires `--apply`, a PII-free actor token, exact app/shop
  scope, the read-only reviewed manifest, its exact SHA-256, and
  `--disposition do-not-send`.
- Any success, send attempt, provider result, provider/error residue, processing
  timestamp, lease residue, non-queued status, wrong scope, or state change
  fails closed.
- Cancellation purges the recipient snapshot, metadata (including
  `DSV_CUSTOMER_MESSAGE` body content), provider result, raw error payload, and
  processing/lease data. No metadata keys are preserved.
- Operator disposition is not written to the send-attempt ledger. A separate
  PII-free reconciliation audit is retained for 180 days, and a PII-free
  idempotency tombstone remains after audit cleanup so the same manifest cannot
  mutate or create evidence twice.
- `OPERATOR_DO_NOT_SEND` facts are excluded from runtime dead-letter and last
  provider-error health classification. They do not make a healthy sender
  permanently degraded.

## Runtime prerequisite

The production image contains Node.js and the compiled script, but not `tsx` or
the development npm toolchain. Use an already deployed, digest-pinned
`delivery-api` image and execute:

```text
node dist/scripts/reconcile-customer-email.js
```

Do not run from a mutable tag. Resolve the deployed digest first through the
approved read-only deployment evidence, then use
`scripts/ssm-customer-email-reconciliation.sh` with an explicit SSM instance,
digest, and base64-encoded JSON argument array. Mount the reviewed manifest
read-only through the wrapper, for example
`/run/reconciliation/manifest.json:ro`; never copy it into the repo or image.

## Create and review a dry-run manifest

Within a one-off container made from the deployed digest and connected to the
approved runtime environment, repeat `--fact-id` for every explicitly reviewed
fact:

```bash
node dist/scripts/reconcile-customer-email.js \
  --change-control-ref EVNSolution/clever-change-control#265 \
  --reason-code HISTORICAL_DO_NOT_SEND \
  --app-id clever \
  --shop-id <shop-uuid> \
  --fact-id <fact-uuid-1> \
  --fact-id <fact-uuid-2> \
  --disposition do-not-send \
  > /secure/operator-path/customer-email-reconciliation.json
```

Review the scope, explicit IDs, disposition, change-control reference, reason,
timestamps, state hashes, and `manifestSha256`. Store the document in an
approved restricted location. Although PII-free, it is internal evidence.
Refusals exit `2` with only a stable `errorCode`; never edit around a refusal.

## Apply an approved do-not-send decision

Do not execute this step until the exact manifest hash and reason are approved
in change control. Mount the manifest read-only into the digest-pinned one-off
container, then use the same binding values:

```bash
node dist/scripts/reconcile-customer-email.js \
  --apply \
  --manifest /run/reconciliation/manifest.json \
  --reviewed-manifest-sha256 <64-character-sha256> \
  --actor <pseudonymous-operator-token> \
  --change-control-ref EVNSolution/clever-change-control#265 \
  --reason-code HISTORICAL_DO_NOT_SEND \
  --app-id clever \
  --shop-id <shop-uuid> \
  --disposition do-not-send
```

Record only the PII-free result, image digest, reviewed hash, actor token,
reason, and SSM command evidence. Never record recipient/content/provider
payloads. The runtime environment remains the source of database credentials;
do not put credentials on the command line or in the manifest.

## Verification and recovery

After an approved apply, verify the expected item counters, `DEAD` plus
`OPERATOR_DO_NOT_SEND`, null recipient/metadata/provider/error/claim fields, one
operator audit, one tombstone, zero new send-attempt rows, and unchanged runtime
dead-letter health. Audit retention cleanup must leave the tombstone intact.

The disposition is terminal. There is no rollback to send/requeue. A mistaken
decision requires a new approved consent and idempotency design; do not edit the
fact, audit, tombstone, or send-attempt history.

For the observed seven facts, the current stop condition is still: decision
pending, production mutation count zero, and email send count zero.
