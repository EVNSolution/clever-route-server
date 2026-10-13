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

// CI is classify -> parallel lanes -> one verdict. Each expensive check lives in
// exactly one lane, and validate fails unless every selected lane succeeded.
const jobsSection = ci.slice(ci.indexOf('\njobs:\n'));
const jobs = Object.fromEntries(
  [...jobsSection.matchAll(/^ {2}([a-z0-9_-]+):\n([\s\S]*?)(?=^ {2}[a-z0-9_-]+:\n|(?![\s\S]))/gm)].map((m) => [m[1], m[2]]),
);
const count = (text, pattern) => (text.match(pattern) ?? []).length;
const apiPackageTest = /npm --prefix apps\/delivery-api run test(?![:\w])/g;

assert.deepEqual(Object.keys(jobs), ['classify', 'checks', 'api_static', 'api_db', 'validate'], 'CI job graph');
for (const lane of ['checks', 'api_static', 'api_db']) {
  assert.match(jobs[lane], /^ {4}needs: classify$/m, `${lane} must wait for classify`);
  assert.equal(count(jobs[lane], /uses: actions\/checkout@/g), 1, `${lane} must checkout once`);
}
assert.match(jobs.classify, /^ {6}run_api_static: \$\{\{ steps\.lanes\.outputs\.run_api_static \}\}$/m);
assert.match(jobs.classify, /^ {6}run_api_db: \$\{\{ steps\.lanes\.outputs\.run_api_db \}\}$/m);
assert.match(jobs.api_static, /^ {4}if: needs\.classify\.outputs\.run_api_static == 'true'$/m);
assert.match(jobs.api_db, /^ {4}if: needs\.classify\.outputs\.run_api_db == 'true'$/m);

assert.match(jobs.validate, /^ {4}if: \$\{\{ !cancelled\(\) \}\}$/m, 'verdict must run after failed lanes');
assert.match(jobs.validate, /^ {4}needs: \[classify, checks, api_static, api_db\]$/m, 'verdict must see every lane');
for (const [lane, result, selected] of [
  ['classify', 'CLASSIFY_RESULT', 'true'],
  ['checks', 'CHECKS_RESULT', 'true'],
  ['api_static', 'API_STATIC_RESULT', '"$RUN_API_STATIC"'],
  ['api_db', 'API_DB_RESULT', '"$RUN_API_DB"'],
]) {
  assert.ok(jobs.validate.includes(`expect ${lane} "$${result}" ${selected}`), `verdict must check ${lane}`);
}
assert.match(jobs.validate, /exit "\$failed"/);

assert.equal(count(ci, /npm --prefix apps\/route-ops-web ci/g), 1, 'web install must run once');
assert.equal(count(jobs.checks, /npm --prefix apps\/route-ops-web ci/g), 1, 'web install belongs to checks');
assert.equal(count(jobs.api_static, /npm --prefix apps\/delivery-api run lint/g), 1, 'API lint belongs to api_static');
assert.equal(count(ci, /npm --prefix apps\/delivery-api run lint/g), 1, 'API lint must run once');
assert.equal(count(ci, /npm --prefix apps\/delivery-api run typecheck/g), 1, 'API typecheck must run once');
assert.equal(count(ci, /npm --prefix apps\/delivery-api run build/g), 1, 'API build must run once');
assert.equal(count(ci, /ssm-customer-email-reconciliation\.test\.sh/g), 1, 'customer email wrapper must run once');
assert.match(
  jobs.api_static,
  /npm --prefix apps\/delivery-api run build[\s\S]*tests\/deploy\/ssm-customer-email-reconciliation\.test\.sh/u,
  'customer email wrapper smokes the compiled CLI, so it must follow the API build in api_static',
);
assert.equal(count(jobs.api_db, /run test:db:disposable/g), 1, 'disposable DB tests belong to api_db');
assert.equal(count(ci, /run test:db:disposable/g), 1, 'disposable DB tests must run once');
assert.equal(count(jobs.api_static, apiPackageTest) + count(jobs.api_db, apiPackageTest), 0, 'API package tests belong to checks');
assert.match(jobs.checks, /- name: Dependency security audit[\s\S]*?if: needs\.classify\.outputs\.dependency_changed == 'true'[\s\S]*?npm --prefix apps\/delivery-api run audit:production/u);
assert.equal(count(ci, /audit:production/g), 1, 'dependency audit must run once');
assert.doesNotMatch(jobs.api_static, /audit:production/u, 'prepare step must not run the expensive audit');

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
