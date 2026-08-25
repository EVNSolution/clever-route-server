#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
wrapper="$repo_root/scripts/ssm-customer-email-reconciliation.sh"
digest="ghcr.io/evnsolution/clever-route-server-delivery-api@sha256:$(printf 'a%.0s' {1..64})"
release_sha="$(printf 'b%.0s' {1..40})"
args='["--apply","--manifest","/run/reconciliation/manifest.json","--reviewed-manifest-sha256","aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","--change-control-ref","EVNSolution/clever-change-control#265","--reason-code","HISTORICAL_DO_NOT_SEND","--app-id","clever","--shop-id","00000000-0000-0000-0000-000000000001","--disposition","do-not-send"]'
args_b64="$(printf '%s' "$args" | base64 | tr -d '\n')"

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
grep -Fq 'CUSTOMER_EMAIL_OPERATOR_ACTOR=' <<<"$rendered"
grep -Fq 'CUSTOMER_EMAIL_SSM_COMMAND_ID=' <<<"$rendered"
grep -Fq 'customer-email-reconciliation:' <<<"$rendered"
grep -Fq 'RECONCILIATION_DATABASE_URL' <<<"$rendered"
! grep -Fq 'docker-compose.prod.yml run' <<<"$rendered"
! grep -Eq 'firebase-fcm|driver-proof-media|customer-email-assets' <<<"$rendered"
! grep -Eq 'tsx|npm run' <<<"$rendered"

"$wrapper" --smoke-compiled-cli >/dev/null

if CUSTOMER_EMAIL_RECONCILIATION_IMAGE=registry.example/delivery-api:latest \
  CUSTOMER_EMAIL_RECONCILIATION_ARGS_B64="$args_b64" \
  "$wrapper" --render-host-script >/dev/null 2>&1; then
  echo 'mutable image tag was accepted' >&2
  exit 1
fi

echo 'ssm customer email reconciliation wrapper checks passed'
