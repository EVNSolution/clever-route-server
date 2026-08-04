import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const read = (path) => readFileSync(resolve(repositoryRoot, path), 'utf8');
const appEnvPath = '../../apps/delivery-api/.env';
const legacyEnvPath = ['infra', 'env', 'delivery-api.env'].join('/');

test('keeps one tracked delivery-api env contract beside the application', () => {
  assert.equal(existsSync(resolve(repositoryRoot, 'apps/delivery-api/.env.example')), true);
  assert.equal(existsSync(resolve(repositoryRoot, `${legacyEnvPath}.example`)), false);

  const example = read('apps/delivery-api/.env.example');
  for (const key of [
    'CLEVER_DSV_ENABLED',
    'CLEVER_DSV_WEB_COOKIE_NAME',
    'CLEVER_DSV_DEMO_SHOP_DOMAIN',
    'DSV_MAP_PROFILE_ID',
    'GEOCODING_PROVIDER_MODE',
    'ROUTE_OPS_MAP_STYLE_URL',
    'UVIS_ENABLED',
    'VWORLD_API_KEY'
  ]) {
    assert.match(example, new RegExp(`^${key}=`, 'mu'), `missing ${key}`);
  }

  assert.doesNotMatch(example, /^API_PORT=/mu);
  assert.doesNotMatch(example, /^POSTGRES_PORT=/mu);
  assert.doesNotMatch(example, /infra\/env\/delivery-api\.env/mu);
});

test('keeps UVIS configuration server-only', () => {
  const example = read('apps/delivery-api/.env.example');
  const productionCompose = read('infra/compose/docker-compose.prod.yml');
  const dsvCompose = read('infra/compose/docker-compose.dsv-dev.yml');
  const deployWorkflow = read('.github/workflows/route-ops-simple-deploy.yml');
  const webDockerfile = read('apps/route-ops-web/Dockerfile');

  assert.match(example, /^UVIS_ENABLED=false$/mu);
  assert.match(deployWorkflow, /ROUTE_OPS_UVIS_ENV_PARAM: \$\{\{ vars\.ROUTE_OPS_UVIS_ENV_PARAM \}\}/u);
  assert.doesNotMatch(deployWorkflow, /secrets\.[A-Z0-9_]*UVIS/u);

  const staticService = productionCompose.slice(
    productionCompose.indexOf('  route-ops-web-static:'),
    productionCompose.indexOf('  clever-route-api:')
  );
  assert.doesNotMatch(staticService, /UVIS_|env_file:/u);
  assert.doesNotMatch(webDockerfile, /UVIS_/u);

  for (const compose of [productionCompose, dsvCompose]) {
    assert.doesNotMatch(compose, /^\s+UVIS_[A-Z0-9_]+:/mu);
  }
});

test('makes every Compose runtime read the adjacent application env', () => {
  const productionCompose = read('infra/compose/docker-compose.prod.yml');
  const dsvCompose = read('infra/compose/docker-compose.dsv-dev.yml');

  assert.equal(productionCompose.split(`- ${appEnvPath}`).length - 1, 3);
  assert.equal(dsvCompose.split(`- ${appEnvPath}`).length - 1, 4);

  for (const key of [
    'CLEVER_ADMIN_ALLOWED_SHOP_DOMAINS',
    'CLEVER_DSV_ENABLED',
    'CLEVER_DSV_DEMO_SHOP_DOMAIN',
    'DSV_MAP_PROFILE_ID',
    'GEOCODING_PROVIDER_MODE',
    'SHOPIFY_APP_URL'
  ]) {
    assert.doesNotMatch(dsvCompose, new RegExp(`^\\s+${key}:`, 'mu'), `${key} must come from the app env`);
  }
});

test('removes active references to the legacy infra env authority', () => {
  let matches = '';
  try {
    matches = execFileSync('git', ['grep', '-n', legacyEnvPath], {
      cwd: repositoryRoot,
      encoding: 'utf8'
    });
  } catch (error) {
    if (error.status !== 1) {
      throw error;
    }
  }

  assert.equal(matches, '');
});
