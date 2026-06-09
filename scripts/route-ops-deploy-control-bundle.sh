#!/usr/bin/env bash
set -euo pipefail

ROUTE_OPS_DEPLOY_CONTROL_BUCKET="route-ops-artifacts-902837199612-ap-northeast-2"
ROUTE_OPS_DEPLOY_CONTROL_PREFIX="artifacts/route-ops/prod/deploy-control"
ROUTE_OPS_DEPLOY_CONTROL_BUNDLE_FILE="route-ops-deploy-control.tar.gz"

fail() {
  echo "route-ops-deploy-control-bundle: $*" >&2
  exit 65
}

bundle_files() {
  cat <<'FILES'
infra/caddy/Caddyfile
infra/compose/docker-compose.prod.yml
scripts/deploy-route-ops-image.sh
scripts/rollback-route-ops-image.sh
scripts/ssm-route-ops-deploy.sh
scripts/smoke-route-ops-production.mjs
scripts/route-ops-deploy-control-bundle.sh
FILES
}

expected_tar_manifest() {
  {
    echo "deploy-control-manifest.json"
    bundle_files
  } | sort
}

reject_secret_like_path() {
  local path="$1"
  case "$path" in
    *.env|*.env.*|*secret*|*token*|*cookie*|*storageState*)
      fail "refusing secret-like deploy-control path: $path"
      ;;
  esac
}

validate_source_file() {
  local path="${1:?source path is required}"
  reject_secret_like_path "$path"
  python3 - "$path" <<'PY'
import os
import stat
import sys

path = sys.argv[1]

def fail(message: str) -> None:
    print(f'route-ops-deploy-control-bundle: {message}', file=sys.stderr)
    sys.exit(65)

try:
    info = os.lstat(path)
except FileNotFoundError:
    fail(f'deploy-control source path missing: {path}')

if not stat.S_ISREG(info.st_mode):
    fail(f'deploy-control source path is not a regular file: {path}')
if info.st_nlink != 1:
    fail(f'deploy-control source path must not be hardlinked: {path}')
PY
}

verify_sha() {
  local bundle_path="${1:?bundle path is required}"
  local expected_sha="${2:?expected sha is required}"
  [[ "$expected_sha" =~ ^[0-9a-fA-F]{64}$ ]] || fail "expected SHA256 must be 64 hex chars"
  test -f "$bundle_path" || fail "bundle file not found: $bundle_path"
  local actual_sha
  actual_sha="$(sha256sum "$bundle_path" | awk '{print $1}')"
  echo "$actual_sha"
  local actual_sha_lower expected_sha_lower
  actual_sha_lower="$(printf '%s' "$actual_sha" | tr '[:upper:]' '[:lower:]')"
  expected_sha_lower="$(printf '%s' "$expected_sha" | tr '[:upper:]' '[:lower:]')"
  if [ "$actual_sha_lower" != "$expected_sha_lower" ]; then
    fail "SHA256 mismatch: expected=${expected_sha_lower} actual=${actual_sha_lower}"
  fi
}

validate_tar_manifest() {
  local bundle_path="${1:?bundle path is required}"
  python3 - "$bundle_path" <<'PY'
import sys
import tarfile

bundle_path = sys.argv[1]
expected = sorted([
    'deploy-control-manifest.json',
    'infra/caddy/Caddyfile',
    'infra/compose/docker-compose.prod.yml',
    'scripts/deploy-route-ops-image.sh',
    'scripts/rollback-route-ops-image.sh',
    'scripts/ssm-route-ops-deploy.sh',
    'scripts/smoke-route-ops-production.mjs',
    'scripts/route-ops-deploy-control-bundle.sh',
])

def fail(message: str) -> None:
    print(f'route-ops-deploy-control-bundle: {message}', file=sys.stderr)
    sys.exit(65)

try:
    with tarfile.open(bundle_path, 'r:gz') as tar:
        members = tar.getmembers()
except Exception as exc:
    fail(f'cannot read deploy-control bundle tar: {exc}')

actual = sorted(member.name for member in members)
if actual != expected:
    fail(f'deploy-control bundle tar manifest mismatch: expected={expected} actual={actual}')
for member in members:
    if not member.isfile():
        fail(f'deploy-control bundle member is not a regular file: {member.name}')
PY
}

