#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/srv/clever-route-server}"
COMPOSE_FILE="${COMPOSE_FILE:-infra/compose/docker-compose.prod.yml}"
ROUTE_OPS_COMPOSE_PROJECT_NAME="${ROUTE_OPS_COMPOSE_PROJECT_NAME:-clever-route}"
BASE_URL="${ROUTE_OPS_SMOKE_BASE_URL:-https://clever-route.cleversystem.ai}"
SHOP_DOMAIN="${ROUTE_OPS_SMOKE_SHOP_DOMAIN:-tomatonofood.com}"
: "${ROUTE_OPS_SMOKE_LOGIN_SECRET:?ROUTE_OPS_SMOKE_LOGIN_SECRET is required locally for rollback smoke}"

cd "$APP_DIR"
export ROUTE_OPS_COMPOSE_PROJECT_NAME
export COMPOSE_PROJECT_NAME="$ROUTE_OPS_COMPOSE_PROJECT_NAME"

LOCK_PATH="${ROUTE_OPS_DEPLOY_LOCK_PATH:-.deploy/route-ops-deploy.lock}"
LOCK_DIR="${LOCK_PATH}.d"
LOCK_ACQUIRED="false"
ROUTE_OPS_WEB_STATIC_IMAGE_REPO="${ROUTE_OPS_WEB_STATIC_IMAGE_REPO:-ghcr.io/evnsolution/clever-route-server-route-ops-web-static}"
ROUTE_ENGINE_IMAGE_REPO="${ROUTE_ENGINE_IMAGE_REPO:-ghcr.io/evnsolution/route-engine-worker}"
ROUTE_ENGINE_IMAGE="${ROUTE_ENGINE_IMAGE:-${ROUTE_ENGINE_IMAGE_REPO}:3aa41c5f068b457d6881a0d46922156c43b68f98}"
ROUTE_ENGINE_GRAPH_HOST_DIR="${ROUTE_ENGINE_GRAPH_HOST_DIR:-/srv/clever-route-server/data/route-engine/parquet}"
export ROUTE_ENGINE_GRAPH_HOST_DIR ROUTE_ENGINE_IMAGE
ROUTE_OPS_ROLLBACK_STATIC_ARTIFACT_STAGED="false"
ROUTE_OPS_ROLLBACK_SERVICE_MUTATED="false"

release_deploy_lock() {
  if [ "$LOCK_ACQUIRED" = "mkdir" ] && [ -d "$LOCK_DIR" ]; then
    rmdir "$LOCK_DIR" || true
  fi
}

route_ops_compose() {
  require_route_ops_compose_project_name
  local image_env_file="$1"
  shift
  docker compose -p "$ROUTE_OPS_COMPOSE_PROJECT_NAME" --env-file "$image_env_file" -f "$COMPOSE_FILE" "$@"
}

require_route_ops_compose_project_name() {
  if [ "$ROUTE_OPS_COMPOSE_PROJECT_NAME" != "clever-route" ]; then
    echo "ROUTE_OPS_COMPOSE_PROJECT_NAME must be exactly clever-route for production Route Ops rollback; got: ${ROUTE_OPS_COMPOSE_PROJECT_NAME}" >&2
    exit 64
  fi
}

enforce_no_legacy_route_ops_compose_project() {
  require_route_ops_compose_project_name
  local offenders=""
  local name project service ports
  while IFS='|' read -r name project service ports || [ -n "$name" ]; do
    [ -n "${name:-}" ] || continue
    if [ "$project" = "compose" ]; then
      case "$service" in
        caddy|delivery-api|delivery-api-migrate|postgres|osrm-ontario|route-engine)
          offenders="${offenders}${name} service=${service} ports=${ports:-none}"$'\n'
          ;;
      esac
    fi
  done < <(docker ps --format '{{.Names}}|{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.service"}}|{{.Ports}}')
  if [ -n "$offenders" ]; then
    echo "Refusing Route Ops rollback because legacy implicit compose project containers are still running." >&2
    echo "Run the compose-project migration preflight/cutover first; do not rollback over project=compose." >&2
    printf '%s' "$offenders" >&2
    exit 78
  fi
}

