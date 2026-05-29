#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const args = process.argv.slice(2);
const allowComposeBootstrap = args.includes('--allow-compose-bootstrap') || process.env.ALLOW_COMPOSE_IMAGE_VARIABLE_BOOTSTRAP === 'true';
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

function uniq(items) {
  return [...new Set(items.map((item) => item.replace(/^\.\//, '').replace(/\\/g, '/')).filter(Boolean))].sort();
}

function changedFiles() {
  if (filesArgIndex >= 0) {
    const value = args[filesArgIndex + 1];
    if (!value) throw new Error('--files requires a path or comma-separated file list');
    if (fs.existsSync(value)) return uniq(fs.readFileSync(value, 'utf8').split(/\r?\n|,/));
    return uniq(value.split(','));
  }
  if (process.env.CHANGED_FILES) return uniq(process.env.CHANGED_FILES.split(/\r?\n|,/));
  if (baseArgIndex >= 0) {
    const base = args[baseArgIndex + 1];
    const head = headArgIndex >= 0 ? args[headArgIndex + 1] : 'HEAD';
    if (!base) throw new Error('--base requires a ref');
    return uniq(tryRunGit(['diff', '--name-only', `${base}...${head}`]) ?? runGit(['diff', '--name-only', base, head]));
  }
  return uniq([
    ...runGit(['diff', '--name-only']),
    ...runGit(['diff', '--cached', '--name-only']),
    ...runGit(['ls-files', '--others', '--exclude-standard']),
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
  'apps/delivery-api/src/routes/admin-commerce-connections-ui.routes.ts',
  'apps/delivery-api/tests/admin-commerce-connections-ui.routes.test.ts',
  'scripts/guard-route-ops-deploy-scope.mjs',
  'scripts/check-ignore-hygiene.mjs',
  'scripts/scan-secrets.sh',
  'scripts/deploy-route-ops-image.sh',
  'scripts/rollback-route-ops-image.sh',
  'scripts/smoke-route-ops-production.mjs',
  'scripts/ssm-route-ops-deploy.sh',
  'scripts/test-ssm-route-ops-deploy.sh',
  'scripts/validate-route-ops-ssm-deploy.mjs',
  'infra/env/delivery-api.env.example',
  'infra/env/deploy-image.env.example',
  'docs/deployment/route-ops-github-deploy.md',
  'docs/deployment/route-ops-ssm-deploy.md',
]);

const allowedPrefixes = [
  'apps/route-ops-web/',
];

if (allowComposeBootstrap) {
  allowedExact.add('infra/compose/docker-compose.prod.yml');
}

function blockedReason(file) {
  if (file.startsWith('output/')) return 'output artifacts must never be in a Route Ops deploy';
  if (file.startsWith('infra/caddy/')) return 'Caddy/ingress changes require a separate infra lane';
  if (file.startsWith('apps/delivery-api/prisma/')) return 'Prisma schema/migrations require a separate DB lane';
  if (file.startsWith('apps/delivery-api/src/modules/woocommerce/')) return 'Woo delivery-facts/connector changes require a separate Woo lane';
  if (file.startsWith('apps/delivery-api/src/modules/shopify/')) return 'Shopify sync/delivery changes require a separate commerce lane';
  if (file.startsWith('infra/compose/')) {
    if (allowComposeBootstrap && file === 'infra/compose/docker-compose.prod.yml') return null;
    return 'compose changes are allowed only for the one-time image-variable bootstrap';
  }
  return null;
}

function allowed(file) {
  return allowedExact.has(file) || allowedPrefixes.some((prefix) => file.startsWith(prefix));
}

const files = changedFiles();
const blocked = [];
const outside = [];
for (const file of files) {
  const reason = blockedReason(file);
  if (reason) {
    blocked.push({ file, reason });
    continue;
  }
  if (!allowed(file)) outside.push({ file, reason: 'not in Route Ops publish/deploy allowlist' });
}

const report = {
  ok: blocked.length === 0 && outside.length === 0,
  allowComposeBootstrap,
  changedFileCount: files.length,
  blocked,
  outside,
};

const output = JSON.stringify(report, null, 2);
if (json) console.log(output);
else {
  console.log(`Route Ops deploy-scope guard: ${report.ok ? 'ok' : 'failed'} (${files.length} file(s))`);
  if (!report.ok) console.log(output);
}
if (!report.ok) process.exit(1);
