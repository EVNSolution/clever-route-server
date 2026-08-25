#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
wrapper="$repo_root/scripts/ssm-customer-email-reconciliation.sh"
compiled_source="$repo_root/apps/delivery-api/src/scripts/reconcile-customer-email.ts"
digest="ghcr.io/evnsolution/clever-route-server-delivery-api@sha256:$(printf 'a%.0s' {1..64})"
release_sha="$(printf 'b%.0s' {1..40})"
args='["--apply","--manifest","/run/reconciliation/manifest.json","--reviewed-manifest-sha256","aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","--expected-item-count","1","--change-control-ref","EVNSolution/clever-change-control#265","--reason-code","HISTORICAL_DO_NOT_SEND","--app-id","clever","--shop-id","00000000-0000-0000-0000-000000000001","--disposition","do-not-send"]'
args_b64="$(printf '%s' "$args" | base64 | tr -d '\n')"
dry_args='["--fact-id","00000000-0000-4000-8000-000000000001","--change-control-ref","EVNSolution/clever-change-control#265","--reason-code","HISTORICAL_DO_NOT_SEND","--app-id","clever","--shop-id","00000000-0000-0000-0000-000000000001","--disposition","do-not-send"]'
dry_args_b64="$(printf '%s' "$dry_args" | base64 | tr -d '\n')"

rendered="$(
  CUSTOMER_EMAIL_RECONCILIATION_IMAGE="$digest" \
  CUSTOMER_EMAIL_RECONCILIATION_ARGS_B64="$args_b64" \
  CUSTOMER_EMAIL_RECONCILIATION_RELEASE_SHA="$release_sha" \
  CUSTOMER_EMAIL_RECONCILIATION_CHANGE_CONTROL_REF='EVNSolution/clever-change-control#265' \
  CUSTOMER_EMAIL_RECONCILIATION_MANIFEST_SHA256="$(printf 'a%.0s' {1..64})" \
  CUSTOMER_EMAIL_RECONCILIATION_APPROVAL_REF='EVNSolution/clever-change-control#265:comment-123' \
  CUSTOMER_EMAIL_RECONCILIATION_CALLER_ARN='arn:aws:sts::123456789012:assumed-role/ops/session' \
  CUSTOMER_EMAIL_RECONCILIATION_EVIDENCE_COMMAND_ID='11111111-1111-4111-8111-111111111111' \
  CUSTOMER_EMAIL_RECONCILIATION_MANIFEST_PATH=/srv/clever-route-server/operator/reconciliation/reviewed.json \
  "$wrapper" --render-host-script
)"

grep -Fq 'node dist/scripts/reconcile-customer-email.js' <<<"$rendered"
grep -Fq '/run/reconciliation/manifest.json:ro' <<<"$rendered"
grep -Fq -- "--dispatch-id" <<<"$rendered"
grep -Fq 'apply requires a manifest and forbids FACT IDs' <<<"$rendered"
grep -Fq 'dry-run requires FACT IDs and forbids a manifest' <<<"$rendered"
grep -Fq 'deployed release provenance mismatch' <<<"$rendered"
grep -Fq 'mktemp /tmp/customer-email-reconciliation-args.XXXXXX' <<<"$rendered"
grep -Fq 'operator evidence is injected by SSM and cannot be supplied' <<<"$rendered"
grep -Fq 'EVIDENCE_COMMAND_ID' <<<"$rendered"
grep -Fq '/run/reconciliation/operator-evidence.json:ro' <<<"$rendered"
grep -Fq 'customer-email-reconciliation-evidence.XXXXXX.json' <<<"$rendered"
! grep -Fq 'CUSTOMER_EMAIL_OPERATOR_ACTOR=' <<<"$rendered"
! grep -Fq 'CUSTOMER_EMAIL_SSM_COMMAND_ID=' <<<"$rendered"
grep -Fq 'customer-email-reconciliation:' <<<"$rendered"
grep -Fq 'RECONCILIATION_DATABASE_URL' <<<"$rendered"
grep -Fq 'CUSTOMER_EMAIL_RECONCILIATION_RESULT_B64=' <<<"$rendered"
grep -Fq 'customer-email-reconciliation-result.XXXXXX.json' <<<"$rendered"
! grep -Fq 'docker-compose.prod.yml run' <<<"$rendered"
! grep -Eq 'firebase-fcm|driver-proof-media|customer-email-assets' <<<"$rendered"
! grep -Eq 'tsx|npm run' <<<"$rendered"
grep -Fq "const OPERATOR_EVIDENCE_PATH = '/run/reconciliation/operator-evidence.json'" "$compiled_source"
grep -Fq 'evidenceStat.uid !== 0' "$compiled_source"
! grep -Eq 'process\.env\.CUSTOMER_EMAIL_(OPERATOR|APPROVAL|RELEASE|SSM)' "$compiled_source"

