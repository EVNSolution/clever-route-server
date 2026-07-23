#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
WRAPPER="apps/delivery-api/scripts/dsv-g007-migrate-deploy.sh"

fail() {
  echo "route-ops-prisma-migrate-deploy.test: $*" >&2
  exit 1
}

make_fake_npm() {
  local tmp="$1"
  mkdir -p "$tmp/bin"
  cat > "$tmp/bin/npm" <<'EOF_NPM'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" > "$FAKE_NPM_ARGS_FILE"
EOF_NPM
  chmod +x "$tmp/bin/npm"
}

run_expect_fail() {
  local tmp="$1"
  local expected="$2"
  shift 2
  if "$@" > "$tmp/stdout" 2> "$tmp/stderr"; then
    fail "expected failure containing '$expected'"
  fi
  grep -Fq "$expected" "$tmp/stderr"
  if [[ -e "$tmp/npm.args" ]]; then
    fail "wrapper invoked npm after failed preflight"
  fi
}

run_missing_mode_case() {
  local tmp
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/route-ops-migrate-missing-mode.XXXXXX")"
  trap 'rm -rf "$tmp"' RETURN
  make_fake_npm "$tmp"
  run_expect_fail "$tmp" 'DSV_MIGRATION_MODE is required' env \
    PATH="$tmp/bin:$PATH" \
    FAKE_NPM_ARGS_FILE="$tmp/npm.args" \
    DATABASE_URL='postgresql://clever:clever@example.invalid:5432/clever_g007_empty_static' \
    bash "$WRAPPER"
}

run_protected_local_case() {
  local tmp
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/route-ops-migrate-protected-local.XXXXXX")"
  trap 'rm -rf "$tmp"' RETURN
  make_fake_npm "$tmp"
  run_expect_fail "$tmp" 'refusing protected local clever_route target' env \
    PATH="$tmp/bin:$PATH" \
    FAKE_NPM_ARGS_FILE="$tmp/npm.args" \
    DSV_MIGRATION_MODE='rehearsal' \
    G007_DATABASE_TARGET_CLASS='empty' \
    DATABASE_URL='postgresql://clever:clever@127.0.0.1:5432/clever_route' \
    bash "$WRAPPER"
}

run_stale_local_port_case() {
  local tmp
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/route-ops-migrate-stale-local-port.XXXXXX")"
  trap 'rm -rf "$tmp"' RETURN
  make_fake_npm "$tmp"
  for database_url in \
    'postgresql://clever:clever@localhost:5433/clever_g007_empty_static' \
    'postgresql://clever:clever@127.0.0.1:5433/clever_g007_empty_static' \
    'postgresql://clever:clever@[::1]:5433/clever_g007_empty_static'
  do
    rm -f "$tmp/npm.args"
    run_expect_fail "$tmp" 'refusing stale local PostgreSQL 5433 migration target' env \
      PATH="$tmp/bin:$PATH" \
      FAKE_NPM_ARGS_FILE="$tmp/npm.args" \
      DSV_MIGRATION_MODE='rehearsal' \
      G007_DATABASE_TARGET_CLASS='empty' \
      DATABASE_URL="$database_url" \
      bash "$WRAPPER"
  done
}

run_normalized_loopback_regression_case() {
  local tmp
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/route-ops-migrate-normalized-loopback.XXXXXX")"
  trap 'rm -rf "$tmp"' RETURN
  make_fake_npm "$tmp"
  for database_url in \
    'postgresql://clever:clever@2130706433:5432/clever_route_prod' \
    'postgresql://clever:clever@0x7f000001:5432/clever_route_prod' \
    'postgresql://clever:clever@017700000001:5432/clever_route_prod' \
    'postgresql://clever:clever@127.1:5432/clever_route_prod' \
    'postgresql://clever:clever@[::ffff:127.0.0.1]:5432/clever_route_prod'
  do
    rm -f "$tmp/npm.args"
    run_expect_fail "$tmp" 'production mode refuses local database hosts' env \
      PATH="$tmp/bin:$PATH" \
      FAKE_NPM_ARGS_FILE="$tmp/npm.args" \
      DSV_MIGRATION_MODE='production' \
      DSV_MIGRATION_APPROVED='1' \
      DSV_MIGRATION_MANIFEST_SHA256='0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' \
      DSV_RESTORE_REHEARSAL_SHA256='abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789' \
      DATABASE_URL="$database_url" \
      bash "$WRAPPER"
  done
}

