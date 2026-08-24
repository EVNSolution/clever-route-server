#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { classifyRouteOpsChanges } from '../../scripts/ci/route-ops-change-classifier.mjs';

function check(name, files, expected) {
  const actual = classifyRouteOpsChanges(files);
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(actual[key], value, `${name}: expected ${key}=${value}, got ${actual[key]}`);
  }
}

function deliveryApiJobRunsOnMainPush(files) {
  const result = classifyRouteOpsChanges(files);
  return (result.api_changed && result.critical_changed) || result.full_required;
}

function releaseStaticChecksRun(files) {
  const result = classifyRouteOpsChanges(files);
  return result.deploy_changed || result.workflow_changed || result.full_required;
}

check('web-only UI change', ['apps/route-ops-web/src/pages/RoutesPage.tsx', 'apps/route-ops-web/src/styles.css'], {
  web_changed: true,
  api_changed: false,
  critical_changed: false,
  full_required: false,
  web_artifact_required: false,
});

check('delivery route-plan API change keeps web artifact for broad API tests', ['apps/delivery-api/src/modules/route-plans/route-plan.repository.ts'], {
  web_changed: false,
  api_changed: true,
  critical_changed: true,
  full_required: false,
  web_artifact_required: true,
  api_test_profile: 'route_ops',
});

check('route grouping allocation changes are critical API changes', [
  'apps/delivery-api/src/modules/route-grouping/route-grouping.service.ts',
  'apps/delivery-api/tests/route-grouping.service.test.ts',
], {
  api_changed: true,
  critical_changed: true,
  full_required: false,
  web_artifact_required: true,
  api_test_profile: 'route_ops',
});

check('prisma migration change keeps web artifact for broad API tests', ['apps/delivery-api/prisma/schema.prisma', 'apps/delivery-api/prisma/migrations/20260622000000_x/migration.sql'], {
  api_changed: true,
  critical_changed: true,
  full_required: false,
  web_artifact_required: true,
  api_test_profile: 'route_ops',
});

check('deploy workflow change', ['scripts/ssm-simple-route-ops-deploy.sh', '.github/workflows/route-ops-simple-deploy.yml'], {
  deploy_changed: true,
  workflow_changed: true,
  critical_changed: true,
  full_required: true,
});

check('edge caddy workflow change', ['scripts/ssm-edge-caddy-deploy.sh', '.github/workflows/edge-caddy-deploy.yml'], {
  deploy_changed: true,
  workflow_changed: true,
  critical_changed: true,
  full_required: true,
});

check('backup workflow change', ['scripts/backup-route-ops-data.sh', 'scripts/ssm-install-route-ops-backup.sh', '.github/workflows/route-ops-backup.yml'], {
  deploy_changed: true,
  workflow_changed: true,
  critical_changed: true,
  full_required: true,
});

check('docs-only change', ['README.md', 'docs/deployment/route-ops-ci-deploy-validation.md'], {
  docs_only: true,
  web_changed: false,
  api_changed: false,
});

check('shared lockfile change', ['package-lock.json'], {
  critical_changed: true,
  full_required: true,
});

check('route optimizer integration change keeps web artifact for broad API tests', ['apps/delivery-api/src/modules/route-plans/vroom-route-optimizer.client.ts'], {
  api_changed: true,
  critical_changed: true,
  web_artifact_required: true,
  api_test_profile: 'route_ops',
});

check('admin UI API test needs web artifact', ['apps/delivery-api/tests/admin-route-plans.routes.test.ts'], {
  api_changed: true,
  web_changed: false,
  web_artifact_required: true,
  api_test_profile: 'route_ops',
});

check('deploy script only stays deploy-critical without API artifact', ['scripts/ssm-simple-route-ops-deploy.sh'], {
  api_changed: false,
  deploy_changed: true,
  critical_changed: true,
  full_required: false,
  web_artifact_required: false,
});

for (const migrationDeployPath of [
  'apps/delivery-api/scripts/dsv-g007-migrate-deploy.sh',
  'tests/deploy/route-ops-prisma-migrate-deploy.test.sh',
]) {
  check(`migration deploy contract triggers release checks: ${migrationDeployPath}`, [migrationDeployPath], {
    deploy_changed: true,
  });
  assert.equal(
    releaseStaticChecksRun([migrationDeployPath]),
    true,
    `Route Ops release static checks must run when ${migrationDeployPath} changes`,
  );
}

