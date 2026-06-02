#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/srv/clever-route-server}"
COMPOSE_FILE="${COMPOSE_FILE:-infra/compose/docker-compose.prod.yml}"
ROUTE_OPS_COMPOSE_PROJECT_NAME="${ROUTE_OPS_COMPOSE_PROJECT_NAME:-clever-route}"
BASE_URL="${ROUTE_OPS_SMOKE_BASE_URL:-https://clever-route.cleversystem.ai}"
SHOP_DOMAIN="${ROUTE_OPS_SMOKE_SHOP_DOMAIN:-dev1.tomatonofood.com}"
EXPECT_PUBLIC_OPENFREEMAP="${ROUTE_OPS_EXPECT_PUBLIC_OPENFREEMAP:-true}"
EXPECT_GEOCODER_CONFIGURED="${ROUTE_OPS_EXPECT_GEOCODER_CONFIGURED:-true}"
: "${IMAGE_TAG:?IMAGE_TAG is required and must be the immutable git SHA tag}"
: "${DELIVERY_API_IMAGE:?DELIVERY_API_IMAGE is required}"
: "${DELIVERY_API_MIGRATE_IMAGE:?DELIVERY_API_MIGRATE_IMAGE is required}"
: "${PRISMA_SCHEMA_SHA:?PRISMA_SCHEMA_SHA is required}"
: "${ROUTE_OPS_SMOKE_LOGIN_SECRET:?ROUTE_OPS_SMOKE_LOGIN_SECRET is required locally for promotion smoke}"

cd "$APP_DIR"
export ROUTE_OPS_COMPOSE_PROJECT_NAME
export COMPOSE_PROJECT_NAME="$ROUTE_OPS_COMPOSE_PROJECT_NAME"

LOCK_PATH="${ROUTE_OPS_DEPLOY_LOCK_PATH:-.deploy/route-ops-deploy.lock}"
LOCK_DIR="${LOCK_PATH}.d"
LOCK_ACQUIRED="false"
ROUTE_OPS_STATIC_ARTIFACT_STAGED="false"
ROUTE_OPS_SERVICE_MUTATED="false"
ROUTE_OPS_RUNTIME_IMAGE_REPO="${ROUTE_OPS_RUNTIME_IMAGE_REPO:-ghcr.io/evnsolution/clever-route-server-delivery-api}"
ROUTE_OPS_MIGRATE_IMAGE_REPO="${ROUTE_OPS_MIGRATE_IMAGE_REPO:-ghcr.io/evnsolution/clever-route-server-delivery-api-migrate}"
ROUTE_OPS_WEB_STATIC_IMAGE_REPO="${ROUTE_OPS_WEB_STATIC_IMAGE_REPO:-ghcr.io/evnsolution/clever-route-server-route-ops-web-static}"
ROUTE_OPS_WEB_STATIC_IMAGE="${ROUTE_OPS_WEB_STATIC_IMAGE:-${ROUTE_OPS_WEB_STATIC_IMAGE_REPO}:${IMAGE_TAG}}"
ROUTE_OPS_WEB_STATIC_VOLUME="${ROUTE_OPS_WEB_STATIC_VOLUME:-clever-route-route-ops-web-static-${IMAGE_TAG}}"
export ROUTE_OPS_WEB_STATIC_IMAGE ROUTE_OPS_WEB_STATIC_VOLUME
ROUTE_OPS_DEPLOY_MIN_FREE_MB="${ROUTE_OPS_DEPLOY_MIN_FREE_MB:-4096}"
ROUTE_OPS_DEPLOY_MIN_FREE_PERCENT="${ROUTE_OPS_DEPLOY_MIN_FREE_PERCENT:-20}"
ROUTE_OPS_IMAGE_PRUNE_DRY_RUN="${ROUTE_OPS_IMAGE_PRUNE_DRY_RUN:-0}"
ROUTE_OPS_PRUNE_LEGACY_LOCAL_IMAGE="${ROUTE_OPS_PRUNE_LEGACY_LOCAL_IMAGE:-0}"

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
    echo "ROUTE_OPS_COMPOSE_PROJECT_NAME must be exactly clever-route for production Route Ops deploy; got: ${ROUTE_OPS_COMPOSE_PROJECT_NAME}" >&2
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
        caddy|delivery-api|delivery-api-migrate|postgres|osrm-ontario)
          offenders="${offenders}${name} service=${service} ports=${ports:-none}"$'\n'
          ;;
      esac
    fi
  done < <(docker ps --format '{{.Names}}|{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.service"}}|{{.Ports}}')
  if [ -n "$offenders" ]; then
    echo "Refusing Route Ops deploy because legacy implicit compose project containers are still running." >&2
    echo "Run the compose-project migration preflight/cutover first; do not deploy over project=compose." >&2
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
      IMAGE_TAG=*|DELIVERY_API_IMAGE=*|DELIVERY_API_MIGRATE_IMAGE=*|ROUTE_OPS_WEB_STATIC_IMAGE=*|ROUTE_OPS_WEB_STATIC_VOLUME=*|PRISMA_SCHEMA_SHA=*) ;;
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
  set +a
}

