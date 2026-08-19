# API contract audit runbook

Use this runbook when changing a Delivery API route, a Shopify embedded-app
request helper, or the OpenAPI contract.

## Evidence layers

1. Route tests assert exact request and response envelopes with injected
   dependencies. They are the source for payload-level evidence.
2. `api-docs.routes.test.ts` parses the OpenAPI document and checks the
   app-facing route inventory. It prevents documented contracts from drifting
   away from the registered routes.
3. The Shopify app sends `x-clever-client-request-id` on Delivery API calls. The
   app emits `delivery_api_request`; the server emits
   `shopify_admin_api_surface_request` with the same correlation ID, method,
   matched route, status, and duration.
4. Raw order/customer request and response bodies are intentionally excluded
   from production logs. Exact body assertions belong in tests and sanitized
   temporary evidence, not retained runtime logs.

The correlation ledger covers the BFF-to-Delivery-API boundary without adding a
browser automation dependency or retaining protected customer data. A browser
HAR is still useful for a one-off authenticated iframe investigation, but it is
not the canonical contract artifact.

## Standard verification

```bash
npm test -- api-docs.routes.test.ts shopify-admin-api-surface-logging.test.ts
npm run typecheck
npm run build
npm run prisma:validate
```

Run the Shopify app's full test suite separately to verify its resource routes,
request helpers, stale-response guards, and GraphQL boundaries.

## Guarded PostgreSQL integration verification

The normal test command deliberately skips suites that require destructive
database fixtures. To run those suites, create three isolated local PostgreSQL
containers on their reserved loopback ports and destroy them on exit:

```bash
CLEVER_RUN_DISPOSABLE_DB_TESTS=1 npm run test:db:disposable
```

The runner refuses to start without the explicit flag. Each test keeps its
existing target-class and exact-URL guard. The command never connects to a
remote host and never reuses the production/evidence database URLs.

Use `npm run test:db:disposable -- --plan` to inspect the local ports and
database names without creating containers.
