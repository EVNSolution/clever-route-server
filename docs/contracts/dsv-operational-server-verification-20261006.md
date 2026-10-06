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

Fresh migrations: all 113 applied to DSV, G002, and G003 isolated databases. Actual G002 regression: 7 passed. Actual G003 regression: 37 passed. Latest DSV DB suite: 32 passed. The optional G002 lane uses `DSV_OPERATIONAL_INCLUDE_G002=1` and loopback port 55488.

Coverage includes publication/intent atomicity, two start events and receipts, forced rollback, forced concurrent same-command receipt waits, arbitrary legacy partial-start repair, command conflict, tenant/account isolation, selector exclusion/history, vehicle selection clipping, immutable UVIS evidence across restart, no catch-up burst, post-lock context rebind, ambiguous vehicle attribution, expired-lease takeover, late-worker CAS, transient provider retry without business ordinal change, real persisted principal/capability/inbox/resolver, operations acknowledge/resolve race, independent N07 lifetime, terminal-stop N06 closure and report rejection, content override rollback, and fresh LIVE activation evidence.

The final two DSV DB cases use the production multi-child draft writers. Public saveDraft commits both published successors, projections, grouping READY, context versions, N02 intents, and command results. A PostgreSQL trigger fails the second sorted context update inside saveDraftInTransaction. The test then verifies full rollback of the first context sync, both children, route/stops, orders, grouping, notifications, and command results.

Source data and provider results are synthetic. Provider tests use fake sends only. Guarded integration skips in the ordinary unit command are not counted as DB proof.

## Original P1–P3 review and checks

Independent source review found and fixed authorization scopes, attempt starvation, dynamic kill-switch/routing parity, geofence post-lock attribution, selector races, internal receipt-hash hints, N04/N05 resolution, independent N07 lifetime, generic writer coverage, terminal N06/report behavior, LIVE activation, and missing hysteresis. Full CI regression also exposed grouped-assignment compatibility and premature draft synchronization. The legacy API now uses a shared immutable successor and transactional attribution/intent sync. A route advisory/row lock inversion was removed. Child replacement now has no implicit execution hook. All nine callers synchronize at their completed business boundary. Unpublished drafts create no context or N01. Published draft writers finish projections, assignment recomputation, and grouping READY before sorted synchronization. Strict published-snapshot validation and same-transaction rollback remain enforced. These repairs received fresh source review and the full actual DB regression profile. Review does not authorize management merge or deployment.

Full admin-shell regression requires the existing Route Ops static artifact. A fresh unchanged `apps/route-ops-web` build supplied that artifact. No frontend product source changed.

| Check | Result |
|---|---|
| prisma:generate | PASS, Prisma 6.19.3, fresh generated client |
| lint | PASS, full API ESLint; final completed-boundary source and regression tests included |
| typecheck | PASS, final completed-boundary source and regression tests included |
| test | PASS, 275 files, 3,221 tests; 24 files / 281 guarded or optional tests skipped |
| build | PASS, full delivery-api TypeScript build |
| Unchanged Route Ops web artifact | PASS, fresh build for existing admin-shell tests |
| Actual PostgreSQL DSV | PASS, 32/32, fresh 113-migration database |
| Actual PostgreSQL G002 | PASS, 7/7, legacy grouped driver API and immutable successor proof |
| Actual PostgreSQL G003 | PASS, 37/37, fresh 113-migration database |
| Full actual PostgreSQL regression profile | PASS, 23 files / 272 tests, including existing assignment, grouping, reorder, privacy, deletion, completion, and DSV operational suites |
| Actual original observations PostgreSQL | PASS, 5/5, fresh 113-migration database |
| P0 fixture | PASS, JSON parse, all 23 IDs, frozen hash/source-byte equality, normalized behavior assertions |
| Scripts and whitespace | PASS, bash -n and git diff --check |

Full tests emit expected negative-path proof-media error logs. The build observer counts three such log lines; Vitest reports zero failed tests. Integration skips in the ordinary test command remain distinct from the actual DB tests above. The separate full disposable profile ran 272 tests. The separate original-observation profile ran five tests. Guarded suites outside these profiles remain unclaimed.

Latest timing coverage exercises the real tickReminders service at exact before/due/after instants: T01–T09, T11, T12, cap injection, monitor expiry, delayed confirmation, and recovery. Actual DB T10/T11 also proves one N04, pause on warehouse re-entry, preserved ordinal, fresh departure across midnight, zero just before T+300, and exactly one at T+300. Six is only a synthetic T07 policy.

