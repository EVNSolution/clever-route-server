# AGENTS.md — apps/route-ops-web

This package is the CLEVER Route Ops frontend SPA. It owns React/Vite/TypeScript UI code, MapLibre/PMTiles frontend behavior, styles, frontend tests, and the separately published static web artifact.

Rules:
- Keep `apps/delivery-api` as the backend API/auth/session owner; do not move server auth or `shopDomain` enforcement into the SPA without an approved backend-auth replacement plan.
- Do not import from or edit `../05_CLEVER_Shopify/shopify-clever` as implementation code. Shopify is reference-only unless explicitly scoped.
- Keep frontend and backend deployable identities separate. Frontend publish changes should produce or reference the `route-ops-web-static` artifact/image, not hide the SPA inside the backend runtime image.
- Preserve the existing visual system unless the user explicitly asks for a new design system.

Expected verification for frontend changes:

```bash
npm --prefix apps/route-ops-web run lint
npm --prefix apps/route-ops-web run typecheck
npm --prefix apps/route-ops-web run test
npm --prefix apps/route-ops-web run build
```