"$wrapper" --smoke-compiled-cli >/dev/null

if CUSTOMER_EMAIL_RECONCILIATION_IMAGE=registry.example/delivery-api:latest \
  CUSTOMER_EMAIL_RECONCILIATION_ARGS_B64="$args_b64" \
  "$wrapper" --render-host-script >/dev/null 2>&1; then
  echo 'mutable image tag was accepted' >&2
  exit 1
fi

duplicate_sha_args="${args%]},\"--reviewed-manifest-sha256\",\"$(printf 'b%.0s' {1..64})\"]"
duplicate_sha_b64="$(printf '%s' "$duplicate_sha_args" | base64 | tr -d '\n')"
if CUSTOMER_EMAIL_RECONCILIATION_IMAGE="$digest" \
  CUSTOMER_EMAIL_RECONCILIATION_ARGS_B64="$duplicate_sha_b64" \
  CUSTOMER_EMAIL_RECONCILIATION_RELEASE_SHA="$release_sha" \
  CUSTOMER_EMAIL_RECONCILIATION_CHANGE_CONTROL_REF='EVNSolution/clever-change-control#265' \
  CUSTOMER_EMAIL_RECONCILIATION_MANIFEST_SHA256="$(printf 'a%.0s' {1..64})" \
  CUSTOMER_EMAIL_RECONCILIATION_APPROVAL_REF='EVNSolution/clever-change-control#265:comment-123' \
  "$wrapper" --render-host-script >/dev/null 2>&1; then
  echo 'duplicate reviewed manifest hash was accepted' >&2
  exit 1
fi

wrong_manifest_args="${args/\/run\/reconciliation\/manifest.json/\/tmp\/reviewed.json}"
wrong_manifest_b64="$(printf '%s' "$wrong_manifest_args" | base64 | tr -d '\n')"
if CUSTOMER_EMAIL_RECONCILIATION_IMAGE="$digest" \
  CUSTOMER_EMAIL_RECONCILIATION_ARGS_B64="$wrong_manifest_b64" \
  CUSTOMER_EMAIL_RECONCILIATION_RELEASE_SHA="$release_sha" \
  CUSTOMER_EMAIL_RECONCILIATION_CHANGE_CONTROL_REF='EVNSolution/clever-change-control#265' \
  CUSTOMER_EMAIL_RECONCILIATION_MANIFEST_SHA256="$(printf 'a%.0s' {1..64})" \
  CUSTOMER_EMAIL_RECONCILIATION_APPROVAL_REF='EVNSolution/clever-change-control#265:comment-123' \
  "$wrapper" --render-host-script >/dev/null 2>&1; then
  echo 'non-canonical manifest container path was accepted' >&2
  exit 1
fi

mock_dir="$(mktemp -d)"
trap 'rm -rf "$mock_dir"' EXIT
mock_log="$mock_dir/aws.log"
cat >"$mock_dir/aws" <<'MOCK_AWS'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$MOCK_AWS_LOG"
case "$1 ${2:-}" in
  'sts get-caller-identity') printf '%s\n' 'arn:aws:sts::123456789012:assumed-role/route-ops/reviewer-session' ;;
  'ssm send-command')
    while [ "$#" -gt 0 ]; do
      if [ "$1" = '--parameters' ]; then cp "${2#file://}" "$MOCK_CAPTURED_PARAMETERS"; break; fi
      shift
    done
    printf '%s\n' '11111111-1111-4111-8111-111111111111'
    ;;
  'ssm get-command-invocation')
    if [ "${MOCK_INVOCATION_STATUS:-Success}" = Success ]; then
      pretty_result="$(printf '{\n  \"mode\": \"%s\",\n  \"mutationCount\": 0\n}\n' "${MOCK_RESULT_MODE:-apply}")"
      result_frame="$(MOCK_RESULT_MODE="${MOCK_RESULT_MODE:-apply}" MOCK_RESULT_TAMPER="${MOCK_RESULT_TAMPER:-none}" python3 - <<'PY' | base64 | tr -d '\n'
