# K-food route grouping ownership recovery

This runbook prepares a narrowly scoped repair for stale order ownership left by a deleted route. It does not authorize or perform a production change.

## Incident boundary

| Field | Exact value |
| --- | --- |
| Baseline API image revision | `a92ae035fa1b941c7f31e41fd1e2ea96be66630e` |
| App | `clever-route-kfood` |
| Shop | `7hrud1-xq.myshopify.com` |
| Old grouping | `6cf7650f-31b9-46c2-bded-0827cf0306e9` |
| New grouping | `02edfb64-31fe-4f12-9dca-c184fad32cc5` |
| Stale child version | `8056cf0d-d490-4c96-9c0f-d57da3878863` |

The reported `42` stale pointers, `42` old-group members, and `41` new-group members are user-observed production evidence. Production was not re-read while preparing this runbook.

Only orders in this exact tenant whose `currentRouteVersionId` still equals the exact stale child version may be repaired. Orders already moved to another version are outside the repair. Membership in the old or named new grouping is allowed. Any other active grouping, different explicit custom-order owner, or invariant/count drift stops the repair.

## Read-only dry-run

Use a read-only database credential when available. The SQL uses a repeatable-read, read-only transaction and ends with `ROLLBACK`.

```bash
psql "$DATABASE_URL" -X \
  -f apps/delivery-api/scripts/kfood-grouping-ownership-recovery-dry-run.sql.example \
  | tee "kfood-grouping-ownership-recovery-dry-run-$(date -u +%Y%m%dT%H%M%SZ).log"
```

Continue planning only when `ready_for_scoped_recovery` is `true` and the report shows:

- tenant, old grouping, active new grouping, and stale child invariant counts: `1` each;
- stale pointers and old-group members: `42` each;
- new-group members and new-group stale pointers: `41` each;
- stale pointers without old membership, changed old-member ownership, other active-group membership, and other custom ownership: `0` each;
- stale child status `ARCHIVED`, old grouping ID exact, and `routePlanId = NULL`.

Any mismatch means the observed snapshot changed. Stop and investigate; do not alter expected counts to pass the gate.

## Reviewable apply plan

Prepare a separate apply script only after the server fix is reviewed and an operator approves a production change window. That script must use one transaction and implement these steps in order:

1. Resolve exactly one shop by the exact `appId` and `shopDomain` above.
2. Recheck the old/new grouping and stale child invariants, plus the `42/42/41` expected counts from the dry-run.
3. Materialize the exact 42 candidate order IDs with their `shopId`, previous version, and previous `updatedAt`. Compare the sorted IDs with the reviewed dry-run artifact.
4. Lock only the two exact grouping rows, exact stale child-version row, exact membership rows for those groups, and exact 42 order rows with `SELECT ... FOR UPDATE` in deterministic ID order. Do not lock entire tables.
5. Repeat every invariant and ownership-conflict query after acquiring the row locks. Abort if any candidate disappeared, moved version, joined another active group, or changed custom owner.
6. Write an immutable incident backup containing exactly these fields:

   - `orderId uuid`, `shopId uuid`, `previousRouteVersionId uuid`;
   - `previousUpdatedAt timestamptz(3)` and one shared `appliedUpdatedAt timestamptz(3)` truncated to milliseconds;
   - incident ID, exact app/shop/old/new/version constants, creation time, reviewed dry-run artifact SHA-256, and operator/change reference.

7. Compare-and-set each exact candidate by `orderId`, `shopId`, stale `currentRouteVersionId`, and previous `updatedAt`. Set only `currentRouteVersionId = NULL` and `updatedAt = appliedUpdatedAt`.
8. Require the update row count and backup row count to equal `42`. Require zero remaining pointers to the stale version for this tenant. Any mismatch rolls back the transaction.
9. Review the transaction-local result before commit. Preserve the backup through post-deploy verification and the rollback window.

This plan intentionally does not include an executable apply block. The eventual apply must be a separate reviewable artifact with the exact 42 IDs captured by an approved dry-run; a broad `UPDATE ... SET currentRouteVersionId = NULL` is prohibited.

## Rollback plan

Prepare rollback as a separate reviewed transaction from the immutable backup:

1. Resolve the same exact tenant and require the backup to contain exactly the reviewed 42 IDs and incident constants.
2. Lock only those 42 orders in deterministic ID order.
3. Refuse rollback if an order is missing, belongs to another shop, has a non-NULL `currentRouteVersionId`, or its `updatedAt` differs from the backup's exact `appliedUpdatedAt`. These checks protect ownership assigned after recovery.
4. Compare-and-set each unchanged row by `orderId`, `shopId`, `currentRouteVersionId IS NULL`, and `appliedUpdatedAt`; restore its exact `previousRouteVersionId` and `previousUpdatedAt`.
5. Require exactly 42 restored rows and verify every restored version equals the incident stale version. Any mismatch rolls back the full transaction.
6. Rerun the read-only report and record the backup/artifact hashes and resulting counts.

After an applied repair, the dry-run should report `stale_pointer_count = 0`; this intentionally makes `ready_for_scoped_recovery = false`. Do not restore or clear an order that has acquired newer ownership through normal routing.

## Validation and completion boundary

The dry-run SQL executed successfully against the task-owned local PostgreSQL fixture and returned `ready_for_scoped_recovery = false` because that empty fixture contains none of the production incident rows. This proves the checked-in read-only SQL executes and fails closed; it does not verify current production counts.

Production recovery remains incomplete until an approved apply artifact is reviewed and committed, post-apply inventory shows zero stale pointers, and K-food grouping save succeeds against the deployed server fix. Server deployment and data recovery are separate operator actions.
