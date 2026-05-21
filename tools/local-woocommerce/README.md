# Local WooCommerce sandbox

Purpose: run a disposable WordPress/WooCommerce site for CLEVER connector development without production WordPress credentials or customer data.

This is a **repo-local Docker scaffold**, not a globally installed WordPress/WooCommerce tool. It is safe to reset and is intended for synthetic development data only.

## Safety boundaries

- Do not put production WordPress credentials in this directory.
- Do not import production DB dumps or raw customer order exports.
- Do not create production WooCommerce webhooks from this sandbox.
- Use synthetic orders only.
- Keep generated files such as `.env.generated` local and ignored by git.

## Fast path: one-command local setup

```bash
cd tools/local-woocommerce
./scripts/bootstrap-sandbox.sh
```

The bootstrap command:

1. Starts local MariaDB + WordPress.
2. Installs WordPress if needed.
3. Installs/activates WooCommerce.
4. Configures non-plain permalinks.
5. Creates a local WooCommerce REST API key.
6. Writes the generated key to ignored `.env.generated`.
7. Seeds synthetic WooCommerce orders from `seed-orders.example.json`.
8. Runs a REST smoke check against `http://localhost:8088`.

Default local admin credentials created by the script:

```text
URL:      http://localhost:8088
User:     admin
Password: password
Email:    admin@example.test
```

These are local-only defaults. Override with `WP_ADMIN_USER`, `WP_ADMIN_PASSWORD`, and `WP_ADMIN_EMAIL` when needed.

## Manual start

```bash
cd tools/local-woocommerce
docker compose up -d db wordpress
```

Open `http://localhost:8088` and complete the WordPress setup wizard with local-only credentials, or use the setup script below.

## Install and configure WordPress/WooCommerce locally

```bash
cd tools/local-woocommerce
./scripts/setup-sandbox.sh
```

This script is idempotent for local use. It does not contact production WordPress.

## Create a local WooCommerce REST API key

```bash
cd tools/local-woocommerce
./scripts/create-rest-key.sh
```

The generated key is saved to:

```text
tools/local-woocommerce/.env.generated
```

That file is ignored by git. To inspect only the safe variable names:

```bash
cut -d= -f1 .env.generated
```

## Seed synthetic orders

```bash
cd tools/local-woocommerce
./scripts/seed-orders.sh
```

The seeder reads `seed-orders.example.json` and writes local-only WooCommerce orders with delivery metadata such as `delivery_date` and `delivery_area`.

## REST smoke commands

After creating `.env.generated`:

```bash
cd tools/local-woocommerce
./scripts/smoke-rest.sh
```

Or pass credentials explicitly:

```bash
WC_CONSUMER_KEY=ck_local WC_CONSUMER_SECRET=cs_local ./scripts/smoke-rest.sh
```

The script only targets the local sandbox URL by default. Override with `WC_BASE_URL` for another disposable local target; set `ALLOW_NON_LOCAL_WC_BASE_URL=1` if you intentionally test a non-local disposable target. Do not point it at production WordPress.

For `http://localhost`, the smoke script signs the request with WooCommerce OAuth 1.0a because WooCommerce only performs Basic Auth on SSL requests. For `https://` targets, it uses Basic Auth.

## Register a local CLEVER connection

From the server package, source the ignored local `.env` and bootstrap the encrypted DB row:

```bash
cd ../../apps/delivery-api
set -a
source .env
set +a
npm run prisma:migrate:deploy
set -a
source ../../tools/local-woocommerce/.env.generated
set +a
WOOCOMMERCE_BOOTSTRAP_SHOP_DOMAIN=localhost:8088 \
WOOCOMMERCE_BOOTSTRAP_SITE_URL=http://localhost:8088 \
WOOCOMMERCE_BOOTSTRAP_WEBHOOK_SECRET=whsec_local \
WOOCOMMERCE_BOOTSTRAP_LABEL="Local Woo sandbox" \
WOOCOMMERCE_BOOTSTRAP_TIMEZONE=America/Toronto \
npm run woocommerce:connection:bootstrap
```

Use the printed `/woocommerce/webhooks/<connectionId>/orders` path when creating a local WooCommerce webhook.

## Useful WP-CLI / WC-CLI commands

All commands run through the `wp-cli` container:

```bash
cd tools/local-woocommerce

docker compose run --rm wp-cli plugin list
docker compose run --rm wp-cli option get permalink_structure
docker compose run --rm wp-cli wc --info
docker compose run --rm wp-cli wc shop_order list --user=admin --field=id
```

## Reset everything

This deletes the local WordPress and MariaDB volumes.

```bash
cd tools/local-woocommerce
docker compose down -v
rm -f .env.generated
```

## Synthetic fixtures

Server-side tests use committed synthetic fixtures under:

```text
apps/delivery-api/tests/fixtures/woocommerce/
```

`seed-orders.example.json` documents the desired sandbox order shapes; it is not a production export.
