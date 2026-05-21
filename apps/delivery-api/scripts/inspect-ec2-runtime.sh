#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/srv/clever-route-server}"
LOG_SINCE="${LOG_SINCE:-2h}"
LOG_TAIL="${LOG_TAIL:-300}"
INCLUDE_DB_COUNTS="${INCLUDE_DB_COUNTS:-true}"
COMPOSE=(docker compose -f infra/compose/docker-compose.prod.yml)

if ! [[ "${LOG_TAIL}" =~ ^[0-9]+$ ]]; then
  echo "LOG_TAIL must be an integer. Received: ${LOG_TAIL}" >&2
  exit 1
fi

if [ ! -d "${APP_DIR}" ]; then
  echo "APP_DIR does not exist: ${APP_DIR}" >&2
  exit 1
fi

cd "${APP_DIR}"

echo "Inspecting clever-route-server runtime"
echo "- app dir: ${APP_DIR}"
echo "- git ref: $(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
echo "- git sha: $(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
echo "- log since: ${LOG_SINCE}"
echo "- log tail: ${LOG_TAIL}"

echo "::group::docker compose status"
"${COMPOSE[@]}" ps
echo "::endgroup::"

echo "::group::api logs"
"${COMPOSE[@]}" logs --since "${LOG_SINCE}" --tail "${LOG_TAIL}" delivery-api || true
echo "::endgroup::"

echo "::group::caddy logs"
"${COMPOSE[@]}" logs --since "${LOG_SINCE}" --tail "${LOG_TAIL}" caddy || true
echo "::endgroup::"

if [ "${INCLUDE_DB_COUNTS}" = "true" ]; then
  echo "::group::route plan database summary"
  "${COMPOSE[@]}" exec -T postgres sh -lc 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<'"'"'SQL'"'"'
\pset pager off
\pset null "(null)"
select count(*) as route_plan_count from route_plans;
select
  rp.id,
  s."shopDomain",
  rp.name,
  rp.status,
  rp."createdAt",
  count(rps.id) as stops
from route_plans rp
join shops s on s.id = rp."shopId"
left join route_plan_stops rps on rps."routePlanId" = rp.id
group by rp.id, s."shopDomain", rp.name, rp.status, rp."createdAt"
order by rp."createdAt" desc
limit 20;
SQL'
  echo "::endgroup::"
fi

echo "Inspection complete. No secret files or process variables were printed."
