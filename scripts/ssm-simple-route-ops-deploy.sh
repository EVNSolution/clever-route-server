#!/usr/bin/env bash
set -euo pipefail

AWS_REGION="${AWS_REGION:-ap-northeast-2}"
APP_DIR="${APP_DIR:-/srv/clever-route-server}"
COMPOSE_FILE="${COMPOSE_FILE:-infra/compose/docker-compose.prod.yml}"
CADDYFILE="${CADDYFILE:-infra/caddy/Caddyfile}"
COMPOSE_PROJECT="${ROUTE_OPS_COMPOSE_PROJECT_NAME:-clever-route}"
SERVICE_TAG_KEY="${ROUTE_OPS_SSM_TAG_KEY:-Service}"
SERVICE_TAG_VALUE="${ROUTE_OPS_SSM_TAG_VALUE:-clever-delivery-server}"
CHANNEL_TAG="${ROUTE_OPS_SIMPLE_CHANNEL_TAG:-prod}"
COMMIT_SHA="$(git rev-parse --short=40 HEAD)"
PRISMA_SCHEMA_SHA="$(shasum -a 256 apps/delivery-api/prisma/schema.prisma | awk '{print $1}')"
RUNTIME_IMAGE_REPO="${ROUTE_OPS_RUNTIME_IMAGE_REPO:-ghcr.io/evnsolution/clever-route-server-delivery-api}"
STATIC_IMAGE_REPO="${ROUTE_OPS_WEB_STATIC_IMAGE_REPO:-ghcr.io/evnsolution/clever-route-server-route-ops-web-static}"
RUNTIME_IMAGE="${ROUTE_OPS_RUNTIME_IMAGE:-${RUNTIME_IMAGE_REPO}:${CHANNEL_TAG}}"
STATIC_IMAGE="${ROUTE_OPS_WEB_STATIC_IMAGE:-${STATIC_IMAGE_REPO}:${CHANNEL_TAG}}"
STATIC_VOLUME="${ROUTE_OPS_WEB_STATIC_VOLUME:-clever-route-route-ops-web-static-${CHANNEL_TAG}}"
VROOM_IMAGE="${VROOM_IMAGE:-ghcr.io/vroom-project/vroom-docker@sha256:247d5683d6745c755d718a156d16b16aac80baccc276a003a68b986c13883b08}"
BASE_URL="${ROUTE_OPS_SMOKE_BASE_URL:-https://clever-route.cleversystem.ai}"
DRY_RUN=0
BUILD_AND_PUSH=0
SEND_COMMAND=1
FORCE_STATIC_RESTAGE="${ROUTE_OPS_FORCE_STATIC_RESTAGE:-0}"

