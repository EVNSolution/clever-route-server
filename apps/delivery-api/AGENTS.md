# AGENTS.md — apps/delivery-api

This package is the CLEVER route server API. Treat Shopify-named modules as
legacy compatibility code, not as the future product boundary.

Rules:
- Keep driver/mobile API contracts backward-compatible unless a migration plan
  says otherwise.
- Add WordPress/WooCommerce source fields additively first; do not destructively
  rename `Shop`, `shopDomain`, or `shopify*` fields in the first migration pass.
- Do not log or commit Shopify tokens, Woo consumer secrets, webhook secrets,
  JWT secrets, DB dumps, proof media, or private evidence.
- Run `npm run prisma:generate`, `npm run lint`, `npm run typecheck`,
  `npm run test`, and `npm run build` before claiming server changes complete.
Deployable boundary:
- `delivery-api` is the backend runtime, API, server-rendered authenticated shell, and Prisma owner.
- Do not build or copy `apps/route-ops-web/dist` into the backend runtime image as the production frontend payload. Consume the separately supplied Route Ops web static artifact through `ROUTE_OPS_WEB_DIST_PATH` and `ROUTE_OPS_WEB_PUBLIC_PATH`.
- Keep frontend SPA styling/component changes in `apps/route-ops-web`; backend route changes should preserve `/admin/ui/app/*` session and `shopDomain` gates.
