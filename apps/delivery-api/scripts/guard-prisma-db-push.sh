#!/bin/sh
set -eu

if [ -n "${PRISMA_SCHEMA_PATH:-}" ]; then
  schema_path="$PRISMA_SCHEMA_PATH"
elif [ -f apps/delivery-api/prisma/schema.prisma ]; then
  schema_path="apps/delivery-api/prisma/schema.prisma"
else
  schema_path="prisma/schema.prisma"
fi

if [ -n "${PRISMA_NPM_PREFIX:-}" ]; then
  npm_prefix="$PRISMA_NPM_PREFIX"
elif [ -f apps/delivery-api/package.json ]; then
  npm_prefix="apps/delivery-api"
else
  npm_prefix="."
fi

fail() {
  echo "guard-prisma-db-push: $*" >&2
  exit 65
}

if [ -z "${PRISMA_SCHEMA_SHA:-}" ]; then
  fail "PRISMA_SCHEMA_SHA is required before prisma db push"
fi

if [ "${#PRISMA_SCHEMA_SHA}" -ne 64 ]; then
  fail "PRISMA_SCHEMA_SHA must be a 64-hex SHA256"
fi
case "$PRISMA_SCHEMA_SHA" in
  *[!0-9a-fA-F]*) fail "PRISMA_SCHEMA_SHA must be a 64-hex SHA256" ;;
esac

if [ ! -f "$schema_path" ]; then
  fail "schema file not found: $schema_path"
fi
command -v sha256sum >/dev/null 2>&1 || fail "sha256sum is required before prisma db push"
command -v awk >/dev/null 2>&1 || fail "awk is required before prisma db push"

actual_schema_sha="$(sha256sum "$schema_path" | awk '{print $1}')"
if [ "$actual_schema_sha" != "$PRISMA_SCHEMA_SHA" ]; then
  fail "refusing prisma db push because schema SHA mismatch: actual=$actual_schema_sha expected=$PRISMA_SCHEMA_SHA"
fi

printf 'guard-prisma-db-push: schema SHA verified for %s\n' "$schema_path"
exec npm --prefix "$npm_prefix" exec -- prisma db push --schema "$schema_path" --skip-generate