usage() {
  cat <<USAGE
Usage: $0 [--dry-run] [--publish] [--no-send]

Simple Route Ops SSM deploy lane: no S3 deploy-control bundle, no EC2 build,
no separate migrate image, and no prod-prev image retagging. GitHub Actions
should publish digest-addressable images first, then pass ROUTE_OPS_RUNTIME_IMAGE
and ROUTE_OPS_WEB_STATIC_IMAGE as repo@sha256 refs. The SSM command only pulls,
runs migration, stages static assets, recreates delivery-api, and healthchecks.

Env:
  ROUTE_OPS_SIMPLE_CHANNEL_TAG   default: prod
  ROUTE_OPS_RUNTIME_IMAGE        optional full runtime image ref, preferably repo@sha256
  ROUTE_OPS_WEB_STATIC_IMAGE     optional full static image ref, preferably repo@sha256
  ROUTE_OPS_FORCE_STATIC_RESTAGE  set to 1 to stage static even when digest matches current
  AWS_REGION                     default: ap-northeast-2
  ROUTE_OPS_SSM_TAG_KEY          default: Service
  ROUTE_OPS_SSM_TAG_VALUE        default: clever-delivery-server
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
    --cache-from "type=registry,ref=${RUNTIME_IMAGE_REPO}:buildcache" \
    --cache-to "type=registry,ref=${RUNTIME_IMAGE_REPO}:buildcache,mode=max" \
    -t "${RUNTIME_IMAGE_REPO}:${CHANNEL_TAG}" .
  for image in "${STATIC_IMAGE_REPO}:${CHANNEL_TAG}" "${RUNTIME_IMAGE_REPO}:${CHANNEL_TAG}"; do
    docker buildx imagetools inspect "$image" --format '{{json .Manifest.Digest}}'
  done
}

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
APP_DIR=__APP_DIR__
COMPOSE_FILE=__COMPOSE_FILE__
CADDYFILE=__CADDYFILE__
COMPOSE_PROJECT=__COMPOSE_PROJECT__
COMMIT_SHA=__COMMIT_SHA__
CHANNEL_TAG=__CHANNEL_TAG__
PRISMA_SCHEMA_SHA=__PRISMA_SCHEMA_SHA__
DELIVERY_API_IMAGE=__RUNTIME_IMAGE__
ROUTE_OPS_WEB_STATIC_IMAGE=__STATIC_IMAGE__
ROUTE_OPS_WEB_STATIC_VOLUME=__STATIC_VOLUME__
VROOM_IMAGE=__VROOM_IMAGE__
BASE_URL=__BASE_URL__
DRY_RUN=__DRY_RUN__
FORCE_STATIC_RESTAGE=__FORCE_STATIC_RESTAGE__
COMPOSE_FILE_B64=__COMPOSE_FILE_B64__
CADDYFILE_B64=__CADDYFILE_B64__
GHCR_USERNAME_PARAM="${ROUTE_OPS_GHCR_USERNAME_PARAM:-/clever/deploy/github/username}"
GHCR_TOKEN_PARAM="${ROUTE_OPS_GHCR_TOKEN_PARAM:-/clever/deploy/github/read-token}"
cd "$APP_DIR"
mkdir -p .deploy
lock_dir=.deploy/route-ops-simple-deploy.lock.d
if ! mkdir "$lock_dir" 2>/dev/null; then echo 'another simple deploy is running' >&2; exit 65; fi
trap 'rmdir "$lock_dir" 2>/dev/null || true' EXIT
printf 'simple deploy preflight: commit=%s channel=%s runtime=%s static=%s volume=%s dryRun=%s forceStaticRestage=%s\n' "$COMMIT_SHA" "$CHANNEL_TAG" "$DELIVERY_API_IMAGE" "$ROUTE_OPS_WEB_STATIC_IMAGE" "$ROUTE_OPS_WEB_STATIC_VOLUME" "$DRY_RUN" "$FORCE_STATIC_RESTAGE"
command -v docker >/dev/null
command -v aws >/dev/null
command -v python3 >/dev/null
command -v base64 >/dev/null
mkdir -p "$(dirname "$COMPOSE_FILE")" "$(dirname "$CADDYFILE")"
printf '%s' "$COMPOSE_FILE_B64" | base64 -d > "$COMPOSE_FILE"
printf '%s' "$CADDYFILE_B64" | base64 -d > "$CADDYFILE"
[ -f infra/env/delivery-api.env ]
cat > .deploy/simple-candidate-image.env <<EOF_ENV
IMAGE_TAG=$CHANNEL_TAG
COMMIT_SHA=$COMMIT_SHA
DELIVERY_API_IMAGE=$DELIVERY_API_IMAGE
ROUTE_OPS_WEB_STATIC_IMAGE=$ROUTE_OPS_WEB_STATIC_IMAGE
ROUTE_OPS_WEB_STATIC_VOLUME=$ROUTE_OPS_WEB_STATIC_VOLUME
VROOM_IMAGE=$VROOM_IMAGE
PRISMA_SCHEMA_SHA=$PRISMA_SCHEMA_SHA
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
docker compose -p "$COMPOSE_PROJECT" --env-file .deploy/simple-candidate-image.env -f "$COMPOSE_FILE" --profile osrm --profile vroom config --quiet
if [ "$DRY_RUN" = "1" ]; then
  printf 'simple deploy dry-run complete; no host image pull, migration, or restart mutation performed.\n'
  exit 0