ensure_static_artifact_env_file() {
  local file="$1"
  test -f "$file"
  local image_tag
  image_tag="$(grep -m1 '^IMAGE_TAG=' "$file" | cut -d= -f2- || true)"
  if [ -z "$image_tag" ] || ! [[ "$image_tag" =~ ^[0-9a-fA-F]{40}$ ]]; then
    echo "Cannot derive Route Ops static artifact metadata without a 40-hex IMAGE_TAG in $file." >&2
    exit 65
  fi
  if ! grep -q '^ROUTE_OPS_WEB_STATIC_IMAGE=' "$file"; then
    printf 'ROUTE_OPS_WEB_STATIC_IMAGE=%s:%s\n' "$ROUTE_OPS_WEB_STATIC_IMAGE_REPO" "$image_tag" >> "$file"
  fi
  if ! grep -q '^ROUTE_OPS_WEB_STATIC_VOLUME=' "$file"; then
    printf 'ROUTE_OPS_WEB_STATIC_VOLUME=clever-route-route-ops-web-static-%s\n' "$image_tag" >> "$file"
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

require_candidate_static_volume_isolated_from_current() {
  local current_file="$1"
  [ -f "$current_file" ] || return 0
  local current_tag current_volume
  current_tag="$(grep -m1 '^IMAGE_TAG=' "$current_file" | cut -d= -f2- || true)"
  current_volume="$(grep -m1 '^ROUTE_OPS_WEB_STATIC_VOLUME=' "$current_file" | cut -d= -f2- || true)"
  if [ -n "$current_tag" ] && [ "$current_tag" != "$IMAGE_TAG" ] && [ -n "$current_volume" ] && [ "$current_volume" = "$ROUTE_OPS_WEB_STATIC_VOLUME" ]; then
    echo "Refusing Route Ops deploy: candidate static volume matches current static volume for a different image tag." >&2
    exit 65
  fi
}


docker_root_dir() {
  local root
  root="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)"
  if [ -n "$root" ]; then
    printf '%s\n' "$root"
    return 0
  fi
  printf '/var/lib/docker\n'
}

disk_stats() {
  local path="$1"
  local line total available
  line="$(df -Pk "$path" 2>/dev/null | awk 'NR == 2 { print $2 " " $4 }')"
  if [ -z "$line" ]; then
    printf '0 0\n'
    return 0
  fi
  read -r total available <<< "$line"
  if [ -z "${total:-}" ] || [ "$total" -le 0 ] 2>/dev/null; then
    printf '0 0\n'
    return 0
  fi
  printf '%s %s\n' "$((available / 1024))" "$((available * 100 / total))"
}

path_has_disk_headroom() {
  local path="$1"
  local free_mb free_percent
  read -r free_mb free_percent <<< "$(disk_stats "$path")"
  [ "$free_mb" -ge "$ROUTE_OPS_DEPLOY_MIN_FREE_MB" ] && [ "$free_percent" -ge "$ROUTE_OPS_DEPLOY_MIN_FREE_PERCENT" ]
}

deploy_has_disk_headroom() {
  local root
  root="$(docker_root_dir)"
  path_has_disk_headroom "/" && path_has_disk_headroom "$root"
}

print_deploy_disk_summary() {
  local stage="$1"
  local root
  root="$(docker_root_dir)"
  echo "=== Route Ops deploy disk summary: ${stage} ==="
  if [ "$root" = "/" ]; then
    df -h /
  else
    df -h / "$root" 2>/dev/null || df -h /
  fi
  docker system df || true
}

add_keep_image() {
  local keep_file="$1"
  local image="$2"
  [ -n "$image" ] || return 0
  printf '%s\n' "$image" >> "$keep_file"
  docker image inspect --format '{{.Id}}' "$image" >> "$keep_file" 2>/dev/null || true
}

add_keep_images_from_env_file() {
  local keep_file="$1"
  local file="$2"
  [ -f "$file" ] || return 0
  local image
  image="$(grep -m1 '^DELIVERY_API_IMAGE=' "$file" | cut -d= -f2- || true)"
  add_keep_image "$keep_file" "$image"
  image="$(grep -m1 '^DELIVERY_API_MIGRATE_IMAGE=' "$file" | cut -d= -f2- || true)"
  add_keep_image "$keep_file" "$image"
  image="$(grep -m1 '^ROUTE_OPS_WEB_STATIC_IMAGE=' "$file" | cut -d= -f2- || true)"
  add_keep_image "$keep_file" "$image"
}

build_keep_image_file() {
  local keep_file="$1"
  : > "$keep_file"
  add_keep_image "$keep_file" "${DELIVERY_API_IMAGE:-}"
  add_keep_image "$keep_file" "${DELIVERY_API_MIGRATE_IMAGE:-}"
  add_keep_image "$keep_file" "${ROUTE_OPS_WEB_STATIC_IMAGE:-}"
  add_keep_images_from_env_file "$keep_file" ".deploy/current-image.env"
  add_keep_images_from_env_file "$keep_file" ".deploy/previous-image.env"
  add_keep_images_from_env_file "$keep_file" ".deploy/candidate-image.env"
  docker ps --format '{{.Image}}' >> "$keep_file" 2>/dev/null || true
  while IFS= read -r active_image || [ -n "$active_image" ]; do
    add_keep_image "$keep_file" "$active_image"
  done < <(docker ps --format '{{.Image}}' 2>/dev/null || true)
  if [ -n "${ROUTE_OPS_IMAGE_KEEP_TAGS:-}" ]; then
    printf '%s\n' "${ROUTE_OPS_IMAGE_KEEP_TAGS//,/ }" | tr ' ' '\n' | sed '/^$/d' >> "$keep_file"
  fi
  sort -u "$keep_file" -o "$keep_file"
}

keep_file_contains() {
  local keep_file="$1"
  local value="$2"
  [ -n "$value" ] && grep -Fxq "$value" "$keep_file"
}

should_keep_image() {
  local keep_file="$1"
  local image="$2"
  local tag="${image##*:}"
  local image_id
  keep_file_contains "$keep_file" "$image" && return 0
  keep_file_contains "$keep_file" "$tag" && return 0
  image_id="$(docker image inspect --format '{{.Id}}' "$image" 2>/dev/null || true)"
  keep_file_contains "$keep_file" "$image_id"
}

remove_image_if_unused() {
  local image="$1"
  if [ "$ROUTE_OPS_IMAGE_PRUNE_DRY_RUN" = "1" ]; then
    echo "dry-run remove ${image}"
    return 0
  fi
  docker image rm "$image" || true
}

prune_old_route_ops_images() {
  local reason="$1"
  local keep_file
  keep_file="$(mktemp ".deploy/route-ops-image-keep.XXXXXX")"
  build_keep_image_file "$keep_file"

  echo "Route Ops image retention cleanup starting: reason=${reason}"
  local removed_count=0
  local kept_count=0
  local skipped_count=0
  local repo image tag
  for repo in "$ROUTE_OPS_RUNTIME_IMAGE_REPO" "$ROUTE_OPS_MIGRATE_IMAGE_REPO" "$ROUTE_OPS_WEB_STATIC_IMAGE_REPO"; do
    while IFS= read -r image || [ -n "$image" ]; do
      [ -n "$image" ] || continue
      tag="${image##*:}"
      if ! [[ "$tag" =~ ^[0-9a-fA-F]{40}$ ]]; then
        echo "skip non-sha Route Ops image tag: ${image}"
        skipped_count=$((skipped_count + 1))
        continue
      fi
      if should_keep_image "$keep_file" "$image"; then
        echo "keep ${image}"
        kept_count=$((kept_count + 1))
        continue
      fi
      echo "remove stale Route Ops image ${image}"
      remove_image_if_unused "$image"
      removed_count=$((removed_count + 1))
    done < <(docker image ls "$repo" --format '{{.Repository}}:{{.Tag}}' 2>/dev/null || true)
  done

  if [ "$ROUTE_OPS_PRUNE_LEGACY_LOCAL_IMAGE" = "1" ] && docker image inspect clever-route-server-delivery-api:local >/dev/null 2>&1; then
    if should_keep_image "$keep_file" "clever-route-server-delivery-api:local"; then
      echo "keep clever-route-server-delivery-api:local"
      kept_count=$((kept_count + 1))
    else
      echo "remove legacy local image clever-route-server-delivery-api:local"
      remove_image_if_unused "clever-route-server-delivery-api:local"
      removed_count=$((removed_count + 1))
    fi
  fi

  rm -f "$keep_file"
  echo "Route Ops image retention cleanup finished: kept=${kept_count} removed=${removed_count} skipped=${skipped_count}"
}

ensure_deploy_disk_headroom() {
  local stage="$1"
  if deploy_has_disk_headroom; then
    print_deploy_disk_summary "${stage}: headroom-ok"
    return 0
  fi

  print_deploy_disk_summary "${stage}: low-headroom-before-cleanup"
  echo "Route Ops deploy disk headroom is below threshold; pruning stale Route Ops images." >&2
  prune_old_route_ops_images "${stage}"
  print_deploy_disk_summary "${stage}: after-cleanup"

  if deploy_has_disk_headroom; then
    return 0
  fi

  echo "Route Ops deploy disk headroom is still below threshold after cleanup." >&2
  echo "Required: ROUTE_OPS_DEPLOY_MIN_FREE_MB=${ROUTE_OPS_DEPLOY_MIN_FREE_MB}, ROUTE_OPS_DEPLOY_MIN_FREE_PERCENT=${ROUTE_OPS_DEPLOY_MIN_FREE_PERCENT}" >&2
  return 76
}

run_production_smoke() {
  if command -v node >/dev/null 2>&1; then
    ROUTE_OPS_SMOKE_BASE_URL="$BASE_URL" \
    ROUTE_OPS_SMOKE_SHOP_DOMAIN="$SHOP_DOMAIN" \
    ROUTE_OPS_SMOKE_LOGIN_SECRET="$ROUTE_OPS_SMOKE_LOGIN_SECRET" \
    ROUTE_OPS_EXPECT_PUBLIC_OPENFREEMAP="$EXPECT_PUBLIC_OPENFREEMAP" \
    ROUTE_OPS_EXPECT_GEOCODER_CONFIGURED="$EXPECT_GEOCODER_CONFIGURED" \
      node scripts/smoke-route-ops-production.mjs
    return 0
  fi

  echo "Host node not found; running Route Ops smoke through the runtime image."
  docker run --rm \
    -v "$APP_DIR/scripts/smoke-route-ops-production.mjs:/tmp/route-ops-smoke.mjs:ro" \
    -e ROUTE_OPS_SMOKE_BASE_URL="$BASE_URL" \
    -e ROUTE_OPS_SMOKE_SHOP_DOMAIN="$SHOP_DOMAIN" \
    -e ROUTE_OPS_SMOKE_LOGIN_SECRET="$ROUTE_OPS_SMOKE_LOGIN_SECRET" \
    -e ROUTE_OPS_EXPECT_PUBLIC_OPENFREEMAP="$EXPECT_PUBLIC_OPENFREEMAP" \
    -e ROUTE_OPS_EXPECT_GEOCODER_CONFIGURED="$EXPECT_GEOCODER_CONFIGURED" \
    "$DELIVERY_API_IMAGE" \
    node /tmp/route-ops-smoke.mjs
}

ensure_route_ops_ingress() {
  echo "Ensuring Route Ops Caddy ingress uses this repo's production Caddyfile under compose project ${ROUTE_OPS_COMPOSE_PROJECT_NAME}."
  route_ops_compose .deploy/candidate-image.env up -d --no-build --force-recreate --no-deps caddy
}

acquire_deploy_lock
trap 'release_deploy_lock' EXIT
enforce_no_legacy_route_ops_compose_project

cat > .deploy/candidate-image.env <<EOF_IMAGE
IMAGE_TAG=${IMAGE_TAG}
DELIVERY_API_IMAGE=${DELIVERY_API_IMAGE}
DELIVERY_API_MIGRATE_IMAGE=${DELIVERY_API_MIGRATE_IMAGE}
ROUTE_OPS_WEB_STATIC_IMAGE=${ROUTE_OPS_WEB_STATIC_IMAGE}
ROUTE_OPS_WEB_STATIC_VOLUME=${ROUTE_OPS_WEB_STATIC_VOLUME}
PRISMA_SCHEMA_SHA=${PRISMA_SCHEMA_SHA}
EOF_IMAGE

if [ -f .deploy/current-image.env ]; then ensure_static_artifact_env_file .deploy/current-image.env; fi
if [ -f .deploy/previous-image.env ]; then ensure_static_artifact_env_file .deploy/previous-image.env; fi

restore_current() {
  local status=$?
  if [ "$status" -ne 0 ] && [ -f .deploy/current-image.env ]; then
    echo "Deploy failed; restoring current image metadata." >&2
    load_image_env_file .deploy/current-image.env
    if [ "$ROUTE_OPS_SERVICE_MUTATED" = "true" ]; then
      route_ops_compose .deploy/current-image.env up -d --no-build --force-recreate --no-deps delivery-api || true
      route_ops_compose .deploy/current-image.env up -d --no-build --force-recreate --no-deps caddy || true
    fi
    if [ "$ROUTE_OPS_SERVICE_MUTATED" != "true" ]; then
      if [ "$ROUTE_OPS_STATIC_ARTIFACT_STAGED" = "true" ]; then
        echo "Deploy failed after staging candidate static artifact but before Route Ops backend service mutation; existing backend keeps its current static volume." >&2
      else
        echo "Deploy failed before Route Ops static artifact or backend service mutation; existing backend keeps its current static volume." >&2
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
require_candidate_static_volume_isolated_from_current .deploy/current-image.env
ensure_deploy_disk_headroom "pre-pull"
route_ops_compose .deploy/candidate-image.env pull route-ops-web-static delivery-api delivery-api-migrate

runtime_revision="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$DELIVERY_API_IMAGE")"
migrate_revision="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$DELIVERY_API_MIGRATE_IMAGE")"
static_revision="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$ROUTE_OPS_WEB_STATIC_IMAGE")"
runtime_schema="$(docker image inspect --format '{{ index .Config.Labels "org.clever-route.prisma-schema-sha" }}' "$DELIVERY_API_IMAGE")"
migrate_schema="$(docker image inspect --format '{{ index .Config.Labels "org.clever-route.prisma-schema-sha" }}' "$DELIVERY_API_MIGRATE_IMAGE")"
runtime_role="$(docker image inspect --format '{{ index .Config.Labels "org.clever-route.image-role" }}' "$DELIVERY_API_IMAGE")"
migrate_role="$(docker image inspect --format '{{ index .Config.Labels "org.clever-route.image-role" }}' "$DELIVERY_API_MIGRATE_IMAGE")"
static_role="$(docker image inspect --format '{{ index .Config.Labels "org.clever-route.image-role" }}' "$ROUTE_OPS_WEB_STATIC_IMAGE")"
test "$runtime_revision" = "$IMAGE_TAG"
test "$migrate_revision" = "$IMAGE_TAG"
test "$static_revision" = "$IMAGE_TAG"
test "$runtime_schema" = "$PRISMA_SCHEMA_SHA"
test "$migrate_schema" = "$PRISMA_SCHEMA_SHA"
test "$runtime_role" = "runtime"
test "$migrate_role" = "migrate"
test "$static_role" = "route-ops-web-static"

