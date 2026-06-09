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
STATIC_REPO="ghcr.io/evnsolution/clever-route-server-route-ops-web-static"
ROUTE_ENGINE_REPO="ghcr.io/evnsolution/route-engine-worker"
ROUTE_ENGINE_TAG="5555555555555555555555555555555555555555"
ROUTE_ENGINE_GRAPH_MANIFEST_SHA="6666666666666666666666666666666666666666666666666666666666666666"
RUNTIME_IMAGE="${RUNTIME_REPO}:${IMAGE_TAG}"
MIGRATE_IMAGE="${MIGRATE_REPO}:${IMAGE_TAG}"
STATIC_IMAGE="${STATIC_REPO}:${IMAGE_TAG}"
ROUTE_ENGINE_IMAGE="${ROUTE_ENGINE_REPO}:${ROUTE_ENGINE_TAG}"
STATIC_VOLUME="clever-route-route-ops-web-static-${IMAGE_TAG}"
CURRENT_STATIC_VOLUME="clever-route-route-ops-web-static-${CURRENT_TAG}"
PREVIOUS_STATIC_VOLUME="clever-route-route-ops-web-static-${PREVIOUS_TAG}"

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
    *:5555555555555555555555555555555555555555) echo "sha256:route-engine" ;;
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
          ghcr.io/evnsolution/clever-route-server-route-ops-web-static)
            echo "ghcr.io/evnsolution/clever-route-server-route-ops-web-static:0123456789abcdef0123456789abcdef01234567"
            echo "ghcr.io/evnsolution/clever-route-server-route-ops-web-static:1111111111111111111111111111111111111111"
            echo "ghcr.io/evnsolution/clever-route-server-route-ops-web-static:2222222222222222222222222222222222222222"
            echo "ghcr.io/evnsolution/clever-route-server-route-ops-web-static:3333333333333333333333333333333333333333"
            ;;
          ghcr.io/evnsolution/route-engine-worker)
            echo "ghcr.io/evnsolution/route-engine-worker:5555555555555555555555555555555555555555"
            echo "ghcr.io/evnsolution/route-engine-worker:3333333333333333333333333333333333333333"
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
          *'org.opencontainers.image.revision'*)
            case "$image" in
              *route-engine-worker*) echo "5555555555555555555555555555555555555555" ;;
              *) echo "0123456789abcdef0123456789abcdef01234567" ;;
            esac
            ;;
          *'org.clever-route.prisma-schema-sha'*) echo "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd" ;;
          *'org.clever-route.graph-manifest-sha'*) echo "6666666666666666666666666666666666666666666666666666666666666666" ;;
          *'org.clever-route.image-role'*)
            case "$image" in
              *delivery-api-migrate*) echo "migrate" ;;
              *route-ops-web-static*) echo "route-ops-web-static" ;;
              *route-engine-worker*) echo "route-engine-worker" ;;
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
    args="${*:2}"
    echo "compose ${args}" >> "$state/compose.log"
    env_file=""
    previous=""
    for token in "${@:2}"; do
      if [ "$previous" = "--env-file" ]; then
        env_file="$token"
        break
      fi
      previous="$token"
    done
    if [ -n "$env_file" ] && [ -f "$env_file" ]; then
      volume_line="$(grep -m1 '^ROUTE_OPS_WEB_STATIC_VOLUME=' "$env_file" || true)"
      echo "env-file ${env_file} ${volume_line}" >> "$state/compose-env.log"
    fi
    if [[ "$args" == *"up --no-build --force-recreate route-ops-web-static"* ]] && [ "${FAKE_STATIC_UP_FAIL:-0}" = "1" ]; then
      exit 17
    fi
    if [[ "$args" == *"run --rm delivery-api-migrate"* ]] && [ "${FAKE_MIGRATE_FAIL:-0}" = "1" ]; then
      exit 18
    fi
    if [[ "$args" == *"run --rm --no-deps"* && "$args" == *"ROUTE_ENGINE_READY_SMOKE_TIMEOUT_MS"* && "$args" == *"ROUTE_ENGINE_WARMUP_SMOKE_TIMEOUT_MS"* && "$args" == *"delivery-api node"* ]] && [ "${FAKE_ROUTE_ENGINE_SMOKE_FAIL:-0}" = "1" ]; then
      exit 19
    fi
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

  cat > "$tmp/bin/sha256sum" <<'EOF_SHA256SUM'
