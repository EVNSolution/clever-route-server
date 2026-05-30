#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${ROOT_DIR:-/srv/clever-route-server}"
DATA_DIR="${OSRM_DATA_DIR:-${ROOT_DIR}/data/osrm/ontario}"
PBF_URL="${OSRM_PBF_URL:-https://download.geofabrik.de/north-america/canada/ontario-latest.osm.pbf}"
PBF_FILE="${PBF_FILE:-ontario-latest.osm.pbf}"
OSRM_FILE="${OSRM_FILE:-ontario-latest.osrm}"
OSRM_IMAGE="${OSRM_IMAGE:-ghcr.io/project-osrm/osrm-backend:latest}"
MIN_FREE_MB="${OSRM_MIN_FREE_MB:-20000}"
MIN_MEMORY_MB="${OSRM_MIN_MEMORY_MB:-4096}"

mkdir -p "$DATA_DIR"

free_mb="$(df -Pm "$DATA_DIR" | awk 'NR==2 { print $4 }')"
if [[ -z "$free_mb" || "$free_mb" -lt "$MIN_FREE_MB" ]]; then
  echo "OSRM prepare aborted: ${DATA_DIR} has ${free_mb:-unknown}MB free; need at least ${MIN_FREE_MB}MB." >&2
  exit 1
fi

echo "OSRM data dir: $DATA_DIR"
echo "Free disk MB: $free_mb"
if command -v free >/dev/null 2>&1; then
  free -m
  available_memory_mb="$(free -m | awk '/^Mem:/ { print $7 }')"
  free_swap_mb="$(free -m | awk '/^Swap:/ { print $4 }')"
  total_available_mb="$(( ${available_memory_mb:-0} + ${free_swap_mb:-0} ))"
  if [[ "$total_available_mb" -lt "$MIN_MEMORY_MB" ]]; then
    echo "OSRM prepare aborted: ${total_available_mb}MB memory+swap available; need at least ${MIN_MEMORY_MB}MB." >&2
    exit 1
  fi
else
  echo "OSRM memory guard warning: 'free' is unavailable; verify at least ${MIN_MEMORY_MB}MB memory+swap manually." >&2
  vm_stat 2>/dev/null || true
fi

docker pull "$OSRM_IMAGE"

if [[ ! -s "${DATA_DIR}/${PBF_FILE}" ]]; then
  curl -fL --retry 3 --retry-delay 5 "$PBF_URL" -o "${DATA_DIR}/${PBF_FILE}"
fi

docker run --rm -v "${DATA_DIR}:/data" "$OSRM_IMAGE" \
  osrm-extract -p /opt/car.lua "/data/${PBF_FILE}"
docker run --rm -v "${DATA_DIR}:/data" "$OSRM_IMAGE" \
  osrm-partition "/data/${OSRM_FILE}"
docker run --rm -v "${DATA_DIR}:/data" "$OSRM_IMAGE" \
  osrm-customize "/data/${OSRM_FILE}"

echo "OSRM Ontario data prepared: ${DATA_DIR}/${OSRM_FILE}"
echo "Next: docker compose -f infra/compose/docker-compose.prod.yml --profile osrm up -d osrm-ontario"
