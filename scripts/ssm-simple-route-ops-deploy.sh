#!/usr/bin/env bash
set -euo pipefail

AWS_REGION="${AWS_REGION:-ap-northeast-2}"
APP_DIR="${APP_DIR:-/srv/clever-route-server}"
COMPOSE_FILE="${COMPOSE_FILE:-infra/compose/docker-compose.prod.yml}"
COMPOSE_PROJECT="${ROUTE_OPS_COMPOSE_PROJECT_NAME:-clever-route}"
SERVICE_TAG_KEY="${ROUTE_OPS_SSM_TAG_KEY:-Service}"
SERVICE_TAG_VALUE="${ROUTE_OPS_SSM_TAG_VALUE:-clever-delivery-server}"
CHANNEL_TAG="${ROUTE_OPS_SIMPLE_CHANNEL_TAG:-prod}"
COMMIT_SHA="$(git rev-parse --short=40 HEAD)"
PRISMA_SCHEMA_SHA="$(shasum -a 256 apps/delivery-api/prisma/schema.prisma | awk '{print $1}')"
RUNTIME_IMAGE="${ROUTE_OPS_RUNTIME_IMAGE_REPO:-ghcr.io/evnsolution/clever-route-server-delivery-api}:${CHANNEL_TAG}"
MIGRATE_IMAGE="${ROUTE_OPS_MIGRATE_IMAGE_REPO:-ghcr.io/evnsolution/clever-route-server-delivery-api-migrate}:${CHANNEL_TAG}"
STATIC_IMAGE="${ROUTE_OPS_WEB_STATIC_IMAGE_REPO:-ghcr.io/evnsolution/clever-route-server-route-ops-web-static}:${CHANNEL_TAG}"
STATIC_VOLUME="${ROUTE_OPS_WEB_STATIC_VOLUME:-clever-route-route-ops-web-static-${CHANNEL_TAG}}"
VROOM_IMAGE="${VROOM_IMAGE:-ghcr.io/vroom-project/vroom-docker@sha256:247d5683d6745c755d718a156d16b16aac80baccc276a003a68b986c13883b08}"
BASE_URL="${ROUTE_OPS_SMOKE_BASE_URL:-https://clever-route.cleversystem.ai}"
DRY_RUN=0
BUILD_AND_PUSH=0
SEND_COMMAND=1

