#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SANDBOX_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
OUTPUT_FILE="${OUTPUT_FILE:-${SANDBOX_DIR}/.env.generated}"
WP_URL="${WP_URL:-http://localhost:8088}"
WC_KEY_DESCRIPTION="${WC_KEY_DESCRIPTION:-CLEVER local sandbox key}"
WC_KEY_USER="${WC_KEY_USER:-admin}"
WC_KEY_PERMISSIONS="${WC_KEY_PERMISSIONS:-read_write}"

cd "$SANDBOX_DIR"

if ! docker compose run --rm wp-cli core is-installed >/dev/null 2>&1; then
  echo "WordPress is not installed yet. Run ./scripts/setup-sandbox.sh first." >&2
  exit 2
fi

mkdir -p "$(dirname "$OUTPUT_FILE")"

docker compose run --rm \
  -e CLEVER_WC_KEY_DESCRIPTION="$WC_KEY_DESCRIPTION" \
  -e CLEVER_WC_KEY_USER="$WC_KEY_USER" \
  -e CLEVER_WC_KEY_PERMISSIONS="$WC_KEY_PERMISSIONS" \
  -e CLEVER_WC_BASE_URL="$WP_URL" \
  wp-cli eval-file /tmp/clever-scripts/create-woocommerce-rest-key.php > "$OUTPUT_FILE"

chmod 0600 "$OUTPUT_FILE"

echo "Wrote local WooCommerce REST credentials to ${OUTPUT_FILE}."
echo "This file is ignored by git."
