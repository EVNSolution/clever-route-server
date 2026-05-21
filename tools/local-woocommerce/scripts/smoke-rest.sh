#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${WC_BASE_URL:-http://localhost:8088}"
ORDERS_URL="${BASE_URL%/}/wp-json/wc/v3/orders?per_page=1"

if [[ -z "${WC_CONSUMER_KEY:-}" || -z "${WC_CONSUMER_SECRET:-}" ]]; then
  echo "WC_CONSUMER_KEY and WC_CONSUMER_SECRET must be set for the local sandbox REST smoke." >&2
  exit 2
fi

curl -fsS "${BASE_URL%/}/wp-json/" >/dev/null
curl -fsS -u "$WC_CONSUMER_KEY:$WC_CONSUMER_SECRET" "$ORDERS_URL" >/dev/null

echo "Local WooCommerce REST smoke passed for ${BASE_URL%/}."
