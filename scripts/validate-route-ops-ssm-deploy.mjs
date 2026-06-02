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
const imageDeployPath = 'scripts/deploy-route-ops-image.sh';
const imageRollbackPath = 'scripts/rollback-route-ops-image.sh';
const composePath = 'infra/compose/docker-compose.prod.yml';
const osrmHelperPath = 'scripts/osrm-ontario.sh';
const docPath = 'docs/deployment/route-ops-ssm-deploy.md';
const githubDocPath = 'docs/deployment/route-ops-github-deploy.md';
const osrmDocPath = 'docs/deployment/route-ops-osrm-ontario.md';

const deploy = read(deployWorkflowPath);
const publish = read(publishWorkflowPath);
const ci = read(ciWorkflowPath);
const wrapper = read(wrapperPath);
const imageDeploy = read(imageDeployPath);
const imageRollback = read(imageRollbackPath);
const compose = read(composePath);
const osrmHelper = read(osrmHelperPath);
const smoke = read('scripts/smoke-route-ops-production.mjs');
const doc = read(docPath);
const githubDoc = read(githubDocPath);
const osrmDoc = read(osrmDocPath);

function assertExplicitRouteOpsCompose(path, text) {
  assert(text.includes('ROUTE_OPS_COMPOSE_PROJECT_NAME'), `${path} must define/pass ROUTE_OPS_COMPOSE_PROJECT_NAME`);
  assert(/docker compose -p/.test(text) || /route_ops_compose\(\)/.test(text), `${path} must use explicit docker compose -p or validated route_ops_compose helper`);
}

function assertNoImplicitProdCompose(path, text) {
  const offenders = text
    .split('\n')
    .map((line, index) => ({ line: line.trim(), lineNumber: index + 1 }))
    .filter(({ line }) => line.includes('docker compose') && line.includes('infra/compose/docker-compose.prod.yml') && !line.includes('-p '));
  for (const offender of offenders) {
    assert(false, `${path}:${offender.lineNumber} must not use implicit compose project for production compose file: ${offender.line}`);
  }
}

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
assert(deploy.includes('Reconcile Route Ops Caddy ingress'), 'deploy workflow must reconcile Route Ops Caddy ingress before deploy smoke');
assert(deploy.includes("vars.ROUTE_OPS_RECONCILE_INGRESS_WITH_AWS_RUNSHELLSCRIPT == 'true'"), 'AWS-RunShellScript ingress reconcile must be explicitly opt-in by repository variable');
assert(deploy.includes('--document-name "AWS-RunShellScript"'), 'deploy workflow must use a fixed AWS-RunShellScript ingress reconcile command');
assert(/docker compose -p \\"?\$ROUTE_OPS_COMPOSE_PROJECT_NAME\\"? --env-file \.deploy\/current-image\.env -f infra\/compose\/docker-compose\.prod\.yml up -d --no-build --force-recreate --no-deps caddy/.test(deploy), 'ingress reconcile must force-recreate only the Route Ops Caddy service under explicit project');
assert(deploy.indexOf('Reconcile Route Ops Caddy ingress') < deploy.indexOf('Send custom SSM deploy command'), 'ingress reconcile must run before the deploy wrapper smoke');
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
assert(wrapper.includes('ROUTE_OPS_COMPOSE_PROJECT_NAME="${ROUTE_OPS_COMPOSE_PROJECT_NAME:-clever-route}"'), 'wrapper must default Route Ops compose project name to clever-route');
assert(wrapper.includes('ROUTE_OPS_COMPOSE_PROJECT_NAME must be exactly clever-route'), 'wrapper must reject compose project overrides');
assert(wrapper.includes('COMPOSE_PROJECT_NAME="$ROUTE_OPS_COMPOSE_PROJECT_NAME"'), 'wrapper must export COMPOSE_PROJECT_NAME as a secondary guard');
assert(wrapper.includes('CLEVER_ADMIN_WEB_LOGIN_SECRET'), 'wrapper must read host-local admin secret key');
assert(wrapper.includes('PUBLISH_EVIDENCE_URL'), 'wrapper must validate and record publish evidence URL when provided');
assert(!wrapper.includes('set -x'), 'wrapper must not enable shell xtrace');
assert(/ROUTE_OPS_SMOKE_LOGIN_SECRET="\$value"/.test(wrapper), 'wrapper must export smoke secret from parsed local value');

