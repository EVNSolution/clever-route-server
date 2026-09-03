#!/usr/bin/env bash
set -euo pipefail

AWS_REGION="${AWS_REGION:-ap-northeast-2}"
APP_DIR="${APP_DIR:-/srv/clever-route-server}"
COMPOSE_FILE="${COMPOSE_FILE:-infra/compose/docker-compose.prod.yml}"
VROOM_CONFIG="${VROOM_CONFIG:-infra/vroom/config.yml}"
VROOM_KOREA_CONFIG="${VROOM_KOREA_CONFIG:-infra/vroom/config.korea.yml}"
COMPOSE_PROJECT="${ROUTE_OPS_COMPOSE_PROJECT_NAME:-clever-route}"
SERVICE_TAG_KEY="${ROUTE_OPS_SSM_TAG_KEY:-Service}"
SERVICE_TAG_VALUE="${ROUTE_OPS_SSM_TAG_VALUE:-clever-delivery-server}"
CHANNEL_TAG="${ROUTE_OPS_SIMPLE_CHANNEL_TAG:-prod}"
COMMIT_SHA="$(git rev-parse --short=40 HEAD)"
PRISMA_SCHEMA_SHA="$(shasum -a 256 apps/delivery-api/prisma/schema.prisma | awk '{print $1}')"
RUNTIME_IMAGE_REPO="${ROUTE_OPS_RUNTIME_IMAGE_REPO:-ghcr.io/evnsolution/clever-route-server-delivery-api}"
MIGRATION_IMAGE_REPO="${ROUTE_OPS_MIGRATION_IMAGE_REPO:-ghcr.io/evnsolution/clever-route-server-delivery-api-migration}"
STATIC_IMAGE_REPO="${ROUTE_OPS_WEB_STATIC_IMAGE_REPO:-ghcr.io/evnsolution/clever-route-server-route-ops-web-static}"
RUNTIME_IMAGE="${ROUTE_OPS_RUNTIME_IMAGE:-${RUNTIME_IMAGE_REPO}:${CHANNEL_TAG}}"
MIGRATION_IMAGE="${ROUTE_OPS_MIGRATION_IMAGE:-${MIGRATION_IMAGE_REPO}:${CHANNEL_TAG}}"
RUN_MIGRATIONS="${ROUTE_OPS_RUN_MIGRATIONS:-1}"
STATIC_IMAGE="${ROUTE_OPS_WEB_STATIC_IMAGE:-${STATIC_IMAGE_REPO}:${CHANNEL_TAG}}"
STATIC_VOLUME="${ROUTE_OPS_WEB_STATIC_VOLUME:-clever-route-route-ops-web-static-${CHANNEL_TAG}}"
VROOM_IMAGE="${VROOM_IMAGE:-ghcr.io/vroom-project/vroom-docker@sha256:247d5683d6745c755d718a156d16b16aac80baccc276a003a68b986c13883b08}"
BASE_URL="${ROUTE_OPS_SMOKE_BASE_URL:-https://clever-route-api.cleversystem.ai}"
LEGACY_BASE_URL="${ROUTE_OPS_LEGACY_SMOKE_BASE_URL:-https://clever-route.cleversystem.ai}"
SMOKE_URLS="${ROUTE_OPS_SMOKE_URLS:-${BASE_URL}/healthz ${LEGACY_BASE_URL}/healthz}"
DRY_RUN=0
BUILD_AND_PUSH=0
SEND_COMMAND=1
FORCE_STATIC_RESTAGE="${ROUTE_OPS_FORCE_STATIC_RESTAGE:-0}"
DSV_MIGRATION_APPROVED="${DSV_MIGRATION_APPROVED:-}"
DSV_MIGRATION_MANIFEST_SHA256="${DSV_MIGRATION_MANIFEST_SHA256:-}"
DSV_RESTORE_REHEARSAL_SHA256="${DSV_RESTORE_REHEARSAL_SHA256:-}"
DSV_PRODUCTION_BASELINE_APPROVED="${DSV_PRODUCTION_BASELINE_APPROVED:-}"
DSV_PRODUCTION_BASELINE_MANIFEST_SHA256="${DSV_PRODUCTION_BASELINE_MANIFEST_SHA256:-}"
FIREBASE_CREDENTIALS_PARAM="${ROUTE_OPS_FIREBASE_CREDENTIALS_PARAM:-/clever/route-ops/firebase/fcm-service-account-json}"
UVIS_ENV_PARAM="${ROUTE_OPS_UVIS_ENV_PARAM:-}"
PROOF_READY_FILTER_CONTRACT_SHA=''

usage() {
  cat <<USAGE
Usage: $0 [--dry-run] [--publish] [--no-send]

Simple Route Ops SSM deploy lane: no S3 deploy-control bundle, no EC2 build,
no prod-prev image retagging, and no ingress/Caddy
mutation. GitHub Actions should publish digest-addressable images first, then
pass ROUTE_OPS_RUNTIME_IMAGE, ROUTE_OPS_MIGRATION_IMAGE, and
ROUTE_OPS_WEB_STATIC_IMAGE as repo@sha256 refs.
The SSM command only pulls, audits custom-order ownership, runs migration,
stages static assets, recreates clever-route-api, and healthchecks.

Env:
  ROUTE_OPS_SIMPLE_CHANNEL_TAG   default: prod
  ROUTE_OPS_RUNTIME_IMAGE        optional full runtime image ref, preferably repo@sha256
  ROUTE_OPS_MIGRATION_IMAGE      optional full migration image ref, preferably repo@sha256
  ROUTE_OPS_RUN_MIGRATIONS       1 to run guarded migrations, 0 to skip; default: 1
  ROUTE_OPS_WEB_STATIC_IMAGE     optional full static image ref, preferably repo@sha256
  ROUTE_OPS_FORCE_STATIC_RESTAGE  set to 1 to stage static even when digest matches current
  ROUTE_OPS_FIREBASE_CREDENTIALS_PARAM encrypted SSM parameter containing FCM credentials
  ROUTE_OPS_UVIS_ENV_PARAM        optional encrypted SSM parameter containing server-only UVIS_* dotenv lines
  AWS_REGION                     default: ap-northeast-2
  ROUTE_OPS_SSM_TAG_KEY          default: Service
  ROUTE_OPS_SSM_TAG_VALUE        default: clever-delivery-server
  VROOM_CONFIG                   default: infra/vroom/config.yml
  VROOM_KOREA_CONFIG             default: infra/vroom/config.korea.yml
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --publish) BUILD_AND_PUSH=1 ;;
    --no-send) SEND_COMMAND=0 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 64 ;;
  esac
  shift
