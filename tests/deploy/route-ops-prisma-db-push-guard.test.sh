#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
GUARD="apps/delivery-api/scripts/guard-prisma-db-push.sh"

fail() {
  echo "route-ops-prisma-db-push-guard.test: $*" >&2
  exit 1
}

run_missing_sha_case() {
  local tmp
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/route-ops-prisma-guard-missing.XXXXXX")"
  trap 'rm -rf "$tmp"' RETURN
  printf 'datasource db { provider = "postgresql" url = env("DATABASE_URL") }\n' > "$tmp/schema.prisma"
  if PRISMA_SCHEMA_PATH="$tmp/schema.prisma" "$GUARD" > "$tmp/stdout" 2> "$tmp/stderr"; then
    fail "missing PRISMA_SCHEMA_SHA unexpectedly passed"
  fi
  grep -q 'PRISMA_SCHEMA_SHA is required before prisma db push' "$tmp/stderr"
}

run_bad_shape_case() {
  local tmp
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/route-ops-prisma-guard-shape.XXXXXX")"
  trap 'rm -rf "$tmp"' RETURN
  printf 'model Example { id String @id }\n' > "$tmp/schema.prisma"
  if PRISMA_SCHEMA_PATH="$tmp/schema.prisma" PRISMA_SCHEMA_SHA="not-a-sha" "$GUARD" > "$tmp/stdout" 2> "$tmp/stderr"; then
    fail "bad PRISMA_SCHEMA_SHA shape unexpectedly passed"
  fi
  grep -q 'PRISMA_SCHEMA_SHA must be a 64-hex SHA256' "$tmp/stderr"
}

run_mismatch_case() {
  local tmp
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/route-ops-prisma-guard-mismatch.XXXXXX")"
  trap 'rm -rf "$tmp"' RETURN
  printf 'model Example { id String @id }\n' > "$tmp/schema.prisma"
  if PRISMA_SCHEMA_PATH="$tmp/schema.prisma" PRISMA_SCHEMA_SHA="0000000000000000000000000000000000000000000000000000000000000000" "$GUARD" > "$tmp/stdout" 2> "$tmp/stderr"; then
    fail "mismatched PRISMA_SCHEMA_SHA unexpectedly passed"
  fi
  grep -q 'refusing prisma db push because schema SHA mismatch' "$tmp/stderr"
}

run_match_executes_prisma_case() {
  local tmp sha
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/route-ops-prisma-guard-match.XXXXXX")"
  trap 'rm -rf "$tmp"' RETURN
  mkdir -p "$tmp/bin"
  cat > "$tmp/bin/npm" <<'EOF_NPM'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" > "$FAKE_NPM_ARGS_FILE"
case "$*" in
  *'--accept-data-loss'*) echo 'guard passed forbidden --accept-data-loss' >&2; exit 88 ;;
esac
EOF_NPM
  chmod +x "$tmp/bin/npm"
  printf 'model Example { id String @id }\n' > "$tmp/schema.prisma"
  sha="$(sha256sum "$tmp/schema.prisma" | awk '{print $1}')"
  PATH="$tmp/bin:$PATH" FAKE_NPM_ARGS_FILE="$tmp/npm.args" PRISMA_SCHEMA_PATH="$tmp/schema.prisma" PRISMA_SCHEMA_SHA="$sha" "$GUARD" > "$tmp/stdout" 2> "$tmp/stderr"
  grep -q 'schema SHA verified' "$tmp/stdout"
  grep -q -- '--prefix apps/delivery-api exec -- prisma db push --schema' "$tmp/npm.args"
  grep -q -- '--skip-generate' "$tmp/npm.args"
  if grep -q -- '--accept-data-loss' "$tmp/npm.args"; then
    fail "guard must not pass --accept-data-loss"
  fi
}

run_runtime_layout_case() {
  local tmp sha
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/route-ops-prisma-guard-runtime.XXXXXX")"
  trap 'rm -rf "$tmp"' RETURN
  mkdir -p "$tmp/bin" "$tmp/prisma"
  cat > "$tmp/bin/npm" <<'EOF_NPM'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" > "$FAKE_NPM_ARGS_FILE"
EOF_NPM
  chmod +x "$tmp/bin/npm"
  printf '{"scripts":{}}\n' > "$tmp/package.json"
  printf 'model Example { id String @id }\n' > "$tmp/prisma/schema.prisma"
  sha="$(sha256sum "$tmp/prisma/schema.prisma" | awk '{print $1}')"
  (cd "$tmp" && PATH="$tmp/bin:$PATH" FAKE_NPM_ARGS_FILE="$tmp/npm.args" PRISMA_SCHEMA_SHA="$sha" sh "$ROOT/$GUARD" > "$tmp/stdout" 2> "$tmp/stderr")
  grep -q 'schema SHA verified for prisma/schema.prisma' "$tmp/stdout"
  grep -q -- '--prefix . exec -- prisma db push --schema prisma/schema.prisma --skip-generate' "$tmp/npm.args"
}

run_static_contract_case() {
  grep -Fq 'delivery-api-migrate:' infra/compose/docker-compose.prod.yml
  grep -Fq 'image: ${DELIVERY_API_IMAGE:?DELIVERY_API_IMAGE is required}' infra/compose/docker-compose.prod.yml
  grep -Fq 'command: ["sh", "scripts/guard-prisma-db-push.sh"]' infra/compose/docker-compose.prod.yml
  grep -Fq 'PRISMA_SCHEMA_SHA: ${PRISMA_SCHEMA_SHA:?PRISMA_SCHEMA_SHA is required}' infra/compose/docker-compose.prod.yml
  grep -Fq 'COPY apps/delivery-api/scripts/guard-prisma-db-push.sh ./scripts/guard-prisma-db-push.sh' apps/delivery-api/Dockerfile
}

run_missing_sha_case
run_bad_shape_case
run_mismatch_case
run_match_executes_prisma_case
run_runtime_layout_case
run_static_contract_case
printf '{"ok":true,"guard":"%s"}\n' "$GUARD"