import json, os
mode = os.environ['MOCK_RESULT_MODE']
result = {
    'disposition': 'DO_NOT_SEND',
    'itemCount': 1,
    'manifestSha256': ('a' if mode == 'apply' else 'b') * 64,
    'mode': mode,
    'scope': {'appId': 'clever', 'shopId': '00000000-0000-0000-0000-000000000001'},
    'ssmCommandId': '11111111-1111-4111-8111-111111111111',
}
tamper = os.environ['MOCK_RESULT_TAMPER']
if tamper == 'manifest': result['manifestSha256'] = 'c' * 64
if tamper == 'scope': result['scope']['shopId'] = '00000000-0000-0000-0000-000000000099'
if tamper == 'count': result['itemCount'] = 2
if tamper == 'command': result['ssmCommandId'] = '22222222-2222-4222-8222-222222222222'
print(json.dumps(result, sort_keys=True, separators=(',', ':')))
PY
)"
      RESULT_FRAME="$result_frame" PRETTY_RESULT="$pretty_result" python3 - <<'PY'
import json, os
print(json.dumps({
    'Status': 'Success',
    'ResponseCode': 0,
    'StandardOutputContent': os.environ['PRETTY_RESULT'] + '\nCUSTOMER_EMAIL_RECONCILIATION_RESULT_B64=' + os.environ['RESULT_FRAME'] + '\n',
}))
PY
    else
      printf '%s\n' '{"Status":"Failed","ResponseCode":1,"StandardOutputContent":""}'
    fi
    ;;
esac
MOCK_AWS
cat >"$mock_dir/gh" <<'MOCK_GH'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *'/collaborators/'*'/permission' ]]; then
  printf '{"permission":"%s","role_name":"%s"}\n' "$MOCK_APPROVAL_PERMISSION" "$MOCK_APPROVAL_PERMISSION"
  exit 0
fi
python3 - <<'PY'
import json, os
print(json.dumps({
    'id': 123,
    'html_url': 'https://github.com/EVNSolution/clever-change-control/issues/265#issuecomment-123',
    'issue_url': f"https://api.github.com/repos/EVNSolution/clever-change-control/issues/{os.environ.get('MOCK_APPROVAL_ISSUE', '265')}",
    'user': {'login': os.environ['MOCK_APPROVAL_AUTHOR']},
    'body': '\n'.join([
        'APPROVED CUSTOMER EMAIL DO-NOT-SEND',
        f"manifest-sha256: {os.environ['MOCK_MANIFEST_SHA256']}",
        f"release-sha: {os.environ['MOCK_RELEASE_SHA']}",
        f"image-digest: {os.environ['MOCK_IMAGE']}",
    ]) if os.environ.get('MOCK_APPROVAL_BODY', 'valid') == 'valid' else 'APPROVED CUSTOMER EMAIL DO-NOT-SEND',
}))
PY
MOCK_GH
chmod +x "$mock_dir/aws" "$mock_dir/gh"

