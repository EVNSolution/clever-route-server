#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const args = process.argv.slice(2);
const allowComposeBootstrap = args.includes('--allow-compose-bootstrap') || process.env.ALLOW_COMPOSE_IMAGE_VARIABLE_BOOTSTRAP === 'true';
const allowGeocodeOsrmLane = args.includes('--allow-geocode-osrm-lane') || process.env.ALLOW_GEOCODE_OSRM_LANE === 'true';
const allowCommerceSyncLane = args.includes('--allow-commerce-sync-lane') || process.env.ALLOW_COMMERCE_SYNC_LANE === 'true';
const json = args.includes('--json');
const filesArgIndex = args.indexOf('--files');
const baseArgIndex = args.indexOf('--base');
const headArgIndex = args.indexOf('--head');

function runGit(gitArgs) {
  return execFileSync('git', gitArgs, { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function tryRunGit(gitArgs) {
  try {
    return runGit(gitArgs);
  } catch {
    return null;
  }
}

function normalizePath(item) {
  return item.replace(/^\.\//, '').replace(/\\/g, '/').trim();
}

function parseNameStatusLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const tabParts = trimmed.split(/\t+/).map((item) => item.trim()).filter(Boolean);
  const statusToken = tabParts[0] ?? '';
  if (/^[ACDMRTUXB][0-9]*$/.test(statusToken) && tabParts.length >= 2) {
    const status = statusToken[0];
    if ((status === 'R' || status === 'C') && tabParts.length >= 3) {
      return {
        status,
        file: normalizePath(tabParts[2]),
        oldFile: normalizePath(tabParts[1]),
      };
    }
    return { status, file: normalizePath(tabParts[1]) };
  }
  return { status: null, file: normalizePath(trimmed) };
}

function uniqEntries(items) {
  const seen = new Map();
  for (const item of items) {
    const entry = typeof item === 'string' ? parseNameStatusLine(item) : item;
    if (!entry?.file) continue;
    const key = `${entry.status ?? ''}\t${entry.oldFile ?? ''}\t${entry.file}`;
    seen.set(key, entry);
  }
  return [...seen.values()].sort((a, b) => `${a.oldFile ?? ''}\t${a.file}`.localeCompare(`${b.oldFile ?? ''}\t${b.file}`));
}

function parseFilesInput(value) {
  if (!value) return [];
  return uniqEntries(value.split(/\r?\n|,/));
}

function changedEntries() {
  if (filesArgIndex >= 0) {
    const value = args[filesArgIndex + 1];
    if (!value) throw new Error('--files requires a path or comma-separated file list');
    if (fs.existsSync(value)) return parseFilesInput(fs.readFileSync(value, 'utf8'));
    return parseFilesInput(value);
  }
  if (process.env.CHANGED_FILES) return parseFilesInput(process.env.CHANGED_FILES);
  if (baseArgIndex >= 0) {
    const base = args[baseArgIndex + 1];
    const head = headArgIndex >= 0 ? args[headArgIndex + 1] : 'HEAD';
    if (!base) throw new Error('--base requires a ref');
    return uniqEntries(tryRunGit(['diff', '--name-status', `${base}...${head}`]) ?? runGit(['diff', '--name-status', base, head]));
  }
  return uniqEntries([
    ...runGit(['diff', '--name-status']),
    ...runGit(['diff', '--cached', '--name-status']),
    ...runGit(['ls-files', '--others', '--exclude-standard']).map((file) => ({ status: 'A', file: normalizePath(file) })),
  ]);
}

const allowedExact = new Set([
  'package.json',
  '.gitignore',
  '.dockerignore',
  '.gitleaks.toml',
  '.github/workflows/ci.yml',
  '.github/workflows/route-ops-publish.yml',
  '.github/workflows/route-ops-ssm-deploy.yml',
  'apps/delivery-api/Dockerfile',
  'apps/delivery-api/src/modules/commerce/admin-commerce-connections.dependencies.ts',
  'apps/delivery-api/src/modules/driver/driver-auth.repository.ts',
  'apps/delivery-api/src/modules/driver/driver-assigned-route.repository.ts',
  'apps/delivery-api/src/modules/driver/driver-commerce-domain.ts',
  'apps/delivery-api/src/modules/driver/driver-consent.repository.ts',
  'apps/delivery-api/src/modules/driver/driver-event.repository.ts',
  'apps/delivery-api/src/modules/driver/driver-proof-media.repository.ts',
  'apps/delivery-api/src/modules/driver/driver-route-access.repository.ts',
  'apps/delivery-api/src/modules/driver/driver-self-service.repository.ts',
  'apps/delivery-api/src/modules/driver/driver-token-access.repository.ts',
  'apps/delivery-api/src/modules/driver/driver-token-verifier.ts',
  'apps/delivery-api/src/modules/route-plans/route-plan.repository.ts',
  'apps/delivery-api/src/modules/route-plans/route-plan.service.ts',
  'apps/delivery-api/src/modules/route-plans/route-plan.types.ts',
  'apps/delivery-api/src/routes/admin-commerce-connections-ui.routes.ts',
  'apps/delivery-api/src/routes/admin-ui-session.ts',
  'apps/delivery-api/src/routes/driver-events.routes.ts',
  'apps/delivery-api/tests/admin-commerce-connections-ui.routes.test.ts',
  'apps/delivery-api/tests/admin-route-plans.routes.test.ts',
  'apps/delivery-api/tests/driver-auth.repository.test.ts',
  'apps/delivery-api/tests/driver-assigned-route.repository.test.ts',
  'apps/delivery-api/tests/driver-auth.routes.test.ts',
  'apps/delivery-api/tests/driver-commerce-domain.test.ts',
  'apps/delivery-api/tests/driver-consent.repository.test.ts',
  'apps/delivery-api/tests/driver-event.repository.test.ts',
  'apps/delivery-api/tests/driver-proof-media.repository.test.ts',
  'apps/delivery-api/tests/driver-route-access.repository.test.ts',
  'apps/delivery-api/tests/driver-route-access.routes.test.ts',
  'apps/delivery-api/tests/driver-self-service.repository.test.ts',
  'apps/delivery-api/tests/driver-token-access.repository.test.ts',
  'apps/delivery-api/tests/driver-token-verifier.test.ts',
  'apps/delivery-api/tests/route-plan.repository.test.ts',
  'apps/delivery-api/tests/route-plan.service.test.ts',
  'scripts/guard-route-ops-deploy-scope.mjs',
  'scripts/check-ignore-hygiene.mjs',
  'scripts/scan-secrets.sh',
  'scripts/deploy-route-ops-image.sh',
  'scripts/rollback-route-ops-image.sh',
  'scripts/smoke-route-ops-production.mjs',
  'scripts/ssm-route-ops-deploy.sh',
  'tests/deploy/ssm-route-ops-deploy.test.sh',
  'scripts/validate-route-ops-ssm-deploy.mjs',
  'infra/env/delivery-api.env.example',
  'infra/env/deploy-image.env.example',
  'docs/deployment/route-ops-github-deploy.md',
  'docs/deployment/route-ops-ssm-deploy.md',
  'docs/development/script-tooling.md',
]);

const allowedPrefixes = [
  'apps/route-ops-web/',
];

const allowedRemovedExact = new Set([
  'scripts/test-ssm-route-ops-deploy.sh',
]);

const geocodeOsrmRemovedExact = new Set([
  'scripts/prepare-osrm-ontario.sh',
  'scripts/smoke-osrm-ontario.sh',
]);

if (allowComposeBootstrap) {
  allowedExact.add('infra/compose/docker-compose.prod.yml');
}

if (allowGeocodeOsrmLane) {
  allowedExact.add('apps/delivery-api/src/modules/route-plans/osrm-route-geometry.client.ts');
  allowedExact.add('apps/delivery-api/src/modules/wordpress-plugin/wordpress-plugin.dependencies.ts');
  allowedExact.add('apps/delivery-api/tests/geocoding.service.test.ts');
  allowedExact.add('apps/delivery-api/tests/osrm-route-geometry.client.test.ts');
  allowedExact.add('docs/deployment/route-ops-map-geocoding.md');
  allowedExact.add('docs/deployment/route-ops-osrm-ontario.md');
  allowedExact.add('scripts/osrm-ontario.sh');
  allowedPrefixes.push('apps/delivery-api/src/modules/geocoding/');
}

const commerceSyncAllowedExact = new Set([
  'apps/delivery-api/src/modules/shopify/order-sync.mapper.ts',
  'apps/delivery-api/src/modules/shopify/order-sync.repository.ts',
  'apps/delivery-api/src/modules/shopify/order-sync.service.ts',
  'apps/delivery-api/src/modules/woocommerce/woocommerce-order-sync.service.ts',
  'apps/delivery-api/src/modules/woocommerce/woocommerce.dependencies.ts',
  'apps/delivery-api/tests/woocommerce-order-sync.service.test.ts',
]);

if (allowCommerceSyncLane) {
  for (const file of commerceSyncAllowedExact) allowedExact.add(file);
}

function blockedReason(file) {
  if (file.startsWith('output/')) return 'output artifacts must never be in a Route Ops deploy';
  if (file.startsWith('infra/caddy/')) return 'Caddy/ingress changes require a separate infra lane';
  if (file.startsWith('apps/delivery-api/prisma/')) return 'Prisma schema/migrations require a separate DB lane';
  if (file.startsWith('apps/delivery-api/src/modules/woocommerce/') && !(allowCommerceSyncLane && commerceSyncAllowedExact.has(file))) {
    return 'Woo delivery-facts/connector changes require a separate Woo lane or explicit commerce-sync deploy approval';
  }
  if (file.startsWith('apps/delivery-api/src/modules/shopify/') && !(allowCommerceSyncLane && commerceSyncAllowedExact.has(file))) {
    return 'Shopify sync/delivery changes require a separate commerce lane or explicit commerce-sync deploy approval';
  }
  if (file.startsWith('infra/compose/')) {
    if (allowComposeBootstrap && file === 'infra/compose/docker-compose.prod.yml') return null;
    return 'compose changes are allowed only for the one-time image-variable bootstrap';
  }
  return null;
}

function allowed(file) {
  return allowedExact.has(file) || allowedPrefixes.some((prefix) => file.startsWith(prefix));
}

function allowedRemoval(file) {
  return allowedRemovedExact.has(file) || (allowGeocodeOsrmLane && geocodeOsrmRemovedExact.has(file));
}

function removalProblem(file) {
  const reason = blockedReason(file);
  if (reason) return { file, reason, type: 'blocked' };
  if (!allowedRemoval(file)) return { file, reason: 'removed or renamed-from path is not in Route Ops cleanup removal allowlist', type: 'outside' };
  return null;
}

const entries = changedEntries();
const blocked = [];
const outside = [];
for (const entry of entries) {
  if (entry.oldFile) {
    const problem = removalProblem(entry.oldFile);
    if (problem?.type === 'blocked') blocked.push({ file: problem.file, reason: problem.reason });
    if (problem?.type === 'outside') outside.push({ file: problem.file, reason: problem.reason });
  }

  if (entry.status === 'D') {
    const problem = removalProblem(entry.file);
    if (problem?.type === 'blocked') blocked.push({ file: problem.file, reason: problem.reason });
    if (problem?.type === 'outside') outside.push({ file: problem.file, reason: problem.reason });
    continue;
  }

  const reason = blockedReason(entry.file);
  if (reason) {
    blocked.push({ file: entry.file, reason });
    continue;
  }
  if (!allowed(entry.file)) outside.push({ file: entry.file, reason: 'not in Route Ops publish/deploy allowlist' });
}

const report = {
  ok: blocked.length === 0 && outside.length === 0,
  allowComposeBootstrap,
  allowGeocodeOsrmLane,
  allowCommerceSyncLane,
  changedFileCount: entries.length,
  blocked,
  outside,
};

const output = JSON.stringify(report, null, 2);
if (json) console.log(output);
else {
  console.log(`Route Ops deploy-scope guard: ${report.ok ? 'ok' : 'failed'} (${entries.length} file(s))`);
  if (!report.ok) console.log(output);
}
if (!report.ok) process.exit(1);
