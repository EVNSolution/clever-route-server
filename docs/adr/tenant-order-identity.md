# ADR — Tenant and source order identity migration

Date: 2026-05-21
Status: proposed; no schema/code change performed in this Ralph run.

## Context

The current delivery server is reusable for drivers/routes/orders, but the identity model is Shopify-shaped:
- `Shop.shopDomain`
- `Shop.shopifyShopGid`
- `Order.shopifyOrderGid`
- `Order.shopifyOrderLegacyId`
- unique `[shopId, shopifyOrderGid]`
- many driver/admin modules accept or return `shopDomain`
- several validators require `.myshopify.com`

The mobile app is not Shopify-native, but it still consumes server contracts that include `shopDomain` in route/access models.

## Decision

Use an additive migration. Do not destructively rename/remove Shopify fields first.

Introduce a platform-neutral identity layer:

```text
Tenant / Merchant boundary
  internalTenantId -> existing Shop.id initially
  sourcePlatform -> shopify | woocommerce | future
  sourceTenantId/sourceSiteUrl -> external site identity

Order source identity
  sourcePlatform
  sourceOrderId
  sourceOrderNumber
  sourceUpdatedAt
```

## Migration sequence

1. Add code-level `Tenant` boundary while keeping `Shop` table.
2. Add nullable source identity fields or a source mapping table.
3. Backfill Shopify orders:
   - `sourcePlatform = shopify`
   - `sourceOrderId = shopifyOrderGid`
   - `sourceOrderNumber = current order number/name field if available`
   - `sourceUpdatedAt = updatedAtShopify`
4. Add WooCommerce adapter using the same canonical order input.
5. Add uniqueness for non-null source identity only after backfill strategy is tested.
6. Add API aliases instead of breaking mobile/admin contracts:
   - retain `shopDomain` in existing responses,
   - add `tenantDomain`/`siteDomain` later as additive fields,
   - remove `.myshopify.com` validation only at new platform-neutral boundaries.
7. Only after Shopify legacy retirement and data migration validation, consider Prisma/table/column renames.

## Compatibility requirements

- Existing Shopify order sync and webhook tests must keep passing.
- Existing driver app login/assigned route/event/proof media flows must keep passing.
- Woo and Shopify order IDs may overlap numerically, so uniqueness must include source platform.
- Missing Woo delivery date must become explicit `Date pending` with diagnostic reason, not silent failure.

## Rejected alternatives

- Immediate DB rename from `Shop` to `Tenant`: rejected; high Prisma/data migration risk.
- Immediate removal of `shopDomain`: rejected; driver app/server contracts still use it.
- Separate Woo-only server schema: rejected; duplicates routing/driver logic and breaks preservation goal.

## Follow-up implementation tests

- Dual fixture ingestion: same external order number from Shopify and Woo does not collide.
- Legacy Shopify rows load before and after migration.
- New Woo rows map to canonical order fields.
- Driver token/session path works for legacy Shopify tenant and future platform-neutral tenant.
