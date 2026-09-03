#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

params_path="$(DSV_MIGRATION_APPROVED=1 DSV_MIGRATION_MANIFEST_SHA256=3333333333333333333333333333333333333333333333333333333333333333 DSV_RESTORE_REHEARSAL_SHA256=4444444444444444444444444444444444444444444444444444444444444444 DSV_PRODUCTION_BASELINE_APPROVED=1 DSV_PRODUCTION_BASELINE_MANIFEST_SHA256=5555555555555555555555555555555555555555555555555555555555555555 ROUTE_OPS_UVIS_ENV_PARAM=/clever/route-ops/uvis/runtime-env ROUTE_OPS_SIMPLE_CHANNEL_TAG=prod-test ROUTE_OPS_RUNTIME_IMAGE=ghcr.io/evnsolution/clever-route-server-delivery-api@sha256:1111111111111111111111111111111111111111111111111111111111111111 ROUTE_OPS_MIGRATION_IMAGE=ghcr.io/evnsolution/clever-route-server-delivery-api-migration@sha256:6666666666666666666666666666666666666666666666666666666666666666 ROUTE_OPS_WEB_STATIC_IMAGE=ghcr.io/evnsolution/clever-route-server-route-ops-web-static@sha256:2222222222222222222222222222222222222222222222222222222222222222 scripts/ssm-simple-route-ops-deploy.sh --dry-run --no-send)"
shopify_params_path="$(ROUTE_OPS_RUN_MIGRATIONS=0 ROUTE_OPS_SIMPLE_CHANNEL_TAG=prod-test ROUTE_OPS_RUNTIME_IMAGE=ghcr.io/evnsolution/clever-route-server-delivery-api@sha256:1111111111111111111111111111111111111111111111111111111111111111 ROUTE_OPS_MIGRATION_IMAGE=ghcr.io/evnsolution/clever-route-server-delivery-api-migration@sha256:6666666666666666666666666666666666666666666666666666666666666666 ROUTE_OPS_WEB_STATIC_IMAGE=ghcr.io/evnsolution/clever-route-server-route-ops-web-static@sha256:2222222222222222222222222222222222222222222222222222222222222222 scripts/ssm-simple-route-ops-deploy.sh --dry-run --no-send)"
proof_ready_contract_sha="$(shasum -a 256 apps/delivery-api/tests/driver-proof-media-read-inventory.test.ts apps/delivery-api/tests/dsv-v1-read-query.service.test.ts | shasum -a 256 | awk '{print $1}')"
cleanup() { rm -f "$params_path" "$shopify_params_path"; }
trap cleanup EXIT

