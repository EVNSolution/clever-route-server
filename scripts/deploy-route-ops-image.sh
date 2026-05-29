#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/srv/clever-route-server}"
COMPOSE_FILE="${COMPOSE_FILE:-infra/compose/docker-compose.prod.yml}"
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

LOCK_PATH="${ROUTE_OPS_DEPLOY_LOCK_PATH:-.deploy/route-ops-deploy.lock}"
LOCK_DIR="${LOCK_PATH}.d"
LOCK_ACQUIRED="false"

release_deploy_lock() {
  if [ "$LOCK_ACQUIRED" = "mkdir" ] && [ -d "$LOCK_DIR" ]; then
    rmdir "$LOCK_DIR" || true
  fi
}

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
      IMAGE_TAG=*|DELIVERY_API_IMAGE=*|DELIVERY_API_MIGRATE_IMAGE=*|PRISMA_SCHEMA_SHA=*) ;;
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
  set +a
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

acquire_deploy_lock
trap 'release_deploy_lock' EXIT

cat > .deploy/candidate-image.env <<EOF_IMAGE
IMAGE_TAG=${IMAGE_TAG}
DELIVERY_API_IMAGE=${DELIVERY_API_IMAGE}
DELIVERY_API_MIGRATE_IMAGE=${DELIVERY_API_MIGRATE_IMAGE}
PRISMA_SCHEMA_SHA=${PRISMA_SCHEMA_SHA}
EOF_IMAGE

restore_current() {
  local status=$?
  if [ "$status" -ne 0 ] && [ -f .deploy/current-image.env ]; then
    echo "Deploy failed; restoring current image metadata." >&2
    load_image_env_file .deploy/current-image.env
    docker compose --env-file .deploy/current-image.env -f "$COMPOSE_FILE" up -d --no-build --force-recreate --no-deps delivery-api || true
    rm -f .deploy/candidate-image.env
  fi
  release_deploy_lock
  exit "$status"
}
trap restore_current EXIT

load_image_env_file .deploy/candidate-image.env
docker compose --env-file .deploy/candidate-image.env -f "$COMPOSE_FILE" pull delivery-api delivery-api-migrate

runtime_revision="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$DELIVERY_API_IMAGE")"
migrate_revision="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$DELIVERY_API_MIGRATE_IMAGE")"
runtime_schema="$(docker image inspect --format '{{ index .Config.Labels "org.clever-route.prisma-schema-sha" }}' "$DELIVERY_API_IMAGE")"
migrate_schema="$(docker image inspect --format '{{ index .Config.Labels "org.clever-route.prisma-schema-sha" }}' "$DELIVERY_API_MIGRATE_IMAGE")"
runtime_role="$(docker image inspect --format '{{ index .Config.Labels "org.clever-route.image-role" }}' "$DELIVERY_API_IMAGE")"
migrate_role="$(docker image inspect --format '{{ index .Config.Labels "org.clever-route.image-role" }}' "$DELIVERY_API_MIGRATE_IMAGE")"
test "$runtime_revision" = "$IMAGE_TAG"
test "$migrate_revision" = "$IMAGE_TAG"
test "$runtime_schema" = "$PRISMA_SCHEMA_SHA"
test "$migrate_schema" = "$PRISMA_SCHEMA_SHA"
test "$runtime_role" = "runtime"
test "$migrate_role" = "migrate"

CURRENT_PRISMA_SCHEMA_SHA="$(grep '^PRISMA_SCHEMA_SHA=' .deploy/current-image.env | cut -d= -f2- || true)"
test -n "$CURRENT_PRISMA_SCHEMA_SHA"
test "$CURRENT_PRISMA_SCHEMA_SHA" = "$PRISMA_SCHEMA_SHA"

docker run --rm "$DELIVERY_API_MIGRATE_IMAGE" sh -lc 'test -f apps/delivery-api/prisma/schema.prisma && npm --prefix apps/delivery-api exec -- prisma --version'
docker compose --env-file .deploy/candidate-image.env -f "$COMPOSE_FILE" run --rm delivery-api-migrate
docker compose --env-file .deploy/candidate-image.env -f "$COMPOSE_FILE" up -d --no-build --force-recreate --no-deps delivery-api
docker compose --env-file .deploy/candidate-image.env -f "$COMPOSE_FILE" ps

run_production_smoke

if [ -f .deploy/current-image.env ]; then cp .deploy/current-image.env .deploy/previous-image.env; fi
mv .deploy/candidate-image.env .deploy/current-image.env
printf '{"ts":"%s","imageTag":"%s","deliveryApiImage":"%s","migrateImage":"%s","prismaSchemaSha":"%s"}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$IMAGE_TAG" "$DELIVERY_API_IMAGE" "$DELIVERY_API_MIGRATE_IMAGE" "$PRISMA_SCHEMA_SHA" >> .deploy/deploy-history.jsonl
release_deploy_lock
trap - EXIT
echo "Route Ops image deploy promoted: ${IMAGE_TAG}"
