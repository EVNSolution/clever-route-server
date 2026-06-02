#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

IMAGE_TAG="0123456789abcdef0123456789abcdef01234567"
CURRENT_TAG="1111111111111111111111111111111111111111"
PREVIOUS_TAG="2222222222222222222222222222222222222222"
STALE_TAG="3333333333333333333333333333333333333333"
ACTIVE_TAG="4444444444444444444444444444444444444444"
SCHEMA_SHA="abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd"
RUNTIME_REPO="ghcr.io/evnsolution/clever-route-server-delivery-api"
MIGRATE_REPO="ghcr.io/evnsolution/clever-route-server-delivery-api-migrate"
RUNTIME_IMAGE="${RUNTIME_REPO}:${IMAGE_TAG}"
MIGRATE_IMAGE="${MIGRATE_REPO}:${IMAGE_TAG}"

make_fake_bin() {
  local tmp="$1"
  mkdir -p "$tmp/bin" "$tmp/docker-root"

  cat > "$tmp/bin/docker" <<'EOF_DOCKER'
#!/usr/bin/env bash
set -euo pipefail
state="${FAKE_DOCKER_STATE:?FAKE_DOCKER_STATE is required}"
mkdir -p "$state"
log="$state/docker.log"
printf 'docker %s\n' "$*" >> "$log"

image_id() {
  local image="$1"
  case "$image" in
    *:0123456789abcdef0123456789abcdef01234567) echo "sha256:candidate" ;;
    *:1111111111111111111111111111111111111111) echo "sha256:current" ;;
    *:2222222222222222222222222222222222222222) echo "sha256:previous" ;;
    *:3333333333333333333333333333333333333333) echo "sha256:stale" ;;
    *:4444444444444444444444444444444444444444) echo "sha256:active" ;;
    clever-route-server-delivery-api:local) echo "sha256:legacy-local" ;;
    *) echo "sha256:other" ;;
  esac
}

case "${1:-}" in
  info)
    if [ "${2:-}" = "--format" ]; then
      echo "${FAKE_DOCKER_ROOT:?FAKE_DOCKER_ROOT is required}"
    fi
    ;;
  system)
    if [ "${2:-}" = "df" ]; then
      echo "TYPE            TOTAL     ACTIVE    SIZE      RECLAIMABLE"
      echo "Images          8         2         8GB       6GB (75%)"
    fi
    ;;
  ps)
    if [ "${2:-}" = "--format" ]; then
      format="${3:-}"
      if [[ "$format" == *'.Names'* ]]; then
        if [ "${FAKE_LEGACY_COMPOSE_RUNNING:-0}" = "1" ]; then
          echo "compose-caddy-1|compose|caddy|0.0.0.0:80->80/tcp,0.0.0.0:443->443/tcp"
          echo "compose-delivery-api-1|compose|delivery-api|3000/tcp"
          echo "compose-postgres-1|compose|postgres|5432/tcp"
        else
          echo "clever-route-caddy-1|clever-route|caddy|0.0.0.0:80->80/tcp,0.0.0.0:443->443/tcp"
        fi
      else
        echo "postgres:17-bookworm"
        echo "ghcr.io/evnsolution/clever-route-server-delivery-api:1111111111111111111111111111111111111111"
        echo "ghcr.io/evnsolution/clever-route-server-delivery-api:4444444444444444444444444444444444444444"
      fi
    fi
    ;;
  image)
    case "${2:-}" in
      ls)
        repo="${3:-}"
        case "$repo" in
          ghcr.io/evnsolution/clever-route-server-delivery-api)
            echo "ghcr.io/evnsolution/clever-route-server-delivery-api:0123456789abcdef0123456789abcdef01234567"
            echo "ghcr.io/evnsolution/clever-route-server-delivery-api:1111111111111111111111111111111111111111"
            echo "ghcr.io/evnsolution/clever-route-server-delivery-api:2222222222222222222222222222222222222222"
            echo "ghcr.io/evnsolution/clever-route-server-delivery-api:3333333333333333333333333333333333333333"
            echo "ghcr.io/evnsolution/clever-route-server-delivery-api:4444444444444444444444444444444444444444"
            ;;
          ghcr.io/evnsolution/clever-route-server-delivery-api-migrate)
            echo "ghcr.io/evnsolution/clever-route-server-delivery-api-migrate:0123456789abcdef0123456789abcdef01234567"
            echo "ghcr.io/evnsolution/clever-route-server-delivery-api-migrate:1111111111111111111111111111111111111111"
            echo "ghcr.io/evnsolution/clever-route-server-delivery-api-migrate:2222222222222222222222222222222222222222"
            echo "ghcr.io/evnsolution/clever-route-server-delivery-api-migrate:3333333333333333333333333333333333333333"
            ;;
        esac
        ;;
      inspect)
        format=""
        image=""
        shift 2
        while [ "$#" -gt 0 ]; do
          case "$1" in
            --format) format="$2"; shift 2 ;;
            *) image="$1"; shift ;;
          esac
        done
        case "$format" in
          *'.Id'*|'{{.Id}}') image_id "$image" ;;
          *'org.opencontainers.image.revision'*) echo "0123456789abcdef0123456789abcdef01234567" ;;
          *'org.clever-route.prisma-schema-sha'*) echo "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd" ;;
          *'org.clever-route.image-role'*)
            case "$image" in
              *delivery-api-migrate*) echo "migrate" ;;
              *) echo "runtime" ;;
            esac
            ;;
          *) image_id "$image" ;;
        esac
        ;;
      rm)
        image="${3:-}"
        echo "$image" >> "$state/removed.log"
        ;;
      *) ;;
    esac
    ;;
  compose)
    echo "compose ${*:2}" >> "$state/compose.log"
    ;;
  run)
    echo "run ${*:2}" >> "$state/docker-run.log"
    ;;
  login)
    ;;
  *)
    ;;