done

fail() { echo "ssm-simple-route-ops-deploy: $*" >&2; exit 65; }

require_publish_auth() {
  if [ "${ROUTE_OPS_SKIP_GHCR_WRITE_SCOPE_CHECK:-0}" = "1" ]; then
    echo "warning: skipping GitHub CLI package-scope precheck; Docker/GHCR push failures remain fatal" >&2
    return 0
  fi
  if command -v gh >/dev/null 2>&1; then
    local auth_status
    auth_status="$(gh auth status -h github.com 2>&1 || true)"
    if ! printf '%s\n' "$auth_status" | grep -q 'write:packages'; then
      echo "warning: GitHub CLI auth status does not show write:packages; continuing because docker push is the authoritative GHCR publish check" >&2
      echo "warning: if publish fails, refresh GHCR Docker login with a write-capable token" >&2
    fi
  fi
}

[[ "$CHANNEL_TAG" =~ ^[A-Za-z0-9_.-]+$ ]] || fail "ROUTE_OPS_SIMPLE_CHANNEL_TAG must be a Docker tag fragment"
[[ "$PRISMA_SCHEMA_SHA" =~ ^[0-9a-f]{64}$ ]] || fail "schema SHA calculation failed"
if [ "$BUILD_AND_PUSH" = "1" ]; then
  test -z "$(git status --porcelain)" || { git status --short; fail "dirty checkout; commit/stash before publishing a deploy channel"; }
  require_publish_auth
fi

build_and_push() {
  docker buildx version >/dev/null 2>&1 || fail "docker buildx is required for --publish; install the docker-buildx CLI plugin or use GitHub Actions publish_images=true"
  docker buildx build --platform linux/amd64 \
    -f apps/route-ops-web/Dockerfile \
    --target static \
    --push \
    --provenance=false \
    --build-arg COMMIT_SHA="$COMMIT_SHA" \
    --build-arg PRISMA_SCHEMA_SHA="$PRISMA_SCHEMA_SHA" \
    --label "org.opencontainers.image.revision=$COMMIT_SHA" \
    --label "org.clever-route.prisma-schema-sha=$PRISMA_SCHEMA_SHA" \
    --label "org.clever-route.image-role=route-ops-web-static" \
    --cache-from "type=registry,ref=${STATIC_IMAGE_REPO}:buildcache" \
    --cache-to "type=registry,ref=${STATIC_IMAGE_REPO}:buildcache,mode=max" \
    -t "${STATIC_IMAGE_REPO}:${CHANNEL_TAG}" .
  docker buildx build --platform linux/amd64 \
    -f apps/delivery-api/Dockerfile \
    --target runtime \
    --push \
    --provenance=false \
    --label "org.opencontainers.image.revision=$COMMIT_SHA" \
    --label "org.clever-route.prisma-schema-sha=$PRISMA_SCHEMA_SHA" \
    --label "org.clever-route.image-role=runtime" \
    --label "org.clever-route.route-completion-invariant-capability=1" \
    --cache-from "type=registry,ref=${RUNTIME_IMAGE_REPO}:buildcache" \
    --cache-to "type=registry,ref=${RUNTIME_IMAGE_REPO}:buildcache,mode=max" \
    -t "${RUNTIME_IMAGE_REPO}:${CHANNEL_TAG}" .
  if [ "$RUN_MIGRATIONS" = "1" ]; then
    docker buildx build --platform linux/amd64 \
      -f apps/delivery-api/Dockerfile \
      --target migration \
      --push \
      --provenance=false \
      --label "org.opencontainers.image.revision=$COMMIT_SHA" \
      --label "org.clever-route.prisma-schema-sha=$PRISMA_SCHEMA_SHA" \
      --label "org.clever-route.image-role=migration" \
      --cache-from "type=registry,ref=${MIGRATION_IMAGE_REPO}:buildcache" \
      --cache-to "type=registry,ref=${MIGRATION_IMAGE_REPO}:buildcache,mode=max" \
      -t "${MIGRATION_IMAGE_REPO}:${CHANNEL_TAG}" .
  fi
  images=("${STATIC_IMAGE_REPO}:${CHANNEL_TAG}" "${RUNTIME_IMAGE_REPO}:${CHANNEL_TAG}")
  if [ "$RUN_MIGRATIONS" = "1" ]; then images+=("${MIGRATION_IMAGE_REPO}:${CHANNEL_TAG}"); fi
  for image in "${images[@]}"; do
    docker buildx imagetools inspect "$image" --format '{{json .Manifest.Digest}}'
  done
}

[[ "$RUN_MIGRATIONS" == "0" || "$RUN_MIGRATIONS" == "1" ]] \
  || fail "ROUTE_OPS_RUN_MIGRATIONS must be 0 or 1"

resolve_instance() {
  read -r count instance_id ping_status <<EOF_RESOLVE
$(aws ssm describe-instance-information \
  --region "$AWS_REGION" \
  --filters "Key=tag:${SERVICE_TAG_KEY},Values=${SERVICE_TAG_VALUE}" \
  --query '[length(InstanceInformationList), InstanceInformationList[0].InstanceId, InstanceInformationList[0].PingStatus]' \
  --output text)
EOF_RESOLVE
  test "$count" = "1" || fail "expected exactly one SSM target for ${SERVICE_TAG_KEY}=${SERVICE_TAG_VALUE}; got ${count}"
  test "$ping_status" = "Online" || fail "SSM target ${instance_id} is not Online: ${ping_status}"
  printf '%s' "$instance_id"
}

