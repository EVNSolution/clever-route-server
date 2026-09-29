#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

readonly EXPECTED_APP_ID='clever-route-kfood'
readonly EXPECTED_SHOP_DOMAIN='7hrud1-xq.myshopify.com'
readonly DEFAULT_PRIVATE_DIR='/srv/clever-route-server/private/route-tracking-preservation-worker'
readonly DEFAULT_CONTAINER_PRIVATE_DIR='/tmp/route-tracking-preservation-worker'
readonly REBUILD_COMMAND='dist/scripts/rebuild-route-tracking-quality.js'

die() {
  printf 'route-tracking preservation worker: %s\n' "$*" >&2
  exit 1
}

for required_command in docker flock install python3 sha256sum; do
  command -v "${required_command}" >/dev/null 2>&1 \
    || die "required command is unavailable: ${required_command}"
done

[[ "${EUID}" -eq 0 ]] || die 'run as root so private evidence remains root-owned'
[[ "${TRACKING_EXECUTE:-}" == '1' ]] || die 'set TRACKING_EXECUTE=1 for an intentional server-host run'
[[ "${TRACKING_APP_ID:-}" == "${EXPECTED_APP_ID}" ]] \
  || die "TRACKING_APP_ID must equal ${EXPECTED_APP_ID}"
[[ "${TRACKING_SHOP_DOMAIN:-}" == "${EXPECTED_SHOP_DOMAIN}" ]] \
  || die "TRACKING_SHOP_DOMAIN must equal ${EXPECTED_SHOP_DOMAIN}"

