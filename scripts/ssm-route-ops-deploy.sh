#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/srv/clever-route-server}"
ENV_FILE="${ROUTE_OPS_HOST_ENV_FILE:-infra/env/delivery-api.env}"
ROUTE_OPS_COMPOSE_PROJECT_NAME="${ROUTE_OPS_COMPOSE_PROJECT_NAME:-clever-route}"
LOCK_PATH="${ROUTE_OPS_DEPLOY_LOCK_PATH:-.deploy/route-ops-deploy.lock}"
LOCK_DIR="${LOCK_PATH}.d"
LOCK_ACQUIRED="false"
GHCR_USERNAME_PARAM="${ROUTE_OPS_GHCR_USERNAME_PARAM:-/clever/deploy/github/username}"
GHCR_TOKEN_PARAM="${ROUTE_OPS_GHCR_TOKEN_PARAM:-/clever/deploy/github/read-token}"

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

login_to_ghcr() {
  if [ "${ROUTE_OPS_SKIP_GHCR_LOGIN:-}" = "1" ]; then
    return 0
  fi
  case "$DELIVERY_API_IMAGE $DELIVERY_API_MIGRATE_IMAGE" in
    *ghcr.io/evnsolution/clever-route-server-delivery-api*) ;;
    *) return 0 ;;
  esac
  command -v aws >/dev/null 2>&1 || fail "aws CLI is required on the host for GHCR credentials"
  command -v docker >/dev/null 2>&1 || fail "docker is required on the host for GHCR login"
  export AWS_REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-${ROUTE_OPS_AWS_REGION:-ap-northeast-2}}}"
  local username token
  username="$(aws ssm get-parameter --name "$GHCR_USERNAME_PARAM" --query 'Parameter.Value' --output text)"
  token="$(aws ssm get-parameter --name "$GHCR_TOKEN_PARAM" --with-decryption --query 'Parameter.Value' --output text)"
  if [ -z "$username" ] || [ "$username" = "None" ]; then
    fail "GHCR username parameter is empty: $GHCR_USERNAME_PARAM"
  fi
  if [ -z "$token" ] || [ "$token" = "None" ]; then
    fail "GHCR token parameter is empty: $GHCR_TOKEN_PARAM"
  fi
  if ! printf '%s' "$token" | docker login ghcr.io -u "$username" --password-stdin >/dev/null; then
    token=""
    fail "GHCR login failed"
  fi
  token=""
  printf 'GHCR login ready for %s\n' "$username"
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
export ROUTE_OPS_COMPOSE_PROJECT_NAME
export COMPOSE_PROJECT_NAME="$ROUTE_OPS_COMPOSE_PROJECT_NAME"

if [ "$ROUTE_OPS_COMPOSE_PROJECT_NAME" != "clever-route" ]; then
  fail "ROUTE_OPS_COMPOSE_PROJECT_NAME must be exactly clever-route; got: ${ROUTE_OPS_COMPOSE_PROJECT_NAME}"
fi
acquire_lock
read_host_secret
login_to_ghcr

printf 'Route Ops SSM deploy wrapper starting: tag=%s schema=%s runtime=%s migrate=%s composeProject=%s\n' \
  "$IMAGE_TAG" "$PRISMA_SCHEMA_SHA" "$DELIVERY_API_IMAGE" "$DELIVERY_API_MIGRATE_IMAGE" "$ROUTE_OPS_COMPOSE_PROJECT_NAME"

scripts/deploy-route-ops-image.sh
record_publish_evidence
