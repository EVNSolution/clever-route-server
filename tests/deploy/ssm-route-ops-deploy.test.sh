#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

IMAGE_TAG="0123456789abcdef0123456789abcdef01234567"
SCHEMA_SHA="abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd"
RUNTIME_IMAGE="ghcr.io/evnsolution/clever-route-server-delivery-api:${IMAGE_TAG}"
MIGRATE_IMAGE="ghcr.io/evnsolution/clever-route-server-delivery-api-migrate:${IMAGE_TAG}"
SECRET_VALUE="unit-test-secret-not-real"

tmp="$(mktemp -d "${TMPDIR:-/tmp}/route-ops-ssm-test.XXXXXX")"
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT

mkdir -p "$tmp/scripts" "$tmp/infra/env" "$tmp/.deploy"
cat > "$tmp/infra/env/delivery-api.env" <<EOF_ENV
CLEVER_ADMIN_WEB_LOGIN_SECRET=${SECRET_VALUE}
EOF_ENV
cat > "$tmp/scripts/deploy-route-ops-image.sh" <<'EOF_DEPLOY'
#!/usr/bin/env bash
set -euo pipefail
: "${ROUTE_OPS_DEPLOY_LOCK_HELD:?lock marker required}"
: "${ROUTE_OPS_SMOKE_LOGIN_SECRET:?secret required}"
: "${IMAGE_TAG:?image tag required}"
: "${PRISMA_SCHEMA_SHA:?schema sha required}"
: "${DELIVERY_API_IMAGE:?runtime image required}"
: "${DELIVERY_API_MIGRATE_IMAGE:?migrate image required}"
: "${ROUTE_OPS_COMPOSE_PROJECT_NAME:?compose project required}"
test "$ROUTE_OPS_COMPOSE_PROJECT_NAME" = "clever-route"
if [ "$ROUTE_OPS_SMOKE_LOGIN_SECRET" = "unit-test-secret-not-real" ]; then
  echo "deploy-called tag=${IMAGE_TAG}" > .deploy/fake-result.txt
else
  echo "unexpected secret" >&2
  exit 1
fi
EOF_DEPLOY
chmod +x "$tmp/scripts/deploy-route-ops-image.sh"

output="$tmp/output.txt"
APP_DIR="$tmp" \
ROUTE_OPS_DEPLOY_LOCK_FORCE_MKDIR=1 \
ROUTE_OPS_SKIP_GHCR_LOGIN=1 \
PUBLISH_EVIDENCE_URL="https://github.com/EVNSolution/clever-route-server/actions/runs/123456789" \
IMAGE_TAG="$IMAGE_TAG" \
PRISMA_SCHEMA_SHA="$SCHEMA_SHA" \
DELIVERY_API_IMAGE="$RUNTIME_IMAGE" \
DELIVERY_API_MIGRATE_IMAGE="$MIGRATE_IMAGE" \
scripts/ssm-route-ops-deploy.sh > "$output"

test -f "$tmp/.deploy/fake-result.txt"
test -f "$tmp/.deploy/deploy-evidence.jsonl"
grep -q "actions/runs/123456789" "$tmp/.deploy/deploy-evidence.jsonl"
if grep -q "$SECRET_VALUE" "$output" "$tmp/.deploy/fake-result.txt" "$tmp/.deploy/deploy-evidence.jsonl"; then
  echo "secret leaked to wrapper output or fake result" >&2
  exit 1
fi

if APP_DIR="$tmp" \
ROUTE_OPS_DEPLOY_LOCK_FORCE_MKDIR=1 \
ROUTE_OPS_SKIP_GHCR_LOGIN=1 \
ROUTE_OPS_COMPOSE_PROJECT_NAME=compose \
IMAGE_TAG="$IMAGE_TAG" \
PRISMA_SCHEMA_SHA="$SCHEMA_SHA" \
DELIVERY_API_IMAGE="$RUNTIME_IMAGE" \
DELIVERY_API_MIGRATE_IMAGE="$MIGRATE_IMAGE" \
scripts/ssm-route-ops-deploy.sh >/dev/null 2>&1; then
  echo "invalid compose project unexpectedly passed" >&2
  exit 1
fi

if APP_DIR="$tmp" \
ROUTE_OPS_DEPLOY_LOCK_FORCE_MKDIR=1 \
ROUTE_OPS_SKIP_GHCR_LOGIN=1 \
IMAGE_TAG="latest" \
PRISMA_SCHEMA_SHA="$SCHEMA_SHA" \
DELIVERY_API_IMAGE="$RUNTIME_IMAGE" \
DELIVERY_API_MIGRATE_IMAGE="$MIGRATE_IMAGE" \
scripts/ssm-route-ops-deploy.sh >/dev/null 2>&1; then
  echo "invalid tag unexpectedly passed" >&2
  exit 1
fi

mkdir -p "$tmp/.deploy/route-ops-deploy.lock.d"
if APP_DIR="$tmp" \
ROUTE_OPS_DEPLOY_LOCK_FORCE_MKDIR=1 \
ROUTE_OPS_SKIP_GHCR_LOGIN=1 \
IMAGE_TAG="$IMAGE_TAG" \
PRISMA_SCHEMA_SHA="$SCHEMA_SHA" \
DELIVERY_API_IMAGE="$RUNTIME_IMAGE" \
DELIVERY_API_MIGRATE_IMAGE="$MIGRATE_IMAGE" \
scripts/ssm-route-ops-deploy.sh >/dev/null 2>&1; then
  echo "pre-existing lock unexpectedly passed" >&2
  exit 1
fi
rmdir "$tmp/.deploy/route-ops-deploy.lock.d"

printf '{"ok":true,"wrapper":"scripts/ssm-route-ops-deploy.sh"}\n'