readonly tracking_private_dir="${TRACKING_PRIVATE_DIR:-${DEFAULT_PRIVATE_DIR}}"
readonly tracking_container_private_dir="${TRACKING_CONTAINER_PRIVATE_DIR:-${DEFAULT_CONTAINER_PRIVATE_DIR}}"
[[ "${tracking_private_dir}" == /srv/clever-route-server/private/* ]] \
  || die 'TRACKING_PRIVATE_DIR must remain under /srv/clever-route-server/private/'
[[ "${tracking_container_private_dir}" == /tmp/route-tracking-preservation-worker* ]] \
  || die 'TRACKING_CONTAINER_PRIVATE_DIR must remain under /tmp/route-tracking-preservation-worker'

install -d -m 0700 \
  "${tracking_private_dir}" \
  "${tracking_private_dir}/backups" \
  "${tracking_private_dir}/logs" \
  "${tracking_private_dir}/state"

exec 9>"${tracking_private_dir}/state/worker.lock"
chmod 0600 "${tracking_private_dir}/state/worker.lock"
flock -n 9 || die 'another preservation worker already holds the tenant lock'

readonly run_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
readonly run_log="${tracking_private_dir}/logs/${run_id}.log"
touch "${run_log}"
chmod 0600 "${run_log}"
exec >>"${run_log}" 2>&1

trap 'printf "%s unexpected failure at line %s; inspect private log %s\n" "$(date -u +%FT%TZ)" "${LINENO}" "${run_log}" >&2' ERR

printf '%s starting exact-tenant server-host preservation run app=%s shop=%s\n' \
  "$(date -u +%FT%TZ)" "${TRACKING_APP_ID}" "${TRACKING_SHOP_DOMAIN}"

tracking_container="${TRACKING_CONTAINER:-}"
if [[ -z "${tracking_container}" ]]; then
  tracking_container="$(docker ps \
    --filter 'label=com.docker.compose.service=clever-route-api' \
    --format '{{.ID}}')"
fi
if [[ -z "${tracking_container}" ]]; then
  tracking_container="$(docker ps \
    --filter 'name=^/clever-route-clever-route-api-1$' \
    --format '{{.ID}}')"
fi
if [[ -z "${tracking_container}" && -n "${TRACKING_COMPOSE_FILE:-}" ]]; then
  [[ -f "${TRACKING_COMPOSE_FILE}" ]] || die "compose file was not found: ${TRACKING_COMPOSE_FILE}"
  tracking_container="$(docker compose -f "${TRACKING_COMPOSE_FILE}" ps -q clever-route-api)"
fi
[[ "${tracking_container}" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$ ]] \
  || die 'could not resolve exactly one API container name or id'
readonly tracking_container

readonly container_status="$(docker inspect -f '{{.State.Status}}' "${tracking_container}")"
[[ "${container_status}" == 'running' ]] || die "API container is not running: ${container_status}"
docker exec "${tracking_container}" sh -c "test -f '${REBUILD_COMMAND}'" \
  || die "deployed API image is missing ${REBUILD_COMMAND}"
docker exec "${tracking_container}" node "${REBUILD_COMMAND}" --help 2>&1 \
  | grep -F -- '--preserve-existing-road-cache' >/dev/null \
  || die 'deployed rebuild command does not support preservation mode'
docker exec "${tracking_container}" sh -c \
  'umask 077; mkdir -p "$1"; chmod 0700 "$1"' sh "${tracking_container_private_dir}"

readonly inventory_file="${tracking_private_dir}/state/${run_id}.inventory.json"
docker exec -i \
  -e TRACKING_APP_ID="${TRACKING_APP_ID}" \
  -e TRACKING_SHOP_DOMAIN="${TRACKING_SHOP_DOMAIN}" \
  "${tracking_container}" node --input-type=module >"${inventory_file}" <<'NODE'
import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { loadRouteTrackingEventWindow } from './dist/modules/route-tracking/route-tracking.event-window.js';

const prisma = new PrismaClient();
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const eventWindowValue = (eventWindow) => ({
  anchorSource: eventWindow.anchorSource,
  endExclusive: eventWindow.endExclusive.toISOString(),
  serviceDate: eventWindow.serviceDate,
  startInclusive: eventWindow.startInclusive.toISOString(),
  timezone: eventWindow.timezone,
});
const identityDigest = (route, eventWindow) => hash({
  assignmentGeneration: route.assignmentGeneration.toString(),
  driverId: route.driverId,
  eventWindow: eventWindowValue(eventWindow),
  planDate: route.planDate.toISOString().slice(0, 10),
  routeStops: route.routeStops.map((stop) => ({
    deliveryStopId: stop.deliveryStopId,
    sequence: stop.sequence,
    status: stop.deliveryStop.status,
  })),
  status: route.status,
});
const stateFingerprint = (route, eventWindow) => hash({
  identityDigest: identityDigest(route, eventWindow),
  job: route.trackingRoadMatchJob === null ? null : {
    completedAt: route.trackingRoadMatchJob.completedAt?.toISOString() ?? null,
    errorCode: route.trackingRoadMatchJob.errorCode,
    leaseExpiresAt: route.trackingRoadMatchJob.leaseExpiresAt?.toISOString() ?? null,
    leaseToken: route.trackingRoadMatchJob.leaseToken,
    status: route.trackingRoadMatchJob.status,
    targetLastInputOccurredAt: route.trackingRoadMatchJob.targetLastInputOccurredAt.toISOString(),
    targetSourcePointCount: route.trackingRoadMatchJob.targetSourcePointCount,
    updatedAt: route.trackingRoadMatchJob.updatedAt.toISOString(),
  },
  tracking: route.trackingGeometry === null ? null : {
    lastOccurredAt: route.trackingGeometry.lastOccurredAt.toISOString(),
    roadMatchedLastInputOccurredAt: route.trackingGeometry.roadMatchedLastInputOccurredAt?.toISOString() ?? null,
    roadMatchedSchemaVersion: route.trackingGeometry.roadMatchedSchemaVersion,
    roadMatchedSourcePointCount: route.trackingGeometry.roadMatchedSourcePointCount,
    roadMatchedWatermark: route.trackingGeometry.roadMatchedWatermark,
    sourcePointCount: route.trackingGeometry.sourcePointCount,
    updatedAt: route.trackingGeometry.updatedAt.toISOString(),
  },
});

try {
  const routes = await prisma.routePlan.findMany({
    orderBy: [{ planDate: 'asc' }, { id: 'asc' }],
    select: {
      assignmentGeneration: true,
      driverId: true,
      id: true,
      planDate: true,
      routeStops: {
        orderBy: { sequence: 'asc' },
        select: { deliveryStop: { select: { status: true } }, deliveryStopId: true, sequence: true },
      },
      status: true,
      trackingGeometry: {
        select: {
          roadMatchedLastInputOccurredAt: true,
          roadMatchedSchemaVersion: true,
          roadMatchedSourcePointCount: true,
          roadMatchedWatermark: true,
          lastOccurredAt: true,
          sourcePointCount: true,
          updatedAt: true,
        },
      },
      trackingRoadMatchJob: {
        select: {
          completedAt: true,
          errorCode: true,
          id: true,
          leaseExpiresAt: true,
          leaseToken: true,
          status: true,
          targetLastInputOccurredAt: true,
          targetSourcePointCount: true,
          updatedAt: true,
        },
      },
    },
    where: {
      shop: { appId: process.env.TRACKING_APP_ID, shopDomain: process.env.TRACKING_SHOP_DOMAIN },
      status: { in: ['COMPLETED', 'IN_PROGRESS'] },
    },
  });
  const now = new Date();
  const selected = [];
  for (const route of routes) {
    const eventWindow = await loadRouteTrackingEventWindow(prisma, route.id);
    if (eventWindow === null) throw new Error(`event window unavailable for route ${route.id}`);
    const staleInProgress = route.status === 'IN_PROGRESS' && eventWindow.endExclusive <= now;
    if (route.status !== 'COMPLETED' && !staleInProgress) continue;
    const geometry = route.trackingGeometry;
    if (geometry === null || geometry.sourcePointCount < 2) {
      throw new Error(`eligible route ${route.id} has no rebuildable tracking geometry`);
    }
    if (geometry.roadMatchedSchemaVersion !== 'route_tracking_road_match.v5'
      || geometry.roadMatchedSourcePointCount !== geometry.sourcePointCount
      || geometry.roadMatchedLastInputOccurredAt === null
      || geometry.roadMatchedLastInputOccurredAt.getTime() !== geometry.lastOccurredAt.getTime()) {
      throw new Error(`eligible route ${route.id} does not have a current v5 road cache`);
    }
    if (route.trackingRoadMatchJob === null) {
      throw new Error(`eligible route ${route.id} has no durable road-match job`);
    }
    const job = route.trackingRoadMatchJob;
    if (job.status !== 'SUCCEEDED'
      || job.targetSourcePointCount !== geometry.sourcePointCount
      || job.targetLastInputOccurredAt.getTime() !== geometry.lastOccurredAt.getTime()
      || job.leaseToken !== null || job.leaseExpiresAt !== null || job.errorCode !== null) {
      throw new Error(`eligible route ${route.id} does not have a settled durable road-match job`);
    }
    const sourcePointCount = await prisma.driverEvent.count({
      where: {
        eventType: 'LOCATION_UPDATED',
        latitude: { not: null },
        longitude: { not: null },
        occurredAt: { gte: eventWindow.startInclusive, lt: eventWindow.endExclusive },
        routePlanId: route.id,
      },
    });
    if (sourcePointCount !== geometry.sourcePointCount) {
      throw new Error(`eligible route ${route.id} raw source count does not match derived geometry`);
    }
    selected.push({
      eventWindowEndExclusive: eventWindow.endExclusive.toISOString(),
      identityDigest: identityDigest(route, eventWindow),
      routePlanId: route.id,
      routeStatus: route.status,
      sourcePointCount: geometry.sourcePointCount,
      stateFingerprint: stateFingerprint(route, eventWindow),
    });
  }
  process.stdout.write(`${JSON.stringify({ routes: selected })}\n`);
} finally {
  await prisma.$disconnect();
}
NODE
chmod 0600 "${inventory_file}"

readonly route_list="${tracking_private_dir}/state/${run_id}.routes.tsv"
python3 - "${inventory_file}" >"${route_list}" <<'PY'
import json
import re
import sys

with open(sys.argv[1], encoding='utf-8') as handle:
    payload = json.load(handle)
routes = payload.get('routes')
if not isinstance(routes, list):
    raise SystemExit('inventory did not contain a route list')
for route in routes:
    route_id = route.get('routePlanId', '')
    digest = route.get('identityDigest', '')
    fingerprint = route.get('stateFingerprint', '')
    if (not re.fullmatch(r'[0-9a-f-]{36}', route_id)
            or not re.fullmatch(r'[0-9a-f]{64}', digest)
            or not re.fullmatch(r'[0-9a-f]{64}', fingerprint)):
        raise SystemExit('inventory contained an invalid route identity')
    print('\t'.join((
        route_id,
        route.get('routeStatus', ''),
        digest,
        str(route.get('sourcePointCount', '')),
        route.get('eventWindowEndExclusive', ''),
        fingerprint,
    )))
PY
chmod 0600 "${route_list}"

json_field() {
  python3 - "$1" "$2" <<'PY'
import json
import sys

with open(sys.argv[1], encoding='utf-8') as handle:
    value = json.load(handle)
for key in sys.argv[2].split('.'):
    if not isinstance(value, dict) or key not in value:
        raise SystemExit(f'missing JSON field: {sys.argv[2]}')
    value = value[key]
if isinstance(value, bool):
    print('true' if value else 'false')
elif value is None:
    print('null')
else:
    print(value)
PY
}

write_current_route_state() {
  local route_plan_id="$1"
  local output_file="$2"
  docker exec -i \
    -e TRACKING_APP_ID="${TRACKING_APP_ID}" \
    -e TRACKING_SHOP_DOMAIN="${TRACKING_SHOP_DOMAIN}" \
    -e TRACKING_ROUTE_PLAN_ID="${route_plan_id}" \
    "${tracking_container}" node --input-type=module >"${output_file}" <<'NODE'
import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { loadRouteTrackingEventWindow } from './dist/modules/route-tracking/route-tracking.event-window.js';

const prisma = new PrismaClient();
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const eventWindowValue = (eventWindow) => ({
  anchorSource: eventWindow.anchorSource,
  endExclusive: eventWindow.endExclusive.toISOString(),
  serviceDate: eventWindow.serviceDate,
  startInclusive: eventWindow.startInclusive.toISOString(),
  timezone: eventWindow.timezone,
});
const identityDigest = (route, eventWindow) => hash({
  assignmentGeneration: route.assignmentGeneration.toString(),
  driverId: route.driverId,
  eventWindow: eventWindowValue(eventWindow),
  planDate: route.planDate.toISOString().slice(0, 10),
  routeStops: route.routeStops.map((stop) => ({
    deliveryStopId: stop.deliveryStopId,
    sequence: stop.sequence,
    status: stop.deliveryStop.status,
  })),
  status: route.status,
});
const stateFingerprint = (route, eventWindow) => hash({
  identityDigest: identityDigest(route, eventWindow),
  job: route.trackingRoadMatchJob === null ? null : {
    completedAt: route.trackingRoadMatchJob.completedAt?.toISOString() ?? null,
    errorCode: route.trackingRoadMatchJob.errorCode,
    leaseExpiresAt: route.trackingRoadMatchJob.leaseExpiresAt?.toISOString() ?? null,
    leaseToken: route.trackingRoadMatchJob.leaseToken,
    status: route.trackingRoadMatchJob.status,
    targetLastInputOccurredAt: route.trackingRoadMatchJob.targetLastInputOccurredAt.toISOString(),
    targetSourcePointCount: route.trackingRoadMatchJob.targetSourcePointCount,
    updatedAt: route.trackingRoadMatchJob.updatedAt.toISOString(),
  },
  tracking: route.trackingGeometry === null ? null : {
    lastOccurredAt: route.trackingGeometry.lastOccurredAt.toISOString(),
    roadMatchedLastInputOccurredAt: route.trackingGeometry.roadMatchedLastInputOccurredAt?.toISOString() ?? null,
    roadMatchedSchemaVersion: route.trackingGeometry.roadMatchedSchemaVersion,
    roadMatchedSourcePointCount: route.trackingGeometry.roadMatchedSourcePointCount,
    roadMatchedWatermark: route.trackingGeometry.roadMatchedWatermark,
    sourcePointCount: route.trackingGeometry.sourcePointCount,
    updatedAt: route.trackingGeometry.updatedAt.toISOString(),
  },
});
try {
  const route = await prisma.routePlan.findFirst({
    select: {
      assignmentGeneration: true,
      driverId: true,
      planDate: true,
      routeStops: {
        orderBy: { sequence: 'asc' },
        select: { deliveryStop: { select: { status: true } }, deliveryStopId: true, sequence: true },
      },
      status: true,
      trackingGeometry: {
        select: {
          lastOccurredAt: true,
          roadMatchedLastInputOccurredAt: true,
          roadMatchedSchemaVersion: true,
          roadMatchedSourcePointCount: true,
          roadMatchedWatermark: true,
          sourcePointCount: true,
          updatedAt: true,
        },
      },
      trackingRoadMatchJob: {
        select: {
          completedAt: true,
          errorCode: true,
          leaseExpiresAt: true,
          leaseToken: true,
          status: true,
          targetLastInputOccurredAt: true,
          targetSourcePointCount: true,
          updatedAt: true,
        },
      },
    },
    where: {
      id: process.env.TRACKING_ROUTE_PLAN_ID,
      shop: { appId: process.env.TRACKING_APP_ID, shopDomain: process.env.TRACKING_SHOP_DOMAIN },
    },
  });
  if (route === null) throw new Error('route identity is unavailable');
  const eventWindow = await loadRouteTrackingEventWindow(prisma, process.env.TRACKING_ROUTE_PLAN_ID);
  if (eventWindow === null) throw new Error('route event window is unavailable');
  const sourcePointCount = await prisma.driverEvent.count({
    where: {
      eventType: 'LOCATION_UPDATED',
      latitude: { not: null },
      longitude: { not: null },
      occurredAt: { gte: eventWindow.startInclusive, lt: eventWindow.endExclusive },
      routePlanId: process.env.TRACKING_ROUTE_PLAN_ID,
    },
  });
  process.stdout.write(`${JSON.stringify({
    eventWindowEndExclusive: eventWindow.endExclusive.toISOString(),
    identityDigest: identityDigest(route, eventWindow),
    routeStatus: route.status,
    sourcePointCount,
    stateFingerprint: stateFingerprint(route, eventWindow),
  })}\n`);
} finally {
  await prisma.$disconnect();
}
NODE
  chmod 0600 "${output_file}"
}

reviewed_state_matches() {
  local state_file="$1"
  local expected_identity_digest="$2"
  local expected_state_fingerprint="$3"
  local expected_source_count="$4"
  local dry_output_file="${5:-}"
  python3 - "${state_file}" "${expected_identity_digest}" "${expected_state_fingerprint}" \
    "${expected_source_count}" "${dry_output_file}" <<'PY'
from datetime import datetime, timezone
import json
import sys

with open(sys.argv[1], encoding='utf-8') as handle:
    state = json.load(handle)
if state.get('identityDigest') != sys.argv[2] or state.get('stateFingerprint') != sys.argv[3]:
    raise SystemExit(1)
if state.get('sourcePointCount') != int(sys.argv[4]):
    raise SystemExit(1)
status = state.get('routeStatus')
end_text = state.get('eventWindowEndExclusive')
try:
    end = datetime.fromisoformat(end_text.replace('Z', '+00:00'))
except (AttributeError, ValueError):
    raise SystemExit(1)
if status != 'COMPLETED' and not (status == 'IN_PROGRESS' and end <= datetime.now(timezone.utc)):
    raise SystemExit(1)
if sys.argv[5]:
    with open(sys.argv[5], encoding='utf-8') as handle:
        dry_run = json.load(handle)
    if dry_run.get('eventWindow', {}).get('endExclusive') != end_text:
        raise SystemExit(1)
PY
}

copy_and_verify_private_file() {
  local container_path="$1"
  local host_path="$2"
  local container_mode
  local container_sha
  local host_sha

  container_mode="$(docker exec "${tracking_container}" stat -c '%a' "${container_path}")"
  [[ "${container_mode}" == '600' ]] || die "container backup is not mode 0600: ${container_path}"
  docker cp "${tracking_container}:${container_path}" "${host_path}" >/dev/null
  chmod 0600 "${host_path}"
  container_sha="$(docker exec "${tracking_container}" sha256sum "${container_path}" | awk '{print $1}')"
  host_sha="$(sha256sum "${host_path}" | awk '{print $1}')"
  [[ "${container_sha}" == "${host_sha}" ]] || die "backup SHA-256 mismatch: ${container_path}"
  printf '%s\n' "${host_sha}"
}

write_checkpoint() {
  local path="$1"
  shift
  {
    printf 'completedAt=%s\n' "$(date -u +%FT%TZ)"
    printf '%s\n' "$@"
  } >"${path}.tmp"
  chmod 0600 "${path}.tmp"
  mv "${path}.tmp" "${path}"
}

checkpoint_value() {
  local path="$1"
  local key="$2"
  awk -F= -v wanted="${key}" '$1 == wanted { print $2 }' "${path}"
}

route_count="$(wc -l <"${route_list}" | tr -d ' ')"
printf '%s selected %s completed-or-stale routes; concurrency=1\n' "$(date -u +%FT%TZ)" "${route_count}"

while IFS=$'\t' read -r route_plan_id route_status identity_digest expected_source_count event_window_end expected_state_fingerprint; do
  [[ -n "${route_plan_id}" ]] || continue
  checkpoint="${tracking_private_dir}/state/${route_plan_id}.done"
  apply_pending="${tracking_private_dir}/state/${route_plan_id}.apply-pending"
  if [[ -f "${apply_pending}" ]]; then
    pending_review_state="${tracking_private_dir}/state/${route_plan_id}.${run_id}.pending-review.json"
    write_current_route_state "${route_plan_id}" "${pending_review_state}"
    pending_current_fingerprint="$(json_field "${pending_review_state}" 'stateFingerprint')"
    pending_current_source_count="$(json_field "${pending_review_state}" 'sourcePointCount')"
    completed_fingerprint=''
    if [[ -f "${checkpoint}" ]]; then
      completed_fingerprint="$(checkpoint_value "${checkpoint}" 'stateFingerprint')"
    fi
    if [[ -n "${completed_fingerprint}"
      && "${completed_fingerprint}" == "${pending_current_fingerprint}"
      && "${pending_current_source_count}" == "${expected_source_count}" ]]; then
      rm -f "${apply_pending}"
      printf '%s route=%s result=recovered-completed-pending\n' "$(date -u +%FT%TZ)" "${route_plan_id}"
    else
      die "route ${route_plan_id} has an unresolved apply-pending marker; follow the runbook recovery procedure"
    fi
  fi
  if [[ -f "${checkpoint}" ]]; then
    checkpoint_fingerprint="$(checkpoint_value "${checkpoint}" 'stateFingerprint')"
    if [[ "${checkpoint_fingerprint}" == "${expected_state_fingerprint}" ]]; then
      printf '%s route=%s result=already-done-current-state\n' "$(date -u +%FT%TZ)" "${route_plan_id}"
      continue
    fi
    printf '%s route=%s result=checkpoint-stale-replanning\n' "$(date -u +%FT%TZ)" "${route_plan_id}"
  fi

  route_backup_dir="${tracking_private_dir}/backups/${route_plan_id}"
  install -d -m 0700 "${route_backup_dir}"
  container_backup="${tracking_container_private_dir}/${route_plan_id}-${run_id}.json"
  host_backup="${route_backup_dir}/${run_id}.reviewed.json"
  dry_output="${route_backup_dir}/${run_id}.dry-run.json"
  dry_error="${route_backup_dir}/${run_id}.dry-run.stderr"
  reviewed_state_file="${route_backup_dir}/${run_id}.reviewed-state.json"
  touch "${dry_output}" "${dry_error}"
  chmod 0600 "${dry_output}" "${dry_error}"

  printf '%s route=%s status=%s windowEnd=%s phase=dry-run\n' \
    "$(date -u +%FT%TZ)" "${route_plan_id}" "${route_status}" "${event_window_end}"
  if ! docker exec -e OSRM_TIMEOUT_MS="${TRACKING_OSRM_TIMEOUT_MS:-30000}" \
    "${tracking_container}" node "${REBUILD_COMMAND}" \
      --app-id "${TRACKING_APP_ID}" \
      --shop-domain "${TRACKING_SHOP_DOMAIN}" \
      --route-plan-id "${route_plan_id}" \
      --backup-file "${container_backup}" \
      --preserve-existing-road-cache >"${dry_output}" 2>"${dry_error}"; then
    if grep -F 'Preservation rebuild found no new non-overlapping Level 0/1 road line' \
      "${dry_error}" >/dev/null; then
      write_current_route_state "${route_plan_id}" "${reviewed_state_file}"
      if ! reviewed_state_matches "${reviewed_state_file}" \
        "${identity_digest}" "${expected_state_fingerprint}" "${expected_source_count}"; then
        write_checkpoint "${tracking_private_dir}/state/${route_plan_id}.retryable" \
          'result=SKIPPED_STALE' "routePlanId=${route_plan_id}"
        printf '%s route=%s result=skipped-stale-no-gain-audit\n' "$(date -u +%FT%TZ)" "${route_plan_id}"
        continue
      fi
      write_checkpoint "${checkpoint}" \
        'result=SKIPPED_NO_GAIN' \
        "routePlanId=${route_plan_id}" \
        "stateFingerprint=${expected_state_fingerprint}"
      rm -f "${tracking_private_dir}/state/${route_plan_id}.retryable"
      printf '%s route=%s result=skipped-no-gain\n' "$(date -u +%FT%TZ)" "${route_plan_id}"
      continue
    fi
    if grep -F -e 'OSRM route-tracking match was incomplete or retryable' \
      -e 'OSRM did not produce a usable route-tracking match' "${dry_error}" >/dev/null; then
      write_checkpoint "${tracking_private_dir}/state/${route_plan_id}.retryable" \
        'result=SKIPPED_RETRYABLE' "routePlanId=${route_plan_id}"
      printf '%s route=%s result=skipped-retryable\n' "$(date -u +%FT%TZ)" "${route_plan_id}"
      continue
    fi
    die "unexpected dry-run failure for route ${route_plan_id}; inspect ${dry_error}"
  fi

  write_current_route_state "${route_plan_id}" "${reviewed_state_file}"
  if ! reviewed_state_matches "${reviewed_state_file}" \
    "${identity_digest}" "${expected_state_fingerprint}" "${expected_source_count}" "${dry_output}"; then
    write_checkpoint "${tracking_private_dir}/state/${route_plan_id}.retryable" \
      'result=SKIPPED_STALE' "routePlanId=${route_plan_id}"
    printf '%s route=%s result=skipped-stale-identity\n' "$(date -u +%FT%TZ)" "${route_plan_id}"
    continue
  fi

  reviewed_backup_sha="$(copy_and_verify_private_file "${container_backup}" "${host_backup}")"
  reported_backup_sha="$(json_field "${dry_output}" 'backup.sha256')"
  [[ "${reviewed_backup_sha}" == "${reported_backup_sha}" ]] \
    || die "reported backup SHA-256 mismatch for route ${route_plan_id}"
  dry_source_count="$(json_field "${dry_output}" 'after.sourcePointCount')"
  [[ "${dry_source_count}" == "${expected_source_count}" ]] \
    || die "source count changed after inventory for route ${route_plan_id}"

  plan_hash="$(json_field "${dry_output}" 'planHash')"
  [[ "${plan_hash}" =~ ^[0-9a-f]{64}$ ]] || die "invalid plan hash for route ${route_plan_id}"
  planned_watermark="$(json_field "${dry_output}" 'plannedRoadMatchedWatermark')"
  apply_output="${route_backup_dir}/${run_id}.apply.json"
  apply_error="${route_backup_dir}/${run_id}.apply.stderr"
  touch "${apply_output}" "${apply_error}"
  chmod 0600 "${apply_output}" "${apply_error}"

  printf '%s route=%s phase=apply\n' "$(date -u +%FT%TZ)" "${route_plan_id}"
  write_checkpoint "${apply_pending}" \
    'result=APPLY_PENDING' \
    "routePlanId=${route_plan_id}" \
    "planHash=${plan_hash}" \
    "preApplyStateFingerprint=${expected_state_fingerprint}" \
    "reviewedBackupFile=${host_backup}" \
    "reviewedBackupSha256=${reviewed_backup_sha}"
  if ! docker exec -e OSRM_TIMEOUT_MS="${TRACKING_OSRM_TIMEOUT_MS:-30000}" \
    "${tracking_container}" node "${REBUILD_COMMAND}" \
      --app-id "${TRACKING_APP_ID}" \
      --shop-domain "${TRACKING_SHOP_DOMAIN}" \
      --route-plan-id "${route_plan_id}" \
      --backup-file "${container_backup}" \
      --backup-sha256 "${reviewed_backup_sha}" \
      --plan-hash "${plan_hash}" \
      --preserve-existing-road-cache \
      --apply >"${apply_output}" 2>"${apply_error}"; then
    if grep -F -e 'OSRM route-tracking match was incomplete or retryable' \
      -e 'OSRM did not produce a usable route-tracking match' "${apply_error}" >/dev/null; then
      write_checkpoint "${tracking_private_dir}/state/${route_plan_id}.retryable" \
        'result=SKIPPED_RETRYABLE' "routePlanId=${route_plan_id}"
      rm -f "${apply_pending}"
      printf '%s route=%s result=skipped-retryable-apply\n' "$(date -u +%FT%TZ)" "${route_plan_id}"
      continue
    fi
    if grep -F -e 'Route identity, route status, assignment, or stop status changed after review' \
      -e 'Reviewed plan hash does not match the current approved source prefix and proposed output' \
      -e 'Reviewed source prefix no longer matches the planned source prefix' \
      -e 'Source event prefix shrank after review' \
      -e 'Source event prefix changed or received an out-of-order insertion after review' \
      -e 'A source event was inserted into the reviewed prefix; apply aborted' \
      -e 'Eligible GPS source changed after review; run a new dry-run before apply' \
      -e 'Route tracking event window or timezone changed after review' \
      -e 'Current derived tracking state changed after review; preservation apply aborted' \
      "${apply_error}" >/dev/null; then
      write_checkpoint "${tracking_private_dir}/state/${route_plan_id}.retryable" \
        'result=SKIPPED_STALE' "routePlanId=${route_plan_id}"
      rm -f "${apply_pending}"
      printf '%s route=%s result=skipped-stale\n' "$(date -u +%FT%TZ)" "${route_plan_id}"
      continue
    fi
    die "guarded apply failed for route ${route_plan_id}; inspect ${apply_error}"
  fi

  prewrite_container="$(json_field "${apply_output}" 'prewriteBackupFile')"
  [[ "${prewrite_container}" == "${container_backup}.prewrite-"*.json ]] \
    || die "unexpected prewrite backup path for route ${route_plan_id}"
  prewrite_host="${route_backup_dir}/${run_id}.prewrite.json"
  prewrite_sha="$(copy_and_verify_private_file "${prewrite_container}" "${prewrite_host}")"

  audit_output="${route_backup_dir}/${run_id}.post-audit.json"
  audit_error="${route_backup_dir}/${run_id}.post-audit.stderr"
  touch "${audit_output}" "${audit_error}"
  chmod 0600 "${audit_output}" "${audit_error}"
  if ! docker exec -i \
    -e TRACKING_APP_ID="${TRACKING_APP_ID}" \
    -e TRACKING_SHOP_DOMAIN="${TRACKING_SHOP_DOMAIN}" \
    -e TRACKING_ROUTE_PLAN_ID="${route_plan_id}" \
    -e TRACKING_EXPECTED_IDENTITY_DIGEST="${identity_digest}" \
    -e TRACKING_EXPECTED_SOURCE_COUNT="${expected_source_count}" \
    -e TRACKING_EXPECTED_WATERMARK="${planned_watermark}" \
    "${tracking_container}" node --input-type=module >"${audit_output}" 2>"${audit_error}" <<'NODE'
import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { loadRouteTrackingEventWindow } from './dist/modules/route-tracking/route-tracking.event-window.js';

const prisma = new PrismaClient();
const fail = (message) => { throw new Error(message); };
const sameInstant = (left, right) => left instanceof Date && right instanceof Date && left.getTime() === right.getTime();
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const eventWindowValue = (eventWindow) => ({
  anchorSource: eventWindow.anchorSource,
  endExclusive: eventWindow.endExclusive.toISOString(),
  serviceDate: eventWindow.serviceDate,
  startInclusive: eventWindow.startInclusive.toISOString(),
  timezone: eventWindow.timezone,
});
const identityDigest = (route, eventWindow) => hash({
  assignmentGeneration: route.assignmentGeneration.toString(),
  driverId: route.driverId,
  eventWindow: eventWindowValue(eventWindow),
  planDate: route.planDate.toISOString().slice(0, 10),
  routeStops: route.routeStops.map((stop) => ({
    deliveryStopId: stop.deliveryStopId,
    sequence: stop.sequence,
    status: stop.deliveryStop.status,
  })),
  status: route.status,
});
const stateFingerprint = (route, eventWindow) => hash({
  identityDigest: identityDigest(route, eventWindow),
  job: {
    completedAt: route.trackingRoadMatchJob.completedAt?.toISOString() ?? null,
    errorCode: route.trackingRoadMatchJob.errorCode,
    leaseExpiresAt: route.trackingRoadMatchJob.leaseExpiresAt?.toISOString() ?? null,
    leaseToken: route.trackingRoadMatchJob.leaseToken,
    status: route.trackingRoadMatchJob.status,
    targetLastInputOccurredAt: route.trackingRoadMatchJob.targetLastInputOccurredAt.toISOString(),
    targetSourcePointCount: route.trackingRoadMatchJob.targetSourcePointCount,
    updatedAt: route.trackingRoadMatchJob.updatedAt.toISOString(),
  },
  tracking: {
    lastOccurredAt: route.trackingGeometry.lastOccurredAt.toISOString(),
    roadMatchedLastInputOccurredAt: route.trackingGeometry.roadMatchedLastInputOccurredAt?.toISOString() ?? null,
    roadMatchedSchemaVersion: route.trackingGeometry.roadMatchedSchemaVersion,
    roadMatchedSourcePointCount: route.trackingGeometry.roadMatchedSourcePointCount,
    roadMatchedWatermark: route.trackingGeometry.roadMatchedWatermark,
    sourcePointCount: route.trackingGeometry.sourcePointCount,
    updatedAt: route.trackingGeometry.updatedAt.toISOString(),
  },
});

try {
  const route = await prisma.routePlan.findFirst({
    select: {
      assignmentGeneration: true,
      driverId: true,
      id: true,
      planDate: true,
      routeStops: {
        orderBy: { sequence: 'asc' },
        select: { deliveryStop: { select: { status: true } }, deliveryStopId: true, sequence: true },
      },
      status: true,
      trackingGeometry: true,
      trackingRoadMatchJob: true,
    },
    where: {
      id: process.env.TRACKING_ROUTE_PLAN_ID,
      shop: { appId: process.env.TRACKING_APP_ID, shopDomain: process.env.TRACKING_SHOP_DOMAIN },
    },
  });
  if (route === null) fail('route identity disappeared after apply');
  const geometry = route.trackingGeometry;
  const job = route.trackingRoadMatchJob;
  if (geometry === null || job === null) fail('derived geometry or durable job is missing');
  const eventWindow = await loadRouteTrackingEventWindow(prisma, route.id);
  if (eventWindow === null) fail('event window is unavailable after apply');
  if (identityDigest(route, eventWindow) !== process.env.TRACKING_EXPECTED_IDENTITY_DIGEST) {
    fail('route, stop, plan date, or event window state changed');
  }
  const sourcePointCount = await prisma.driverEvent.count({
    where: {
      eventType: 'LOCATION_UPDATED',
      latitude: { not: null },
      longitude: { not: null },
      occurredAt: { gte: eventWindow.startInclusive, lt: eventWindow.endExclusive },
      routePlanId: route.id,
    },
  });
  const expectedSourceCount = Number(process.env.TRACKING_EXPECTED_SOURCE_COUNT);
  if (sourcePointCount !== expectedSourceCount
    || geometry.sourcePointCount !== sourcePointCount
    || geometry.roadMatchedSourcePointCount !== sourcePointCount) fail('source/cache point counts disagree');
  if (!sameInstant(geometry.lastOccurredAt, geometry.roadMatchedLastInputOccurredAt)) fail('cache input timestamp is stale');
  if (geometry.roadMatchedSchemaVersion !== 'route_tracking_road_match.v5') fail('cache schema is not v5');
  if (geometry.roadMatchedWatermark !== process.env.TRACKING_EXPECTED_WATERMARK) fail('cache watermark differs from reviewed plan');
  if (job.status !== 'SUCCEEDED'
    || job.targetSourcePointCount !== sourcePointCount
    || !sameInstant(job.targetLastInputOccurredAt, geometry.lastOccurredAt)
    || job.leaseToken !== null || job.leaseExpiresAt !== null || job.errorCode !== null) {
    fail('durable job settlement does not match the published cache');
  }
  process.stdout.write(`${JSON.stringify({
    cacheSchemaVersion: geometry.roadMatchedSchemaVersion,
    jobStatus: job.status,
    ok: true,
    routePlanId: route.id,
    routeStatus: route.status,
    sourcePointCount,
    stateFingerprint: stateFingerprint(route, eventWindow),
  })}\n`);
} finally {
  await prisma.$disconnect();
}
NODE
  then
    die "post-apply audit failed for route ${route_plan_id}; inspect ${audit_error}"
  fi

  mutation_count="$(json_field "${apply_output}" 'mutationCount')"
  [[ "${mutation_count}" == '0' || "${mutation_count}" == '1' ]] \
    || die "unexpected mutation count for route ${route_plan_id}"
  audited_state_fingerprint="$(json_field "${audit_output}" 'stateFingerprint')"
  [[ "${audited_state_fingerprint}" =~ ^[0-9a-f]{64}$ ]] \
    || die "post-audit state fingerprint is invalid for route ${route_plan_id}"
  write_checkpoint "${checkpoint}" \
    "result=APPLIED" \
    "routePlanId=${route_plan_id}" \
    "mutationCount=${mutation_count}" \
    "planHash=${plan_hash}" \
    "plannedWatermark=${planned_watermark}" \
    "reviewedBackupSha256=${reviewed_backup_sha}" \
    "prewriteBackupSha256=${prewrite_sha}" \
    "stateFingerprint=${audited_state_fingerprint}"
  rm -f "${apply_pending}"
  rm -f "${tracking_private_dir}/state/${route_plan_id}.retryable"
  printf '%s route=%s result=applied mutationCount=%s\n' \
    "$(date -u +%FT%TZ)" "${route_plan_id}" "${mutation_count}"
done <"${route_list}"

printf '%s completed server-host preservation run; privateLog=%s\n' "$(date -u +%FT%TZ)" "${run_log}"
