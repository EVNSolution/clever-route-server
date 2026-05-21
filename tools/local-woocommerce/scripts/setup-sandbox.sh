#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SANDBOX_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

WP_URL="${WP_URL:-http://localhost:8088}"
WP_TITLE="${WP_TITLE:-CLEVER Local WooCommerce}"
WP_ADMIN_USER="${WP_ADMIN_USER:-admin}"
WP_ADMIN_PASSWORD="${WP_ADMIN_PASSWORD:-password}"
WP_ADMIN_EMAIL="${WP_ADMIN_EMAIL:-admin@example.test}"

cd "$SANDBOX_DIR"

echo "Starting local WordPress/WooCommerce sandbox..."
docker compose up -d db wordpress

echo "Waiting for WordPress files and database..."
ready=0
for _ in {1..60}; do
  if docker compose run --rm wp-cli core version >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 2
done

if [[ "$ready" != "1" ]]; then
  echo "WordPress CLI did not become ready in time." >&2
  exit 1
fi

if docker compose run --rm wp-cli core is-installed >/dev/null 2>&1; then
  echo "WordPress is already installed."
else
  echo "Installing WordPress at ${WP_URL}..."
  docker compose run --rm wp-cli core install \
    --url="$WP_URL" \
    --title="$WP_TITLE" \
    --admin_user="$WP_ADMIN_USER" \
    --admin_password="$WP_ADMIN_PASSWORD" \
    --admin_email="$WP_ADMIN_EMAIL" \
    --skip-email
fi

echo "Installing/activating WooCommerce..."
if docker compose run --rm wp-cli plugin is-installed woocommerce >/dev/null 2>&1; then
  docker compose run --rm wp-cli plugin activate woocommerce >/dev/null
else
  docker compose run --rm wp-cli plugin install woocommerce --activate
fi

echo "Configuring local permalinks..."
docker compose run --rm wp-cli rewrite structure '/%postname%/' --hard >/dev/null
docker compose run --rm wp-cli rewrite flush --hard >/dev/null

echo "Local WordPress/WooCommerce sandbox is ready at ${WP_URL}."