write_parameters() {
  local path="$1"
  local inner_path
  inner_path="$(mktemp /tmp/route-ops-simple-host.XXXXXX)"
  cat > "$inner_path" <<'HOST_SCRIPT'
set -euo pipefail
AWS_REGION=__AWS_REGION__
APP_DIR=__APP_DIR__
COMPOSE_FILE=__COMPOSE_FILE__
VROOM_CONFIG=__VROOM_CONFIG__
VROOM_KOREA_CONFIG=__VROOM_KOREA_CONFIG__
COMPOSE_PROJECT=__COMPOSE_PROJECT__
COMMIT_SHA=__COMMIT_SHA__
CHANNEL_TAG=__CHANNEL_TAG__
PRISMA_SCHEMA_SHA=__PRISMA_SCHEMA_SHA__
PROOF_READY_FILTER_CONTRACT_SHA=__PROOF_READY_FILTER_CONTRACT_SHA__
DELIVERY_API_IMAGE=__RUNTIME_IMAGE__
DELIVERY_API_MIGRATION_IMAGE=__MIGRATION_IMAGE__
RUN_MIGRATIONS=__RUN_MIGRATIONS__
ROUTE_OPS_WEB_STATIC_IMAGE=__STATIC_IMAGE__
ROUTE_OPS_WEB_STATIC_VOLUME=__STATIC_VOLUME__
VROOM_IMAGE=__VROOM_IMAGE__
BASE_URL=__BASE_URL__
SMOKE_URLS=__SMOKE_URLS__
DRY_RUN=__DRY_RUN__
FORCE_STATIC_RESTAGE=__FORCE_STATIC_RESTAGE__
DSV_MIGRATION_APPROVED=__DSV_MIGRATION_APPROVED__
DSV_MIGRATION_MANIFEST_SHA256=__DSV_MIGRATION_MANIFEST_SHA256__
DSV_RESTORE_REHEARSAL_SHA256=__DSV_RESTORE_REHEARSAL_SHA256__
DSV_PRODUCTION_BASELINE_APPROVED=__DSV_PRODUCTION_BASELINE_APPROVED__
DSV_PRODUCTION_BASELINE_MANIFEST_SHA256=__DSV_PRODUCTION_BASELINE_MANIFEST_SHA256__
FIREBASE_CREDENTIALS_PARAM=__FIREBASE_CREDENTIALS_PARAM__
UVIS_ENV_PARAM=__UVIS_ENV_PARAM__
COMPOSE_FILE_B64=__COMPOSE_FILE_B64__
VROOM_CONFIG_B64=__VROOM_CONFIG_B64__
VROOM_KOREA_CONFIG_B64=__VROOM_KOREA_CONFIG_B64__
DOCKER_CLEANUP_SCRIPT_B64=__DOCKER_CLEANUP_SCRIPT_B64__
RETENTION_RUNNER_B64=__RETENTION_RUNNER_B64__
RETENTION_INSTALLER_B64=__RETENTION_INSTALLER_B64__
RETENTION_SERVICE_B64=__RETENTION_SERVICE_B64__
RETENTION_TIMER_B64=__RETENTION_TIMER_B64__
GHCR_USERNAME_PARAM="${ROUTE_OPS_GHCR_USERNAME_PARAM:-/clever/deploy/github/username}"
GHCR_TOKEN_PARAM="${ROUTE_OPS_GHCR_TOKEN_PARAM:-/clever/deploy/github/read-token}"
cd "$APP_DIR"
mkdir -p .deploy
lock_dir=.deploy/route-ops-simple-deploy.lock.d
if ! mkdir "$lock_dir" 2>/dev/null; then echo 'another simple deploy is running' >&2; exit 65; fi
trap 'rmdir "$lock_dir" 2>/dev/null || true' EXIT
printf 'simple deploy preflight: commit=%s channel=%s runtime=%s migration=%s runMigrations=%s static=%s volume=%s dryRun=%s forceStaticRestage=%s\n' "$COMMIT_SHA" "$CHANNEL_TAG" "$DELIVERY_API_IMAGE" "$DELIVERY_API_MIGRATION_IMAGE" "$RUN_MIGRATIONS" "$ROUTE_OPS_WEB_STATIC_IMAGE" "$ROUTE_OPS_WEB_STATIC_VOLUME" "$DRY_RUN" "$FORCE_STATIC_RESTAGE"
command -v docker >/dev/null
command -v aws >/dev/null
command -v python3 >/dev/null
command -v base64 >/dev/null
[ -f apps/delivery-api/.env ] || { echo 'missing required runtime env: apps/delivery-api/.env' >&2; exit 65; }
mkdir -p "$(dirname "$COMPOSE_FILE")" "$(dirname "$VROOM_CONFIG")" "$(dirname "$VROOM_KOREA_CONFIG")"
mkdir -p scripts infra/systemd
printf '%s' "$COMPOSE_FILE_B64" | base64 -d > "$COMPOSE_FILE"
printf '%s' "$VROOM_CONFIG_B64" | base64 -d > "$VROOM_CONFIG"
printf '%s' "$VROOM_KOREA_CONFIG_B64" | base64 -d > "$VROOM_KOREA_CONFIG"
printf '%s' "$DOCKER_CLEANUP_SCRIPT_B64" | base64 -d > .deploy/route-ops-docker-cleanup.sh
chmod 750 .deploy/route-ops-docker-cleanup.sh
mkdir -p .deploy/retention-rollback .deploy/candidate-retention
rm -f .deploy/retention-rollback/runner.present .deploy/retention-rollback/service.present .deploy/retention-rollback/timer.present .deploy/retention-rollback/timer.enabled
if [ -f scripts/run-driver-event-attempt-retention.sh ]; then
  cp scripts/run-driver-event-attempt-retention.sh .deploy/retention-rollback/run-driver-event-attempt-retention.sh
  touch .deploy/retention-rollback/runner.present
fi
if [ -f /etc/systemd/system/clever-driver-event-attempt-retention.service ]; then
  cp /etc/systemd/system/clever-driver-event-attempt-retention.service .deploy/retention-rollback/clever-driver-event-attempt-retention.service
  touch .deploy/retention-rollback/service.present
fi
if [ -f /etc/systemd/system/clever-driver-event-attempt-retention.timer ]; then
  cp /etc/systemd/system/clever-driver-event-attempt-retention.timer .deploy/retention-rollback/clever-driver-event-attempt-retention.timer
  touch .deploy/retention-rollback/timer.present
fi
if systemctl is-enabled clever-driver-event-attempt-retention.timer >/dev/null 2>&1; then
  touch .deploy/retention-rollback/timer.enabled
fi
printf '%s' "$RETENTION_RUNNER_B64" | base64 -d > .deploy/candidate-retention/run-driver-event-attempt-retention.sh
printf '%s' "$RETENTION_INSTALLER_B64" | base64 -d > .deploy/install-driver-event-attempt-retention.sh
printf '%s' "$RETENTION_SERVICE_B64" | base64 -d > .deploy/candidate-retention/clever-driver-event-attempt-retention.service
printf '%s' "$RETENTION_TIMER_B64" | base64 -d > .deploy/candidate-retention/clever-driver-event-attempt-retention.timer
chmod 0750 .deploy/candidate-retention/run-driver-event-attempt-retention.sh .deploy/install-driver-event-attempt-retention.sh
cat > .deploy/simple-candidate-image.env <<EOF_ENV
IMAGE_TAG=$CHANNEL_TAG
COMMIT_SHA=$COMMIT_SHA
API_RUNTIME_REVISION=$COMMIT_SHA
DELIVERY_API_IMAGE=$DELIVERY_API_IMAGE
DELIVERY_API_MIGRATION_IMAGE=$DELIVERY_API_MIGRATION_IMAGE
ROUTE_OPS_WEB_STATIC_IMAGE=$ROUTE_OPS_WEB_STATIC_IMAGE
ROUTE_OPS_WEB_STATIC_VOLUME=$ROUTE_OPS_WEB_STATIC_VOLUME
VROOM_IMAGE=$VROOM_IMAGE
PRISMA_SCHEMA_SHA=$PRISMA_SCHEMA_SHA
DSV_MIGRATION_APPROVED=$DSV_MIGRATION_APPROVED
DSV_MIGRATION_MANIFEST_SHA256=$DSV_MIGRATION_MANIFEST_SHA256
DSV_RESTORE_REHEARSAL_SHA256=$DSV_RESTORE_REHEARSAL_SHA256
DSV_PRODUCTION_BASELINE_APPROVED=$DSV_PRODUCTION_BASELINE_APPROVED
DSV_PRODUCTION_BASELINE_MANIFEST_SHA256=$DSV_PRODUCTION_BASELINE_MANIFEST_SHA256
DRIVER_PROOF_MEDIA_READY_FILTER_COMPATIBLE=$([ -n "$PROOF_READY_FILTER_CONTRACT_SHA" ] && echo true || echo false)
DRIVER_PROOF_MEDIA_READY_FILTER_CONTRACT_SHA=$PROOF_READY_FILTER_CONTRACT_SHA
ROUTE_COMPLETION_INVARIANT_CAPABILITY_VERSION=1
EOF_ENV
HAD_CURRENT_IMAGE_ENV=0
if [ -f .deploy/current-image.env ]; then
  HAD_CURRENT_IMAGE_ENV=1
  cp .deploy/current-image.env .deploy/simple-rollback-image.env
else
  cp .deploy/simple-candidate-image.env .deploy/simple-rollback-image.env
fi
if [ "$HAD_CURRENT_IMAGE_ENV" = "1" ]; then
  CURRENT_ROUTE_OPS_WEB_STATIC_IMAGE="$(awk -F= '$1 == "ROUTE_OPS_WEB_STATIC_IMAGE" {print substr($0, index($0, "=") + 1)}' .deploy/simple-rollback-image.env | tail -n 1)"
else
  CURRENT_ROUTE_OPS_WEB_STATIC_IMAGE=''
fi
proof_reservations_enabled="$(awk -F= '$1 == "DRIVER_PROOF_MEDIA_RESERVATIONS_ENABLED" {print tolower(substr($0, index($0, "=") + 1))}' apps/delivery-api/.env | tail -n 1)"
rollback_ready_filter_compatible="$(awk -F= '$1 == "DRIVER_PROOF_MEDIA_READY_FILTER_COMPATIBLE" {print tolower(substr($0, index($0, "=") + 1))}' .deploy/simple-rollback-image.env | tail -n 1)"
if [ "$proof_reservations_enabled" = "true" ] && [ "$rollback_ready_filter_compatible" != "true" ]; then
  echo 'proof media reservation rollout blocked: rollback image does not advertise READY-only reads' >&2
  exit 1
fi
completion_mode="$(awk -F= '$1 == "DRIVER_ROUTE_COMPLETION_INVARIANT_MODE" {print toupper(substr($0, index($0, "=") + 1))}' apps/delivery-api/.env | tail -n 1)"
completion_mode="${completion_mode:-OBSERVE}"
rollback_completion_capability="$(awk -F= '$1 == "ROUTE_COMPLETION_INVARIANT_CAPABILITY_VERSION" {print substr($0, index($0, "=") + 1)}' .deploy/simple-rollback-image.env | tail -n 1)"
rollback_delivery_image="$(awk -F= '$1 == "DELIVERY_API_IMAGE" {print substr($0, index($0, "=") + 1)}' .deploy/simple-rollback-image.env | tail -n 1)"
if [ "$completion_mode" != "OBSERVE" ]; then
  [ "$rollback_completion_capability" = "1" ] || { echo 'route completion rollout blocked: rollback image does not advertise invariant capability v1' >&2; exit 1; }
  [ "$(docker image inspect "$rollback_delivery_image" --format '{{ index .Config.Labels "org.clever-route.route-completion-invariant-capability" }}')" = "1" ] \
    || { echo 'route completion rollout blocked: rollback image capability label is missing' >&2; exit 1; }
fi
is_digest_ref() {
  case "$1" in
    *@sha256:*) return 0 ;;
    *) return 1 ;;
  esac
}
should_stage_static() {
  if [ "$FORCE_STATIC_RESTAGE" = "1" ]; then
    echo 'force'
    return 0
  fi
  if [ -z "$CURRENT_ROUTE_OPS_WEB_STATIC_IMAGE" ]; then
    echo 'missing-current'
    return 0
  fi
  if ! is_digest_ref "$CURRENT_ROUTE_OPS_WEB_STATIC_IMAGE" || ! is_digest_ref "$ROUTE_OPS_WEB_STATIC_IMAGE"; then
    echo 'non-digest-ref'
    return 0
  fi
  if [ "$CURRENT_ROUTE_OPS_WEB_STATIC_IMAGE" != "$ROUTE_OPS_WEB_STATIC_IMAGE" ]; then
    echo 'digest-changed'
    return 0
  fi
  echo 'unchanged'
  return 0
}
docker compose -p "$COMPOSE_PROJECT" --env-file .deploy/simple-candidate-image.env -f "$COMPOSE_FILE" --profile osrm --profile vroom --profile korea config --quiet
smoke_health() {
  for url in $SMOKE_URLS; do
    if curl -fsS "$url"; then
      printf 'simple deploy health ok: %s\n' "$url"
      return 0
    fi
  done
  return 1
}
if [ "$DRY_RUN" = "1" ]; then
  .deploy/route-ops-docker-cleanup.sh --dry-run --enforce
  printf 'simple deploy dry-run complete; no host image pull, migration, or restart mutation performed.\n'
  exit 0
