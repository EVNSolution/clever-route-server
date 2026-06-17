#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

params_path="$(ROUTE_OPS_SIMPLE_CHANNEL_TAG=prod-test scripts/ssm-simple-route-ops-deploy.sh --dry-run --no-send)"
cleanup() { rm -f "$params_path"; }
trap cleanup EXIT

python3 - "$params_path" <<'PY'
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
payload = json.loads(path.read_text())
command = payload['commands'][0]
checks = {
    'uses_run_shell_command': command.startswith('bash -lc '),
    'channel_rendered': 'CHANNEL_TAG=prod-test' in command,
    'compose_preflight': 'docker compose -p "$COMPOSE_PROJECT" --env-file .deploy/simple-candidate-image.env' in command,
    'dry_run_exits_before_pull': command.index('if [ "$DRY_RUN" = "1" ]') < command.index('docker pull "$DELIVERY_API_IMAGE"'),
    'vroom_env': 'VROOM_BASE_URL' in command and 'http://vroom:3000' in command and 'ROUTE_ENGINE_BASE_URL' in command,
    'proof_media_bootstrap': 'chown -R 100:101 /srv/clever-route-server/data/driver-proof-media' in command and 'chmod 750 /srv/clever-route-server/data/driver-proof-media' in command,
    'vroom_smoke': 'http://vroom:3000/health' in command and 'http://vroom:3000/' in command and 'payload.code !== 0' in command,
    'route_engine_stop': '--profile route-engine stop route-engine' in command,
    'history_append': '"lane":"simple-ssm"' in command,
}
missing = [name for name, ok in checks.items() if not ok]
if missing:
    raise SystemExit(f'missing expected simple deploy guard(s): {missing}')
print('{"ok":true,"wrapper":"scripts/ssm-simple-route-ops-deploy.sh"}')
PY