assert(imageDeploy.includes('ensure_deploy_disk_headroom "pre-pull"'), 'image deploy script must check disk headroom before pulling images');
assert(imageDeploy.indexOf('ensure_deploy_disk_headroom "pre-pull"') < imageDeploy.indexOf('pull delivery-api delivery-api-migrate'), 'disk headroom check must run before docker compose pull');
assert(imageDeploy.includes('docker compose -p "$ROUTE_OPS_COMPOSE_PROJECT_NAME"'), 'image deploy script must invoke compose with explicit project name');
assert(imageDeploy.includes('ROUTE_OPS_COMPOSE_PROJECT_NAME="${ROUTE_OPS_COMPOSE_PROJECT_NAME:-clever-route}"'), 'image deploy script must default compose project name to clever-route');
assert(imageDeploy.includes('ROUTE_OPS_COMPOSE_PROJECT_NAME must be exactly clever-route'), 'image deploy script must reject compose project overrides');
assert(imageDeploy.includes('enforce_no_legacy_route_ops_compose_project'), 'image deploy script must fail closed when legacy implicit Route Ops compose containers are still running');
assert(imageDeploy.includes('ROUTE_OPS_DEPLOY_MIN_FREE_MB'), 'image deploy script must expose minimum free MB threshold');
assert(imageDeploy.includes('ROUTE_OPS_DEPLOY_MIN_FREE_PERCENT'), 'image deploy script must expose minimum free percent threshold');
assert(imageDeploy.includes('ROUTE_OPS_RUNTIME_IMAGE_REPO'), 'image deploy script must scope cleanup to the Route Ops runtime image repository');
assert(imageDeploy.includes('ROUTE_OPS_MIGRATE_IMAGE_REPO'), 'image deploy script must scope cleanup to the Route Ops migrate image repository');
assert(imageDeploy.includes('ensure_route_ops_ingress'), 'image deploy script must force Route Ops ingress back to this repo before smoke');
assert(imageDeploy.includes('docker image rm "$image"'), 'image deploy cleanup must remove explicit image refs only');
assert(!imageDeploy.includes('docker system prune'), 'image deploy cleanup must not use docker system prune');
assert(!imageDeploy.includes('docker volume prune'), 'image deploy cleanup must not use docker volume prune');
assert(!imageDeploy.includes('docker container prune'), 'image deploy cleanup must not use docker container prune');
assert(imageDeploy.includes('prune_old_route_ops_images "post-promote"'), 'image deploy script must run retention cleanup after promotion');

assert(compose.includes('name: ${ROUTE_OPS_COMPOSE_PROJECT_NAME:-clever-route}'), 'production compose file must declare defensive top-level project name');
assert(imageRollback.includes('ROUTE_OPS_COMPOSE_PROJECT_NAME must be exactly clever-route'), 'rollback script must reject compose project overrides');
assert(imageRollback.includes('enforce_no_legacy_route_ops_compose_project'), 'rollback script must fail closed when legacy implicit Route Ops compose containers are still running');
assert(smoke.includes('/admin/ui/app/api/drivers?shopDomain=${encodeURIComponent(shopDomain)}'), 'production smoke must include shopDomain when checking Drivers API');
assertExplicitRouteOpsCompose(imageDeployPath, imageDeploy);
assertExplicitRouteOpsCompose(imageRollbackPath, imageRollback);
assert(wrapper.includes('export ROUTE_OPS_COMPOSE_PROJECT_NAME'), 'wrapper must export explicit compose project for child deploy script');
assertExplicitRouteOpsCompose(deployWorkflowPath, deploy);
assert(osrmHelper.includes('docker compose -p ${ROUTE_OPS_COMPOSE_PROJECT_NAME:-clever-route} -f infra/compose/docker-compose.prod.yml --profile osrm up -d osrm-ontario'), 'OSRM helper must suggest explicit Route Ops compose project for start command');
assert(osrmDoc.includes('docker compose -p "$ROUTE_OPS_COMPOSE_PROJECT_NAME" -f infra/compose/docker-compose.prod.yml --profile osrm up -d osrm-ontario'), 'OSRM docs must start OSRM with explicit Route Ops compose project');
for (const [path, text] of [
  [deployWorkflowPath, deploy],
  [imageDeployPath, imageDeploy],
  [imageRollbackPath, imageRollback],
  [osrmHelperPath, osrmHelper],
  [githubDocPath, githubDoc],
  [osrmDocPath, osrmDoc],
]) {
  assertNoImplicitProdCompose(path, text);
}

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
  'ROUTE_OPS_DEPLOY_MIN_FREE_MB',
  'ROUTE_OPS_DEPLOY_MIN_FREE_PERCENT',
  'ROUTE_OPS_COMPOSE_PROJECT_NAME',
  'docker compose -p "\\$ROUTE_OPS_COMPOSE_PROJECT_NAME"',
  'fail closed.*legacy implicit Route Ops container',
  'compose_caddy-data.*clever-route_caddy-data',
  'compose-caddy-1.*compose-delivery-api-1.*compose-postgres-1',
  'old and new Route Ops Postgres containers must never run concurrently',
  'current.*previous.*candidate',
]) {
  assert(new RegExp(pattern, 's').test(doc), `docs must include ${pattern}`);
}

if (failures.length) {
  console.error('Route Ops SSM deploy validation failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, checked: [deployWorkflowPath, wrapperPath, imageDeployPath, imageRollbackPath, composePath, osrmHelperPath, docPath, githubDocPath, osrmDocPath, publishWorkflowPath, ciWorkflowPath] }, null, 2));