#!/usr/bin/env bash
set -euo pipefail
for file in "$@"; do
  case "$file" in
    *.parquet) printf '%s  %s\n' "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" "$file" ;;
    *.deploy/route-engine-graph-manifest.*|*/.deploy/route-engine-graph-manifest.*) printf '%s  %s\n' "6666666666666666666666666666666666666666666666666666666666666666" "$file" ;;
    *) printf '%s  %s\n' "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" "$file" ;;
  esac
done
EOF_SHA256SUM
  chmod +x "$tmp/bin/sha256sum"
}

prepare_app_dir() {
  local tmp="$1"
  mkdir -p "$tmp/.deploy" "$tmp/infra/compose" "$tmp/scripts" "$tmp/data/route-engine/parquet"
  printf 'parquet-data\n' > "$tmp/data/route-engine/parquet/nodes.parquet"
  printf 'parquet-data\n' > "$tmp/data/route-engine/parquet/routing_arcs_snapshot.parquet"
  cat > "$tmp/.deploy/current-image.env" <<EOF_CURRENT
IMAGE_TAG=${CURRENT_TAG}
DELIVERY_API_IMAGE=${RUNTIME_REPO}:${CURRENT_TAG}
DELIVERY_API_MIGRATE_IMAGE=${MIGRATE_REPO}:${CURRENT_TAG}
ROUTE_OPS_WEB_STATIC_IMAGE=${STATIC_REPO}:${CURRENT_TAG}
ROUTE_OPS_WEB_STATIC_VOLUME=${CURRENT_STATIC_VOLUME}
ROUTE_ENGINE_IMAGE=${ROUTE_ENGINE_IMAGE}
ROUTE_ENGINE_GRAPH_HOST_DIR=${tmp}/data/route-engine/parquet
PRISMA_SCHEMA_SHA=${SCHEMA_SHA}
EOF_CURRENT
  cat > "$tmp/.deploy/previous-image.env" <<EOF_PREVIOUS
IMAGE_TAG=${PREVIOUS_TAG}
DELIVERY_API_IMAGE=${RUNTIME_REPO}:${PREVIOUS_TAG}
DELIVERY_API_MIGRATE_IMAGE=${MIGRATE_REPO}:${PREVIOUS_TAG}
ROUTE_OPS_WEB_STATIC_IMAGE=${STATIC_REPO}:${PREVIOUS_TAG}
ROUTE_OPS_WEB_STATIC_VOLUME=${PREVIOUS_STATIC_VOLUME}
ROUTE_ENGINE_IMAGE=${ROUTE_ENGINE_IMAGE}
ROUTE_ENGINE_GRAPH_HOST_DIR=${tmp}/data/route-engine/parquet
PRISMA_SCHEMA_SHA=${SCHEMA_SHA}
EOF_PREVIOUS
  mkdir -p "$tmp/infra/env"
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
  ROUTE_ENGINE_IMAGE="$ROUTE_ENGINE_IMAGE" \
  ROUTE_ENGINE_GRAPH_HOST_DIR="$tmp/data/route-engine/parquet" \
    scripts/deploy-route-ops-image.sh > "$tmp/output.log"

  grep -q "${RUNTIME_REPO}:${STALE_TAG}" "$tmp/state/removed.log"
  grep -q "${MIGRATE_REPO}:${STALE_TAG}" "$tmp/state/removed.log"
  grep -q "${STATIC_REPO}:${STALE_TAG}" "$tmp/state/removed.log"
  for protected in \
    "${RUNTIME_REPO}:${CURRENT_TAG}" \
    "${MIGRATE_REPO}:${CURRENT_TAG}" \
    "${RUNTIME_IMAGE}" \
    "${MIGRATE_IMAGE}" \
    "${STATIC_IMAGE}" \
    "${ROUTE_ENGINE_IMAGE}" \
    "${RUNTIME_REPO}:${ACTIVE_TAG}"; do
    if grep -q "$protected" "$tmp/state/removed.log"; then
      echo "protected image was removed: $protected" >&2
      exit 1
    fi
  done
  grep -q "DELIVERY_API_IMAGE=${RUNTIME_IMAGE}" "$tmp/.deploy/current-image.env"
  grep -q "DELIVERY_API_MIGRATE_IMAGE=${MIGRATE_IMAGE}" "$tmp/.deploy/current-image.env"
  grep -q "ROUTE_OPS_WEB_STATIC_IMAGE=${STATIC_IMAGE}" "$tmp/.deploy/current-image.env"
  grep -q "ROUTE_OPS_WEB_STATIC_VOLUME=${STATIC_VOLUME}" "$tmp/.deploy/current-image.env"
  grep -q "ROUTE_ENGINE_IMAGE=${ROUTE_ENGINE_IMAGE}" "$tmp/.deploy/current-image.env"
  grep -q "DELIVERY_API_IMAGE=${RUNTIME_REPO}:${CURRENT_TAG}" "$tmp/.deploy/previous-image.env"
  grep -q "DELIVERY_API_MIGRATE_IMAGE=${MIGRATE_REPO}:${CURRENT_TAG}" "$tmp/.deploy/previous-image.env"
  grep -q "ROUTE_OPS_WEB_STATIC_VOLUME=${CURRENT_STATIC_VOLUME}" "$tmp/.deploy/previous-image.env"
  grep -q -- "-p clever-route" "$tmp/state/compose.log"
  grep -q -- "--profile route-engine pull route-ops-web-static delivery-api delivery-api-migrate route-engine" "$tmp/state/compose.log"
  grep -q -- "-e ROUTE_ENGINE_READY_SMOKE_TIMEOUT_MS -e ROUTE_ENGINE_WARMUP_SMOKE_TIMEOUT_MS -e ROUTE_ENGINE_SOLVE_SMOKE_TIMEOUT_MS delivery-api node" "$tmp/state/compose.log"
  grep -q "Smoking route_engine from the delivery-api runtime network: readyTimeoutMs=5000 warmupTimeoutMs=180000 solveTimeoutMs=120000" "$tmp/output.log"
  grep -q "up --no-build --force-recreate route-ops-web-static" "$tmp/state/compose.log"
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

run_headroom_ok_still_prunes_before_pull_case() {
  local tmp
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/route-ops-disk-headroom-ok.XXXXXX")"
  trap 'rm -rf "$tmp"' RETURN
  prepare_app_dir "$tmp"
  make_fake_bin "$tmp"
  mkdir -p "$tmp/state"

  PATH="$tmp/bin:$PATH" \
  FAKE_DOCKER_STATE="$tmp/state" \
  FAKE_DOCKER_ROOT="$tmp/docker-root" \
  FAKE_DF_MODE="always-ok" \
  APP_DIR="$tmp" \
  ROUTE_OPS_DEPLOY_LOCK_FORCE_MKDIR=1 \
  ROUTE_OPS_DEPLOY_MIN_FREE_MB=4096 \
  ROUTE_OPS_DEPLOY_MIN_FREE_PERCENT=20 \
  ROUTE_OPS_SMOKE_LOGIN_SECRET="unit-test-secret-not-real" \
  IMAGE_TAG="$IMAGE_TAG" \
  PRISMA_SCHEMA_SHA="$SCHEMA_SHA" \
  DELIVERY_API_IMAGE="$RUNTIME_IMAGE" \
  DELIVERY_API_MIGRATE_IMAGE="$MIGRATE_IMAGE" \
  ROUTE_ENGINE_IMAGE="$ROUTE_ENGINE_IMAGE" \
  ROUTE_ENGINE_GRAPH_HOST_DIR="$tmp/data/route-engine/parquet" \
    scripts/deploy-route-ops-image.sh > "$tmp/output.log"

  grep -q "${RUNTIME_REPO}:${STALE_TAG}" "$tmp/state/removed.log"
  grep -q "${MIGRATE_REPO}:${STALE_TAG}" "$tmp/state/removed.log"
  grep -q "${STATIC_REPO}:${STALE_TAG}" "$tmp/state/removed.log"
  grep -q "Route Ops image retention cleanup finished" "$tmp/output.log"

  local pull_line
  pull_line="$(grep -n "docker compose .* --profile route-engine pull route-ops-web-static delivery-api delivery-api-migrate route-engine" "$tmp/state/docker.log" | head -n1 | cut -d: -f1)"
  if [ -z "$pull_line" ]; then
    echo "docker compose pull was not recorded" >&2
    cat "$tmp/state/docker.log" >&2
    exit 1
  fi

  for stale_image in \
    "${RUNTIME_REPO}:${STALE_TAG}" \
    "${MIGRATE_REPO}:${STALE_TAG}" \
    "${STATIC_REPO}:${STALE_TAG}"; do
    local prune_line
    prune_line="$(grep -n "docker image rm ${stale_image}" "$tmp/state/docker.log" | head -n1 | cut -d: -f1)"
    if [ -z "$prune_line" ]; then
      echo "stale image was not pruned: $stale_image" >&2
      cat "$tmp/state/docker.log" >&2
      exit 1
    fi
    if [ "$prune_line" -ge "$pull_line" ]; then
      echo "stale image was pruned after pull instead of before pull: $stale_image" >&2
      cat "$tmp/state/docker.log" >&2
      exit 1
    fi
  done

  for protected in \
    "${RUNTIME_REPO}:${CURRENT_TAG}" \
    "${MIGRATE_REPO}:${CURRENT_TAG}" \
    "${RUNTIME_IMAGE}" \
    "${MIGRATE_IMAGE}" \
    "${STATIC_IMAGE}" \
    "${ROUTE_ENGINE_IMAGE}" \
    "${RUNTIME_REPO}:${ACTIVE_TAG}"; do
    if grep -q "$protected" "$tmp/state/removed.log"; then
      echo "protected image was removed: $protected" >&2
      exit 1
    fi
  done
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
    ROUTE_ENGINE_IMAGE="$ROUTE_ENGINE_IMAGE" \
    ROUTE_ENGINE_GRAPH_HOST_DIR="$tmp/data/route-engine/parquet" \
    ROUTE_OPS_WEB_STATIC_IMAGE="$STATIC_IMAGE" \
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
    ROUTE_ENGINE_IMAGE="$ROUTE_ENGINE_IMAGE" \
    ROUTE_ENGINE_GRAPH_HOST_DIR="$tmp/data/route-engine/parquet" \
    ROUTE_OPS_WEB_STATIC_IMAGE="$STATIC_IMAGE" \
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
    ROUTE_ENGINE_IMAGE="$ROUTE_ENGINE_IMAGE" \
    ROUTE_ENGINE_GRAPH_HOST_DIR="$tmp/data/route-engine/parquet" \
    ROUTE_OPS_WEB_STATIC_IMAGE="$STATIC_IMAGE" \
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

run_legacy_rollback_metadata_case() {
  local tmp
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/route-ops-rollback-legacy.XXXXXX")"
  trap 'rm -rf "$tmp"' RETURN
  prepare_app_dir "$tmp"
  make_fake_bin "$tmp"
  mkdir -p "$tmp/state"

  grep -v '^ROUTE_OPS_WEB_STATIC_IMAGE=' "$tmp/.deploy/previous-image.env" > "$tmp/.deploy/previous-image.env.legacy"
  mv "$tmp/.deploy/previous-image.env.legacy" "$tmp/.deploy/previous-image.env"
  grep -v '^ROUTE_OPS_WEB_STATIC_VOLUME=' "$tmp/.deploy/previous-image.env" > "$tmp/.deploy/previous-image.env.legacy"
  mv "$tmp/.deploy/previous-image.env.legacy" "$tmp/.deploy/previous-image.env"

  PATH="$tmp/bin:$PATH" \
  FAKE_DOCKER_STATE="$tmp/state" \
  FAKE_DOCKER_ROOT="$tmp/docker-root" \
  APP_DIR="$tmp" \
  ROUTE_OPS_DEPLOY_LOCK_FORCE_MKDIR=1 \
  ROUTE_OPS_SMOKE_LOGIN_SECRET="unit-test-secret-not-real" \
    scripts/rollback-route-ops-image.sh > "$tmp/output.log"

  grep -q "ROUTE_OPS_WEB_STATIC_IMAGE=${STATIC_REPO}:${PREVIOUS_TAG}" "$tmp/.deploy/current-image.env"
  grep -q "ROUTE_OPS_WEB_STATIC_VOLUME=${PREVIOUS_STATIC_VOLUME}" "$tmp/.deploy/current-image.env"
  grep -q "ROUTE_ENGINE_IMAGE=${ROUTE_ENGINE_IMAGE}" "$tmp/.deploy/current-image.env"
  grep -q -- "--profile route-engine pull route-ops-web-static delivery-api delivery-api-migrate route-engine" "$tmp/state/compose.log"
  grep -q "up --no-build --force-recreate route-ops-web-static" "$tmp/state/compose.log"
  grep -q '"routeOpsWebStaticImage":"'"${STATIC_REPO}:${PREVIOUS_TAG}"'"' "$tmp/.deploy/deploy-history.jsonl"
  grep -q '"routeOpsWebStaticVolume":"'"${PREVIOUS_STATIC_VOLUME}"'"' "$tmp/.deploy/deploy-history.jsonl"
  grep -q '"routeEngineImage":"'"${ROUTE_ENGINE_IMAGE}"'"' "$tmp/.deploy/deploy-history.jsonl"
  if grep -q "Rollback failed before Route Ops service mutation" "$tmp/output.log"; then
    echo "legacy rollback unexpectedly skipped service mutation" >&2
    exit 1
  fi
}


run_deploy_static_failure_restores_current_static_case() {
  local tmp
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/route-ops-deploy-static-fail.XXXXXX")"
  trap 'rm -rf "$tmp"' RETURN
  prepare_app_dir "$tmp"
  make_fake_bin "$tmp"
  mkdir -p "$tmp/state"

  if PATH="$tmp/bin:$PATH"     FAKE_DOCKER_STATE="$tmp/state"     FAKE_DOCKER_ROOT="$tmp/docker-root"     FAKE_DF_MODE="recover"     FAKE_STATIC_UP_FAIL=1     APP_DIR="$tmp"     ROUTE_OPS_DEPLOY_LOCK_FORCE_MKDIR=1     ROUTE_OPS_SMOKE_LOGIN_SECRET="unit-test-secret-not-real"     IMAGE_TAG="$IMAGE_TAG"     PRISMA_SCHEMA_SHA="$SCHEMA_SHA"     DELIVERY_API_IMAGE="$RUNTIME_IMAGE"     DELIVERY_API_MIGRATE_IMAGE="$MIGRATE_IMAGE"     ROUTE_ENGINE_IMAGE="$ROUTE_ENGINE_IMAGE"     ROUTE_ENGINE_GRAPH_HOST_DIR="$tmp/data/route-engine/parquet"     ROUTE_OPS_WEB_STATIC_IMAGE="$STATIC_IMAGE"       scripts/deploy-route-ops-image.sh > "$tmp/output.log" 2>&1; then
    echo "deploy static failure unexpectedly passed" >&2
    exit 1
  fi

  grep -q -- "--env-file .deploy/candidate-image.env .*up --no-build --force-recreate route-ops-web-static" "$tmp/state/compose.log"
  grep -q "env-file .deploy/candidate-image.env ROUTE_OPS_WEB_STATIC_VOLUME=${STATIC_VOLUME}" "$tmp/state/compose-env.log"
  grep -q "ROUTE_OPS_WEB_STATIC_VOLUME=${CURRENT_STATIC_VOLUME}" "$tmp/.deploy/current-image.env"
  if grep -q -- "--env-file .deploy/current-image.env .*up --no-build --force-recreate route-ops-web-static" "$tmp/state/compose.log"; then
    echo "current static volume was rewritten even though candidate static is isolated by SHA volume" >&2
    cat "$tmp/state/compose.log" >&2
    exit 1
  fi
  if grep -q "up -d --no-build --force-recreate --no-deps delivery-api" "$tmp/state/compose.log"; then
    echo "delivery-api was restored or recreated after static-only deploy failure" >&2
    cat "$tmp/state/compose.log" >&2
    exit 1
  fi
}

run_deploy_migrate_failure_restores_current_static_case() {
  local tmp
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/route-ops-deploy-migrate-fail.XXXXXX")"
  trap 'rm -rf "$tmp"' RETURN
  prepare_app_dir "$tmp"
  make_fake_bin "$tmp"
  mkdir -p "$tmp/state"

  if PATH="$tmp/bin:$PATH"     FAKE_DOCKER_STATE="$tmp/state"     FAKE_DOCKER_ROOT="$tmp/docker-root"     FAKE_DF_MODE="recover"     FAKE_MIGRATE_FAIL=1     APP_DIR="$tmp"     ROUTE_OPS_DEPLOY_LOCK_FORCE_MKDIR=1     ROUTE_OPS_SMOKE_LOGIN_SECRET="unit-test-secret-not-real"     IMAGE_TAG="$IMAGE_TAG"     PRISMA_SCHEMA_SHA="$SCHEMA_SHA"     DELIVERY_API_IMAGE="$RUNTIME_IMAGE"     DELIVERY_API_MIGRATE_IMAGE="$MIGRATE_IMAGE"     ROUTE_ENGINE_IMAGE="$ROUTE_ENGINE_IMAGE"     ROUTE_ENGINE_GRAPH_HOST_DIR="$tmp/data/route-engine/parquet"     ROUTE_OPS_WEB_STATIC_IMAGE="$STATIC_IMAGE"       scripts/deploy-route-ops-image.sh > "$tmp/output.log" 2>&1; then
    echo "deploy migrate failure unexpectedly passed" >&2
    exit 1
  fi

  grep -q -- "--env-file .deploy/candidate-image.env .*run --rm delivery-api-migrate" "$tmp/state/compose.log"
  grep -q "env-file .deploy/candidate-image.env ROUTE_OPS_WEB_STATIC_VOLUME=${STATIC_VOLUME}" "$tmp/state/compose-env.log"
  grep -q "ROUTE_OPS_WEB_STATIC_VOLUME=${CURRENT_STATIC_VOLUME}" "$tmp/.deploy/current-image.env"
  if grep -q -- "--env-file .deploy/current-image.env .*up --no-build --force-recreate route-ops-web-static" "$tmp/state/compose.log"; then
    echo "current static volume was rewritten after candidate migration failure" >&2
    cat "$tmp/state/compose.log" >&2
    exit 1
  fi
  if grep -q "up -d --no-build --force-recreate --no-deps delivery-api" "$tmp/state/compose.log"; then
    echo "delivery-api was restored or recreated before backend mutation" >&2
    cat "$tmp/state/compose.log" >&2
    exit 1
  fi
}

run_deploy_route_engine_smoke_failure_restores_host_env_case() {
  local tmp
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/route-ops-deploy-route-engine-fail.XXXXXX")"
  trap 'rm -rf "$tmp"' RETURN
  prepare_app_dir "$tmp"
  make_fake_bin "$tmp"
  mkdir -p "$tmp/state"
  cat > "$tmp/infra/env/delivery-api.env" <<'EOF_ENV'
OSRM_BASE_URL=http://osrm-ontario:5000
OSRM_TIMEOUT_MS=10000
EOF_ENV

  if PATH="$tmp/bin:$PATH" \
    FAKE_DOCKER_STATE="$tmp/state" \
    FAKE_DOCKER_ROOT="$tmp/docker-root" \
    FAKE_DF_MODE="recover" \
    FAKE_ROUTE_ENGINE_SMOKE_FAIL=1 \
    APP_DIR="$tmp" \
    ROUTE_OPS_DEPLOY_LOCK_FORCE_MKDIR=1 \
    ROUTE_OPS_SMOKE_LOGIN_SECRET="unit-test-secret-not-real" \
    IMAGE_TAG="$IMAGE_TAG" \
    PRISMA_SCHEMA_SHA="$SCHEMA_SHA" \
    DELIVERY_API_IMAGE="$RUNTIME_IMAGE" \
    DELIVERY_API_MIGRATE_IMAGE="$MIGRATE_IMAGE" \
    ROUTE_ENGINE_IMAGE="$ROUTE_ENGINE_IMAGE" \
    ROUTE_ENGINE_GRAPH_HOST_DIR="$tmp/data/route-engine/parquet" \
    ROUTE_OPS_WEB_STATIC_IMAGE="$STATIC_IMAGE" \
      scripts/deploy-route-ops-image.sh > "$tmp/output.log" 2>&1; then
    echo "deploy route_engine smoke failure unexpectedly passed" >&2
    exit 1
  fi

  grep -q "Deploy failed after route_engine service mutation but before Route Ops backend mutation; stopping route_engine" "$tmp/output.log"
  grep -q -- "--env-file .deploy/candidate-image.env .*--profile route-engine stop route-engine" "$tmp/state/compose.log"
  grep -q '^OSRM_BASE_URL=http://osrm-ontario:5000$' "$tmp/infra/env/delivery-api.env"
  grep -q '^OSRM_TIMEOUT_MS=10000$' "$tmp/infra/env/delivery-api.env"
  if grep -q '^ROUTE_ENGINE_' "$tmp/infra/env/delivery-api.env"; then
    echo "route_engine env leaked after smoke failure" >&2
    cat "$tmp/infra/env/delivery-api.env" >&2
    exit 1
  fi
  if grep -q "up -d --no-build --force-recreate --no-deps delivery-api" "$tmp/state/compose.log"; then
    echo "delivery-api was mutated after route_engine smoke failure" >&2
    cat "$tmp/state/compose.log" >&2
    exit 1
  fi
}

run_rollback_static_failure_restores_current_static_case() {
  local tmp
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/route-ops-rollback-static-fail.XXXXXX")"
  trap 'rm -rf "$tmp"' RETURN
  prepare_app_dir "$tmp"
  make_fake_bin "$tmp"
  mkdir -p "$tmp/state"

  if PATH="$tmp/bin:$PATH"     FAKE_DOCKER_STATE="$tmp/state"     FAKE_DOCKER_ROOT="$tmp/docker-root"     FAKE_STATIC_UP_FAIL=1     APP_DIR="$tmp"     ROUTE_OPS_DEPLOY_LOCK_FORCE_MKDIR=1     ROUTE_OPS_SMOKE_LOGIN_SECRET="unit-test-secret-not-real"       scripts/rollback-route-ops-image.sh > "$tmp/output.log" 2>&1; then
    echo "rollback static failure unexpectedly passed" >&2
    exit 1
  fi

  grep -q -- "--env-file .deploy/candidate-image.env .*up --no-build --force-recreate route-ops-web-static" "$tmp/state/compose.log"
  grep -q "env-file .deploy/candidate-image.env ROUTE_OPS_WEB_STATIC_VOLUME=${PREVIOUS_STATIC_VOLUME}" "$tmp/state/compose-env.log"
  grep -q "ROUTE_OPS_WEB_STATIC_VOLUME=${CURRENT_STATIC_VOLUME}" "$tmp/.deploy/rollback-from-image.env"
  if grep -q -- "--env-file .deploy/rollback-from-image.env .*up --no-build --force-recreate route-ops-web-static" "$tmp/state/compose.log"; then
    echo "pre-rollback static volume was rewritten even though rollback candidate is isolated by SHA volume" >&2
    cat "$tmp/state/compose.log" >&2
    exit 1
  fi
  if grep -q "up -d --no-build --force-recreate --no-deps delivery-api" "$tmp/state/compose.log"; then
    echo "delivery-api was restored or recreated after static-only rollback failure" >&2
    cat "$tmp/state/compose.log" >&2
    exit 1
  fi
}

run_rollback_migrate_failure_restores_current_static_case() {
  local tmp
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/route-ops-rollback-migrate-fail.XXXXXX")"
  trap 'rm -rf "$tmp"' RETURN
  prepare_app_dir "$tmp"
  make_fake_bin "$tmp"
  mkdir -p "$tmp/state"

  if PATH="$tmp/bin:$PATH"     FAKE_DOCKER_STATE="$tmp/state"     FAKE_DOCKER_ROOT="$tmp/docker-root"     FAKE_MIGRATE_FAIL=1     APP_DIR="$tmp"     ROUTE_OPS_DEPLOY_LOCK_FORCE_MKDIR=1     ROUTE_OPS_SMOKE_LOGIN_SECRET="unit-test-secret-not-real"       scripts/rollback-route-ops-image.sh > "$tmp/output.log" 2>&1; then
    echo "rollback migrate failure unexpectedly passed" >&2
    exit 1
  fi

  grep -q -- "--env-file .deploy/candidate-image.env .*run --rm delivery-api-migrate" "$tmp/state/compose.log"
  grep -q "env-file .deploy/candidate-image.env ROUTE_OPS_WEB_STATIC_VOLUME=${PREVIOUS_STATIC_VOLUME}" "$tmp/state/compose-env.log"
  grep -q "ROUTE_OPS_WEB_STATIC_VOLUME=${CURRENT_STATIC_VOLUME}" "$tmp/.deploy/rollback-from-image.env"
  if grep -q -- "--env-file .deploy/rollback-from-image.env .*up --no-build --force-recreate route-ops-web-static" "$tmp/state/compose.log"; then
    echo "pre-rollback static volume was rewritten after rollback migration failure" >&2
    cat "$tmp/state/compose.log" >&2
    exit 1
  fi
  if grep -q "up -d --no-build --force-recreate --no-deps delivery-api" "$tmp/state/compose.log"; then
    echo "delivery-api was restored or recreated before rollback backend mutation" >&2
    cat "$tmp/state/compose.log" >&2
    exit 1
  fi
}

run_deploy_rejects_shared_current_static_volume_case() {
  local tmp
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/route-ops-deploy-shared-volume.XXXXXX")"
  trap 'rm -rf "$tmp"' RETURN
  prepare_app_dir "$tmp"
  make_fake_bin "$tmp"
  mkdir -p "$tmp/state"

  if PATH="$tmp/bin:$PATH"     FAKE_DOCKER_STATE="$tmp/state"     FAKE_DOCKER_ROOT="$tmp/docker-root"     FAKE_DF_MODE="recover"     APP_DIR="$tmp"     ROUTE_OPS_DEPLOY_LOCK_FORCE_MKDIR=1     ROUTE_OPS_SMOKE_LOGIN_SECRET="unit-test-secret-not-real"     IMAGE_TAG="$IMAGE_TAG"     PRISMA_SCHEMA_SHA="$SCHEMA_SHA"     DELIVERY_API_IMAGE="$RUNTIME_IMAGE"     DELIVERY_API_MIGRATE_IMAGE="$MIGRATE_IMAGE"     ROUTE_ENGINE_IMAGE="$ROUTE_ENGINE_IMAGE"     ROUTE_ENGINE_GRAPH_HOST_DIR="$tmp/data/route-engine/parquet"     ROUTE_OPS_WEB_STATIC_IMAGE="$STATIC_IMAGE"     ROUTE_OPS_WEB_STATIC_VOLUME="$CURRENT_STATIC_VOLUME"       scripts/deploy-route-ops-image.sh > "$tmp/output.log" 2>&1; then
    echo "deploy with shared current static volume unexpectedly passed" >&2
    exit 1
  fi

  grep -q "ROUTE_OPS_WEB_STATIC_VOLUME must be ${STATIC_VOLUME}" "$tmp/output.log"
  if [ -f "$tmp/state/compose.log" ]; then
    echo "compose was invoked despite invalid static volume" >&2
    cat "$tmp/state/compose.log" >&2
    exit 1
  fi
}

run_deploy_rejects_mismatched_static_image_case() {
  local tmp
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/route-ops-deploy-bad-static-image.XXXXXX")"
  trap 'rm -rf "$tmp"' RETURN
  prepare_app_dir "$tmp"
  make_fake_bin "$tmp"
  mkdir -p "$tmp/state"

  if PATH="$tmp/bin:$PATH"     FAKE_DOCKER_STATE="$tmp/state"     FAKE_DOCKER_ROOT="$tmp/docker-root"     FAKE_DF_MODE="recover"     APP_DIR="$tmp"     ROUTE_OPS_DEPLOY_LOCK_FORCE_MKDIR=1     ROUTE_OPS_SMOKE_LOGIN_SECRET="unit-test-secret-not-real"     IMAGE_TAG="$IMAGE_TAG"     PRISMA_SCHEMA_SHA="$SCHEMA_SHA"     DELIVERY_API_IMAGE="$RUNTIME_IMAGE"     DELIVERY_API_MIGRATE_IMAGE="$MIGRATE_IMAGE"     ROUTE_ENGINE_IMAGE="$ROUTE_ENGINE_IMAGE"     ROUTE_ENGINE_GRAPH_HOST_DIR="$tmp/data/route-engine/parquet"     ROUTE_OPS_WEB_STATIC_IMAGE="${STATIC_REPO}:${CURRENT_TAG}"     ROUTE_OPS_WEB_STATIC_VOLUME="$STATIC_VOLUME"       scripts/deploy-route-ops-image.sh > "$tmp/output.log" 2>&1; then
    echo "deploy with mismatched static image unexpectedly passed" >&2
    exit 1
  fi

  grep -q "ROUTE_OPS_WEB_STATIC_IMAGE must match IMAGE_TAG" "$tmp/output.log"
  if [ -f "$tmp/state/compose.log" ]; then
    echo "compose was invoked despite mismatched static image" >&2
    cat "$tmp/state/compose.log" >&2
    exit 1
  fi
}

run_rollback_rejects_shared_current_static_volume_case() {
  local tmp
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/route-ops-rollback-shared-volume.XXXXXX")"
  trap 'rm -rf "$tmp"' RETURN
  prepare_app_dir "$tmp"
  make_fake_bin "$tmp"
  mkdir -p "$tmp/state"
  # Simulate poisoned previous metadata that would stage rollback static into the current backend's volume.
  perl -0pi -e 's/ROUTE_OPS_WEB_STATIC_VOLUME=clever-route-route-ops-web-static-2222222222222222222222222222222222222222/ROUTE_OPS_WEB_STATIC_VOLUME=clever-route-route-ops-web-static-1111111111111111111111111111111111111111/' "$tmp/.deploy/previous-image.env"

  if PATH="$tmp/bin:$PATH"     FAKE_DOCKER_STATE="$tmp/state"     FAKE_DOCKER_ROOT="$tmp/docker-root"     APP_DIR="$tmp"     ROUTE_OPS_DEPLOY_LOCK_FORCE_MKDIR=1     ROUTE_OPS_SMOKE_LOGIN_SECRET="unit-test-secret-not-real"       scripts/rollback-route-ops-image.sh > "$tmp/output.log" 2>&1; then
    echo "rollback with shared current static volume unexpectedly passed" >&2
    exit 1
  fi

  grep -q "ROUTE_OPS_WEB_STATIC_VOLUME must be ${PREVIOUS_STATIC_VOLUME}" "$tmp/output.log"
  if [ -f "$tmp/state/compose.log" ]; then
    echo "compose was invoked despite invalid rollback static volume" >&2
    cat "$tmp/state/compose.log" >&2
    exit 1
  fi
}
run_success_case
run_headroom_ok_still_prunes_before_pull_case
run_failure_case
run_invalid_project_case
run_legacy_project_guard_case
run_legacy_rollback_metadata_case
run_deploy_rejects_shared_current_static_volume_case
run_deploy_rejects_mismatched_static_image_case
run_rollback_rejects_shared_current_static_volume_case
run_deploy_static_failure_restores_current_static_case
run_deploy_migrate_failure_restores_current_static_case
run_deploy_route_engine_smoke_failure_restores_host_env_case
run_rollback_static_failure_restores_current_static_case
run_rollback_migrate_failure_restores_current_static_case

printf '{"ok":true,"test":"deploy-route-ops-image-disk-guard"}\n'
