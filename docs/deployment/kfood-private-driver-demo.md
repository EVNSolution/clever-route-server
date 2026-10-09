# Account-only KFood driver demo

Tracking: `EVNSolution/clever-route-server#492`, `EVNSolution/clever-change-control#319`.

This demo uses a separate Shop under the reserved app ID
`clever-route-kfood-private-demo`. Its domain matches the existing KFood domain
because the released driver app selects the KFood completion flow by domain.
The Shop ID and all orders, stops, routes and the driver record are separate from
the normal KFood Shop. No real Shopify order or customer is copied.

## Access boundary

- Set both `KFOOD_PRIVATE_DEMO_SHOP_ID` and `KFOOD_PRIVATE_DEMO_ACCOUNT_ID` to
  reviewed UUIDs in the private runtime environment. Missing or invalid values
  disable driver demo access.
- Only the configured active account can obtain access to its assigned demo
  routes. Existing account/route ownership, token version, publication and
  assignment checks still apply. Legacy driver tokens cannot enter this scope.
- Never register credentials for the reserved app. Shopify session verification
  rejects it even if credentials are accidentally registered. Ordinary Shopify
  and Route Ops requests keep their existing app scope. Shared completion-review
  reports exclude the reserved app.
- The reserved app cannot issue or read a signed map preview URL or a proof-media
  read URL, even when activation settings are missing. The driver retains route
  geometry and authenticated proof upload/completion. Proof previews use the
  device's local captured file; the static map fallback is unavailable.
- These are application access restrictions. Database and infrastructure
  operators necessarily retain maintenance access. Do not place real customer
  data in this demo.

## Release and creation

Run the focused access tests and the disposable PostgreSQL seed tests before
deploying. Verify the exact runtime revision before activating the two settings.
Keep the existing environment backup and previous image reference private.

The seed is dry-run-first and creates only synthetic rows. It requires an active
account and a current official driver session with the required proof capability.
It must not update the account, existing drivers, credentials or real assignments.
The two demo routes cover optional proof with Cash/eTransfer and required
photo/signature. They contain no customer link, email address or telephone number.
Creation must not call a customer notification provider or send Dispatch push.

Inside the verified API runtime, first run the compiled script without `--apply`:

```sh
node dist/scripts/seed-private-driver-demo.js --manifest-file /private/demo-dry-run.json
node dist/scripts/seed-private-driver-demo.js --apply --manifest-file /private/demo-created.json
```

Use a writable private directory and a new file for each invocation. The script
refuses to overwrite evidence files. It validates the exact configuration,
account/session, and reserved tenant before creating data. An unchanged replay
returns `UNCHANGED`; a used or modified demo is refused without resetting it.
The seeded geometry consists of synthetic straight lines. It does not verify road
routing or toll avoidance.

After creation, verify the configured account on the connected official app.
Check other-account denial, normal-admin isolation, signed-media denial and
unchanged real assignments separately from delivery-function checks. Save route
identifiers and device evidence outside Git and public issues.

## Recovery

Before creation, an image rollback uses the normal deployment procedure. After
creation, do not start an older API that lacks the reserved-app restrictions.
Use a forward fix or remove only the verified synthetic scope first. Clearing the
two activation settings blocks driver access but does not replace the permanent
reserved-app admin/media exclusions.

Before removing a used demo, re-read its exact manifest and dependencies. Preserve
private evidence and inspect completion receipts, live-change publications,
tracking and proof-media objects. Delete only rows and objects owned by the demo.
Do not assume a database cascade also removes S3 media. Never change a real
account or assignment to clean up the demo.
