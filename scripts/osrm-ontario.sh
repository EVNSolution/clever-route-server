#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/osrm-ontario.sh <preflight|prepare|smoke> [--dry-run]

Ontario-only OSRM helper for Route Ops road geometry.

Subcommands:
  preflight Check existing OSRM data/service/env plus disk and memory.
  prepare   Download/preprocess the Ontario extract with OSRM tools.
  smoke     Request one sample route and verify GeoJSON geometry exists.

Dry-run:
  OSRM_DRY_RUN=1 scripts/osrm-ontario.sh preflight
  OSRM_DRY_RUN=1 scripts/osrm-ontario.sh prepare
  OSRM_DRY_RUN=1 scripts/osrm-ontario.sh smoke
  scripts/osrm-ontario.sh prepare --dry-run

Environment:
  ROOT_DIR              Default: /srv/clever-route-server
  OSRM_DATA_DIR         Default: $ROOT_DIR/data/osrm/ontario
  OSRM_ENV_FILE         Default: $ROOT_DIR/infra/env/delivery-api.env
  OSRM_COMPOSE_FILE     Default: $ROOT_DIR/infra/compose/docker-compose.prod.yml
  OSRM_PBF_URL          Default: Geofabrik Ontario extract
  PBF_FILE              Default: ontario-latest.osm.pbf
  OSRM_FILE             Default: ontario-latest.osrm
  OSRM_IMAGE            Default: ghcr.io/project-osrm/osrm-backend:latest
  ROUTE_OPS_COMPOSE_PROJECT_NAME Default: clever-route
  OSRM_MIN_FREE_MB      Default: 20000
  OSRM_MIN_MEMORY_MB    Default: 4096
  OSRM_BASE_URL         Default: http://127.0.0.1:5000 (smoke only)
  OSRM_SMOKE_ROUTE_PATH Default: Toronto City Hall -> Mississauga City Centre
USAGE
}

