#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

# This runner only owns a named disposable database on the local machine.
# DATABASE_URL is deliberately ignored; no production fallback is allowed.
task_container=''
cleanup() {
  if [[ -n "$task_container" ]]; then
    docker rm -f "$task_container" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if [[ -n "${LIVE_ROUTE_CHANGE_DATABASE_URL:-}" ]]; then
  if [[ "${LIVE_ROUTE_CHANGE_DATABASE_TARGET_CLASS:-}" != 'safe-local-disposable' ]]; then
    echo 'An existing database requires LIVE_ROUTE_CHANGE_DATABASE_TARGET_CLASS=safe-local-disposable.' >&2
    exit 2
  fi
  task_database_url="$LIVE_ROUTE_CHANGE_DATABASE_URL"
else
  if [[ "${CLEVER_RUN_DISPOSABLE_DB_TESTS:-}" != '1' ]]; then
    echo 'Set CLEVER_RUN_DISPOSABLE_DB_TESTS=1 to create an isolated local PostgreSQL container.' >&2
    exit 2
  fi
  command -v docker >/dev/null 2>&1 || { echo 'docker is required.' >&2; exit 1; }
  docker info >/dev/null 2>&1 || { echo 'docker daemon is unavailable.' >&2; exit 1; }
  task_container="clever-live-route-change-test-$$-${RANDOM}"
  docker run --detach --rm --name "$task_container" --cpus=2 --memory=512m \
    --publish '127.0.0.1::5432' --env POSTGRES_DB=kfood_live_change \
    --env POSTGRES_USER=kfood_test --env POSTGRES_PASSWORD=kfood_test \
    postgres:17-bookworm >/dev/null
  task_port="$(docker port "$task_container" 5432/tcp)"
  task_port="${task_port##*:}"
  [[ "$task_port" =~ ^[0-9]+$ ]] || { echo 'Invalid disposable PostgreSQL port.' >&2; exit 1; }
  task_database_url="postgresql://kfood_test:kfood_test@127.0.0.1:${task_port}/kfood_live_change?schema=public"
  task_ready=''
  for attempt in {1..60}; do
    if docker exec "$task_container" pg_isready -U kfood_test -d kfood_live_change >/dev/null 2>&1; then
      task_ready=1
      break
    fi
    sleep 1
  done
  [[ "$task_ready" == '1' ]] || { echo 'Disposable PostgreSQL did not become ready.' >&2; exit 1; }
fi

# Validate before Prisma can connect. Do not print credentials on rejection.
LIVE_ROUTE_CHANGE_DATABASE_URL="$task_database_url" node --input-type=module <<'JS'
let target;
try { target = new URL(process.env.LIVE_ROUTE_CHANGE_DATABASE_URL); }
catch { throw new Error('Invalid disposable live route change database URL.'); }
const query = [...target.searchParams];
if (target.protocol !== 'postgresql:'
  || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)
  || target.pathname !== '/kfood_live_change'
  || target.port === ''
  || target.hash !== ''
  || query.some(([key, value]) => key !== 'schema' || value !== 'public')) {
  throw new Error('Live route change tests require a named loopback disposable PostgreSQL database.');
}
JS

DATABASE_URL="$task_database_url" npm run prisma:migrate:deploy
LIVE_ROUTE_CHANGE_DATABASE_TARGET_CLASS=safe-local-disposable \
LIVE_ROUTE_CHANGE_DATABASE_URL="$task_database_url" \
npm test -- tests/live-route-change.integration.test.ts --maxWorkers=1
