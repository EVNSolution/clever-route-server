#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "--plan" ]]; then
  printf '%s\n' \
    'G003: 127.0.0.1:55433 / clever_g003' \
    'G010: 127.0.0.1:55477 / clever_g007_g010_eta' \
    'G005: 127.0.0.1:55466 / clever_g005'
  exit 0
fi

if [[ "${CLEVER_RUN_DISPOSABLE_DB_TESTS:-}" != "1" ]]; then
  echo 'Set CLEVER_RUN_DISPOSABLE_DB_TESTS=1 to create and destroy isolated local PostgreSQL containers.' >&2
  exit 2
fi

command -v docker >/dev/null 2>&1 || { echo 'docker is required.' >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo 'docker daemon is not available.' >&2; exit 1; }

audit_suffix="$$-${RANDOM}"
declare -a audit_containers=()

cleanup() {
  local container_name
  for container_name in "${audit_containers[@]:-}"; do
    docker rm -f "$container_name" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT

start_postgres() {
  local container_name="$1"
  local host_port="$2"
  local database_name="$3"
  local database_user="$4"
  local database_password="$5"

  docker run --detach --rm \
    --name "$container_name" \
    --publish "127.0.0.1:${host_port}:5432" \
    --env "POSTGRES_DB=${database_name}" \
    --env "POSTGRES_USER=${database_user}" \
    --env "POSTGRES_PASSWORD=${database_password}" \
    postgres:17-bookworm >/dev/null
  audit_containers+=("$container_name")

  local attempt
  for attempt in {1..60}; do
    if docker exec "$container_name" pg_isready -U "$database_user" -d "$database_name" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done

  echo "PostgreSQL did not become ready: ${container_name}" >&2
  return 1
}

g003_container="clever-api-audit-g003-${audit_suffix}"
g010_container="clever-api-audit-g010-${audit_suffix}"
g005_container="clever-api-audit-g005-${audit_suffix}"

g003_url='postgresql://clever_g003:clever_g003@127.0.0.1:55433/clever_g003?schema=public'
g010_url='postgresql://clever_g007:clever_g007@127.0.0.1:55477/clever_g007_g010_eta?schema=public'
g005_url='postgresql://clever_g005:clever_g005@127.0.0.1:55466/clever_g005?schema=public'

start_postgres "$g003_container" 55433 clever_g003 clever_g003 clever_g003
start_postgres "$g010_container" 55477 clever_g007_g010_eta clever_g007 clever_g007
start_postgres "$g005_container" 55466 clever_g005 clever_g005 clever_g005

for database_url in "$g003_url" "$g010_url" "$g005_url"; do
  DATABASE_URL="$database_url" npm run prisma:migrate:deploy
done

G003_DATABASE_TARGET_CLASS='safe-local-g003-temp-cluster' \
DATABASE_URL="$g003_url" \
npm test -- dsv-dispatch-import-g003-integration.test.ts

G004_DATABASE_TARGET_CLASS='safe-local-g010-disposable' \
DATABASE_URL="$g010_url" \
DSV_G010_DATABASE_URL="$g010_url" \
npm test -- dsv-assignment-command.integration.test.ts dsv-g009-tenant-composite-fks.integration.test.ts

G005_DATABASE_TARGET_CLASS='safe-local-g005-temp-cluster' \
DATABASE_URL="$g005_url" \
npm test -- dsv-v1-read-query.integration.test.ts
