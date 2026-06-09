#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/srv/clever-route-server}"
COMPOSE_FILE="${COMPOSE_FILE:-infra/compose/docker-compose.prod.yml}"
ROUTE_OPS_COMPOSE_PROJECT_NAME="${ROUTE_OPS_COMPOSE_PROJECT_NAME:-clever-route}"
BASE_URL="${ROUTE_OPS_SMOKE_BASE_URL:-https://clever-route.cleversystem.ai}"
SHOP_DOMAIN="${ROUTE_OPS_SMOKE_SHOP_DOMAIN:-tomatonofood.com}"
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
ROUTE_ENGINE_IMAGE_REPO="${ROUTE_ENGINE_IMAGE_REPO:-ghcr.io/evnsolution/route-engine-worker}"
ROUTE_ENGINE_IMAGE="${ROUTE_ENGINE_IMAGE:-${ROUTE_ENGINE_IMAGE_REPO}:3aa41c5f068b457d6881a0d46922156c43b68f98}"
ROUTE_ENGINE_GRAPH_HOST_DIR="${ROUTE_ENGINE_GRAPH_HOST_DIR:-/srv/clever-route-server/data/route-engine/parquet}"
ROUTE_OPS_WEB_STATIC_IMAGE="${ROUTE_OPS_WEB_STATIC_IMAGE:-${ROUTE_OPS_WEB_STATIC_IMAGE_REPO}:${IMAGE_TAG}}"
ROUTE_OPS_WEB_STATIC_VOLUME="${ROUTE_OPS_WEB_STATIC_VOLUME:-clever-route-route-ops-web-static-${IMAGE_TAG}}"
export ROUTE_ENGINE_GRAPH_HOST_DIR ROUTE_ENGINE_IMAGE ROUTE_OPS_WEB_STATIC_IMAGE ROUTE_OPS_WEB_STATIC_VOLUME
ROUTE_OPS_DEPLOY_MIN_FREE_MB="${ROUTE_OPS_DEPLOY_MIN_FREE_MB:-4096}"
ROUTE_OPS_DEPLOY_MIN_FREE_PERCENT="${ROUTE_OPS_DEPLOY_MIN_FREE_PERCENT:-20}"
ROUTE_OPS_IMAGE_PRUNE_DRY_RUN="${ROUTE_OPS_IMAGE_PRUNE_DRY_RUN:-0}"
ROUTE_OPS_PRUNE_LEGACY_LOCAL_IMAGE="${ROUTE_OPS_PRUNE_LEGACY_LOCAL_IMAGE:-0}"
ROUTE_ENGINE_HOST_ENV_BACKUP_PATH=""
ROUTE_ENGINE_HOST_ENV_EXISTED="false"
ROUTE_ENGINE_SERVICE_MUTATED="false"

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
    echo "Cannot derive Route Ops static artifact metadata without a 40-hex IMAGE_TAG in $file." >&2
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
  image="$(grep -m1 '^ROUTE_ENGINE_IMAGE=' "$file" | cut -d= -f2- || true)"
  add_keep_image "$keep_file" "$image"
}

