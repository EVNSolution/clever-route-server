# EC2 + PostgreSQL deployment readiness

This package can run as the API container in the delivery-only CLEVER route
server compose stack. The initial production shape is expected to be one EC2
instance with Docker Compose, Caddy, and PostgreSQL storage, then a later RDS
migration if operational load requires it.

## Runtime units

- API: `clever-route-server` delivery API container
- Database: PostgreSQL 17 container
- Ingress: Caddy serving `https://clever-route.cleversystem.ai`
- Health checks: `GET /healthz`, `GET /readyz`

## Required environment

Use `infra/env/delivery-api.env.example` from the repository root as the compose
runtime template. Minimum values:

```env
DATABASE_URL=postgresql://clever:<password>@postgres:5432/clever_route
POSTGRES_DB=clever_route
POSTGRES_USER=clever
POSTGRES_PASSWORD=<strong-password>
JWT_SECRET=<strong-driver-api-secret>
```

Optional legacy Shopify compatibility values (`SHOPIFY_API_KEY`,
`SHOPIFY_API_SECRET`, `SHOPIFY_TOKEN_ENCRYPTION_KEY`, etc.) should remain unset
for the WordPress/Woo main runtime unless a rollback/compatibility path needs
those routes enabled.

Never commit real `.env` files, DB passwords, JWT secrets, Shopify credentials,
Woo credentials, webhook secrets, proof media, or private evidence.

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
2. Install Docker Engine and the Compose plugin.
3. Place runtime env at `/srv/clever-route-server/infra/env/delivery-api.env` or
   the host path selected by the deploy runbook.
4. Start the delivery-only compose stack.
5. Verify `/healthz`, `/readyz`, Caddy TLS, and DNS for
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