fi
docker compose -p "$COMPOSE_PROJECT" --env-file .deploy/simple-candidate-image.env -f "$COMPOSE_FILE" exec -T caddy caddy reload --config /etc/caddy/Caddyfile
rollback_delivery_api() {
  echo 'simple deploy health failed; rolling delivery-api back to previous image env' >&2
  docker compose -p "$COMPOSE_PROJECT" --env-file .deploy/simple-rollback-image.env -f "$COMPOSE_FILE" --profile osrm --profile vroom pull delivery-api route-ops-web-static vroom
  docker compose -p "$COMPOSE_PROJECT" --env-file .deploy/simple-rollback-image.env -f "$COMPOSE_FILE" up --no-build --force-recreate route-ops-web-static
  docker compose -p "$COMPOSE_PROJECT" --env-file .deploy/simple-rollback-image.env -f "$COMPOSE_FILE" up -d --no-build --no-deps --force-recreate delivery-api
  for rollback_attempt in $(seq 1 30); do
    if curl -fsS "$BASE_URL/healthz"; then
      echo 'simple deploy rollback completed; previous delivery-api is healthy' >&2
      return 0
    fi
    sleep 2
  done
  echo 'simple deploy rollback failed health check; manual intervention required' >&2
  return 1
}
python3 - <<'ENVUP'
from pathlib import Path
path = Path('infra/env/delivery-api.env')
updates = {
    'VROOM_BASE_URL': 'http://vroom:3000',
    'VROOM_TIMEOUT_MS': '180000',
    'ROUTE_OPTIMIZATION_JOB_TIMEOUT_BUDGET_MS': '180000',
    'OSRM_BASE_URL': 'http://osrm-ontario:5000',
    'OSRM_TIMEOUT_MS': '10000',
}
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
ENVUP
mkdir -p /srv/clever-route-server/data/driver-proof-media
chown -R 100:101 /srv/clever-route-server/data/driver-proof-media
chmod 750 /srv/clever-route-server/data/driver-proof-media
username="$(aws ssm get-parameter --name "$GHCR_USERNAME_PARAM" --query 'Parameter.Value' --output text)"
token="$(aws ssm get-parameter --name "$GHCR_TOKEN_PARAM" --with-decryption --query 'Parameter.Value' --output text)"
printf '%s' "$token" | docker login ghcr.io -u "$username" --password-stdin >/dev/null
token=''
static_stage_reason="$(should_stage_static)"
docker compose -p "$COMPOSE_PROJECT" --env-file .deploy/simple-candidate-image.env -f "$COMPOSE_FILE" --profile osrm --profile vroom pull delivery-api vroom
if [ "$static_stage_reason" != "unchanged" ]; then
  docker compose -p "$COMPOSE_PROJECT" --env-file .deploy/simple-candidate-image.env -f "$COMPOSE_FILE" --profile osrm --profile vroom pull route-ops-web-static
fi
docker compose -p "$COMPOSE_PROJECT" --env-file .deploy/simple-candidate-image.env -f "$COMPOSE_FILE" run --rm delivery-api-migrate
if [ "$static_stage_reason" = "unchanged" ]; then
  printf 'simple deploy static stage skipped: candidate static digest matches current (%s)\n' "$ROUTE_OPS_WEB_STATIC_IMAGE"
else
  printf 'simple deploy static stage required: reason=%s current=%s candidate=%s\n' "$static_stage_reason" "$CURRENT_ROUTE_OPS_WEB_STATIC_IMAGE" "$ROUTE_OPS_WEB_STATIC_IMAGE"
  docker compose -p "$COMPOSE_PROJECT" --env-file .deploy/simple-candidate-image.env -f "$COMPOSE_FILE" up --no-build --force-recreate route-ops-web-static