require_route_ops_compose_project_name

acquire_deploy_lock() {
  mkdir -p .deploy
  if [ "${ROUTE_OPS_DEPLOY_LOCK_HELD:-}" = "1" ]; then
    return 0
  fi
  if [ "${ROUTE_OPS_DEPLOY_LOCK_FORCE_MKDIR:-}" != "1" ] && command -v flock >/dev/null 2>&1; then
    exec 9>"$LOCK_PATH"
    if ! flock -n 9; then
      echo "Another Route Ops deploy or rollback is already running." >&2
      exit 75
    fi
    LOCK_ACQUIRED="flock"
    export ROUTE_OPS_DEPLOY_LOCK_HELD=1
    return 0
  fi
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    echo "Another Route Ops deploy or rollback is already running." >&2
    exit 75
  fi
  LOCK_ACQUIRED="mkdir"
  export ROUTE_OPS_DEPLOY_LOCK_HELD=1
}

validate_image_env_file() {
  local file="$1"
  test -f "$file"
  while IFS= read -r line || [ -n "$line" ]; do
    [ -z "$line" ] && continue
    case "$line" in
      IMAGE_TAG=*|DELIVERY_API_IMAGE=*|DELIVERY_API_MIGRATE_IMAGE=*|ROUTE_OPS_WEB_STATIC_IMAGE=*|ROUTE_OPS_WEB_STATIC_VOLUME=*|ROUTE_ENGINE_IMAGE=*|ROUTE_ENGINE_GRAPH_HOST_DIR=*|PRISMA_SCHEMA_SHA=*) ;;
      *) echo "Invalid image env key in $file: ${line%%=*}" >&2; return 1 ;;
    esac
    local value="${line#*=}"
    if ! [[ "$value" =~ ^[A-Za-z0-9._:@/+=-]+$ ]]; then
      echo "Invalid image env value characters in $file for ${line%%=*}" >&2
      return 1
    fi
  done < "$file"
}

load_image_env_file() {
  local file="$1"
  validate_image_env_file "$file"
  set -a
  # shellcheck disable=SC1090
  source "$file"
  if [ -z "${ROUTE_OPS_WEB_STATIC_IMAGE:-}" ] && [ -n "${IMAGE_TAG:-}" ] && [[ "$IMAGE_TAG" =~ ^[0-9a-fA-F]{40}$ ]]; then
    ROUTE_OPS_WEB_STATIC_IMAGE="${ROUTE_OPS_WEB_STATIC_IMAGE_REPO}:${IMAGE_TAG}"
    export ROUTE_OPS_WEB_STATIC_IMAGE
  fi
  if [ -z "${ROUTE_OPS_WEB_STATIC_VOLUME:-}" ] && [ -n "${IMAGE_TAG:-}" ] && [[ "$IMAGE_TAG" =~ ^[0-9a-fA-F]{40}$ ]]; then
    ROUTE_OPS_WEB_STATIC_VOLUME="clever-route-route-ops-web-static-${IMAGE_TAG}"
    export ROUTE_OPS_WEB_STATIC_VOLUME
  fi
  if [ -z "${ROUTE_ENGINE_IMAGE:-}" ]; then
    ROUTE_ENGINE_IMAGE="${ROUTE_ENGINE_IMAGE_REPO}:3aa41c5f068b457d6881a0d46922156c43b68f98"
    export ROUTE_ENGINE_IMAGE
  fi
  if [ -z "${ROUTE_ENGINE_GRAPH_HOST_DIR:-}" ]; then
    ROUTE_ENGINE_GRAPH_HOST_DIR="/srv/clever-route-server/data/route-engine/parquet"
    export ROUTE_ENGINE_GRAPH_HOST_DIR
  fi
  set +a
}

