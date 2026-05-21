#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

"${SCRIPT_DIR}/setup-sandbox.sh"
"${SCRIPT_DIR}/create-rest-key.sh"
"${SCRIPT_DIR}/seed-orders.sh"
"${SCRIPT_DIR}/smoke-rest.sh"

echo "Local WooCommerce sandbox bootstrap complete."