fi
docker compose -p "$COMPOSE_PROJECT" --env-file .deploy/simple-candidate-image.env -f "$COMPOSE_FILE" up -d --no-build --no-deps --force-recreate delivery-api
for attempt in $(seq 1 30); do
  if curl -fsS "$BASE_URL/healthz"; then break; fi
  if [ "$attempt" = "30" ]; then rollback_delivery_api || true; exit 1; fi
  sleep 2
done
cp .deploy/current-image.env ".deploy/current-image.env.before-simple-$(date -u +%Y%m%dT%H%M%SZ)" 2>/dev/null || true
cp .deploy/simple-candidate-image.env .deploy/current-image.env
printf '{"ts":"%s","commitSha":"%s","channelTag":"%s","deliveryApiImage":"%s","routeOpsWebStaticImage":"%s","routeOpsWebStaticVolume":"%s","vroomImage":"%s","prismaSchemaSha":"%s","staticStage":"%s","lane":"simple-ssm"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$COMMIT_SHA" "$CHANNEL_TAG" "$DELIVERY_API_IMAGE" "$ROUTE_OPS_WEB_STATIC_IMAGE" "$ROUTE_OPS_WEB_STATIC_VOLUME" "$VROOM_IMAGE" "$PRISMA_SCHEMA_SHA" "$static_stage_reason" >> .deploy/deploy-history.jsonl
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
    '__APP_DIR__': shlex.quote(os.environ['APP_DIR']),
    '__COMPOSE_FILE__': shlex.quote(os.environ['COMPOSE_FILE']),
    '__CADDYFILE__': shlex.quote(os.environ['CADDYFILE']),
    '__COMPOSE_PROJECT__': shlex.quote(os.environ['COMPOSE_PROJECT']),
    '__COMMIT_SHA__': shlex.quote(os.environ['COMMIT_SHA']),
    '__CHANNEL_TAG__': shlex.quote(os.environ['CHANNEL_TAG']),
    '__PRISMA_SCHEMA_SHA__': shlex.quote(os.environ['PRISMA_SCHEMA_SHA']),
    '__RUNTIME_IMAGE__': shlex.quote(os.environ['RUNTIME_IMAGE']),
    '__STATIC_IMAGE__': shlex.quote(os.environ['STATIC_IMAGE']),
    '__STATIC_VOLUME__': shlex.quote(os.environ['STATIC_VOLUME']),
    '__VROOM_IMAGE__': shlex.quote(os.environ['VROOM_IMAGE']),
    '__BASE_URL__': shlex.quote(os.environ['BASE_URL']),
    '__DRY_RUN__': shlex.quote(os.environ['DRY_RUN']),
    '__FORCE_STATIC_RESTAGE__': shlex.quote(os.environ['FORCE_STATIC_RESTAGE']),
    '__COMPOSE_FILE_B64__': shlex.quote(os.environ['COMPOSE_FILE_B64']),
    '__CADDYFILE_B64__': shlex.quote(os.environ['CADDYFILE_B64']),
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
CADDYFILE_B64="$(base64 < "$CADDYFILE" | tr -d '\n')"
export APP_DIR COMPOSE_FILE CADDYFILE COMPOSE_PROJECT COMMIT_SHA CHANNEL_TAG PRISMA_SCHEMA_SHA RUNTIME_IMAGE STATIC_IMAGE STATIC_VOLUME VROOM_IMAGE BASE_URL DRY_RUN FORCE_STATIC_RESTAGE COMPOSE_FILE_B64 CADDYFILE_B64
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
set +e
aws ssm wait command-executed --region "$AWS_REGION" --command-id "$COMMAND_ID" --instance-id "$INSTANCE_ID"
wait_status=$?
set -e
aws ssm get-command-invocation \
  --region "$AWS_REGION" \
  --command-id "$COMMAND_ID" \
  --instance-id "$INSTANCE_ID" \
  --query '{Status:Status,ResponseCode:ResponseCode,Stdout:StandardOutputContent,Stderr:StandardErrorContent}' \
  --output json
exit "$wait_status"
