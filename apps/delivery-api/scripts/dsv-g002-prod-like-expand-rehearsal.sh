#!/usr/bin/env bash
set -euo pipefail

if [ "${G002_PROD_LIKE_DATABASE_URL:-}" = "" ]; then
  echo "G002_PROD_LIKE_DATABASE_URL is required and must point to a non-production clone or snapshot." >&2
  exit 64
fi

schema_path="${G002_SCHEMA_PATH:-prisma/schema.prisma}"
migration_path="${G002_MIGRATION_PATH:-prisma/migrations/20260722170000_dsv_customer_auth_foundation/migration.sql}"
evidence_dir="${G002_EVIDENCE_DIR:-docs/evidence/g002}"
mkdir -p "$evidence_dir"

drift_path="$evidence_dir/prod-like-expand-drift.sql"
metadata_path="$evidence_dir/prod-like-expand-rehearsal.json"

set +e
npx prisma migrate diff \
  --from-url "$G002_PROD_LIKE_DATABASE_URL" \
  --to-schema-datamodel "$schema_path" \
  --script > "$drift_path"
diff_exit_code=$?
set -e

schema_sha256="$(shasum -a 256 "$schema_path" | awk '{print $1}')"
migration_sha256="$(shasum -a 256 "$migration_path" | awk '{print $1}')"

cat > "$metadata_path" <<JSON
{
  "goal": "G002",
  "targetClass": "production-like-clone",
  "commands": [
    "npx prisma migrate diff --from-url [REDACTED] --to-schema-datamodel $schema_path --script"
  ],
  "schemaSha256": "$schema_sha256",
  "g002MigrationSha256": "$migration_sha256",
  "generatedDriftReport": "$drift_path",
  "diffExitCode": $diff_exit_code,
  "note": "This helper only computes drift against a non-production clone; it does not apply migrations or write database rows."
}
JSON

echo "$metadata_path"
exit "$diff_exit_code"