esac
EOF_DOCKER
  chmod +x "$tmp/bin/docker"

  cat > "$tmp/bin/df" <<'EOF_DF'
#!/usr/bin/env bash
set -euo pipefail
state="${FAKE_DOCKER_STATE:?FAKE_DOCKER_STATE is required}"
mode="${FAKE_DF_MODE:-recover}"
if [ "${1:-}" = "-Pk" ]; then
  path="${2:-/}"
  echo "Filesystem 1024-blocks Used Available Capacity Mounted on"
  if [ "$mode" = "always-low" ] || { [ "$mode" = "recover" ] && [ ! -s "$state/removed.log" ]; }; then
    echo "/dev/fake 20480000 20478976 1024 99% ${path}"
  else
    echo "/dev/fake 20480000 10240000 10240000 50% ${path}"
  fi
  exit 0
fi
echo "Filesystem      Size  Used Avail Use% Mounted on"
echo "/dev/fake        20G   10G   10G  50% ${*: -1}"
EOF_DF
  chmod +x "$tmp/bin/df"

  cat > "$tmp/bin/node" <<'EOF_NODE'
#!/usr/bin/env bash
set -euo pipefail
echo "fake-node-smoke-ok"
EOF_NODE
  chmod +x "$tmp/bin/node"
}

prepare_app_dir() {
  local tmp="$1"
  mkdir -p "$tmp/.deploy" "$tmp/infra/compose" "$tmp/scripts"
  cat > "$tmp/.deploy/current-image.env" <<EOF_CURRENT
IMAGE_TAG=${CURRENT_TAG}
DELIVERY_API_IMAGE=${RUNTIME_REPO}:${CURRENT_TAG}
DELIVERY_API_MIGRATE_IMAGE=${MIGRATE_REPO}:${CURRENT_TAG}
PRISMA_SCHEMA_SHA=${SCHEMA_SHA}
EOF_CURRENT
  cat > "$tmp/.deploy/previous-image.env" <<EOF_PREVIOUS
IMAGE_TAG=${PREVIOUS_TAG}
DELIVERY_API_IMAGE=${RUNTIME_REPO}:${PREVIOUS_TAG}
DELIVERY_API_MIGRATE_IMAGE=${MIGRATE_REPO}:${PREVIOUS_TAG}
PRISMA_SCHEMA_SHA=${SCHEMA_SHA}
EOF_PREVIOUS
  touch "$tmp/infra/compose/docker-compose.prod.yml" "$tmp/scripts/smoke-route-ops-production.mjs"
}

