# Completion assistance server rollout

Status: source/local preparation only. This document does not record a merge,
production migration, deployment, runtime verification, app release, or store
submission.

Related work:

- App issue: `EVNSolution/clever-routes-app#288`
- App PR and wire contract: `EVNSolution/clever-routes-app#289` at `c705c8e`
- Change control: `EVNSolution/clever-change-control#295`
- Root lineage: `EVNSolution/clever-change-control#145`

As of 2026-09-21, change-control #295 scopes the app implementation and server
handoff and explicitly excludes production deployment. It has no comment that
expands production authority to the server migration, API rollout, operational
policy, worker, or inference outcomes. Source implementation and a reviewable
server PR may proceed under the current task direction. Production merge and
deployment evidence remain pending an explicit change-control expansion or a
new linked server change-control item.

## Rollout boundary

The first server rollout is migration plus authenticated API only. It must keep
new detection and inference processing disabled. It does not deploy the Routes
app, submit an app to a store, modify Shopify Order or Customer source records,
change the Shopify administrator Tracking UI, or repair historical delivery
statuses.

The API contract is wire contract v1:

- `GET /driver/completion-assistance`
- `POST /driver/completion-assistance`
- `Authorization: Bearer <driver account token>`
- `Cache-Control: no-store`
- GET returns `contractVersion`, `serverTime`, `runs`, and `candidates`.
- POST returns the request `commandId`, `status` (`applied`, `duplicate`, or
  `rejected`), and the authoritative candidate when the command targets a
  candidate.

An applied or duplicate response ACK must contain the response that the command
actually applied, its original response time, and its resulting revision. A
duplicate returns the immutable receipt projection saved by the first attempt,
even if a later command has changed the candidate. The current candidate remains
available through GET. Receipt, candidate revision, delivery-stop projection,
outcome/audit, and downstream outbox facts commit in one transaction.

Customer notification behavior is not part of this rollout. When an outcome
would otherwise create a customer-delivery outbox fact, record it as `SKIPPED`
until separate notification behavior is approved. Candidate creation and retry
must never send a server push; the app owns candidate local notifications.

## Production configuration

Every setting uses the `COMPLETION_ASSISTANCE_` prefix. Safe defaults are part of
the runtime contract, so an existing production `.env` that lacks these keys
cannot enable detection or processing.

```dotenv
# JSON object containing every required wire-v1 policy field. There are no
# operational threshold defaults. Invalid or absent JSON disables new detection
# while existing GET, response, and correction behavior remains available.
COMPLETION_ASSISTANCE_POLICY_JSON=

# Comma-separated driver account UUID allowlist. An empty value has no enabled
# cohort. Do not infer accounts from the first shop, route, or database row.
COMPLETION_ASSISTANCE_ACCOUNT_IDS=

# Fresh immutable identifier for each approved enabling epoch. Never reuse an
# earlier activation ID when policy or cohort activation is restarted.
COMPLETION_ASSISTANCE_ACTIVATION_ID=

# ISO-8601 instant for the enabling epoch. It is not a replacement deadline and
# does not move any candidate's verified exit time.
COMPLETION_ASSISTANCE_ACTIVATED_AT=

# Both default false. Detection requires an approved policy and cohort. Worker enablement additionally requires an activation ID and
# activation instant and is a later, separately approved step.
COMPLETION_ASSISTANCE_DETECTION_ENABLED=false
COMPLETION_ASSISTANCE_WORKER_ENABLED=false
```

`COMPLETION_ASSISTANCE_POLICY_JSON` must contain all v1 fields:
`version`, `maxAccuracyMeters`, `enterRadiusMeters`, `exitRadiusMeters`,
`dwellMs`, `maxGapMs`, `minDwellSamples`, and `ambiguityRadiusMeters`. The
server supplies no 50 m, 100 m, 60 second, 200 m, or other operational fallback.

Enabling new inference requires one reviewable approval that identifies the
exact policy JSON, account cohort, fresh activation ID, and activation instant.
The server stores the activation ID on each run and candidate. Candidates made
while detection or worker eligibility is disabled, and candidates first
uploaded after their exact deadline, remain held. Enabling a later epoch cannot
make them a processing backlog or restart a deadline. For eligible candidates,
`responseDeadlineAt` remains exactly `verifiedExitAt + 86,400,000 ms`.

Policy errors stop new detection only. They do not disable GET, command receipt
replay, explicit responses, or corrections for stored candidates. An API image
rollback must preserve the database, raw evidence, receipts, audit history, and
the ability to serve or restore response/correction handling. Stop the inference
worker before any runtime rollback.

