#!/usr/bin/env bash
set -euo pipefail

AWS_REGION="${AWS_REGION:-ap-northeast-2}"
INSTANCE_ID="${CUSTOMER_EMAIL_RECONCILIATION_INSTANCE_ID:-}"
IMAGE="${CUSTOMER_EMAIL_RECONCILIATION_IMAGE:-}"
MANIFEST_PATH="${CUSTOMER_EMAIL_RECONCILIATION_MANIFEST_PATH:-}"
CLI_ARGS_B64="${CUSTOMER_EMAIL_RECONCILIATION_ARGS_B64:-}"
RENDER_HOST_SCRIPT=false

usage() {
  cat <<'USAGE'
Usage: CUSTOMER_EMAIL_RECONCILIATION_IMAGE=<image@sha256:digest> \
       CUSTOMER_EMAIL_RECONCILIATION_ARGS_B64=<base64-json-array> \
       scripts/ssm-customer-email-reconciliation.sh [--render-host-script]

Apply additionally requires CUSTOMER_EMAIL_RECONCILIATION_MANIFEST_PATH to be an
absolute host path under /srv/clever-route-server/operator/reconciliation. The
wrapper mounts that reviewed manifest read-only. Arguments must select FACT IDs;
manual dispatch reconciliation is unsupported.
USAGE
}

if [ "${1:-}" = "--render-host-script" ]; then
  RENDER_HOST_SCRIPT=true
  shift
fi
[ "$#" -eq 0 ] || { usage >&2; exit 64; }

[[ "$IMAGE" =~ @sha256:[0-9a-f]{64}$ ]] || {
  echo "customer-email-reconciliation: a digest-pinned image is required" >&2
  exit 64
}
[ -n "$CLI_ARGS_B64" ] || { echo "customer-email-reconciliation: encoded argument array is required" >&2; exit 64; }
if [ -n "$MANIFEST_PATH" ] && [[ "$MANIFEST_PATH" != /srv/clever-route-server/operator/reconciliation/* ]]; then
  echo "customer-email-reconciliation: manifest path is outside the approved directory" >&2
  exit 64
fi

shell_quote() { printf '%q' "$1"; }

host_script() {
  cat <<HOST
#!/usr/bin/env bash
set -euo pipefail
IMAGE=$(shell_quote "$IMAGE")
ARGS_B64=$(shell_quote "$CLI_ARGS_B64")
MANIFEST_PATH=$(shell_quote "$MANIFEST_PATH")
HOST
  cat <<'HOST'
cd /srv/clever-route-server
python3 - "$ARGS_B64" <<'PY' >/tmp/customer-email-reconciliation-args
import base64, json, sys
args = json.loads(base64.b64decode(sys.argv[1], validate=True))
if not isinstance(args, list) or not args or not all(isinstance(v, str) for v in args):
    raise SystemExit('invalid argument array')
if '--dispatch-id' in args or not any(v == '--fact-id' for v in args):
    raise SystemExit('FACT IDs are required and dispatch IDs are forbidden')
for value in args:
    if '\0' in value or '\n' in value or '\r' in value:
        raise SystemExit('invalid control character in argument')
print('\0'.join(args), end='')
PY
mapfile -d '' -t args </tmp/customer-email-reconciliation-args
rm -f /tmp/customer-email-reconciliation-args

compose=(docker compose -p clever-route -f infra/compose/docker-compose.prod.yml run --rm --no-deps)
if [[ " ${args[*]} " == *" --apply "* ]]; then
  [ -n "$MANIFEST_PATH" ] || { echo 'apply requires an approved manifest path' >&2; exit 64; }
  [ -f "$MANIFEST_PATH" ] || { echo 'approved manifest is missing' >&2; exit 66; }
  compose+=(-v "$MANIFEST_PATH:/run/reconciliation/manifest.json:ro")
fi
DELIVERY_API_IMAGE="$IMAGE" "${compose[@]}" clever-route-api \
  node dist/scripts/reconcile-customer-email.js "${args[@]}"
HOST
}

if [ "$RENDER_HOST_SCRIPT" = true ]; then
  host_script
  exit 0
fi

command -v aws >/dev/null || { echo "customer-email-reconciliation: aws is required" >&2; exit 127; }
command -v python3 >/dev/null || { echo "customer-email-reconciliation: python3 is required" >&2; exit 127; }
[ -n "$INSTANCE_ID" ] || {
  echo "customer-email-reconciliation: explicit SSM instance id is required" >&2
  exit 64
}

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
host_script >"$tmp_dir/host.sh"
encoded="$(base64 <"$tmp_dir/host.sh" | tr -d '\n')"
python3 - "$tmp_dir/parameters.json" "$encoded" <<'PY'
import json, sys
with open(sys.argv[1], 'w', encoding='utf-8') as fh:
    json.dump({'commands': [f"printf '%s' '{sys.argv[2]}' | base64 -d | bash"]}, fh)
PY

aws ssm send-command \
  --region "$AWS_REGION" \
  --instance-ids "$INSTANCE_ID" \
  --document-name AWS-RunShellScript \
  --comment 'CC-approved customer email fact reconciliation' \
  --parameters "file://$tmp_dir/parameters.json" \
  --query 'Command.CommandId' \
  --output text
