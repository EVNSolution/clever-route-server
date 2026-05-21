#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SANDBOX_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
SEED_FILE="${SEED_FILE:-/tmp/seed-orders.example.json}"

cd "$SANDBOX_DIR"

if ! docker compose run --rm wp-cli plugin is-active woocommerce >/dev/null 2>&1; then
  echo "WooCommerce is not active yet. Run ./scripts/setup-sandbox.sh first." >&2
  exit 2
fi

docker compose run --rm \
  -e CLEVER_WC_SEED_FILE="$SEED_FILE" \
  wp-cli eval-file /tmp/clever-scripts/seed-woocommerce-orders.php