ensure_static_artifact_env_file() {
  local file="$1"
  test -f "$file"
  local image_tag
  image_tag="$(grep -m1 '^IMAGE_TAG=' "$file" | cut -d= -f2- || true)"
  if [ -z "$image_tag" ] || ! [[ "$image_tag" =~ ^[0-9a-fA-F]{40}$ ]]; then
    echo "Cannot derive Route Ops static artifact metadata for rollback without a 40-hex IMAGE_TAG in $file." >&2
    exit 65
  fi
  if ! grep -q '^ROUTE_OPS_WEB_STATIC_IMAGE=' "$file"; then
    printf 'ROUTE_OPS_WEB_STATIC_IMAGE=%s:%s\n' "$ROUTE_OPS_WEB_STATIC_IMAGE_REPO" "$image_tag" >> "$file"
  fi
  if ! grep -q '^ROUTE_OPS_WEB_STATIC_VOLUME=' "$file"; then
    printf 'ROUTE_OPS_WEB_STATIC_VOLUME=clever-route-route-ops-web-static-%s\n' "$image_tag" >> "$file"
  fi
  if ! grep -q '^ROUTE_ENGINE_IMAGE=' "$file"; then
    printf 'ROUTE_ENGINE_IMAGE=%s\n' "$ROUTE_ENGINE_IMAGE" >> "$file"
  fi
  if ! grep -q '^ROUTE_ENGINE_GRAPH_HOST_DIR=' "$file"; then
    printf 'ROUTE_ENGINE_GRAPH_HOST_DIR=%s\n' "$ROUTE_ENGINE_GRAPH_HOST_DIR" >> "$file"
  fi
}
expected_static_volume_for_tag() {
  local image_tag="$1"
  printf 'clever-route-route-ops-web-static-%s
' "$image_tag"
}

validate_loaded_static_artifact_contract() {
  local file="$1"
  : "${IMAGE_TAG:?IMAGE_TAG must be loaded before static artifact validation}"
  : "${ROUTE_OPS_WEB_STATIC_IMAGE:?ROUTE_OPS_WEB_STATIC_IMAGE must be loaded before static artifact validation}"
  : "${ROUTE_OPS_WEB_STATIC_VOLUME:?ROUTE_OPS_WEB_STATIC_VOLUME must be loaded before static artifact validation}"
  if ! [[ "$IMAGE_TAG" =~ ^[0-9a-fA-F]{40}$ ]]; then
    echo "Invalid IMAGE_TAG in $file for Route Ops static artifact validation." >&2
    exit 65
  fi
  if [ "$ROUTE_OPS_WEB_STATIC_IMAGE" != "${ROUTE_OPS_WEB_STATIC_IMAGE_REPO}:${IMAGE_TAG}" ]; then
    echo "ROUTE_OPS_WEB_STATIC_IMAGE must match IMAGE_TAG in $file." >&2
    exit 65
  fi
  local expected_volume
  expected_volume="$(expected_static_volume_for_tag "$IMAGE_TAG")"
  if [ "$ROUTE_OPS_WEB_STATIC_VOLUME" != "$expected_volume" ]; then
    echo "ROUTE_OPS_WEB_STATIC_VOLUME must be ${expected_volume} in $file." >&2
    exit 65
  fi
}

require_candidate_static_volume_isolated_from_rollback_from() {
  local rollback_from_file="$1"
  [ -f "$rollback_from_file" ] || return 0
  local rollback_from_tag rollback_from_volume
  rollback_from_tag="$(grep -m1 '^IMAGE_TAG=' "$rollback_from_file" | cut -d= -f2- || true)"
  rollback_from_volume="$(grep -m1 '^ROUTE_OPS_WEB_STATIC_VOLUME=' "$rollback_from_file" | cut -d= -f2- || true)"
  if [ -n "$rollback_from_tag" ] && [ "$rollback_from_tag" != "$IMAGE_TAG" ] && [ -n "$rollback_from_volume" ] && [ "$rollback_from_volume" = "$ROUTE_OPS_WEB_STATIC_VOLUME" ]; then
    echo "Refusing Route Ops rollback: candidate static volume matches pre-rollback current static volume for a different image tag." >&2
    exit 65
  fi
}


