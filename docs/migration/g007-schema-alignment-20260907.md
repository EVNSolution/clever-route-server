# G007 schema metadata alignment — 2026-09-07

## Decision and boundary

This hotfix is independent of the Driver inquiry feature. Replaying the existing
100 migrations and comparing their schema to Prisma reproduced the same preexisting
drift with and without inquiries. The original drift reports were byte-identical
(SHA-256 `f78c044aad24491d6670fec4315ce91b8db53b910e43c2e031e3e6f7d9d3322e`).

The SQL migrations and observed database definitions remain authoritative. Describe
their UUID/timestamp defaults, FK update actions, existing physical index names,
and 26 trigram GIN indexes accurately in Prisma. Remove only the phantom
`DriverRouteSessionLease` ordinary index declaration that never existed in the
migration chain. Preserve its existing partial unique index in SQL. No new repair
migration, table/column drop, index recreation, data update, or tenant change is
needed for this metadata correction alone. The separately identified missing
queue constraints require the additive recovery below. Do not replace the whole schema with
introspection output: that also changes existing relation API cardinalities.

Prisma will now use existing database UUID defaults for the corrected models.
Callers consume returned IDs or re-read by natural key; they do not depend on a
client-generated UUID before insertion. Existing timestamp defaults coexist with
Prisma `@updatedAt`; neither the database default nor update behavior is removed.

## Rehearsal corrections

The fingerprint builder previously executed SQL files using psql autocommit.
Migration `20260730170000_backfill_dsv_dispatch_groupings` uses `ON COMMIT DROP`
temporary tables across statements, so replay failed after the first statement.
Execute each migration file with `--single-transaction`, retaining any explicit
transaction boundaries in its SQL. Do not edit already-applied migration files.

Align the history validator with the existing production-monitor policy: keep a
rolled-back attempt when the same known migration also has a successful row with
the current checksum. A missing successful row, wrong current checksum, unknown
migration, or incomplete non-rolled-back attempt still fails. Never erase recovery
history or use `migrate resolve` to conceal an unresolved failure.

Regression evidence must cover the failing-before/passing-after wrapper checks,
fresh empty migration replay, backup/guarded restore with a synthetic recovered
history row, unchanged fixture data, idempotent second deploy, and final Prisma
drift exit code 0. Test generated Prisma types and the existing server suite.

## Missing queue constraints and additive recovery

Read-only production catalog comparison found equal columns, defaults and FK
definitions for all 95 tables, with two table-index differences. At
`2026-09-07T04:44:57Z`, the following partial unique indexes were absent in
production but present in the migration-chain database:

| Index | Function | Active rows | Duplicate groups |
| --- | --- | ---: | ---: |
| `commerce_sync_runs_one_active_per_connection_idx` | One QUEUED/RUNNING sync per commerce connection | 0 | 0 |
| `route_optimization_jobs_one_active_per_route_idx` | One QUEUED/RUNNING optimization per route | 0 | 0 |

The sampled table sizes were 80 kB and 264 kB. These are point-in-time observations,
not an enduring uniqueness guarantee. Prisma 6.19 does not model these predicates;
its zero-drift result does **not** prove complete catalog parity for partial
indexes, checks, or triggers. Existing queue repositories rely on these unique
constraints to resolve concurrent creation through Prisma `P2002`; their absence
allows a read-before-create race. The likely acceptance gap is the historical
Prisma-based baseline fingerprint, which omits partial indexes. The exact time and
cause of their operational absence are not established by repository evidence.

New migration `20260907000000_restore_active_job_uniqueness` restores only these
two original constraints. It locks the two small tables in a fixed order, checks
for duplicate active keys, creates missing indexes with the original predicates,
and checks their catalog definition and validity. Lock timeout is 5 seconds and
statement timeout is 30 seconds; duplicates, incorrect same-name indexes or
unavailable locks abort the transaction and block image rollout. No job is
deleted, merged, or reassigned. On a fresh migration-chain database the correct
indexes already exist, so this migration preserves them.

The raw Woo sync creation path now handles the same uniqueness conflict as the
ordinary sync path: re-read and return the winning active run. Other errors, or a
conflict without an active run, still propagate. This preserves the existing
`alreadyRunning` contract without changing external Woo or Shopify APIs.

The inquiry API does not use either queue, but the release must not claim complete
repair until the two catalog constraints are present and valid. Check the actual
catalog after deployment in addition to Prisma drift and health endpoints.

## Rollback

Metadata alignment makes no database mutation. The additive queue migration
restores constraints already expected by the previous image; no schema downgrade
or index drop is required during image rollback. The old raw sync race can still
surface as an error, so prefer a forward fix retaining the conflict handler.
Any later feature migration, including inquiries,
must have its own backward-compatibility and data-retention recovery plan.
