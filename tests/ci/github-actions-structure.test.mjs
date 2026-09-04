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
assert.match(ci, /- name: Dependency security audit[\s\S]*?if: steps\.classify\.outputs\.dependency_changed == 'true'[\s\S]*?npm --prefix apps\/delivery-api run audit:production/u);
assert.doesNotMatch(ci, /- name: Prepare delivery API[\s\S]*?npm --prefix apps\/delivery-api run audit:production/u, 'prepare step must not run the expensive audit');

assert.match(operations, /^name: Route Ops operations$/m);
assert.match(operations, /^run-name: Route Ops \/ \$\{\{ inputs\.operation \}\} \/ \$\{\{ inputs\.source_ref \}\}$/m);
assert.match(operations, /^  route:\n/m, 'operation graph must have a routing job');
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
  assert.match(operations, new RegExp(`^  ${operation}:\\n    needs: route\\n    if: needs\\.route\\.outputs\\.operation == '${operation}'$`, 'm'), `missing graph branch ${operation}`);
}
assert.equal((operations.match(/uses: actions\/checkout@/g) ?? []).length, 7, 'each operation branch must checkout once');
assert.equal((operations.match(/uses: aws-actions\/configure-aws-credentials@/g) ?? []).length, 7, 'each AWS operation branch must configure credentials once');
assert.match(operations, /^  summary:\n/m, 'operation graph must converge on a summary job');

console.log('GitHub Actions structure contract passed');