fi
FIREBASE_CREDENTIALS_FILE=/srv/clever-route-server/secrets/firebase-fcm.json
mkdir -p "$(dirname "$FIREBASE_CREDENTIALS_FILE")"
firebase_credentials="$(aws ssm get-parameter --name "$FIREBASE_CREDENTIALS_PARAM" --with-decryption --query 'Parameter.Value' --output text)"
printf '%s' "$firebase_credentials" > "$FIREBASE_CREDENTIALS_FILE"
firebase_credentials=''
python3 -c 'import json,sys; value=json.load(open(sys.argv[1])); assert value.get("project_id") == "clever-routes-prod"; assert value.get("client_email")' "$FIREBASE_CREDENTIALS_FILE"
chown 100:101 "$FIREBASE_CREDENTIALS_FILE"
chmod 400 "$FIREBASE_CREDENTIALS_FILE"
rollback_delivery_api() {
  echo 'simple deploy health failed; rolling clever-route-api back to previous image env' >&2
  docker compose -p "$COMPOSE_PROJECT" --env-file .deploy/simple-rollback-image.env -f "$COMPOSE_FILE" --profile osrm --profile vroom --profile korea pull clever-route-api route-ops-web-static vroom vroom-korea
  docker compose -p "$COMPOSE_PROJECT" --env-file .deploy/simple-rollback-image.env -f "$COMPOSE_FILE" up --no-build --force-recreate route-ops-web-static
  docker compose -p "$COMPOSE_PROJECT" --env-file .deploy/simple-rollback-image.env -f "$COMPOSE_FILE" up -d --no-build --no-deps --force-recreate --remove-orphans clever-route-api
  for rollback_attempt in $(seq 1 30); do
    if smoke_health; then
      echo 'simple deploy rollback completed; previous clever-route-api is healthy' >&2
      return 0
    fi
    sleep 2
  done
  echo 'simple deploy rollback failed health check; manual intervention required' >&2
  return 1
}
rollback_retention_runtime() {
  if [ -f .deploy/retention-rollback/runner.present ]; then
    cp .deploy/retention-rollback/run-driver-event-attempt-retention.sh scripts/run-driver-event-attempt-retention.sh
  else
    rm -f scripts/run-driver-event-attempt-retention.sh
  fi
  if [ -f .deploy/retention-rollback/service.present ]; then
    cp .deploy/retention-rollback/clever-driver-event-attempt-retention.service /etc/systemd/system/clever-driver-event-attempt-retention.service
  else
    rm -f /etc/systemd/system/clever-driver-event-attempt-retention.service
  fi
  if [ -f .deploy/retention-rollback/timer.present ]; then
    cp .deploy/retention-rollback/clever-driver-event-attempt-retention.timer /etc/systemd/system/clever-driver-event-attempt-retention.timer
  else
    rm -f /etc/systemd/system/clever-driver-event-attempt-retention.timer
  fi
  systemctl daemon-reload
  if [ -f .deploy/retention-rollback/timer.enabled ]; then
    systemctl enable --now clever-driver-event-attempt-retention.timer
  else
    systemctl disable --now clever-driver-event-attempt-retention.timer >/dev/null 2>&1 || true
  fi
}
export AWS_REGION UVIS_ENV_PARAM
python3 - <<'ENVUP'
import os
from pathlib import Path
path = Path('apps/delivery-api/.env')
updates = {
    'VROOM_BASE_URL': 'http://vroom:3000',
    'VROOM_ONTARIO_BASE_URL': 'http://vroom:3000',
    'VROOM_KOREA_BASE_URL': 'http://vroom-korea:3000',
    'VROOM_TIMEOUT_MS': '180000',
    'ROUTE_OPTIMIZATION_JOB_TIMEOUT_BUDGET_MS': '180000',
    'OSRM_BASE_URL': 'http://osrm-ontario:5000',
    'OSRM_ONTARIO_BASE_URL': 'http://osrm-ontario:5000',
    'OSRM_KOREA_BASE_URL': 'http://osrm-korea:5000',
    'OSRM_DEFAULT_COVERAGE': 'korea',
    'OSRM_TIMEOUT_MS': '10000',
    'FIREBASE_PROJECT_ID': 'clever-routes-prod',
    'GOOGLE_APPLICATION_CREDENTIALS': '/run/secrets/firebase-fcm.json',
    'UVIS_ENABLED': 'false',
}
uvis_allowed_keys = {
    'UVIS_ENABLED',
    'UVIS_APP_ID',
    'UVIS_SHOP_DOMAIN',
    'UVIS_ACCESS_KEY_URL',
    'UVIS_TELEMETRY_URL',
    'UVIS_ALLOWED_OUTBOUND_URLS',
    'UVIS_COMPANY_SERIAL_KEY',
    'UVIS_LOCATION_GUBUN',
    'UVIS_TEMPERATURE_GUBUN',
    'UVIS_TIMEOUT_MS',
    'UVIS_LOCATION_POLL_INTERVAL_MS',
    'UVIS_LOCATION_DORMANT_GRACE_PERIOD_MS',
    'UVIS_LOCATION_DORMANT_HEARTBEAT_INTERVAL_MS',
    'UVIS_TEMPERATURE_POLL_INTERVAL_MS',
}
uvis_param = os.environ.get('UVIS_ENV_PARAM', '')
if uvis_param:
    import subprocess

    uvis_payload = subprocess.check_output(
        [
            'aws',
            'ssm',
            'get-parameter',
            '--name',
            uvis_param,
            '--with-decryption',
            '--query',
            'Parameter.Value',
            '--output',
            'text',
            '--region',
            os.environ['AWS_REGION'],
        ],
        text=True,
    )
    for raw_line in uvis_payload.splitlines():
        line = raw_line.strip()
        if not line or line.startswith('#'):
            continue
        if '=' not in line:
            raise SystemExit('UVIS SSM parameter contains a non-dotenv line')
        key, value = line.split('=', 1)
        key = key.strip()
        if key not in uvis_allowed_keys:
            raise SystemExit(f'UVIS SSM parameter contains unsupported key: {key}')
        updates[key] = value.strip()
