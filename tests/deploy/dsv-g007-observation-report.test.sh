#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
logs="$tmp_dir/request-log.jsonl"
report="$tmp_dir/report.json"

cat > "$logs" <<'JSONL'
{"time":"2026-07-23T00:00:00.900Z","req":{"method":"GET","url":"/api/dsv/v1/dispatches"},"reqId":"req-v1"}
{"time":"2026-07-23T00:00:01.000Z","method":"GET","path":"/api/dsv/v1/dispatches","requestId":"req-v1","callerSurface":"local-remote-fixture-e2e","legacyCategory":"v1_read"}
{"time":"2026-07-23T00:00:02.000Z","method":"POST","path":"/api/dsv/seller-orders/7f2c7d8e-1111-4222-8333-111111111111/assignment/reassign","requestId":"req-alias","callerSurface":"local-remote-fixture-e2e"}
{"time":"2026-07-23T00:00:03.000Z","method":"GET","path":"/api/dsv/dispatches","requestId":"req-legacy-read","callerSurface":"legacy-admin"}
{"time":"2026-07-23T00:00:04.000Z","method":"POST","path":"/api/dsv/imports","requestId":"req-legacy-write","callerSurface":"legacy-admin"}
{"time":"2026-07-23T00:00:05.000Z","method":"POST","path":"/api/dsv/v1/dispatches","requestId":"req-ignored","callerSurface":"local-remote-fixture-e2e"}
JSONL

scripts/dsv-g007-observation-report.sh \
  --input "$logs" \
  --started-at 2026-07-23T00:00:00.000Z \
  --ended-at 2026-07-23T00:10:00.000Z > "$report"

python3 - "$report" <<'PY'
import json
import sys

report = json.load(open(sys.argv[1], encoding='utf-8'))
assert report['schemaVersion'] == 1
assert report['startedAt'] == '2026-07-23T00:00:00.000Z'
assert report['endedAt'] == '2026-07-23T00:10:00.000Z'
assert report['windowSeconds'] == 600
counts = report['counts']
assert counts['GET /api/dsv/v1/dispatches']['v1_read'] == 1
assert counts['POST /api/dsv/seller-orders/:sellerOrderId/assignment/reassign']['canonical_assignment_command_alias'] == 1
assert counts['GET /api/dsv/dispatches']['legacy_read'] == 1
assert counts['POST /api/dsv/imports']['legacy_write'] == 1
assert report['sampledRequestIds']['legacy_read'] == ['req-legacy-read']
assert report['sampledRequestIds']['legacy_write'] == ['req-legacy-write']
assert report['callerSurface']['local-remote-fixture-e2e'] == ['req-v1', 'req-alias']
assert report['routeMethodSamples']['POST /api/dsv/seller-orders/:sellerOrderId/assignment/reassign'] == ['req-alias']
assert report['legacyZeroEvidence'] == {'legacy_read': False, 'legacy_write': False}
PY

zero_report="$(printf '%s\n' '{"method":"GET","path":"/api/dsv/v1/dispatches","requestId":"req-zero","callerSurface":"fixture"}' | scripts/dsv-g007-observation-report.sh)"
case "$zero_report" in
  *'"legacy_read": true'*'"legacy_write": true'*) ;;
  *) echo "zero-evidence report must mark legacy read/write as true only when absent" >&2; exit 1 ;;
esac

printf '{"ok":true,"monitor":"scripts/dsv-g007-observation-report.sh"}\n'
