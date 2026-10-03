#!/usr/bin/env bash
set -euo pipefail

# Own one disposable fixture database; never accept a caller's database URL.
cd "$(dirname "$0")/.."
task_container="clever-original-observations-test-$$-${RANDOM}"
cleanup() { docker rm -f "$task_container" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker run --detach --rm --name "$task_container" --cpus=2 --memory=512m \
  --publish '127.0.0.1::5432' --env POSTGRES_DB=gps_read_test \
  --env POSTGRES_USER=gps_read_test --env POSTGRES_PASSWORD=gps_read_test \
  postgres:17-bookworm >/dev/null
task_port="$(docker port "$task_container" 5432/tcp)"
task_port="${task_port##*:}"
[[ "$task_port" =~ ^[0-9]+$ ]] || exit 1
task_database_url="postgresql://gps_read_test:gps_read_test@127.0.0.1:${task_port}/gps_read_test"
for attempt in {1..60}; do
  if docker exec "$task_container" pg_isready -U gps_read_test -d gps_read_test >/dev/null 2>&1; then break; fi
  sleep 1
done
DATABASE_URL="$task_database_url" npm run prisma:migrate:deploy
ORIGINAL_OBSERVATIONS_DATABASE_TARGET_CLASS=safe-disposable-original-observations \
ORIGINAL_OBSERVATIONS_DATABASE_URL="$task_database_url" \
npm test -- tests/original-observations.integration.test.ts --maxWorkers=1