text = path.read_text().splitlines()
out, seen = [], set()
for line in text:
    if not line or line.lstrip().startswith('#') or '=' not in line:
        out.append(line)
        continue
    key = line.split('=', 1)[0]
    if key in updates:
        out.append(f'{key}={updates[key]}')
        seen.add(key)
    else:
        out.append(line)
for key, value in updates.items():
    if key not in seen:
        out.append(f'{key}={value}')
path.write_text('\n'.join(out) + '\n')
path.chmod(0o600)
ENVUP
mkdir -p /srv/clever-route-server/data/driver-proof-media
chown -R 100:101 /srv/clever-route-server/data/driver-proof-media
chmod 750 /srv/clever-route-server/data/driver-proof-media
mkdir -p /srv/clever-route-server/data/customer-email-assets
chown -R 100:101 /srv/clever-route-server/data/customer-email-assets
chmod 750 /srv/clever-route-server/data/customer-email-assets
.deploy/route-ops-docker-cleanup.sh --enforce
username="$(aws ssm get-parameter --name "$GHCR_USERNAME_PARAM" --query 'Parameter.Value' --output text)"
token="$(aws ssm get-parameter --name "$GHCR_TOKEN_PARAM" --with-decryption --query 'Parameter.Value' --output text)"
printf '%s' "$token" | docker login ghcr.io -u "$username" --password-stdin >/dev/null
token=''
static_stage_reason="$(should_stage_static)"
docker compose -p "$COMPOSE_PROJECT" --env-file .deploy/simple-candidate-image.env -f "$COMPOSE_FILE" --profile osrm --profile vroom --profile korea pull clever-route-api vroom vroom-korea
runtime_revision="$(docker image inspect "$DELIVERY_API_IMAGE" --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')"
[[ "$runtime_revision" =~ ^[0-9a-f]{40}$ ]] || { echo 'candidate delivery API image revision is invalid' >&2; exit 1; }
if [ "$RUN_MIGRATIONS" = "1" ]; then
  docker compose -p "$COMPOSE_PROJECT" --env-file .deploy/simple-candidate-image.env -f "$COMPOSE_FILE" pull clever-route-api-migrate
  migration_revision="$(docker image inspect "$DELIVERY_API_MIGRATION_IMAGE" --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')"
  [ "$migration_revision" = "$runtime_revision" ] || { echo 'candidate migration image revision does not match runtime' >&2; exit 1; }
  [ "$(docker image inspect "$DELIVERY_API_MIGRATION_IMAGE" --format '{{ index .Config.Labels "org.clever-route.image-role" }}')" = "migration" ] \
    || { echo 'candidate migration image role is invalid' >&2; exit 1; }
