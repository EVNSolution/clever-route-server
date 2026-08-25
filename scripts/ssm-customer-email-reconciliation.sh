#!/usr/bin/env bash
set -euo pipefail

AWS_REGION="${AWS_REGION:-ap-northeast-2}"
INSTANCE_ID="${CUSTOMER_EMAIL_RECONCILIATION_INSTANCE_ID:-}"
IMAGE="${CUSTOMER_EMAIL_RECONCILIATION_IMAGE:-}"
RELEASE_SHA="${CUSTOMER_EMAIL_RECONCILIATION_RELEASE_SHA:-}"
CHANGE_CONTROL_REF="${CUSTOMER_EMAIL_RECONCILIATION_CHANGE_CONTROL_REF:-}"
MANIFEST_SHA256="${CUSTOMER_EMAIL_RECONCILIATION_MANIFEST_SHA256:-}"
APPROVAL_REF="${CUSTOMER_EMAIL_RECONCILIATION_APPROVAL_REF:-}"
CALLER_ARN="${CUSTOMER_EMAIL_RECONCILIATION_CALLER_ARN:-}"
EVIDENCE_COMMAND_ID="${CUSTOMER_EMAIL_RECONCILIATION_EVIDENCE_COMMAND_ID:-}"
APPROVAL_SNAPSHOT_SHA256="${CUSTOMER_EMAIL_RECONCILIATION_APPROVAL_SNAPSHOT_SHA256:-}"
COMMAND_ID_PARAMETER="${CUSTOMER_EMAIL_RECONCILIATION_COMMAND_ID_PARAMETER:-}"
APPROVER_LOGINS="${CUSTOMER_EMAIL_RECONCILIATION_APPROVER_LOGINS:-}"
MANIFEST_PATH="${CUSTOMER_EMAIL_RECONCILIATION_MANIFEST_PATH:-}"
CLI_ARGS_B64="${CUSTOMER_EMAIL_RECONCILIATION_ARGS_B64:-}"
RENDER_HOST_SCRIPT=false
SMOKE_COMPILED_CLI=false

usage() {
  cat <<'USAGE'
Usage: CUSTOMER_EMAIL_RECONCILIATION_IMAGE=<image@sha256:digest> \
       CUSTOMER_EMAIL_RECONCILIATION_ARGS_B64=<base64-json-array> \
       scripts/ssm-customer-email-reconciliation.sh [--render-host-script]

       scripts/ssm-customer-email-reconciliation.sh --smoke-compiled-cli

Apply additionally requires CUSTOMER_EMAIL_RECONCILIATION_MANIFEST_PATH to be an
absolute host path under /srv/clever-route-server/operator/reconciliation. The
wrapper mounts that reviewed manifest read-only. Arguments must select FACT IDs;
manual dispatch reconciliation is unsupported.
USAGE
}

case "${1:-}" in
  --render-host-script) RENDER_HOST_SCRIPT=true; shift ;;
  --smoke-compiled-cli) SMOKE_COMPILED_CLI=true; shift ;;
esac
[ "$#" -eq 0 ] || { usage >&2; exit 64; }