validate_extracted() {
  local extracted_dir="${1:?extracted directory is required}"
  local expected_s3_uri="${2:?expected s3 uri is required}"
  local manifest_path="$extracted_dir/deploy-control-manifest.json"
  test -f "$manifest_path" || fail "deploy-control manifest missing"
  while IFS= read -r file; do
    reject_secret_like_path "$file"
    if [ -L "$extracted_dir/$file" ] || [ ! -f "$extracted_dir/$file" ]; then
      fail "allowlisted file is not a regular file in extracted bundle: $file"
    fi
  done < <(bundle_files)
  python3 - "$manifest_path" "$expected_s3_uri" <<'PY'
import json
import re
import shlex
import sys

manifest_path, expected_s3_uri = sys.argv[1:3]
allowed_files = [
    'infra/caddy/Caddyfile',
    'infra/compose/docker-compose.prod.yml',
    'scripts/deploy-route-ops-image.sh',
    'scripts/rollback-route-ops-image.sh',
    'scripts/ssm-route-ops-deploy.sh',
    'scripts/smoke-route-ops-production.mjs',
    'scripts/route-ops-deploy-control-bundle.sh',
]
allowed_keys = {
    'schemaVersion',
    'dryRun',
    'runId',
    'commitSha',
    'imageTag',
    'prismaSchemaSha',
    'deliveryApiImage',
    'deliveryApiMigrateImage',
    'publishEvidenceUrl',
    'artifactBucket',
    'artifactPrefix',
    'bundleFile',
    's3Uri',
    'deployControlFiles',
}
patterns = {
    'runId': re.compile(r'^[0-9]+$'),
    'commitSha': re.compile(r'^[0-9a-fA-F]{40}$'),
    'imageTag': re.compile(r'^[0-9a-fA-F]{40}$'),
    'prismaSchemaSha': re.compile(r'^[0-9a-fA-F]{64}$'),
    'deliveryApiImage': re.compile(r'^ghcr\.io/evnsolution/clever-route-server-delivery-api:[0-9a-fA-F]{40}$'),
    'deliveryApiMigrateImage': re.compile(r'^ghcr\.io/evnsolution/clever-route-server-delivery-api-migrate:[0-9a-fA-F]{40}$'),
    'publishEvidenceUrl': re.compile(r'^https://github\.com/EVNSolution/clever-route-server/actions/runs/[0-9]+/?$'),
    'artifactBucket': re.compile(r'^route-ops-artifacts-902837199612-ap-northeast-2$'),
    'artifactPrefix': re.compile(r'^artifacts/route-ops/prod/deploy-control$'),
    'bundleFile': re.compile(r'^route-ops-deploy-control\.tar\.gz$'),
    's3Uri': re.compile(r'^s3://route-ops-artifacts-902837199612-ap-northeast-2/artifacts/route-ops/prod/deploy-control/[0-9]+/[0-9a-fA-F]{40}/route-ops-deploy-control\.tar\.gz$'),
}

def fail(message: str) -> None:
    print(f'route-ops deploy-control manifest invalid: {message}', file=sys.stderr)
    sys.exit(65)

try:
    with open(manifest_path, encoding='utf-8') as fh:
        manifest = json.load(fh)
except Exception as exc:  # noqa: BLE001 - host-side validation should fail closed with context.
    fail(f'cannot parse JSON: {exc}')

if set(manifest) != allowed_keys:
    fail(f'keys must exactly match allowlist; got={sorted(manifest)}')
if manifest.get('schemaVersion') != 1:
    fail('schemaVersion must be 1')
if not isinstance(manifest.get('dryRun'), bool):
    fail('dryRun must be boolean')
if manifest.get('deployControlFiles') != allowed_files:
    fail('deployControlFiles must exactly match reviewed allowlist')
for path in manifest.get('deployControlFiles', []):
    if not isinstance(path, str):
        fail('deployControlFiles entries must be strings')
    lowered = path.lower()
    if path.startswith('/') or '..' in path.split('/'):
        fail(f'deploy-control path is not repo-relative safe path: {path}')
    if path.endswith('.env') or '.env.' in path or any(marker in lowered for marker in ('secret', 'token', 'cookie', 'storagestate')):
        fail(f'secret-like deploy-control path is not allowed: {path}')
for key, pattern in patterns.items():
    value = manifest.get(key)
    if not isinstance(value, str) or not pattern.fullmatch(value):
        fail(f'{key} does not match required pattern')
if manifest['commitSha'].lower() != manifest['imageTag'].lower():
    fail('commitSha must match imageTag')
expected_uri = f"s3://{manifest['artifactBucket']}/{manifest['artifactPrefix']}/{manifest['runId']}/{manifest['commitSha']}/{manifest['bundleFile']}"
if manifest['s3Uri'] != expected_uri:
    fail('s3Uri does not match bucket/prefix/runId/commitSha/bundleFile fields')
if manifest['s3Uri'] != expected_s3_uri:
    fail('s3Uri does not match SSM DeployControlBundleS3Uri')
if not manifest['deliveryApiImage'].endswith(':' + manifest['imageTag']):
    fail('deliveryApiImage tag must match imageTag')
if not manifest['deliveryApiMigrateImage'].endswith(':' + manifest['imageTag']):
    fail('deliveryApiMigrateImage tag must match imageTag')

exports = {
    'DRY_RUN': 'true' if manifest['dryRun'] else 'false',
    'IMAGE_TAG': manifest['imageTag'],
    'PRISMA_SCHEMA_SHA': manifest['prismaSchemaSha'],
    'DELIVERY_API_IMAGE': manifest['deliveryApiImage'],
    'DELIVERY_API_MIGRATE_IMAGE': manifest['deliveryApiMigrateImage'],
    'PUBLISH_EVIDENCE_URL': manifest['publishEvidenceUrl'],
    'GITHUB_RUN_ID': manifest['runId'],
    'DEPLOY_CONTROL_BUNDLE_S3_URI': manifest['s3Uri'],
}
print('route-ops deploy-control manifest validation passed', file=sys.stderr)
for key, value in exports.items():
    print(f'{key}={shlex.quote(value)}')
PY
}

