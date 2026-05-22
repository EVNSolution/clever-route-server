# Public docs sanitized review — clever-route.cleversystem.ai/docs

Date: 2026-05-22
Status: approved for the current public `/docs` and `/docs/openapi.yaml` API-contract surface
Scope: `apps/delivery-api/src/routes/api-docs.routes.ts` and `apps/delivery-api/docs/api/openapi.yaml`

## Decision

`/docs` and `/docs/openapi.yaml` may remain public on
`https://clever-route.cleversystem.ai` for the current route-server API-contract
surface because the published material is limited to route shapes, schemas, and
high-level authentication requirements.

This review does **not** approve publication of internal runbooks, real tenant
or customer identifiers, real credentials, screenshots, private support
evidence, deployment details, database dumps, proof-media artifacts, or legal
privacy copy. If those materials are added to `/docs`, the docs route must be
protected before production publication or this review must be replaced.

## Sanitization checks

The current public docs surface must not include:

- real Woo Consumer Keys, Consumer Secrets, webhook secrets, bearer tokens, or
  query-string credential examples;
- private customer, tenant, shop, driver, or order identifiers;
- internal operator runbook commands or credential-handling procedures;
- private URLs, private evidence, screenshots, DB dumps, or proof-media
  artifacts;
- production DNS, AWS, Caddy, certificate, deploy, or private infrastructure
  steps.

The current OpenAPI examples may use documentation-only placeholders such as
`example.com`, `example.myshopify.com`, UUID-shaped example IDs, and generic
bearer-token schema names. Those placeholders are not production secrets or
customer identifiers.

## Revalidation triggers

Re-run this review and the API docs route tests before public exposure if any of
these change:

1. Admin or Woo credential onboarding endpoints are added to the OpenAPI file.
2. Internal runbook content is linked or embedded in `/docs`.
3. Real deployment, credential, customer, tenant, proof-media, or support
   evidence is added to docs content.
4. A future protected `/admin` browser page changes docs authentication or route
   ownership.

If revalidation is not completed, protect `/docs` and `/docs/openapi.yaml` by
default.
