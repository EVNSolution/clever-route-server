# Route grouping draft Save compatibility

`SaveRouteGroupingDraftInput` keeps the existing request shape. The server derives
the Unassigned pool from group membership minus the membership of operational
current children (`CURRENT` and `supersededAt = NULL`). Driver assignment and
delivery date/scope are not membership authorities: a child without a driver is
still a child, and an order without a delivery date can remain in the group.

## Save rules

- `routes[].orderIds` must contain only current group members, without duplicates.
- Every order already in a current child must appear exactly once in a submitted
  route or in `removedOrderIds`. Omitting it remains an error, including when its
  child is listed in `deletedRoutePlanIds`.
- Orders outside all current children may be omitted. Their group and linked
  inventory membership are retained. They may also be explicitly assigned to a
  route in the same request.
- `removedOrderIds` is an explicit group/inventory removal operation. An order
  cannot be both routed and removed. The server never adds IDs to this field.
- Archived/superseded children do not make an Unassigned order mandatory in the
  draft. Existing revision, tenant, route ownership, and started-route checks
  still apply at Save time.

For a group containing 42 orders, where current children contain 41 and one order
has no delivery date/scope, a draft partitioning those 41 as `[18, 23, 0]` succeeds
without submitting the remaining order. After Save the group and its inventory
still contain 42 orders. Saving the same draft again preserves the same member.

Clients that send a complete partition continue to work unchanged. Clients that
omit their Unassigned UI row can use the existing endpoint immediately after the
server deployment. No new field or coordinated client release is required.
To move an already routed order into Unassigned rather than remove it from the
group, a separate explicit contract is required; omission is not that operation.

## Cancelled orders and filter-wide selection

Group creation, standalone-to-group creation, and addition of new group members
share delivery-fact validation. A non-null `Order.cancelledAt` rejects the
transaction with `ROUTE_GROUPING_INVALID`, even if delivery facts still say
`READY_TO_PLAN`. Orders without a delivery date/scope remain allowed subject to
the existing coordinate/stop checks.

Filter-wide selection snapshots exclude cancelled orders across the whole
matching result set, and exclusion changes recheck cancellation before computing
the selected count. The snapshot stores the full filter/watermark universe;
cancelled members always have `excludedAt` set and never enter the selected set.
This preserves compatibility with clients that send visible cancelled IDs in
`excludeOrderIds` on creation or replacement. Exclusions outside that captured
universe still fail validation. Ordinary Orders list queries retain cancelled
rows. This is independent of action-time eligibility/skip checks.

This server change does not publish the separately prepared Shopify web commit
`3f4e1c0`, repair historical production pointers, or deploy a runtime image.
See [the scoped recovery runbook](../runbooks/kfood-grouping-ownership-recovery.md)
for existing-data recovery prerequisites and rollback gates.