ensure_route_ops_ingress() {
  echo "Ensuring Route Ops Caddy ingress uses this repo's production Caddyfile under compose project ${ROUTE_OPS_COMPOSE_PROJECT_NAME}."
  route_ops_compose .deploy/candidate-image.env up -d --no-build --force-recreate --no-deps caddy
}

read_route_ops_host_env_value() {
  local key value
  key="$1"
  value=""
  if [ -f infra/env/delivery-api.env ]; then
    value="$(awk -F= -v key="$key" '
      /^[[:space:]]*#/ { next }
      $1 == key { print substr($0, index($0, "=") + 1); exit }
    ' infra/env/delivery-api.env)"
  fi
  value="${value%%#*}"
  printf '%s' "$value" | tr -d '[:space:]' | sed -e "s/^['\"]//" -e "s/['\"]$//"
}

route_ops_osrm_configured() {
  local osrm_base_url
  osrm_base_url="$(read_route_ops_host_env_value OSRM_BASE_URL)"
  [ -n "$osrm_base_url" ]
}

route_ops_osrm_enabled_json() {
  if route_ops_osrm_configured; then
    printf 'true'
  else
    printf 'false'
  fi
}

route_engine_configured() {
  local route_engine_base_url
  route_engine_base_url="$(read_route_ops_host_env_value ROUTE_ENGINE_BASE_URL)"
  [ -n "$route_engine_base_url" ]
}

route_engine_enabled_json() {
  if route_engine_configured; then
    printf 'true'
  else
    printf 'false'
  fi
}

validate_route_engine_image() {
  if ! [[ "${ROUTE_ENGINE_IMAGE:-}" =~ ^ghcr\.io/evnsolution/route-engine-worker:[0-9a-fA-F]{40}$ ]]; then
    echo "ROUTE_ENGINE_IMAGE must be the approved route_engine worker GHCR image with SHA tag; got: ${ROUTE_ENGINE_IMAGE:-unset}" >&2
    exit 65
  fi
}

route_ops_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$@"
    return 0
  fi
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$@"
    return 0
  fi
  echo "sha256sum or shasum is required for Route Engine graph manifest validation." >&2
  return 1
}

route_engine_image_graph_manifest_sha() {
  docker image inspect --format '{{ index .Config.Labels "org.clever-route.graph-manifest-sha" }}' "$ROUTE_ENGINE_IMAGE"
}

route_engine_host_graph_manifest_sha() {
  local graph_dir="$1"
  local manifest_file
  manifest_file="$(mktemp ".deploy/route-engine-graph-manifest.XXXXXX")"
  find "$graph_dir" -maxdepth 1 -type f -name '*.parquet' -print | sort | while IFS= read -r graph_file; do
    route_ops_sha256 "$graph_file" | awk -v name="$(basename "$graph_file")" '{ print $1 "  routing_engine/v7_out/parquet/" name }'
  done > "$manifest_file"
  route_ops_sha256 "$manifest_file" | awk '{ print $1 }'
  rm -f "$manifest_file"
}

