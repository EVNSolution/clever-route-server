# Local WooCommerce sandbox

Purpose: run a disposable WordPress/WooCommerce site for CLEVER connector development without production WordPress credentials or customer data.

## Safety boundaries

- Do not put production WordPress credentials in this directory.
- Do not import production DB dumps or raw customer order exports.
- Do not create production WooCommerce webhooks from this sandbox.
- Use synthetic orders only.

## Start

```bash
cd tools/local-woocommerce
docker compose up -d db wordpress
```

Open `http://localhost:8088` and complete the WordPress setup wizard with local-only credentials.

## Install WooCommerce locally

```bash
cd tools/local-woocommerce
docker compose run --rm wp-cli plugin install woocommerce --activate
```

Then in WP admin:

1. Set permalinks to any non-plain structure.
2. Create a WooCommerce REST API key with `Read` permission.
3. Use the local key against `http://localhost:8088/wp-json/wc/v3/orders`.

## REST smoke commands

```bash
WC_CONSUMER_KEY=ck_local WC_CONSUMER_SECRET=cs_local ./scripts/smoke-rest.sh
```

The script only targets the local sandbox URL by default. Override with `WC_BASE_URL` for another disposable local target; do not point it at production WordPress.

## Register a local CLEVER connection

From the server package, source the ignored local `.env` and bootstrap the encrypted DB row:

```bash
cd ../../apps/delivery-api
set -a
source .env
set +a
npm run prisma:migrate:deploy
WOOCOMMERCE_BOOTSTRAP_SHOP_DOMAIN=localhost:8088 \
WOOCOMMERCE_BOOTSTRAP_SITE_URL=http://localhost:8088 \
WOOCOMMERCE_BOOTSTRAP_CONSUMER_KEY=ck_local \
WOOCOMMERCE_BOOTSTRAP_CONSUMER_SECRET=cs_local \
WOOCOMMERCE_BOOTSTRAP_WEBHOOK_SECRET=whsec_local \
WOOCOMMERCE_BOOTSTRAP_LABEL="Local Woo sandbox" \
WOOCOMMERCE_BOOTSTRAP_TIMEZONE=America/Toronto \
npm run woocommerce:connection:bootstrap
```

Use the printed `/woocommerce/webhooks/<connectionId>/orders` path when creating a local WooCommerce webhook.

## Synthetic fixtures

Server-side tests use committed synthetic fixtures under:

```text
apps/delivery-api/tests/fixtures/woocommerce/
```

`seed-orders.example.json` documents the desired sandbox order shapes; it is not a production export.
