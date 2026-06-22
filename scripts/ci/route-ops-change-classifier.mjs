#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import process from 'node:process';

if (isCliEntryPoint()) {
  const args = new Set(process.argv.slice(2));
  const githubOutputPath = getArgValue('--github-output');
  const forceFullVerify = args.has('--full-verify') || process.env.FULL_VERIFY === 'true';
  const input = readStdin();
  const files = normalizeFiles(input);
  const result = classifyRouteOpsChanges(files, { forceFullVerify });

  if (githubOutputPath) {
    appendOutputs(githubOutputPath, result);
  } else if (args.has('--json')) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    for (const [key, value] of Object.entries(result)) {
      process.stdout.write(`${key}=${formatOutputValue(value)}\n`);
    }
  }
}

function isCliEntryPoint() {
  return import.meta.url === `file://${process.argv[1]}`;
}

function getArgValue(name) {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(name);
  if (index === -1) return '';
  return argv[index + 1] ?? '';
}

function readStdin() {
  return readFileSync(0, 'utf8');
}

function normalizeFiles(input) {
  return input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function any(files, patterns) {
  return files.some((file) => patterns.some((pattern) => pattern.test(file)));
}

function all(files, patterns) {
  return files.length > 0 && files.every((file) => patterns.some((pattern) => pattern.test(file)));
}

export function classifyRouteOpsChanges(files, options = {}) {
  const force = options.forceFullVerify === true;

  const webChanged = any(files, [
    /^apps\/route-ops-web\//,
  ]);

  const workflowChanged = any(files, [
    /^\.github\/workflows\/(ci|route-ops-simple-deploy)\.yml$/,
  ]);

  const deployChanged = any(files, [
    /^infra\/compose\/docker-compose\.prod\.yml$/,
    /^infra\/vroom\/config\.yml$/,
    /^infra\/env\/delivery-api\.env\.example$/,
    /^scripts\/(guard-route-ops-deploy-scope|check-ignore-hygiene|scan-secrets|smoke-route-ops-production|ssm-simple-route-ops-deploy|osrm-ontario|monitor-route-ops-production)\.(mjs|sh)$/,
    /^tests\/deploy\/(ssm-simple-route-ops-deploy|route-ops-prisma-db-push-guard|monitor-route-ops-production)\.test\.sh$/,
    /^docs\/deployment\/(route-ops-simple-ssm-deploy|route-ops-osrm-ontario|route-ops-vroom)\.md$/,
  ]);

  const apiChanged = any(files, [
    /^apps\/delivery-api\//,
  ]);

  const routeGeometryOnlyApiChanged = apiChanged && all(files, [
    /^apps\/delivery-api\/src\/modules\/route-plans\/(osrm-route-geometry\.client|route-plan-geometry-cache)\.ts$/,
    /^apps\/delivery-api\/src\/scripts\/refresh-route-geometry-cache\.ts$/,
    /^apps\/delivery-api\/tests\/(osrm-route-geometry\.client|route-plan-geometry-cache|refresh-route-geometry-cache\.script|route-plan\.service|route-plan\.repository)\.test\.ts$/,
  ]);

  const routeOpsUiApiChanged = any(files, [
    /^apps\/delivery-api\/src\/routes\/(admin-commerce-connections-ui\.routes|admin-ui-[^/]+)\.ts$/,
    /^apps\/delivery-api\/tests\/(admin-commerce-connections-ui\.routes|admin-ui-[^/]+|admin-route-plans\.routes)\.test\.ts$/,
  ]);

  const docsOnly = all(files, [
    /^docs\//,
    /^README\.md$/,
    /^\.omx\//,
  ]);

  const routeOpsChanged = any(files, [
    /^AGENTS\.md$/,
    /^apps\/route-ops-web\//,
    /^apps\/delivery-api\//,
    /^infra\/compose\/docker-compose\.prod\.yml$/,
    /^infra\/vroom\/config\.yml$/,
    /^infra\/env\/delivery-api\.env\.example$/,
    /^scripts\/ci\/route-ops-change-classifier\.mjs$/,
    /^scripts\/(guard-route-ops-deploy-scope|check-ignore-hygiene|scan-secrets|smoke-route-ops-production|ssm-simple-route-ops-deploy|osrm-ontario|monitor-route-ops-production)\.(mjs|sh)$/,
    /^tests\/(deploy|ci)\//,
    /^docs\/(architecture|migration|deployment|development)\//,
    /^\.github\/workflows\/(ci|route-ops-simple-deploy)\.yml$/,
    /^\.gitignore$/,
    /^\.dockerignore$/,
    /^\.gitleaks\.toml$/,
    /^package(-lock)?\.json$/,
  ]);

  const webArtifactRequired = force || routeOpsUiApiChanged || (apiChanged && !routeGeometryOnlyApiChanged);

  const criticalChanged = any(files, [
    /^package(-lock)?\.json$/,
    /^apps\/delivery-api\/package(-lock)?\.json$/,
    /^apps\/delivery-api\/Dockerfile$/,
    /^apps\/delivery-api\/prisma\//,
    /^apps\/delivery-api\/src\/routes\/(admin-session-auth|admin-ui-session|admin-ui-session-security|shopify-auth|driver-auth)\.ts$/,
    /^apps\/delivery-api\/src\/routes\/(admin-commerce-connections-ui|admin-route-plans|driver-auth|driver-events|shopify-auth)\.routes\.ts$/,
    /^apps\/delivery-api\/src\/routes\/admin-ui-[^/]+\.ts$/,
    /^apps\/delivery-api\/src\/modules\/(commerce|driver|route-plans|route-ops|geocoding)\//,
    /^apps\/delivery-api\/src\/modules\/shopify\/(auth\.dependencies|session-token-verifier)\.ts$/,
    /^apps\/delivery-api\/src\/modules\/wordpress-plugin\/wordpress-plugin-auth\.service\.ts$/,
    /^apps\/delivery-api\/src\/scripts\/(.*proof-media.*|refresh-route-geometry-cache)\.ts$/,
    /^apps\/delivery-api\/tests\/(admin-commerce-auth|admin-session-auth|admin-commerce-connections-ui\.routes|admin-route-plans\.routes|driver-auth\.(repository|routes)|driver\.dependencies|driver-route-access\.routes|driver-proof-media.*|driver-route-session\.(repository|routes)|geocoding\.service|osrm-route-geometry\.client|vroom-route-optimizer\.client|route-plan\.(repository|service)|route-scope-config|prisma-schema|shopify-auth\.(dependencies|routes)|shopify-session-token-verifier|wordpress-plugin-auth\.service)\.test\.ts$/,
    /^scripts\/ci\/route-ops-change-classifier\.mjs$/,
    /^tests\/ci\/route-ops-change-classifier\.test\.mjs$/,
    /^infra\/compose\/docker-compose\.prod\.yml$/,
    /^infra\/vroom\/config\.yml$/,
    /^scripts\/(ssm-simple-route-ops-deploy|osrm-ontario|monitor-route-ops-production)\.sh$/,
    /^tests\/deploy\//,
    /^\.github\/workflows\/(ci|route-ops-simple-deploy)\.yml$/,
  ]);

  const classifierChanged = any(files, [
    /^scripts\/ci\/route-ops-change-classifier\.mjs$/,
    /^tests\/ci\/route-ops-change-classifier\.test\.mjs$/,
  ]);

  const api_test_profile = routeGeometryOnlyApiChanged ? 'route_geometry' : 'route_ops';

  const fullRequired = force || classifierChanged || any(files, [
    /^package(-lock)?\.json$/,
    /^apps\/delivery-api\/package(-lock)?\.json$/,
    /^apps\/route-ops-web\/package(-lock)?\.json$/,
    /^\.github\/workflows\/(ci|route-ops-simple-deploy)\.yml$/,
  ]);

  return {
    changed_files_count: files.length,
    route_ops_changed: routeOpsChanged,
    web_changed: webChanged,
    api_changed: apiChanged,
    deploy_changed: deployChanged,
    workflow_changed: workflowChanged,
    docs_only: docsOnly,
    critical_changed: criticalChanged,
    full_required: fullRequired,
    web_artifact_required: webArtifactRequired,
    api_test_profile,
  };
}

function appendOutputs(path, result) {
  const lines = Object.entries(result).map(([key, value]) => `${key}=${formatOutputValue(value)}`);
  appendFileSync(path, `${lines.join('\n')}\n`, 'utf8');
}

function formatOutputValue(value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}
