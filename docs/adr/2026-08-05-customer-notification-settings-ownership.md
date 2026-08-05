# ADR — Customer Notification settings ownership

Date: 2026-08-05
Status: accepted for implementation
Change control: EVNSolution/clever-change-control#248

## Context

The delivery API already owns `customerEmailSettings`, customer-email rendering,
provider transport, route recipient history, and the automatic notification
outbox. Route Ops also has an older `emailNotifications` settings block with a
separate template and reminder plans. The Shopify embedded app already exposes
Customer Notifications branding, raster logo upload, preview, and test-send
controls from changes #243 through #245.

Keeping two editable content stores would make preview, manual delivery, and
future automatic delivery drift. The Shopify app is explicitly in scope for the
merchant-facing settings and Route Detail workflow, while Shopify order and
customer source data remains read-only.

## Decision

1. The delivery API is the canonical settings, token-document, render,
   readiness, preview, idempotency, audit, and send boundary.
2. The Shopify embedded app owns the merchant-facing Customer Notification
   settings and Route Detail recipient/preview/manual-send experience through
   authenticated delivery API BFF calls.
3. Route Ops owns operational timing and trigger rules only. In particular,
   `nearbyStopsThreshold` moves to Route Ops operational settings as the V3
   authority; older customer-email settings remain compatibility-readable
   during migration.
4. Existing Route Ops template content is not silently promoted or merged.
   `customerEmailSettings` remains authoritative unless a merchant explicitly
   imports and saves legacy content.
5. The Shopify app does not add Admin GraphQL `email` or `customer` fields in
   this lane. Recipient eligibility and exact addresses come from the delivery
   API canonical order/preview contract. Missing addresses remain ineligible.
6. Existing #243-#245 behavior is preserved: safe branded HTML, raster logo
   upload, draft test sends, and the simplified subject/body/divider/boxed
   business-card footer. Removed color, preview-text, and logo-alt controls are
   not reintroduced.
7. Automatic delivery remains OFF by default. Making activation available
   requires versioned consent, readiness, renderer parity, idempotency, retry,
   and kill-switch verification. This ADR does not authorize activation,
   external email delivery, production deployment, or Shopify Dashboard
   changes.

## Consequences

- Both repositories require coordinated, isolated worktrees and compatible DTO
  rollout.
- Route Ops keeps reminder plans and trigger controls but no longer edits email
  subject/body content after the ownership cutover.
- Shopify-origin orders without a canonical delivery API email cannot be sent
  through this feature. Expanding Shopify protected-customer-data access needs
  separate approval, field-map/privacy updates, and Dashboard work.
- Preview, test, manual, and future automatic delivery must consume one
  canonical render result.

## Verification requirements

- Static tests prove no Shopify email/customer GraphQL field or customer/order
  mutation is added.
- Migration tests prove V1/V2 compatibility and single-writer ownership for
  templates and `nearbyStopsThreshold`.
- All send-path tests use fake transport; no real provider call is permitted.
- Contract tests prove missing canonical email is ineligible and cannot fall
  back to guessed or newly queried Shopify data.
