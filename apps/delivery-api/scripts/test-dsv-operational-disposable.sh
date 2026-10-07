#!/usr/bin/env bash
set -euo pipefail

readonly target_class='safe-local-dsv-operational-disposable'
readonly host_port='55496'
readonly database_name='dsv_operational'
readonly database_user='dsv_operational'
readonly database_password='dsv_operational'
readonly database_url="postgresql://${database_user}:${database_password}@127.0.0.1:${host_port}/${database_name}?schema=public"
readonly g002_database_url='postgresql://clever_g002:clever_g002@127.0.0.1:55488/clever_g002?schema=public'
readonly g003_database_url='postgresql://clever_g003:clever_g003@127.0.0.1:55433/clever_g003?schema=public'
readonly include_g002="${DSV_OPERATIONAL_INCLUDE_G002:-0}"
readonly include_g003="${DSV_OPERATIONAL_INCLUDE_G003:-1}"

if [[ "${1:-}" == '--plan' ]]; then
  printf '%s\n' \
    "DSV operational P1-P3: 127.0.0.1:${host_port} / ${database_name}" \
    'Driver event contract G002 regression (opt-in): 127.0.0.1:55488 / clever_g002' \
    'DSV import G003 regression: 127.0.0.1:55433 / clever_g003'
  exit 0
fi

if [[ "${CLEVER_RUN_DISPOSABLE_DB_TESTS:-}" != '1' ]]; then
  echo 'Set CLEVER_RUN_DISPOSABLE_DB_TESTS=1 to create and destroy the isolated DSV PostgreSQL container.' >&2
  exit 2
fi

if [[ "${DSV_OPERATIONAL_DATABASE_TARGET_CLASS:-}" != "$target_class" ]]; then
  echo "Set DSV_OPERATIONAL_DATABASE_TARGET_CLASS=${target_class}." >&2
  exit 2
fi

command -v docker >/dev/null 2>&1 || { echo 'docker is required.' >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo 'docker daemon is not available.' >&2; exit 1; }

readonly run_suffix="$$-${RANDOM}"
readonly container_name="clever-api-audit-dsv-operational-${run_suffix}"

cleanup() {
  docker rm -f "$container_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

publish_args=(--publish "127.0.0.1:${host_port}:5432")
if [[ "$include_g002" == '1' ]]; then
  publish_args+=(--publish '127.0.0.1:55488:5432')
fi
if [[ "$include_g003" == '1' ]]; then
  publish_args+=(--publish '127.0.0.1:55433:5432')
fi

docker run --detach --rm \
  --name "$container_name" \
  "${publish_args[@]}" \
  --env "POSTGRES_DB=${database_name}" \
  --env "POSTGRES_USER=${database_user}" \
  --env "POSTGRES_PASSWORD=${database_password}" \
  postgres:17-bookworm >/dev/null

for _attempt in {1..60}; do
  if [[ "$(docker exec "$container_name" psql -U "$database_user" -d "$database_name" -Atqc 'SELECT 1' 2>/dev/null || true)" == '1' ]]; then
    break
  fi
  sleep 1
done

if [[ "$(docker exec "$container_name" psql -U "$database_user" -d "$database_name" -Atqc 'SELECT 1' 2>/dev/null || true)" != '1' ]]; then
  echo "PostgreSQL did not become ready: ${container_name}" >&2
  exit 1
fi

DATABASE_URL="$database_url" npm run prisma:migrate:deploy
if [[ "$include_g002" == '1' ]]; then
  docker exec "$container_name" psql -v ON_ERROR_STOP=1 -U "$database_user" -d "$database_name" \
    -c "CREATE ROLE clever_g002 LOGIN PASSWORD 'clever_g002'" \
    -c 'CREATE DATABASE clever_g002 OWNER clever_g002' >/dev/null
  DATABASE_URL="$g002_database_url" npm run prisma:migrate:deploy
  G002_DATABASE_TARGET_CLASS='safe-local-g002-disposable' \
  DATABASE_URL="$g002_database_url" \
  DRIVER_EVENT_CONTRACT_V2_DATABASE_URL="$g002_database_url" \
  npm test -- driver-event-contract-v2.integration.test.ts --maxWorkers=1
fi
if [[ "$include_g003" == '1' ]]; then
  docker exec "$container_name" psql -v ON_ERROR_STOP=1 -U "$database_user" -d "$database_name" \
    -c "CREATE ROLE clever_g003 LOGIN PASSWORD 'clever_g003'" \
    -c 'CREATE DATABASE clever_g003 OWNER clever_g003' >/dev/null
  DATABASE_URL="$g003_database_url" npm run prisma:migrate:deploy
  G003_DATABASE_TARGET_CLASS='safe-local-g003-temp-cluster' \
  DATABASE_URL="$g003_database_url" \
  npm test -- dsv-dispatch-import-g003-integration.test.ts --maxWorkers=1
fi

CLEVER_RUN_DISPOSABLE_DB_TESTS='1' \
DSV_OPERATIONAL_DATABASE_TARGET_CLASS="$target_class" \
DSV_OPERATIONAL_DATABASE_URL="$database_url" \
DATABASE_URL="$database_url" \
npm test -- dsv-operational-server.integration.test.ts dsv-isolated-client-http.integration.test.ts --maxWorkers=1
