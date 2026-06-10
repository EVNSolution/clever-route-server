# EC2 + PostgreSQL deployment readiness

This package can run as the API container in the delivery-only CLEVER route
server compose stack. The initial production shape is expected to be one EC2
instance with Docker Compose, Caddy, and PostgreSQL storage, then a later RDS
migration if operational load requires it.

## Runtime units

- API: `clever-route-server` delivery API container
- Database: PostgreSQL 17 container running on the same EC2 instance
- Ingress: Caddy serving `https://clever-route.cleversystem.ai`
- Storage: EBS mounted on the EC2 host and exposed to containers through
  `/srv/clever-route-server/data/*` bind mounts
- Health checks: `GET /healthz`, `GET /readyz`

## Required environment

Use `infra/env/delivery-api.env.example` from the repository root as the compose
runtime template. Minimum values:

```env
DELIVERY_API_PUBLIC_URL=https://clever-route.cleversystem.ai
PRIVACY_CONTACT_EMAIL=chase@evnsolution.com
CLEVER_ADMIN_ALLOWED_SHOP_DOMAINS=<comma-separated-shop-domains>
DATABASE_URL=postgresql://clever:<password>@postgres:5432/clever_route
POSTGRES_DB=clever_route
POSTGRES_USER=clever
POSTGRES_PASSWORD=<strong-password>
JWT_SECRET=<strong-driver-api-secret>
CREDENTIAL_ENCRYPTION_KEY=<base64-or-hex-32-byte-key>
CLEVER_ADMIN_API_TOKEN=<strong-internal-admin-token>
CLEVER_ADMIN_WEB_LOGIN_SECRET=<strong-browser-admin-login-secret>
CLEVER_ADMIN_WEB_SESSION_SECRET=<strong-browser-admin-session-secret>
DRIVER_PROOF_MEDIA_STORAGE_BACKEND=local
DRIVER_PROOF_MEDIA_STORAGE_DIR=/app/var/driver-proof-media
```

Use explicit customer-owned WooCommerce hostnames in
`CLEVER_ADMIN_ALLOWED_SHOP_DOMAINS` before enabling admin onboarding. Leaving it
blank fails closed. A wildcard (`*`) is acceptable only for a deliberate,
reviewed compatibility exception during a controlled test.

Optional legacy Shopify compatibility values (`SHOPIFY_API_KEY`,
`SHOPIFY_API_SECRET`, `SHOPIFY_TOKEN_ENCRYPTION_KEY`, etc.) should remain unset
for the WordPress/Woo main runtime unless a rollback/compatibility path needs
those routes enabled.

Never commit real `.env` files, DB passwords, JWT secrets, Shopify credentials,
Woo credentials, webhook secrets, proof media, or private evidence.

## Same-host Woo credential admin UI

When `CLEVER_ADMIN_WEB_LOGIN_SECRET` and `CLEVER_ADMIN_WEB_SESSION_SECRET` are
set, the API exposes the browser-only Woo onboarding UI at:

```text
https://clever-route.cleversystem.ai/admin/ui/commerce-connections/woocommerce
```

The browser login secret is intentionally separate from `CLEVER_ADMIN_API_TOKEN`.
The JSON API bearer token must not be entered into the browser UI. UI sessions
use an `HttpOnly` same-site cookie and CSRF-protected multipart forms. Customer
WooCommerce Consumer Key, Consumer Secret, and webhook secret are submitted
through the page and stored encrypted in DB connector rows; saved secrets are
not shown again after submission.

In production, the UI is registered only when `DELIVERY_API_PUBLIC_URL` is set
alongside both dedicated admin web secrets. Before broad customer onboarding,
add an outer access gate for `/admin/ui/*` at the ingress layer (for example
VPN, private allowlist, or equivalent Caddy policy) and keep `/docs` exposure
under the existing sanitized-docs review.

## Compose config check

From the repo root:

```bash
cp infra/env/delivery-api.env.example infra/env/delivery-api.env
docker compose -f infra/compose/docker-compose.prod.yml config --quiet
rm -f infra/env/delivery-api.env
```

## EC2 host outline

1. Provision the approved main route server EC2/EIP only after change-control
   and AWS inventory are complete.
2. Attach and mount the EBS volume at `/srv/clever-route-server`, then create:
   - `/srv/clever-route-server/data/postgres`
   - `/srv/clever-route-server/data/postgres-backups`
   - `/srv/clever-route-server/data/driver-proof-media`
   - `/srv/clever-route-server/infra/env`
3. Install Docker Engine and the Compose plugin.
4. Place runtime env at `/srv/clever-route-server/infra/env/delivery-api.env` or
   the host path selected by the deploy runbook.
5. Start the delivery-only compose stack. The first compose start creates the
   PostgreSQL database under the EBS-backed bind mount if it does not already
   exist.
6. Verify `/healthz`, `/readyz`, Caddy TLS, and DNS for
   `clever-route.cleversystem.ai` before mobile/webhook cutover.

## Backup and restore

Use `scripts/postgres-backup.sh` and `scripts/postgres-restore.sh` with an
explicit `DATABASE_URL`. Restore is destructive to the selected target database;
do not run restore against production without verifying the target DB and backup
file.

## Current gaps

- This bootstrap does not create or mutate AWS resources.
- CI validates build/test/compose config only; it does not deploy production.
- WordPress/WooCommerce credentials and webhook permissions are still pending.