if [[ $# -eq 0 || "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

COMMAND="$1"
shift || true
DRY_RUN="${OSRM_DRY_RUN:-${DRY_RUN:-0}}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

is_dry_run() {
  [[ "$DRY_RUN" == "1" || "$DRY_RUN" == "true" || "$DRY_RUN" == "yes" ]]
}

print_cmd() {
  printf 'dry-run:'
  printf ' %q' "$@"
  printf '\n'
}

nearest_existing_path() {
  local path
  path="$1"
  while [[ ! -e "$path" && "$path" != "/" ]]; do
    path="$(dirname "$path")"
  done
  printf '%s\n' "$path"
}

read_env_value() {
  local env_file key
  env_file="$1"
  key="$2"
  awk -F= -v key="$key" '$1 == key { print substr($0, index($0, "=") + 1); exit }' "$env_file"
}

print_env_presence() {
  local env_file key value
  env_file="$1"
  key="$2"
  if [[ ! -f "$env_file" ]]; then
    echo "${key} configured: unknown (env file missing)"
    return 0
  fi

  value="$(read_env_value "$env_file" "$key")"
  if [[ -n "${value//[[:space:]]/}" ]]; then
    echo "${key} configured: yes"
  else
    echo "${key} configured: no"
  fi
}

preflight_osrm() {
  local root_dir data_dir env_file compose_file osrm_file min_free_mb min_memory_mb
  root_dir="${ROOT_DIR:-/srv/clever-route-server}"
  local compose_project_name
  compose_project_name="${ROUTE_OPS_COMPOSE_PROJECT_NAME:-clever-route}"
  data_dir="${OSRM_DATA_DIR:-${root_dir}/data/osrm/ontario}"
  env_file="${OSRM_ENV_FILE:-${root_dir}/infra/env/delivery-api.env}"
  compose_file="${OSRM_COMPOSE_FILE:-${root_dir}/infra/compose/docker-compose.prod.yml}"
  osrm_file="${OSRM_FILE:-ontario-latest.osrm}"
  min_free_mb="${OSRM_MIN_FREE_MB:-20000}"
  min_memory_mb="${OSRM_MIN_MEMORY_MB:-4096}"

  echo "OSRM Ontario preflight"
  echo "Root dir: ${root_dir}"
  echo "Data dir: ${data_dir}"
  echo "Env file: ${env_file}"
  echo "Compose file: ${compose_file}"
  echo "Compose project: ${compose_project_name}"
  echo "Minimum free disk MB: ${min_free_mb}"
  echo "Minimum memory+swap MB: ${min_memory_mb}"

  if is_dry_run; then
    print_cmd test -d "$data_dir"
    print_cmd find "$data_dir" -maxdepth 1 -type f -name "${osrm_file}*"
    print_cmd df -Pm "$data_dir"
    print_cmd docker ps -a --filter name=osrm --format '{{.Names}}\t{{.Status}}\t{{.Ports}}'
    print_cmd grep -E '^(OSRM_BASE_URL|OSRM_TIMEOUT_MS|ROUTE_OPS_ROUTER_COVERAGE)=' "$env_file"
    print_cmd docker compose -p "$compose_project_name" -f "$compose_file" --profile osrm ps osrm-ontario
    print_cmd curl -fsS "http://127.0.0.1:5000/route/v1/driving/-79.3832,43.6532;-79.6441,43.5890?overview=full&geometries=geojson&steps=false"
    echo "dry-run: no filesystem, Docker, env, or live OSRM checks executed."
    return 0
  fi

  local disk_path free_mb
  disk_path="$(nearest_existing_path "$data_dir")"
  free_mb="$(df -Pm "$disk_path" | awk 'NR==2 { print $4 }')"
  echo "Disk check path: ${disk_path}"
  echo "Free disk MB: ${free_mb:-unknown}"
  if [[ -z "$free_mb" || "$free_mb" -lt "$min_free_mb" ]]; then
    echo "Storage decision: expansion_required_before_prepare"
  else
    echo "Storage decision: ok_for_prepare_threshold"
  fi

  if command -v free >/dev/null 2>&1; then
    local available_memory_mb free_swap_mb total_available_mb
    available_memory_mb="$(free -m | awk '/^Mem:/ { print $7 }')"
    free_swap_mb="$(free -m | awk '/^Swap:/ { print $4 }')"
    total_available_mb="$(( ${available_memory_mb:-0} + ${free_swap_mb:-0} ))"
    echo "Available memory+swap MB: ${total_available_mb}"
    if [[ "$total_available_mb" -lt "$min_memory_mb" ]]; then
      echo "Memory decision: below_prepare_threshold"
    else
      echo "Memory decision: ok_for_prepare_threshold"
    fi
  else
    echo "Memory decision: unknown (free command unavailable)"
  fi

  if [[ -d "$data_dir" ]]; then
    echo "Data dir exists: yes"
    du -sh "$data_dir" 2>/dev/null || true
    local missing=0
    for suffix in ".fileIndex" ".cells" ".partition" ".mldgr"; do
      if [[ ! -s "${data_dir}/${osrm_file}${suffix}" ]]; then
        echo "Missing prepared artifact: ${osrm_file}${suffix}"
        missing=1
      fi
    done
    if [[ "$missing" -eq 0 ]]; then
      echo "Prepared data decision: likely_complete_for_mld"
    else
      echo "Prepared data decision: incomplete_or_absent"
    fi
    find "$data_dir" -maxdepth 1 -type f \( -name "${osrm_file}*" -o -name "*.osm.pbf" \) -exec ls -lh {} + 2>/dev/null | head -40 || true
  else
    echo "Data dir exists: no"
    echo "Prepared data decision: absent"
  fi

  echo "Runtime env presence (values redacted):"
  print_env_presence "$env_file" "OSRM_BASE_URL"
  print_env_presence "$env_file" "OSRM_TIMEOUT_MS"
  print_env_presence "$env_file" "ROUTE_OPS_ROUTER_COVERAGE"

  if [[ -f "$compose_file" ]]; then
    if grep -q 'osrm-ontario:' "$compose_file" && grep -q '127.0.0.1:5000:5000' "$compose_file"; then
      echo "Compose decision: osrm_service_defined_internal_loopback"
    else
      echo "Compose decision: osrm_service_missing_or_not_loopback"
    fi
  else
    echo "Compose decision: compose_file_missing"
  fi

  if command -v docker >/dev/null 2>&1; then
    echo "Docker OSRM containers:"
    docker ps -a --filter name=osrm --format '{{.Names}}\t{{.Status}}\t{{.Ports}}' || true
    echo "Docker OSRM images:"
    docker images --format '{{.Repository}}:{{.Tag}}\t{{.ID}}\t{{.Size}}' | grep -E '(^|/)osrm-backend:' || true
  else
    echo "Docker decision: unavailable"
  fi

  echo "Preflight complete."
}

prepare_osrm() {
  local root_dir data_dir pbf_url pbf_file osrm_file osrm_image min_free_mb min_memory_mb
  root_dir="${ROOT_DIR:-/srv/clever-route-server}"
  data_dir="${OSRM_DATA_DIR:-${root_dir}/data/osrm/ontario}"
  pbf_url="${OSRM_PBF_URL:-https://download.geofabrik.de/north-america/canada/ontario-latest.osm.pbf}"
  pbf_file="${PBF_FILE:-ontario-latest.osm.pbf}"
  osrm_file="${OSRM_FILE:-ontario-latest.osrm}"
  osrm_image="${OSRM_IMAGE:-ghcr.io/project-osrm/osrm-backend:latest}"
  min_free_mb="${OSRM_MIN_FREE_MB:-20000}"
  min_memory_mb="${OSRM_MIN_MEMORY_MB:-4096}"

  echo "OSRM Ontario prepare"
  echo "Data dir: ${data_dir}"
  echo "PBF URL: ${pbf_url}"
  echo "OSRM image: ${osrm_image}"
  echo "Minimum free disk MB: ${min_free_mb}"
  echo "Minimum memory+swap MB: ${min_memory_mb}"

  if is_dry_run; then
    print_cmd mkdir -p "$data_dir"
    print_cmd df -Pm "$data_dir"
    print_cmd docker pull "$osrm_image"
    print_cmd curl -fL --retry 3 --retry-delay 5 "$pbf_url" -o "${data_dir}/${pbf_file}"
    print_cmd docker run --rm -v "${data_dir}:/data" "$osrm_image" osrm-extract -p /opt/car.lua "/data/${pbf_file}"
    print_cmd docker run --rm -v "${data_dir}:/data" "$osrm_image" osrm-partition "/data/${osrm_file}"
    print_cmd docker run --rm -v "${data_dir}:/data" "$osrm_image" osrm-customize "/data/${osrm_file}"
    echo "dry-run: no directory changes, PBF download, Docker pull/run, or OSRM preprocessing executed."
    return 0
  fi

  mkdir -p "$data_dir"

  local free_mb
  free_mb="$(df -Pm "$data_dir" | awk 'NR==2 { print $4 }')"
  if [[ -z "$free_mb" || "$free_mb" -lt "$min_free_mb" ]]; then
    echo "OSRM prepare aborted: ${data_dir} has ${free_mb:-unknown}MB free; need at least ${min_free_mb}MB." >&2
    exit 1
  fi

  echo "Free disk MB: $free_mb"
  if command -v free >/dev/null 2>&1; then
    free -m
    local available_memory_mb free_swap_mb total_available_mb
    available_memory_mb="$(free -m | awk '/^Mem:/ { print $7 }')"
    free_swap_mb="$(free -m | awk '/^Swap:/ { print $4 }')"
    total_available_mb="$(( ${available_memory_mb:-0} + ${free_swap_mb:-0} ))"
    if [[ "$total_available_mb" -lt "$min_memory_mb" ]]; then
      echo "OSRM prepare aborted: ${total_available_mb}MB memory+swap available; need at least ${min_memory_mb}MB." >&2
      exit 1
    fi
  else
    echo "OSRM memory guard warning: 'free' is unavailable; verify at least ${min_memory_mb}MB memory+swap manually." >&2
    vm_stat 2>/dev/null || true
  fi

  docker pull "$osrm_image"

  if [[ ! -s "${data_dir}/${pbf_file}" ]]; then
    curl -fL --retry 3 --retry-delay 5 "$pbf_url" -o "${data_dir}/${pbf_file}"
  fi

  docker run --rm -v "${data_dir}:/data" "$osrm_image" \
    osrm-extract -p /opt/car.lua "/data/${pbf_file}"
  docker run --rm -v "${data_dir}:/data" "$osrm_image" \
    osrm-partition "/data/${osrm_file}"
  docker run --rm -v "${data_dir}:/data" "$osrm_image" \
    osrm-customize "/data/${osrm_file}"

  echo "OSRM Ontario data prepared: ${data_dir}/${osrm_file}"
  echo "Next: docker compose -p ${ROUTE_OPS_COMPOSE_PROJECT_NAME:-clever-route} -f infra/compose/docker-compose.prod.yml --profile osrm up -d osrm-ontario"
}

smoke_osrm() {
  local osrm_base_url route_path url
  osrm_base_url="${OSRM_BASE_URL:-http://127.0.0.1:5000}"
  # Toronto City Hall -> Mississauga City Centre, lon/lat order for OSRM.
  route_path="${OSRM_SMOKE_ROUTE_PATH:--79.3832,43.6532;-79.6441,43.5890}"
  url="${osrm_base_url%/}/route/v1/driving/${route_path}?overview=full&geometries=geojson&steps=false"

  echo "OSRM Ontario smoke"
  echo "URL: ${url}"

  if is_dry_run; then
    echo "dry-run: no live OSRM HTTP request executed."
    return 0
  fi

  local payload
  payload="$(curl -fsS "$url")"
  if command -v node >/dev/null 2>&1; then
    printf '%s' "$payload" | node -e '
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { raw += chunk; });
process.stdin.on("end", () => {
  const payload = JSON.parse(raw);
  const route = Array.isArray(payload.routes) ? payload.routes[0] : null;
  const geometry = route?.geometry ?? null;
  const coordinates = Array.isArray(geometry?.coordinates) ? geometry.coordinates : [];
  const validCoordinates = coordinates.filter((coordinate) => (
    Array.isArray(coordinate) &&
    coordinate.length >= 2 &&
    Number.isFinite(coordinate[0]) &&
    Number.isFinite(coordinate[1])
  ));
  if (
    payload.code !== "Ok" ||
    geometry?.type !== "LineString" ||
    coordinates.length < 2 ||
    validCoordinates.length !== coordinates.length
  ) {
    throw new Error("OSRM smoke did not return route geometry");
  }
  console.log(JSON.stringify({
    code: payload.code,
    distance: route.distance ?? null,
    duration: route.duration ?? null,
    coordinates: coordinates.length
  }));
});
'
    return 0
  fi

  if command -v python3 >/dev/null 2>&1; then
    printf '%s' "$payload" | python3 -c '
import json
import math
import sys

payload = json.load(sys.stdin)
routes = payload.get("routes")
route = routes[0] if isinstance(routes, list) and routes else None
geometry = route.get("geometry") if isinstance(route, dict) else None
coordinates = geometry.get("coordinates") if isinstance(geometry, dict) else None
valid_coordinates = [
    coordinate
    for coordinate in coordinates
    if isinstance(coordinate, list)
    and len(coordinate) >= 2
    and isinstance(coordinate[0], (int, float))
    and isinstance(coordinate[1], (int, float))
    and math.isfinite(coordinate[0])
    and math.isfinite(coordinate[1])
]
if (
    payload.get("code") != "Ok"
    or not isinstance(geometry, dict)
    or geometry.get("type") != "LineString"
    or not isinstance(coordinates, list)
    or len(coordinates) < 2
    or len(valid_coordinates) != len(coordinates)
):
    raise SystemExit("OSRM smoke did not return route geometry")
print(json.dumps({
    "code": payload.get("code"),
    "distance": route.get("distance"),
    "duration": route.get("duration"),
    "coordinates": len(coordinates),
}, separators=(",", ":")))
'
    return 0
  fi

  echo "OSRM smoke requires node or python3 to validate the JSON payload." >&2
  return 1
}

case "$COMMAND" in
  preflight)
    preflight_osrm
    ;;
  prepare)
    prepare_osrm
    ;;
  smoke)
    smoke_osrm
    ;;
  *)
    echo "Unknown subcommand: $COMMAND" >&2
    usage >&2
    exit 2
    ;;
esac
