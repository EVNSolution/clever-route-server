#!/usr/bin/env bash
set -euo pipefail

DEFAULT_CURRENT_S3_URI="s3://clever-route-prod-artifacts-902837199612-ap-northeast-2/route-engine/graphs/v7/current.json"
DEFAULT_DEST_ROOT="/srv/clever-route-server/data/route-engine/graphs"
PYTHON_BIN="${PYTHON_BIN:-python3}"
AWS_BIN="${AWS_BIN:-aws}"

usage() {
  cat >&2 <<'EOF'
Usage: scripts/provision-route-engine-graph-from-s3.sh [options]

Downloads the approved route_engine graph artifact from private S3, validates
bundle SHA-256 plus canonical graph manifest SHA, and atomically points
<dest-root>/current at the verified version. It does not deploy, restart, or
remove existing graph versions.

Options:
  --current-s3-uri <s3://bucket/key>     Current pointer JSON. Defaults to the production graph pointer.
  --dest-root <dir>                     Versioned graph root. Defaults to /srv/clever-route-server/data/route-engine/graphs.
  --expected-manifest-sha <sha256>      Optional fail-closed expected graph manifest SHA.
  --region <aws-region>                 Optional AWS region override; current.json region is preferred when present.
  -h, --help                            Show this help.
EOF
}

current_s3_uri="${ROUTE_ENGINE_GRAPH_S3_CURRENT_URI:-$DEFAULT_CURRENT_S3_URI}"
dest_root="${ROUTE_ENGINE_GRAPH_DEST_ROOT:-$DEFAULT_DEST_ROOT}"
expected_manifest_sha="${ROUTE_ENGINE_GRAPH_MANIFEST_SHA:-}"
region="${AWS_REGION:-${AWS_DEFAULT_REGION:-}}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --current-s3-uri)
      current_s3_uri="${2:-}"
      shift 2
      ;;
    --dest-root)
      dest_root="${2:-}"
      shift 2
      ;;
    --expected-manifest-sha)
      expected_manifest_sha="${2:-}"
      shift 2
      ;;
    --region)
      region="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage
      exit 2
      ;;
  esac
done

case "$current_s3_uri" in
  s3://clever-route-prod-artifacts-902837199612-ap-northeast-2/route-engine/graphs/v7/current.json) ;;
  *)
    echo "current S3 URI is outside the approved route_engine graph pointer: $current_s3_uri" >&2
    exit 65
    ;;
esac
if [ -n "$expected_manifest_sha" ] && ! [[ "$expected_manifest_sha" =~ ^[0-9a-f]{64}$ ]]; then
  echo "expected manifest SHA must be a 64-character lowercase hex SHA-256 value." >&2
  exit 65
