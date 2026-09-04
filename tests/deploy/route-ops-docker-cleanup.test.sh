#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

python3 - <<'PY'
from pathlib import Path

worker = Path('scripts/route-ops-docker-cleanup.sh').read_text()
wrapper = Path('scripts/ssm-route-ops-docker-cleanup.sh').read_text()
deploy = Path('scripts/ssm-simple-route-ops-deploy.sh').read_text()
workflow = Path('.github/workflows/route-ops-operations.yml').read_text()

checks = {
    'worker_is_dangling_only': 'docker image prune --force --filter "until=$IMAGE_MAX_AGE"' in worker,
    'worker_prunes_old_build_cache': 'docker builder prune --force --filter "until=$BUILD_CACHE_MAX_AGE" --reserved-space "$BUILD_CACHE_RESERVED_SPACE"' in worker,
    'worker_has_20gb_and_20pct_guard': 'MIN_FREE_MB="${ROUTE_OPS_DOCKER_MIN_FREE_MB:-20480}"' in worker and 'MIN_FREE_PERCENT="${ROUTE_OPS_DOCKER_MIN_FREE_PERCENT:-20}"' in worker,
    'worker_cleans_before_enforcing_actual_capacity': 'check_capacity before "$DRY_RUN"' in worker and 'check_capacity after 1' in worker,
    'worker_supports_dry_run': '--dry-run' in worker and 'cleanup dry-run complete; no Docker data was removed' in worker,
    'worker_checks_running_set': 'running-containers.before' in worker and 'running-containers.after' in worker and 'diff -u' in worker,
    'worker_never_prunes_unsafe_objects': all(snippet not in worker for snippet in [
        'docker system prune', 'docker container prune', 'docker volume prune', 'docker network prune',
        'docker image prune -a', 'docker image prune --all',
    ]),
    'wrapper_uses_ssm': 'aws ssm send-command' in wrapper and 'AWS-RunShellScript' in wrapper,
    'wrapper_embeds_worker': 'DOCKER_CLEANUP_SCRIPT_B64' in wrapper and 'route-ops-docker-cleanup.sh' in wrapper,
    'deploy_runs_cleanup_before_pull': deploy.index('route-ops-docker-cleanup.sh --enforce') < deploy.index('pull clever-route-api vroom vroom-korea'),
    'deploy_runs_cleanup_after_promotion': deploy.rindex('route-ops-docker-cleanup.sh --enforce') > deploy.index('cp .deploy/simple-candidate-image.env .deploy/current-image.env'),
    'deploy_dry_run_is_non_mutating': 'route-ops-docker-cleanup.sh --dry-run --enforce' in deploy,
    'workflow_has_dry_run_default': 'default: true' in workflow and 'scripts/ssm-route-ops-docker-cleanup.sh --dry-run' in workflow and "inputs.operation == 'docker_cleanup'" in workflow,
    'workflow_uses_oidc': 'id-token: write' in workflow and 'aws-actions/configure-aws-credentials@' in workflow,
    'workflow_requires_main_history': 'git merge-base --is-ancestor HEAD origin/main' in workflow,
}

missing = [name for name, ok in checks.items() if not ok]
if missing:
    raise SystemExit(f'missing expected Docker cleanup guard(s): {missing}')
print('{"ok":true,"worker":"scripts/route-ops-docker-cleanup.sh"}')
PY