if [ "$SMOKE_COMPILED_CLI" = true ]; then
  compiled_cli="$(cd "$(dirname "$0")/.." && pwd)/apps/delivery-api/dist/scripts/reconcile-customer-email.js"
  [ -f "$compiled_cli" ] || { echo "customer-email-reconciliation: compiled CLI is missing" >&2; exit 66; }
  smoke_dir="$(mktemp -d)"
  trap 'rm -rf "$smoke_dir"' EXIT
  cat >"$smoke_dir/manifest.json" <<'JSON'
{"schema":"customer_email_reconciliation_manifest_v1","changeControlRef":"EVNSolution/clever-change-control#265","disposition":"DO_NOT_SEND","generatedAt":"2026-08-25T00:00:00.000Z","items":[{"kind":"FACT","id":"00000000-0000-4000-8000-000000000001","stateSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","updatedAt":"2026-08-25T00:00:00.000Z"}],"reasonCode":"CONTRACT_SMOKE","scope":{"appId":"clever","shopId":"00000000-0000-4000-8000-000000000002"}}
JSON
  set +e
  dry_output="$(node "$compiled_cli" --fact-id 00000000-0000-4000-8000-000000000001 --change-control-ref EVNSolution/clever-change-control#265 --reason-code CONTRACT_SMOKE --app-id clever --shop-id 00000000-0000-4000-8000-000000000002 --disposition unsupported 2>&1)"
  dry_status=$?
  apply_output="$(node "$compiled_cli" --apply --manifest "$smoke_dir/manifest.json" --reviewed-manifest-sha256 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --change-control-ref EVNSolution/clever-change-control#265 --reason-code CONTRACT_SMOKE --app-id clever --shop-id 00000000-0000-4000-8000-000000000002 --disposition do-not-send 2>&1)"
  apply_status=$?
  set -e
  [ "$dry_status" -eq 2 ] && [ "$dry_output" = '{"errorCode":"DISPOSITION_UNSUPPORTED"}' ] || { echo "customer-email-reconciliation: compiled dry-run smoke failed" >&2; exit 1; }
  [ "$apply_status" -eq 2 ] && [ "$apply_output" = '{"errorCode":"CUSTOMER_EMAIL_RECONCILIATION_FAILED"}' ] || { echo "customer-email-reconciliation: compiled apply smoke failed" >&2; exit 1; }
  echo 'compiled customer email reconciliation dry-run/apply smoke passed'
  exit 0
fi