Retention is hold-preserve pending separate operational-retention approval.
There is no purge job for candidates, commands, receipts, raw evidence, outcomes,
or correction audit in this rollout.

## Source and local gates

Record fresh output for every applicable command on the final source commit:

```bash
npm --prefix apps/delivery-api run prisma:generate
npm --prefix apps/delivery-api run lint
npm --prefix apps/delivery-api run typecheck
npm --prefix apps/delivery-api run test
CLEVER_RUN_DISPOSABLE_DB_TESTS=1 npm --prefix apps/delivery-api run test:db:disposable
npm --prefix apps/delivery-api run build
cp apps/delivery-api/.env.example apps/delivery-api/.env
npm run compose:config
rm -f apps/delivery-api/.env
git diff --check
```

The completion-assistance coverage must include:

- exact 24-hour boundary immediately before, at, and after the deadline;
- deadline stability after other-stop activity, return intent, notification
  display/read, route completion, and GPS shutdown;
- manual completion, failure, cancellation, reassignment, and worker races;
- one-point, pass-by, low-accuracy, discontinuous, time-invalid, future,
  excessive-evidence, and same-building ambiguity holds, including terminal
  neighboring stops;
- duplicate commands, response loss and replay, changed payload reuse of one
  command ID, and immutable duplicate receipts;
- the causal offline sequence `rev0 -> inferred rev1 -> completed(expected 0)
  -> failed(expected 1, predecessor completed)` with the final explicit failure
  preserved;
- rejection of a predecessor from another account, candidate, run, assignment,
  or route version, and rejection after an intervening manual result,
  cancellation, or reassignment;
- ended-run GET, response, and correction with account authentication;
- cross-account, cross-shop, stale-assignment, and reassigned-run isolation;
- atomic agreement among candidate state, actual `DeliveryStop` state, receipt,
  outcome/audit, and outbox facts, including transaction rollback;
- `not_completed` restoration only to the stored actual prior nonterminal state
  when the candidate owns the terminal outcome;
- worker-disabled behavior, held disabled-period candidates, fresh activation
  epochs, and no bulk processing when a later epoch is enabled;
- unchanged Shopify source Order/Customer records and no candidate server push.

## Merge and deployment gates

The server change uses a branch and PR targeting `main`. Main is governed by a
repository ruleset requiring a pull request and a successful strict GitGuardian
check. The server CI should also pass before merge even though it is not currently
listed as a merge-required ruleset check.

Production deployment has additional hard gates:

1. Change control explicitly authorizes the server schema migration and API-only
   production rollout with both completion-assistance flags false.
2. The PR is reviewed and merged to `main`; record the PR number, source head,
   and merge SHA separately.
3. The exact merge SHA has a successful `push` run of `.github/workflows/ci.yml`
   on `main`. A PR CI result is not enough for the deploy workflow.
4. A reviewed database backup/restore rehearsal supplies the required lowercase
   64-character `restore_rehearsal_sha256` evidence.
5. The new migration is additive, has no historical status backfill, and the
   previous runtime image is compatible with the migrated schema. Record the
   forward-fix or restore plan because image rollback does not roll back the DB.
6. `COMPLETION_ASSISTANCE_DETECTION_ENABLED=false` and
   `COMPLETION_ASSISTANCE_WORKER_ENABLED=false` are verified from effective
   runtime configuration before and after API recreation.

Prisma changes force the guarded migration lane. After the exact-main CI and
change-control gates pass, use the standard Route Ops workflow with the merge
SHA, reviewed restore rehearsal digest, and migrations enabled:

```bash
gh workflow run "Route Ops operations" \
  --repo EVNSolution/clever-route-server \
  --ref main \
  -f operation=deploy \
  -f channel_tag=prod \
  -f source_ref=<merge-sha> \
  -f publish_images=true \
  -f dry_run=false \
  -f run_migrations=true \
  -f approve_dsv_migration=true \
  -f restore_rehearsal_sha256=<reviewed-64-hex-sha256> \
  -f approve_production_baseline=false
```

Set `approve_production_baseline=true` only if a separate current production
baseline review requires it. Do not use that switch as a generic migration
approval.

The workflow must resolve exactly one Online SSM target, confirm the source is on
main history, require successful exact-main CI, build digest-addressable runtime
and migration images, run the guarded migration before API recreation, preserve
the prior image env for rollback, and pass the public `/healthz` check. A failed
SSM phase may be retried with `publish_images=false` and the already published
exact source SHA; do not rebuild or select a different source during a retry.

