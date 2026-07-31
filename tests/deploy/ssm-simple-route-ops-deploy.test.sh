#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

params_path="$(DSV_MIGRATION_APPROVED=1 DSV_MIGRATION_MANIFEST_SHA256=3333333333333333333333333333333333333333333333333333333333333333 DSV_RESTORE_REHEARSAL_SHA256=4444444444444444444444444444444444444444444444444444444444444444 DSV_PRODUCTION_BASELINE_APPROVED=1 DSV_PRODUCTION_BASELINE_MANIFEST_SHA256=5555555555555555555555555555555555555555555555555555555555555555 ROUTE_OPS_SIMPLE_CHANNEL_TAG=prod-test ROUTE_OPS_RUNTIME_IMAGE=ghcr.io/evnsolution/clever-route-server-delivery-api@sha256:1111111111111111111111111111111111111111111111111111111111111111 ROUTE_OPS_WEB_STATIC_IMAGE=ghcr.io/evnsolution/clever-route-server-route-ops-web-static@sha256:2222222222222222222222222222222222222222222222222222222222222222 scripts/ssm-simple-route-ops-deploy.sh --dry-run --no-send)"
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
web_dockerfile = pathlib.Path('apps/route-ops-web/Dockerfile').read_text()
compose = pathlib.Path('infra/compose/docker-compose.prod.yml').read_text()
dry_run_idx = command.index('if [ "$DRY_RUN" = "1" ]')
forward_mutation_snippets = [
    '--profile osrm --profile vroom --profile korea pull clever-route-api vroom vroom-korea',
    '--profile osrm --profile vroom --profile korea pull route-ops-web-static',
    'run --rm clever-route-api-migrate',
    'up --no-build --force-recreate route-ops-web-static',
    'up -d --no-build --no-deps --force-recreate --remove-orphans clever-route-api',
]
checks = {
    'uses_run_shell_command': command.startswith('bash -lc '),
    'channel_rendered': 'CHANNEL_TAG=prod-test' in command,
    'digest_runtime_rendered': 'DELIVERY_API_IMAGE=ghcr.io/evnsolution/clever-route-server-delivery-api@sha256:1111111111111111111111111111111111111111111111111111111111111111' in command,
    'digest_static_rendered': 'ROUTE_OPS_WEB_STATIC_IMAGE=ghcr.io/evnsolution/clever-route-server-route-ops-web-static@sha256:2222222222222222222222222222222222222222222222222222222222222222' in command,
    'migration_evidence_rendered': 'DSV_MIGRATION_APPROVED=1' in command and 'DSV_MIGRATION_MANIFEST_SHA256=3333333333333333333333333333333333333333333333333333333333333333' in command and 'DSV_RESTORE_REHEARSAL_SHA256=4444444444444444444444444444444444444444444444444444444444444444' in command,
    'production_baseline_evidence_rendered': 'DSV_PRODUCTION_BASELINE_APPROVED=1' in command and 'DSV_PRODUCTION_BASELINE_MANIFEST_SHA256=5555555555555555555555555555555555555555555555555555555555555555' in command,
    'compose_synced_to_host': 'COMPOSE_FILE_B64=' in command and 'base64 -d > "$COMPOSE_FILE"' in command,
    'runtime_env_fails_before_synced_file_mutation': 'missing required runtime env: apps/delivery-api/.env' in command and command.index('missing required runtime env: apps/delivery-api/.env') < command.index('base64 -d > "$COMPOSE_FILE"'),
    'does_not_mutate_ingress': 'CADDYFILE_B64=' not in command and 'base64 -d > "$CADDYFILE"' not in command and 'caddy reload --config /etc/caddy/Caddyfile' not in command and 'caddy validate --config /etc/caddy/Caddyfile' not in command and '/etc/caddy/Caddyfile' not in command,
    'compose_preflight': 'docker compose -p "$COMPOSE_PROJECT" --env-file .deploy/simple-candidate-image.env' in command,
    'smoke_tries_canonical_and_legacy_urls': 'SMOKE_URLS=' in command and 'https://clever-route-api.cleversystem.ai/healthz https://clever-route.cleversystem.ai/healthz' in command and 'smoke_health()' in command,
    'dry_run_exits_before_forward_mutations': all(dry_run_idx < command.index(snippet) for snippet in forward_mutation_snippets),
    'vroom_env': 'VROOM_BASE_URL' in command and 'http://vroom:3000' in command,
    'multi_coverage_env': 'OSRM_ONTARIO_BASE_URL' in command and 'http://osrm-ontario:5000' in command and 'OSRM_KOREA_BASE_URL' in command and 'http://osrm-korea:5000' in command and 'VROOM_KOREA_BASE_URL' in command and 'http://vroom-korea:3000' in command and 'OSRM_DEFAULT_COVERAGE' in command and 'korea' in command,
    'vroom_configs_synced_to_host': 'VROOM_CONFIG_B64=' in command and 'VROOM_KOREA_CONFIG_B64=' in command and 'base64 -d > "$VROOM_KOREA_CONFIG"' in command,
    'proof_media_bootstrap': 'chown -R 100:101 /srv/clever-route-server/data/driver-proof-media' in command and 'chmod 750 /srv/clever-route-server/data/driver-proof-media' in command,
    'firebase_credential_bootstrap': 'FIREBASE_CREDENTIALS_PARAM=' in command and 'aws ssm get-parameter --name "$FIREBASE_CREDENTIALS_PARAM" --with-decryption' in command and 'chown 100:101 "$FIREBASE_CREDENTIALS_FILE"' in command and 'chmod 400 "$FIREBASE_CREDENTIALS_FILE"' in command,
    'firebase_runtime_env': "'FIREBASE_PROJECT_ID': 'clever-routes-prod'" in wrapper and "'GOOGLE_APPLICATION_CREDENTIALS': '/run/secrets/firebase-fcm.json'" in wrapper,
    'firebase_credential_mount': '/srv/clever-route-server/secrets/firebase-fcm.json:/run/secrets/firebase-fcm.json:ro' in compose,
    'compose_pull_only_on_host': '--profile osrm --profile vroom --profile korea pull clever-route-api vroom vroom-korea' in command and 'pull route-ops-web-static' in command and 'docker pull "$DELIVERY_API_IMAGE"' not in command,
    'migrate_uses_compose_service': 'run --rm clever-route-api-migrate' in command,
    'migrate_before_static_stage': command.index('run --rm clever-route-api-migrate') < command.index('simple deploy static stage required', command.index('run --rm clever-route-api-migrate')),
    'api_up_no_deps': 'up -d --no-build --no-deps --force-recreate --remove-orphans clever-route-api' in command,
    'does_not_recreate_caddy': '--force-recreate --remove-orphans clever-route-api caddy' not in command and '--force-recreate clever-route-api caddy' not in command,
    'does_not_push_prod_prev': 'backup_channel_images' not in wrapper and 'previous_image_ref' not in wrapper and 'docker tag' not in wrapper,
    'rollback_uses_previous_env': 'cp .deploy/current-image.env .deploy/simple-rollback-image.env' in command and 'rolling clever-route-api back to previous image env' in command,
    'static_missing_current_guard': 'HAD_CURRENT_IMAGE_ENV=0' in wrapper and "CURRENT_ROUTE_OPS_WEB_STATIC_IMAGE=''" in wrapper and "echo 'missing-current'" in wrapper,
    'static_non_digest_is_conservative': 'is_digest_ref()' in wrapper and "echo 'non-digest-ref'" in wrapper,
    'static_skip_logic': 'should_stage_static()' in command and 'simple deploy static stage skipped' in command and 'ROUTE_OPS_FORCE_STATIC_RESTAGE' in wrapper and "echo 'unchanged'" in wrapper and "echo 'unchanged'\n  return 1" not in wrapper,
    'static_force_logic': 'FORCE_STATIC_RESTAGE' in command and 'forceStaticRestage' in command and 'static_stage_reason="$(should_stage_static)"' in command,
    'history_append': '"lane":"simple-ssm"' in command and '"staticStage":"%s"' in command,
    'gh_write_packages_warning_only': 'does not show write:packages; continuing because docker push is the authoritative GHCR publish check' in wrapper and 'GHCR publish requires a GitHub/GHCR token with write:packages' not in wrapper,
    'workflow_uses_node24_docker_build_actions': 'uses: docker/setup-buildx-action@v4' in workflow and 'uses: docker/build-push-action@v7' in workflow,
    'workflow_requires_migration_approval_evidence': 'approve_dsv_migration:' in workflow and 'restore_rehearsal_sha256:' in workflow and 'approve_dsv_migration=true is required for a production rollout' in workflow and 'restore_rehearsal_sha256 must be 64 lowercase hex characters' in workflow,
    'workflow_exposes_one_time_production_baseline': 'approve_production_baseline:' in workflow and 'DSV_PRODUCTION_BASELINE_APPROVED:' in workflow and 'production_baseline_manifest_sha256' in workflow,
    'workflow_always_prepares_private_registry_resolution': '      - name: Login to GHCR\n        # docker/login-action' in workflow and '      - name: Set up Docker Buildx\n        uses: docker/setup-buildx-action@v4' in workflow,
    'workflow_fails_closed_when_digest_resolution_fails': 'if ! digest="$(docker buildx imagetools inspect' in workflow and '[[ "$digest" == sha256:* ]] || return 1' in workflow,
    'workflow_uses_registry_cache': 'cache-from: type=registry,ref=${{ env.DELIVERY_API_IMAGE_REPO }}:buildcache' in workflow and 'cache-to: type=registry,ref=${{ env.ROUTE_OPS_WEB_STATIC_IMAGE_REPO }}:buildcache,mode=max' in workflow,
    'workflow_publishes_sha_and_channel_tags': '${{ env.DELIVERY_API_IMAGE_REPO }}:${{ github.sha }}' in workflow and '${{ env.DELIVERY_API_IMAGE_REPO }}:${{ inputs.channel_tag }}' in workflow and '${{ env.ROUTE_OPS_WEB_STATIC_IMAGE_REPO }}:${{ github.sha }}' in workflow and '${{ env.ROUTE_OPS_WEB_STATIC_IMAGE_REPO }}:${{ inputs.channel_tag }}' in workflow,
    'workflow_uses_digest_output': 'API_DIGEST: ${{ steps.build_api.outputs.digest }}' in workflow and 'WEB_DIGEST: ${{ steps.build_web.outputs.digest }}' in workflow,
    'workflow_splits_image_scope': "grep -Eq '^(apps/delivery-api/|\\.dockerignore$)'" in workflow and "grep -Eq '^(apps/route-ops-web/|\\.dockerignore$)'" in workflow,
    'workflow_has_no_migrate_build': 'clever-route-api-migrate' not in workflow and 'target: migrate' not in workflow,
    'ssm_wait_covers_real_deploy_duration': 'SSM_WAIT_TIMEOUT_SECONDS:-1800' in wrapper and 'aws ssm wait command-executed' not in wrapper and '--query Status' in wrapper and 'sleep 5' in wrapper,
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
