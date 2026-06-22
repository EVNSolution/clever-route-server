#!/usr/bin/env node
import assert from 'node:assert/strict';
import { classifyRouteOpsChanges } from '../../scripts/ci/route-ops-change-classifier.mjs';

function check(name, files, expected) {
  const actual = classifyRouteOpsChanges(files);
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(actual[key], value, `${name}: expected ${key}=${value}, got ${actual[key]}`);
  }
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

check('shopify auth/session verifier is critical', ['apps/delivery-api/src/modules/shopify/session-token-verifier.ts', 'apps/delivery-api/tests/shopify-session-token-verifier.test.ts'], {
  api_changed: true,
  critical_changed: true,
});

const forced = classifyRouteOpsChanges(['docs/note.md'], { forceFullVerify: true });
assert.equal(forced.full_required, true, 'force full verify sets full_required');
assert.equal(forced.web_artifact_required, true, 'force full verify preserves web artifact build');

console.log('route-ops-change-classifier tests passed');
