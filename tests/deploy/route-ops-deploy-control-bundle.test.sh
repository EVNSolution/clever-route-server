#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

IMAGE_TAG="0123456789abcdef0123456789abcdef01234567"
SCHEMA_SHA="abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd"
RUN_ID="123456789"
BUCKET="route-ops-artifacts-902837199612-ap-northeast-2"
PREFIX="artifacts/route-ops/prod/deploy-control"
BUNDLE_NAME="route-ops-deploy-control.tar.gz"
S3_URI="s3://${BUCKET}/${PREFIX}/${RUN_ID}/${IMAGE_TAG}/${BUNDLE_NAME}"
RUNTIME_IMAGE="ghcr.io/evnsolution/clever-route-server-delivery-api:${IMAGE_TAG}"
MIGRATE_IMAGE="ghcr.io/evnsolution/clever-route-server-delivery-api-migrate:${IMAGE_TAG}"
PUBLISH_EVIDENCE_URL="https://github.com/EVNSolution/clever-route-server/actions/runs/${RUN_ID}"
ROUTE_ENGINE_IMAGE="ghcr.io/evnsolution/route-engine-worker:5555555555555555555555555555555555555555"
ROUTE_ENGINE_PUBLISH_EVIDENCE_URL="https://github.com/EVNSolution/route_engine/actions/runs/987654321"

tmp="$(mktemp -d "${TMPDIR:-/tmp}/route-ops-deploy-control-test.XXXXXX")"
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT

files=()
while IFS= read -r file; do
  files+=("$file")
done < <(scripts/route-ops-deploy-control-bundle.sh bundle-files)

make_staging() {
  local staging="$1"
  mkdir -p "$staging"
  for file in "${files[@]}"; do
    mkdir -p "$staging/$(dirname "$file")"
    cp "$file" "$staging/$file"
  done
  python3 - \
    "$IMAGE_TAG" \
    "$SCHEMA_SHA" \
    "$RUNTIME_IMAGE" \
    "$MIGRATE_IMAGE" \
    "$ROUTE_ENGINE_IMAGE" \
    "$ROUTE_ENGINE_PUBLISH_EVIDENCE_URL" \
    "$PUBLISH_EVIDENCE_URL" \
    "$RUN_ID" \
    "$BUCKET" \
    "$PREFIX" \
    "$BUNDLE_NAME" \
    "$S3_URI" \
    "${files[@]}" <<'PY' > "$staging/deploy-control-manifest.json"
import json
import sys
(
    image_tag,
    schema_sha,
    runtime_image,
    migrate_image,
    route_engine_image,
    route_engine_publish_evidence_url,
    publish_evidence_url,
    run_id,
    bucket,
    prefix,
    bundle_name,
    s3_uri,
    *files,
) = sys.argv[1:]
print(json.dumps({
    'schemaVersion': 1,
    'dryRun': True,
    'runId': run_id,
    'commitSha': image_tag,
    'imageTag': image_tag,
    'prismaSchemaSha': schema_sha,
    'deliveryApiImage': runtime_image,
    'deliveryApiMigrateImage': migrate_image,
    'routeEngineImage': route_engine_image,
    'routeEnginePublishEvidenceUrl': route_engine_publish_evidence_url,
    'publishEvidenceUrl': publish_evidence_url,
    'artifactBucket': bucket,
    'artifactPrefix': prefix,
    'bundleFile': bundle_name,
    's3Uri': s3_uri,
    'deployControlFiles': files,
}, sort_keys=True, separators=(',', ':')))
PY
}

bundle_from_staging() {
  local staging="$1"
  local bundle="$2"
  tar -C "$staging" -czf "$bundle" deploy-control-manifest.json "${files[@]}"
}

staging="$tmp/staging"
make_staging "$staging"
bundle="$tmp/${BUNDLE_NAME}"
bundle_from_staging "$staging" "$bundle"

scripts/route-ops-deploy-control-bundle.sh validate-tar-manifest "$bundle"
sha="$(sha256sum "$bundle" | awk '{print $1}')"
actual_sha="$(scripts/route-ops-deploy-control-bundle.sh verify-sha "$bundle" "$sha")"
test "$actual_sha" = "$sha"