build_keep_image_file() {
  local keep_file="$1"
  : > "$keep_file"
  add_keep_image "$keep_file" "${DELIVERY_API_IMAGE:-}"
  add_keep_image "$keep_file" "${DELIVERY_API_MIGRATE_IMAGE:-}"
  add_keep_image "$keep_file" "${ROUTE_OPS_WEB_STATIC_IMAGE:-}"
  add_keep_image "$keep_file" "${ROUTE_ENGINE_IMAGE:-}"
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
  for repo in "$ROUTE_OPS_RUNTIME_IMAGE_REPO" "$ROUTE_OPS_MIGRATE_IMAGE_REPO" "$ROUTE_OPS_WEB_STATIC_IMAGE_REPO" "$ROUTE_ENGINE_IMAGE_REPO"; do
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

set_route_ops_host_env_value() {
  local key value tmp_file
  key="$1"
  value="$2"
  mkdir -p infra/env .deploy
  touch infra/env/delivery-api.env
  tmp_file="$(mktemp infra/env/delivery-api.env.XXXXXX)"
  if grep -qE "^[[:space:]]*${key}=" infra/env/delivery-api.env; then
    awk -v key="$key" -v value="$value" '
      BEGIN { replaced = 0 }
      $0 ~ "^[[:space:]]*" key "=" {
        print key "=" value
        replaced = 1
        next
      }
      { print }
      END {
        if (!replaced) print key "=" value
      }
    ' infra/env/delivery-api.env > "$tmp_file"
  else
    cat infra/env/delivery-api.env > "$tmp_file"
    printf '%s=%s\n' "$key" "$value" >> "$tmp_file"
  fi
  chmod --reference=infra/env/delivery-api.env "$tmp_file" 2>/dev/null || chmod 0600 "$tmp_file"
  mv "$tmp_file" infra/env/delivery-api.env
}

generate_route_engine_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
    return 0
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 - <<'PYTHON'
import secrets
print(secrets.token_urlsafe(48))
PYTHON
    return 0
  fi
  echo "openssl or python3 is required to generate ROUTE_ENGINE_INTERNAL_TOKEN" >&2
  return 1
}

ensure_route_engine_host_env() {
  local backup_path base_url token
  mkdir -p .deploy
  if [ -f infra/env/delivery-api.env ]; then
    backup_path=".deploy/delivery-api.env.route-engine-backup-$(date -u +%Y%m%dT%H%M%SZ)"
    cp infra/env/delivery-api.env "$backup_path"
    chmod 0600 "$backup_path" 2>/dev/null || true
    ROUTE_ENGINE_HOST_ENV_BACKUP_PATH="$backup_path"
    ROUTE_ENGINE_HOST_ENV_EXISTED="true"
    echo "Route Engine host env backup created: ${backup_path}"
  else
    ROUTE_ENGINE_HOST_ENV_EXISTED="false"
  fi

  base_url="$(read_route_ops_host_env_value ROUTE_ENGINE_BASE_URL)"
  if [ -z "$base_url" ]; then
    set_route_ops_host_env_value ROUTE_ENGINE_BASE_URL "http://route-engine:8080"
    echo "Route Engine internal base URL enabled in infra/env/delivery-api.env."
  fi

  token="$(read_route_ops_host_env_value ROUTE_ENGINE_INTERNAL_TOKEN)"
  if [ -z "$token" ]; then
    token="$(generate_route_engine_token)"
    set_route_ops_host_env_value ROUTE_ENGINE_INTERNAL_TOKEN "$token"
    echo "Route Engine internal token generated in infra/env/delivery-api.env."
  fi

  if [ -z "$(read_route_ops_host_env_value ROUTE_ENGINE_TIMEOUT_MS)" ]; then
    set_route_ops_host_env_value ROUTE_ENGINE_TIMEOUT_MS "30000"
  fi
  if [ -z "$(read_route_ops_host_env_value ROUTE_ENGINE_MODE)" ]; then
    set_route_ops_host_env_value ROUTE_ENGINE_MODE "road_graph"
  fi
  if [ -z "$(read_route_ops_host_env_value ROUTE_ENGINE_OBJECTIVE)" ]; then
    set_route_ops_host_env_value ROUTE_ENGINE_OBJECTIVE "minimize_duration"
  fi
  if [ -z "$(read_route_ops_host_env_value ROUTE_ENGINE_SERVICE_REGION)" ]; then
    set_route_ops_host_env_value ROUTE_ENGINE_SERVICE_REGION "ontario"
  fi
}

restore_route_engine_host_env_on_failure() {
  if [ -n "$ROUTE_ENGINE_HOST_ENV_BACKUP_PATH" ] && [ -f "$ROUTE_ENGINE_HOST_ENV_BACKUP_PATH" ]; then
    cp "$ROUTE_ENGINE_HOST_ENV_BACKUP_PATH" infra/env/delivery-api.env
    chmod 0600 infra/env/delivery-api.env 2>/dev/null || true
    echo "Route Engine host env restored from pre-deploy backup." >&2
    return 0
  fi
  if [ "$ROUTE_ENGINE_HOST_ENV_EXISTED" != "true" ] && [ -f infra/env/delivery-api.env ]; then
    rm -f infra/env/delivery-api.env
    echo "Route Engine host env file removed after failed deploy because it did not exist before deploy." >&2
  fi
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
    echo "Provision the route_engine Git LFS parquet artifacts there before production activation." >&2
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
  set_route_ops_host_env_value ROUTE_ENGINE_GRAPH_MANIFEST_SHA "$expected_manifest_sha"
  echo "Route Engine graph artifacts verified: dir=${graph_dir} manifest=${expected_manifest_sha}"
}

