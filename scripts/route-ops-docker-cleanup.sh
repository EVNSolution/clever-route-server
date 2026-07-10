#!/usr/bin/env bash
set -euo pipefail

DRY_RUN=0
ENFORCE=0
IMAGE_MAX_AGE="${ROUTE_OPS_DOCKER_IMAGE_MAX_AGE:-168h}"
BUILD_CACHE_MAX_AGE="${ROUTE_OPS_DOCKER_BUILD_CACHE_MAX_AGE:-168h}"
BUILD_CACHE_RESERVED_SPACE="${ROUTE_OPS_DOCKER_BUILD_CACHE_RESERVED_SPACE:-4GB}"
MIN_FREE_MB="${ROUTE_OPS_DOCKER_MIN_FREE_MB:-20480}"
MIN_FREE_PERCENT="${ROUTE_OPS_DOCKER_MIN_FREE_PERCENT:-20}"

usage() {
  cat <<'USAGE'
Usage: route-ops-docker-cleanup.sh [--dry-run] [--enforce]

Safely removes only dangling images older than seven days and old Docker build
cache. It never prunes tagged images, containers, volumes, or networks.

  --dry-run  Report candidates and disk state without deleting anything.
  --enforce  Fail unless Docker storage has at least 20 GiB and 20% free.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --enforce) ENFORCE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 64 ;;
  esac
  shift
done

fail() { echo "route-ops-docker-cleanup: $*" >&2; exit 65; }
[[ "$MIN_FREE_MB" =~ ^[0-9]+$ ]] || fail "ROUTE_OPS_DOCKER_MIN_FREE_MB must be an integer"
[[ "$MIN_FREE_PERCENT" =~ ^[0-9]+$ ]] || fail "ROUTE_OPS_DOCKER_MIN_FREE_PERCENT must be an integer"
command -v docker >/dev/null || fail "docker is required"
docker info >/dev/null || fail "Docker daemon is unavailable"

work_dir="$(mktemp -d /tmp/route-ops-docker-cleanup.XXXXXX)"
trap 'rm -rf "$work_dir"' EXIT
docker_root="$(docker info --format '{{.DockerRootDir}}')"
[ -d "$docker_root" ] || fail "Docker root directory does not exist: $docker_root"

disk_stats() {
  df -Pk "$docker_root" | awk 'NR == 2 {printf "%s %s %s\n", int($4 / 1024), int(($4 * 100) / $2), $5}'
}

check_capacity() {
  local phase="$1" enforce_now="$2" free_mb free_percent used_percent
  read -r free_mb free_percent used_percent <<EOF_STATS
$(disk_stats)
EOF_STATS
  printf 'docker cleanup capacity: phase=%s root=%s free_mb=%s free_percent=%s used=%s minimum_mb=%s minimum_percent=%s\n' \
    "$phase" "$docker_root" "$free_mb" "$free_percent" "$used_percent" "$MIN_FREE_MB" "$MIN_FREE_PERCENT"
  if [ "$ENFORCE" = "1" ] && [ "$enforce_now" = "1" ] && { [ "$free_mb" -lt "$MIN_FREE_MB" ] || [ "$free_percent" -lt "$MIN_FREE_PERCENT" ]; }; then
    fail "insufficient Docker disk capacity after ${phase}: ${free_mb}MB/${free_percent}% free"
  fi
}

docker ps --no-trunc --format '{{.ID}}\t{{.Image}}' | sort > "$work_dir/running-containers.before"
dangling_count="$(docker image ls -q --filter dangling=true | sort -u | wc -l | tr -d ' ')"
printf 'docker cleanup policy: dangling_images_older_than=%s build_cache_older_than=%s build_cache_reserved=%s dangling_total=%s\n' \
  "$IMAGE_MAX_AGE" "$BUILD_CACHE_MAX_AGE" "$BUILD_CACHE_RESERVED_SPACE" "$dangling_count"
docker system df
check_capacity before "$DRY_RUN"

if [ "$DRY_RUN" = "1" ]; then
  echo 'cleanup dry-run complete; no Docker data was removed'
  exit 0
fi

# Intentionally no --all: Docker's image prune default is dangling images only.
docker image prune --force --filter "until=$IMAGE_MAX_AGE"
docker builder prune --force --filter "until=$BUILD_CACHE_MAX_AGE" --reserved-space "$BUILD_CACHE_RESERVED_SPACE"

docker ps --no-trunc --format '{{.ID}}\t{{.Image}}' | sort > "$work_dir/running-containers.after"
if ! diff -u "$work_dir/running-containers.before" "$work_dir/running-containers.after"; then
  fail "running container set changed during cleanup"
fi
check_capacity after 1
docker system df
echo 'docker cleanup complete; running containers unchanged'