usage() {
  cat <<USAGE
Usage: $0 [--dry-run] [--publish] [--no-send]

Simple Route Ops SSM deploy lane: no S3 deploy-control bundle and no immutable
image tag handoff. --publish builds and pushes mutable channel images locally;
the SSM command pulls the channel images and restarts production through Docker
Compose on the managed instance.

Env:
  ROUTE_OPS_SIMPLE_CHANNEL_TAG   default: prod
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
    return 0
  fi
  if command -v gh >/dev/null 2>&1; then
    local auth_status
    auth_status="$(gh auth status -h github.com 2>&1 || true)"
    if ! printf '%s\n' "$auth_status" | grep -q 'write:packages'; then
      fail "GHCR publish requires a GitHub/GHCR token with write:packages; refresh login or set ROUTE_OPS_SKIP_GHCR_WRITE_SCOPE_CHECK=1 after docker login with a write-capable token"
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
  npm --prefix apps/route-ops-web run build
  local static_context
  static_context="$(mktemp -d)"
  cp -R apps/route-ops-web/dist "$static_context/dist"
  cp -R apps/route-ops-web/public "$static_context/public"
  cat > "$static_context/Dockerfile" <<'DOCKERFILE'
FROM alpine:3.20
ARG COMMIT_SHA
ARG PRISMA_SCHEMA_SHA
LABEL org.opencontainers.image.revision=$COMMIT_SHA
LABEL org.clever-route.image-role=route-ops-web-static
LABEL org.clever-route.prisma-schema-sha=$PRISMA_SCHEMA_SHA
WORKDIR /opt/route-ops-web
COPY dist ./dist
COPY public ./public
DOCKERFILE
  docker build --platform linux/amd64 \
    --build-arg COMMIT_SHA="$COMMIT_SHA" \
    --build-arg PRISMA_SCHEMA_SHA="$PRISMA_SCHEMA_SHA" \
    -t "$STATIC_IMAGE" "$static_context"
  docker build --platform linux/amd64 \
    -f apps/delivery-api/Dockerfile \
    --target runtime \
    --label "org.opencontainers.image.revision=$COMMIT_SHA" \
    --label "org.clever-route.prisma-schema-sha=$PRISMA_SCHEMA_SHA" \
    --label "org.clever-route.image-role=runtime" \
    -t "$RUNTIME_IMAGE" .
  docker build --platform linux/amd64 \
    -f apps/delivery-api/Dockerfile \
    --target migrate \
    --label "org.opencontainers.image.revision=$COMMIT_SHA" \
    --label "org.clever-route.prisma-schema-sha=$PRISMA_SCHEMA_SHA" \
    --label "org.clever-route.image-role=migrate" \
    -t "$MIGRATE_IMAGE" .
  for image in "$STATIC_IMAGE" "$RUNTIME_IMAGE" "$MIGRATE_IMAGE"; do
    docker image inspect "$image" --format '{{.Architecture}} {{index .Config.Labels "org.opencontainers.image.revision"}} {{index .Config.Labels "org.clever-route.image-role"}} {{index .Config.Labels "org.clever-route.prisma-schema-sha"}}'
    docker push "$image"
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
COMPOSE_PROJECT=__COMPOSE_PROJECT__
COMMIT_SHA=__COMMIT_SHA__
CHANNEL_TAG=__CHANNEL_TAG__
PRISMA_SCHEMA_SHA=__PRISMA_SCHEMA_SHA__
DELIVERY_API_IMAGE=__RUNTIME_IMAGE__
DELIVERY_API_MIGRATE_IMAGE=__MIGRATE_IMAGE__
ROUTE_OPS_WEB_STATIC_IMAGE=__STATIC_IMAGE__
ROUTE_OPS_WEB_STATIC_VOLUME=__STATIC_VOLUME__
VROOM_IMAGE=__VROOM_IMAGE__
BASE_URL=__BASE_URL__
DRY_RUN=__DRY_RUN__
GHCR_USERNAME_PARAM="${ROUTE_OPS_GHCR_USERNAME_PARAM:-/clever/deploy/github/username}"
GHCR_TOKEN_PARAM="${ROUTE_OPS_GHCR_TOKEN_PARAM:-/clever/deploy/github/read-token}"
cd "$APP_DIR"
mkdir -p .deploy
lock_dir=.deploy/route-ops-simple-deploy.lock.d
if ! mkdir "$lock_dir" 2>/dev/null; then echo 'another simple deploy is running' >&2; exit 65; fi
trap 'rmdir "$lock_dir" 2>/dev/null || true' EXIT
printf 'simple deploy preflight: commit=%s channel=%s runtime=%s migrate=%s static=%s volume=%s dryRun=%s\n' "$COMMIT_SHA" "$CHANNEL_TAG" "$DELIVERY_API_IMAGE" "$DELIVERY_API_MIGRATE_IMAGE" "$ROUTE_OPS_WEB_STATIC_IMAGE" "$ROUTE_OPS_WEB_STATIC_VOLUME" "$DRY_RUN"
command -v docker >/dev/null
command -v aws >/dev/null
command -v python3 >/dev/null
[ -f "$COMPOSE_FILE" ]
[ -f infra/env/delivery-api.env ]
cat > .deploy/simple-candidate-image.env <<EOF_ENV
IMAGE_TAG=$CHANNEL_TAG
COMMIT_SHA=$COMMIT_SHA
DELIVERY_API_IMAGE=$DELIVERY_API_IMAGE
DELIVERY_API_MIGRATE_IMAGE=$DELIVERY_API_MIGRATE_IMAGE
ROUTE_OPS_WEB_STATIC_IMAGE=$ROUTE_OPS_WEB_STATIC_IMAGE
ROUTE_OPS_WEB_STATIC_VOLUME=$ROUTE_OPS_WEB_STATIC_VOLUME
VROOM_IMAGE=$VROOM_IMAGE
PRISMA_SCHEMA_SHA=$PRISMA_SCHEMA_SHA
EOF_ENV
docker compose -p "$COMPOSE_PROJECT" --env-file .deploy/simple-candidate-image.env -f "$COMPOSE_FILE" --profile osrm --profile vroom config --quiet
if [ "$DRY_RUN" = "1" ]; then
  printf 'simple deploy dry-run complete; no host env, image pull, or restart mutation performed.\n'
  exit 0
fi
python3 - <<'ENVUP'
from pathlib import Path
path = Path('infra/env/delivery-api.env')
updates = {
    'VROOM_BASE_URL': 'http://vroom:3000',
    'VROOM_TIMEOUT_MS': '180000',
    'ROUTE_OPTIMIZATION_JOB_TIMEOUT_BUDGET_MS': '180000',
    'ROUTE_ENGINE_BASE_URL': '',
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
docker pull "$DELIVERY_API_IMAGE"
docker pull "$DELIVERY_API_MIGRATE_IMAGE"
docker pull "$ROUTE_OPS_WEB_STATIC_IMAGE"
docker pull "$VROOM_IMAGE"
docker compose -p "$COMPOSE_PROJECT" --env-file .deploy/simple-candidate-image.env -f "$COMPOSE_FILE" up --no-build --force-recreate route-ops-web-static
docker compose -p "$COMPOSE_PROJECT" --env-file .deploy/simple-candidate-image.env -f "$COMPOSE_FILE" run --rm delivery-api-migrate
docker compose -p "$COMPOSE_PROJECT" --env-file .deploy/simple-candidate-image.env -f "$COMPOSE_FILE" --profile osrm --profile vroom up -d --no-build osrm-ontario vroom
docker compose -p "$COMPOSE_PROJECT" --env-file .deploy/simple-candidate-image.env -f "$COMPOSE_FILE" run --rm --no-deps delivery-api node - <<'NODE'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let lastError;
for (let attempt = 1; attempt <= 30; attempt += 1) {
  try {
    const health = await fetch('http://vroom:3000/health');
    if (!health.ok) throw new Error(`health ${health.status}`);
    const response = await fetch('http://vroom:3000/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vehicles: [{ id: 1, profile: 'car', start: [-79.3832, 43.6532], end: [-79.3832, 43.6532], capacity: [2] }],
        jobs: [
          { id: 1, location: [-79.3871, 43.6426], delivery: [1] },
          { id: 2, location: [-79.6441, 43.5890], delivery: [1] }
        ]
      })
    });
    if (!response.ok) throw new Error(`solve ${response.status}: ${await response.text()}`);
    const payload = await response.json();
    if (payload.code !== 0 || (payload.unassigned?.length ?? 0) !== 0) throw new Error(JSON.stringify(payload));
    console.log(JSON.stringify({ code: payload.code, routes: payload.routes?.length ?? 0, unassigned: payload.unassigned?.length ?? 0 }));
    process.exit(0);
  } catch (error) {
    lastError = error;
    if (attempt < 30) await sleep(2000);
  }
}
throw lastError;
NODE
docker compose -p "$COMPOSE_PROJECT" --env-file .deploy/simple-candidate-image.env -f "$COMPOSE_FILE" up -d --no-build --force-recreate delivery-api caddy
docker compose -p "$COMPOSE_PROJECT" --env-file .deploy/simple-candidate-image.env -f "$COMPOSE_FILE" --profile route-engine stop route-engine || true
for attempt in $(seq 1 30); do
  if curl -fsS "$BASE_URL/healthz"; then break; fi
  if [ "$attempt" = "30" ]; then echo 'health smoke failed' >&2; exit 1; fi
  sleep 2