smoke_route_engine_from_runtime_network() {
  local image_env_file ready_timeout_ms warmup_timeout_ms solve_timeout_ms
  image_env_file="$1"
  ready_timeout_ms="${ROUTE_ENGINE_READY_SMOKE_TIMEOUT_MS:-5000}"
  warmup_timeout_ms="${ROUTE_ENGINE_WARMUP_SMOKE_TIMEOUT_MS:-600000}"
  solve_timeout_ms="${ROUTE_ENGINE_SOLVE_SMOKE_TIMEOUT_MS:-120000}"
  echo "Smoking route_engine from the delivery-api runtime network: readyTimeoutMs=${ready_timeout_ms} warmupTimeoutMs=${warmup_timeout_ms} solveTimeoutMs=${solve_timeout_ms}."
  ROUTE_ENGINE_READY_SMOKE_TIMEOUT_MS="$ready_timeout_ms" \
  ROUTE_ENGINE_WARMUP_SMOKE_TIMEOUT_MS="$warmup_timeout_ms" \
  ROUTE_ENGINE_SOLVE_SMOKE_TIMEOUT_MS="$solve_timeout_ms" \
    route_ops_compose "$image_env_file" run --rm --no-deps \
      -e ROUTE_ENGINE_READY_SMOKE_TIMEOUT_MS \
      -e ROUTE_ENGINE_WARMUP_SMOKE_TIMEOUT_MS \
      -e ROUTE_ENGINE_SOLVE_SMOKE_TIMEOUT_MS \
      delivery-api node - <<'NODE'
const baseUrl = (process.env.ROUTE_ENGINE_BASE_URL || 'http://route-engine:8080').replace(/\/+$/, '');
const token = process.env.ROUTE_ENGINE_INTERNAL_TOKEN || '';
if (!token) throw new Error('ROUTE_ENGINE_INTERNAL_TOKEN is missing in delivery-api runtime env');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const positiveInteger = (name, fallback) => {
  const parsed = Number(process.env[name] || '');
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};
const readyTimeoutMs = positiveInteger('ROUTE_ENGINE_READY_SMOKE_TIMEOUT_MS', 5000);
const warmupTimeoutMs = positiveInteger('ROUTE_ENGINE_WARMUP_SMOKE_TIMEOUT_MS', 600000);
const solveTimeoutMs = positiveInteger('ROUTE_ENGINE_SOLVE_SMOKE_TIMEOUT_MS', 120000);
const fetchWithTimeout = async (url, options, timeoutMs, label) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`${label} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
};
const fetchJson = async (url, options, timeoutMs, label) => {
  const response = await fetchWithTimeout(url, options, timeoutMs, label);
  let body = null;
  try {
    body = await response.json();
  } catch (error) {
    body = { parse_error: String(error) };
  }
  return { response, body };
};

let readyResponse = null;
let ready = null;
let lastReadyError = null;
for (let attempt = 1; attempt <= 30; attempt += 1) {
  try {
    const result = await fetchJson(`${baseUrl}/readyz`, {
      headers: { 'X-Request-Id': `route-engine-prod-smoke-readyz-${attempt}` },
    }, readyTimeoutMs, `route_engine readyz attempt ${attempt}`);
    readyResponse = result.response;
    ready = result.body;
    if (readyResponse.ok && ready.service === 'route_engine' && ready.ready === true && ready.external_calls === false) {
      break;
    }
    lastReadyError = new Error(`status=${readyResponse.status} body=${JSON.stringify(ready)}`);
  } catch (error) {
    lastReadyError = error;
  }
  if (attempt < 30) await sleep(1000);
}
if (!readyResponse?.ok || ready?.service !== 'route_engine' || ready?.ready !== true || ready?.external_calls !== false) {
  throw new Error(`route_engine ready smoke failed after readiness wait: ${lastReadyError?.message || 'unknown error'}`);
}
console.log(JSON.stringify({ service: ready.service, ready: ready.ready, graph: ready.graph?.status, warmupTimeoutMs, solveTimeoutMs }));

const warmupResponse = await fetchWithTimeout(`${baseUrl}/internal/warmup`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'X-Request-Id': 'route-engine-prod-smoke-warmup-20260609',
  },
}, warmupTimeoutMs, 'route_engine warmup smoke');
const warmed = await warmupResponse.json();
if (!warmupResponse.ok || warmed.status !== 'warmed' || warmed.engine?.name !== 'route_engine' || warmed.engine?.external_calls !== false) {
  throw new Error(`route_engine warmup smoke failed: ${warmupResponse.status} ${JSON.stringify(warmed)}`);
}
console.log(JSON.stringify({
  service: ready.service,
  ready: ready.ready,
  graph: ready.graph?.status,
  warmupStatus: warmed.status,
  warmupElapsedMs: Math.round(warmed.warmup?.elapsed_ms || 0),
  cacheExists: warmed.warmup?.cache_exists === true,
  externalCalls: warmed.engine.external_calls,
}));

const solveResponse = await fetchWithTimeout(`${baseUrl}/v1/solve`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-Request-Id': 'route-engine-prod-smoke-solve-20260608',
    'X-Request-Timeout-Ms': String(solveTimeoutMs),
  },
  body: JSON.stringify({
    request_id: 'route-engine-prod-smoke-solve-20260608',
    tenant: { tenant_id: 'tenant-smoke', service_region: 'ontario' },
    depot: { depot_id: 'smoke-depot', lat: 43.6532, lng: -79.3832 },
    drivers: [{ driver_id: 'driver-smoke-1', capacity: 10 }],
    stops: [
      { stop_id: 'smoke-stop-1', lat: 43.6426, lng: -79.3871, demand: 1, service_seconds: 60 },
      { stop_id: 'smoke-stop-2', lat: 43.5890, lng: -79.6441, demand: 1, service_seconds: 60 },
    ],
    options: { mode: 'road_graph', objective: 'minimize_duration', timeout_ms: solveTimeoutMs },
  }),
}, solveTimeoutMs + 5000, 'route_engine solve smoke');
const solved = await solveResponse.json();
if (!solveResponse.ok || solved.status !== 'solved' || solved.engine?.name !== 'route_engine' || solved.engine?.external_calls !== false) {
  throw new Error(`route_engine solve smoke failed: ${solveResponse.status} ${JSON.stringify(solved)}`);
}
const route = solved.result?.routes?.[0];
if (!route || route.summary?.total_stops !== 2 || !(route.summary?.total_distance_meters > 0) || !(route.summary?.total_duration_seconds > 0)) {
  throw new Error(`route_engine solve smoke returned invalid route summary: ${JSON.stringify(solved.result)}`);
}
console.log(JSON.stringify({
  service: ready.service,
  ready: ready.ready,
  graph: ready.graph?.status,
  status: solved.status,
  routeStops: route.summary.total_stops,
  distanceMeters: Math.round(route.summary.total_distance_meters),
  durationSeconds: Math.round(route.summary.total_duration_seconds),
  externalCalls: solved.engine.external_calls,
}));
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
  route_engine_revision="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$ROUTE_ENGINE_IMAGE")"
  route_engine_role="$(docker image inspect --format '{{ index .Config.Labels "org.clever-route.image-role" }}' "$ROUTE_ENGINE_IMAGE")"
  route_engine_graph_manifest_sha="$(route_engine_image_graph_manifest_sha)"
  test "$route_engine_revision" = "${ROUTE_ENGINE_IMAGE##*:}"
  test "$route_engine_role" = "route-engine-worker"
  validate_route_engine_graph_artifacts "$route_engine_graph_manifest_sha"
  echo "Ensuring route_engine worker service is attached to the durable clever-route compose project."
  route_ops_compose "$image_env_file" --profile route-engine up -d --no-build route-engine
  ROUTE_ENGINE_SERVICE_MUTATED="true"
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

cat > .deploy/candidate-image.env <<EOF_IMAGE
IMAGE_TAG=${IMAGE_TAG}
DELIVERY_API_IMAGE=${DELIVERY_API_IMAGE}
DELIVERY_API_MIGRATE_IMAGE=${DELIVERY_API_MIGRATE_IMAGE}
ROUTE_OPS_WEB_STATIC_IMAGE=${ROUTE_OPS_WEB_STATIC_IMAGE}
ROUTE_OPS_WEB_STATIC_VOLUME=${ROUTE_OPS_WEB_STATIC_VOLUME}
ROUTE_ENGINE_IMAGE=${ROUTE_ENGINE_IMAGE}
ROUTE_ENGINE_GRAPH_HOST_DIR=${ROUTE_ENGINE_GRAPH_HOST_DIR}
PRISMA_SCHEMA_SHA=${PRISMA_SCHEMA_SHA}
EOF_IMAGE

if [ -f .deploy/current-image.env ]; then ensure_static_artifact_env_file .deploy/current-image.env; fi
if [ -f .deploy/previous-image.env ]; then ensure_static_artifact_env_file .deploy/previous-image.env; fi

restore_current() {
  local status="${1:-$?}"
  trap - EXIT INT TERM
  if [ "$status" -ne 0 ] && [ -f .deploy/current-image.env ]; then
    echo "Deploy failed; restoring current image metadata." >&2
    restore_route_engine_host_env_on_failure
    load_image_env_file .deploy/current-image.env
    if [ "$ROUTE_OPS_SERVICE_MUTATED" = "true" ]; then
      ensure_route_engine .deploy/current-image.env || true
      ensure_route_ops_osrm .deploy/current-image.env || true
      route_ops_compose .deploy/current-image.env up -d --no-build --force-recreate --no-deps delivery-api || true
      stop_route_engine_if_disabled .deploy/current-image.env || true
      stop_route_ops_osrm_if_disabled .deploy/current-image.env || true
      route_ops_compose .deploy/current-image.env up -d --no-build --force-recreate --no-deps caddy || true
    fi
    if [ "$ROUTE_ENGINE_SERVICE_MUTATED" = "true" ] && [ "$ROUTE_OPS_SERVICE_MUTATED" != "true" ]; then
      echo "Deploy failed after route_engine service mutation but before Route Ops backend mutation; stopping route_engine." >&2
      route_ops_compose .deploy/candidate-image.env --profile route-engine stop route-engine || true
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
trap 'restore_current "$?"' EXIT
trap 'restore_current 130' INT
trap 'restore_current 143' TERM

ensure_route_engine_host_env
load_image_env_file .deploy/candidate-image.env
validate_loaded_static_artifact_contract .deploy/candidate-image.env
require_candidate_static_volume_isolated_from_current .deploy/current-image.env
ensure_deploy_disk_headroom "pre-pull"
prune_old_route_ops_images "pre-pull-retention"
ensure_deploy_disk_headroom "pre-pull-after-retention"
route_ops_compose .deploy/candidate-image.env --profile route-engine pull route-ops-web-static delivery-api delivery-api-migrate route-engine
ensure_deploy_disk_headroom "post-pull"

runtime_revision="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$DELIVERY_API_IMAGE")"
migrate_revision="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$DELIVERY_API_MIGRATE_IMAGE")"
static_revision="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$ROUTE_OPS_WEB_STATIC_IMAGE")"
runtime_schema="$(docker image inspect --format '{{ index .Config.Labels "org.clever-route.prisma-schema-sha" }}' "$DELIVERY_API_IMAGE")"
migrate_schema="$(docker image inspect --format '{{ index .Config.Labels "org.clever-route.prisma-schema-sha" }}' "$DELIVERY_API_MIGRATE_IMAGE")"
runtime_role="$(docker image inspect --format '{{ index .Config.Labels "org.clever-route.image-role" }}' "$DELIVERY_API_IMAGE")"
migrate_role="$(docker image inspect --format '{{ index .Config.Labels "org.clever-route.image-role" }}' "$DELIVERY_API_MIGRATE_IMAGE")"
static_role="$(docker image inspect --format '{{ index .Config.Labels "org.clever-route.image-role" }}' "$ROUTE_OPS_WEB_STATIC_IMAGE")"
route_engine_revision="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$ROUTE_ENGINE_IMAGE")"
route_engine_role="$(docker image inspect --format '{{ index .Config.Labels "org.clever-route.image-role" }}' "$ROUTE_ENGINE_IMAGE")"
route_engine_graph_manifest_sha="$(route_engine_image_graph_manifest_sha)"
test "$runtime_revision" = "$IMAGE_TAG"
test "$migrate_revision" = "$IMAGE_TAG"
test "$static_revision" = "$IMAGE_TAG"
test "$runtime_schema" = "$PRISMA_SCHEMA_SHA"
test "$migrate_schema" = "$PRISMA_SCHEMA_SHA"
test "$runtime_role" = "runtime"
test "$migrate_role" = "migrate"
test "$static_role" = "route-ops-web-static"
test "$route_engine_revision" = "${ROUTE_ENGINE_IMAGE##*:}"
test "$route_engine_role" = "route-engine-worker"
if route_engine_configured; then
  validate_route_engine_graph_artifacts "$route_engine_graph_manifest_sha"
fi

CURRENT_PRISMA_SCHEMA_SHA="$(grep '^PRISMA_SCHEMA_SHA=' .deploy/current-image.env | cut -d= -f2- || true)"
test -n "$CURRENT_PRISMA_SCHEMA_SHA"
if [ "$CURRENT_PRISMA_SCHEMA_SHA" != "$PRISMA_SCHEMA_SHA" ]; then
  echo "Route Ops deploy schema change detected: current=${CURRENT_PRISMA_SCHEMA_SHA} candidate=${PRISMA_SCHEMA_SHA}; running candidate migrate before promotion."
fi

docker run --rm "$DELIVERY_API_MIGRATE_IMAGE" sh -lc 'test -f apps/delivery-api/prisma/schema.prisma && npm --prefix apps/delivery-api exec -- prisma --version'
ROUTE_OPS_STATIC_ARTIFACT_STAGED="true"
route_ops_compose .deploy/candidate-image.env up --no-build --force-recreate route-ops-web-static
route_ops_compose .deploy/candidate-image.env run --rm delivery-api-migrate
ensure_route_engine .deploy/candidate-image.env
ensure_route_ops_osrm .deploy/candidate-image.env
ROUTE_OPS_SERVICE_MUTATED="true"
route_ops_compose .deploy/candidate-image.env up -d --no-build --force-recreate --no-deps delivery-api
stop_route_engine_if_disabled .deploy/candidate-image.env
stop_route_ops_osrm_if_disabled .deploy/candidate-image.env
ensure_route_ops_ingress
route_ops_compose .deploy/candidate-image.env ps

run_production_smoke

if [ -f .deploy/current-image.env ]; then cp .deploy/current-image.env .deploy/previous-image.env; fi
mv .deploy/candidate-image.env .deploy/current-image.env
printf '{"ts":"%s","imageTag":"%s","deliveryApiImage":"%s","migrateImage":"%s","routeOpsWebStaticImage":"%s","routeOpsWebStaticVolume":"%s","routeEngineImage":"%s","prismaSchemaSha":"%s","routeEngineEnabled":%s,"osrmEnabled":%s}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$IMAGE_TAG" "$DELIVERY_API_IMAGE" "$DELIVERY_API_MIGRATE_IMAGE" "$ROUTE_OPS_WEB_STATIC_IMAGE" "$ROUTE_OPS_WEB_STATIC_VOLUME" "$ROUTE_ENGINE_IMAGE" "$PRISMA_SCHEMA_SHA" "$(route_engine_enabled_json)" "$(route_ops_osrm_enabled_json)" >> .deploy/deploy-history.jsonl
prune_old_route_ops_images "post-promote" || echo "Route Ops post-promote image cleanup failed; deploy promotion remains complete." >&2
release_deploy_lock
trap - EXIT
echo "Route Ops image deploy promoted: ${IMAGE_TAG}"
