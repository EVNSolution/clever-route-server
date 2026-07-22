#!/usr/bin/env bash
set -euo pipefail

schema_path="${G002_SCHEMA_PATH:-prisma/schema.prisma}"
baseline_path="${G002_BASELINE_PATH:-prisma/baseline/g002-full-schema-baseline.sql}"
evidence_dir="${G002_EVIDENCE_DIR:-docs/evidence/g002}"
mkdir -p "$evidence_dir"

generated_path="$evidence_dir/empty-baseline-regenerated.sql"
metadata_path="$evidence_dir/empty-baseline-rehearsal.json"

npx prisma migrate diff \
  --from-empty \
  --to-schema-datamodel "$schema_path" \
  --script > "$generated_path"

cmp "$baseline_path" "$generated_path"
npm run prisma:validate

schema_sha256="$(shasum -a 256 "$schema_path" | awk '{print $1}')"
baseline_sha256="$(shasum -a 256 "$baseline_path" | awk '{print $1}')"

cat > "$metadata_path" <<JSON
{
  "goal": "G002",
  "targetClass": "empty-schema",
  "commands": [
    "npx prisma migrate diff --from-empty --to-schema-datamodel $schema_path --script",
    "cmp $baseline_path $generated_path",
    "npm run prisma:validate"
  ],
  "schemaSha256": "$schema_sha256",
  "baselineSha256": "$baseline_sha256",
  "generatedReport": "$generated_path",
  "exitCode": 0
}
JSON

echo "$metadata_path"