run_mocked_wrapper() {
  PATH="$mock_dir:$PATH" \
  MOCK_AWS_LOG="$mock_log" \
  MOCK_CAPTURED_PARAMETERS="$mock_dir/parameters.json" \
  MOCK_APPROVAL_AUTHOR="$1" \
  MOCK_APPROVAL_BODY="${2:-valid}" \
  MOCK_INVOCATION_STATUS="${3:-Success}" \
  MOCK_APPROVAL_ISSUE="${4:-265}" \
  MOCK_RESULT_MODE="${5:-apply}" \
  MOCK_APPROVAL_PERMISSION="${6:-admin}" \
  MOCK_RESULT_TAMPER="${8:-none}" \
  MOCK_MANIFEST_SHA256="$(printf 'a%.0s' {1..64})" \
  MOCK_RELEASE_SHA="$release_sha" \
  MOCK_IMAGE="$digest" \
  CUSTOMER_EMAIL_RECONCILIATION_IMAGE="$digest" \
  CUSTOMER_EMAIL_RECONCILIATION_ARGS_B64="${7:-$args_b64}" \
  CUSTOMER_EMAIL_RECONCILIATION_RELEASE_SHA="$release_sha" \
  CUSTOMER_EMAIL_RECONCILIATION_CHANGE_CONTROL_REF='EVNSolution/clever-change-control#265' \
  CUSTOMER_EMAIL_RECONCILIATION_MANIFEST_SHA256="$(printf 'a%.0s' {1..64})" \
  CUSTOMER_EMAIL_RECONCILIATION_APPROVAL_REF='EVNSolution/clever-change-control#265:comment-123' \
  CUSTOMER_EMAIL_RECONCILIATION_INSTANCE_ID='i-local-test' \
  CUSTOMER_EMAIL_RECONCILIATION_CALLER_ARN='caller-spoof-must-be-ignored' \
  CUSTOMER_EMAIL_RECONCILIATION_MANIFEST_PATH=/srv/clever-route-server/operator/reconciliation/reviewed.json \
  "$wrapper"
}

approved_output="$(run_mocked_wrapper release-manager)"
grep -Fq 'SSM_RECONCILIATION_COMMAND_ID=11111111-1111-4111-8111-111111111111' <<<"$approved_output"
grep -Fq 'ssm send-command' "$mock_log"
grep -Fq 'ssm wait command-executed' "$mock_log"
grep -Fq 'ssm get-command-invocation' "$mock_log"
grep -Fq -- '--overwrite --value 11111111-1111-4111-8111-111111111111' "$mock_log"
python3 - "$mock_dir/parameters.json" "$mock_dir/host.sh" <<'PY'
import base64, json, re, sys
command = json.load(open(sys.argv[1], encoding='utf-8'))['commands'][0]
encoded = re.fullmatch(r"printf '%s' '([^']+)' \| base64 -d \| bash", command).group(1)
open(sys.argv[2], 'wb').write(base64.b64decode(encoded, validate=True))
PY
grep -Fq 'CALLER_ARN=arn:aws:sts::123456789012:assumed-role/route-ops/reviewer-session' "$mock_dir/host.sh"
! grep -Fq 'caller-spoof-must-be-ignored' "$mock_dir/host.sh"

: >"$mock_log"
if run_mocked_wrapper unapproved-user valid Success 265 apply write >/dev/null 2>&1; then
  echo 'unapproved GitHub comment author was accepted' >&2
  exit 1
fi
! grep -Fq 'ssm send-command' "$mock_log"

: >"$mock_log"
if run_mocked_wrapper release-manager valid Success 999 >/dev/null 2>&1; then
  echo 'approval comment from another issue was accepted' >&2
  exit 1
fi
! grep -Fq 'ssm send-command' "$mock_log"

: >"$mock_log"
if run_mocked_wrapper release-manager invalid >/dev/null 2>&1; then
  echo 'approval without manifest/release/image binding was accepted' >&2
  exit 1
fi
! grep -Fq 'ssm send-command' "$mock_log"

: >"$mock_log"
if run_mocked_wrapper release-manager valid Failed >/dev/null 2>&1; then
  echo 'failed SSM invocation was reported as successful' >&2
  exit 1
fi
grep -Fq 'ssm get-command-invocation' "$mock_log"

: >"$mock_log"
dry_output="$(run_mocked_wrapper release-manager valid Success 265 dry-run admin "$dry_args_b64")"
grep -Fq 'SSM_RECONCILIATION_COMMAND_ID=11111111-1111-4111-8111-111111111111' <<<"$dry_output"
grep -Fq 'ssm get-command-invocation' "$mock_log"

for tamper in manifest scope count command; do
  : >"$mock_log"
  if run_mocked_wrapper release-manager valid Success 265 apply admin "$args_b64" "$tamper" >/dev/null 2>&1; then
    echo "tampered SSM result was accepted: $tamper" >&2
    exit 1
  fi
  grep -Fq 'ssm get-command-invocation' "$mock_log"
done

: >"$mock_log"
if run_mocked_wrapper release-manager valid Success 265 dry-run admin "$args_b64" >/dev/null 2>&1; then
  echo 'SSM result mode different from requested mode was accepted' >&2
  exit 1
fi

echo 'ssm customer email reconciliation wrapper checks passed'
