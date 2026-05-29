#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/srv/clever-route-server}"
ENV_FILE="${ROUTE_OPS_HOST_ENV_FILE:-infra/env/delivery-api.env}"
LOCK_PATH="${ROUTE_OPS_DEPLOY_LOCK_PATH:-.deploy/route-ops-deploy.lock}"
LOCK_DIR="${LOCK_PATH}.d"
LOCK_ACQUIRED="false"

: "${IMAGE_TAG:?IMAGE_TAG is required}"
: "${PRISMA_SCHEMA_SHA:?PRISMA_SCHEMA_SHA is required}"
: "${DELIVERY_API_IMAGE:?DELIVERY_API_IMAGE is required}"
: "${DELIVERY_API_MIGRATE_IMAGE:?DELIVERY_API_MIGRATE_IMAGE is required}"

fail() {
  echo "ssm-route-ops-deploy: $*" >&2
  exit 1
}

validate_inputs() {
  [[ "$IMAGE_TAG" =~ ^[0-9a-fA-F]{40}$ ]] || fail "IMAGE_TAG must be a 40-hex git SHA"
  [[ "$PRISMA_SCHEMA_SHA" =~ ^[0-9a-fA-F]{64}$ ]] || fail "PRISMA_SCHEMA_SHA must be a 64-hex SHA256"
  [[ "$DELIVERY_API_IMAGE" =~ ^ghcr\.io/evnsolution/clever-route-server-delivery-api:[0-9a-fA-F]{40}$ ]] || fail "DELIVERY_API_IMAGE must be the approved runtime GHCR image with SHA tag"
  [[ "$DELIVERY_API_MIGRATE_IMAGE" =~ ^ghcr\.io/evnsolution/clever-route-server-delivery-api-migrate:[0-9a-fA-F]{40}$ ]] || fail "DELIVERY_API_MIGRATE_IMAGE must be the approved migrate GHCR image with SHA tag"
  [[ "$DELIVERY_API_IMAGE" == *":$IMAGE_TAG" ]] || fail "runtime image tag must match IMAGE_TAG"
  [[ "$DELIVERY_API_MIGRATE_IMAGE" == *":$IMAGE_TAG" ]] || fail "migrate image tag must match IMAGE_TAG"
}

release_lock() {
  if [ "$LOCK_ACQUIRED" = "mkdir" ] && [ -d "$LOCK_DIR" ]; then
    rmdir "$LOCK_DIR" || true
  fi
}

acquire_lock() {
  mkdir -p .deploy
  if [ "${ROUTE_OPS_DEPLOY_LOCK_HELD:-}" = "1" ]; then
    return 0
  fi
  if [ "${ROUTE_OPS_DEPLOY_LOCK_FORCE_MKDIR:-}" != "1" ] && command -v flock >/dev/null 2>&1; then
    exec 9>"$LOCK_PATH"
    if ! flock -n 9; then
      fail "another Route Ops deploy or rollback is already running"
    fi
    LOCK_ACQUIRED="flock"
    export ROUTE_OPS_DEPLOY_LOCK_HELD=1
    return 0
  fi
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    fail "another Route Ops deploy or rollback is already running"
  fi
  LOCK_ACQUIRED="mkdir"
  export ROUTE_OPS_DEPLOY_LOCK_HELD=1
  trap release_lock EXIT
}

read_host_secret() {
  if [ -n "${ROUTE_OPS_SMOKE_LOGIN_SECRET:-}" ]; then
    return 0
  fi
  if [ ! -f "$ENV_FILE" ]; then
    fail "ROUTE_OPS_SMOKE_LOGIN_SECRET is unset and $ENV_FILE was not found"
  fi
  local line value
  line="$(grep -m1 '^CLEVER_ADMIN_WEB_LOGIN_SECRET=' "$ENV_FILE" || true)"
  if [ -z "$line" ]; then
    fail "CLEVER_ADMIN_WEB_LOGIN_SECRET was not found in $ENV_FILE"
  fi
  value="${line#CLEVER_ADMIN_WEB_LOGIN_SECRET=}"
  case "$value" in
    \"*\") value="${value#\"}"; value="${value%\"}" ;;
    \'*\') value="${value#\'}"; value="${value%\'}" ;;
  esac
  if [ -z "$value" ]; then
    fail "CLEVER_ADMIN_WEB_LOGIN_SECRET is empty in $ENV_FILE"
  fi
  export ROUTE_OPS_SMOKE_LOGIN_SECRET="$value"
}

validate_publish_evidence() {
  if [ -z "${PUBLISH_EVIDENCE_URL:-}" ]; then
    return 0
  fi
  [[ "$PUBLISH_EVIDENCE_URL" =~ ^https://github\.com/EVNSolution/clever-route-server/actions/runs/[0-9]+/?$ ]] || fail "PUBLISH_EVIDENCE_URL must be a Route Ops GitHub Actions run URL"
}

record_publish_evidence() {
  if [ -z "${PUBLISH_EVIDENCE_URL:-}" ]; then
    return 0
  fi
  printf '{"ts":"%s","imageTag":"%s","publishEvidenceUrl":"%s"}
'     "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$IMAGE_TAG" "$PUBLISH_EVIDENCE_URL" >> .deploy/deploy-evidence.jsonl
}

validate_inputs
validate_publish_evidence
cd "$APP_DIR"
acquire_lock
read_host_secret

printf 'Route Ops SSM deploy wrapper starting: tag=%s schema=%s runtime=%s migrate=%s\n' \
  "$IMAGE_TAG" "$PRISMA_SCHEMA_SHA" "$DELIVERY_API_IMAGE" "$DELIVERY_API_MIGRATE_IMAGE"

scripts/deploy-route-ops-image.sh
record_publish_evidence
