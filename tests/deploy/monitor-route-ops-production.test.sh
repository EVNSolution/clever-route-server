#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

rendered="$(ROUTE_OPS_EXPECT_PUBLIC_OPENFREEMAP=true ROUTE_OPS_EXPECT_GEOCODER_CONFIGURED=true scripts/monitor-route-ops-production.sh --render-host-script)"

case "$rendered" in
  *"SECTION=host_disk"*"SECTION=production_smoke"*) ;;
  *) echo "monitor host script must include status and smoke sections" >&2; exit 1 ;;
esac
case "$rendered" in
  *"export ROUTE_OPS_MONITOR_STATUS_ONLY=false"*"export ROUTE_OPS_EXPECT_PUBLIC_OPENFREEMAP=true"*"export ROUTE_OPS_EXPECT_GEOCODER_CONFIGURED=true"*) ;;
  *) echo "monitor host script must render self-contained production defaults for SSM" >&2; exit 1 ;;
esac
case "$rendered" in
  *"ROUTE_OPS_EXPECT_PUBLIC_OPENFREEMAP"*"ROUTE_OPS_EXPECT_GEOCODER_CONFIGURED"*) ;;
  *) echo "monitor host script must pass production smoke expectation env" >&2; exit 1 ;;
esac
case "$rendered" in
  *"docker', 'run', '--rm'"*"/tmp/route-ops-smoke.mjs"*) ;;
  *) echo "monitor smoke must run through the deployed runtime image instead of host node" >&2; exit 1 ;;
esac
case "$rendered" in
  *"clever_admin_ui=<redacted>"*|*"clever_admin_ui=[^"*) ;;
  *) echo "monitor output must redact admin cookies" >&2; exit 1 ;;
esac

status_only="$(scripts/monitor-route-ops-production.sh --render-host-script --status-only)"
case "$status_only" in
  *"export ROUTE_OPS_MONITOR_STATUS_ONLY=true"* ) ;;
  *) echo "monitor host script must support status-only mode" >&2; exit 1 ;;
esac

printf '{"ok":true,"monitor":"scripts/monitor-route-ops-production.sh"}\n'
