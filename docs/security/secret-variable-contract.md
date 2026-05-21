# CLEVER Route secret variable contract

This document defines where required secrets live for the multi-tenant CLEVER Route server.
Do not store real secret values in git, GitHub issues, PRs, screenshots, or proof artifacts.

## Server-held environment secrets

These variables are maintained by the server runtime environment (`apps/delivery-api/.env` for local development, `infra/env/delivery-api.env` or the host secret store for deployment).

| Variable | Required when | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | always | Prisma/PostgreSQL connection string. Treat as secret because it contains DB credentials. |
| `POSTGRES_PASSWORD` | compose-managed Postgres | PostgreSQL user password used to build `DATABASE_URL`. |
| `JWT_SECRET` | driver/mobile APIs enabled | Signs and verifies driver session tokens. |
| `CREDENTIAL_ENCRYPTION_KEY` | any DB-stored connector credential exists | 32-byte AES-GCM master key used to encrypt/decrypt customer connector secrets stored in DB. |
| `DRIVER_PROOF_MEDIA_S3_SECRET_ACCESS_KEY` | S3 proof-media backend enabled | S3-compatible storage secret access key. |
| `DRIVER_PROOF_MEDIA_S3_SESSION_TOKEN` | temporary S3 credentials used | Optional temporary S3 session token. |
| `DRIVER_PROOF_MEDIA_SCANNER_BEARER_TOKEN` | scanner backend enabled | Optional malware scanner bearer token. |
| `DRIVER_PROOF_MEDIA_SCAN_MONITOR_BEARER_TOKEN` | scan-monitor backend enabled | Optional scan monitor bearer token. |
| `SHOPIFY_API_SECRET` | legacy Shopify auth compatibility enabled | Legacy Shopify app OAuth secret. Keep unset for Woo-first runtime unless compatibility is needed. |
| `SHOPIFY_WEBHOOK_SECRET` | legacy Shopify webhook compatibility enabled | Legacy Shopify webhook HMAC secret. |
| `SHOPIFY_TOKEN_ENCRYPTION_KEY` | legacy Shopify token storage enabled before migration | Existing Shopify-token encryption key. New generic connector storage should use `CREDENTIAL_ENCRYPTION_KEY`. |

### `CREDENTIAL_ENCRYPTION_KEY` format

Use a 32-byte key encoded as one of the existing supported formats:

```text
CREDENTIAL_ENCRYPTION_KEY=base64:<base64-encoded-32-byte-key>
```

Example generation command; do not commit the output:

```bash
node -e "console.log('base64:' + require('crypto').randomBytes(32).toString('base64'))"
```

## Customer connector secrets

Customer-specific commerce credentials do **not** belong in shared `.env` files for the product runtime.
They must be encrypted into DB rows with `CREDENTIAL_ENCRYPTION_KEY`.

Recommended DB field names for the WooCommerce connector credential store:

| DB field | Secret value |
| --- | --- |
| `consumerKeyCiphertext` | WooCommerce REST consumer key |
| `consumerSecretCiphertext` | WooCommerce REST consumer secret |
| `webhookSecretCiphertext` | WooCommerce webhook secret |

Recommended AAD strings:

```text
woocommerce:consumer-key:<connectionId>
woocommerce:consumer-secret:<connectionId>
woocommerce:webhook-secret:<connectionId>
```

## Temporary local proof only

`apps/delivery-api/.env.woocommerce.local` may exist on a developer machine for one-off read-only payload discovery.
It is ignored by git and must not become the multi-tenant product credential store.