run_percent_encoded_path_bypass_case() {
  local tmp
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/route-ops-migrate-path-bypass.XXXXXX")"
  trap 'rm -rf "$tmp"' RETURN
  make_fake_npm "$tmp"
  run_expect_fail "$tmp" 'DATABASE_URL database name is unsafe' env \
    PATH="$tmp/bin:$PATH" \
    FAKE_NPM_ARGS_FILE="$tmp/npm.args" \
    DSV_MIGRATION_MODE='rehearsal' \
    G007_DATABASE_TARGET_CLASS='empty' \
    DATABASE_URL='postgresql://clever:clever@example.invalid:5432/clever_g007_empty_static%2Fclever_route' \
    bash "$WRAPPER"
}

run_rehearsal_success_case() {
  local tmp
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/route-ops-migrate-rehearsal.XXXXXX")"
  trap 'rm -rf "$tmp"' RETURN
  make_fake_npm "$tmp"
  env \
    PATH="$tmp/bin:$PATH" \
    FAKE_NPM_ARGS_FILE="$tmp/npm.args" \
    DSV_MIGRATION_MODE='rehearsal' \
    G007_DATABASE_TARGET_CLASS='empty' \
    DATABASE_URL='postgresql://clever:clever@example.invalid:5432/clever_g007_empty_static' \
    bash "$WRAPPER" > "$tmp/stdout" 2> "$tmp/stderr"
  grep -Fq 'validated rehearsal target example.invalid/clever_g007_empty_static' "$tmp/stdout"
  grep -Fq -- "--prefix $ROOT/apps/delivery-api run prisma:migrate:deploy" "$tmp/npm.args"
}

run_rehearsal_url_normalization_success_case() {
  local tmp
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/route-ops-migrate-rehearsal-normalized.XXXXXX")"
  trap 'rm -rf "$tmp"' RETURN
  make_fake_npm "$tmp"
  env \
    PATH="$tmp/bin:$PATH" \
    FAKE_NPM_ARGS_FILE="$tmp/npm.args" \
    DSV_MIGRATION_MODE='rehearsal' \
    G007_DATABASE_TARGET_CLASS='empty' \
    DATABASE_URL='postgresql://clever:clever@EXAMPLE.invalid/clever_g007_%65mpty_static' \
    bash "$WRAPPER" > "$tmp/stdout" 2> "$tmp/stderr"
  grep -Fq 'validated rehearsal target example.invalid/clever_g007_empty_static' "$tmp/stdout"
  grep -Fq -- "--prefix $ROOT/apps/delivery-api run prisma:migrate:deploy" "$tmp/npm.args"
}

run_rehearsal_ipv6_bypass_success_case() {
  local tmp
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/route-ops-migrate-rehearsal-ipv6.XXXXXX")"
  trap 'rm -rf "$tmp"' RETURN
  make_fake_npm "$tmp"
  env \
    PATH="$tmp/bin:$PATH" \
    FAKE_NPM_ARGS_FILE="$tmp/npm.args" \
    DSV_MIGRATION_MODE='rehearsal' \
    G007_DATABASE_TARGET_CLASS='empty' \
    DATABASE_URL='postgresql://clever:clever@[2001:db8::7]:5433/clever_g007_empty_static' \
    bash "$WRAPPER" > "$tmp/stdout" 2> "$tmp/stderr"
  grep -Fq 'validated rehearsal target 2001:db8::7/clever_g007_empty_static' "$tmp/stdout"
  grep -Fq -- "--prefix $ROOT/apps/delivery-api run prisma:migrate:deploy" "$tmp/npm.args"
}

run_cwd_independence_case() {
  local tmp
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/route-ops-migrate-cwd.XXXXXX")"
  trap 'rm -rf "$tmp"' RETURN
  make_fake_npm "$tmp"
  (
    cd "$tmp"
    env \
      PATH="$tmp/bin:$PATH" \
      FAKE_NPM_ARGS_FILE="$tmp/npm.args" \
      DSV_MIGRATION_MODE='rehearsal' \
      G007_DATABASE_TARGET_CLASS='empty' \
      DATABASE_URL='postgresql://clever:clever@example.invalid:5432/clever_g007_empty_cwd_static' \
      bash "$ROOT/$WRAPPER" > "$tmp/stdout" 2> "$tmp/stderr"
  )
  grep -Fq 'validated rehearsal target example.invalid/clever_g007_empty_cwd_static' "$tmp/stdout"
  grep -Fq -- "--prefix $ROOT/apps/delivery-api run prisma:migrate:deploy" "$tmp/npm.args"
  if grep -Fq 'apps/delivery-api/apps/delivery-api' "$tmp/npm.args"; then
    fail "wrapper built a cwd-dependent nested apps/delivery-api path"
  fi
}