validate_route_engine_graph_artifacts() {
  local expected_manifest_sha graph_dir graph_files actual_manifest_sha lfs_pointer_file
  expected_manifest_sha="$1"
  graph_dir="${ROUTE_ENGINE_GRAPH_HOST_DIR:-/srv/clever-route-server/data/route-engine/parquet}"
  if ! [[ "$expected_manifest_sha" =~ ^[0-9a-fA-F]{64}$ ]]; then
    echo "ROUTE_ENGINE_IMAGE must carry org.clever-route.graph-manifest-sha; got: ${expected_manifest_sha:-unset}" >&2
    exit 65
  fi
  if [ ! -d "$graph_dir" ]; then
    echo "Route Engine graph directory is missing: ${graph_dir}" >&2
    exit 66
  fi
  graph_files="$(find "$graph_dir" -maxdepth 1 -type f -name '*.parquet' -print | sort)"
  if [ -z "$graph_files" ]; then
    echo "Route Engine graph directory has no parquet artifacts: ${graph_dir}" >&2
    exit 66
  fi
  lfs_pointer_file="$(while IFS= read -r graph_file; do
    if head -n 1 "$graph_file" 2>/dev/null | grep -q '^version https://git-lfs.github.com/spec/v1'; then
      printf '%s\n' "$graph_file"
      break
    fi
  done <<EOF_GRAPH_FILES
$graph_files
EOF_GRAPH_FILES
)"
  if [ -n "$lfs_pointer_file" ]; then
    echo "Route Engine graph artifact is still a Git LFS pointer, not parquet data: ${lfs_pointer_file}" >&2
    exit 66
  fi
  actual_manifest_sha="$(route_engine_host_graph_manifest_sha "$graph_dir")"
  if [ "$actual_manifest_sha" != "$expected_manifest_sha" ]; then
    echo "Route Engine graph manifest mismatch for ${graph_dir}: expected=${expected_manifest_sha} actual=${actual_manifest_sha}" >&2
    exit 66
  fi
  echo "Route Engine graph artifacts verified: dir=${graph_dir} manifest=${expected_manifest_sha}"
}

smoke_route_engine_from_runtime_network() {
  local image_env_file
  image_env_file="$1"
  echo "Smoking route_engine from the delivery-api runtime network."
  route_ops_compose "$image_env_file" run --rm --no-deps delivery-api node - <<'NODE'
const baseUrl = (process.env.ROUTE_ENGINE_BASE_URL || 'http://route-engine:8080').replace(/\/+$/, '');
const token = process.env.ROUTE_ENGINE_INTERNAL_TOKEN || '';
if (!token) throw new Error('ROUTE_ENGINE_INTERNAL_TOKEN is missing in delivery-api runtime env');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fetchJson = async (url, options) => {
  const response = await fetch(url, options);
  let body = null;
  try {
    body = await response.json();
  } catch (error) {
    body = { parse_error: String(error) };
  }
  return { response, body };
};

let response = null;
let payload = null;
let lastReadyError = null;
for (let attempt = 1; attempt <= 30; attempt += 1) {
  try {
    const result = await fetchJson(`${baseUrl}/readyz`, {
      headers: { 'X-Request-Id': `route-engine-rollback-smoke-readyz-${attempt}` },
    });
    response = result.response;
    payload = result.body;
    if (response.ok && payload.service === 'route_engine' && payload.ready === true && payload.external_calls === false) {
      break;
    }
    lastReadyError = new Error(`status=${response.status} body=${JSON.stringify(payload)}`);
  } catch (error) {
    lastReadyError = error;
  }
  if (attempt < 30) await sleep(1000);
}
if (!response?.ok || payload?.service !== 'route_engine' || payload?.ready !== true || payload?.external_calls !== false) {
  throw new Error(`route_engine rollback ready smoke failed after readiness wait: ${lastReadyError?.message || 'unknown error'}`);
}
console.log(JSON.stringify({ service: payload.service, ready: payload.ready, graph: payload.graph?.status, externalCalls: payload.external_calls }));
NODE
}

ensure_route_engine() {
  local image_env_file route_engine_revision route_engine_role route_engine_graph_manifest_sha
  image_env_file="$1"
  if ! route_engine_configured; then
    echo "route_engine disabled in infra/env/delivery-api.env; skipping route_engine service activation."
    return 0
  fi

  validate_route_engine_image
  echo "Ensuring route_engine worker service is attached to the durable clever-route compose project."
  route_engine_revision="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$ROUTE_ENGINE_IMAGE")"
  route_engine_role="$(docker image inspect --format '{{ index .Config.Labels "org.clever-route.image-role" }}' "$ROUTE_ENGINE_IMAGE")"
  route_engine_graph_manifest_sha="$(route_engine_image_graph_manifest_sha)"
  test "$route_engine_revision" = "${ROUTE_ENGINE_IMAGE##*:}"
  test "$route_engine_role" = "route-engine-worker"
  validate_route_engine_graph_artifacts "$route_engine_graph_manifest_sha"
  route_ops_compose "$image_env_file" --profile route-engine up -d --no-build route-engine
  smoke_route_engine_from_runtime_network "$image_env_file"
}