## Deployed evidence checklist

Keep these evidence categories distinct in the release report:

- **Source PR:** PR URL/number, source head SHA, review result, GitGuardian, PR
  CI, and local validation totals.
- **Merge:** merge SHA and exact `main` tree. Do not label the PR head as the
  deployed revision.
- **Migration:** workflow run, migration image digest/revision, guarded command
  success, exact migration name/checksum/readback in `_prisma_migrations`, and
  confirmation that no historical delivery status was backfilled.
- **Runtime:** `.deploy/current-image.env` commit, `API_RUNTIME_REVISION`, runtime
  OCI revision, digest-addressable `DELIVERY_API_IMAGE`, running container image
  ID/ref, public `/healthz`, and the prior rollback image pointer.
- **Authentication:** unauthenticated GET and POST return 401; a dedicated test
  account bearer receives `Cache-Control: no-store` and wire-v1 GET/POST bodies.
  Do not expose the bearer, phone, PIN, coordinates, or customer data in evidence.
- **ACK behavior:** on a controlled test run, save one response, simulate response
  loss, resend the identical command, and show the immutable duplicate receipt.
  Verify a conflict returns the authoritative candidate/revision.
- **Ended run:** the same account can GET and send a response/correction after
  route and GPS termination; reassignment and another account remain blocked.
- **Activation:** effective detection and worker flags are false, the account
  allowlist is empty, no activation ID is active, disabled/late candidates are
  held, and no inference outcome was claimed.
- **Compatibility:** existing manual `STOP_DELIVERED`/`STOP_FAILED`, assignment,
  route access, and older app flows still pass. The unsupported-app behavior
  remains explicit until live integration is complete.
- **Exclusions:** no app/store deployment, candidate server push, Shopify source
  Order/Customer write, Tracking UI change, historical South correction, or
  bulk completion occurred.

Use a dedicated controlled test account and route for authenticated production
fixtures. The 2026-09-17 K-food South route is investigation context only and is
not a test target or authorization for correction.

## Local verification (2026-09-21)

The final source was checked in an isolated branch/worktree. The original
checkout and its branch were preserved. All data below is synthetic and local:

- Prisma generate and validate, whole API lint and typecheck, API build,
  Compose configuration, shell syntax/plan, and Git whitespace checks passed.
- The full API suite passed **2,552 tests** with the completion-assistance
  PostgreSQL cases enabled. **147 existing tests** require other separately
  configured disposable DB targets and were skipped in this local run.
- PostgreSQL 17 accepted all **108 migrations** on an empty disposable database.
  A second populated synthetic database upgraded from **107 to 108** migrations;
  the pre-existing Shopify Order row and ARRIVED DeliveryStop row were identical
  afterward, apart from the two new null ownership columns. No candidates,
  runs, receipts, or outcomes were backfilled.
- Real PostgreSQL/Fastify account-token requests verified wire-v1 GET/POST,
  no-store, applied response projection, immutable duplicate ACK, and expired
  bearer rejection. This is local authentication evidence, not production API
  or physical-device proof.
- Race/ownership regressions include manual driver completion/failure, direct
  stop cancellation, administrator confirmation of the same inferred status,
  and copied-stop reassignment even after the later route is completed,
  cancelled, or its version archived. Failure injection proves atomic rollback.
- The Docker-based repository-wide disposable DB profile includes the new
  completion-assistance suite, but was not run locally; the focused suite used
  an isolated native PostgreSQL 17 cluster. CI remains a separate gate.

Evidence that predates immutable run issuance is held even when buffered GPS is
uploaded later under the current server assignment stamp. This conservatively
avoids assigning old route observations to a newer run. Genuine GPS upload,
notification, offline/restart, and app integration behavior still needs the
staged server/device verification above.

## Pending production evidence

- Server PR: [#435](https://github.com/EVNSolution/clever-route-server/pull/435), draft for review
- Source head: use the current PR head; production evidence below remains pending
- Merge SHA: pending
- Exact-main CI: pending
- Restore rehearsal SHA-256: pending
- Migration result/readback: pending
- Runtime revision/image digest: pending
- Authenticated GET/POST fixture: pending
- Ended-run response/correction fixture: pending
- Detection flag: expected `false`, not deployed or read back
- Worker flag: expected `false`, not deployed or read back
- App/device integration: pending and outside this server rollout
- App/store deployment: excluded