A supplemental developer typecheck initially exhausted the default 2 GiB Node heap. The command was rerun with a 4,096 MiB old-space limit and passed. The final lint and compiler commands use that same explicit limit. No source or dependency workaround was used.

Local log root: `~/.codex/build-logs/dsv-server-20261006/` (logs remain outside Git).

- Prisma generation: `clever-route-server/20261006T181417.963083+0900-07f0899603ed-dsv-boundary-prisma-generate/summary.json`.
- Full lint: `clever-route-server/20261006T182612.642607+0900-07f0899603ed-dsv-final-full-lint/summary.json`.
- Final typecheck: `clever-route-server/20261006T182716.673302+0900-07f0899603ed-dsv-final-full-typecheck/summary.json`.
- Full tests: `clever-route-server/20261006T182758.053513+0900-07f0899603ed-dsv-final-full-test/summary.json`.
- API build: `clever-route-server/20261006T182853.540812+0900-07f0899603ed-dsv-final-api-build/summary.json`.
- Actual DSV DB: `dsv-operational-disposable-20261006-final8.log`, SHA-256 `45cbe2f2e3a27e052cd06271e4dff3c54e671a0cabd8ea645a0774431f943c35`.
- G003 and preceding 27 DSV cases: `dsv-operational-disposable-20261006-final6.log`, SHA-256 `0f4ffbafffeda6bd65700568009bd3de178807821ac0c1b53726a521adc50a29`.

After the CI compatibility repair, G002/G003/DSV were rerun together: `dsv-g002-g003-operational-20261006-final5.log`, SHA-256 `9a3b1e4f2902d18d70f0d93d58c409b5c67e2cc359156f47e43ad3ba07393bfb`. All 74 tests passed. Forced row-wait cases now prove grouped assignment versus sync and internal close without a command ID. They finish without lock inversion and commit coherent generation, child, epoch, recipient, N01/N03, and close state. The old child remains ARCHIVED. Legacy API success expectations remain unchanged. The completed-boundary repair then passed the full disposable profile (272/272) and original-observation profile (5/5). Source re-review: APPROVE, zero unresolved findings.

- Final full disposable DB profile: `full-disposable-db-profile-20261006-final-multichild.log`, SHA-256 `b64f52bf6a95b285b94146f1743a1537a7d1de0206854666e55035083153f50f`.
- Final DSV operational lane: `dsv-operational-multichild-20261006-final.log`, SHA-256 `e109e627a78fdc0aa17592b22de2ede4f3cbaf65065fda5a8db78300757d7221`.
- Final original observations DB: `original-observations-db-20261006-final.log`, SHA-256 `e455bac24f6ed3269daf3d7cf3bd90d674fb533ec5ddb68569bb43c6cdbd0948`.

The logs identify checkout HEAD at invocation; validation includes the implementation worktree changes. These are the original P1–P3 results through management review baseline `90465a872662bbf6d7b7abf9fe011e74290441e8`. The following section records the subsequent management corrections. Production evidence is not included.

## PR #483 management corrections

Review input: `.omx/plans/dsv-notification-server-review-20261006.md` in the canonical server checkout. Reviewed baseline: `90465a872662bbf6d7b7abf9fe011e74290441e8`. Corrections continue the existing PR branch. Target #482 and change-control #310 remain unchanged. These records are technical evidence, not operating-policy approval.

| Finding | Reproduced defect | Correction and regression scope |
|---|---|---|
| R1: driver/vehicle deletion | Actual PostgreSQL allowed all three deletion entrypoints to remove newly assigned resources while ACTIVE scalar contexts remained. Fixtures assert zero import-row resource references. | Shared transaction rejects nonterminal published routes, ACTIVE contexts, and import-row references with RESOURCE_IN_USE. Sorted route locks precede the resource lock and a fresh reference check. Context synchronization holds resource KEY SHARE locks. Tests assert complete no-change on rejection, normal unreferenced deletion, preserved closed history, and both winners of assignment/publication races. |
| R2: first exit observation | Unit reproduction returned NONE/EXITING for exitMinSamples=1, exitDwellSeconds=0. | First valid outside observation uses the same confirmation predicate as later observations. Persisted synthetic raw UVIS proof covers DEPARTED, T+299.999 seconds with zero N05, T+300 seconds with one N05, retry, and restart. Existing multi-sample/dwell, neutral band, gap, and re-entry cases remain. |
| R3: N01 date | Two unit reproductions showed the generic title without the execution date. | Push and inbox use execution.serviceDate for “n월 n일 배차가 등록되었습니다.”. Future dates, different service days, calendar-boundary retry, unchanged schema-v1 payload, and final fresh checks are tested. Existing-context date mismatch rejects instead of moving an execution to another business day. |

