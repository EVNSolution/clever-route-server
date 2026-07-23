#!/usr/bin/env bash
set -euo pipefail

INPUT="-"
STARTED_AT=""
ENDED_AT=""
SAMPLE_LIMIT="${DSV_G007_OBSERVATION_SAMPLE_LIMIT:-20}"

usage() {
  cat <<'USAGE'
Usage: scripts/dsv-g007-observation-report.sh [--input PATH] [--started-at ISO] [--ended-at ISO]

Aggregates structured JSON request logs into the G007 DSV API observation report.
Input may be newline-delimited JSON or a JSON array. The report is written to stdout.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --input)
      INPUT="${2:-}"
      [ -n "$INPUT" ] || { echo "dsv-g007-observation-report: --input requires a path" >&2; exit 64; }
      shift
      ;;
    --started-at)
      STARTED_AT="${2:-}"
      [ -n "$STARTED_AT" ] || { echo "dsv-g007-observation-report: --started-at requires a value" >&2; exit 64; }
      shift
      ;;
    --ended-at)
      ENDED_AT="${2:-}"
      [ -n "$ENDED_AT" ] || { echo "dsv-g007-observation-report: --ended-at requires a value" >&2; exit 64; }
      shift
      ;;
    -h|--help) usage; exit 0 ;;
    *) echo "dsv-g007-observation-report: unknown argument: $1" >&2; usage >&2; exit 64 ;;
  esac
  shift
done

python3 - "$INPUT" "$STARTED_AT" "$ENDED_AT" "$SAMPLE_LIMIT" <<'PY'
from datetime import datetime, timezone
import json
import re
import sys

input_path, started_arg, ended_arg, sample_limit_raw = sys.argv[1:5]
try:
    sample_limit = max(1, int(sample_limit_raw))
except ValueError:
    print("dsv-g007-observation-report: sample limit must be an integer", file=sys.stderr)
    sys.exit(64)

categories = (
    "v1_read",
    "canonical_assignment_command_alias",
    "legacy_read",
    "legacy_write",
)


def parse_instant(value):
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        # Pino timestamps are milliseconds; small epoch values are seconds.
        seconds = float(value) / 1000 if value > 10_000_000_000 else float(value)
        return datetime.fromtimestamp(seconds, timezone.utc)
    if not isinstance(value, str):
        return None
    raw = value.strip()
    if not raw:
        return None
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        return None


def format_instant(value):
    if value is None:
        return None
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def first(payload, paths):
    for path in paths:
        value = payload
        for part in path.split("."):
            if not isinstance(value, dict):
                value = None
                break
            value = value.get(part)
        if value not in (None, ""):
            return value
    return None


def load_records():
    raw = sys.stdin.read() if input_path == "-" else open(input_path, encoding="utf-8").read()
    stripped = raw.strip()
    if not stripped:
        return []
    records = []
    if stripped.startswith("["):
        parsed = json.loads(stripped)
        if not isinstance(parsed, list):
            raise ValueError("JSON array input must contain objects")
        items = parsed
    else:
        items = []
        for line_number, line in enumerate(raw.splitlines(), 1):
            line = line.strip()
            if not line:
                continue
            try:
                items.append(json.loads(line))
            except json.JSONDecodeError as exc:
                raise ValueError(f"line {line_number}: {exc}") from exc
    for item in items:
        if isinstance(item, dict):
            records.append(item)
    return records


def normalize_route(method, raw_path):
    path = raw_path.split("?", 1)[0]
    path = re.sub(r"/+", "/", path)
    alias = re.compile(r"^/api/dsv/seller-orders/[^/]+/assignment/(reassign|unassign)$")
    match = alias.match(path)
    if method == "POST" and match:
        return f"/api/dsv/seller-orders/:sellerOrderId/assignment/{match.group(1)}"
    path = re.sub(r"/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?=/|$)", "/:id", path)
    path = re.sub(r"/\d+(?=/|$)", "/:id", path)
    return path