CURRENT_PRISMA_SCHEMA_SHA="$(grep '^PRISMA_SCHEMA_SHA=' .deploy/current-image.env | cut -d= -f2- || true)"
test -n "$CURRENT_PRISMA_SCHEMA_SHA"
test "$CURRENT_PRISMA_SCHEMA_SHA" = "$PRISMA_SCHEMA_SHA"

docker run --rm "$DELIVERY_API_MIGRATE_IMAGE" sh -lc 'test -f apps/delivery-api/prisma/schema.prisma && npm --prefix apps/delivery-api exec -- prisma --version'
ROUTE_OPS_STATIC_ARTIFACT_STAGED="true"
route_ops_compose .deploy/candidate-image.env up --no-build --force-recreate route-ops-web-static
route_ops_compose .deploy/candidate-image.env run --rm delivery-api-migrate
ROUTE_OPS_SERVICE_MUTATED="true"
route_ops_compose .deploy/candidate-image.env up -d --no-build --force-recreate --no-deps delivery-api
ensure_route_ops_ingress
route_ops_compose .deploy/candidate-image.env ps

run_production_smoke

if [ -f .deploy/current-image.env ]; then cp .deploy/current-image.env .deploy/previous-image.env; fi
mv .deploy/candidate-image.env .deploy/current-image.env
printf '{"ts":"%s","imageTag":"%s","deliveryApiImage":"%s","migrateImage":"%s","routeOpsWebStaticImage":"%s","routeOpsWebStaticVolume":"%s","prismaSchemaSha":"%s"}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$IMAGE_TAG" "$DELIVERY_API_IMAGE" "$DELIVERY_API_MIGRATE_IMAGE" "$ROUTE_OPS_WEB_STATIC_IMAGE" "$ROUTE_OPS_WEB_STATIC_VOLUME" "$PRISMA_SCHEMA_SHA" >> .deploy/deploy-history.jsonl
prune_old_route_ops_images "post-promote" || echo "Route Ops post-promote image cleanup failed; deploy promotion remains complete." >&2
release_deploy_lock
trap - EXIT
echo "Route Ops image deploy promoted: ${IMAGE_TAG}"
