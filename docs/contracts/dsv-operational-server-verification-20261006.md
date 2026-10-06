# DSV server P1–P3 verification — 2026-10-06

This report covers implemented server behavior and synthetic/disposable proof. It does not claim deployment, actual GPS acceptance, app integration, device proof, or operational approval.

## Baseline and scope

- Server remote main and worktree base: `9c517aa2f483bdfdccf730889df61da346d1d22d`.
- Branch: `codex/dsv-server-notifications` in a separate managed worktree.
- Web reference main: `4f261b67cfb22669cb26a093eb1f3f59ab9c7606`.
- Driver dev: `4009a9f522372a9cf23272ba723bfbbb76d96253`.
- Driver Draft PR61 candidate: `a7959e5a84393d7dc57e2caa654ea2f8edad202c`.
- Target [server #482](https://github.com/EVNSolution/clever-route-server/issues/482); change-control [#310](https://github.com/EVNSolution/clever-change-control/issues/310).
- Other repositories were read only. Existing merged PR cleanup was not repeated. Canonical server checkout remained clean.

Implemented P1: additive execution/version/epoch schema, mapping and selector history, durable receipts, atomic START, separate exception reports, and transactional writer hooks.
Implemented P2: raw UVIS job persistence, leased processing, durable geofence state/evidence, hysteresis/dwell, attribution revalidation, and durable non-burst five-minute reminders.
Implemented P3: N01–N07 intents, inbox/acks/current resolver, capability fences, leased retry/expiry/provider handling, dynamic default-OFF policy, and driver/operations APIs.

Technical decisions are recorded in [the contract](dsv-operational-server-v1.md). Runtime configuration, production DB, actual GPS shadow, deploy, merge, real notifications, other-repository implementation, and P7 were excluded.

## Frozen P0 evidence and executable coverage

Tracked fixture: `apps/delivery-api/tests/fixtures/dsv-notification-d03-cases.json`.
SHA-256: `9dd523fedd79932b1130899b95b0eb9ceb8d5efaf5bf5467db03a06aeb14cee5`.
The file remains the P0 historical proposal/current-code record. Its historical implemented=false fields are not rewritten as current runtime truth.

`dsv-execution-context.service.test.ts` executes the real identity service with bounded delegate harnesses. Its final fixture comparison checks all 23 IDs, normalized resulting context, identity/version/epoch, timer, prior-notification action, outcomes, and new intents. This is behavioral proof, not an ID-presence test. Symbolic P0 IDs are normalized to runtime observations. Actual PostgreSQL tests separately exercise shared production writer, transaction, locking, constraint, worker, resolver, and failure paths.

| P0 case | Executable proof |
|---|---|
| D03-01 / D03-04 | Initial publication and first NO_OP publication create one context/N01; actual DB concurrent publication and rollback |
| D03-02 / D03-03 | Same receipt replay and new NO_OP preserve identity/timer/intents |
| D03-05 / D03-06 / D03-07 | Quantity, destination/address/coordinates, sequence bump content only; DB version/override rollback |
| D03-08 / D03-09 | Driver/vehicle attribution increments epoch and ends prior timers; DB selector clipping |
| D03-10 / D03-11 | Closed context cannot reopen; implicit subsequent publication requires mapping |
| D03-12 | Explicit new afternoon execution gets a distinct context; DB implicit vehicle/date publication race |
| D03-13 / D03-14 | Ambiguous attribution defers; explicit selection authorizes one context; DB exclusion/history |
| D03-15 | Explicit replacement mapping retains logical context and time interval |
| D03-16 | Completion closes context and driver warnings |
| D03-17 | Conflicting receipt input rejects; actual DB preserves winner |
| D03-18 | Active/non-PENDING import conflict; existing G003 DB snapshot/mutation protections |
| D03-19 / D03-20 | Metadata and uploaded label changes do not create content/attribution changes |
| D03-21 | Order movement revises each affected logical route |
| D03-22 | Default vehicle-driver registry link does not mutate execution |
| D03-23 | Started IN_PROGRESS content revision cannot recreate missing-start state |

## Disposable database proof

Runner: `apps/delivery-api/scripts/test-dsv-operational-disposable.sh`.
Guard: `CLEVER_RUN_DISPOSABLE_DB_TESTS=1` and `DSV_OPERATIONAL_DATABASE_TARGET_CLASS=safe-local-dsv-operational-disposable`.
Container: uniquely named, loopback-only PostgreSQL 17, synthetic tenants/accounts/orders/samples, deleted on EXIT.
Target: `127.0.0.1:55496/dsv_operational`; optional existing G003: `127.0.0.1:55433/clever_g003`.
The pre-existing local Homebrew PostgreSQL cluster was not used or changed.

Fresh migrations: all 113 applied to DSV, G002, and G003 isolated databases. Actual G002 regression: 7 passed. Actual G003 regression: 37 passed. Latest DSV DB suite: 30 passed. The optional G002 lane uses `DSV_OPERATIONAL_INCLUDE_G002=1` and loopback port 55488.

Coverage includes publication/intent atomicity, two start events and receipts, forced rollback, forced concurrent same-command receipt waits, arbitrary legacy partial-start repair, command conflict, tenant/account isolation, selector exclusion/history, vehicle selection clipping, immutable UVIS evidence across restart, no catch-up burst, post-lock context rebind, ambiguous vehicle attribution, expired-lease takeover, late-worker CAS, transient provider retry without business ordinal change, real persisted principal/capability/inbox/resolver, operations acknowledge/resolve race, independent N07 lifetime, terminal-stop N06 closure and report rejection, content override rollback, and fresh LIVE activation evidence.

Source data and provider results are synthetic. Provider tests use fake sends only. Guarded integration skips in the ordinary unit command are not counted as DB proof.

## Review and final checks

Independent source review found and fixed authorization scopes, attempt starvation, dynamic kill-switch/routing parity, geofence post-lock attribution, selector races, internal receipt-hash hints, N04/N05 resolution, independent N07 lifetime, generic writer coverage, terminal N06/report behavior, LIVE activation, and missing hysteresis. Additional CI regression exposed a blanket grouped-assignment rejection. The legacy API now uses a shared immutable successor and transactional attribution/intent sync. A route advisory/row lock inversion was also removed. These repairs receive fresh source review and DB regression proof. Review does not authorize management merge or deployment.

Full admin-shell regression requires the existing Route Ops static artifact. A fresh unchanged `apps/route-ops-web` build supplied that artifact. No frontend product source changed.

| Check | Result |
|---|---|
| prisma:generate | PASS, Prisma 6.19.3, fresh generated client |
| lint | PASS, full API ESLint; final added timing/DB tests also checked separately |
| typecheck | PASS, final full compiler after timing fixture type correction |
| test | PASS, 275 files, 3,219 tests; 24 files / 279 guarded or optional tests skipped |
| build | PASS, full delivery-api TypeScript build |
| Unchanged Route Ops web artifact | PASS, fresh build for existing admin-shell tests |
| Actual PostgreSQL DSV | PASS, 30/30, fresh 113-migration database |
| Actual PostgreSQL G002 | PASS, 7/7, legacy grouped driver API and immutable successor proof |
| Actual PostgreSQL G003 | PASS, 37/37, fresh 113-migration database |
| P0 fixture | PASS, JSON parse, all 23 IDs, frozen hash/source-byte equality, normalized behavior assertions |
| Scripts and whitespace | PASS, bash -n and git diff --check |

Full tests emit expected negative-path proof-media error logs. The build observer counts three such log lines; Vitest reports zero failed tests. Integration skips in the ordinary test command remain distinct from the 30+7+37 actual DB tests above. Other optional integration suites are not claimed as locally executed here.

Latest timing coverage exercises the real tickReminders service at exact before/due/after instants: T01–T09, T11, T12, cap injection, monitor expiry, delayed confirmation, and recovery. Actual DB T10/T11 also proves one N04, pause on warehouse re-entry, preserved ordinal, fresh departure across midnight, zero just before T+300, and exactly one at T+300. Six is only a synthetic T07 policy.

Local log root: `~/.codex/build-logs/dsv-server-20261006/` (logs remain outside Git).

- Full lint: `clever-route-server/20261006T175421.518225+0900-32dda9af664e-dsv-compat-full-lint/summary.json`.
- Final typecheck: `clever-route-server/20261006T175831.939836+0900-32dda9af664e-dsv-compat-full-typecheck2/summary.json`.
- Full tests: `clever-route-server/20261006T175743.212243+0900-32dda9af664e-dsv-compat-full-test2/summary.json`.
- API build: `clever-route-server/20261006T175700.332394+0900-32dda9af664e-dsv-compat-api-build/summary.json`.
- Actual DSV DB: `dsv-operational-disposable-20261006-final8.log`, SHA-256 `45cbe2f2e3a27e052cd06271e4dff3c54e671a0cabd8ea645a0774431f943c35`.
- G003 and preceding 27 DSV cases: `dsv-operational-disposable-20261006-final6.log`, SHA-256 `0f4ffbafffeda6bd65700568009bd3de178807821ac0c1b53726a521adc50a29`.

After the CI compatibility repair, G002/G003/DSV were rerun together: `dsv-g002-g003-operational-20261006-final5.log`, SHA-256 `9a3b1e4f2902d18d70f0d93d58c409b5c67e2cc359156f47e43ad3ba07393bfb`. All 74 tests passed. Forced row-wait cases now prove grouped assignment versus sync and internal close without a command ID. They finish without lock inversion and commit coherent generation, child, epoch, recipient, N01/N03, and close state. The old child remains ARCHIVED. Legacy API success expectations remain unchanged. Source re-review: APPROVE, zero unresolved findings.

The logs identify checkout HEAD at invocation; validation includes the implementation worktree changes. The final PR commit identifies the reviewed source. Production evidence is not included.

## Remaining release work

- D01: reminder cap/budget/expiry. Six reminders is an injected test example only.
- D02: operating windows/timezone/night behavior.
- D04: labeled fleet samples, parameters, false-positive/negative and latency acceptance.
- D05: approved reason catalog and operations handling process.
- D07: derived-record retention/deletion and read-audit policy; no approved purge is implemented.
- Driver PR61/Issue62: separate app integration/security release blocker.
- Actual GPS shadow, migration/deploy rehearsal, runtime proof, authenticated devices and FCM acceptance remain unperformed.
- P4/P5 client workflows and P6 activation remain separate. P7 is excluded.

Server P1–P3 completion means source implementation, synthetic proof, actual disposable DB proof, and an unmerged reviewable PR. It does not mean fleet/live readiness.