stop_route_engine_if_disabled() {
  local image_env_file
  image_env_file="$1"
  if route_engine_configured; then
    return 0
  fi

  echo "Stopping route_engine because ROUTE_ENGINE_BASE_URL is disabled in infra/env/delivery-api.env."
  route_ops_compose "$image_env_file" --profile route-engine stop route-engine
}

smoke_route_ops_osrm_url() {
  local osrm_base_url route_path url
  osrm_base_url="$1"
  route_path="${ROUTE_OPS_OSRM_SMOKE_ROUTE_PATH:--79.3832,43.6532;-79.6441,43.5890}"
  url="${osrm_base_url%/}/route/v1/driving/${route_path}?overview=full&geometries=geojson&steps=false"
  echo "Smoking Route Ops OSRM from host loopback."
  if command -v node >/dev/null 2>&1; then
    ROUTE_OPS_OSRM_SMOKE_URL="$url" node <<'NODE'
const response = await fetch(process.env.ROUTE_OPS_OSRM_SMOKE_URL);
if (!response.ok) throw new Error(`OSRM smoke HTTP ${response.status}`);
const payload = await response.json();
const route = Array.isArray(payload.routes) ? payload.routes[0] : null;
const coordinates = route?.geometry?.coordinates;
if (payload.code !== 'Ok' || route?.geometry?.type !== 'LineString' || !Array.isArray(coordinates) || coordinates.length < 2) {
  throw new Error('OSRM smoke did not return a LineString route geometry');
}
console.log(JSON.stringify({ code: payload.code, coordinates: coordinates.length }));
NODE
    return 0
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$url" <<'PYTHON'
import json
import sys
import urllib.request

with urllib.request.urlopen(sys.argv[1], timeout=10) as response:
    payload = json.load(response)
route = payload.get('routes', [None])[0]
geometry = route.get('geometry') if isinstance(route, dict) else None
coordinates = geometry.get('coordinates') if isinstance(geometry, dict) else None
if (
    payload.get('code') != 'Ok'
    or not isinstance(geometry, dict)
    or geometry.get('type') != 'LineString'
    or not isinstance(coordinates, list)
    or len(coordinates) < 2
):
    raise SystemExit('OSRM smoke did not return a LineString route geometry')
print(json.dumps({'code': payload.get('code'), 'coordinates': len(coordinates)}, separators=(',', ':')))
PYTHON
    return 0
  fi
  echo "OSRM smoke requires node or python3 on the deploy host." >&2
  return 1
}

smoke_route_ops_osrm_from_runtime_network() {
  local image_env_file network_url
  image_env_file="$1"
  network_url="${ROUTE_OPS_OSRM_NETWORK_SMOKE_URL:-http://osrm-ontario:5000}"
  echo "Smoking Route Ops OSRM from the delivery-api runtime network."
  route_ops_compose "$image_env_file" run --rm --no-deps -e ROUTE_OPS_OSRM_SMOKE_URL="$network_url" delivery-api node - <<'NODE'
const url = `${process.env.ROUTE_OPS_OSRM_SMOKE_URL.replace(/\/+$/, '')}/route/v1/driving/-79.3832,43.6532;-79.6441,43.5890?overview=full&geometries=geojson&steps=false`;
const response = await fetch(url);
if (!response.ok) throw new Error(`OSRM smoke HTTP ${response.status}`);
const payload = await response.json();
const route = Array.isArray(payload.routes) ? payload.routes[0] : null;
const coordinates = route?.geometry?.coordinates;
if (payload.code !== 'Ok' || route?.geometry?.type !== 'LineString' || !Array.isArray(coordinates) || coordinates.length < 2) {
  throw new Error('OSRM smoke did not return a LineString route geometry');
}
console.log(JSON.stringify({ code: payload.code, coordinates: coordinates.length }));
NODE
}

