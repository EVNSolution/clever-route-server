# Staging Release Checklist — Woo Credential Onboarding and Same-Host Policy

Date: 2026-05-22
Scope: `https://clever-route.cleversystem.ai` route-server only.

This checklist executes the approved release-readiness plan from the workspace OMX artifacts:

- `.omx/plans/ralplan-release-commit-env-staging-woo-rehearsal.md`
- `.omx/plans/test-spec-release-commit-env-staging-woo-rehearsal.md`

The `.omx` artifacts live at the workspace level and are not part of this Git repository. This document is the repository-local operational checklist.

## Hard boundaries

- Do not deploy or test with real Woo credentials until local verification and staging smoke checks pass.
- Do not print or commit `CLEVER_ADMIN_API_TOKEN`, `CREDENTIAL_ENCRYPTION_KEY`, Woo REST keys/secrets, or webhook secrets.
- Do not make final privacy/legal publication claims until `PRIVACY_CONTACT_EMAIL` is confirmed as an official business/privacy contact.
- Do not start protected browser `/admin` pages in this release. `/admin/commerce-connections/woocommerce` remains a protected JSON API surface.
- Do not introduce `admin.cleversystem.ai`, `apps/admin-web`, or a separate CLEVER Admin Web.

## Required environment confirmation

Confirm these names exist in the staging/server secret configuration without writing their values into tickets, Git, docs, shell history, or logs.

| Variable | Required value or shape | Notes |
| --- | --- | --- |
| `DELIVERY_API_PUBLIC_URL` | `https://clever-route.cleversystem.ai` | canonical public URL for webhook setup data |
| `PRIVACY_CONTACT_EMAIL` | official business/privacy email | if unset, privacy page must keep pending contact wording |
| `CLEVER_ADMIN_API_TOKEN` | high-entropy internal operator token | protects Woo onboarding admin API |
| `CREDENTIAL_ENCRYPTION_KEY` | valid application encryption key | required before storing Woo credentials |

Woo REST credentials are entered per customer/company/site through the protected admin API and stored encrypted. They do not belong in shared environment files.

## Local release gate

Run from the repository root:

```bash
git status --short
git diff --check
npm --prefix apps/delivery-api run prisma:generate
npm --prefix apps/delivery-api run prisma:validate
npm --prefix apps/delivery-api run lint
npm --prefix apps/delivery-api run typecheck
npm --prefix apps/delivery-api run test
npm --prefix apps/delivery-api run build
```

For local compose syntax validation only, create `infra/env/delivery-api.env` from the example or a local secret manager source, run the config check, then remove the local placeholder if it was copied from the example:

```bash
cp infra/env/delivery-api.env.example infra/env/delivery-api.env
npm run compose:config
rm -f infra/env/delivery-api.env
```

`infra/env/*.env` is ignored by Git. Never commit a real server env file.

## DB migration order

After staging DB backup/snapshot per ops policy:

1. Apply `apps/delivery-api/prisma/migrations/20260522013000_add_wordpress_plugin_access/`.
   - This is a prerequisite schema slice for freshness/plugin access tables and watermarks.
2. Apply `apps/delivery-api/prisma/migrations/20260522043000_add_woocommerce_onboarding_admin/`.
3. Run Prisma generate/validate against the deployed schema.
4. Confirm no drift and that the app boots.

Stop if the first migration is not intended for the release; split or supersede the schema path before applying the second migration.

## Same-host route smoke checks

Use only `https://clever-route.cleversystem.ai`.

```bash
curl -fsS https://clever-route.cleversystem.ai/healthz
curl -fsS https://clever-route.cleversystem.ai/readyz
curl -fsS https://clever-route.cleversystem.ai/privacy
curl -fsSI https://clever-route.cleversystem.ai/privacy-policy
curl -fsS https://clever-route.cleversystem.ai/docs >/tmp/clever-route-docs.html
curl -fsS https://clever-route.cleversystem.ai/docs/openapi.yaml >/tmp/clever-route-openapi.yaml
```

Expected:

- `/privacy-policy` redirects to `/privacy`.
- `/privacy` contains no personal email and only shows the official contact when configured.
- `/docs` and `/docs/openapi.yaml` stay public only while the sanitized public-docs review remains valid.

## Admin API smoke checks

Unauthenticated request must fail with a 401/403-class response and no secret echo:

```bash
curl -sS -o /tmp/woo-test-unauth.json -w '%{http_code}' \
  -X POST https://clever-route.cleversystem.ai/admin/commerce-connections/woocommerce/test \
  -H 'content-type: application/json' \
  --data '{"siteUrl":"https://example.invalid","consumerKey":"placeholder_consumer_key","consumerSecret":"placeholder_consumer_secret"}'
```

Authenticated staging requests may use only controlled test/sandbox credentials. Do not print the admin token or Woo credentials in logs or copied evidence.

Required authenticated smoke checks:

- test Woo credentials against a controlled site;
- create/update one Woo connection;
- list connection metadata;
- rotate webhook secret if needed;
- verify responses contain only safe metadata and one-time setup values where explicitly intended.

## Webhook smoke checks

1. Send an invalid-signature payload to `/woocommerce/webhooks/:connectionId/orders`; expect rejection.
2. Send a valid signed controlled payload for a staging connection; expect success.
3. Confirm logs do not expose Woo REST keys, webhook secret, admin token, encryption key, or customer PII.

## Completion evidence

Record only redacted evidence:

- commit hashes included in the release;
- verification commands and pass/fail status;
- migration order/result;
- route smoke status codes;
- admin API auth rejection and controlled success result;
- webhook invalid/valid signature result;
- explicit no-secret-leak statement;
- remaining risks or blockers.
