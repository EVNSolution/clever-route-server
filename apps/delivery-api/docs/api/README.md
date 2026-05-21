# API documentation storage strategy

This directory is the service-local source of truth for HTTP contracts owned by
the CLEVER route server delivery API.

## Artifact layout

| Artifact | Role |
| --- | --- |
| `docs/api/openapi.yaml` | Machine-readable OpenAPI contract served at `/docs/openapi.yaml`. |
| `docs/api/*.md` | Human-readable behavior notes, examples, persistence model, and rollout caveats. |
| package `README.md` | Quick-start and high-level readiness summary only. |

Generated HTML, copied Swagger UI bundles, Postman collections, and SDK stubs are
not source artifacts. Generate them into temporary/release evidence workspaces
when needed.

## Deployed web addresses

Future main route server target:

- Swagger UI: `https://clever-route.cleversystem.ai/docs`
- Raw OpenAPI YAML: `https://clever-route.cleversystem.ai/docs/openapi.yaml`

Do not treat raw EIP or `sslip.io` hostnames as the normal integration contract.

## Consumer map

| Consumer | Contract surface | Auth boundary | Human docs |
| --- | --- | --- | --- |
| Current admin clients | `/admin/orders*`, `/admin/drivers*`, `/admin/route-plans*` | Current admin session-token verifier while legacy Shopify admin is retained | `shopify-and-admin-api.md`, `admin-route-plans.md` |
| Legacy Shopify compatibility | `/shopify/auth/token-exchange`, `/shopify/webhooks` | Shopify session token or webhook HMAC | `shopify-and-admin-api.md` |
| Native driver app | `/driver/route-access/lookup`, `/driver/consents`, `/driver/assigned-route`, `/driver/proof-media*`, `/driver/events` | Phone/invite flow followed by short-lived server-issued driver JWT | `driver-route-access.md`, `driver-consents.md`, `driver-assigned-route.md`, `driver-proof-media.md` |
| Operations / deployment monitors | `/healthz`, `/readyz`, `/docs` | None in current local contract | `openapi.yaml`, deployment docs |

## Source-of-truth rules

1. Runtime behavior is implemented in `src/routes/*.routes.ts` and verified by
   tests in `tests/*.routes.test.ts`.
2. `docs/api/openapi.yaml` is the canonical review artifact for method, path,
   auth, request body, parameters, status codes, and response envelopes.
3. Markdown files are the canonical review artifact for semantics: persistence,
   minimization, compliance notes, rollout caveats, and cross-consumer flow.
4. When code, OpenAPI, and Markdown disagree, treat code/tests as current
   behavior and fix docs before marking the change complete.
5. Do not store real shop domains, access tokens, driver phones, proof images,
   object-storage keys, customer data, Woo secrets, or Shopify tokens in docs.

## Update checklist for API changes

- [ ] Update route implementation and nearest route tests.
- [ ] Update `docs/api/openapi.yaml`.
- [ ] Update matching Markdown behavior notes.
- [ ] Keep driver-app consumed responses backward-compatible or document the
      mobile migration.
- [ ] Run lint/typecheck/tests/build before completion.
