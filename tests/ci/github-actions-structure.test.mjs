#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const workflowDir = join(root, '.github/workflows');
const workflowFiles = readdirSync(workflowDir).filter((name) => name.endsWith('.yml')).sort();

assert.deepEqual(workflowFiles, ['ci.yml', 'route-ops-operations.yml']);

const ci = readFileSync(join(workflowDir, 'ci.yml'), 'utf8');
const operations = readFileSync(join(workflowDir, 'route-ops-operations.yml'), 'utf8');

assert.match(ci, /^name: CI$/m);
assert.equal((ci.match(/^  [a-z0-9-]+:\n    runs-on:/gm) ?? []).length, 1, 'CI must use one runner job');
assert.equal((ci.match(/uses: actions\/checkout@/g) ?? []).length, 1, 'CI checkout must run once');
assert.equal((ci.match(/uses: actions\/setup-node@/g) ?? []).length, 1, 'CI Node setup must run once');
assert.equal((ci.match(/npm --prefix apps\/delivery-api ci/g) ?? []).length, 1, 'delivery API install must run once');
assert.equal((ci.match(/npm --prefix apps\/route-ops-web ci/g) ?? []).length, 1, 'web install must run once');

assert.match(operations, /^name: Route Ops operations$/m);
assert.match(operations, /^run-name: Route Ops \/ \$\{\{ inputs\.operation \}\} \/ \$\{\{ inputs\.source_ref \}\}$/m);
for (const operation of [
  'deploy',
  'edge_caddy',
  'backup_setup',
  'docker_cleanup',
  'completion_evidence',
  'alarm_canary',
  'invariant_mode',
]) {
  assert.match(operations, new RegExp(`^          - ${operation}$`, 'm'), `missing operation ${operation}`);
}
assert.equal((operations.match(/uses: actions\/checkout@/g) ?? []).length, 1, 'operations checkout must run once');
assert.equal((operations.match(/uses: aws-actions\/configure-aws-credentials@/g) ?? []).length, 1, 'AWS credentials must be configured once');
assert.match(operations, /inputs\.operation == 'deploy'/);
assert.match(operations, /inputs\.operation == 'edge_caddy'/);
assert.match(operations, /inputs\.operation == 'invariant_mode'/);

console.log('GitHub Actions structure contract passed');
