#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
wrapper="$repo_root/scripts/ssm-customer-email-reconciliation.sh"
digest="registry.example/delivery-api@sha256:$(printf 'a%.0s' {1..64})"
args='["--apply","--fact-id","00000000-0000-0000-0000-000000000001","--manifest","/run/reconciliation/manifest.json"]'
args_b64="$(printf '%s' "$args" | base64 | tr -d '\n')"

rendered="$(
  CUSTOMER_EMAIL_RECONCILIATION_IMAGE="$digest" \
  CUSTOMER_EMAIL_RECONCILIATION_ARGS_B64="$args_b64" \
  CUSTOMER_EMAIL_RECONCILIATION_MANIFEST_PATH=/srv/clever-route-server/operator/reconciliation/reviewed.json \
  "$wrapper" --render-host-script
)"

grep -Fq 'node dist/scripts/reconcile-customer-email.js' <<<"$rendered"
grep -Fq '/run/reconciliation/manifest.json:ro' <<<"$rendered"
grep -Fq -- "--dispatch-id" <<<"$rendered"
! grep -Eq 'tsx|npm run' <<<"$rendered"

if CUSTOMER_EMAIL_RECONCILIATION_IMAGE=registry.example/delivery-api:latest \
  CUSTOMER_EMAIL_RECONCILIATION_ARGS_B64="$args_b64" \
  "$wrapper" --render-host-script >/dev/null 2>&1; then
  echo 'mutable image tag was accepted' >&2
  exit 1
fi

echo 'ssm customer email reconciliation wrapper checks passed'
