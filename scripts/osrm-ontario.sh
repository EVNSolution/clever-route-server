#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/osrm-ontario.sh <prepare|smoke> [--dry-run]

Ontario-only OSRM helper for Route Ops road geometry.

Subcommands:
  prepare   Download/preprocess the Ontario extract with OSRM tools.
  smoke     Request one sample route and verify GeoJSON geometry exists.

Dry-run:
  OSRM_DRY_RUN=1 scripts/osrm-ontario.sh prepare
  OSRM_DRY_RUN=1 scripts/osrm-ontario.sh smoke
  scripts/osrm-ontario.sh prepare --dry-run

Environment:
  ROOT_DIR              Default: /srv/clever-route-server
  OSRM_DATA_DIR         Default: $ROOT_DIR/data/osrm/ontario
  OSRM_PBF_URL          Default: Geofabrik Ontario extract
  PBF_FILE              Default: ontario-latest.osm.pbf
  OSRM_FILE             Default: ontario-latest.osrm
  OSRM_IMAGE            Default: ghcr.io/project-osrm/osrm-backend:latest
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
  echo "Next: docker compose -f infra/compose/docker-compose.prod.yml --profile osrm up -d osrm-ontario"
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
  node -e '
const payload = JSON.parse(process.argv[1]);
if (payload.code !== "Ok" || !Array.isArray(payload.routes) || !payload.routes[0]?.geometry) {
  throw new Error("OSRM smoke did not return route geometry");
}
console.log(JSON.stringify({
  code: payload.code,
  distance: payload.routes[0].distance ?? null,
  duration: payload.routes[0].duration ?? null,
  coordinates: payload.routes[0].geometry?.coordinates?.length ?? 0
}));
' "$payload"
}

case "$COMMAND" in
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