ensure_route_ops_osrm() {
  local image_env_file host_url
  image_env_file="$1"
  if ! route_ops_osrm_configured; then
    echo "Route Ops OSRM disabled in infra/env/delivery-api.env; skipping OSRM service activation."
    return 0
  fi

  echo "Ensuring Route Ops OSRM Ontario service is attached to the durable clever-route compose project."
  route_ops_compose "$image_env_file" --profile osrm up -d --no-build osrm-ontario

  host_url="${ROUTE_OPS_OSRM_HOST_SMOKE_URL:-http://127.0.0.1:5000}"
  smoke_route_ops_osrm_url "$host_url"
  smoke_route_ops_osrm_from_runtime_network "$image_env_file"
}

stop_route_ops_osrm_if_disabled() {
  local image_env_file
  image_env_file="$1"
  if route_ops_osrm_configured; then
    return 0
  fi

  echo "Stopping Route Ops OSRM Ontario because OSRM_BASE_URL is disabled in infra/env/delivery-api.env."
  route_ops_compose "$image_env_file" --profile osrm stop osrm-ontario
}

acquire_deploy_lock
trap 'release_deploy_lock' EXIT
enforce_no_legacy_route_ops_compose_project

test -f .deploy/current-image.env
test -f .deploy/previous-image.env
cp .deploy/current-image.env .deploy/rollback-from-image.env
cp .deploy/previous-image.env .deploy/candidate-image.env
ensure_static_artifact_env_file .deploy/rollback-from-image.env
ensure_static_artifact_env_file .deploy/candidate-image.env

restore_current() {
  local status=$?
  if [ "$status" -ne 0 ] && [ -f .deploy/rollback-from-image.env ]; then
    echo "Rollback failed; restoring pre-rollback current image metadata." >&2
    load_image_env_file .deploy/rollback-from-image.env
    if [ "$ROUTE_OPS_ROLLBACK_SERVICE_MUTATED" = "true" ]; then
      ensure_route_engine .deploy/rollback-from-image.env || true
      ensure_route_ops_osrm .deploy/rollback-from-image.env || true
      route_ops_compose .deploy/rollback-from-image.env up -d --no-build --force-recreate --no-deps delivery-api || true
      stop_route_engine_if_disabled .deploy/rollback-from-image.env || true
      stop_route_ops_osrm_if_disabled .deploy/rollback-from-image.env || true
      route_ops_compose .deploy/rollback-from-image.env up -d --no-build --force-recreate --no-deps caddy || true
    fi
    if [ "$ROUTE_OPS_ROLLBACK_SERVICE_MUTATED" != "true" ]; then
      if [ "$ROUTE_OPS_ROLLBACK_STATIC_ARTIFACT_STAGED" = "true" ]; then
        echo "Rollback failed after staging candidate static artifact but before Route Ops backend service mutation; existing backend keeps its current static volume." >&2
      else
        echo "Rollback failed before Route Ops static artifact or backend service mutation; existing backend keeps its current static volume." >&2
      fi
    fi
    rm -f .deploy/candidate-image.env
  fi
  release_deploy_lock
  exit "$status"
}
trap restore_current EXIT

load_image_env_file .deploy/candidate-image.env
validate_loaded_static_artifact_contract .deploy/candidate-image.env
require_candidate_static_volume_isolated_from_rollback_from .deploy/rollback-from-image.env
CURRENT_PRISMA_SCHEMA_SHA="$(grep '^PRISMA_SCHEMA_SHA=' .deploy/rollback-from-image.env | cut -d= -f2- || true)"
test -n "$CURRENT_PRISMA_SCHEMA_SHA"
test "$CURRENT_PRISMA_SCHEMA_SHA" = "$PRISMA_SCHEMA_SHA"

