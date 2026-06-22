#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

params_path="$(ROUTE_OPS_SIMPLE_CHANNEL_TAG=prod-test ROUTE_OPS_RUNTIME_IMAGE=ghcr.io/evnsolution/clever-route-server-delivery-api@sha256:1111111111111111111111111111111111111111111111111111111111111111 ROUTE_OPS_WEB_STATIC_IMAGE=ghcr.io/evnsolution/clever-route-server-route-ops-web-static@sha256:2222222222222222222222222222222222222222222222222222222222222222 scripts/ssm-simple-route-ops-deploy.sh --dry-run --no-send)"
cleanup() { rm -f "$params_path"; }
trap cleanup EXIT

python3 - "$params_path" <<'PY'
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
payload = json.loads(path.read_text())
command = payload['commands'][0]
wrapper = pathlib.Path('scripts/ssm-simple-route-ops-deploy.sh').read_text()
workflow = pathlib.Path('.github/workflows/route-ops-simple-deploy.yml').read_text()
caddyfile = pathlib.Path('infra/caddy/Caddyfile').read_text()
web_dockerfile = pathlib.Path('apps/route-ops-web/Dockerfile').read_text()
dry_run_idx = command.index('if [ "$DRY_RUN" = "1" ]')
forward_mutation_snippets = [
    '--profile osrm --profile vroom pull delivery-api vroom',
    '--profile osrm --profile vroom pull route-ops-web-static',
    'run --rm delivery-api-migrate',
    'up --no-build --force-recreate route-ops-web-static',
    'up -d --no-build --no-deps --force-recreate delivery-api',
]
checks = {
    'uses_run_shell_command': command.startswith('bash -lc '),
    'channel_rendered': 'CHANNEL_TAG=prod-test' in command,
    'digest_runtime_rendered': 'DELIVERY_API_IMAGE=ghcr.io/evnsolution/clever-route-server-delivery-api@sha256:1111111111111111111111111111111111111111111111111111111111111111' in command,
    'digest_static_rendered': 'ROUTE_OPS_WEB_STATIC_IMAGE=ghcr.io/evnsolution/clever-route-server-route-ops-web-static@sha256:2222222222222222222222222222222222222222222222222222222222222222' in command,
    'compose_synced_to_host': 'COMPOSE_FILE_B64=' in command and 'base64 -d > "$COMPOSE_FILE"' in command,
    'caddyfile_synced_and_reloaded': 'CADDYFILE_B64=' in command and 'base64 -d > "$CADDYFILE"' in command and 'caddy reload --config /etc/caddy/Caddyfile' in command,
    'caddyfile_retries_api_swap': 'lb_try_duration 30s' in caddyfile and 'lb_try_interval 500ms' in caddyfile,
    'compose_preflight': 'docker compose -p "$COMPOSE_PROJECT" --env-file .deploy/simple-candidate-image.env' in command,
    'dry_run_exits_before_forward_mutations': all(dry_run_idx < command.index(snippet) for snippet in forward_mutation_snippets),
    'vroom_env': 'VROOM_BASE_URL' in command and 'http://vroom:3000' in command,
    'proof_media_bootstrap': 'chown -R 100:101 /srv/clever-route-server/data/driver-proof-media' in command and 'chmod 750 /srv/clever-route-server/data/driver-proof-media' in command,
    'compose_pull_only_on_host': '--profile osrm --profile vroom pull delivery-api vroom' in command and 'pull route-ops-web-static' in command and 'docker pull "$DELIVERY_API_IMAGE"' not in command,
    'migrate_uses_compose_service': 'run --rm delivery-api-migrate' in command,
    'migrate_before_static_stage': command.index('run --rm delivery-api-migrate') < command.index('simple deploy static stage required', command.index('run --rm delivery-api-migrate')),
    'api_up_no_deps': 'up -d --no-build --no-deps --force-recreate delivery-api' in command,
    'does_not_recreate_caddy': '--force-recreate delivery-api caddy' not in command,
    'does_not_push_prod_prev': 'backup_channel_images' not in wrapper and 'previous_image_ref' not in wrapper and 'docker tag' not in wrapper,
    'rollback_uses_previous_env': 'cp .deploy/current-image.env .deploy/simple-rollback-image.env' in command and 'rolling delivery-api back to previous image env' in command,
    'static_missing_current_guard': 'HAD_CURRENT_IMAGE_ENV=0' in wrapper and "CURRENT_ROUTE_OPS_WEB_STATIC_IMAGE=''" in wrapper and "echo 'missing-current'" in wrapper,
    'static_non_digest_is_conservative': 'is_digest_ref()' in wrapper and "echo 'non-digest-ref'" in wrapper,
    'static_skip_logic': 'should_stage_static()' in command and 'simple deploy static stage skipped' in command and 'ROUTE_OPS_FORCE_STATIC_RESTAGE' in wrapper and "echo 'unchanged'" in wrapper and "echo 'unchanged'\n  return 1" not in wrapper,
    'static_force_logic': 'FORCE_STATIC_RESTAGE' in command and 'forceStaticRestage' in command and 'static_stage_reason="$(should_stage_static)"' in command,
    'history_append': '"lane":"simple-ssm"' in command and '"staticStage":"%s"' in command,
    'gh_write_packages_warning_only': 'does not show write:packages; continuing because docker push is the authoritative GHCR publish check' in wrapper and 'GHCR publish requires a GitHub/GHCR token with write:packages' not in wrapper,
    'workflow_uses_node24_docker_build_actions': 'uses: docker/setup-buildx-action@v4' in workflow and 'uses: docker/build-push-action@v7' in workflow,
    'workflow_uses_registry_cache': 'cache-from: type=registry,ref=${{ env.DELIVERY_API_IMAGE_REPO }}:buildcache' in workflow and 'cache-to: type=registry,ref=${{ env.ROUTE_OPS_WEB_STATIC_IMAGE_REPO }}:buildcache,mode=max' in workflow,
    'workflow_publishes_sha_and_channel_tags': '${{ env.DELIVERY_API_IMAGE_REPO }}:${{ github.sha }}' in workflow and '${{ env.DELIVERY_API_IMAGE_REPO }}:${{ inputs.channel_tag }}' in workflow and '${{ env.ROUTE_OPS_WEB_STATIC_IMAGE_REPO }}:${{ github.sha }}' in workflow and '${{ env.ROUTE_OPS_WEB_STATIC_IMAGE_REPO }}:${{ inputs.channel_tag }}' in workflow,
    'workflow_uses_digest_output': 'API_DIGEST: ${{ steps.build_api.outputs.digest }}' in workflow and 'WEB_DIGEST: ${{ steps.build_web.outputs.digest }}' in workflow,
    'workflow_splits_image_scope': "grep -Eq '^(apps/delivery-api/|\\.dockerignore$)'" in workflow and "grep -Eq '^(apps/route-ops-web/|\\.dockerignore$)'" in workflow,
    'workflow_has_no_migrate_build': 'delivery-api-migrate' not in workflow and 'target: migrate' not in workflow,
    'manual_publish_uses_buildx': 'docker buildx build --platform linux/amd64' in wrapper and '--push' in wrapper and '--provenance=false' in wrapper,
    'manual_publish_uses_registry_cache': f'--cache-from "type=registry,ref=${{STATIC_IMAGE_REPO}}:buildcache"' in wrapper and f'--cache-to "type=registry,ref=${{RUNTIME_IMAGE_REPO}}:buildcache,mode=max"' in wrapper,
    'manual_publish_requires_buildx': 'docker buildx version >/dev/null 2>&1 || fail "docker buildx is required for --publish' in wrapper,
    'manual_publish_does_not_use_legacy_builder': 'docker build --platform linux/amd64' not in wrapper and 'docker push "$image"' not in wrapper,
    'web_static_build_stage_uses_build_platform': 'FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS build' in web_dockerfile and 'FROM --platform=$TARGETPLATFORM busybox:1.37.0 AS static' in web_dockerfile,
}
missing = [name for name, ok in checks.items() if not ok]
if missing:
    raise SystemExit(f'missing expected simple deploy guard(s): {missing}')
print('{"ok":true,"wrapper":"scripts/ssm-simple-route-ops-deploy.sh"}')
PY
