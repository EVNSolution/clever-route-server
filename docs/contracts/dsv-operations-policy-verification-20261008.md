# DSV operations policy verification — 2026-10-08

Base: PR487 `18ea784934ec3cf511f56646b708d141617c404b`, which contains PR483
`44e6d880684609f7d075f3102c634a999b5c24ca`. Remote heads and existing worktrees
were checked before creating `codex/dsv-operations-policy`. The existing PRs and
main checkout were not modified. The new PR is stacked on PR487.

Contract and app follow-up: [confirmed policy](dsv-operations-policy-20261008.md).

## Validation results

| Check | Result |
| --- | --- |
| Prisma client generation | PASS: Prisma 6.19.3 |
| API lint | PASS: no findings |
| API typecheck | PASS |
| Full API tests | PASS: 279 files, 3,317 tests; 332 guarded/optional tests skipped |
| Isolated PostgreSQL and HTTP | PASS: 81 tests; two optional external Driver-source tests skipped |
| API build | PASS |
| Independent source review | Accepted after corrections |
| Secret scan / whitespace | PASS: no findings |

The ordinary test skips are not counted as DB verification. The separate
PostgreSQL invocation above ran the DSV database lane. Existing completion-result
recovery, ownership, permission, and photo-optional contracts are covered by the
full API suite. Negative proof-media tests emit expected error logs; Vitest reports
zero failed tests.

## Isolated database evidence

PostgreSQL 17 ran in a new local cluster on `127.0.0.1:55496/dsv_operational`.
All 115 migrations applied, including the additive report email columns. The
database was separate from production and was stopped/deleted after verification
(about 73 MiB reclaimed). Logs and reusable dependencies remain. Tests used synthetic tenants and fake
push/email senders. No live provider was configured.

`dsv-operational-server.integration.test.ts` and
`dsv-isolated-client-http.integration.test.ts` passed 81 tests. Two optional tests
that import a separate Driver checkout were skipped. Server-side legacy HTTP,
authentication, tenant isolation, assignment fencing, and report replay checks ran.

Coverage includes:

- Arrival before 06:00, once per execution, and valid dwell before publication.
- Dwell longer than the latest-sample freshness window and dwell across midnight.
- Invalid plate, stale latest sample, excessive speed, latest outside position,
  long GPS gap, reassignment, and same-day/overnight ambiguous execution rejection.
- More than six N05 reminders, exactly five-minute scheduling, no missed-slot burst,
  noon cutoff, previous-day rejection, and persisted history after expiry.
- Existing start, cancellation, assignment, completed-stop and resource guards.
- Actual publication and material-change writers at 02:00/02:01 KST, unchanged
  save suppression, command replay, isolated sends and transient retry deduplication.
- Concurrent free-text report replay, one report/mail job, all required email
  content, isolated sender concurrency, and no delivery-state mutation.
- All N01–N07 records, attempts, acknowledgements, report/email snapshot, and command
  receipt survive expiry and production evidence cleanup functions at a 2036 date.
- N06 retains observation-time monitoring, its previous TTL, and overnight delivery.

Unit tests additionally cover noon crossed while waiting for the context lock,
authority queries, the final send lease lookup, and asynchronous Firebase imports.
Provider TTL is reduced to the remaining N05 lifetime. Same-morning legacy
`CAP_REACHED` contexts resume without catch-up; noon/next-day contexts do not.

## Review and test repairs

Independent report review found newline rejection in the new free-text reason.
CR/LF and tabs are now accepted only for `reason`; other control characters and
legacy field validation remain restricted. Independent geofence review found
late creation/send boundaries, N06 time-window regressions, and insufficient
historical dwell reconstruction. These findings were fixed and re-reviewed.
The parent also aligned warehouse recovery with overnight ambiguity checks.

The existing HTTP harness seeded shared route/order projection rows concurrently.
The first real DB run exposed a PostgreSQL deadlock in that fixture. Those seed
writes now use one transaction. GPS scenarios use the fixture business-day morning
and matching synthetic effective/mapping times, rather than the machine's current
date. Production locks and policy checks were not bypassed.

An initial Node 26.3.1 typecheck timed out after 600 seconds without diagnostics.
The observed process footprint was about 2.4 GiB. Final compiler/lint validation
uses the already-installed Node 24.19.0 runtime with a command-scoped 4096 MiB
old-space limit. Heavy stages run sequentially; tests use one worker.
An unchanged Route Ops web artifact was built for existing server shell tests.
No frontend product source changed.

## Evidence and remaining boundaries

Local observer logs remain outside Git under
`/Users/jiin/.codex/build-hygiene/logs/clever-route-server/`.
The verified DB run is
`20261008T142106.000225+0900-18ea784934ec-dsv-policy-db-verified/summary.json`.
The full API run is
`20261008T142329.725260+0900-18ea784934ec-dsv-policy-full-test-verified/summary.json`.
The final lint, typecheck, and build runs are:

- `20261008T142516.431859+0900-18ea784934ec-dsv-policy-lint-verified/summary.json`
- `20261008T142913.936075+0900-18ea784934ec-dsv-policy-typecheck-verified/summary.json`
- `20261008T142947.862865+0900-18ea784934ec-dsv-policy-build-verified/summary.json`

Intermediate failing runs are retained and are not passing evidence.

No operational DB changes, push/email sends, merge, deployment, or device actions
were performed. Real vehicle GPS validation remains after next week's app release.
GPS fleet thresholds, actual FCM delivery, staff recipient/transport configuration,
and release approval remain separate work. C1 remains closed.

There is no age-based notification/report purge. Existing explicit account/tenant
erasure can still remove related records. Raw GPS, photos, and technical-log
retention remain unchanged. Email `UNKNOWN` or interrupted `SENDING` outcomes
remain non-retriable until a separate recovery policy is configured.