Independent code review also found that the new serviceDate lookup must precede the final fresh policy, authority, and lease checks. The lookup now occurs before those checks. A policy change to OFF during the lookup results in zero provider calls. Review also found a missing matching-date invariant in SAME_EXECUTION; replacement and existing-context synchronization now reject a different business date. Actual PostgreSQL verifies mapping, receipt, notification, and context rollback on rejection.

The publication-versus-deletion tests use the production grouped publication writer and PostgreSQL trigger gates. Publication winning first preserves the resource, ACTIVE context, N01, and publication receipt while deletion rejects. Deletion winning first leaves route.driverId null and preserves legacy physical publication evidence plus one SKIPPED_NON_DSV receipt; its external result is FAILED/NOTIFICATION_PROCESSING_FAILED. It creates no context, mapping, or N01. Independent code and design reviews accepted this existing partial-success boundary. No product writer was changed to erase that history or skipped-command result.

Correction log root: `/Users/jiin/.codex/build-logs/dsv-review-fixes-20261006/`. Red runs are intentional defect reproductions and are not final passing results.

- R1 actual PostgreSQL red: `r1-prefixed-deletion-guard-reproduction.log`; original 32 cases passed, three new deletion rejection cases failed as expected. SHA-256 `8aba81e1d149d930fa4385aa1ae5db2d1395f0acd00da7dec1ce2b4d49ecfea6`.
- R2 red: `clever-route-server/20261006T212940.141690+0900-90465a872662-r2-red-geofence-engine/summary.json`.
- R2 focused green: `clever-route-server/20261006T213034.545710+0900-90465a872662-r2-green-final-focused/summary.json`; 44 passed.
- R3 red: `clever-route-server/20261006T213011.244645+0900-90465a872662-dsv-r3-n01-red/summary.json`.
- R3 focused green after freshness repair: `clever-route-server/20261006T213605.151600+0900-90465a872662-dsv-r3-n01-final-green/summary.json`; 32 passed.

Supplemental publication-race test development exposed a test-only Prisma P2010 when selecting an advisory-lock function's void value. The gate now selects a boolean value. A subsequent expectation incorrectly required publication rollback and zero command receipts; it was corrected to assert the existing FAILED result, physical publication evidence, one skipped receipt, and zero execution artifacts. These intermediate runs are not counted as passing proof.

The unchanged original-observations lane initially failed its late-storage fixture twice (4/5). Diagnostics showed DB snapshot `12:54:17.840315Z`, Prisma-created stored time `12:54:17.803Z`, DB clock `12:54:17.843Z`, and host clock `12:54:17.805Z`. The host clock lagged the VM DB by about 38 ms, so the fixture did not satisfy its required late-storage condition. Only the fixture now sets its stored time to the DB cursor snapshot plus one microsecond and explicitly asserts storedAfterSnapshot=true. The production query is unchanged. This verifies a stored-time cursor fence; it does not claim a commit-time fence for transactions opened before the snapshot.

| Fresh PostgreSQL check | Result |
|---|---|
| Full existing disposable profile | PASS, 23 files / 282 tests, including the first 42 DSV cases |
| Final DSV lane after two added publication races | PASS, 44/44; 113 migrations; no resource or execution lock failure |
| Distinct cases covered by the profile and final DSV lane | 284; repeated DSV invocations are not added to this count |
| Original observations after deterministic fixture repair | PASS, 5/5; fresh 113-migration database |

