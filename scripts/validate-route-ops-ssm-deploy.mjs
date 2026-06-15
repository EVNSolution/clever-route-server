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
const releaseWorkflowPath = '.github/workflows/route-ops-release.yml';
const ciWorkflowPath = '.github/workflows/ci.yml';
const wrapperPath = 'scripts/ssm-route-ops-deploy.sh';
const imageDeployPath = 'scripts/deploy-route-ops-image.sh';
const imageRollbackPath = 'scripts/rollback-route-ops-image.sh';
const composePath = 'infra/compose/docker-compose.prod.yml';
const deliveryApiDockerfilePath = 'apps/delivery-api/Dockerfile';
const prismaDbPushGuardPath = 'apps/delivery-api/scripts/guard-prisma-db-push.sh';
const deliveryApiDepsPath = 'apps/delivery-api/src/modules/driver/driver.dependencies.ts';
const deliveryApiEnvExamplePath = 'infra/env/delivery-api.env.example';
const deliveryApiLocalEnvExamplePath = 'apps/delivery-api/.env.example';
const proofMediaDocPath = 'apps/delivery-api/docs/api/driver-proof-media.md';
const ssmDocumentPath = 'infra/ssm/route-ops-deploy-document.json';
const osrmHelperPath = 'scripts/osrm-ontario.sh';
const deployControlBundlePath = 'scripts/route-ops-deploy-control-bundle.sh';
const deployScopeGuardPath = 'scripts/guard-route-ops-deploy-scope.mjs';
const docPath = 'docs/deployment/route-ops-ssm-deploy.md';
const githubDocPath = 'docs/deployment/route-ops-github-deploy.md';
const osrmDocPath = 'docs/deployment/route-ops-osrm-ontario.md';
const releaseManifestPath = 'scripts/route-ops-release-manifest.mjs';
const releaseManifestTestPath = 'scripts/test-route-ops-release-manifest.mjs';

const deploy = read(deployWorkflowPath);
const publish = read(publishWorkflowPath);
const ci = read(ciWorkflowPath);
const release = read(releaseWorkflowPath);
const wrapper = read(wrapperPath);
const imageDeploy = read(imageDeployPath);
const imageRollback = read(imageRollbackPath);
const compose = read(composePath);
const deliveryApiDockerfile = read(deliveryApiDockerfilePath);
const prismaDbPushGuard = read(prismaDbPushGuardPath);
const deliveryApiDeps = read(deliveryApiDepsPath);
const deliveryApiEnvExample = read(deliveryApiEnvExamplePath);
const deliveryApiLocalEnvExample = read(deliveryApiLocalEnvExamplePath);
const proofMediaDoc = read(proofMediaDocPath);
const ssmDocument = read(ssmDocumentPath);
const osrmHelper = read(osrmHelperPath);
const deployControlBundle = read(deployControlBundlePath);
const deployScopeGuard = read(deployScopeGuardPath);
const smoke = read('scripts/smoke-route-ops-production.mjs');
const doc = read(docPath);
const githubDoc = read(githubDocPath);
const osrmDoc = read(osrmDocPath);
const releaseManifest = read(releaseManifestPath);
const releaseManifestTest = read(releaseManifestTestPath);


const routeOpsActionPins = [
  {
    workflowName: 'Route Ops publish',
    text: publish,
    action: 'docker/login-action',
    release: 'v4.2.0',
    sha: '650006c6eb7dba73a995cc03b0b2d7f5ca915bee',
  },
  {
    workflowName: 'Route Ops publish',
    text: publish,
    action: 'docker/setup-buildx-action',
    release: 'v4.1.0',
    sha: 'd7f5e7f509e45cec5c76c4d5afdd7de93d0b3df5',
  },
  {
    workflowName: 'Route Ops publish',
    text: publish,
    action: 'docker/build-push-action',
    release: 'v7.2.0',
    sha: 'f9f3042f7e2789586610d6e8b85c8f03e5195baf',
  },
  {
    workflowName: 'Route Ops release',
    text: release,
    action: 'docker/login-action',
    release: 'v4.2.0',
    sha: '650006c6eb7dba73a995cc03b0b2d7f5ca915bee',
  },
  {
    workflowName: 'Route Ops release',
    text: release,
    action: 'docker/setup-buildx-action',
    release: 'v4.1.0',
    sha: 'd7f5e7f509e45cec5c76c4d5afdd7de93d0b3df5',
  },
  {
    workflowName: 'Route Ops release',
    text: release,
    action: 'docker/build-push-action',
    release: 'v7.2.0',
    sha: 'f9f3042f7e2789586610d6e8b85c8f03e5195baf',
  },
  {
    workflowName: 'Route Ops release',
    text: release,
    action: 'aws-actions/configure-aws-credentials',
    release: 'v6.2.0',
    sha: 'e7f100cf4c008499ea8adda475de1042d6975c7b',
  },
  {
    workflowName: 'Route Ops deploy',
    text: deploy,
    action: 'aws-actions/configure-aws-credentials',
    release: 'v6.2.0',
    sha: 'e7f100cf4c008499ea8adda475de1042d6975c7b',
  },
];

const protectedActionPrefixes = ['docker/', 'aws-actions/'];
const fullShaPattern = /^[0-9a-f]{40}$/;

