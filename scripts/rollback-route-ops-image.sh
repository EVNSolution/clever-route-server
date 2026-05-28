#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/srv/clever-route-server}"
COMPOSE_FILE="${COMPOSE_FILE:-infra/compose/docker-compose.prod.yml}"
BASE_URL="${ROUTE_OPS_SMOKE_BASE_URL:-https://clever-route.cleversystem.ai}"
SHOP_DOMAIN="${ROUTE_OPS_SMOKE_SHOP_DOMAIN:-dev1.tomatonofood.com}"
: "${ROUTE_OPS_SMOKE_LOGIN_SECRET:?ROUTE_OPS_SMOKE_LOGIN_SECRET is required locally for rollback smoke}"

cd "$APP_DIR"

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
test -f .deploy/current-image.env
test -f .deploy/previous-image.env
cp .deploy/current-image.env .deploy/rollback-from-image.env
cp .deploy/previous-image.env .deploy/candidate-image.env

restore_current() {
  local status=$?
  if [ "$status" -ne 0 ] && [ -f .deploy/rollback-from-image.env ]; then
    echo "Rollback failed; restoring pre-rollback current image metadata." >&2
    load_image_env_file .deploy/rollback-from-image.env
    docker compose --env-file .deploy/rollback-from-image.env -f "$COMPOSE_FILE" up -d --no-build --force-recreate --no-deps delivery-api || true
    rm -f .deploy/candidate-image.env
  fi
  exit "$status"
}
trap restore_current EXIT

load_image_env_file .deploy/candidate-image.env
CURRENT_PRISMA_SCHEMA_SHA="$(grep '^PRISMA_SCHEMA_SHA=' .deploy/rollback-from-image.env | cut -d= -f2- || true)"
test -n "$CURRENT_PRISMA_SCHEMA_SHA"
test "$CURRENT_PRISMA_SCHEMA_SHA" = "$PRISMA_SCHEMA_SHA"

docker compose --env-file .deploy/candidate-image.env -f "$COMPOSE_FILE" pull delivery-api delivery-api-migrate
runtime_role="$(docker image inspect --format '{{ index .Config.Labels "org.clever-route.image-role" }}' "$DELIVERY_API_IMAGE")"
migrate_role="$(docker image inspect --format '{{ index .Config.Labels "org.clever-route.image-role" }}' "$DELIVERY_API_MIGRATE_IMAGE")"
test "$runtime_role" = "runtime"
test "$migrate_role" = "migrate"
docker run --rm "$DELIVERY_API_MIGRATE_IMAGE" sh -lc 'test -f apps/delivery-api/prisma/schema.prisma && npm --prefix apps/delivery-api exec -- prisma --version'
docker compose --env-file .deploy/candidate-image.env -f "$COMPOSE_FILE" run --rm delivery-api-migrate
docker compose --env-file .deploy/candidate-image.env -f "$COMPOSE_FILE" up -d --no-build --force-recreate --no-deps delivery-api

ROUTE_OPS_SMOKE_BASE_URL="$BASE_URL" \
ROUTE_OPS_SMOKE_SHOP_DOMAIN="$SHOP_DOMAIN" \
ROUTE_OPS_SMOKE_LOGIN_SECRET="$ROUTE_OPS_SMOKE_LOGIN_SECRET" \
node scripts/smoke-route-ops-production.mjs

mv .deploy/current-image.env .deploy/previous-image.env
mv .deploy/candidate-image.env .deploy/current-image.env
printf '{"ts":"%s","rollbackTo":"%s","deliveryApiImage":"%s","migrateImage":"%s","prismaSchemaSha":"%s"}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${IMAGE_TAG:-unknown}" "$DELIVERY_API_IMAGE" "$DELIVERY_API_MIGRATE_IMAGE" "$PRISMA_SCHEMA_SHA" >> .deploy/deploy-history.jsonl
trap - EXIT
echo "Route Ops image rollback promoted: ${IMAGE_TAG:-unknown}"
