#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

grep -Fq 'DRIVER_ROUTE_COMPLETION_INVARIANT_MODE=OBSERVE' apps/delivery-api/.env.example
grep -Fq 'driver:route-completion-invariant:report' apps/delivery-api/package.json
grep -Fq 'ROUTE_COMPLETION_INCOMPLETE' apps/delivery-api/docs/api/openapi.yaml
grep -Fq 'workflow_dispatch:' .github/workflows/route-completion-invariant-mode.yml
grep -Fq 'source_sha:' .github/workflows/route-completion-invariant-mode.yml
grep -Fq 'target_mode:' .github/workflows/route-completion-invariant-mode.yml
grep -Fq 'evidence_artifact_id:' .github/workflows/route-completion-invariant-mode.yml
grep -Fq 'Route completion invariant evidence' .github/workflows/route-completion-invariant-evidence.yml
grep -Fq 'validate-route-completion-rollout-evidence.mjs' .github/workflows/route-completion-invariant-mode.yml
grep -Fq 'verify-route-completion-alarm.sh' .github/workflows/route-completion-invariant-mode.yml
grep -Fq 'scripts/ssm-route-completion-invariant-mode.sh' .github/workflows/route-completion-invariant-mode.yml

bash -n scripts/ssm-route-completion-invariant-mode.sh scripts/verify-route-completion-alarm.sh
rendered="$(ROUTE_COMPLETION_SOURCE_SHA=0123456789012345678901234567890123456789 \
  ROUTE_COMPLETION_EXPECTED_CURRENT_MODE=OBSERVE \
  ROUTE_COMPLETION_TARGET_MODE=GUARDED \
  scripts/ssm-route-completion-invariant-mode.sh --render-host-script)"
case "$rendered" in
  *'COMMIT_SHA=0123456789012345678901234567890123456789'*'TARGET_MODE=GUARDED'*'runtime-env.before-route-completion-mode-'*) ;;
  *) echo 'mode-change host script must pin source/mode and back up runtime env' >&2; exit 1 ;;
esac
for contract in '.deploy/route-ops-simple-deploy.lock.d' 'wait_health' 'rollback failed to restore healthy service' 'EXPECTED_CURRENT_MODE=OBSERVE'; do
  grep -Fq "$contract" <<<"$rendered" || { echo 'mode-change host script must share the deploy lock and validate forward/rollback health' >&2; exit 1; }
done
for contract in 'docker compose' 'force-recreate' 'clever-route-api' '/healthz' 'rollback'; do
  grep -Fq "$contract" <<<"$rendered" || { echo 'mode-change host script must restart, health-check, and rollback' >&2; exit 1; }
done
case "$rendered" in
  *'prisma'*|*'psql'*|*'INSERT '*|*'UPDATE '*|*'DELETE '*)
    echo 'mode-change lane must not mutate the database' >&2
    exit 1
    ;;
esac

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
node - "$tmp_dir/evidence.json" <<'NODE'
const fs = require('node:fs');
fs.writeFileSync(process.argv[2], JSON.stringify({
  activeSessions: { adoptionPercent: 100, legacyActiveCount: 0 },
  currentMode: 'OBSERVE', generatedAt: new Date().toISOString(),
  gate: { consecutiveCleanReviewedDays: 7, falsePositiveCount: 0, minimumDailySampleCount: 1, recoveryCohortCount: 200, recoveryWithinFiveMinutesPercent: 99.5, unreviewedWouldRejectCount: 0 },
  legacyRetirementVerified: true, recoveryVerified: true,
  sourceSha: '0123456789012345678901234567890123456789'
}));
NODE
node scripts/validate-route-completion-rollout-evidence.mjs "$tmp_dir/evidence.json" 0123456789012345678901234567890123456789 OBSERVE GUARDED >/dev/null
if node scripts/validate-route-completion-rollout-evidence.mjs "$tmp_dir/evidence.json" 0123456789012345678901234567890123456789 OBSERVE FULL >/dev/null 2>&1; then
  echo 'OBSERVE to FULL must fail closed' >&2; exit 1
fi
node - "$tmp_dir/evidence.json" <<'NODE'
const fs = require('node:fs'); const path = process.argv[2]; const value = JSON.parse(fs.readFileSync(path));
value.gate.falsePositiveCount = 1; fs.writeFileSync(path, JSON.stringify(value));
NODE
if node scripts/validate-route-completion-rollout-evidence.mjs "$tmp_dir/evidence.json" 0123456789012345678901234567890123456789 OBSERVE GUARDED >/dev/null 2>&1; then
  echo 'false-positive evidence must fail closed' >&2; exit 1
fi

mkdir "$tmp_dir/bin"
cat > "$tmp_dir/bin/aws" <<'AWS'
#!/usr/bin/env bash
case "$1 $2" in
  'cloudwatch describe-alarms')
    if [[ "$*" == *ActionsEnabled* ]]; then echo True; else echo "$ROUTE_COMPLETION_ALARM_TOPIC_ARN"; fi ;;
  'sns list-subscriptions-by-topic') echo "${MOCK_CONFIRMED_SUBSCRIPTIONS:-1}" ;;
  *) exit 2 ;;
esac
AWS
chmod +x "$tmp_dir/bin/aws"
PATH="$tmp_dir/bin:$PATH" ROUTE_COMPLETION_TARGET_MODE=GUARDED ROUTE_COMPLETION_OBSERVE_ALARM_NAME=observe-alarm ROUTE_COMPLETION_REJECT_ALARM_NAME=reject-alarm \
  ROUTE_COMPLETION_ALARM_TOPIC_ARN=arn:aws:sns:ap-northeast-2:123:approved scripts/verify-route-completion-alarm.sh >/dev/null
if PATH="$tmp_dir/bin:$PATH" MOCK_CONFIRMED_SUBSCRIPTIONS=0 ROUTE_COMPLETION_TARGET_MODE=FULL ROUTE_COMPLETION_OBSERVE_ALARM_NAME=observe-alarm ROUTE_COMPLETION_REJECT_ALARM_NAME=reject-alarm \
  ROUTE_COMPLETION_ALARM_TOPIC_ARN=arn:aws:sns:ap-northeast-2:123:approved scripts/verify-route-completion-alarm.sh >/dev/null 2>&1; then
  echo 'unconfirmed SNS subscription must fail closed' >&2; exit 1
fi

printf '{"ok":true,"contract":"route-completion-invariant-rollout"}\n'
