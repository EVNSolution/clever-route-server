#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

params_path="$(scripts/ssm-edge-caddy-deploy.sh --dry-run --no-send)"
cleanup() { rm -f "$params_path"; }
trap cleanup EXIT

python3 - "$params_path" <<'PY'
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
payload = json.loads(path.read_text())
command = payload['commands'][0]
wrapper = pathlib.Path('scripts/ssm-edge-caddy-deploy.sh').read_text()
dry_run_idx = command.index('if [ "$DRY_RUN" = "1" ]')
install_idx = command.index('install -m 0644 "$candidate" "$CADDYFILE"')
container_validate_idx = command.index('if ! docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" exec -T caddy caddy validate --config /etc/caddy/Caddyfile')
container_reload_idx = command.index('if ! docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" exec -T caddy caddy reload --config /etc/caddy/Caddyfile')
checks = {
    'uses_run_shell_command': command.startswith('bash -lc '),
    'caddyfile_rendered': 'CADDYFILE_B64=' in command and 'base64 -d > "$candidate"' in command,
    'validates_candidate_before_dry_run': 'docker run --rm -v "$candidate_abs:/etc/caddy/Caddyfile:ro" caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile' in command and command.index('docker run --rm -v "$candidate_abs:/etc/caddy/Caddyfile:ro"') < dry_run_idx,
    'dry_run_exits_before_ingress_mutation': dry_run_idx < install_idx,
    'validates_container_before_reload': container_validate_idx < container_reload_idx,
    'reloads_not_restarts': 'exec -T caddy caddy reload --config /etc/caddy/Caddyfile' in command and 'restart caddy' not in command,
    'rollback_restores_backup': 'cp "$backup" "$CADDYFILE"' in command and 'restore_caddy' in command and 'reload failed' in command and 'route-api smoke failed' in command and 'route-legacy smoke failed' in command and 'shopify-prod smoke failed' in command and 'shopify-legacy-admin smoke failed' in command,
    'smoke_hosts': all(url in command for url in [
        'https://clever-route-api.cleversystem.ai/healthz',
        'https://clever-route.cleversystem.ai/healthz',
        'https://clever-route-app-dev.cleversystem.ai/auth/login',
        'https://clever-route-app.cleversystem.ai/auth/login',
        'https://clever-admin.cleversystem.ai/auth/login',
        'https://clever-kfood-app.cleversystem.ai/auth/login',
    ]),
    'does_not_touch_runtime_lane': 'clever-route-api-migrate' not in command and 'force-recreate clever-route-api' not in command and 'route-ops-web-static' not in command,
    'history_append': '"lane":"edge-caddy"' in command,
    'wrapper_no_publish_or_migration': '--publish' not in wrapper and 'DELIVERY_API_IMAGE' not in wrapper and 'ROUTE_OPS_WEB_STATIC_IMAGE' not in wrapper and 'clever-route-api-migrate' not in wrapper,
}
missing = [name for name, ok in checks.items() if not ok]
if missing:
    raise SystemExit(f'missing expected edge caddy deploy guard(s): {missing}')
print('{"ok":true,"wrapper":"scripts/ssm-edge-caddy-deploy.sh"}')
PY