fi
case "$dest_root" in
  /*) ;;
  *)
    echo "dest-root must be an absolute path: $dest_root" >&2
    exit 65
    ;;
esac

for command in "$AWS_BIN" "$PYTHON_BIN" tar; do
  command -v "$command" >/dev/null 2>&1 || { echo "required command not found: $command" >&2; exit 65; }
done
if command -v sha256sum >/dev/null 2>&1; then
  sha256_cmd=(sha256sum)
elif command -v shasum >/dev/null 2>&1; then
  sha256_cmd=(shasum -a 256)
else
  echo "sha256sum or shasum is required." >&2
  exit 65
fi

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT
current_json="$work_dir/current.json"

aws_cp_args=()
if [ -n "$region" ]; then
  aws_cp_args+=(--region "$region")
fi
"$AWS_BIN" s3 cp "$current_s3_uri" "$current_json" "${aws_cp_args[@]}" --only-show-errors

pointer_env="$work_dir/pointer.env"
"$PYTHON_BIN" - "$current_json" "$expected_manifest_sha" > "$pointer_env" <<'PY'
import json
import re
import shlex
import sys
from pathlib import Path

current_path, expected = sys.argv[1:3]
try:
    data = json.loads(Path(current_path).read_text(encoding='utf-8'))
except Exception as exc:  # noqa: BLE001 - fail closed with context.
    print(f'cannot parse route_engine graph current JSON: {exc}', file=sys.stderr)
    sys.exit(65)

required_keys = {'bucket', 'region', 'manifestSha', 'bundleKey', 'manifestKey', 'sha256Key'}
missing = sorted(required_keys - set(data))
if missing:
    print(f'current JSON missing keys: {missing}', file=sys.stderr)
    sys.exit(65)
if data.get('schema') != 'clever-route.route-engine.graph-current.v1':
    print('current JSON schema mismatch', file=sys.stderr)
    sys.exit(65)
bucket = data['bucket']
if bucket != 'clever-route-prod-artifacts-902837199612-ap-northeast-2':
    print(f'unapproved graph artifact bucket: {bucket}', file=sys.stderr)
    sys.exit(65)
sha = data['manifestSha']
if not re.fullmatch(r'[0-9a-f]{64}', sha):
    print(f'invalid manifestSha: {sha}', file=sys.stderr)
    sys.exit(65)
if expected and sha != expected:
    print(f'current manifest mismatch: expected={expected} current={sha}', file=sys.stderr)
    sys.exit(66)
base_prefix = f'route-engine/graphs/v7/{sha}/'
expected_suffixes = {
    'bundleKey': f'route-engine-graph-v7-{sha}.tar.zst',
    'manifestKey': f'route-engine-graph-v7-{sha}.manifest.json',
    'sha256Key': f'route-engine-graph-v7-{sha}.sha256',
}
for key, suffix in expected_suffixes.items():
    value = data[key]
    if value != base_prefix + suffix:
        print(f'{key} is not the deterministic approved key for manifest {sha}: {value}', file=sys.stderr)
        sys.exit(65)
for name in ('bucket', 'region', 'manifestSha', 'bundleKey', 'manifestKey', 'sha256Key'):
    print(f'{name}={shlex.quote(str(data[name]))}')
PY
# shellcheck disable=SC1090
source "$pointer_env"

aws_obj_args=(--region "$region")
bundle="$work_dir/route-engine-graph.tar.zst"
manifest="$work_dir/route-engine-graph.manifest.json"
sha_file="$work_dir/route-engine-graph.sha256"
# shellcheck disable=SC2154
"$AWS_BIN" s3 cp "s3://${bucket}/${bundleKey}" "$bundle" "${aws_obj_args[@]}" --only-show-errors
# shellcheck disable=SC2154
"$AWS_BIN" s3 cp "s3://${bucket}/${manifestKey}" "$manifest" "${aws_obj_args[@]}" --only-show-errors
# shellcheck disable=SC2154
"$AWS_BIN" s3 cp "s3://${bucket}/${sha256Key}" "$sha_file" "${aws_obj_args[@]}" --only-show-errors

expected_bundle_sha="$(awk '{print $1; exit}' "$sha_file")"
if ! [[ "$expected_bundle_sha" =~ ^[0-9a-f]{64}$ ]]; then
  echo "invalid bundle SHA file: $sha_file" >&2
  exit 65
fi
actual_bundle_sha="$("${sha256_cmd[@]}" "$bundle" | awk '{print $1}')"
if [ "$actual_bundle_sha" != "$expected_bundle_sha" ]; then
  echo "route_engine graph bundle SHA mismatch: expected=${expected_bundle_sha} actual=${actual_bundle_sha}" >&2
  exit 66
fi

while IFS= read -r member; do
  case "$member" in
    ""|/*|../*|*/../*)
      echo "unsafe graph bundle member: $member" >&2
      exit 65
      ;;
    routing_engine/v7_out/parquet/nodes.parquet|routing_engine/v7_out/parquet/physical_directed_edges.parquet|routing_engine/v7_out/parquet/destination_state_index.parquet|routing_engine/v7_out/parquet/routing_arcs_snapshot.parquet)
      ;;
    *)
      echo "unexpected graph bundle member: $member" >&2
      exit 65
      ;;
  esac
done < <(tar --zstd -tf "$bundle")

stage_dir="$work_dir/extract"
mkdir -p "$stage_dir"
tar --zstd -xf "$bundle" -C "$stage_dir"
extracted_graph_dir="$stage_dir/routing_engine/v7_out/parquet"

# shellcheck disable=SC2154
"$PYTHON_BIN" - "$extracted_graph_dir" "$manifest" "$manifestSha" <<'PY'
import hashlib
import json
import sys
from pathlib import Path

graph_dir = Path(sys.argv[1])
manifest_path = Path(sys.argv[2])
expected = sys.argv[3]
names = sorted([
    'nodes.parquet',
    'physical_directed_edges.parquet',
    'destination_state_index.parquet',
    'routing_arcs_snapshot.parquet',
])
try:
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
except Exception as exc:  # noqa: BLE001
    print(f'cannot parse manifest JSON: {exc}', file=sys.stderr)
    sys.exit(65)
lines = []
for name in names:
    path = graph_dir / name
    if not path.is_file() or path.is_symlink():
        print(f'missing or invalid graph file: {path}', file=sys.stderr)
        sys.exit(66)
    if path.stat().st_size <= 0:
        print(f'empty graph file: {path}', file=sys.stderr)
        sys.exit(66)
    digest = hashlib.sha256()
    with path.open('rb') as fh:
        first = fh.readline().strip()
        if first == b'version https://git-lfs.github.com/spec/v1':
            print(f'LFS pointer is not graph data: {path}', file=sys.stderr)
            sys.exit(66)
        fh.seek(0)
        for chunk in iter(lambda: fh.read(1024 * 1024), b''):
            digest.update(chunk)
    lines.append(f'{digest.hexdigest()}  routing_engine/v7_out/parquet/{name}\n')
manifest_text = ''.join(lines)
actual = hashlib.sha256(manifest_text.encode('utf-8')).hexdigest()
if actual != expected:
    print(f'graph manifest mismatch: expected={expected} actual={actual}', file=sys.stderr)
    sys.exit(66)
if manifest.get('manifest_sha') != expected or manifest.get('manifest_text') != manifest_text:
    print('downloaded manifest JSON does not match extracted graph files', file=sys.stderr)
    sys.exit(66)
PY

mkdir -p "$dest_root"
version_dir="$dest_root/$manifestSha"
parquet_dir="$version_dir/parquet"
if [ -e "$version_dir" ]; then
  if [ ! -d "$parquet_dir" ]; then
    echo "existing graph version is not a provisioned directory: $version_dir" >&2
    exit 66
  fi
  "$PYTHON_BIN" - "$parquet_dir" "$manifestSha" <<'PY'
import hashlib
import sys
from pathlib import Path

graph_dir = Path(sys.argv[1])
expected = sys.argv[2]
lines = []
for name in sorted(['nodes.parquet', 'physical_directed_edges.parquet', 'destination_state_index.parquet', 'routing_arcs_snapshot.parquet']):
    path = graph_dir / name
    if not path.is_file() or path.is_symlink() or path.stat().st_size <= 0:
        print(f'existing graph version is invalid: {path}', file=sys.stderr)
        sys.exit(66)
    digest = hashlib.sha256()
    with path.open('rb') as fh:
        first = fh.readline().strip()
        if first == b'version https://git-lfs.github.com/spec/v1':
            print(f'existing graph version is an LFS pointer: {path}', file=sys.stderr)
            sys.exit(66)
        fh.seek(0)
        for chunk in iter(lambda: fh.read(1024 * 1024), b''):
            digest.update(chunk)
    lines.append(f'{digest.hexdigest()}  routing_engine/v7_out/parquet/{name}\n')
actual = hashlib.sha256(''.join(lines).encode('utf-8')).hexdigest()
if actual != expected:
    print(f'existing graph version manifest mismatch: expected={expected} actual={actual}', file=sys.stderr)
    sys.exit(66)
PY
  echo "graph version already provisioned and verified: $version_dir"
else
  install_tmp="$dest_root/.install-${manifestSha}.$$"
  rm -rf "$install_tmp"
  mkdir -p "$install_tmp"
  mv "$extracted_graph_dir" "$install_tmp/parquet"
  mv "$install_tmp" "$version_dir"
  echo "graph version provisioned: $version_dir"
fi

current_path="$dest_root/current"
if [ -e "$current_path" ] && [ ! -L "$current_path" ]; then
  echo "refusing to replace non-symlink current path: $current_path" >&2
  exit 66
fi
rm -f "$dest_root/.current.tmp"
ln -s "$manifestSha" "$dest_root/.current.tmp"
mv -f "$dest_root/.current.tmp" "$current_path"

cat <<EOF
Route Engine graph S3 provision complete:
  manifest: ${manifestSha}
  bundle_sha256: ${actual_bundle_sha}
  graph_dir: ${parquet_dir}
  current: ${current_path} -> ${manifestSha}
  ROUTE_ENGINE_GRAPH_HOST_DIR=${dest_root}/current/parquet
EOF