fi
sed -i.bak "s/^API_RUNTIME_REVISION=.*/API_RUNTIME_REVISION=$runtime_revision/" .deploy/simple-candidate-image.env
rm -f .deploy/simple-candidate-image.env.bak
[ "$(docker image inspect "$DELIVERY_API_IMAGE" --format '{{ index .Config.Labels "org.clever-route.route-completion-invariant-capability" }}')" = "1" ] \
  || { echo 'candidate delivery API does not advertise route completion invariant capability v1' >&2; exit 1; }
if [ "$static_stage_reason" != "unchanged" ]; then
  docker compose -p "$COMPOSE_PROJECT" --env-file .deploy/simple-candidate-image.env -f "$COMPOSE_FILE" --profile osrm --profile vroom --profile korea pull route-ops-web-static
fi
docker compose -p "$COMPOSE_PROJECT" --env-file .deploy/simple-candidate-image.env -f "$COMPOSE_FILE" run --rm --no-deps clever-route-api node dist/scripts/audit-custom-route-order-ownership.js
if [ "$RUN_MIGRATIONS" = "1" ]; then
  docker compose -p "$COMPOSE_PROJECT" --env-file .deploy/simple-candidate-image.env -f "$COMPOSE_FILE" run --rm clever-route-api-migrate
else
  echo 'simple deploy migrations skipped: Prisma inputs unchanged and migration lane not requested'
fi
if [ "$static_stage_reason" = "unchanged" ]; then
  printf 'simple deploy static stage skipped: candidate static digest matches current (%s)\n' "$ROUTE_OPS_WEB_STATIC_IMAGE"
else
  printf 'simple deploy static stage required: reason=%s current=%s candidate=%s\n' "$static_stage_reason" "$CURRENT_ROUTE_OPS_WEB_STATIC_IMAGE" "$ROUTE_OPS_WEB_STATIC_IMAGE"
  docker compose -p "$COMPOSE_PROJECT" --env-file .deploy/simple-candidate-image.env -f "$COMPOSE_FILE" up --no-build --force-recreate route-ops-web-static