python3 - "$params_path" "$shopify_params_path" "$proof_ready_contract_sha" <<'PY'
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
shopify_path = pathlib.Path(sys.argv[2])
proof_ready_contract_sha = sys.argv[3]
payload = json.loads(path.read_text())
command = payload['commands'][0]
shopify_command = json.loads(shopify_path.read_text())['commands'][0]
wrapper = pathlib.Path('scripts/ssm-simple-route-ops-deploy.sh').read_text()
workflow = pathlib.Path('.github/workflows/route-ops-simple-deploy.yml').read_text()
ci_workflow = pathlib.Path('.github/workflows/ci.yml').read_text()
web_dockerfile = pathlib.Path('apps/route-ops-web/Dockerfile').read_text()
compose = pathlib.Path('infra/compose/docker-compose.prod.yml').read_text()
dry_run_idx = command.index('if [ "$DRY_RUN" = "1" ]')
forward_mutation_snippets = [
    '--profile osrm --profile vroom --profile korea pull clever-route-api vroom vroom-korea',
    'pull clever-route-api-migrate',
    '--profile osrm --profile vroom --profile korea pull route-ops-web-static',
    'run --rm --no-deps clever-route-api node dist/scripts/audit-custom-route-order-ownership.js',
    'run --rm clever-route-api-migrate',
    'up --no-build --force-recreate route-ops-web-static',
    'up -d --no-build --no-deps --force-recreate --remove-orphans clever-route-api',
]
checks = {
    'uses_run_shell_command': command.startswith('bash -lc '),
    'channel_rendered': 'CHANNEL_TAG=prod-test' in command,
    'digest_runtime_rendered': 'DELIVERY_API_IMAGE=ghcr.io/evnsolution/clever-route-server-delivery-api@sha256:1111111111111111111111111111111111111111111111111111111111111111' in command,
    'digest_migration_rendered': 'DELIVERY_API_MIGRATION_IMAGE=ghcr.io/evnsolution/clever-route-server-delivery-api-migration@sha256:6666666666666666666666666666666666666666666666666666666666666666' in command,
    'digest_static_rendered': 'ROUTE_OPS_WEB_STATIC_IMAGE=ghcr.io/evnsolution/clever-route-server-route-ops-web-static@sha256:2222222222222222222222222222222222222222222222222222222222222222' in command,
    'migration_evidence_rendered': 'DSV_MIGRATION_APPROVED=1' in command and 'DSV_MIGRATION_MANIFEST_SHA256=3333333333333333333333333333333333333333333333333333333333333333' in command and 'DSV_RESTORE_REHEARSAL_SHA256=4444444444444444444444444444444444444444444444444444444444444444' in command,
    'production_baseline_evidence_rendered': 'DSV_PRODUCTION_BASELINE_APPROVED=1' in command and 'DSV_PRODUCTION_BASELINE_MANIFEST_SHA256=5555555555555555555555555555555555555555555555555555555555555555' in command,
    'shopify_deploy_disables_migrations': 'RUN_MIGRATIONS=0' in shopify_command and 'DSV_MIGRATION_APPROVED=1' not in shopify_command,
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
    'customer_email_assets_bootstrap': 'chown -R 100:101 /srv/clever-route-server/data/customer-email-assets' in command and 'chmod 750 /srv/clever-route-server/data/customer-email-assets' in command,
    'firebase_credential_bootstrap': 'FIREBASE_CREDENTIALS_PARAM=' in command and 'aws ssm get-parameter --name "$FIREBASE_CREDENTIALS_PARAM" --with-decryption' in command and 'chown 100:101 "$FIREBASE_CREDENTIALS_FILE"' in command and 'chmod 400 "$FIREBASE_CREDENTIALS_FILE"' in command,
    'firebase_runtime_env': "'FIREBASE_PROJECT_ID': 'clever-routes-prod'" in wrapper and "'GOOGLE_APPLICATION_CREDENTIALS': '/run/secrets/firebase-fcm.json'" in wrapper,
    'firebase_credential_mount': '/srv/clever-route-server/secrets/firebase-fcm.json:/run/secrets/firebase-fcm.json:ro' in compose,
    'uvis_default_disabled': "'UVIS_ENABLED': 'false'" in wrapper and 'UVIS_ENABLED=false' in pathlib.Path('apps/delivery-api/.env.example').read_text(),
    'uvis_aws_region_rendered_for_host': 'AWS_REGION=ap-northeast-2' in command and 'export AWS_REGION UVIS_ENV_PARAM' in command,
    'uvis_uses_ssm_parameter_name_only': 'UVIS_ENV_PARAM=/clever/route-ops/uvis/runtime-env' in command and 'export AWS_REGION UVIS_ENV_PARAM' in command and 'uvis_param = os.environ.get' in command and 'uvis_param,' in command and "'--with-decryption'" in command,
    'uvis_whitelists_server_env': 'uvis_allowed_keys = {' in command and "'UVIS_ALLOWED_OUTBOUND_URLS'" in command and "'UVIS_COMPANY_SERIAL_KEY'" in command and "'UVIS_SHOP_DOMAIN'" in command and 'unsupported key: {key}' in command,
    'uvis_runtime_env_permissions': 'path.chmod(0o600)' in command,
    'uvis_not_in_candidate_image_env': 'UVIS_COMPANY_SERIAL_KEY=$' not in command and 'UVIS_ACCESS_KEY_URL=$' not in command and 'UVIS_ENABLED=$' not in command,
    'uvis_not_in_static_image_workflow': 'ROUTE_OPS_UVIS_ENV_PARAM: ${{ vars.ROUTE_OPS_UVIS_ENV_PARAM }}' in workflow and 'secrets.UVIS' not in workflow,
    'compose_pull_only_on_host': '--profile osrm --profile vroom --profile korea pull clever-route-api vroom vroom-korea' in command and 'pull clever-route-api-migrate' in command and 'pull route-ops-web-static' in command and 'docker pull "$DELIVERY_API_IMAGE"' not in command,
    'migrate_uses_compose_service': 'run --rm clever-route-api-migrate' in command,
    'migrate_is_conditionally_scoped': 'if [ "$RUN_MIGRATIONS" = "1" ]; then' in command and 'simple deploy migrations skipped: Prisma inputs unchanged and migration lane not requested' in command,
    'migrate_compose_uses_separate_image': 'image: ${DELIVERY_API_MIGRATION_IMAGE:-${DELIVERY_API_IMAGE:?DELIVERY_API_IMAGE is required}}' in compose,
    'custom_ownership_audit_uses_candidate_runtime': 'run --rm --no-deps clever-route-api node dist/scripts/audit-custom-route-order-ownership.js' in command,
    'custom_ownership_audit_before_migrate': command.index('run --rm --no-deps clever-route-api node dist/scripts/audit-custom-route-order-ownership.js') < command.index('run --rm clever-route-api-migrate'),
    'migrate_before_static_stage': command.index('run --rm clever-route-api-migrate') < command.index('simple deploy static stage required', command.index('run --rm clever-route-api-migrate')),
    'api_up_no_deps': 'up -d --no-build --no-deps --force-recreate --remove-orphans clever-route-api' in command,
    'does_not_recreate_caddy': '--force-recreate --remove-orphans clever-route-api caddy' not in command and '--force-recreate clever-route-api caddy' not in command,
    'does_not_push_prod_prev': 'backup_channel_images' not in wrapper and 'previous_image_ref' not in wrapper and 'docker tag' not in wrapper,
    'rollback_uses_previous_env': 'cp .deploy/current-image.env .deploy/simple-rollback-image.env' in command and 'rolling clever-route-api back to previous image env' in command,
    'retention_install_failure_restores_previous_runtime': 'if ! CLEVER_ROUTE_RETENTION_RUNNER_SOURCE=' in command and '.deploy/install-driver-event-attempt-retention.sh; then' in command and 'cp .deploy/simple-rollback-image.env .deploy/current-image.env' in command and 'rollback_retention_runtime || true' in command and command.index('rollback_retention_runtime || true', command.index('if ! CLEVER_ROUTE_RETENTION_RUNNER_SOURCE=')) < command.index('rollback_delivery_api || true', command.index('if ! CLEVER_ROUTE_RETENTION_RUNNER_SOURCE=')),
    'retention_rollback_restores_or_removes_candidate_units': 'retention-rollback/service.present' in command and 'rm -f /etc/systemd/system/clever-driver-event-attempt-retention.service' in command and 'systemctl disable --now clever-driver-event-attempt-retention.timer' in command,
    'proof_reservation_rollout_requires_compatible_rollback': 'DRIVER_PROOF_MEDIA_READY_FILTER_COMPATIBLE=$([ -n "$PROOF_READY_FILTER_CONTRACT_SHA" ] && echo true || echo false)' in command and 'DRIVER_PROOF_MEDIA_READY_FILTER_CONTRACT_SHA=$PROOF_READY_FILTER_CONTRACT_SHA' in command and 'proof media reservation rollout blocked: rollback image does not advertise READY-only reads' in command,
    'completion_invariant_candidate_and_rollback_capability': 'ROUTE_COMPLETION_INVARIANT_CAPABILITY_VERSION=1' in command and 'rollback image does not advertise invariant capability v1' in command and 'candidate delivery API does not advertise route completion invariant capability v1' in command and 'org.clever-route.route-completion-invariant-capability' in command,
    'runtime_metadata_comes_from_selected_api_image': 'runtime_revision=' in command and 'org.opencontainers.image.revision' in command and 'API_RUNTIME_REVISION=$runtime_revision' in command and 'API_RUNTIME_REVISION=$COMMIT_SHA' in command,
    'web_only_deploy_preserves_runtime_revision_identity': "values.get('API_RUNTIME_REVISION', values.get('COMMIT_SHA', ''))" in workflow and "values.get('COMMIT_SHA', '')" in workflow,
    'completion_invariant_workflow_image_label': 'org.clever-route.route-completion-invariant-capability=1' in workflow,
    'proof_ready_contract_sha_rendered': f'PROOF_READY_FILTER_CONTRACT_SHA={proof_ready_contract_sha}' in command,
    'proof_ready_contract_hash_needs_no_node_dependencies': 'shasum -a 256 apps/delivery-api/tests/driver-proof-media-read-inventory.test.ts apps/delivery-api/tests/dsv-v1-read-query.service.test.ts' in wrapper and 'npm test -- driver-proof-media-read-inventory.test.ts' not in wrapper,
    'main_ci_runs_proof_ready_contracts': 'tests/driver-proof-media-read-inventory.test.ts' in ci_workflow and 'tests/dsv-v1-read-query.service.test.ts' in ci_workflow,
    'workflow_requires_exact_successful_main_ci': 'actions: read' in workflow and 'actions/workflows/ci.yml/runs' in workflow and '-f branch=main' in workflow and '-f event=push' in workflow and '-f status=success' in workflow and '-f head_sha="$SOURCE_SHA"' in workflow and 'GH_TOKEN: ${{ github.token }}' in workflow and 'test "$count" -gt 0' in workflow,
    'workflow_ci_gate_precedes_aws': workflow.index('Require successful main CI for exact source SHA') < workflow.index('Configure AWS credentials through OIDC'),
    'workflow_does_not_reinstall_for_deploy': 'npm ci' not in workflow and 'npm install' not in workflow,
    'retention_candidate_is_staged_until_post_health_install': '.deploy/candidate-retention/run-driver-event-attempt-retention.sh' in command and 'CLEVER_ROUTE_RETENTION_RUNNER_SOURCE="$APP_DIR/.deploy/candidate-retention/run-driver-event-attempt-retention.sh"' in command and command.index('up -d --no-build --no-deps --force-recreate --remove-orphans clever-route-api') < command.index('CLEVER_ROUTE_RETENTION_RUNNER_SOURCE='),
    'static_missing_current_guard': 'HAD_CURRENT_IMAGE_ENV=0' in wrapper and "CURRENT_ROUTE_OPS_WEB_STATIC_IMAGE=''" in wrapper and "echo 'missing-current'" in wrapper,
    'static_non_digest_is_conservative': 'is_digest_ref()' in wrapper and "echo 'non-digest-ref'" in wrapper,
    'static_skip_logic': 'should_stage_static()' in command and 'simple deploy static stage skipped' in command and 'ROUTE_OPS_FORCE_STATIC_RESTAGE' in wrapper and "echo 'unchanged'" in wrapper and "echo 'unchanged'\n  return 1" not in wrapper,
    'static_force_logic': 'FORCE_STATIC_RESTAGE' in command and 'forceStaticRestage' in command and 'static_stage_reason="$(should_stage_static)"' in command,
    'history_append': '"lane":"simple-ssm"' in command and '"staticStage":"%s"' in command,
    'gh_write_packages_warning_only': 'does not show write:packages; continuing because docker push is the authoritative GHCR publish check' in wrapper and 'GHCR publish requires a GitHub/GHCR token with write:packages' not in wrapper,
    'workflow_uses_node24_docker_build_actions': 'uses: docker/setup-buildx-action@v4' in workflow and 'uses: docker/build-push-action@v7' in workflow,
    'workflow_requires_migration_approval_evidence': 'run_migrations:' in workflow and 'approve_dsv_migration:' in workflow and 'restore_rehearsal_sha256:' in workflow and 'if [ "$RUN_MIGRATIONS" = "true" ] && [ "$DRY_RUN" != "true" ]; then' in workflow and 'approve_dsv_migration=true is required for a production rollout' in workflow and 'restore_rehearsal_sha256 must be 64 lowercase hex characters' in workflow,
    'workflow_fails_closed_for_unapproved_prisma_changes': "grep -Eq '^apps/delivery-api/prisma/'" in workflow and 'Prisma inputs changed since the deployed API revision; run_migrations=true and reviewed migration evidence are required.' in workflow,
    'workflow_skips_migration_image_for_shopify_scope': "if: steps.changes.outputs.build_api == 'true' && steps.changes.outputs.run_migrations == 'true'" in workflow and "ROUTE_OPS_RUN_MIGRATIONS: ${{ steps.changes.outputs.run_migrations == 'true' && '1' || '0' }}" in workflow,
    'workflow_exposes_one_time_production_baseline': 'approve_production_baseline:' in workflow and 'DSV_PRODUCTION_BASELINE_APPROVED:' in workflow and 'production_baseline_manifest_sha256' in workflow,
    'workflow_always_prepares_private_registry_resolution': '      - name: Login to GHCR\n        # docker/login-action' in workflow and '      - name: Set up Docker Buildx\n        uses: docker/setup-buildx-action@v4' in workflow,
    'workflow_fails_closed_when_digest_resolution_fails': 'if ! digest="$(docker buildx imagetools inspect' in workflow and '[[ "$digest" == sha256:* ]] || return 1' in workflow,
    'workflow_uses_registry_cache': 'cache-from: type=registry,ref=${{ env.DELIVERY_API_IMAGE_REPO }}:buildcache' in workflow and 'cache-to: type=registry,ref=${{ env.ROUTE_OPS_WEB_STATIC_IMAGE_REPO }}:buildcache,mode=max' in workflow,
    'workflow_publishes_sha_and_channel_tags': '${{ env.DELIVERY_API_IMAGE_REPO }}:${{ github.sha }}' in workflow and '${{ env.DELIVERY_API_IMAGE_REPO }}:${{ inputs.channel_tag }}' in workflow and '${{ env.ROUTE_OPS_WEB_STATIC_IMAGE_REPO }}:${{ github.sha }}' in workflow and '${{ env.ROUTE_OPS_WEB_STATIC_IMAGE_REPO }}:${{ inputs.channel_tag }}' in workflow,
    'workflow_uses_digest_output': 'API_DIGEST: ${{ steps.build_api.outputs.digest }}' in workflow and 'WEB_DIGEST: ${{ steps.build_web.outputs.digest }}' in workflow,
    'workflow_splits_image_scope': "grep -Eq '^(apps/delivery-api/|\\.dockerignore$)'" in workflow and "grep -Eq '^(apps/route-ops-web/|\\.dockerignore$)'" in workflow,
    'workflow_unquotes_non_ascii_paths_before_scope_match': 'git -c core.quotePath=false diff --name-only' in workflow and 'git -c core.quotePath=false ls-files' in workflow,
    'main_ci_unquotes_non_ascii_paths_before_classification': 'git -c core.quotePath=false diff --name-only' in ci_workflow and 'git -c core.quotePath=false ls-files' in ci_workflow,
    'main_ci_runs_for_simple_deploy_contract_changes': '      - ".github/workflows/route-ops-simple-deploy.yml"' in ci_workflow and '      - "scripts/ssm-simple-route-ops-deploy.sh"' in ci_workflow and '      - "tests/deploy/ssm-simple-route-ops-deploy.test.sh"' in ci_workflow,
    'workflow_uses_runtime_revision_for_api_scope': 'API_RUNTIME_COMMIT: ${{ steps.current.outputs.runtime_commit }}' in workflow and 'api_files="$(git -c core.quotePath=false diff --name-only "$API_RUNTIME_COMMIT" HEAD)"' in workflow and '''printf '%s\\n' "$api_files" | grep -Eq '^(apps/delivery-api/|\.dockerignore$)' '''.strip() in workflow,
    'workflow_builds_separate_migration_image': 'DELIVERY_API_MIGRATION_IMAGE_REPO:' in workflow and 'target: migration' in workflow and 'org.clever-route.image-role=migration' in workflow,
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