def infer_category(method, route):
    if method == "GET" and route.startswith("/api/dsv/v1/"):
        return "v1_read"
    if method == "POST" and route in {
        "/api/dsv/seller-orders/:sellerOrderId/assignment/reassign",
        "/api/dsv/seller-orders/:sellerOrderId/assignment/unassign",
    }:
        return "canonical_assignment_command_alias"
    if route.startswith("/api/dsv/") and not route.startswith("/api/dsv/v1/"):
        return "legacy_read" if method == "GET" else "legacy_write"
    return None


def add_sample(bucket, request_id):
    if request_id and request_id not in bucket and len(bucket) < sample_limit:
        bucket.append(request_id)


try:
    records = load_records()
except (OSError, ValueError, json.JSONDecodeError) as exc:
    print(f"dsv-g007-observation-report: {exc}", file=sys.stderr)
    sys.exit(65)

explicit_request_ids = set()
for record in records:
    request_id = str(first(record, ("requestId", "reqId", "req.id", "request.id")) or "")
    explicit_category = first(record, ("legacyCategory", "dsvApiCategory", "category"))
    if request_id and explicit_category in categories:
        explicit_request_ids.add(request_id)

started = parse_instant(started_arg)
ended = parse_instant(ended_arg)
observed_times = []
counts = {}
sampled = {category: [] for category in categories}
route_samples = {}
caller_surface = {}
ignored = 0

for record in records:
    method = str(first(record, ("method", "req.method", "request.method", "http.method")) or "").upper()
    raw_path = str(first(record, ("route", "path", "url", "req.route", "req.url", "request.path", "request.url")) or "")
    request_id = str(first(record, ("requestId", "reqId", "req.id", "request.id")) or "")
    caller = str(first(record, ("callerSurface", "caller_surface", "request.callerSurface")) or "unknown")
    explicit_category = first(record, ("legacyCategory", "dsvApiCategory", "category"))
    instant = parse_instant(first(record, ("time", "timestamp", "ts", "startedAt")))

    if not method or not raw_path:
        ignored += 1
        continue
    if request_id in explicit_request_ids and explicit_category not in categories:
        ignored += 1
        continue
    route = normalize_route(method, raw_path)
    category = str(explicit_category) if explicit_category in categories else infer_category(method, route)
    if category not in categories:
        ignored += 1
        continue

    key = f"{method} {route}"
    counts.setdefault(key, {})
    counts[key][category] = counts[key].get(category, 0) + 1
    add_sample(sampled[category], request_id)
    route_samples.setdefault(key, [])
    add_sample(route_samples[key], request_id)
    caller_surface.setdefault(caller, [])
    add_sample(caller_surface[caller], request_id)
    if instant is not None:
        observed_times.append(instant)

if started is None and observed_times:
    started = min(observed_times)
if ended is None and observed_times:
    ended = max(observed_times)
if started is None:
    started = datetime.now(timezone.utc)
if ended is None:
    ended = started

window_seconds = max(0, int((ended - started).total_seconds()))
legacy_reads = sum(route_counts.get("legacy_read", 0) for route_counts in counts.values())
legacy_writes = sum(route_counts.get("legacy_write", 0) for route_counts in counts.values())

report = {
    "schemaVersion": 1,
    "startedAt": format_instant(started),
    "endedAt": format_instant(ended),
    "windowSeconds": window_seconds,
    "counts": dict(sorted(counts.items())),
    "sampledRequestIds": sampled,
    "routeMethodSamples": dict(sorted(route_samples.items())),
    "callerSurface": dict(sorted(caller_surface.items())),
    "legacyZeroEvidence": {
        "legacy_read": legacy_reads == 0,
        "legacy_write": legacy_writes == 0,
    },
    "ignoredRecords": ignored,
}
print(json.dumps(report, indent=2, sort_keys=True))
PY
