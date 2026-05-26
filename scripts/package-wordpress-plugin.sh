#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_SRC="${ROOT_DIR}/apps/wordpress-connector-plugin"
ZIP_OUT="${ROOT_DIR}/apps/clever-route-connector.zip"
ZIP_ROOT="wordpress-connector-plugin"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

if [[ ! -f "${PLUGIN_SRC}/clever-route-connector.php" ]]; then
  echo "Plugin source not found: ${PLUGIN_SRC}" >&2
  exit 1
fi

mkdir -p "${TMP_DIR}/${ZIP_ROOT}"
rsync -a \
  --exclude='.DS_Store' \
  --exclude='*.zip' \
  "${PLUGIN_SRC}/" "${TMP_DIR}/${ZIP_ROOT}/"

rm -f "${ZIP_OUT}"
(
  cd "${TMP_DIR}"
  zip -qr "${ZIP_OUT}" "${ZIP_ROOT}"
)

unzip -tq "${ZIP_OUT}" >/dev/null
unzip -l "${ZIP_OUT}" | sed -n '1,40p'