fi
docker compose -p "$COMPOSE_PROJECT" --env-file .deploy/simple-candidate-image.env -f "$COMPOSE_FILE" up -d --no-build --no-deps --force-recreate --remove-orphans clever-route-api
for attempt in $(seq 1 30); do
  if smoke_health; then break; fi
  if [ "$attempt" = "30" ]; then rollback_delivery_api || true; exit 1; fi
  sleep 2
done
cp .deploy/current-image.env ".deploy/current-image.env.before-simple-$(date -u +%Y%m%dT%H%M%SZ)" 2>/dev/null || true
cp .deploy/simple-candidate-image.env .deploy/current-image.env
if ! CLEVER_ROUTE_RETENTION_RUNNER_SOURCE="$APP_DIR/.deploy/candidate-retention/run-driver-event-attempt-retention.sh" \
  CLEVER_ROUTE_RETENTION_UNIT_SOURCE_DIR="$APP_DIR/.deploy/candidate-retention" \
  .deploy/install-driver-event-attempt-retention.sh; then
  echo 'retention installer failed; restoring previous image env and runtime' >&2
  if [ "$HAD_CURRENT_IMAGE_ENV" = "1" ]; then
    cp .deploy/simple-rollback-image.env .deploy/current-image.env
  else
    rm -f .deploy/current-image.env
  fi
  rollback_retention_runtime || true
  rollback_delivery_api || true
  exit 1
fi
.deploy/route-ops-docker-cleanup.sh --enforce
printf '{"ts":"%s","commitSha":"%s","runtimeCommitSha":"%s","channelTag":"%s","deliveryApiImage":"%s","deliveryApiMigrationImage":"%s","runMigrations":%s,"routeOpsWebStaticImage":"%s","routeOpsWebStaticVolume":"%s","vroomImage":"%s","prismaSchemaSha":"%s","staticStage":"%s","lane":"simple-ssm"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$COMMIT_SHA" "$runtime_revision" "$CHANNEL_TAG" "$DELIVERY_API_IMAGE" "$DELIVERY_API_MIGRATION_IMAGE" "$RUN_MIGRATIONS" "$ROUTE_OPS_WEB_STATIC_IMAGE" "$ROUTE_OPS_WEB_STATIC_VOLUME" "$VROOM_IMAGE" "$PRISMA_SCHEMA_SHA" "$static_stage_reason" >> .deploy/deploy-history.jsonl
printf 'simple deploy completed: commit=%s channel=%s\n' "$COMMIT_SHA" "$CHANNEL_TAG"
HOST_SCRIPT
  python3 - "$path" "$inner_path" <<'PY'
import json
import os
import shlex
import sys

path, inner_path = sys.argv[1], sys.argv[2]
with open(inner_path, 'r', encoding='utf-8') as handle:
    script = handle.read()
replacements = {
    '__AWS_REGION__': shlex.quote(os.environ['AWS_REGION']),
    '__APP_DIR__': shlex.quote(os.environ['APP_DIR']),
    '__COMPOSE_FILE__': shlex.quote(os.environ['COMPOSE_FILE']),
    '__COMPOSE_PROJECT__': shlex.quote(os.environ['COMPOSE_PROJECT']),
    '__VROOM_CONFIG__': shlex.quote(os.environ['VROOM_CONFIG']),
    '__VROOM_KOREA_CONFIG__': shlex.quote(os.environ['VROOM_KOREA_CONFIG']),
    '__COMMIT_SHA__': shlex.quote(os.environ['COMMIT_SHA']),
    '__CHANNEL_TAG__': shlex.quote(os.environ['CHANNEL_TAG']),
    '__PRISMA_SCHEMA_SHA__': shlex.quote(os.environ['PRISMA_SCHEMA_SHA']),
    '__PROOF_READY_FILTER_CONTRACT_SHA__': shlex.quote(os.environ['PROOF_READY_FILTER_CONTRACT_SHA']),
    '__RUNTIME_IMAGE__': shlex.quote(os.environ['RUNTIME_IMAGE']),
    '__MIGRATION_IMAGE__': shlex.quote(os.environ['MIGRATION_IMAGE']),
    '__RUN_MIGRATIONS__': shlex.quote(os.environ['RUN_MIGRATIONS']),
    '__STATIC_IMAGE__': shlex.quote(os.environ['STATIC_IMAGE']),
    '__STATIC_VOLUME__': shlex.quote(os.environ['STATIC_VOLUME']),
    '__VROOM_IMAGE__': shlex.quote(os.environ['VROOM_IMAGE']),
    '__BASE_URL__': shlex.quote(os.environ['BASE_URL']),
    '__SMOKE_URLS__': shlex.quote(os.environ['SMOKE_URLS']),
    '__DRY_RUN__': shlex.quote(os.environ['DRY_RUN']),
    '__FORCE_STATIC_RESTAGE__': shlex.quote(os.environ['FORCE_STATIC_RESTAGE']),
    '__DSV_MIGRATION_APPROVED__': shlex.quote(os.environ['DSV_MIGRATION_APPROVED']),
    '__DSV_MIGRATION_MANIFEST_SHA256__': shlex.quote(os.environ['DSV_MIGRATION_MANIFEST_SHA256']),
    '__DSV_RESTORE_REHEARSAL_SHA256__': shlex.quote(os.environ['DSV_RESTORE_REHEARSAL_SHA256']),
    '__DSV_PRODUCTION_BASELINE_APPROVED__': shlex.quote(os.environ['DSV_PRODUCTION_BASELINE_APPROVED']),
    '__DSV_PRODUCTION_BASELINE_MANIFEST_SHA256__': shlex.quote(os.environ['DSV_PRODUCTION_BASELINE_MANIFEST_SHA256']),
    '__FIREBASE_CREDENTIALS_PARAM__': shlex.quote(os.environ['FIREBASE_CREDENTIALS_PARAM']),
    '__UVIS_ENV_PARAM__': shlex.quote(os.environ['UVIS_ENV_PARAM']),
    '__COMPOSE_FILE_B64__': shlex.quote(os.environ['COMPOSE_FILE_B64']),
    '__VROOM_CONFIG_B64__': shlex.quote(os.environ['VROOM_CONFIG_B64']),
    '__VROOM_KOREA_CONFIG_B64__': shlex.quote(os.environ['VROOM_KOREA_CONFIG_B64']),
    '__DOCKER_CLEANUP_SCRIPT_B64__': shlex.quote(os.environ['DOCKER_CLEANUP_SCRIPT_B64']),
    '__RETENTION_RUNNER_B64__': shlex.quote(os.environ['RETENTION_RUNNER_B64']),
    '__RETENTION_INSTALLER_B64__': shlex.quote(os.environ['RETENTION_INSTALLER_B64']),
    '__RETENTION_SERVICE_B64__': shlex.quote(os.environ['RETENTION_SERVICE_B64']),
    '__RETENTION_TIMER_B64__': shlex.quote(os.environ['RETENTION_TIMER_B64']),
}
for key, value in replacements.items():
    script = script.replace(key, value)
