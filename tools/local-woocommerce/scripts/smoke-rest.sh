#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SANDBOX_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
GENERATED_ENV="${GENERATED_ENV:-${SANDBOX_DIR}/.env.generated}"

if [[ -f "$GENERATED_ENV" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$GENERATED_ENV"
  set +a
fi

BASE_URL="${WC_BASE_URL:-http://localhost:8088}"
ORDERS_URL="${BASE_URL%/}/wp-json/wc/v3/orders?per_page=1"

case "$BASE_URL" in
  http://localhost:*|http://127.0.0.1:*|http://0.0.0.0:*) ;;
  *)
    if [[ "${ALLOW_NON_LOCAL_WC_BASE_URL:-}" != "1" ]]; then
      echo "Refusing to smoke-test non-local WooCommerce URL without ALLOW_NON_LOCAL_WC_BASE_URL=1: ${BASE_URL}" >&2
      exit 2
    fi
    ;;
esac

if [[ -z "${WC_CONSUMER_KEY:-}" || -z "${WC_CONSUMER_SECRET:-}" ]]; then
  echo "WC_CONSUMER_KEY and WC_CONSUMER_SECRET must be set for the local sandbox REST smoke." >&2
  echo "Run ./scripts/create-rest-key.sh first, or pass the variables explicitly." >&2
  exit 2
fi

curl -fsS "${BASE_URL%/}/wp-json/" >/dev/null

if [[ "$BASE_URL" == https://* ]]; then
  curl -fsS -u "$WC_CONSUMER_KEY:$WC_CONSUMER_SECRET" "$ORDERS_URL" >/dev/null
else
  if ! command -v node >/dev/null 2>&1; then
    echo "node is required to sign local HTTP WooCommerce OAuth smoke requests." >&2
    exit 2
  fi

  SIGNED_ORDERS_URL="$(WC_BASE_URL="$BASE_URL" WC_CONSUMER_KEY="$WC_CONSUMER_KEY" WC_CONSUMER_SECRET="$WC_CONSUMER_SECRET" node "${SCRIPT_DIR}/sign-woocommerce-oauth-url.mjs")"
  curl -fsS "$SIGNED_ORDERS_URL" >/dev/null
fi

echo "Local WooCommerce REST smoke passed for ${BASE_URL%/}."