- Full profile: `full-disposable-db-profile-final.log`; SHA-256 `76550a98777f25e2308f5355c334842baedb041c1d5ee5608ab16510ab78bacc`.
- Final DSV: `r1-r3-actual-db-final-44-run5.log`; SHA-256 `2092e70f5ffaa01be2bb0dbba28ca2b5dfc9a7afc309b8849e7d951f2cf061f3`.
- Final original observations: `original-observations-db-final-run4.log`; SHA-256 `cee96c8c5308a7413e1cfddb83cb65b2727b569a839b5778eb5c67a4b386b0c8`.
- Original clock diagnosis: `original-observations-db-diagnostic.log`; SHA-256 `b4b6d30de50c1183f531d5e1245dcd3cc539bc4a89f2021854b1e6db47489301`.

The R1–R3 correction received independent code and design approval at `c3488be92d20d5daeb7604ba753ba60491969e39`. Management subsequently found the account-link/driver-delete lock inversion and withdrew that approval. Those earlier reviews are historical evidence, not the current acceptance verdict. The following account-link section records the additional correction and fresh acceptance checks.

The first full correction typecheck found two test-only type errors: a mock call array typed as a one-element tuple, and an unchecked raw-query row destructure. The mock call type now permits an array; the DB assertion now checks exactly one true result row. No product type or query changed. The fresh typecheck rerun passed.

Prisma generation and checks identify baseline HEAD at invocation because the corrections were still uncommitted. Their source is the correction commit attached to PR #483.

| Fresh required API gate | Result |
|---|---|
| prisma:generate | PASS, Prisma 6.19.3 generated client |
| lint | PASS, full API and all final regression fixtures |
| typecheck | PASS, full API and tests |
| test | PASS, 276 files / 3,241 tests; 24 files / 293 guarded or optional tests skipped |
| build | PASS, full delivery-api TypeScript build |
| P0 fixture | PASS, JSON parse, 23 distinct cases, unchanged frozen SHA-256 |
| Hygiene and whitespace | PASS, ignore hygiene, secrets scan, scanner tests, git diff --check |

The three expected proof-media negative-path error logs remain; Vitest reports zero failed tests. The ordinary test command's 293 skipped tests are not DB passes. Fresh actual PostgreSQL results are listed separately above. The unchanged existing Route Ops artifact supplies local admin-shell tests; no frontend source changed. All final Node gates use a 4,096 MiB old-space limit and run sequentially after DB work.

- Prisma: `clever-route-server/20261006T214122.082951+0900-90465a872662-dsv-review-prisma-generate/summary.json`.
- Final lint: `clever-route-server/20261006T215858.493606+0900-90465a872662-dsv-review-final-lint/summary.json`.
- Final typecheck: `clever-route-server/20261006T215810.679647+0900-90465a872662-dsv-review-final-typecheck/summary.json`.
- Full tests: `clever-route-server/20261006T220007.772482+0900-90465a872662-dsv-review-final-full-test/summary.json`.
- API build: `clever-route-server/20261006T220055.338956+0900-90465a872662-dsv-review-final-api-build/summary.json`.

All disposable containers were removed. The task-owned Colima VM was stopped, and Docker context restored to its initial default. Canonical checkout and other worktrees were preserved.

## Account-link and driver-delete lock correction

Reviewed baseline: `c3488be92d20d5daeb7604ba753ba60491969e39`. The same PR #483 branch continues. Target #482 and change-control #310 remain linked. Management's model-level reproduction was followed by actual product-writer PostgreSQL tests.

The baseline deletion guard waited in route → driver order. Admin account approval, DSV registration, DSV login auto-linking, and common invite registration updated the driver before their attribution hook waited for the route. The regression holds a conditional AFTER UPDATE trigger at a transaction advisory gate. It confirms the linking writer's lock wait, starts the actual deletion writer, confirms its lock wait, then releases the gate. It uses PostgreSQL lock state to select the reached driver; no arbitrary sleep determines transaction order.

All four baseline cases reproduced Prisma P2010 with SQLSTATE `40P01` and `ERROR: deadlock detected` in deletion. The linking writer committed, while deletion failed instead of returning RESOURCE_IN_USE. The existing 44 DB cases passed. The SQLSTATE log includes the opposing transaction ShareLock waits. Each target database received the existing 113 migrations.

Log root: `/Users/jiin/.codex/build-logs/dsv-account-link-locks-20261006/`.

- Initial red: `account-link-delete-red.log`, 4 failed / 44 passed; SHA-256 `81754782f6f7a94f31781400ad852baf29e5dfee22c9804765697fee8d31eddc`.
- Red with raw SQLSTATE: `account-link-delete-red-with-sqlstate.log`, 4 failed / 44 passed; SHA-256 `14b3ea71adeca98ed71f720e7e6a2e1246f831c36065a164abbbad217443922a`.

