# Driver destination notes and visit history

## Notes: current values and revisions

- A destination has 5 driver notes: memo, openTime, lunchTimeRange, lunchEntryStatus, requiredArrivalTime.
- The current values stay on `delivery_customer_profiles` (`driverMemo`, `driverMemoUpdatedAt`, …).
- The admin web and the driver route payload read these columns, as before.
- `destination_note_revisions` keeps every change. Each row has one field and its new value.
- A row also records `source`, `driverId`, `routePlanId` and `changedAt`.
- The driver app writes notes with `PATCH /driver/destinations/:destinationId/notes`.
- That request updates the profile columns and inserts one revision per changed field, in one transaction.
- An unchanged value writes no row.
- `source = DRIVER`: written by a driver on the route given by `routePlanId`.
- `source = LEGACY`: a value that existed when the table was created, dated at its old `…UpdatedAt`.
- Changes made before the table existed are not recoverable.
- Revisions belong to the profile they were written to.
- Readers collect the canonical destination, its identity duplicates and the profiles merged into them.
- Any new writer of these columns must also insert revisions. Otherwise visit history loses that change.

## Visit history

`GET /driver/destinations/:destinationId/visits?cursor=…`

- Auth: a route token, or the driver account token. Visit history is readable without an open route.
- Scope: only the requesting driver's own routes, with the driver's review classification.
- Other drivers' visits are not returned.
- A visit is one route of this driver with a `DELIVERED` or `FAILED` stop at the destination.
- `outcome` is DELIVERED, FAILED or PARTIAL.
- `visitedAt` is the latest `STOP_DELIVERED.occurredAt` of the visit. This is the time the driver entered.
- `notes` are the latest revisions per field with `changedAt <= visitedAt`.
- A visit without a completion time reads `notes` at the end of its plan date.
- `changedFields` lists the fields this driver changed on that route.
- `orderNotes` are the distinct stop instructions of that visit.
- Order: plan date descending, then route id descending.
- Pages hold 20 visits. `nextCursor` is opaque.