function parseUsesEntries(text) {
  return [...text.matchAll(/^\s*uses:\s*([^\s#]+)\s*$/gm)].map((match) => {
    const uses = match[1];
    const at = uses.lastIndexOf('@');
    return {
      uses,
      action: at === -1 ? uses : uses.slice(0, at),
      ref: at === -1 ? '' : uses.slice(at + 1),
      line: text.slice(0, match.index).split('\n').length,
    };
  });
}


function collectRouteOpsActionPinFailures(workflows, pins = routeOpsActionPins) {
  const errors = [];
  const pinsByAction = new Map(pins.map((pin) => [pin.action, pin]));
  for (const pin of pins) {
    const releaseComment = `${pin.action} ${pin.release} (Node 24) pinned to full commit SHA.`;
    if (!pin.text.includes(releaseComment)) {
      errors.push(`${pin.workflowName} must document ${pin.action} ${pin.release} for SHA ${pin.sha}`);
    }
  }

  for (const workflow of workflows) {
    const protectedUses = parseUsesEntries(workflow.text).filter((entry) => protectedActionPrefixes.some((prefix) => entry.action.startsWith(prefix)));
    if (protectedUses.length === 0) {
      errors.push(`${workflow.workflowName} must contain protected action uses for policy validation`);
    }
    for (const entry of protectedUses) {
      const pin = pinsByAction.get(entry.action);
      if (!pin) {
        errors.push(`${workflow.workflowName}:${entry.line} protected action ${entry.action} must be listed in routeOpsActionPins`);
        continue;
      }
      if (!fullShaPattern.test(entry.ref)) {
        errors.push(`${workflow.workflowName}:${entry.line} protected action ${entry.action} must use a full 40-char SHA, got ${entry.ref || '<missing>'}`);
        continue;
      }
      if (entry.ref !== pin.sha) {
        errors.push(`${workflow.workflowName}:${entry.line} protected action ${entry.action} must use reviewed SHA ${pin.sha}, got ${entry.ref}`);
      }
    }
  }
  return errors;
}

function assertRouteOpsActionPinSelfTest() {
  const badWorkflow = {
    workflowName: 'Route Ops publish fixture',
    text: `
      - name: Known good action
        uses: docker/login-action@650006c6eb7dba73a995cc03b0b2d7f5ca915bee
      - name: Floating action must fail
        uses: docker/setup-buildx-action@v4
      - name: Unexpected protected action must fail
        uses: docker/metadata-action@v5
      - name: Wrong full SHA must fail
        uses: docker/build-push-action@0000000000000000000000000000000000000000
`,
  };
  const errors = collectRouteOpsActionPinFailures([badWorkflow]);
  assert(errors.some((message) => message.includes('docker/setup-buildx-action') && message.includes('full 40-char SHA')), 'pin policy self-test must reject floating major protected actions');
  assert(errors.some((message) => message.includes('docker/metadata-action') && message.includes('routeOpsActionPins')), 'pin policy self-test must reject unregistered protected actions');
  assert(errors.some((message) => message.includes('docker/build-push-action') && message.includes('reviewed SHA')), 'pin policy self-test must reject wrong protected action SHA');
}

function assertRouteOpsActionPins() {
  assertRouteOpsActionPinSelfTest();
  const errors = collectRouteOpsActionPinFailures([
    { workflowName: 'Route Ops publish', text: publish },
    { workflowName: 'Route Ops deploy', text: deploy },
    { workflowName: 'Route Ops release', text: release },
  ]);
  for (const error of errors) {
    assert(false, error);
  }
}

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

function quotedStringValues(block) {
  return [...block.matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

function assertEveryPythonListMatches(path, text, variableName, expectedValues) {
  const pattern = new RegExp(`${variableName} = \\[([\\s\\S]*?)\\]`, 'g');
  const blocks = [...text.matchAll(pattern)].map((match) => match[1]);
  assert(blocks.length > 0, `${path} must declare ${variableName}`);
  for (const [index, block] of blocks.entries()) {
    const actualValues = quotedStringValues(block);
    assert(
      JSON.stringify(actualValues) === JSON.stringify(expectedValues),
      `${path} ${variableName} block ${index + 1} must match the canonical deploy-control contract; got ${JSON.stringify(actualValues)}`,
    );
  }
}

function assertEveryPythonSetMatches(path, text, variableName, expectedValues) {
  const pattern = new RegExp(`${variableName} = \\{([\\s\\S]*?)\\}`, 'g');
  const blocks = [...text.matchAll(pattern)].map((match) => match[1]);
  assert(blocks.length > 0, `${path} must declare ${variableName}`);
  const expectedSorted = [...expectedValues].sort();
  for (const [index, block] of blocks.entries()) {
    const actualSorted = quotedStringValues(block).sort();
    assert(
      JSON.stringify(actualSorted) === JSON.stringify(expectedSorted),
      `${path} ${variableName} block ${index + 1} must match the canonical deploy-control contract; got ${JSON.stringify(actualSorted)}`,
    );
  }
}



function workflowJobBlock(text, jobName) {
  const start = text.indexOf(`  ${jobName}:\n`);
  if (start === -1) return '';
  const rest = text.slice(start + 1);
  const next = rest.search(/\n  [a-zA-Z0-9_-]+:\n/);
  return next === -1 ? text.slice(start) : text.slice(start, start + 1 + next);
}

function assertJobPermission(path, text, jobName, permission, expected) {
  const block = workflowJobBlock(text, jobName);
  assert(block, `${path} must define job ${jobName}`);
  assert(new RegExp(`${permission}:\\s*${expected}`).test(block), `${path} job ${jobName} must set ${permission}:${expected}`);
}

function assertJobLacksWritePermission(path, text, jobName, permission) {
  const block = workflowJobBlock(text, jobName);
  assert(block, `${path} must define job ${jobName}`);
  assert(!new RegExp(`${permission}:\\s*write`).test(block), `${path} job ${jobName} must not request ${permission}:write`);
}

function stepBlock(text, stepName) {
  const start = text.indexOf(`      - name: ${stepName}\n`);
  if (start === -1) return '';
  const rest = text.slice(start + 1);
  const next = rest.search(/\n      - name: /);
  return next === -1 ? text.slice(start) : text.slice(start, start + 1 + next);
}

function assertNoInputsInterpolationInRunBlocks(path, text) {
  const lines = text.split('\n');
  let inRunBlock = false;
  let runIndent = 0;
  for (const [index, line] of lines.entries()) {
    const runMatch = line.match(/^(\s*)run:\s*\|/);
    if (runMatch) {
      inRunBlock = true;
      runIndent = runMatch[1].length;
      continue;
    }
    if (inRunBlock) {
      const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
      if (line.trim() && indent <= runIndent) inRunBlock = false;
    }
    if (inRunBlock && line.includes('${{ inputs.')) {
      assert(false, `${path}:${index + 1} must pass workflow_dispatch inputs through env before shell use`);
    }
  }
}

function assertHeredocMatches(path, command, heredocPath, expectedValues) {
  const pattern = new RegExp(`cat > "\\$tmp_dir/${heredocPath}" <<'FILES'\\n([\\s\\S]*?)\\nFILES`);
  const match = command.match(pattern);
  if (!match) {
    assert(false, `${path} must define ${heredocPath} heredoc allowlist`);
    return;
  }
  const actualValues = match[1]
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  assert(
    JSON.stringify(actualValues) === JSON.stringify(expectedValues),
    `${path} ${heredocPath} heredoc must match the canonical deploy-control contract; got ${JSON.stringify(actualValues)}`,
  );
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
assert(/timeout-minutes:\s*120/.test(deploy), 'deploy workflow must allow enough time for traced cold route_engine activation');
assert(deploy.includes("github.ref != 'refs/heads/main'"), 'deploy workflow must require refs/heads/main');
assert(deploy.includes('DEPLOY_ALLOWED_ACTORS is required'), 'deploy actor allowlist must fail closed when empty');
assertRouteOpsActionPins();

assert(/workflow_dispatch:\n/.test(release), 'release workflow must be workflow_dispatch');
for (const forbidden of ['pull_request:', 'schedule:', 'workflow_run:', 'repository_dispatch:']) {
  assert(!release.includes(forbidden), `release workflow must not include ${forbidden}`);
}
assert(!/^  push:/m.test(release), 'release workflow must not include push trigger');
assert(release.includes("github.ref != 'refs/heads/main'"), 'release workflow must require refs/heads/main');
assert(release.includes('DEPLOY_ALLOWED_ACTORS is required and must fail closed before preparing Route Ops release.'), 'release prepare actor allowlist must fail closed when empty');
assert(release.includes('DEPLOY_ALLOWED_ACTORS is required and must fail closed before promoting Route Ops release.'), 'release promote actor allowlist must fail closed when empty');
assert(release.indexOf('Require actor allowlist') < release.indexOf('Configure AWS credentials through OIDC'), 'release actor allowlist must run before AWS credentials are requested');
assertNoInputsInterpolationInRunBlocks(releaseWorkflowPath, release);
assertJobPermission(releaseWorkflowPath, release, 'prepare_publish', 'packages', 'write');
assertJobLacksWritePermission(releaseWorkflowPath, release, 'prepare_publish', 'id-token');
assertJobPermission(releaseWorkflowPath, release, 'prepare_dry_run', 'id-token', 'write');
assertJobPermission(releaseWorkflowPath, release, 'prepare_dry_run', 'packages', 'read');
assertJobLacksWritePermission(releaseWorkflowPath, release, 'prepare_dry_run', 'packages');
assertJobPermission(releaseWorkflowPath, release, 'promote_deploy', 'id-token', 'write');
assertJobPermission(releaseWorkflowPath, release, 'promote_deploy', 'packages', 'read');
assertJobLacksWritePermission(releaseWorkflowPath, release, 'promote_deploy', 'packages');
assert(release.includes('DRY_RUN: "true"'), 'release prepare must generate a dryRun=true deploy-control bundle');
assert(release.includes('DRY_RUN: "false"'), 'release promote must generate a dryRun=false deploy-control bundle');
assert((release.match(/Validate AWS\/SSM variable configuration/g) || []).length >= 2, 'release prepare and promote must validate AWS/SSM variables before OIDC');
assert(release.includes('AWS_ROUTE_OPS_DEPLOY_ROLE_ARN AWS_REGION SSM_ROUTE_OPS_TARGET_TAG_KEY SSM_ROUTE_OPS_TARGET_TAG_VALUE SSM_ROUTE_OPS_DOCUMENT_NAME SSM_ROUTE_OPS_DOCUMENT_VERSION'), 'release AWS/SSM validation must require deploy role, region, target, document, and document version vars');
assert(release.includes('AWS-RunShellScript is not allowed for Route Ops release deploy.'), 'release workflow must reject AWS-RunShellScript as deploy document');
assert(release.includes('SSM_ROUTE_OPS_DOCUMENT_VERSION must be a pinned numeric reviewed version.'), 'release workflow must require a pinned numeric SSM document version');
assert(release.indexOf('Validate AWS/SSM variable configuration') < release.indexOf('Configure AWS credentials through OIDC'), 'release prepare must validate SSM variables before OIDC credentials');
assert(release.lastIndexOf('Validate AWS/SSM variable configuration') < release.lastIndexOf('Configure AWS credentials through OIDC'), 'release promote must validate SSM variables before OIDC credentials');
assert(release.includes('mode=promote -f release_run_id=${GITHUB_RUN_ID} -f release_manifest_sha256=${manifest_sha}'), 'release prepare summary must hand off only run id and manifest sha to promote');
assert(!release.includes('-f image_tag=') && !release.includes('-f delivery_api_image='), 'release promote handoff must not accept mutable image coordinates');
assert(release.includes('scripts/route-ops-release-manifest.mjs validate "$manifest_path" --expect-sha "$EXPECTED_MANIFEST_SHA"'), 'release promote must validate the manifest digest before exporting fields');
assert(release.includes('find "$manifest_dir" -name release-manifest.json -type f'), 'release promote must locate downloaded manifest artifacts even when gh creates an artifact subdirectory');
assert(release.includes('steps.prepare_manifest.outputs.manifest_path'), 'release promote must pass the discovered manifest path to validation');
assert(release.includes('id: prepare_manifest'), 'release promote download step must define the prepare_manifest id used by validation');
assert(!release.includes('      - name: Checkout exact release commit\n      - name: Checkout exact release commit'), 'release promote must not contain duplicate no-op checkout step');
assert(release.includes('git checkout --detach "$COMMIT_SHA"'), 'release promote must check out the exact manifest commit');
assert(release.includes('[ "${ROUTE_ENGINE_IMAGE%:*}" != "$ROUTE_ENGINE_IMAGE_REPO" ]'), 'release prepare must exact-match route_engine image repository before any pull');
assert(release.includes('route_engine_tag="${ROUTE_ENGINE_IMAGE##*:}"'), 'release prepare must validate route_engine tag separately from exact repository');
assert(!release.includes('^${ROUTE_ENGINE_IMAGE_REPO}:'), 'release prepare must not interpolate the route_engine repository string into a regex');
assert(release.includes('Route Ops SSM dry-run output is missing no-mutation proof.'), 'release prepare must assert dry-run no-mutation SSM output before manifest creation');
assert(release.includes('Route Ops SSM dry-run output is missing manifest validation proof.'), 'release prepare must assert dry-run manifest validation output before manifest creation');
assert(release.includes('StandardOutputContent:StandardOutputContent'), 'release prepare must read SSM standard output to validate dry-run evidence');
assert(release.includes('route_engine_image_digest'), 'release prepare must require a route_engine image digest input');
assert(release.includes('ROUTE_ENGINE_IMAGE_DIGEST: ${{ inputs.route_engine_image_digest }}'), 'release prepare must pass route_engine image digest through env before shell use');
assert(release.includes('expected_digest_prefix="${ROUTE_ENGINE_IMAGE_REPO}@sha256:"'), 'release prepare must exact-match route_engine digest repository before any pull');
assert(release.includes('RepoDigests'), 'release workflow must inspect route_engine RepoDigests for immutable digest verification');
assert(release.includes('route_engine image digest mismatch'), 'release workflow must fail closed on route_engine digest mismatch');
assert(release.includes('vars.ROUTE_ENGINE_GHCR_READ_USERNAME || github.actor'), 'release workflow must use a cross-repo GHCR read username var before falling back to actor');
assert(release.includes('secrets.ROUTE_ENGINE_GHCR_READ_TOKEN || secrets.GITHUB_TOKEN'), 'release workflow must use a cross-repo GHCR read token secret before falling back to GITHUB_TOKEN');
assert(release.includes('read -r total_count instance_id ping_status agent_version'), 'release SSM target preflight must capture agent_version with the variable used by validation');
assert(!release.includes('_agent_version'), 'release SSM target preflight must not capture an unused _agent_version');
assert((release.match(/python3 - "\$agent_version" <<'PY'/g) || []).length >= 2, 'release prepare and promote must both validate SSM AgentVersion');
assert(release.includes('Route Ops SSM target instance id is missing.'), 'release SSM target preflight must fail closed on missing instance id');
assert((release.match(/Verify route_engine worker image revision label/g) || []).length >= 2, 'release prepare and promote must verify route_engine image revision label');
assert(release.includes('docker pull "$ROUTE_ENGINE_IMAGE"'), 'release workflow must pull the pinned route_engine image before deploy manifest/deploy');
assert(release.includes('org.opencontainers.image.revision'), 'release workflow must verify route_engine image revision label');
assert(release.includes('routeEngineImageRevision: process.env.ROUTE_ENGINE_IMAGE_REVISION'), 'release manifest must record machine-verified route_engine image revision');
assert(release.includes('routeEngineImageDigest: process.env.ROUTE_ENGINE_IMAGE_DIGEST'), 'release manifest must record machine-verified route_engine image digest');
assert(release.includes('--instance-ids "$INSTANCE_ID"'), 'release workflow must send SSM commands to the resolved exact instance id');
assert(!release.includes('--targets "Key=tag:'), 'release workflow must not send production commands by mutable tag selector');
assert(releaseManifest.includes('CONTROL_CHARS') && releaseManifest.includes('control characters are not allowed'), 'release manifest validator must reject control characters before GITHUB_OUTPUT export');
assert(releaseManifest.includes('release manifest contains unknown field'), 'release manifest validator must reject unknown top-level fields');
assert(releaseManifest.includes('tag must match imageTag'), 'release manifest validator must bind image outputs to imageTag');
assert(releaseManifest.includes('routeEngineImageRevision must match routeEngineImage tag'), 'release manifest validator must bind route_engine image revision to route_engine image tag');
assert(releaseManifest.includes('routeEngineImageDigest must be ghcr.io/evnsolution/route-engine-worker@sha256:<64-hex-digest>'), 'release manifest validator must require route_engine immutable digest evidence');
assert(releaseManifest.includes('image-revision-label-digest-and-audit-url'), 'release manifest validator must require the machine-verified route_engine evidence contract');
assert(releaseManifestTest.includes('extra_output=pwned'), 'release manifest tests must cover GITHUB_OUTPUT newline injection');
assert(releaseManifestTest.includes('wrongRouteEngineRevision'), 'release manifest tests must cover route_engine revision/tag mismatch');
assert(releaseManifestTest.includes('wrongRouteEngineDigest'), 'release manifest tests must cover route_engine digest mismatch');
assert(deploy.includes('AWS_ROUTE_OPS_DEPLOY_ROLE_ARN'), 'deploy workflow must use AWS deploy role variable');
assert(deploy.includes('git merge-base --is-ancestor "$IMAGE_TAG" origin/main'), 'deploy workflow must verify image tag is reachable from origin/main');
assert(deploy.includes('publish_evidence_url'), 'deploy workflow must require publish evidence URL');
assert(deploy.includes('route_engine_image'), 'deploy workflow must require an explicit route_engine worker image');
assert(deploy.includes('route_engine_publish_evidence_url'), 'deploy workflow must require route_engine publish evidence URL for the deploy-control audit trail');
assert(deploy.includes('ROUTE_ENGINE_IMAGE_REPO: ghcr.io/evnsolution/route-engine-worker'), 'deploy workflow must pin the route_engine image repository allowlist');
assert(deploy.includes('/actions/runs/${publish_run_id}'), 'deploy workflow must query GitHub Actions run metadata for publish evidence');
assert(deploy.includes("run.get('conclusion') != 'success'"), 'deploy workflow must require successful publish run evidence');
assert(deploy.includes("run.get('head_branch') != 'main'"), 'deploy workflow must require publish run on main');
assert(deploy.includes("head_sha"), 'deploy workflow must require publish run SHA to match image tag');
assert(deploy.includes('Checkout deploy-control source at image tag'), 'deploy workflow must check out deploy-control source at the image tag before bundling');
assert(deploy.includes('git checkout --detach "$IMAGE_TAG"'), 'deploy workflow must pin bundled deploy-control files to the image tag commit');
assert(deploy.includes('AWS-RunShellScript is not allowed'), 'deploy workflow must explicitly reject AWS-RunShellScript document configuration');
assert(deploy.includes('Prepare deploy control files for custom SSM document'), 'deploy workflow must prepare reviewed deploy-control files before running the host deploy wrapper');
assert(deploy.includes('scripts/route-ops-deploy-control-bundle.sh bundle-files'), 'deploy workflow must load the reviewed deploy-control file allowlist from the bundle helper');
const expectedDeployControlFiles = [
  'infra/caddy/Caddyfile',
  'infra/compose/docker-compose.prod.yml',
  'scripts/deploy-route-ops-image.sh',
  'scripts/rollback-route-ops-image.sh',
  'scripts/ssm-route-ops-deploy.sh',
  'scripts/provision-route-engine-graph-from-s3.sh',
  'scripts/smoke-route-ops-production.mjs',
  'scripts/route-ops-deploy-control-bundle.sh',
];
const expectedDeployControlTarEntries = ['deploy-control-manifest.json', ...expectedDeployControlFiles].sort();
const expectedDeployControlManifestKeys = [
  'schemaVersion',
  'dryRun',
  'runId',
  'commitSha',
  'imageTag',
  'prismaSchemaSha',
  'deliveryApiImage',
  'deliveryApiMigrateImage',
  'routeEngineImage',
  'routeEnginePublishEvidenceUrl',
  'publishEvidenceUrl',
  'artifactBucket',
  'artifactPrefix',
  'bundleFile',
  's3Uri',
  'deployControlFiles',
];
for (const file of expectedDeployControlFiles) {
  assert(deployControlBundle.includes(file), `deploy-control source sync helper must include ${file}`);
}
const deployControlListMatch = deployControlBundle.match(/bundle_files\(\) \{\n\s+cat <<'FILES'\n(?<body>[\s\S]*?)\nFILES\n\}/);
if (deployControlListMatch?.groups?.body) {
  const actualDeployControlFiles = deployControlListMatch.groups.body
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  assert(
    JSON.stringify(actualDeployControlFiles) === JSON.stringify(expectedDeployControlFiles),
    `deploy-control source sync allowlist must exactly match reviewed files; got ${JSON.stringify(actualDeployControlFiles)}`,
  );
} else {
  assert(false, 'deploy-control source sync allowlist block must be parseable');
}
assertEveryPythonListMatches(deployControlBundlePath, deployControlBundle, 'allowed_files', expectedDeployControlFiles);
assertEveryPythonSetMatches(deployControlBundlePath, deployControlBundle, 'allowed_keys', expectedDeployControlManifestKeys);
const helperExpectedTarMatch = deployControlBundle.match(/expected = sorted\(\[([\s\S]*?)\]\)/);
if (helperExpectedTarMatch) {
  assert(
    JSON.stringify(quotedStringValues(helperExpectedTarMatch[1]).sort()) === JSON.stringify(expectedDeployControlTarEntries),
    'deploy-control helper tar entry allowlist must match the canonical deploy-control contract',
  );
} else {
  assert(false, 'deploy-control helper must declare expected tar entries');
}
assert(deployControlBundle.includes('refusing secret-like deploy-control path'), 'deploy-control source sync helper must reject secret-like paths before bundling');
assert(deploy.includes('ROUTE_OPS_DEPLOY_CONTROL_BUCKET: route-ops-artifacts-902837199612-ap-northeast-2'), 'deploy workflow must select the Route Ops specific artifact bucket');
assert(deploy.includes('ROUTE_OPS_DEPLOY_CONTROL_PREFIX: artifacts/route-ops/prod/deploy-control'), 'deploy workflow must use the approved Route Ops deploy-control prefix');
assert(deploy.includes('scripts/route-ops-deploy-control-bundle.sh validate-source-file "$file"'), 'deploy workflow must reject source symlinks/hardlinks/non-regular files before staging');
assert(deploy.includes('aws s3 cp "$BUNDLE_PATH" "$S3_URI" --sse AES256 --no-progress'), 'deploy workflow must upload the deploy-control bundle to S3 with SSE-S3');
assert(deploy.includes('DeployControlBundleS3Uri'), 'deploy workflow must pass deploy-control bundle S3 URI to the custom SSM document');
assert(deploy.includes('DeployControlBundleSha256'), 'deploy workflow must pass deploy-control bundle SHA256 to the custom SSM document');
assert(!deploy.includes('DeployControlBundleBase64'), 'deploy workflow must not pass deploy-control bundle base64 through SSM');
assert(!deploy.includes('base64 -w0'), 'deploy workflow must not base64-encode the deploy-control bundle for SSM');
assert(deploy.includes('dry_run'), 'deploy workflow must expose dry-run validation mode');
assert(deploy.includes("'dryRun': dry_run == 'true'"), 'deploy workflow must write dry-run state into the deploy-control manifest');
assert(deploy.includes("'routeEngineImage': route_engine_image"), 'deploy workflow must write route_engine image into the deploy-control manifest');
assert(deploy.includes("'routeEnginePublishEvidenceUrl': route_engine_publish_evidence_url"), 'deploy workflow must write route_engine publish evidence into the deploy-control manifest');
assert(deploy.includes('DRIVER_APP_DOWNLOAD_URL') && deploy.includes('DriverAppDownloadUrl'), 'deploy workflow must pass the driver app download URL only through the custom SSM command parameter file');
assert(deploy.includes('ssmParameterChars DeployControlBundleS3Uri'), 'deploy workflow must log SSM parameter sizes for the reduced parameters');
assert(deploy.includes('/tmp/route-ops-deploy-parameters.json'), 'deploy workflow must prepare one parameter file for the custom SSM document');
assert(deploy.includes('--parameters file:///tmp/route-ops-deploy-parameters.json'), 'custom deploy SendCommand must use the prepared parameter file');
assert(deploy.includes('Upload deploy-control bundle artifact'), 'deploy workflow must upload the deploy-control bundle only after AWS credentials are configured');
assert(deploy.indexOf('Prepare deploy control files for custom SSM document') < deploy.indexOf('Configure AWS credentials through OIDC'), 'deploy-control source prep must run before AWS credentials are configured');
assert(deploy.indexOf('Upload deploy-control bundle artifact') > deploy.indexOf('Resolve deploy-control artifact bucket'), 'deploy-control bundle upload must run after the artifact bucket is resolved with AWS identity evidence');
assert(deploy.indexOf('Upload deploy-control bundle artifact') < deploy.indexOf('Verify SSM target resolves to one online managed node'), 'deploy-control bundle upload must happen before SSM dry-run target validation');
assert(deploy.indexOf('Upload deploy-control bundle artifact') < deploy.indexOf('Send custom SSM deploy command'), 'deploy-control bundle upload must run before the custom deploy document');
assert(deploy.indexOf('Prepare deploy control files for custom SSM document') < deploy.indexOf('Send custom SSM deploy command'), 'deploy-control source prep must run before the custom deploy document');
const uploadStep = stepBlock(deploy, 'Upload deploy-control bundle artifact');
assert(!uploadStep.includes('scripts/route-ops-deploy-control-bundle.sh'), 'deploy-control upload step must not execute deploy-control source helper after AWS credentials are configured');
assert(uploadStep.includes('aws s3 cp "$BUNDLE_PATH" "$S3_URI" --sse AES256 --no-progress'), 'deploy-control upload step must only upload the prebuilt bundle to S3 with SSE-S3');
assert(deploy.includes('Reconcile Route Ops Caddy ingress'), 'deploy workflow must reconcile Route Ops Caddy ingress before deploy smoke');
assert(deploy.includes("vars.ROUTE_OPS_RECONCILE_INGRESS_WITH_AWS_RUNSHELLSCRIPT == 'true'"), 'AWS-RunShellScript ingress reconcile must be explicitly opt-in by repository variable');
assert(deploy.includes("inputs.dry_run == 'false' && vars.ROUTE_OPS_RECONCILE_INGRESS_WITH_AWS_RUNSHELLSCRIPT == 'true'"), 'AWS-RunShellScript ingress reconcile must be disabled during dry-run validation');
assert(deploy.includes('--document-name "AWS-RunShellScript"'), 'deploy workflow must use a fixed AWS-RunShellScript command only for optional ingress reconcile');
assert(/docker compose -p \\"?\$ROUTE_OPS_COMPOSE_PROJECT_NAME\\"? --env-file \.deploy\/current-image\.env -f infra\/compose\/docker-compose\.prod\.yml up -d --no-build --force-recreate --no-deps caddy/.test(deploy), 'ingress reconcile must force-recreate only the Route Ops Caddy service under explicit project');
assert(deploy.indexOf('Reconcile Route Ops Caddy ingress') < deploy.indexOf('Send custom SSM deploy command'), 'ingress reconcile must run before the deploy wrapper smoke');
assert(deploy.includes('target_query="[length(InstanceInformationList), InstanceInformationList[0].InstanceId, InstanceInformationList[0].PingStatus, InstanceInformationList[0].AgentVersion]"'), 'deploy workflow must resolve target count, instance id, online status, and agent version from one describe-instance-information call');
assert(deploy.includes('3.3.2746.0'), 'deploy workflow must require SSM AgentVersion >= 3.3.2746.0 for ENV_VAR interpolation');
assert(deploy.includes('--instance-ids "$INSTANCE_ID"'), 'deploy workflow must send command to the resolved exact instance id');
assert(!deploy.includes('--targets "Key=tag:'), 'deploy workflow must not send production command by mutable tag selector');
assert(deploy.includes('Command.[CommandId,TargetCount]'), 'deploy workflow must read SendCommand TargetCount');
assert(deploy.includes('TargetCount must be 1'), 'deploy workflow must assert SendCommand TargetCount is 1');
assert(deploy.includes('for _ in {1..720}; do'), 'deploy workflow must poll long enough to let the custom SSM document produce host trace evidence');
assert(deploy.includes('--max-concurrency "1"'), 'deploy workflow must set max-concurrency=1');
assert(deploy.includes('--max-errors "0"'), 'deploy workflow must set max-errors=0');
assert(deploy.includes('SSM_ROUTE_OPS_DOCUMENT_VERSION'), 'deploy workflow must require explicit SSM document version');
assert(!/secrets\.(?!DRIVER_APP_DOWNLOAD_URL\b)/.test(deploy), 'deploy workflow must not reference GitHub secrets except the driver app download URL handoff');
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
assert(publish.includes('Require actor allowlist'), 'publish workflow must require a fail-closed actor allowlist');
assert(publish.includes('DEPLOY_ALLOWED_ACTORS is required and must fail closed before publishing Route Ops images.'), 'publish actor allowlist must fail closed when empty');
assert(!publish.includes('Optional actor allowlist'), 'publish workflow actor allowlist must not be optional');
assert(!publish.includes("if: vars.DEPLOY_ALLOWED_ACTORS != ''"), 'publish actor allowlist must not be skipped when the allowlist is empty');
assert(publish.indexOf('Require actor allowlist') < publish.indexOf('actions/checkout'), 'publish actor allowlist must run before checkout/build/package work');
assert(ci.includes('apps/delivery-api/src/routes/admin-ui-[^/]+\\.ts'), 'CI Route Ops filters must include extracted admin-ui route helper files');
assert(ci.includes('apps/delivery-api/tests/admin-ui-[^/]+\\.test\\.ts'), 'CI Route Ops filters must include extracted admin-ui helper test files');
assert(!/actions:\s*read/.test(publish), 'publish workflow must not request actions:read for deploy provenance checks');
assert(publish.includes('FRONTEND_STATIC_IMAGE'), 'publish workflow must define a frontend static image repo');
assert(publish.includes('apps/route-ops-web/Dockerfile'), 'publish workflow must build the Route Ops web static Dockerfile');
assert(publish.includes('org.clever-route.route-ops-web-static-sha'), 'publish workflow must label the frontend static artifact SHA');
assert(publish.includes('org.clever-route.image-role=route-ops-web-static'), 'publish workflow must label the frontend static image role');

assert(wrapper.includes('ROUTE_OPS_DEPLOY_LOCK_HELD=1'), 'wrapper must export lock-held marker');
assert(wrapper.includes('ROUTE_OPS_COMPOSE_PROJECT_NAME="${ROUTE_OPS_COMPOSE_PROJECT_NAME:-clever-route}"'), 'wrapper must default Route Ops compose project name to clever-route');
assert(wrapper.includes('ROUTE_OPS_COMPOSE_PROJECT_NAME must be exactly clever-route'), 'wrapper must reject compose project overrides');
assert(wrapper.includes('COMPOSE_PROJECT_NAME="$ROUTE_OPS_COMPOSE_PROJECT_NAME"'), 'wrapper must export COMPOSE_PROJECT_NAME as a secondary guard');
assert(wrapper.includes('CLEVER_ADMIN_WEB_LOGIN_SECRET'), 'wrapper must read host-local admin secret key');
assert(wrapper.includes('PUBLISH_EVIDENCE_URL'), 'wrapper must validate and record publish evidence URL when provided');
assert(wrapper.includes('ROUTE_OPS_WEB_STATIC_IMAGE'), 'wrapper must derive and validate the frontend static image');
assert(wrapper.includes('ROUTE_OPS_WEB_STATIC_VOLUME'), 'wrapper must derive and validate the SHA-scoped frontend static volume');
assert(wrapper.includes('ROUTE_ENGINE_IMAGE'), 'wrapper must derive and validate the route_engine worker image');
assert(wrapper.includes('ROUTE_ENGINE_GRAPH_HOST_DIR'), 'wrapper must expose the route_engine graph host directory');
assert(deployControlBundle.includes('scripts/provision-route-engine-graph-from-s3.sh'), 'deploy-control bundle must include the route_engine S3 graph provision helper');
assert(deployScopeGuard.includes('scripts/provision-route-engine-graph-from-s3.sh'), 'Route Ops deploy scope guard must allow the route_engine S3 graph provision helper');
assert(ssmDocument.includes('scripts/provision-route-engine-graph-from-s3.sh'), 'SSM deploy document must sync the route_engine S3 graph provision helper');
assert(wrapper.includes('ROUTE_OPS_DEPLOY_TRACE_DIR'), 'wrapper must establish a host-local deploy trace directory');
assert(wrapper.includes('ssm-wrapper.log'), 'wrapper must persist deploy stdout/stderr to a host-local wrapper log');
assert(wrapper.includes('PIPESTATUS[0]'), 'wrapper must preserve deploy script exit status through tee');
assert(!wrapper.includes('set -x'), 'wrapper must not enable shell xtrace');
assert(/ROUTE_OPS_SMOKE_LOGIN_SECRET="\$value"/.test(wrapper), 'wrapper must export smoke secret from parsed local value');

assert(imageDeploy.includes('ensure_deploy_disk_headroom "pre-pull"'), 'image deploy script must check disk headroom before pulling images');
assert(imageDeploy.indexOf('ensure_deploy_disk_headroom "pre-pull"') < imageDeploy.indexOf('pull route-ops-web-static delivery-api delivery-api-migrate'), 'disk headroom check must run before docker compose pull');
assert(imageDeploy.includes('prune_old_route_ops_images "pre-pull-retention"'), 'image deploy script must prune stale Route Ops images before docker compose pull');
assert(imageDeploy.indexOf('prune_old_route_ops_images "pre-pull-retention"') < imageDeploy.indexOf('pull route-ops-web-static delivery-api delivery-api-migrate'), 'pre-pull stale image cleanup must run before docker compose pull');
assert(imageDeploy.includes('ensure_deploy_disk_headroom "post-pull"'), 'image deploy script must re-check disk headroom after pulling images');
assert(imageDeploy.includes('docker compose -p "$ROUTE_OPS_COMPOSE_PROJECT_NAME"'), 'image deploy script must invoke compose with explicit project name');
assert(imageDeploy.includes('ROUTE_OPS_COMPOSE_PROJECT_NAME="${ROUTE_OPS_COMPOSE_PROJECT_NAME:-clever-route}"'), 'image deploy script must default compose project name to clever-route');
assert(imageDeploy.includes('ROUTE_OPS_COMPOSE_PROJECT_NAME must be exactly clever-route'), 'image deploy script must reject compose project overrides');
assert(imageDeploy.includes('enforce_no_legacy_route_ops_compose_project'), 'image deploy script must fail closed when legacy implicit Route Ops compose containers are still running');
assert(imageDeploy.includes('ROUTE_OPS_DEPLOY_MIN_FREE_MB'), 'image deploy script must expose minimum free MB threshold');
assert(imageDeploy.includes('ROUTE_OPS_DEPLOY_MIN_FREE_PERCENT'), 'image deploy script must expose minimum free percent threshold');
assert(imageDeploy.includes('ROUTE_OPS_RUNTIME_IMAGE_REPO'), 'image deploy script must scope cleanup to the Route Ops runtime image repository');
assert(imageDeploy.includes('ROUTE_OPS_MIGRATE_IMAGE_REPO'), 'image deploy script must scope cleanup to the Route Ops migrate image repository');
assert(imageDeploy.includes('ROUTE_OPS_WEB_STATIC_IMAGE_REPO'), 'image deploy script must scope cleanup to the Route Ops web static image repository');
assert(imageDeploy.includes('ROUTE_OPS_WEB_STATIC_IMAGE'), 'image deploy script must track the frontend static image in deploy metadata');
assert(imageDeploy.includes('ROUTE_OPS_WEB_STATIC_VOLUME'), 'image deploy script must track the SHA-scoped frontend static volume in deploy metadata');
assert(imageDeploy.includes('ROUTE_ENGINE_IMAGE_REPO'), 'image deploy script must scope cleanup to the route_engine worker image repository');
assert(imageDeploy.includes('ROUTE_ENGINE_IMAGE'), 'image deploy script must track the route_engine worker image in deploy metadata');
assert(imageDeploy.includes('ROUTE_ENGINE_GRAPH_HOST_DIR'), 'image deploy script must track the route_engine graph host directory in deploy metadata');
assert(imageDeploy.includes('route_ops_trace_event'), 'image deploy script must persist structured deploy trace events');
assert(imageDeploy.includes('route_ops_trace_snapshot'), 'image deploy script must persist diagnostic snapshots on failure');
assert(imageDeploy.includes('route_engine_trace_monitor_start'), 'image deploy script must monitor route_engine during warmup/solve smoke');
assert(imageDeploy.includes('route_engine_smoke') && imageDeploy.includes('.monitor.log'), 'image deploy script must write a route_engine smoke monitor log');
assert(imageDeploy.includes('restartCount={{.RestartCount}}'), 'image deploy route_engine trace must record container restarts');
assert(imageDeploy.includes('host oom evidence'), 'image deploy failure snapshot must include host OOM evidence');
assert(imageDeploy.includes('oom-kill') && imageDeploy.includes('killed process'), 'image deploy failure snapshot must grep kernel OOM-killer messages');
assert(imageDeploy.includes('ROUTE_OPS_STATIC_ARTIFACT_STAGED'), 'image deploy script must track static artifact staging separately from backend mutation');
assert(imageDeploy.includes('ensure_route_engine_host_env'), 'image deploy script must configure production host route_engine env before activation');
assert(imageDeploy.includes('restore_route_engine_host_env_on_failure'), 'image deploy script must restore host route_engine env if activation fails');
assert(imageDeploy.includes('validate_route_engine_graph_artifacts'), 'image deploy script must validate mounted route_engine graph artifacts before activation');
assert(imageDeploy.includes('org.clever-route.graph-manifest-sha'), 'image deploy script must compare route_engine host graph artifacts with the worker image graph manifest label');
assert(imageDeploy.includes('ensure_static_artifact_env_file .deploy/current-image.env'), 'image deploy script must normalize legacy current static artifact metadata before mutation');
assert(imageDeploy.includes('validate_loaded_static_artifact_contract .deploy/candidate-image.env'), 'image deploy script must semantically validate candidate static image and volume before compose mutation');
assert(imageDeploy.includes('require_candidate_static_volume_isolated_from_current'), 'image deploy script must reject candidate static volumes shared with current metadata');
assert(imageDeploy.includes('pull route-ops-web-static delivery-api delivery-api-migrate route-engine'), 'image deploy script must pull frontend static, runtime, migrate, and route_engine images together');
assert(imageDeploy.includes('--profile route-engine up -d --no-build route-engine'), 'image deploy script must start route_engine through the explicit Route Ops compose project profile');
assert(imageDeploy.includes('smoke_route_engine_from_runtime_network'), 'image deploy script must smoke route_engine from the delivery-api runtime network before backend activation');
assert(imageDeploy.includes('route_engine ready smoke failed after readiness wait'), 'image deploy script must wait for route_engine readiness before failing the smoke');
assert(imageDeploy.includes('up --no-build --force-recreate route-ops-web-static'), 'image deploy script must stage the frontend static artifact before backend activation');
assert(imageDeploy.includes('ensure_route_ops_ingress'), 'image deploy script must force Route Ops ingress back to this repo before smoke');
assert(imageDeploy.includes('docker image rm "$image"'), 'image deploy cleanup must remove explicit image refs only');
assert(!imageDeploy.includes('docker system prune'), 'image deploy cleanup must not use docker system prune');
assert(!imageDeploy.includes('docker volume prune'), 'image deploy cleanup must not use docker volume prune');
assert(!imageDeploy.includes('docker container prune'), 'image deploy cleanup must not use docker container prune');
assert(imageDeploy.includes('prune_old_route_ops_images "post-promote"'), 'image deploy script must run retention cleanup after promotion');
assert(imageDeploy.includes('ensure_route_ops_osrm .deploy/candidate-image.env'), 'image deploy script must activate and smoke OSRM before delivery-api activation when OSRM_BASE_URL is configured');
assert(imageDeploy.includes('--profile osrm up -d --no-build osrm-ontario'), 'image deploy script must start OSRM through the explicit Route Ops compose project, not a manual sidecar');
assert(imageDeploy.includes('ROUTE_OPS_OSRM_HOST_SMOKE_URL'), 'image deploy script must support host-loopback OSRM smoke');
assert(imageDeploy.includes('ROUTE_OPS_OSRM_NETWORK_SMOKE_URL'), 'image deploy script must smoke OSRM from the delivery-api runtime network');
assert(imageDeploy.indexOf('ensure_route_ops_osrm .deploy/candidate-image.env') > imageDeploy.indexOf('run --rm delivery-api-migrate'), 'image deploy script must run migrations before OSRM/runtime smoke');
assert(imageDeploy.indexOf('ensure_route_engine .deploy/candidate-image.env') > imageDeploy.indexOf('run --rm delivery-api-migrate'), 'image deploy script must run migrations before route_engine runtime smoke');
assert(imageDeploy.lastIndexOf('validate_route_engine_graph_artifacts "$route_engine_graph_manifest_sha"') < imageDeploy.indexOf('run --rm delivery-api-migrate'), 'image deploy script must validate route_engine graph artifacts before migration or service mutation');
assert(imageDeploy.indexOf('ensure_route_ops_osrm .deploy/candidate-image.env') < imageDeploy.lastIndexOf('up -d --no-build --force-recreate --no-deps delivery-api'), 'image deploy script must ensure OSRM before restarting delivery-api');
assert(imageDeploy.indexOf('ensure_route_engine .deploy/candidate-image.env') < imageDeploy.lastIndexOf('up -d --no-build --force-recreate --no-deps delivery-api'), 'image deploy script must ensure route_engine before restarting delivery-api');
assert(imageDeploy.includes('stop_route_engine_if_disabled .deploy/candidate-image.env'), 'image deploy script must stop route_engine after delivery-api restart when ROUTE_ENGINE_BASE_URL is disabled');
assert(imageDeploy.includes('stop_route_ops_osrm_if_disabled .deploy/candidate-image.env'), 'image deploy script must stop OSRM after delivery-api restart when OSRM_BASE_URL is disabled');
assert(!imageDeploy.includes('stop osrm-ontario || true'), 'image deploy script must not swallow normal OSRM stop failures');
assert(imageDeploy.lastIndexOf('stop_route_ops_osrm_if_disabled .deploy/candidate-image.env') > imageDeploy.lastIndexOf('up -d --no-build --force-recreate --no-deps delivery-api'), 'image deploy script must stop disabled OSRM only after delivery-api has restarted with the disabled env');
assert(imageDeploy.includes('"routeEngineEnabled":%s'), 'image deploy history must record route_engine enablement state');
assert(imageDeploy.includes('"osrmEnabled":%s'), 'image deploy history must record OSRM enablement state');

assert(compose.includes('name: ${ROUTE_OPS_COMPOSE_PROJECT_NAME:-clever-route}'), 'production compose file must declare defensive top-level project name');
assert(compose.includes('route-ops-web-static:'), 'production compose must declare the Route Ops web static artifact service');
assert(compose.includes('ROUTE_OPS_WEB_STATIC_IMAGE'), 'production compose must require the frontend static image variable');
assert(compose.includes('ROUTE_OPS_WEB_STATIC_VOLUME'), 'production compose must require a SHA-scoped frontend static volume variable');
assert(compose.includes('$$staging'), 'production compose static handoff command must escape shell variables from compose interpolation');
assert(compose.includes('route-ops-web-static:/app/external/route-ops-web:ro'), 'delivery-api must mount the frontend static artifact read-only');
assert(compose.includes('route-engine:'), 'production compose must declare the internal route_engine service');
const deliveryApiComposeService = compose.match(/\n  delivery-api:\n([\s\S]*?)\n  delivery-api-migrate:/)?.[1] ?? '';
assert(deliveryApiComposeService.includes('healthcheck:'), 'delivery-api compose service must declare a healthcheck');
assert(deliveryApiComposeService.includes("host:'127.0.0.1'"), 'delivery-api healthcheck must probe loopback inside the container');
assert(deliveryApiComposeService.includes("path:'/healthz'"), 'delivery-api healthcheck must probe /healthz');
assert(deliveryApiComposeService.includes('process.exit(res.statusCode===200?0:1)'), 'delivery-api healthcheck must fail on non-200 /healthz responses');
assert(compose.includes('command: ["sh", "apps/delivery-api/scripts/guard-prisma-db-push.sh"]'), 'delivery-api-migrate compose service must run the guarded Prisma db push entrypoint');
assert(compose.includes('PRISMA_SCHEMA_SHA: ${PRISMA_SCHEMA_SHA:?PRISMA_SCHEMA_SHA is required}'), 'delivery-api-migrate compose service must inject PRISMA_SCHEMA_SHA into the guarded db push container');
assert(ci.includes('PRISMA_SCHEMA_SHA=abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd'), 'CI compose placeholder validation must pass PRISMA_SCHEMA_SHA for the guarded migrate service');
assert(deliveryApiDockerfile.includes('COPY apps/delivery-api/scripts ./apps/delivery-api/scripts'), 'delivery-api Dockerfile must copy the guarded Prisma db push entrypoint into the migrate image');
assert(deliveryApiDockerfile.includes('CMD ["sh", "apps/delivery-api/scripts/guard-prisma-db-push.sh"]'), 'delivery-api migrate image default command must run the guarded Prisma db push entrypoint');
assert(prismaDbPushGuard.includes('PRISMA_SCHEMA_SHA is required before prisma db push'), 'Prisma db push guard must fail closed when PRISMA_SCHEMA_SHA is missing');
assert(prismaDbPushGuard.includes('PRISMA_SCHEMA_SHA must be a 64-hex SHA256'), 'Prisma db push guard must validate PRISMA_SCHEMA_SHA shape before db push');
assert(prismaDbPushGuard.includes('sha256sum "$schema_path"'), 'Prisma db push guard must hash the schema file used by prisma db push');
assert(prismaDbPushGuard.includes('refusing prisma db push because schema SHA mismatch'), 'Prisma db push guard must fail closed on schema SHA mismatch');
assert(prismaDbPushGuard.includes('exec npm --prefix apps/delivery-api exec -- prisma db push --schema "$schema_path" --skip-generate'), 'Prisma db push guard must be the only path to prisma db push');
assert(!prismaDbPushGuard.includes('--accept-data-loss'), 'Prisma db push guard must not enable Prisma destructive data loss acceptance');
assert(compose.includes('ROUTE_ENGINE_IMAGE'), 'production compose must accept a pinned route_engine worker image variable');
assert(compose.includes('profiles:') && compose.includes('route-engine'), 'production route_engine service must be profile-gated for explicit activation');
assert(compose.includes('ROUTE_ENGINE_GRAPH_HOST_DIR'), 'production compose must mount route_engine graph artifacts from an explicit host directory');
assert(compose.includes('/app/routing_engine/v7_out/parquet:ro'), 'production route_engine graph mount must target the expected read-only parquet path');
assert(compose.includes('/srv/clever-route-server/data/driver-proof-media:/app/var/driver-proof-media'), 'production compose must bind-mount the approved local proof-media host directory');
assert(deliveryApiEnvExample.includes('DRIVER_PROOF_MEDIA_STORAGE_BACKEND=local'), 'production env example must explicitly select local proof-media storage');
assert(deliveryApiEnvExample.includes('DRIVER_PROOF_MEDIA_STORAGE_DIR=/app/var/driver-proof-media'), 'production env example must align proof-media storage dir with the compose mount');
assert(deliveryApiEnvExample.includes('DRIVER_PROOF_MEDIA_SCANNER_BACKEND=none'), 'production env example must keep proof-media scanner disabled by default');
assert(deliveryApiEnvExample.includes('DRIVER_PROOF_MEDIA_SCAN_MONITOR_BACKEND=none'), 'production env example must keep proof-media scan monitor disabled by default');
assert(deliveryApiDeps.includes("DEFAULT_DRIVER_PROOF_MEDIA_STORAGE_BACKEND = 'local'"), 'driver dependencies must expose the local proof-media storage default as a named constant');
assert(deliveryApiDeps.includes("DEFAULT_DRIVER_PROOF_MEDIA_SCANNER_BACKEND = 'none'"), 'driver dependencies must expose the disabled scanner default as a named constant');
assert(deliveryApiDeps.includes("DEFAULT_DRIVER_PROOF_MEDIA_SCAN_MONITOR_BACKEND = 'none'"), 'driver dependencies must expose the disabled scan-monitor default as a named constant');
assert(deliveryApiLocalEnvExample.includes('Use s3 only after private bucket/IAM'), 'app env example must not imply object storage is production-ready without private evidence');
assert(proofMediaDoc.includes('storage backend `local`, scanner backend `none`, and scan-monitor backend `none`'), 'proof-media docs must state the explicit storage/scanner defaults');
assert(proofMediaDoc.includes('Do not switch scanner or monitor backends to `http` until'), 'proof-media docs must gate scanner/monitor activation on private evidence');
const parsedSsmDocument = JSON.parse(ssmDocument);
const ssmRunCommand = parsedSsmDocument.mainSteps?.[0]?.inputs?.runCommand ?? [];
assert(parsedSsmDocument.mainSteps?.[0]?.inputs?.timeoutSeconds === '7200', 'SSM deploy document timeout must allow traced cold route_engine activation');
assertEveryPythonListMatches(ssmDocumentPath, ssmDocument, 'allowed_files', expectedDeployControlFiles);
assertEveryPythonSetMatches(ssmDocumentPath, ssmDocument, 'allowed_keys', expectedDeployControlManifestKeys);
const ssmExpectedTarMatch = ssmDocument.match(/expected = sorted\(\[([\s\S]*?)\]\)/);
if (ssmExpectedTarMatch) {
  assert(
    JSON.stringify(quotedStringValues(ssmExpectedTarMatch[1]).sort()) === JSON.stringify(expectedDeployControlTarEntries),
    'SSM document tar entry allowlist must match the canonical deploy-control contract',
  );
} else {
  assert(false, 'SSM document must declare expected tar entries');
}
assert(
  JSON.stringify(Object.keys(parsedSsmDocument.parameters).sort()) === JSON.stringify(['DeployControlBundleS3Uri', 'DeployControlBundleSha256', 'DriverAppDownloadUrl'].sort()),
  'SSM deploy document parameters must be reduced to DeployControlBundleS3Uri, DeployControlBundleSha256, and DriverAppDownloadUrl',
);
assert(ssmRunCommand.includes('aws s3 cp "$SSM_DeployControlBundleS3Uri" "$bundle_path" --no-progress'), 'SSM deploy document must download the deploy-control bundle from S3');
assert(ssmDocument.includes('Route Ops deploy-control bundle SHA256 mismatch'), 'SSM deploy document must verify deploy-control bundle SHA256 on the host');
assert(ssmDocument.includes('Route Ops deploy-control bundle manifest mismatch'), 'SSM deploy document must verify an exact host manifest');
assert(ssmDocument.includes('manifest validation result=passed'), 'SSM deploy document must log manifest validation success');
assert(ssmDocument.includes('dry-run complete') && ssmDocument.includes('no production files synced'), 'SSM deploy document must have a no-mutation dry-run exit');
assert(ssmDocument.includes('.deploy/source-backups'), 'SSM deploy document must back up host files before replacement');
assert(ssmRunCommand.some((command) => command.includes('python3 - "$tmp_dir/deploy-control-manifest.json" "$SSM_DeployControlBundleS3Uri"')), 'SSM deploy document must inline manifest validation before executing synced files');
assert(!ssmRunCommand.some((command) => command.includes('bash "$tmp_dir/scripts/route-ops-deploy-control-bundle.sh"')), 'SSM deploy document must not execute helper code from the downloaded bundle before source sync');
assert(
  ssmRunCommand.findIndex((command) => command.includes('dry-run complete')) < ssmRunCommand.findIndex((command) => command.includes('mkdir -p "$backup_dir"')),
  'SSM deploy document dry-run exit must happen before persistent backup directory creation',
);
assert(deployControlBundle.includes('refusing secret-like deploy-control path'), 'deploy-control bundle helper must reject secret-like deploy-control paths');
assert(deployControlBundle.includes('deploy-control source path must not be hardlinked'), 'deploy-control bundle helper must reject hardlinked source files before staging');
assert(deployControlBundle.includes('deploy-control source path is not a regular file'), 'deploy-control bundle helper must reject source symlinks/non-regular files before staging');
assert(ssmDocument.includes('ROUTE_OPS_DRIVER_APP_DOWNLOAD_URL') && imageDeploy.includes('ensure_driver_app_download_host_env'), 'deploy script must inject the driver app download URL into the host env before delivery-api restart');
assert(deployControlBundle.includes('deployControlFiles must exactly match reviewed allowlist'), 'deploy-control bundle helper must validate the manifest allowlist fail-closed');
assert(deployControlBundle.includes('SHA256 mismatch'), 'deploy-control bundle helper must fail closed on SHA256 mismatch');
assert(ssmRunCommand.some((command) => command.includes('done < "$tmp_dir/allowed-files"')), 'SSM deploy document must sync only inline allowlisted files after SHA and manifest validation');
const ssmAllowedFilesCommand = ssmRunCommand.find((command) => command.includes('cat > "$tmp_dir/allowed-files"')) || '';
assertHeredocMatches(ssmDocumentPath, ssmAllowedFilesCommand, 'allowed-files', expectedDeployControlFiles);
assert(ssmRunCommand.includes('bash -n scripts/deploy-route-ops-image.sh scripts/rollback-route-ops-image.sh scripts/ssm-route-ops-deploy.sh scripts/provision-route-engine-graph-from-s3.sh scripts/route-ops-deploy-control-bundle.sh'), 'SSM deploy document must syntax-check synced shell scripts before deploy');
assert(ssmDocument.includes('scripts/ssm-route-ops-deploy.sh'), 'SSM deploy document must invoke the reviewed host deploy wrapper after source sync');
assert(imageRollback.includes('ROUTE_OPS_ROLLBACK_STATIC_ARTIFACT_STAGED'), 'rollback script must track static artifact staging separately from backend mutation');
assert(imageRollback.includes('validate_loaded_static_artifact_contract .deploy/candidate-image.env'), 'rollback script must semantically validate candidate static image and volume before compose mutation');
assert(imageRollback.includes('require_candidate_static_volume_isolated_from_rollback_from'), 'rollback script must reject candidate static volumes shared with pre-rollback current metadata');
assert(imageRollback.includes('ROUTE_OPS_COMPOSE_PROJECT_NAME must be exactly clever-route'), 'rollback script must reject compose project overrides');
assert(imageRollback.includes('enforce_no_legacy_route_ops_compose_project'), 'rollback script must fail closed when legacy implicit Route Ops compose containers are still running');
assert(imageRollback.includes('ensure_route_ops_osrm .deploy/candidate-image.env'), 'rollback script must activate and smoke OSRM before delivery-api rollback activation when OSRM_BASE_URL is configured');
assert(imageRollback.includes('ensure_route_engine .deploy/candidate-image.env'), 'rollback script must activate and smoke route_engine before delivery-api rollback activation when ROUTE_ENGINE_BASE_URL is configured');
assert(imageRollback.includes('route_engine rollback ready smoke failed after readiness wait'), 'rollback script must wait for route_engine readiness before failing the smoke');
assert(imageRollback.includes('ROUTE_ENGINE_GRAPH_HOST_DIR'), 'rollback script must carry the route_engine graph host directory');
assert(imageRollback.includes('validate_route_engine_graph_artifacts'), 'rollback script must validate route_engine graph artifacts before activation');
assert(imageRollback.includes('org.clever-route.graph-manifest-sha'), 'rollback script must compare route_engine host graph artifacts with the worker image graph manifest label');
assert(imageRollback.includes('--profile osrm up -d --no-build osrm-ontario'), 'rollback script must start OSRM through the explicit Route Ops compose project, not a manual sidecar');
assert(imageRollback.includes('ROUTE_OPS_OSRM_HOST_SMOKE_URL'), 'rollback script must support host-loopback OSRM smoke');
assert(imageRollback.includes('ROUTE_OPS_OSRM_NETWORK_SMOKE_URL'), 'rollback script must smoke OSRM from the delivery-api runtime network');
assert(imageRollback.indexOf('ensure_route_ops_osrm .deploy/candidate-image.env') > imageRollback.indexOf('run --rm delivery-api-migrate'), 'rollback script must run migrations before OSRM/runtime smoke');
assert(imageRollback.indexOf('ensure_route_engine .deploy/candidate-image.env') > imageRollback.indexOf('run --rm delivery-api-migrate'), 'rollback script must run migrations before route_engine runtime smoke');
assert(imageRollback.lastIndexOf('validate_route_engine_graph_artifacts "$route_engine_graph_manifest_sha"') < imageRollback.indexOf('run --rm delivery-api-migrate'), 'rollback script must validate route_engine graph artifacts before migration or service mutation');
assert(imageRollback.indexOf('ensure_route_ops_osrm .deploy/candidate-image.env') < imageRollback.lastIndexOf('up -d --no-build --force-recreate --no-deps delivery-api'), 'rollback script must ensure OSRM before restarting delivery-api');
assert(imageRollback.indexOf('ensure_route_engine .deploy/candidate-image.env') < imageRollback.lastIndexOf('up -d --no-build --force-recreate --no-deps delivery-api'), 'rollback script must ensure route_engine before restarting delivery-api');
assert(imageRollback.includes('stop_route_engine_if_disabled .deploy/candidate-image.env'), 'rollback script must stop route_engine after delivery-api restart when ROUTE_ENGINE_BASE_URL is disabled');
assert(imageRollback.includes('stop_route_ops_osrm_if_disabled .deploy/candidate-image.env'), 'rollback script must stop OSRM after delivery-api restart when OSRM_BASE_URL is disabled');
assert(!imageRollback.includes('stop osrm-ontario || true'), 'rollback script must not swallow normal OSRM stop failures');
assert(imageRollback.lastIndexOf('stop_route_ops_osrm_if_disabled .deploy/candidate-image.env') > imageRollback.lastIndexOf('up -d --no-build --force-recreate --no-deps delivery-api'), 'rollback script must stop disabled OSRM only after delivery-api has restarted with the disabled env');
assert(imageRollback.includes('"routeEngineEnabled":%s'), 'rollback history must record route_engine enablement state');
assert(imageRollback.includes('"osrmEnabled":%s'), 'rollback history must record OSRM enablement state');
assert(smoke.includes('/admin/ui/app/api/drivers?shopDomain=${encodeURIComponent(shopDomain)}'), 'production smoke must include shopDomain when checking Drivers API');
assertExplicitRouteOpsCompose(imageDeployPath, imageDeploy);
assertExplicitRouteOpsCompose(imageRollbackPath, imageRollback);
assert(wrapper.includes('export ROUTE_OPS_COMPOSE_PROJECT_NAME'), 'wrapper must export explicit compose project for child deploy script');
assertExplicitRouteOpsCompose(deployWorkflowPath, deploy);
assert(osrmHelper.includes('docker compose -p ${ROUTE_OPS_COMPOSE_PROJECT_NAME:-clever-route} -f infra/compose/docker-compose.prod.yml --profile osrm up -d osrm-ontario'), 'OSRM helper must suggest explicit Route Ops compose project for start command');
assert(osrmDoc.includes('docker compose -p "$ROUTE_OPS_COMPOSE_PROJECT_NAME" -f infra/compose/docker-compose.prod.yml --profile osrm up -d osrm-ontario'), 'OSRM docs must start OSRM with explicit Route Ops compose project');
assert(osrmDoc.includes('Normal image deploy/rollback is now the durable activation path'), 'OSRM docs must document deploy/rollback as the durable OSRM activation path');
assert(osrmDoc.includes('Do not leave OSRM as a manually attached sidecar/container'), 'OSRM docs must reject manual OSRM sidecar/network attach as steady state');
assert(osrmDoc.includes('smoke `http://osrm-ontario:5000` from a one-off `delivery-api` runtime container'), 'OSRM docs must require delivery-api-network OSRM smoke');
assert(osrmDoc.includes('deploy history records `osrmEnabled`'), 'OSRM docs must document deploy-history OSRM state recording');
assert(osrmDoc.includes('automatically stops `osrm-ontario` after the app restarts'), 'OSRM docs must document automatic OSRM stop when disabled');
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

assert(githubDoc.includes('route-ops-web-static'), 'GitHub deploy docs must include frontend static artifact identity');
assert(githubDoc.includes('ROUTE_OPS_WEB_STATIC_IMAGE'), 'GitHub deploy docs must include frontend static deploy env');
assert(githubDoc.includes('ROUTE_OPS_WEB_STATIC_VOLUME'), 'GitHub deploy docs must include frontend static volume deploy env');
assert(githubDoc.includes('ROUTE_ENGINE_IMAGE'), 'GitHub deploy docs must include the route_engine worker image env');
assert(githubDoc.includes('ROUTE_ENGINE_GRAPH_HOST_DIR'), 'GitHub deploy docs must include the route_engine graph host mount env');
assert(githubDoc.includes('http://route-engine:8080'), 'GitHub deploy docs must document the internal route_engine base URL');

for (const pattern of [
  'DeployControlBundleS3Uri.*allowedPattern',
  'DeployControlBundleSha256.*allowedPattern',
  'deploy-control-manifest\\.json',
  'dryRun',
  's3:PutObject',
  's3:GetObject',
  'route-ops-artifacts-902837199612-ap-northeast-2',
  'route-ops-web-static',
  'clever-route-server-route-ops-web-static:<sha>',
  'ROUTE_OPS_WEB_STATIC_IMAGE',
  'ROUTE_OPS_WEB_STATIC_VOLUME',
  'ROUTE_ENGINE_IMAGE',
  'routeEnginePublishEvidenceUrl',
  'ROUTE_ENGINE_GRAPH_HOST_DIR',
  'org.clever-route.graph-manifest-sha',
  '/app/routing_engine/v7_out/parquet:ro',
  'route-engine:8080',
  'non-customer.*POST /v1/solve',
  'SHA-scoped',
  'DocumentVersion',
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

console.log(JSON.stringify({ ok: true, checked: [deployWorkflowPath, wrapperPath, deployControlBundlePath, imageDeployPath, imageRollbackPath, composePath, deliveryApiDockerfilePath, prismaDbPushGuardPath, deliveryApiDepsPath, deliveryApiEnvExamplePath, deliveryApiLocalEnvExamplePath, proofMediaDocPath, ssmDocumentPath, osrmHelperPath, docPath, githubDocPath, osrmDocPath, publishWorkflowPath, releaseWorkflowPath, ciWorkflowPath, releaseManifestPath, releaseManifestTestPath] }, null, 2));