These red runs are intentional defect evidence. They are not passing verification.

The correction prelocks the global direct-route/ACTIVE-context route union, then the global driver union, both in UUID order. Existing accounts are held before route/driver locks. Fresh route and candidate references must be covered by the actual locked rows. Unknown references cause full rollback and at most three topology-only attempts; no driver-held transaction waits for a newly discovered route or account. SQLSTATE 40P01 and ordinary storage errors are not retried. Exhausted topology changes return ATTRIBUTION_CHANGED 409. Common invite account, linking, attribution, and session now share one transaction.

Independent code review found one additional reachable attribution writer: common admin createPendingDriver updates an existing same-phone/shop driver, including DSV drivers. Its baseline changed accountId without synchronizing execution. Actual PostgreSQL reproduced epoch 1 and a null execution recipient after successful account linking. The existing row branch now uses sorted current/target account advisory and row locks before route/driver locks. It rereads both account references and rejects changed hints without acquiring late account locks. A per-invocation UUID is reused only within topology retry; it prevents an old receipt from suppressing A→B→A relinking. Same-account calls create no epoch, intent, or synchronization receipt. New-driver creation retains its existing behavior. Both common admin and Route Ops JSON APIs map topology exhaustion to 409.

- Common admin red: `admin-existing-account-link-red.log`, 1 failed / 52 passed; SHA-256 `f198fbbeafa35d134c70c87ce02dfdf26446c7d40300e76bd4e32095618c1bb4`.
- Four-path correction green with refresh and rollback: `account-link-delete-green-final.log`, 52/52; SHA-256 `bd318589c04697f0dcc120e3e47babfa734dea135f261447b78f43def8160714`.
- Final dedicated lane including common admin and A→B→A: `admin-existing-account-link-green.log`, 54/54; SHA-256 `3370a7b2a6fd67ac84f3fa8b91dcfe2669afba17d164996f5853b46729c8ad89`.
- Final dedicated lane with complete rollback row snapshots and single-audit assertion: `atomic-snapshots-final.log`, 54/54; SHA-256 `403815c1667fd1c0c648d3eb80378016c71e828dc8a5730225bb719384fc8f2a`.

The final lane invokes actual product repositories/services. It covers admin approval, DSV registration/login/refresh, common invite registration, and common admin existing-row registration against deletion. Linking succeeds; deletion returns RESOURCE_IN_USE, whose HTTP 409 mapping is also tested at the API boundary. No normal race returns a deadlock error. Reverse driver/route UUID fixtures verify the global ordering. A transaction-client proxy pauses after a completed real topology query; an independent route insert commits before linking resumes. The actual account-approval writer rolls back and succeeds on its second complete transaction attempt, with one audit, one epoch increment, and one N01. A conditional trigger rejects the second driver's N01 in signup/invite tests; account, session, driver/profile, contexts, route state, intents, and receipts all retain their pre-call state. A→B→A tests verify epoch 2/3, recipient-specific N03/N01, two distinct command receipts, and unchanged state on same-account repetition.

Test development initially exceeded an existing account name column limit. Synthetic names now fit that limit; phone and invite inputs use each API's accepted format. Two exploratory green runs are not counted as passing evidence. One also timed out an unchanged geofence case under concurrent validation; the cause was not established. The sequential fresh run passed with its original timeout and assertions. Synthetic credential literals use the scanner's existing fixture prefix rules; no scanner rule or secret allowlist changed.

| Fresh account-link PostgreSQL check | Result |
|---|---|
| Complete existing disposable profile | PASS, 23 files / 294 distinct cases, including all 54 DSV cases |
| Strengthened DSV rollback and audit lane | PASS, 54/54; complete driver, profile, route and execution-artifact snapshots; account/session counts unchanged on injected failure |
| Original observations | PASS, 5/5; fresh 113-migration database |

The final full profile used the final product source. The subsequent dedicated lane strengthened test assertions without changing product code. Its 54 cases are already included in the 294 distinct-case count. Ordinary guarded integration skips are not counted as passing database proof.