with open(path, 'w', encoding='utf-8') as handle:
    json.dump({'commands': ['bash -lc ' + shlex.quote(script)]}, handle)
PY
  rm -f "$inner_path"
}

if [ "$BUILD_AND_PUSH" = "1" ]; then
  build_and_push
fi

COMPOSE_FILE_B64="$(base64 < "$COMPOSE_FILE" | tr -d '\n')"
VROOM_CONFIG_B64="$(base64 < "$VROOM_CONFIG" | tr -d '\n')"
VROOM_KOREA_CONFIG_B64="$(base64 < "$VROOM_KOREA_CONFIG" | tr -d '\n')"
DOCKER_CLEANUP_SCRIPT_B64="$(base64 < scripts/route-ops-docker-cleanup.sh | tr -d '\n')"
RETENTION_RUNNER_B64="$(base64 < scripts/run-driver-event-attempt-retention.sh | tr -d '\n')"
RETENTION_INSTALLER_B64="$(base64 < scripts/install-driver-event-attempt-retention.sh | tr -d '\n')"
RETENTION_SERVICE_B64="$(base64 < infra/systemd/clever-driver-event-attempt-retention.service | tr -d '\n')"
RETENTION_TIMER_B64="$(base64 < infra/systemd/clever-driver-event-attempt-retention.timer | tr -d '\n')"
test -f apps/delivery-api/tests/driver-proof-media-read-inventory.test.ts \
  || fail 'missing proof media READY-filter inventory contract'
test -f apps/delivery-api/tests/dsv-v1-read-query.service.test.ts \
  || fail 'missing DSV READY-filter contract'
PROOF_READY_FILTER_CONTRACT_SHA="$(shasum -a 256 apps/delivery-api/tests/driver-proof-media-read-inventory.test.ts apps/delivery-api/tests/dsv-v1-read-query.service.test.ts | shasum -a 256 | awk '{print $1}')"
export AWS_REGION APP_DIR COMPOSE_FILE VROOM_CONFIG VROOM_KOREA_CONFIG COMPOSE_PROJECT COMMIT_SHA CHANNEL_TAG PRISMA_SCHEMA_SHA PROOF_READY_FILTER_CONTRACT_SHA RUNTIME_IMAGE MIGRATION_IMAGE RUN_MIGRATIONS STATIC_IMAGE STATIC_VOLUME VROOM_IMAGE BASE_URL SMOKE_URLS DRY_RUN FORCE_STATIC_RESTAGE DSV_MIGRATION_APPROVED DSV_MIGRATION_MANIFEST_SHA256 DSV_RESTORE_REHEARSAL_SHA256 DSV_PRODUCTION_BASELINE_APPROVED DSV_PRODUCTION_BASELINE_MANIFEST_SHA256 FIREBASE_CREDENTIALS_PARAM UVIS_ENV_PARAM COMPOSE_FILE_B64 VROOM_CONFIG_B64 VROOM_KOREA_CONFIG_B64 DOCKER_CLEANUP_SCRIPT_B64 RETENTION_RUNNER_B64 RETENTION_INSTALLER_B64 RETENTION_SERVICE_B64 RETENTION_TIMER_B64
parameters_path="$(mktemp /tmp/route-ops-simple-ssm.XXXXXX)"
write_parameters "$parameters_path"
if [ "$SEND_COMMAND" = "0" ]; then
  echo "$parameters_path"
  exit 0
fi
INSTANCE_ID="$(resolve_instance)"
COMMAND_ID="$(aws ssm send-command \
  --region "$AWS_REGION" \
  --instance-ids "$INSTANCE_ID" \
  --document-name AWS-RunShellScript \
  --comment "Route Ops simple SSM deploy ${COMMIT_SHA} channel ${CHANNEL_TAG}" \
  --timeout-seconds 3600 \
  --parameters "file://${parameters_path}" \
  --query Command.CommandId \
  --output text)"
printf 'SSM_SIMPLE_COMMAND_ID=%s\nSSM_SIMPLE_INSTANCE_ID=%s\n' "$COMMAND_ID" "$INSTANCE_ID"
wait_timeout_seconds="${SSM_WAIT_TIMEOUT_SECONDS:-1800}"
wait_started_at="$SECONDS"
wait_status=1
while (( SECONDS - wait_started_at < wait_timeout_seconds )); do
  command_status="$(aws ssm get-command-invocation \
    --region "$AWS_REGION" \
    --command-id "$COMMAND_ID" \
    --instance-id "$INSTANCE_ID" \
    --query Status \
    --output text 2>/dev/null || true)"
  case "$command_status" in
    Success)
      wait_status=0
      break
      ;;
    Pending|InProgress|Delayed|Cancelling|"")
      sleep 5
      ;;
    *)
      break
      ;;
  esac
done
aws ssm get-command-invocation \
  --region "$AWS_REGION" \
  --command-id "$COMMAND_ID" \
  --instance-id "$INSTANCE_ID" \
  --query '{Status:Status,ResponseCode:ResponseCode,Stdout:StandardOutputContent,Stderr:StandardErrorContent}' \
  --output json
exit "$wait_status"
