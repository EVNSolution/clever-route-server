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
