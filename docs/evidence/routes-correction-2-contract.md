# Routes correction 2: server contract

## Scope and invariant

The Routes table represents actual `RoutePlan` records only. A `RouteGrouping` is a relationship among routes and is never a table row. No `is_group` or `group_id` database columns are required: current membership is already represented by `RouteGroupingChildVersion.groupingId -> routePlanId`.

`GET /admin/ui/app/api/routes?shopDomain=...&deliveryDate=YYYY-MM-DD` remains shop-scoped and returns two sources:

- `routePlans`: standalone route plans only.
- `routeGroups[].children[]`: current route plans that belong to a group.

A row may be rendered only when it has an actual route-plan ID. Group containers and groups without current child routes are not rows.

## Exact row mapping

| Table column | Standalone route (`routePlans[]`) | Grouped route (`routeGroups[].children[]`) | Contract |
| --- | --- | --- | --- |
| Select | Client row selection keyed by `routePlan:<routePlan.id>` | Client row selection keyed by the child `routePlanId` and parent group ID | UI-only; no server value. |
| Name | `name` | `child.routePlan.name` | The route's own name. Never use `routeGroup.name` as the row name. |
| Status | `status` | `child.displayStatus` (or `child.routePlan.status` only as compatibility fallback) | Per-route execution status. Never substitute the parent group status. |
| Driver | `driver.displayName`; identity is `driverId` / `driver.id` | `child.driverName`; identity is `child.driverId` | Per-route assignment. The standalone API exposes only driver ID and display name, not auth or contact fields. |
| Start time | `scheduledStartAt` with `scheduledStartTimeZone`; fall back to `departureTime` | `child.routePlan.scheduledStartAt` with `scheduledStartTimeZone`; fall back to `departureTime` | `scheduledStartAt` is an ISO instant. `scheduledStartTimeZone` is the IANA display zone. `departureTime` is a local `HH:mm` value and must not be treated as UTC. Missing values remain unavailable. |
| Stops | `stopsCount` | `child.stopsCount` (equivalent route-plan count is a compatibility fallback) | Count of stops on that route only. |
| Total items | `itemSummary.totalQuantity` | `child.routePlan.itemSummary.totalQuantity` | Sum of line-item quantities on unique orders allocated to that route. An empty, valid item set is `0`; unavailable order-item data must not be invented. |
| Total drive time | `routeMetrics.durationSeconds` | `child.routeMetrics.durationSeconds` | Seconds for the exact current route shape. `null` means fresh metrics are unavailable. |
| Total distance | `routeMetrics.distanceMeters` | `child.routeMetrics.distanceMeters` | Meters for the exact current route shape. `null` means fresh metrics are unavailable. |
| Total price | `totalAmount.amount` + `totalAmount.currencyCode` | `child.routePlan.totalAmount.amount` + `.currencyCode` | Sum of unique orders on that route only. Returns `null` when any amount/currency is missing or currencies differ; never use a group total or fabricated zero. |
| Created | `createdAt` | `child.routePlan.createdAt` | Route-plan creation instant in ISO 8601. |
| Last modified | `updatedAt` | `child.routePlan.updatedAt` | Route-plan modification instant in ISO 8601. |

## Group relationship and color

The authoritative relationship is the current child membership under `routeGroups[].id`. Standalone summaries now expose `routeGroupingChild` only for a `CURRENT`, non-superseded child version, so archived membership cannot make a standalone route appear grouped.

All rows with the same parent `routeGroups[].id` share one presentation color. The existing `child.color` is retained for compatibility with route editing and snapshots, but it is not a separate group identity and must not produce different table colors for siblings. An ordinary route has no group color.

`switchRoutes` remains the sibling-navigation contract. Copy behavior and all route/order identities remain unchanged.

## Additive server correction

The standalone Route Ops DTO now preserves values that already existed in `RoutePlanSummary` but were previously omitted at the HTTP boundary:

- sanitized `driver: { id, displayName } | null`
- `routeMetrics: { durationSeconds, distanceMeters } | null`
- `scheduledStartAt: string | null`
- `scheduledStartTimeZone: string | null`

The repository list summary now emits `scheduledStartTimeZone` and limits `routeGroupingChild` to active membership. This change adds no schema migration, grouping model, group totals, data deletion, notification, or route-order mutation.