sync_extracted() {
  local extracted_dir="${1:?extracted directory is required}"
  local backup_dir="${2:?backup directory is required}"
  mkdir -p "$backup_dir"
  while IFS= read -r file; do
    reject_secret_like_path "$file"
    if [ -L "$extracted_dir/$file" ] || [ ! -f "$extracted_dir/$file" ]; then
      fail "allowlisted file is not a regular file in extracted bundle: $file"
    fi
    if [ -L "$file" ]; then
      fail "refusing to overwrite host symlink deploy-control path: $file"
    fi
    if [ -f "$file" ]; then
      mkdir -p "$backup_dir/$(dirname "$file")"
      cp "$file" "$backup_dir/$file"
    fi
    mkdir -p "$(dirname "$file")"
    cp "$extracted_dir/$file" "$file"
  done < <(bundle_files)
  chmod 0755 \
    scripts/deploy-route-ops-image.sh \
    scripts/rollback-route-ops-image.sh \
    scripts/ssm-route-ops-deploy.sh \
    scripts/route-ops-deploy-control-bundle.sh
  bash -n \
    scripts/deploy-route-ops-image.sh \
    scripts/rollback-route-ops-image.sh \
    scripts/ssm-route-ops-deploy.sh \
    scripts/route-ops-deploy-control-bundle.sh
}

usage() {
  cat <<'USAGE' >&2
Usage: scripts/route-ops-deploy-control-bundle.sh <command> [args]

Commands:
  bundle-files
  expected-tar-manifest
  verify-sha <bundle.tar.gz> <expected-sha256>
  validate-tar-manifest <bundle.tar.gz>
  validate-source-file <path>
  validate-extracted <extracted-dir> <expected-s3-uri>
  sync-extracted <extracted-dir> <backup-dir>
USAGE
}

command="${1:-}"
case "$command" in
  bundle-files)
    bundle_files
    ;;
  expected-tar-manifest)
    expected_tar_manifest
    ;;
  verify-sha)
    shift
    verify_sha "$@"
    ;;
  validate-tar-manifest)
    shift
    validate_tar_manifest "$@"
    ;;
  validate-source-file)
    shift
    validate_source_file "$@"
    ;;
  validate-extracted)
    shift
    validate_extracted "$@"
    ;;
  sync-extracted)
    shift
    sync_extracted "$@"
    ;;
  *)
    usage
    exit 2
    ;;
esac