done
cp .deploy/current-image.env ".deploy/current-image.env.before-simple-$(date -u +%Y%m%dT%H%M%SZ)" 2>/dev/null || true
cp .deploy/simple-candidate-image.env .deploy/current-image.env
printf '{"ts":"%s","commitSha":"%s","channelTag":"%s","deliveryApiImage":"%s","migrateImage":"%s","routeOpsWebStaticImage":"%s","routeOpsWebStaticVolume":"%s","vroomImage":"%s","prismaSchemaSha":"%s","lane":"simple-ssm"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$COMMIT_SHA" "$CHANNEL_TAG" "$DELIVERY_API_IMAGE" "$DELIVERY_API_MIGRATE_IMAGE" "$ROUTE_OPS_WEB_STATIC_IMAGE" "$ROUTE_OPS_WEB_STATIC_VOLUME" "$VROOM_IMAGE" "$PRISMA_SCHEMA_SHA" >> .deploy/deploy-history.jsonl
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
    '__COMPOSE_PROJECT__': shlex.quote(os.environ['COMPOSE_PROJECT']),
    '__COMMIT_SHA__': shlex.quote(os.environ['COMMIT_SHA']),
    '__CHANNEL_TAG__': shlex.quote(os.environ['CHANNEL_TAG']),
    '__PRISMA_SCHEMA_SHA__': shlex.quote(os.environ['PRISMA_SCHEMA_SHA']),
    '__RUNTIME_IMAGE__': shlex.quote(os.environ['RUNTIME_IMAGE']),
    '__MIGRATE_IMAGE__': shlex.quote(os.environ['MIGRATE_IMAGE']),
    '__STATIC_IMAGE__': shlex.quote(os.environ['STATIC_IMAGE']),
    '__STATIC_VOLUME__': shlex.quote(os.environ['STATIC_VOLUME']),
    '__VROOM_IMAGE__': shlex.quote(os.environ['VROOM_IMAGE']),
    '__BASE_URL__': shlex.quote(os.environ['BASE_URL']),
    '__DRY_RUN__': shlex.quote(os.environ['DRY_RUN']),
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

export APP_DIR COMPOSE_FILE COMPOSE_PROJECT COMMIT_SHA CHANNEL_TAG PRISMA_SCHEMA_SHA RUNTIME_IMAGE MIGRATE_IMAGE STATIC_IMAGE STATIC_VOLUME VROOM_IMAGE BASE_URL DRY_RUN
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
aws ssm wait command-executed --region "$AWS_REGION" --command-id "$COMMAND_ID" --instance-id "$INSTANCE_ID"
aws ssm get-command-invocation \
  --region "$AWS_REGION" \
  --command-id "$COMMAND_ID" \
  --instance-id "$INSTANCE_ID" \
  --query '{Status:Status,ResponseCode:ResponseCode,Stdout:StandardOutputContent,Stderr:StandardErrorContent}' \
  --output json
