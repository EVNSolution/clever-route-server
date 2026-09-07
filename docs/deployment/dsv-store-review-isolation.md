# DSV Play review data isolation

Review fixtures stay in their existing tenant. The DSV developer-admin boundary
(`dsv:accounts:read`) can inspect and manage them; ordinary operators and customer
accounts cannot. Driver use requires matching review classification on the
account, driver, and route. Regular and review orders must not share a route or
be reassigned across those classifications. Credentials and account IDs do not change.

This fixture has no vehicle or telematics attachment; the repair asserts that
invariant. Vehicle telemetry remains operational data. Adding dedicated review
vehicles later requires a separate telemetry-classification decision.

The flags are internal server fields, not writable API inputs. Import resolution,
route regeneration, public/unassigned order lists, direct-ID commands, notification
lists, counts, and pagination must preserve the boundary. Do not replace database
query predicates with client-side hiding. Non-DSV Shopify and plugin authentication
remain separate and are not broadened by this change.

## Existing two-stop fixture

Deploy through the existing DSV backend GitHub Actions runbook first. Wait for other
server deployment owners to release their deployment slot. The schema migration
adds flags with false defaults; it does not classify arbitrary existing accounts.

Run `node dist/scripts/isolate-dsv-store-review-data.js` inside the deployed API
container with explicit `STORE_REVIEW_SHOP_ID`, `STORE_REVIEW_DRIVER_ID`, and
`STORE_REVIEW_ACCOUNT_ID`. Do not put credentials in these variables or logs.

1. Run without `--apply`. It checks the exact account/driver and the existing two
   `STORE-REVIEW-SYNTHETIC-` orders, rejects mixed/shared graphs, and prints counts
   plus a fingerprint without credentials or raw customer data.
2. Set `STORE_REVIEW_EXPECTED_FINGERPRINT` to that result and
   `STORE_REVIEW_SNAPSHOT_PATH` to a new absolute private file, then run `--apply`.
   The repair requires an exclusive 0600 snapshot and a serializable transaction.
3. Run dry-run again: `alreadyIsolated` must be true. Confirm ordinary DSV operator
   lists/counts omit the targets, direct-ID commands fail, developer queries retain
   them, and the original review login obtains its own assigned route.
4. Preserve the private snapshot for rollback. It contains only target graph IDs
   and pre-change flags, never password/token material. Restore only those flags
   after checking no subsequent assignments have changed the graph.

Address repair is separate: the original destinations are synthetic addresses and
cannot be reverse-resolved to an intended address. Obtain the intended two places
before changing coordinates. Update canonical destination, order/stop/import
coordinates consistently and regenerate route geometry; retain the no-real-delivery
designation. Do not substitute arbitrary land coordinates or modify real deliveries.