check('edge caddy file stays deploy-critical without API artifact', ['infra/caddy/Caddyfile'], {
  api_changed: false,
  deploy_changed: true,
  critical_changed: true,
  full_required: false,
  web_artifact_required: false,
});

check('multi-coverage deploy config is deploy-critical', [
  'infra/vroom/config.korea.yml',
  'docs/deployment/route-ops-multi-coverage-routing.md',
], {
  api_changed: false,
  deploy_changed: true,
  critical_changed: true,
  full_required: false,
});

check('route geometry refresh script uses light API profile without web artifact', ['apps/delivery-api/src/scripts/refresh-route-geometry-cache.ts'], {
  api_changed: true,
  critical_changed: true,
  full_required: false,
  web_artifact_required: false,
  api_test_profile: 'route_geometry',
});

check('route geometry client and cache tests use light API profile', [
  'apps/delivery-api/src/modules/route-plans/osrm-route-geometry.client.ts',
  'apps/delivery-api/src/modules/route-plans/route-plan-geometry-cache.ts',
  'apps/delivery-api/tests/osrm-route-geometry.client.test.ts',
  'apps/delivery-api/tests/route-plan-geometry-cache.test.ts',
], {
  api_changed: true,
  critical_changed: true,
  full_required: false,
  web_artifact_required: false,
  api_test_profile: 'route_geometry',
});

check('route geometry plus UI route falls back to normal API profile with web artifact', [
  'apps/delivery-api/src/scripts/refresh-route-geometry-cache.ts',
  'apps/delivery-api/src/routes/admin-commerce-connections-ui.routes.ts',
], {
  api_changed: true,
  critical_changed: true,
  web_artifact_required: true,
  api_test_profile: 'route_ops',
});

check('admin notification postgres stream changes are critical API changes', [
  'apps/delivery-api/src/modules/notifications/admin-notification.postgres-stream.ts',
  'apps/delivery-api/tests/admin-notification.postgres-stream.test.ts',
], {
  api_changed: true,
  critical_changed: true,
  web_artifact_required: true,
  api_test_profile: 'route_ops',
});

check('order sync notification producer changes are critical API changes', [
  'apps/delivery-api/src/modules/shopify/order-sync.repository.ts',
  'apps/delivery-api/tests/order-sync.repository.test.ts',
], {
  api_changed: true,
  critical_changed: true,
  web_artifact_required: true,
  api_test_profile: 'route_ops',
});

check('ci validation doc stays docs-only light', ['docs/deployment/route-ops-ci-deploy-validation.md'], {
  docs_only: true,
  deploy_changed: false,
  web_changed: false,
  api_changed: false,
});

check('classifier policy edits are critical and full verify', ['scripts/ci/route-ops-change-classifier.mjs', 'tests/ci/route-ops-change-classifier.test.mjs'], {
  route_ops_changed: true,
  critical_changed: true,
  full_required: true,
});

check('admin session auth is critical with broad API web artifact', ['apps/delivery-api/src/routes/admin-session-auth.ts', 'apps/delivery-api/tests/admin-session-auth.test.ts'], {
  api_changed: true,
  critical_changed: true,
  web_artifact_required: true,
  api_test_profile: 'route_ops',
});

check('driver proof media scripts are critical with broad API web artifact', ['apps/delivery-api/src/scripts/cleanup-driver-proof-media.ts', 'apps/delivery-api/tests/driver-proof-media.routes.test.ts'], {
  api_changed: true,
  critical_changed: true,
  web_artifact_required: true,
  api_test_profile: 'route_ops',
});

for (const contractPath of [
  'apps/delivery-api/src/modules/driver/driver-proof-media.repository.ts',
  'apps/delivery-api/tests/driver-proof-media-read-inventory.test.ts',
  'apps/delivery-api/src/modules/dsv/dsv-v1-read-query.service.ts',
  'apps/delivery-api/tests/dsv-v1-read-query.service.test.ts',
]) {
  check(`proof READY contract path is critical: ${contractPath}`, [contractPath], {
    api_changed: true,
    critical_changed: true,
    full_required: false,
    web_artifact_required: true,
    api_test_profile: 'route_ops',
  });
  assert.equal(
    deliveryApiJobRunsOnMainPush([contractPath]),
    true,
    `Delivery API CI job must run when ${contractPath} changes`,
  );
}

