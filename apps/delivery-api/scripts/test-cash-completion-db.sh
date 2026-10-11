#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

# Only a named disposable loopback database is accepted. DATABASE_URL is ignored.
task_cluster=''
task_container=''
task_pg_bin=''
cleanup() {
  if [[ -n "$task_cluster" ]]; then
    "$task_pg_bin/pg_ctl" -D "$task_cluster/data" -m immediate stop >/dev/null 2>&1 || true
    rm -rf -- "$task_cluster"
  fi
  if [[ -n "$task_container" ]]; then
    docker rm -f "$task_container" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if [[ -n "${CASH_COMPLETION_DATABASE_URL:-}" ]]; then
  [[ "${CASH_COMPLETION_DATABASE_TARGET_CLASS:-}" == 'safe-local-disposable' ]] || {
    echo 'An existing database requires CASH_COMPLETION_DATABASE_TARGET_CLASS=safe-local-disposable.' >&2
    exit 2
  }
  task_database_url="$CASH_COMPLETION_DATABASE_URL"
else
  [[ "${CLEVER_RUN_DISPOSABLE_DB_TESTS:-}" == '1' ]] || {
    echo 'Set CLEVER_RUN_DISPOSABLE_DB_TESTS=1 to create disposable local PostgreSQL.' >&2
    exit 2
  }
  if [[ -x "${CASH_COMPLETION_PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}/initdb" ]]; then
    task_pg_bin="${CASH_COMPLETION_PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
    task_cluster="$(mktemp -d "${TMPDIR:-/tmp}/clever-cash-completion.XXXXXX")"
    task_port="$(node --input-type=module -e 'import net from "node:net"; const server=net.createServer(); server.listen(0,"127.0.0.1",()=>{console.log(server.address().port);server.close();});')"
    "$task_pg_bin/initdb" -D "$task_cluster/data" -U kfood_test --auth-local=trust --auth-host=trust --no-locale --encoding=UTF8 >/dev/null
    "$task_pg_bin/pg_ctl" -D "$task_cluster/data" -l "$task_cluster/postgres.log" \
      -o "-h 127.0.0.1 -p $task_port -k $task_cluster -c max_connections=20 -c shared_buffers=32MB" -w start >/dev/null
    "$task_pg_bin/createdb" -h 127.0.0.1 -p "$task_port" -U kfood_test kfood_cash_completion
  else
    command -v docker >/dev/null 2>&1 || { echo 'PostgreSQL 17 binaries or Docker are required.' >&2; exit 1; }
    docker info >/dev/null 2>&1 || { echo 'Docker daemon is unavailable.' >&2; exit 1; }
    task_container="clever-cash-completion-test-$$-${RANDOM}"
    docker run --detach --rm --name "$task_container" --cpus=2 --memory=512m \
      --publish '127.0.0.1::5432' --env POSTGRES_DB=kfood_cash_completion \
      --env POSTGRES_USER=kfood_test --env POSTGRES_PASSWORD=kfood_test \
      postgres:17-bookworm >/dev/null
    task_port="$(docker port "$task_container" 5432/tcp)"
    task_port="${task_port##*:}"
    task_ready=''
    for attempt in {1..60}; do
      if docker exec "$task_container" pg_isready -U kfood_test -d kfood_cash_completion >/dev/null 2>&1; then
        task_ready=1
        break
      fi
      sleep 1
    done
    [[ "$task_ready" == '1' ]] || { echo 'Disposable PostgreSQL did not become ready.' >&2; exit 1; }
  fi
  [[ "$task_port" =~ ^[0-9]+$ ]] || { echo 'Invalid disposable PostgreSQL port.' >&2; exit 1; }
  task_database_url="postgresql://kfood_test:kfood_test@127.0.0.1:${task_port}/kfood_cash_completion?schema=public"
fi

CASH_COMPLETION_DATABASE_URL="$task_database_url" node --input-type=module <<'JS'
let target;
try { target = new URL(process.env.CASH_COMPLETION_DATABASE_URL); }
catch { throw new Error('Invalid disposable cash completion database URL.'); }
if (target.protocol !== 'postgresql:'
  || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)
  || target.pathname !== '/kfood_cash_completion'
  || target.port === '' || target.hash !== ''
  || [...target.searchParams].some(([key, value]) => key !== 'schema' || value !== 'public')) {
  throw new Error('Cash completion tests require the named loopback disposable database.');
}
JS

DATABASE_URL="$task_database_url" npm run prisma:migrate:deploy
CASH_COMPLETION_DATABASE_TARGET_CLASS=safe-local-disposable \
CASH_COMPLETION_DATABASE_URL="$task_database_url" \
npm test -- tests/driver-cash-completion.integration.test.ts --maxWorkers=1 "$@"