- Full profile observer: `clever-route-server/20261006T225946.001495+0900-c3488be92d20-dsv-account-link-final-full-db/summary.json`; output SHA-256 `4c1ac352c001167354a17d50fbb0a1dba36957a983b30787418b587c5ed3e6e3`. One logged proof-media cleanup error is an expected negative-path assertion; the suite has zero failed tests.
- Original observations observer: `clever-route-server/20261006T230524.690613+0900-c3488be92d20-dsv-account-link-original-db/summary.json`; output SHA-256 `9cc57eb94be48ac098a38a43d411873f1f0c6996a65f0126dccf5220124194a6`.

All disposable containers were removed. The task-owned Colima instance was stopped and the initial Docker `default` context restored. The existing Homebrew database, other worktrees, production data and runtime settings were not changed.

The first full typecheck found two test-adapter type errors: a generic transaction mock returned unknown, and a reduced Prisma adapter omitted the transaction array overload. The helper test now uses a generic callback wrapper with a separate call spy. The topology test now proxies the real Prisma client. Assertions and the real transaction/gate behavior remain unchanged. A fresh full typecheck passed. The final dedicated PostgreSQL lane passed 54/54 after this adapter correction.

| Fresh account-link API gate | Result |
|---|---|
| prisma:generate | PASS, Prisma 6.19.3 fresh client |
| lint | PASS, full API; corrected test adapters also receive fresh focused ESLint |
| typecheck | PASS, full API and final test adapters |
| test | PASS, 277 files / 3,255 tests; 24 files / 303 guarded or optional tests skipped |
| build | PASS, full delivery-api TypeScript build |
| P0 fixture | PASS, 23 distinct cases, JSON parse, frozen source-byte/SHA-256 behavioral checks |
| Hygiene, secrets and whitespace | PASS, existing hygiene/scanner contracts and git diff --check; no scanner rules changed |

API gates use a 4,096 MiB Node old-space limit. The ordinary test run logs three expected proof-media negative-path errors and reports zero failed tests. These logs are not test failures. Guarded integration skips remain separate from the disposable database proof.

- Prisma: `clever-route-server/20261006T230843.588340+0900-c3488be92d20-dsv-account-link-prisma/summary.json`.
- Full lint: `clever-route-server/20261006T230859.856222+0900-c3488be92d20-dsv-account-link-lint/summary.json`.
- Final full typecheck: `clever-route-server/20261006T231121.670652+0900-c3488be92d20-dsv-account-link-typecheck-final/summary.json`.
- Full tests: `clever-route-server/20261006T231149.689148+0900-c3488be92d20-dsv-account-link-test/summary.json`.
- API build: `clever-route-server/20261006T231251.128487+0900-c3488be92d20-dsv-account-link-build/summary.json`.
- Final adapter DB: `clever-route-server/20261006T231428.463194+0900-c3488be92d20-dsv-account-link-final-adapter-db-rerun/summary.json`; output SHA-256 `78021abd45c61d14b3724b756eed9887bc1366f6df6bfd7f0d6b23c5f676be6f`; 54/54, fresh 113 migrations. An earlier observer invocation used the wrong working-directory-relative script path and exited before creating a database; it is not counted as test proof.

Independent frozen-diff code and design re-review: APPROVE, zero unresolved findings. Both reviews cover the four requested entrypoints, refresh, the additional common admin existing-driver path, global route/driver ordering, topology-only retry, failure atomicity and preserved R1–R3 behavior. Exact correction-commit CI and read-only review evidence are linked on PR #483 after commit/push; historical c3488be9 approval is not substituted for this final verification.

## Remaining release work

- D01: reminder cap/budget/expiry. Six reminders is an injected test example only.
- D02: operating windows/timezone/night behavior.
- D04: labeled fleet samples, parameters, false-positive/negative and latency acceptance.
- D05: approved reason catalog and operations handling process.
- D07: derived-record retention/deletion and read-audit policy; no approved purge is implemented.
- Driver PR61/Issue62: separate app integration/security release blocker.
- Actual GPS shadow, migration/deploy rehearsal, runtime proof, authenticated devices and FCM acceptance remain unperformed.
- P4/P5 client workflows and P6 activation remain separate. P7 is excluded.
- P6 WATCH: verify actual provider readiness before the new channel replaces legacy sending. This remains a later activation condition, without expanding the current default-OFF corrections.

Server P1–P3 completion means source implementation, synthetic proof, actual disposable DB proof, and an unmerged reviewable PR. It does not mean fleet/live readiness.
