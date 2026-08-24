#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

node <<'NODE'
const { readFileSync } = require('node:fs');

const packageJson = JSON.parse(readFileSync('apps/delivery-api/package.json', 'utf8'));
const expected = {
  'driver:event-attempts:cleanup': 'node dist/scripts/cleanup-driver-event-attempts.js',
  'shopify:webhook-events:cleanup': 'node dist/scripts/cleanup-shopify-webhook-events.js',
  'driver:proof-media:cleanup': 'node dist/scripts/cleanup-driver-proof-media.js',
};
for (const [name, command] of Object.entries(expected)) {
  if (packageJson.scripts?.[name] !== command) {
    throw new Error(`${name} must use the built production script`);
  }
}
NODE

grep -Fq 'npm --prefix apps/delivery-api prune --omit=dev' apps/delivery-api/Dockerfile
for script in \
  cleanup-driver-event-attempts.js \
  cleanup-shopify-webhook-events.js \
  cleanup-driver-proof-media.js
do
  grep -Fq "test -f apps/delivery-api/dist/scripts/${script}" apps/delivery-api/Dockerfile
done

printf '{"ok":true,"contract":"route-ops-retention-production-runtime"}\n'