run_rehearsal_target_name_case() {
  local tmp
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/route-ops-migrate-rehearsal-target.XXXXXX")"
  trap 'rm -rf "$tmp"' RETURN
  make_fake_npm "$tmp"
  run_expect_fail "$tmp" 'rehearsal mode requires a disposable clever_g007_* database' env \
    PATH="$tmp/bin:$PATH" \
    FAKE_NPM_ARGS_FILE="$tmp/npm.args" \
    DSV_MIGRATION_MODE='rehearsal' \
    G007_DATABASE_TARGET_CLASS='empty' \
    DATABASE_URL='postgresql://clever:clever@example.invalid:5432/not_g007' \
    bash "$WRAPPER"
}

run_compose_dev_success_case() {
  local tmp
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/route-ops-migrate-compose-dev.XXXXXX")"
  trap 'rm -rf "$tmp"' RETURN
  make_fake_npm "$tmp"
  env \
    PATH="$tmp/bin:$PATH" \
    FAKE_NPM_ARGS_FILE="$tmp/npm.args" \
    DSV_MIGRATION_MODE='compose-dev' \
    DSV_DEV_FRESH_VOLUME='1' \
    DSV_DEV_VOLUME_NAME='dsv-postgres-g007-migrate-deploy' \
    DATABASE_URL='postgresql://clever:clever@postgres:5432/clever_route' \
    bash "$WRAPPER" > "$tmp/stdout" 2> "$tmp/stderr"
  grep -Fq 'validated compose-dev target postgres/clever_route' "$tmp/stdout"
  grep -Fq -- "--prefix $ROOT/apps/delivery-api run prisma:migrate:deploy" "$tmp/npm.args"
}

run_compose_dev_old_volume_case() {
  local tmp
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/route-ops-migrate-compose-dev-volume.XXXXXX")"
  trap 'rm -rf "$tmp"' RETURN
  make_fake_npm "$tmp"
  run_expect_fail "$tmp" 'compose-dev mode refuses old dsv-postgres volume' env \
    PATH="$tmp/bin:$PATH" \
    FAKE_NPM_ARGS_FILE="$tmp/npm.args" \
    DSV_MIGRATION_MODE='compose-dev' \
    DSV_DEV_FRESH_VOLUME='1' \
    DSV_DEV_VOLUME_NAME='dsv-postgres' \
    DATABASE_URL='postgresql://clever:clever@postgres:5432/clever_route' \
    bash "$WRAPPER"
}

run_compose_dev_missing_volume_name_case() {
  local tmp
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/route-ops-migrate-compose-dev-missing-volume.XXXXXX")"
  trap 'rm -rf "$tmp"' RETURN
  make_fake_npm "$tmp"
  run_expect_fail "$tmp" 'DSV_DEV_VOLUME_NAME is required' env \
    PATH="$tmp/bin:$PATH" \
    FAKE_NPM_ARGS_FILE="$tmp/npm.args" \
    DSV_MIGRATION_MODE='compose-dev' \
    DSV_DEV_FRESH_VOLUME='1' \
    DATABASE_URL='postgresql://clever:clever@postgres:5432/clever_route' \
    bash "$WRAPPER"
}

run_production_loopback_case() {
  local tmp
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/route-ops-migrate-production-loopback.XXXXXX")"
  trap 'rm -rf "$tmp"' RETURN
  make_fake_npm "$tmp"
  for database_url in \
    'postgresql://clever:clever@localhost:5432/clever_route' \
    'postgresql://clever:clever@127.9.8.7:5432/clever_route' \
    'postgresql://clever:clever@[::1]:5432/clever_route'
  do
    rm -f "$tmp/npm.args"
    run_expect_fail "$tmp" 'refusing protected local clever_route target' env \
      PATH="$tmp/bin:$PATH" \
      FAKE_NPM_ARGS_FILE="$tmp/npm.args" \
      DSV_MIGRATION_MODE='production' \
      DSV_MIGRATION_APPROVED='1' \
      DSV_MIGRATION_MANIFEST_SHA256='0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' \
      DSV_RESTORE_REHEARSAL_SHA256='abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789' \
      DATABASE_URL="$database_url" \
      bash "$WRAPPER"
  done
}

