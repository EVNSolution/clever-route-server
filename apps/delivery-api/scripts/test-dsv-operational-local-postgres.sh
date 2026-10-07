#!/usr/bin/env bash
set -euo pipefail

# A native PostgreSQL 17 alternative to the Docker disposable profile.
# It never accepts a supplied database URL or an existing data directory.
if [[ "${CLEVER_RUN_DISPOSABLE_DB_TESTS:-}" != '1' ]]; then
  echo 'Set CLEVER_RUN_DISPOSABLE_DB_TESTS=1 for isolated local PostgreSQL tests.' >&2
  exit 2
fi
readonly pg_bin="${DSV_TEST_PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
"$pg_bin/postgres" --version | grep -Eq 'PostgreSQL\) 17\.' || {
  echo 'This profile requires PostgreSQL 17.' >&2
  exit 2
}
readonly run_dir="$(mktemp -d "${TMPDIR:-/tmp}/dsv-isolated-postgres.XXXXXX")"
declare -a cluster_dirs=()
cleanup() {
  local original_status=$? cleanup_failed=0 data_dir
  trap - EXIT
  for data_dir in "${cluster_dirs[@]:-}"; do
    if [[ -n "$data_dir" && -f "$data_dir/postmaster.pid" ]]; then
      if ! "$pg_bin/pg_ctl" -D "$data_dir" -m fast -w stop >>"$run_dir/cleanup.log" 2>&1; then
        echo "Failed to stop owned PostgreSQL cluster: $data_dir; inspect $run_dir/cleanup.log and postmaster.pid" >&2
        cleanup_failed=1
      fi
    fi
  done
  # Logs remain available for diagnosis. Databases contain synthetic data only.
  echo "Isolated PostgreSQL logs and data retained at $run_dir"
  if [[ "$original_status" -ne 0 ]]; then exit "$original_status"; fi
  exit "$cleanup_failed"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

start_cluster() {
  local port="$1" name="$2"
  local data_dir="$run_dir/$name"
  "$pg_bin/initdb" -D "$data_dir" -U "$name" --auth=trust --no-locale --encoding=UTF8 >"$run_dir/$name-initdb.log"
  cluster_dirs+=("$data_dir")
  # Bind/start fails if the fixed test port is already owned. Do not reuse it.
  "$pg_bin/pg_ctl" -D "$data_dir" -l "$run_dir/$name-postgres.log" \
    -o "-h 127.0.0.1 -p $port -k $run_dir -c shared_buffers=32MB -c max_connections=30" -w start
  "$pg_bin/createdb" -h 127.0.0.1 -p "$port" -U "$name" "$name"
}

readonly operational_url='postgresql://dsv_operational:dsv_operational@127.0.0.1:55496/dsv_operational?schema=public'
start_cluster 55496 dsv_operational
DATABASE_URL="$operational_url" npm run prisma:migrate:deploy

if [[ "${DSV_OPERATIONAL_INCLUDE_G002:-0}" == '1' ]]; then
  readonly g002_url='postgresql://clever_g002:clever_g002@127.0.0.1:55488/clever_g002?schema=public'
  start_cluster 55488 clever_g002
  DATABASE_URL="$g002_url" npm run prisma:migrate:deploy
  G002_DATABASE_TARGET_CLASS='safe-local-g002-disposable' DATABASE_URL="$g002_url" \
    DRIVER_EVENT_CONTRACT_V2_DATABASE_URL="$g002_url" \
    npm test -- driver-event-contract-v2.integration.test.ts --maxWorkers=1
fi

if [[ "${DSV_OPERATIONAL_INCLUDE_G003:-1}" == '1' ]]; then
  readonly g003_url='postgresql://clever_g003:clever_g003@127.0.0.1:55433/clever_g003?schema=public'
  start_cluster 55433 clever_g003
  DATABASE_URL="$g003_url" npm run prisma:migrate:deploy
  G003_DATABASE_TARGET_CLASS='safe-local-g003-temp-cluster' DATABASE_URL="$g003_url" \
    npm test -- dsv-dispatch-import-g003-integration.test.ts --maxWorkers=1
fi

DSV_OPERATIONAL_DATABASE_TARGET_CLASS='safe-local-dsv-operational-disposable' \
  DSV_OPERATIONAL_DATABASE_URL="$operational_url" DATABASE_URL="$operational_url" \
  npm test -- dsv-operational-server.integration.test.ts dsv-isolated-client-http.integration.test.ts --maxWorkers=1

# Optional command keeps the same real DB available for the browser harness.
if [[ "$#" -gt 0 ]]; then
  DSV_OPERATIONAL_DATABASE_TARGET_CLASS='safe-local-dsv-operational-disposable' \
    DSV_OPERATIONAL_DATABASE_URL="$operational_url" DATABASE_URL="$operational_url" "$@"
fi
