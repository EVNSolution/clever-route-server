# K-food delivery completion and return navigation

## Contract

For app `clever-route-kfood` and shop `7hrud1-xq.myshopify.com`, an accepted
last terminal stop result records delivery completion immediately. Admin and
Shopify route list, detail, grouping, history and operational reads display
`COMPLETED`. The existing mobile execution contract retains raw `IN_PROGRESS`
for two hours so return-to-store navigation can remain available without a
mobile or Shopify release.

The server records its receipt time in `deliveryWorkCompletedAt` and the fixed
two-hour deadline in `driverNavigationUntil`, bound to the assignment generation
and current immutable child version. It requires exactly one current child,
nonempty exact snapshot membership, matching order bindings, and every stop
`DELIVERED`, `FAILED`, `CANCELLED` or `SKIPPED`. `ARRIVED` is unresolved.
This records delivery work being resolved, not a claim that every order was
delivered successfully.

Driver terminal events, accepted completion-assistance outcomes/return intent,
and administrative stop transitions reconcile completion under the route lock.
K-food receives a command-only completion run even when location detection is
disabled. Released apps require a valid policy to send the return command, so
this run uses an immutable internal policy and null coordinates for every
stop. Null coordinates prevent local visit detection; the run has no inference
activation and does not enable the location worker. An explicit return-to-store
command resolves the final stop from
`ARRIVED` to `DELIVERED` only when it is the sole unresolved stop, every earlier
stop is terminal, and the current account, assignment, child snapshot and order
bindings match. The server records `DRIVER_RETURN_INTENT` as the outcome source
and does not infer a delivery time from GPS. Pending or en-route stops, earlier
unresolved stops and stale assignments cannot be completed this way.
Repeats do not extend the deadline. Stop corrections invalidate the marker, and
child replacement clears markers owned by the replaced version. No historical
backfill or synthetic `ROUTE_COMPLETED` event occurs.

## Mobile compatibility

During the grace period, GPS and notes remain accepted; new execution, pause,
restart and reorder commands are rejected. A client `ROUTE_COMPLETED` command
is acknowledged as a `NOTE_ADDED` event with schema
`kfood_return_navigation_completion_ack_v1`, preserving the navigation period.
Its retry resolves to the same receipt. Previously committed stop retries also
resolve before execution-state validation.

At the deadline, active account/route lookup and route-token validation exclude
the route even if the periodic worker has not run. A subsequent mobile refresh
or reconnection removes it from My Routes. This does not install a timer in an
already cached mobile screen or stop external map navigation.

The existing `KFOOD_STALE_ROUTE_FINALIZATION_ENABLED` worker revalidates current
membership under the route lock and changes the raw status to `COMPLETED` after
the deadline. It scans every 15 minutes, in pages of 25; raw finalization can lag
the access deadline. Routes without an eligible completion marker retain the
existing tracking-window finalization to `INCOMPLETE`. The worker never derives
historical stop outcomes from an all-terminal snapshot alone.

## Rollout and evidence

Apply additive migration `20261002140000_kfood_delivery_navigation_grace`
through the reviewed manual deployment workflow before starting the new image.
It adds four nullable columns and updates no existing rows. No runtime config
change is required if the stale finalization worker is already enabled. If it
is disabled, access still expires but raw status awaits worker activation.

Deployment requires explicit production authority. Preserve the existing
backup/restore rehearsal, migration approval and rollback evidence requirements
in the production runbooks. An older image does not maintain these markers
when a stop or child version changes. Before it can serve requests, stop the
candidate, durably back up marker-bearing K-food routes, conditionally clear
all four marker fields under route locks, and verify that none remain. The
simple deployment wrapper performs this guard before automatic image rollback.
It first requires zero deferred `kfood_return_navigation_completion_ack_v1`
events, because an older image cannot replay those receipts. If one exists, or
backup or cleanup fails, it must not start the older image; recover with a
compatible image or a forward fix. Manual rollback must use the same guard,
or use a marker-aware compatible image. Retain the
private backup for audit and do not restore markers after mutations by an
older server. Order/stop outcomes, route status and assignment generation are
preserved. Do not remove these columns or backfill completion times as part
of rollback.

Before first rollout, verify the exact K-food tenant is unique, marker fields
have no existing values, deferred completion acknowledgements are absent, and
the previous runtime digest is pinned. After any acknowledgement is created,
that previous image is no longer an unconditional recovery option.

Validate separately:

1. Prisma generation, lint, typecheck, tests and server build.
2. Additive migration on a disposable PostgreSQL database and the last-stop,
   explicit return intent, retry, client completion acknowledgement, correction
   and expiry contracts, with location detection disabled.
3. Production migration, runtime revision, worker flag and health evidence.
4. Authenticated Shopify Complete views and the currently installed mobile
   binary before/after the deadline. Local API tests do not prove these screens.

Historical incidents with an unresolved final stop need authoritative outcome
evidence and a separately authorized, guarded repair. Deploying this policy
does not repair stored historical outcomes.