run_success_case() {
  local tmp
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/route-ops-disk-success.XXXXXX")"
  trap 'rm -rf "$tmp"' RETURN
  prepare_app_dir "$tmp"
  make_fake_bin "$tmp"
  mkdir -p "$tmp/state"

  PATH="$tmp/bin:$PATH" \
  FAKE_DOCKER_STATE="$tmp/state" \
  FAKE_DOCKER_ROOT="$tmp/docker-root" \
  FAKE_DF_MODE="recover" \
  APP_DIR="$tmp" \
  ROUTE_OPS_DEPLOY_LOCK_FORCE_MKDIR=1 \
  ROUTE_OPS_DEPLOY_MIN_FREE_MB=4096 \
  ROUTE_OPS_DEPLOY_MIN_FREE_PERCENT=20 \
  ROUTE_OPS_SMOKE_LOGIN_SECRET="unit-test-secret-not-real" \
  IMAGE_TAG="$IMAGE_TAG" \
  PRISMA_SCHEMA_SHA="$SCHEMA_SHA" \
  DELIVERY_API_IMAGE="$RUNTIME_IMAGE" \
  DELIVERY_API_MIGRATE_IMAGE="$MIGRATE_IMAGE" \
    scripts/deploy-route-ops-image.sh > "$tmp/output.log"

  grep -q "${RUNTIME_REPO}:${STALE_TAG}" "$tmp/state/removed.log"
  grep -q "${MIGRATE_REPO}:${STALE_TAG}" "$tmp/state/removed.log"
  for protected in \
    "${RUNTIME_REPO}:${CURRENT_TAG}" \
    "${MIGRATE_REPO}:${CURRENT_TAG}" \
    "${RUNTIME_IMAGE}" \
    "${MIGRATE_IMAGE}" \
    "${RUNTIME_REPO}:${ACTIVE_TAG}"; do
    if grep -q "$protected" "$tmp/state/removed.log"; then
      echo "protected image was removed: $protected" >&2
      exit 1
    fi
  done
  grep -q "DELIVERY_API_IMAGE=${RUNTIME_IMAGE}" "$tmp/.deploy/current-image.env"
  grep -q "DELIVERY_API_MIGRATE_IMAGE=${MIGRATE_IMAGE}" "$tmp/.deploy/current-image.env"
  grep -q "DELIVERY_API_IMAGE=${RUNTIME_REPO}:${CURRENT_TAG}" "$tmp/.deploy/previous-image.env"
  grep -q "DELIVERY_API_MIGRATE_IMAGE=${MIGRATE_REPO}:${CURRENT_TAG}" "$tmp/.deploy/previous-image.env"
  grep -q -- "-p clever-route" "$tmp/state/compose.log"
  grep -q "pull delivery-api delivery-api-migrate" "$tmp/state/compose.log"
  grep -q "up -d --no-build --force-recreate --no-deps caddy" "$tmp/state/compose.log"
  if grep -q "compose --env-file" "$tmp/state/docker.log"; then
    echo "compose command omitted explicit project name" >&2
    cat "$tmp/state/docker.log" >&2
    exit 1
  fi
  grep -q "Route Ops image retention cleanup finished" "$tmp/output.log"
  if grep -Eq 'system prune|volume prune|container prune' "$tmp/state/docker.log"; then
    echo "forbidden prune command was invoked" >&2
    exit 1
  fi
}

run_failure_case() {
  local tmp
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/route-ops-disk-fail.XXXXXX")"
  trap 'rm -rf "$tmp"' RETURN
  prepare_app_dir "$tmp"
  make_fake_bin "$tmp"
  mkdir -p "$tmp/state"

  if PATH="$tmp/bin:$PATH" \
    FAKE_DOCKER_STATE="$tmp/state" \
    FAKE_DOCKER_ROOT="$tmp/docker-root" \
    FAKE_DF_MODE="always-low" \
    APP_DIR="$tmp" \
    ROUTE_OPS_DEPLOY_LOCK_FORCE_MKDIR=1 \
    ROUTE_OPS_DEPLOY_MIN_FREE_MB=4096 \
    ROUTE_OPS_DEPLOY_MIN_FREE_PERCENT=20 \
    ROUTE_OPS_SMOKE_LOGIN_SECRET="unit-test-secret-not-real" \
    IMAGE_TAG="$IMAGE_TAG" \
    PRISMA_SCHEMA_SHA="$SCHEMA_SHA" \
    DELIVERY_API_IMAGE="$RUNTIME_IMAGE" \
    DELIVERY_API_MIGRATE_IMAGE="$MIGRATE_IMAGE" \
      scripts/deploy-route-ops-image.sh > "$tmp/output.log" 2>&1; then
    echo "low disk deploy unexpectedly passed" >&2
    exit 1
  fi

  grep -q "still below threshold" "$tmp/output.log"
  if [ -f "$tmp/state/compose.log" ]; then
    echo "compose mutated or pulled despite insufficient disk" >&2
    cat "$tmp/state/compose.log" >&2
    exit 1
  fi
}