[[ "$IMAGE" =~ ^ghcr\.io/evnsolution/clever-route-server-delivery-api@sha256:[0-9a-f]{64}$ ]] || {
  echo "customer-email-reconciliation: a digest-pinned image is required" >&2
  exit 64
}
[[ "$RELEASE_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "customer-email-reconciliation: exact release SHA is required" >&2; exit 64; }
[[ "$CHANGE_CONTROL_REF" =~ ^EVNSolution/clever-change-control#[1-9][0-9]*$ ]] || { echo "customer-email-reconciliation: change-control binding is required" >&2; exit 64; }
[[ "$APPROVAL_REF" =~ ^${CHANGE_CONTROL_REF}:comment-[1-9][0-9]*$ ]] || { echo "customer-email-reconciliation: exact approval reference is required" >&2; exit 64; }
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
RELEASE_SHA=$(shell_quote "$RELEASE_SHA")
CHANGE_CONTROL_REF=$(shell_quote "$CHANGE_CONTROL_REF")
MANIFEST_SHA256=$(shell_quote "$MANIFEST_SHA256")
APPROVAL_REF=$(shell_quote "$APPROVAL_REF")
CALLER_ARN=$(shell_quote "$CALLER_ARN")
EVIDENCE_COMMAND_ID=$(shell_quote "$EVIDENCE_COMMAND_ID")
APPROVAL_SNAPSHOT_SHA256=$(shell_quote "$APPROVAL_SNAPSHOT_SHA256")
COMMAND_ID_PARAMETER=$(shell_quote "$COMMAND_ID_PARAMETER")
HOST
  cat <<'HOST'
cd /srv/clever-route-server
args_file="$(mktemp /tmp/customer-email-reconciliation-args.XXXXXX)"
trap 'rm -f "$args_file"' EXIT
python3 - "$ARGS_B64" "$CHANGE_CONTROL_REF" "$MANIFEST_SHA256" <<'PY' >"$args_file"
import base64, json, sys
args = json.loads(base64.b64decode(sys.argv[1], validate=True))
if not isinstance(args, list) or not args or not all(isinstance(v, str) for v in args):
    raise SystemExit('invalid argument array')
is_apply = '--apply' in args
has_fact = '--fact-id' in args
has_manifest = '--manifest' in args
if '--dispatch-id' in args:
    raise SystemExit('dispatch IDs are forbidden')
if any(flag in args for flag in ('--operator-actor', '--ssm-command-id', '--release-image-digest', '--approval-ref')):
    raise SystemExit('operator evidence is injected by SSM and cannot be supplied')
if is_apply and (has_fact or not has_manifest):
    raise SystemExit('apply requires a manifest and forbids FACT IDs')
if not is_apply and (not has_fact or has_manifest):
    raise SystemExit('dry-run requires FACT IDs and forbids a manifest')
def value(flag):
    return args[args.index(flag) + 1] if flag in args and args.index(flag) + 1 < len(args) else None
if value('--change-control-ref') != sys.argv[2]:
    raise SystemExit('change-control binding mismatch')
if is_apply and value('--reviewed-manifest-sha256') != sys.argv[3]:
    raise SystemExit('reviewed manifest binding mismatch')
for value in args:
    if '\0' in value or '\n' in value or '\r' in value:
        raise SystemExit('invalid control character in argument')
print('\0'.join(args), end='')
PY
mapfile -d '' -t args <"$args_file"
is_apply=false
[[ " ${args[*]} " == *" --apply "* ]] && is_apply=true
operator_actor="aws-$(printf '%s' "$CALLER_ARN" | sha256sum | cut -c1-24)"

python3 - "$IMAGE" "$RELEASE_SHA" <<'PY'
import json, pathlib, subprocess, sys
image, release_sha = sys.argv[1:]
if subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip() != release_sha:
    raise SystemExit('checked-out source SHA mismatch')
history = pathlib.Path('.deploy/deploy-history.jsonl')
record = json.loads(history.read_text(encoding='utf-8').splitlines()[-1])
if record.get('commitSha') != release_sha or record.get('deliveryApiImage') != image:
    raise SystemExit('deployed release provenance mismatch')
PY

api_container="$(docker ps --filter label=com.docker.compose.project=clever-route --filter label=com.docker.compose.service=clever-route-api --format '{{.ID}}')"
[[ "$api_container" != *$'\n'* && -n "$api_container" ]] || { echo 'expected exactly one deployed API container' >&2; exit 65; }
database_url="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$api_container" | sed -n 's/^DATABASE_URL=//p')"
[ -n "$database_url" ] || { echo 'deployed DATABASE_URL is unavailable' >&2; exit 65; }
compose_file="$(mktemp /tmp/customer-email-reconciliation-compose.XXXXXX.yml)"
trap 'rm -f "$args_file" "$compose_file"' EXIT
cat >"$compose_file" <<'YAML'
services:
  customer-email-reconciliation:
    image: ${RECONCILIATION_IMAGE:?}
    environment:
      DATABASE_URL: ${RECONCILIATION_DATABASE_URL:?}
    networks:
      - runtime
networks:
  runtime:
    external: true
    name: clever-route_default
YAML
compose=(docker compose -f "$compose_file" run --rm --no-deps)
if [ "$is_apply" = true ]; then
  [ -n "$MANIFEST_PATH" ] || { echo 'apply requires an approved manifest path' >&2; exit 64; }
  [ -f "$MANIFEST_PATH" ] || { echo 'approved manifest is missing' >&2; exit 66; }
  for _ in $(seq 1 60); do
    EVIDENCE_COMMAND_ID="$(aws ssm get-parameter --name "$COMMAND_ID_PARAMETER" --query Parameter.Value --output text 2>/dev/null || true)"
    [[ "$EVIDENCE_COMMAND_ID" =~ ^[a-f0-9-]{36}$ ]] && break
    sleep 1
  done
  [[ "$EVIDENCE_COMMAND_ID" =~ ^[a-f0-9-]{36}$ ]] || { echo 'actual SSM command identity is unavailable' >&2; exit 65; }
  compose+=(-e "CUSTOMER_EMAIL_OPERATOR_ACTOR=$operator_actor")
  compose+=(-e "CUSTOMER_EMAIL_SSM_COMMAND_ID=$EVIDENCE_COMMAND_ID")
  compose+=(-e "CUSTOMER_EMAIL_RELEASE_IMAGE_DIGEST=$IMAGE")
  compose+=(-e "CUSTOMER_EMAIL_APPROVAL_REF=$APPROVAL_REF")
  compose+=(-e "CUSTOMER_EMAIL_APPROVAL_SNAPSHOT_SHA256=$APPROVAL_SNAPSHOT_SHA256")
  compose+=(-v "$MANIFEST_PATH:/run/reconciliation/manifest.json:ro")
fi
RECONCILIATION_IMAGE="$IMAGE" RECONCILIATION_DATABASE_URL="$database_url" "${compose[@]}" customer-email-reconciliation \
  node dist/scripts/reconcile-customer-email.js "${args[@]}"
HOST
}

if [ "$RENDER_HOST_SCRIPT" = true ]; then
  host_script
  exit 0
fi

command -v aws >/dev/null || { echo "customer-email-reconciliation: aws is required" >&2; exit 127; }
command -v python3 >/dev/null || { echo "customer-email-reconciliation: python3 is required" >&2; exit 127; }
command -v gh >/dev/null || { echo "customer-email-reconciliation: gh is required" >&2; exit 127; }
CALLER_ARN="$(aws sts get-caller-identity --query Arn --output text)"
[ -n "$CALLER_ARN" ] && [ "$CALLER_ARN" != "None" ] || { echo "customer-email-reconciliation: AWS caller identity is unavailable" >&2; exit 65; }
[ -n "$INSTANCE_ID" ] || {
  echo "customer-email-reconciliation: explicit SSM instance id is required" >&2
  exit 64
}

comment_id="${APPROVAL_REF##*:comment-}"
approval_json="$(gh api "repos/EVNSolution/clever-change-control/issues/comments/$comment_id")"
APPROVAL_SNAPSHOT_SHA256="$(APPROVAL_JSON="$approval_json" python3 - "$APPROVER_LOGINS" "$MANIFEST_SHA256" "$RELEASE_SHA" "$IMAGE" <<'PY'
import hashlib, json, os, sys
allowed, manifest, release, image = sys.argv[1:]
data = json.loads(os.environ['APPROVAL_JSON'])
author = data.get('user', {}).get('login', '')
body = data.get('body', '')
if author not in {v.strip() for v in allowed.split(',') if v.strip()}:
    raise SystemExit('approval author is not authorized')
required = ['APPROVED CUSTOMER EMAIL DO-NOT-SEND', f'manifest-sha256: {manifest}', f'release-sha: {release}', f'image-digest: {image}']
if any(value not in body for value in required):
    raise SystemExit('approval body binding mismatch')
snapshot = {'author': author, 'body': body, 'commentId': data.get('id'), 'htmlUrl': data.get('html_url')}
print(hashlib.sha256(json.dumps(snapshot, sort_keys=True, separators=(',', ':')).encode()).hexdigest())
PY
)"
COMMAND_ID_PARAMETER="/clever/route-ops/reconciliation/$(python3 -c 'import uuid; print(uuid.uuid4())')"
aws ssm put-parameter --region "$AWS_REGION" --name "$COMMAND_ID_PARAMETER" --type String --value pending >/dev/null

tmp_dir="$(mktemp -d)"
cleanup_local() {
  aws ssm delete-parameter --region "$AWS_REGION" --name "$COMMAND_ID_PARAMETER" >/dev/null 2>&1 || true
  rm -rf "$tmp_dir"
}
trap cleanup_local EXIT
host_script >"$tmp_dir/host.sh"
encoded="$(base64 <"$tmp_dir/host.sh" | tr -d '\n')"
python3 - "$tmp_dir/parameters.json" "$encoded" <<'PY'
import json, sys
with open(sys.argv[1], 'w', encoding='utf-8') as fh:
    json.dump({'commands': [f"printf '%s' '{sys.argv[2]}' | base64 -d | bash"]}, fh)
PY

command_id="$(aws ssm send-command \
  --region "$AWS_REGION" \
  --instance-ids "$INSTANCE_ID" \
  --document-name AWS-RunShellScript \
  --comment 'CC-approved customer email fact reconciliation' \
  --parameters "file://$tmp_dir/parameters.json" \
  --query 'Command.CommandId' \
  --output text)"
aws ssm put-parameter --region "$AWS_REGION" --name "$COMMAND_ID_PARAMETER" --type String --overwrite --value "$command_id" >/dev/null
aws ssm wait command-executed --region "$AWS_REGION" --command-id "$command_id" --instance-id "$INSTANCE_ID"
invocation="$(aws ssm get-command-invocation --region "$AWS_REGION" --command-id "$command_id" --instance-id "$INSTANCE_ID" --output json)"
INVOCATION_JSON="$invocation" python3 - <<'PY'
import json, os
value = json.loads(os.environ['INVOCATION_JSON'])
if value.get('Status') != 'Success' or value.get('ResponseCode') != 0:
    raise SystemExit('reconciliation command did not succeed')
lines = [line for line in value.get('StandardOutputContent', '').splitlines() if line.startswith('{')]
if not lines or json.loads(lines[-1]).get('mode') not in {'apply', 'dry-run'}:
    raise SystemExit('reconciliation result evidence is missing')
PY
echo "SSM_RECONCILIATION_COMMAND_ID=$command_id"