run_production_contract_case() {
  local tmp
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/route-ops-migrate-production.XXXXXX")"
  trap 'rm -rf "$tmp"' RETURN
  make_fake_npm "$tmp"
  run_expect_fail "$tmp" 'production mode requires DSV_MIGRATION_APPROVED=1' env \
    PATH="$tmp/bin:$PATH" \
    FAKE_NPM_ARGS_FILE="$tmp/npm.args" \
    DSV_MIGRATION_MODE='production' \
    DATABASE_URL='postgresql://clever:clever@db.example.invalid:5432/clever_route' \
    bash "$WRAPPER"

  env \
    PATH="$tmp/bin:$PATH" \
    FAKE_NPM_ARGS_FILE="$tmp/npm.args" \
    DSV_MIGRATION_MODE='production' \
    DSV_MIGRATION_APPROVED='1' \
    DSV_MIGRATION_MANIFEST_SHA256='0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' \
    DSV_RESTORE_REHEARSAL_SHA256='abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789' \
    DATABASE_URL='postgresql://clever:clever@db.example.invalid:5432/clever_route' \
    bash "$WRAPPER" > "$tmp/stdout" 2> "$tmp/stderr"
  grep -Fq 'validated production target db.example.invalid/clever_route' "$tmp/stdout"
  grep -Fq -- "--prefix $ROOT/apps/delivery-api run prisma:migrate:deploy" "$tmp/npm.args"
}

run_static_contract_case() {
  grep -Fq '"prisma:migrate:deploy": "prisma migrate deploy"' apps/delivery-api/package.json
  grep -Fq 'COPY apps/delivery-api/scripts/dsv-g007-migrate-deploy.sh ./scripts/dsv-g007-migrate-deploy.sh' apps/delivery-api/Dockerfile
  grep -Fq 'chmod 0755 ./scripts/dsv-g007-migrate-deploy.sh' apps/delivery-api/Dockerfile
  grep -Fq 'command: ["/app/scripts/dsv-g007-migrate-deploy.sh"]' infra/compose/docker-compose.prod.yml
  grep -Fq 'DSV_MIGRATION_MODE: production' infra/compose/docker-compose.prod.yml
  grep -Fq 'command: ["/app/scripts/dsv-g007-migrate-deploy.sh"]' infra/compose/docker-compose.dsv-dev.yml
  grep -Fq 'DSV_MIGRATION_MODE: compose-dev' infra/compose/docker-compose.dsv-dev.yml
  grep -Fq 'DSV_DEV_FRESH_VOLUME: "1"' infra/compose/docker-compose.dsv-dev.yml
  grep -Fq 'dsv-postgres-g007-migrate-deploy:/var/lib/postgresql/data' infra/compose/docker-compose.dsv-dev.yml
  if grep -Fq 'dsv-postgres:/var/lib/postgresql/data' infra/compose/docker-compose.dsv-dev.yml; then
    fail "DSV dev compose must not mount the old dsv-postgres volume"
  fi

  local forbidden_db_push_pattern='db[[:space:]]+push'
  if grep -RE "$forbidden_db_push_pattern|--accept-data-loss|--force-reset|postgres-restore[.]sh" \
      infra/compose/docker-compose.prod.yml \
      infra/compose/docker-compose.dsv-dev.yml \
      apps/delivery-api/scripts/dsv-g007-migrate-deploy.sh; then
    fail "G007 migrate deploy path contains a forbidden operational command"
  fi
}

run_missing_mode_case
run_protected_local_case
run_stale_local_port_case
run_normalized_loopback_regression_case
run_percent_encoded_path_bypass_case
run_rehearsal_success_case
run_rehearsal_url_normalization_success_case
run_rehearsal_ipv6_bypass_success_case
run_cwd_independence_case
run_rehearsal_target_name_case
run_compose_dev_success_case
run_compose_dev_old_volume_case
run_compose_dev_missing_volume_name_case
run_production_loopback_case
run_production_contract_case
run_static_contract_case
printf '{"ok":true,"wrapper":"%s"}\n' "$WRAPPER"
