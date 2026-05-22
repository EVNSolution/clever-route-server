# ADR — Woo credential onboarding auth, tenant, and frontend gates

Date: 2026-05-22
Status: accepted for MVP execution gate

## Context

The WooCommerce credential onboarding plan moves secret entry from an
ops-only bootstrap script to a CLEVER-owned admin/API flow. The server already
has `Shop`/`CommerceConnection` ownership, encrypted Woo credential storage, a
Woo webhook endpoint, and server-side Woo REST backfill.

The repository currently has no dedicated CLEVER Admin frontend app. The only
app package under `apps/` is `apps/delivery-api`. The product direction has now
been narrowed to the existing route-server host, `clever-route.cleversystem.ai`;
do not introduce a separate `admin.cleversystem.ai` or standalone CLEVER Admin
Web surface for this lane. There are also existing uncommitted WordPress
connector/plugin changes in the working tree, including shared server files that
future onboarding work may also touch.

## Decision

For the MVP implementation lane:

1. **Tenant model:** use existing `Shop.id` / `shopId` as the tenant boundary.
   Do not introduce a new `Company` or `Tenant` table in this delivery unless a
   separate account-hierarchy requirement is approved.
2. **Actor/auth model:** credential collection is internal-operator-only for
   this repo's MVP API contract. Public or customer self-service credential
   collection is forbidden until a customer-admin identity/session model is
   designed.
3. **Admin route authorization:** admin credential routes must have an explicit
   server-side admin auth gate before they are enabled. They must not rely on
   Shopify session auth as proof of authority for Woo credential management.
   A narrow internal admin bearer token/JWT guard is acceptable for the
   API-contract MVP if it resolves an actor and tenant scope and is covered by
   tests.
4. **Frontend/domain placement:** this lane is limited to
   `https://clever-route.cleversystem.ai` and its server-owned subroutes.
   Do not create a separate CLEVER Admin Web domain/app. If operator/customer
   pages are added later, they must live on this route-server surface (for
   example a protected `/admin/...` page backed by the existing `/admin/...`
   API contract) unless a newer ADR explicitly overrides this.
5. **Public policy placement:** public privacy-policy links should migrate to
   the same route-server host, with `/privacy-policy` redirecting to `/privacy`.
6. **Webhook setup:** the server generates a strong webhook secret and returns
   it one time with the delivery URL. Woo webhook creation remains manual for
   MVP. Automatic webhook creation is deferred until required Woo permissions
   and customer consent are approved.
7. **Dirty-tree protection:** onboarding implementation must preserve existing
   uncommitted WordPress connector/plugin changes. Shared files must be edited
   additively and reviewed against the dirty-tree assessment before changes are
   checkpointed.

## Consequences

- Backend/API work can proceed after recording a dirty-tree conflict
  assessment.
- No separate Admin Web app/domain is part of the current plan. Future UI work
  must remain under `clever-route.cleversystem.ai` subroutes unless a newer ADR
  changes the domain strategy.
- Public privacy-policy publication can be prepared in this repo because it is
  route-server-owned and does not require a separate frontend app.
- Multi-company semantics are represented by existing shop/connection scoping
  for now: one `Shop` can own one or more `CommerceConnection` rows, uniquely
  keyed by `[shopId, platform, siteUrl]`.
- A future customer-facing self-service UI still needs a follow-up ADR for
  identity, permissions, audit visibility, and protected `/admin/...` page
  ownership, but not a new public Admin Web domain by default.

## Rejected alternatives

- **Immediate `Company/Tenant` schema introduction:** rejected for MVP because
  current orders, routes, drivers, and commerce connections already depend on
  `Shop.id`, and the account hierarchy is not yet explicit.
- **WP plugin as credential entry surface:** rejected for this lane because it
  expands the plugin security role and fragments support.
- **Unauthenticated/public credential collection:** rejected as unsafe.
- **Automatic Woo webhook creation in MVP:** rejected because it may require
  broader Woo permissions and explicit consent.

## Verification requirements

- Tests must prove admin credential routes reject unauthenticated requests and
  out-of-scope tenant access.
- Tests must prove safe DTOs never include raw credential values.
- If a frontend app is later selected, UI evidence must prove write-only secret
  inputs, no secret hydration, no browser storage, and no raw secret display
  after refresh/error/rotation flows.