run_invalid_project_case() {
  local tmp
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/route-ops-project-fail.XXXXXX")"
  trap 'rm -rf "$tmp"' RETURN
  prepare_app_dir "$tmp"
  make_fake_bin "$tmp"
  mkdir -p "$tmp/state"

  if PATH="$tmp/bin:$PATH" \
    FAKE_DOCKER_STATE="$tmp/state" \
    FAKE_DOCKER_ROOT="$tmp/docker-root" \
    FAKE_DF_MODE="recover" \
    APP_DIR="$tmp" \
    ROUTE_OPS_COMPOSE_PROJECT_NAME=compose \
    ROUTE_OPS_DEPLOY_LOCK_FORCE_MKDIR=1 \
    ROUTE_OPS_SMOKE_LOGIN_SECRET="unit-test-secret-not-real" \
    IMAGE_TAG="$IMAGE_TAG" \
    PRISMA_SCHEMA_SHA="$SCHEMA_SHA" \
    DELIVERY_API_IMAGE="$RUNTIME_IMAGE" \
    DELIVERY_API_MIGRATE_IMAGE="$MIGRATE_IMAGE" \
      scripts/deploy-route-ops-image.sh > "$tmp/output.log" 2>&1; then
    echo "invalid compose project deploy unexpectedly passed" >&2
    exit 1
  fi

  grep -q "must be exactly clever-route" "$tmp/output.log"
  if [ -f "$tmp/state/compose.log" ]; then
    echo "compose was invoked despite invalid project name" >&2
    cat "$tmp/state/compose.log" >&2
    exit 1
  fi
}

run_legacy_project_guard_case() {
  local tmp
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/route-ops-legacy-fail.XXXXXX")"
  trap 'rm -rf "$tmp"' RETURN
  prepare_app_dir "$tmp"
  make_fake_bin "$tmp"
  mkdir -p "$tmp/state"

  if PATH="$tmp/bin:$PATH" \
    FAKE_DOCKER_STATE="$tmp/state" \
    FAKE_DOCKER_ROOT="$tmp/docker-root" \
    FAKE_DF_MODE="recover" \
    FAKE_LEGACY_COMPOSE_RUNNING=1 \
    APP_DIR="$tmp" \
    ROUTE_OPS_DEPLOY_LOCK_FORCE_MKDIR=1 \
    ROUTE_OPS_SMOKE_LOGIN_SECRET="unit-test-secret-not-real" \
    IMAGE_TAG="$IMAGE_TAG" \
    PRISMA_SCHEMA_SHA="$SCHEMA_SHA" \
    DELIVERY_API_IMAGE="$RUNTIME_IMAGE" \
    DELIVERY_API_MIGRATE_IMAGE="$MIGRATE_IMAGE" \
      scripts/deploy-route-ops-image.sh > "$tmp/output.log" 2>&1; then
    echo "legacy compose project deploy unexpectedly passed" >&2
    exit 1
  fi

  grep -q "legacy implicit compose project containers are still running" "$tmp/output.log"
  grep -q "compose-postgres-1 service=postgres" "$tmp/output.log"
  if [ -f "$tmp/state/compose.log" ]; then
    echo "compose was invoked despite legacy project guard" >&2
    cat "$tmp/state/compose.log" >&2
    exit 1
  fi
}

run_success_case
run_failure_case
run_invalid_project_case
run_legacy_project_guard_case

printf '{"ok":true,"test":"deploy-route-ops-image-disk-guard"}\n'