for (const contractPath of [
  'apps/delivery-api/package.json',
  'apps/delivery-api/Dockerfile',
  'apps/delivery-api/tsconfig.build.json',
  'apps/delivery-api/src/scripts/cleanup-driver-event-attempts.ts',
  'apps/delivery-api/src/scripts/cleanup-shopify-webhook-events.ts',
  'apps/delivery-api/src/scripts/cleanup-driver-proof-media.ts',
  'apps/delivery-api/tests/package-scripts.test.ts',
  'apps/delivery-api/tests/driver-event-attempt-retention-script.test.ts',
  'apps/delivery-api/tests/driver-event-attempt-retention.test.ts',
  'apps/delivery-api/tests/route-operational-evidence-retention.test.ts',
  'apps/delivery-api/tests/shopify-webhook-retention.test.ts',
  'apps/delivery-api/tests/driver-proof-media.cleanup.test.ts',
  'apps/delivery-api/tests/deploy/driver-event-attempt-retention-schedule.test.sh',
  'scripts/run-driver-event-attempt-retention.sh',
  'scripts/install-driver-event-attempt-retention.sh',
  'infra/systemd/clever-driver-event-attempt-retention.service',
  'infra/systemd/clever-driver-event-attempt-retention.timer',
  'tests/deploy/route-ops-retention-runtime.test.sh',
]) {
  check(`retention runtime contract triggers image and release checks: ${contractPath}`, [contractPath], {
    deploy_changed: true,
    critical_changed: true,
  });
  assert.equal(
    releaseStaticChecksRun([contractPath]),
    true,
    `Route Ops release static checks must run when ${contractPath} changes`,
  );
  if (contractPath.startsWith('apps/delivery-api/')) {
    assert.equal(
      deliveryApiJobRunsOnMainPush([contractPath]),
      true,
      `Delivery API build and tests must run when ${contractPath} changes`,
    );
  }
}

const ciWorkflow = readFileSync('.github/workflows/ci.yml', 'utf8');
const retentionStep = ciWorkflow.match(
  /- name: Retention runtime tests\n(?<body>[\s\S]*?)(?=\n\s+- name: Build delivery API)/u,
);
assert.ok(retentionStep?.groups?.body, 'CI must define a dedicated retention runtime test step');
const retentionStepTokens = retentionStep.groups.body.trim().split(/\s+/u);
for (const testPath of [
  'tests/driver-event-attempt-retention.test.ts',
  'tests/route-operational-evidence-retention.test.ts',
  'tests/shopify-webhook-retention.test.ts',
  'tests/driver-proof-media.cleanup.test.ts',
  'tests/package-scripts.test.ts',
  'tests/driver-event-attempt-retention-script.test.ts',
]) {
  assert.ok(
    retentionStepTokens.includes(testPath),
    `Retention runtime CI step must run ${testPath}`,
  );
}

check('shopify auth/session verifier is critical', ['apps/delivery-api/src/modules/shopify/session-token-verifier.ts', 'apps/delivery-api/tests/shopify-session-token-verifier.test.ts'], {
  api_changed: true,
  critical_changed: true,
});

const forced = classifyRouteOpsChanges(['docs/note.md'], { forceFullVerify: true });
assert.equal(forced.full_required, true, 'force full verify sets full_required');
assert.equal(forced.web_artifact_required, true, 'force full verify preserves web artifact build');


const cli = spawnSync(process.execPath, ['scripts/ci/route-ops-change-classifier.mjs', '--json'], {
  input: 'scripts/ci/route-ops-change-classifier.mjs\n',
  encoding: 'utf8',
});
assert.equal(cli.status, 0, `classifier CLI failed: ${cli.stderr}`);
assert.equal(JSON.parse(cli.stdout).full_required, true, 'classifier CLI emits JSON outputs');

console.log('route-ops-change-classifier tests passed');
