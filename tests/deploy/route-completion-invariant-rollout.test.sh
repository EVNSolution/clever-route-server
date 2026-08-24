#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

grep -Fq 'DRIVER_ROUTE_COMPLETION_INVARIANT_MODE=OBSERVE' apps/delivery-api/.env.example
grep -Fq 'driver:route-completion-invariant:report' apps/delivery-api/package.json
grep -Fq 'ROUTE_COMPLETION_INCOMPLETE' apps/delivery-api/docs/api/openapi.yaml
grep -Fq 'workflow_dispatch:' .github/workflows/route-completion-invariant-mode.yml
grep -Fq 'source_sha:' .github/workflows/route-completion-invariant-mode.yml
grep -Fq 'target_mode:' .github/workflows/route-completion-invariant-mode.yml
grep -Fq 'scripts/ssm-route-completion-invariant-mode.sh' .github/workflows/route-completion-invariant-mode.yml

bash -n scripts/ssm-route-completion-invariant-mode.sh
rendered="$(ROUTE_COMPLETION_SOURCE_SHA=0123456789012345678901234567890123456789 \
  ROUTE_COMPLETION_TARGET_MODE=GUARDED \
  scripts/ssm-route-completion-invariant-mode.sh --render-host-script)"
case "$rendered" in
  *'COMMIT_SHA=0123456789012345678901234567890123456789'*'TARGET_MODE=GUARDED'*'runtime-env.before-route-completion-mode-'*) ;;
  *) echo 'mode-change host script must pin source/mode and back up runtime env' >&2; exit 1 ;;
esac
case "$rendered" in
  *'docker compose'*'force-recreate'*'clever-route-api'*'/healthz'*'rollback'*) ;;
  *) echo 'mode-change host script must restart, health-check, and rollback' >&2; exit 1 ;;
esac
case "$rendered" in
  *'prisma'*|*'psql'*|*'INSERT '*|*'UPDATE '*|*'DELETE '*)
    echo 'mode-change lane must not mutate the database' >&2
    exit 1
    ;;
esac

printf '{"ok":true,"contract":"route-completion-invariant-rollout"}\n'