if scripts/route-ops-deploy-control-bundle.sh verify-sha "$bundle" "0000000000000000000000000000000000000000000000000000000000000000" >/dev/null 2>&1; then
  echo "SHA256 mismatch unexpectedly passed" >&2
  exit 1
fi

source_file="$tmp/source-file"
printf 'safe\n' > "$source_file"
scripts/route-ops-deploy-control-bundle.sh validate-source-file "$source_file"
ln -s "$source_file" "$tmp/source-symlink"
if scripts/route-ops-deploy-control-bundle.sh validate-source-file "$tmp/source-symlink" >/dev/null 2>&1; then
  echo "source symlink unexpectedly passed" >&2
  exit 1
fi
ln "$source_file" "$tmp/source-hardlink"
if scripts/route-ops-deploy-control-bundle.sh validate-source-file "$source_file" >/dev/null 2>&1; then
  echo "source hardlink unexpectedly passed" >&2
  exit 1
fi
rm "$tmp/source-hardlink"

extract_dir="$tmp/extracted"
mkdir -p "$extract_dir"
tar -xzf "$bundle" -C "$extract_dir"
scripts/route-ops-deploy-control-bundle.sh validate-extracted "$extract_dir" "$S3_URI" > "$tmp/deploy-control.env" 2> "$tmp/manifest.stderr"
grep -q 'manifest validation passed' "$tmp/manifest.stderr"
# shellcheck disable=SC1091
. "$tmp/deploy-control.env"
test "$DRY_RUN" = "true"
test "$IMAGE_TAG" = "0123456789abcdef0123456789abcdef01234567"
test "$DEPLOY_CONTROL_BUNDLE_S3_URI" = "$S3_URI"
test "$ROUTE_ENGINE_IMAGE" = "ghcr.io/evnsolution/route-engine-worker:5555555555555555555555555555555555555555"

bad_staging="$tmp/bad-staging"
make_staging "$bad_staging"
python3 - "$bad_staging/deploy-control-manifest.json" <<'PY'
import json
import sys
path = sys.argv[1]
data = json.load(open(path, encoding='utf-8'))
data['deployControlFiles'] = data['deployControlFiles'] + ['infra/env/delivery-api.env']
open(path, 'w', encoding='utf-8').write(json.dumps(data, sort_keys=True, separators=(',', ':')))
PY
bad_bundle="$tmp/bad-manifest.tar.gz"
bundle_from_staging "$bad_staging" "$bad_bundle"
mkdir -p "$tmp/bad-extracted"
tar -xzf "$bad_bundle" -C "$tmp/bad-extracted"
if scripts/route-ops-deploy-control-bundle.sh validate-extracted "$tmp/bad-extracted" "$S3_URI" >/dev/null 2>&1; then
  echo "invalid manifest allowlist unexpectedly passed" >&2
  exit 1
fi

missing_manifest_bundle="$tmp/missing-manifest.tar.gz"
tar -C "$staging" -czf "$missing_manifest_bundle" "${files[@]}"
if scripts/route-ops-deploy-control-bundle.sh validate-tar-manifest "$missing_manifest_bundle" >/dev/null 2>&1; then
  echo "missing manifest tar unexpectedly passed" >&2
  exit 1
fi

symlink_staging="$tmp/symlink-staging"
make_staging "$symlink_staging"
rm "$symlink_staging/scripts/smoke-route-ops-production.mjs"
ln -s /etc/passwd "$symlink_staging/scripts/smoke-route-ops-production.mjs"
symlink_bundle="$tmp/symlink-member.tar.gz"
bundle_from_staging "$symlink_staging" "$symlink_bundle"
if scripts/route-ops-deploy-control-bundle.sh validate-tar-manifest "$symlink_bundle" >/dev/null 2>&1; then
  echo "symlink tar member unexpectedly passed" >&2
  exit 1
fi

rm "$extract_dir/scripts/smoke-route-ops-production.mjs"
ln -s /etc/passwd "$extract_dir/scripts/smoke-route-ops-production.mjs"
if scripts/route-ops-deploy-control-bundle.sh validate-extracted "$extract_dir" "$S3_URI" >/dev/null 2>&1; then
  echo "symlink extracted member unexpectedly passed" >&2
  exit 1
fi

printf '{"ok":true,"bundle":"scripts/route-ops-deploy-control-bundle.sh"}\n'
