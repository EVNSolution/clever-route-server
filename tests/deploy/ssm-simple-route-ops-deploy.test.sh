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
checks = {
    'uses_run_shell_command': command.startswith('bash -lc '),
    'channel_rendered': 'CHANNEL_TAG=prod-test' in command,
    'digest_runtime_rendered': 'DELIVERY_API_IMAGE=ghcr.io/evnsolution/clever-route-server-delivery-api@sha256:1111111111111111111111111111111111111111111111111111111111111111' in command,
    'digest_static_rendered': 'ROUTE_OPS_WEB_STATIC_IMAGE=ghcr.io/evnsolution/clever-route-server-route-ops-web-static@sha256:2222222222222222222222222222222222222222222222222222222222222222' in command,
    'compose_synced_to_host': 'COMPOSE_FILE_B64=' in command and 'base64 -d > "$COMPOSE_FILE"' in command,
    'compose_preflight': 'docker compose -p "$COMPOSE_PROJECT" --env-file .deploy/simple-candidate-image.env' in command,
    'dry_run_exits_before_pull': command.index('if [ "$DRY_RUN" = "1" ]') < command.index('--profile osrm --profile vroom pull delivery-api route-ops-web-static vroom'),
    'vroom_env': 'VROOM_BASE_URL' in command and 'http://vroom:3000' in command and 'ROUTE_ENGINE_BASE_URL' in command,
    'proof_media_bootstrap': 'chown -R 100:101 /srv/clever-route-server/data/driver-proof-media' in command and 'chmod 750 /srv/clever-route-server/data/driver-proof-media' in command,
    'compose_pull_only_on_host': '--profile osrm --profile vroom pull delivery-api route-ops-web-static vroom' in command and 'docker pull "$DELIVERY_API_IMAGE"' not in command,
    'migrate_uses_compose_service': 'run --rm delivery-api-migrate' in command,
    'migrate_before_static_stage': command.index('run --rm delivery-api-migrate') < command.index('up --no-build --force-recreate route-ops-web-static', command.index('run --rm delivery-api-migrate')),
    'api_up_no_deps': 'up -d --no-build --no-deps --force-recreate delivery-api' in command,
    'route_engine_stop': '--profile route-engine stop route-engine' in command,
    'does_not_recreate_caddy': '--force-recreate delivery-api caddy' not in command,
    'does_not_push_prod_prev': 'backup_channel_images' not in wrapper and 'previous_image_ref' not in wrapper and 'docker tag' not in wrapper,
    'rollback_uses_previous_env': 'cp .deploy/current-image.env .deploy/simple-rollback-image.env' in command and 'rolling delivery-api back to previous image env' in command,
    'history_append': '"lane":"simple-ssm"' in command,
    'workflow_uses_build_push_v6': 'uses: docker/build-push-action@v6' in workflow,
    'workflow_uses_registry_cache': 'cache-from: type=registry,ref=${{ env.DELIVERY_API_IMAGE_REPO }}:buildcache' in workflow and 'cache-to: type=registry,ref=${{ env.ROUTE_OPS_WEB_STATIC_IMAGE_REPO }}:buildcache,mode=max' in workflow,
    'workflow_publishes_sha_and_channel_tags': '${{ env.DELIVERY_API_IMAGE_REPO }}:${{ github.sha }}' in workflow and '${{ env.DELIVERY_API_IMAGE_REPO }}:${{ inputs.channel_tag }}' in workflow and '${{ env.ROUTE_OPS_WEB_STATIC_IMAGE_REPO }}:${{ github.sha }}' in workflow and '${{ env.ROUTE_OPS_WEB_STATIC_IMAGE_REPO }}:${{ inputs.channel_tag }}' in workflow,
    'workflow_uses_digest_output': 'API_DIGEST: ${{ steps.build_api.outputs.digest }}' in workflow and 'WEB_DIGEST: ${{ steps.build_web.outputs.digest }}' in workflow,
    'workflow_splits_image_scope': "grep -Eq '^(apps/delivery-api/|\\.dockerignore$)'" in workflow and "grep -Eq '^(apps/route-ops-web/|\\.dockerignore$)'" in workflow,
    'workflow_has_no_migrate_build': 'delivery-api-migrate' not in workflow and 'target: migrate' not in workflow,
}
missing = [name for name, ok in checks.items() if not ok]
if missing:
    raise SystemExit(f'missing expected simple deploy guard(s): {missing}')
print('{"ok":true,"wrapper":"scripts/ssm-simple-route-ops-deploy.sh"}')
PY
