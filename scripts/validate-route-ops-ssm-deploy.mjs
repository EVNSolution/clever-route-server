#!/usr/bin/env node
import fs from 'node:fs';

function read(path) {
  return fs.readFileSync(path, 'utf8');
}

function assert(condition, message) {
  if (!condition) failures.push(message);
}

const failures = [];
const deployWorkflowPath = '.github/workflows/route-ops-ssm-deploy.yml';
const publishWorkflowPath = '.github/workflows/route-ops-publish.yml';
const ciWorkflowPath = '.github/workflows/ci.yml';
const wrapperPath = 'scripts/ssm-route-ops-deploy.sh';
const docPath = 'docs/deployment/route-ops-ssm-deploy.md';

const deploy = read(deployWorkflowPath);
const publish = read(publishWorkflowPath);
const ci = read(ciWorkflowPath);
const wrapper = read(wrapperPath);
const doc = read(docPath);

assert(/workflow_dispatch:\n/.test(deploy), 'deploy workflow must be workflow_dispatch');
for (const forbidden of ['pull_request:', 'schedule:', 'workflow_run:', 'repository_dispatch:']) {
  assert(!deploy.includes(forbidden), `deploy workflow must not include ${forbidden}`);
}
assert(!/^\s*push:/m.test(deploy), 'deploy workflow must not include push trigger');
assert(/permissions:/m.test(deploy), 'deploy workflow must declare permissions');
assert(/contents:\s*read/.test(deploy), 'deploy workflow must request contents:read');
assert(/actions:\s*read/.test(deploy), 'deploy workflow must request actions:read for publish-run provenance verification');
assert(/id-token:\s*write/.test(deploy), 'deploy workflow must request id-token:write for OIDC');
assert(!deploy.includes('packages: write'), 'deploy workflow must not request packages:write');
assert(deploy.includes("github.ref != 'refs/heads/main'"), 'deploy workflow must require refs/heads/main');
assert(deploy.includes('DEPLOY_ALLOWED_ACTORS is required'), 'deploy actor allowlist must fail closed when empty');
assert(deploy.includes('aws-actions/configure-aws-credentials@v4'), 'deploy workflow must use AWS OIDC credentials action');
assert(deploy.includes('AWS_ROUTE_OPS_DEPLOY_ROLE_ARN'), 'deploy workflow must use AWS deploy role variable');
assert(deploy.includes('git merge-base --is-ancestor "$IMAGE_TAG" origin/main'), 'deploy workflow must verify image tag is reachable from origin/main');
assert(deploy.includes('publish_evidence_url'), 'deploy workflow must require publish evidence URL');
assert(deploy.includes('/actions/runs/${publish_run_id}'), 'deploy workflow must query GitHub Actions run metadata for publish evidence');
assert(deploy.includes("run.get('conclusion') != 'success'"), 'deploy workflow must require successful publish run evidence');
assert(deploy.includes("run.get('head_branch') != 'main'"), 'deploy workflow must require publish run on main');
assert(deploy.includes("head_sha"), 'deploy workflow must require publish run SHA to match image tag');
assert(deploy.includes('AWS-RunShellScript is not allowed'), 'deploy workflow must explicitly reject AWS-RunShellScript document configuration');
assert(!deploy.includes('--document-name AWS-RunShellScript'), 'deploy workflow must not send AWS-RunShellScript');
assert(deploy.includes('target_query="[length(InstanceInformationList), InstanceInformationList[0].InstanceId, InstanceInformationList[0].PingStatus, InstanceInformationList[0].AgentVersion]"'), 'deploy workflow must resolve target count, instance id, online status, and agent version from one describe-instance-information call');
assert(deploy.includes('3.3.2746.0'), 'deploy workflow must require SSM AgentVersion >= 3.3.2746.0 for ENV_VAR interpolation');
assert(deploy.includes('--instance-ids "$INSTANCE_ID"'), 'deploy workflow must send command to the resolved exact instance id');
assert(!deploy.includes('--targets "Key=tag:'), 'deploy workflow must not send production command by mutable tag selector');
assert(deploy.includes('Command.[CommandId,TargetCount]'), 'deploy workflow must read SendCommand TargetCount');
assert(deploy.includes('TargetCount must be 1'), 'deploy workflow must assert SendCommand TargetCount is 1');
assert(deploy.includes('--max-concurrency "1"'), 'deploy workflow must set max-concurrency=1');
assert(deploy.includes('--max-errors "0"'), 'deploy workflow must set max-errors=0');
assert(deploy.includes('SSM_ROUTE_OPS_DOCUMENT_VERSION'), 'deploy workflow must require explicit SSM document version');
assert(!/secrets\./.test(deploy), 'deploy workflow must not reference GitHub secrets');
for (const secretName of ['PROD_SSH_PRIVATE_KEY', 'ROUTE_OPS_SMOKE_LOGIN_SECRET', 'CLEVER_ADMIN_WEB_LOGIN_SECRET', 'DATABASE_URL', 'POSTGRES_PASSWORD']) {
  assert(!deploy.includes(secretName), `deploy workflow must not reference ${secretName}`);
}

const otherWorkflows = [
  [publishWorkflowPath, publish],
  [ciWorkflowPath, ci],
];
for (const [path, text] of otherWorkflows) {
  assert(!text.includes('AWS_ROUTE_OPS_DEPLOY_ROLE_ARN'), `${path} must not reference the deploy role ARN variable`);
}
assert(!/id-token:\s*write/.test(publish), 'publish workflow must not request id-token:write for deploy role');
assert(!/id-token:\s*write/.test(ci), 'ci workflow must not request id-token:write for deploy role');
assert(!/actions:\s*read/.test(publish), 'publish workflow must not request actions:read for deploy provenance checks');

assert(wrapper.includes('ROUTE_OPS_DEPLOY_LOCK_HELD=1'), 'wrapper must export lock-held marker');
assert(wrapper.includes('CLEVER_ADMIN_WEB_LOGIN_SECRET'), 'wrapper must read host-local admin secret key');
assert(wrapper.includes('PUBLISH_EVIDENCE_URL'), 'wrapper must validate and record publish evidence URL when provided');
assert(!wrapper.includes('set -x'), 'wrapper must not enable shell xtrace');
assert(/ROUTE_OPS_SMOKE_LOGIN_SECRET="\$value"/.test(wrapper), 'wrapper must export smoke secret from parsed local value');

for (const pattern of [
  'ImageTag.*allowedPattern',
  'PrismaSchemaSha.*allowedPattern',
  'RuntimeImage.*allowedPattern',
  'MigrateImage.*allowedPattern',
  'DocumentVersion',
  'SSM_ImageTag',
  'SSM_PrismaSchemaSha',
  'SSM_RuntimeImage',
  'SSM_MigrateImage',
  'SSM_PublishEvidence',
  'AWS-RunShellScript',
  'repo:EVNSolution/clever-route-server:ref:refs/heads/main',
]) {
  assert(new RegExp(pattern, 's').test(doc), `docs must include ${pattern}`);
}

if (failures.length) {
  console.error('Route Ops SSM deploy validation failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, checked: [deployWorkflowPath, wrapperPath, docPath, publishWorkflowPath, ciWorkflowPath] }, null, 2));