route_ops_compose .deploy/candidate-image.env --profile route-engine pull route-ops-web-static delivery-api delivery-api-migrate route-engine
runtime_role="$(docker image inspect --format '{{ index .Config.Labels "org.clever-route.image-role" }}' "$DELIVERY_API_IMAGE")"
migrate_role="$(docker image inspect --format '{{ index .Config.Labels "org.clever-route.image-role" }}' "$DELIVERY_API_MIGRATE_IMAGE")"
test "$runtime_role" = "runtime"
test "$migrate_role" = "migrate"
static_role="$(docker image inspect --format '{{ index .Config.Labels "org.clever-route.image-role" }}' "$ROUTE_OPS_WEB_STATIC_IMAGE")"
test "$static_role" = "route-ops-web-static"
route_engine_revision="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$ROUTE_ENGINE_IMAGE")"
route_engine_role="$(docker image inspect --format '{{ index .Config.Labels "org.clever-route.image-role" }}' "$ROUTE_ENGINE_IMAGE")"
route_engine_graph_manifest_sha="$(route_engine_image_graph_manifest_sha)"
test "$route_engine_revision" = "${ROUTE_ENGINE_IMAGE##*:}"
test "$route_engine_role" = "route-engine-worker"
if route_engine_configured; then
  validate_route_engine_graph_artifacts "$route_engine_graph_manifest_sha"
fi
docker run --rm "$DELIVERY_API_MIGRATE_IMAGE" sh -lc 'test -f apps/delivery-api/prisma/schema.prisma && npm --prefix apps/delivery-api exec -- prisma --version'
ROUTE_OPS_ROLLBACK_STATIC_ARTIFACT_STAGED="true"
route_ops_compose .deploy/candidate-image.env up --no-build --force-recreate route-ops-web-static
route_ops_compose .deploy/candidate-image.env run --rm delivery-api-migrate
ensure_route_engine .deploy/candidate-image.env
ensure_route_ops_osrm .deploy/candidate-image.env
ROUTE_OPS_ROLLBACK_SERVICE_MUTATED="true"
route_ops_compose .deploy/candidate-image.env up -d --no-build --force-recreate --no-deps delivery-api
stop_route_engine_if_disabled .deploy/candidate-image.env
stop_route_ops_osrm_if_disabled .deploy/candidate-image.env
ensure_route_ops_ingress

ROUTE_OPS_SMOKE_BASE_URL="$BASE_URL" \
ROUTE_OPS_SMOKE_SHOP_DOMAIN="$SHOP_DOMAIN" \
ROUTE_OPS_SMOKE_LOGIN_SECRET="$ROUTE_OPS_SMOKE_LOGIN_SECRET" \
node scripts/smoke-route-ops-production.mjs

mv .deploy/current-image.env .deploy/previous-image.env
mv .deploy/candidate-image.env .deploy/current-image.env
printf '{"ts":"%s","rollbackTo":"%s","deliveryApiImage":"%s","migrateImage":"%s","routeOpsWebStaticImage":"%s","routeOpsWebStaticVolume":"%s","routeEngineImage":"%s","prismaSchemaSha":"%s","routeEngineEnabled":%s,"osrmEnabled":%s}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${IMAGE_TAG:-unknown}" "$DELIVERY_API_IMAGE" "$DELIVERY_API_MIGRATE_IMAGE" "${ROUTE_OPS_WEB_STATIC_IMAGE:-}" "${ROUTE_OPS_WEB_STATIC_VOLUME:-}" "${ROUTE_ENGINE_IMAGE:-}" "$PRISMA_SCHEMA_SHA" "$(route_engine_enabled_json)" "$(route_ops_osrm_enabled_json)" >> .deploy/deploy-history.jsonl
release_deploy_lock
trap - EXIT
echo "Route Ops image rollback promoted: ${IMAGE_TAG:-unknown}"
