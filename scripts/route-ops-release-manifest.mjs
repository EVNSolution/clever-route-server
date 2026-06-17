#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ROUTE_OPS_RELEASE_WORKFLOW_PATH = '.github/workflows/route-ops-release.yml';
export const ROUTE_OPS_RELEASE_SCHEMA_VERSION = 1;
export const PUBLISH_EVIDENCE_CONTRACT = 'self-prepare-run-builds-route-ops-images';

const HEX40 = /^[0-9a-f]{40}$/i;
const HEX64 = /^[0-9a-f]{64}$/i;
const GITHUB_RUN_URL = /^https:\/\/github\.com\/EVNSolution\/clever-route-server\/actions\/runs\/\d+\/?$/;
const RUNTIME_IMAGE_REPO = 'ghcr.io/evnsolution/clever-route-server-delivery-api';
const MIGRATE_IMAGE_REPO = 'ghcr.io/evnsolution/clever-route-server-delivery-api-migrate';
const FRONTEND_STATIC_IMAGE_REPO = 'ghcr.io/evnsolution/clever-route-server-route-ops-web-static';
const DEPLOY_CONTROL_BUNDLE_S3_URI = /^s3:\/\/route-ops-artifacts-902837199612-ap-northeast-2\/artifacts\/route-ops\/prod\/deploy-control\/\d+\/[0-9a-f]{40}\/route-ops-deploy-control\.tar\.gz$/i;
const CONTROL_CHARS = /[\x00-\x1F\x7F]/;

const REQUIRED_PREPARE_FIELDS = [
  'schemaVersion',
  'mode',
  'workflowName',
  'workflowPath',
  'releaseRunId',
  'releaseRunAttempt',
  'artifactName',
  'repository',
  'ref',
  'headSha',
  'actor',
  'createdAt',
  'deployedBaseRef',
  'allowComposeImageVariableBootstrap',
  'allowGeocodeOsrmLane',
  'allowCommerceSyncLane',
  'imageTag',
  'commitSha',
  'prismaSchemaSha',
  'routeOpsWebStaticSha',
  'deliveryApiImage',
  'deliveryApiMigrateImage',
  'routeOpsWebStaticImage',
  'prepareRunUrl',
  'publishEvidenceUrl',
  'publishEvidenceContract',
  'dryRunDeployControlBundleS3Uri',
  'dryRunDeployControlBundleSha256',
  'dryRunSsmCommandId',
  'dryRunStatus',
  'dryRunEvidenceSummary',
  'driverAppDownloadUrlPresent',
  'manifestSha256',
];

const SECRET_KEY_PATTERN = /(secret|password|passwd|token|credential|private[-_]?key|access[-_]?key|driverAppDownloadUrl|downloadUrl)/i;
const SECRET_VALUE_PATTERNS = [
  /-----BEGIN [A-Z ]+PRIVATE KEY-----/,
  /\b(AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /drive\.google\.com/i,
  /googleusercontent\.com/i,
  /\.apk(?:\?|$)/i,
  /DRIVER_APP_DOWNLOAD_URL/,
];
const ALLOWED_URL_KEYS = new Set([
  'prepareRunUrl',
  'publishEvidenceUrl',
  'dryRunDeployControlBundleS3Uri',
]);
const ALLOWED_SECRETISH_KEYS = new Set([
  'driverAppDownloadUrlPresent',
]);
const ALLOWED_PREPARE_FIELDS = new Set(REQUIRED_PREPARE_FIELDS);

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => value[key] !== undefined)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return `${JSON.stringify(canonicalize(value))}\n`;
}

export function releaseManifestDigest(manifest) {
  const { manifestSha256: _manifestSha256, ...withoutSelfHash } = manifest;
  return crypto.createHash('sha256').update(canonicalJson(withoutSelfHash)).digest('hex');
}

export function withReleaseManifestDigest(manifest) {
  const next = { ...manifest };
  next.manifestSha256 = releaseManifestDigest(next);
  return next;
}


function assertExactImage(issues, manifest, field, repo) {
  const value = manifest[field];
  const match = typeof value === 'string' ? value.match(new RegExp(`^${repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:([0-9a-f]{40})$`, 'i')) : null;
  if (!match) {
    issues.push(`${field} must be ${repo}:<imageTag>`);
    return;
  }
  if (typeof manifest.imageTag === 'string' && match[1].toLowerCase() !== manifest.imageTag.toLowerCase()) {
    issues.push(`${field} tag must match imageTag`);
  }
}

function collectManifestIssues(manifest) {
  const issues = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return ['release manifest must be a JSON object'];
  }
  for (const field of REQUIRED_PREPARE_FIELDS) {
    if (!(field in manifest)) issues.push(`release manifest missing required field: ${field}`);
  }
  for (const field of Object.keys(manifest)) {
    if (!ALLOWED_PREPARE_FIELDS.has(field)) issues.push(`release manifest contains unknown field: ${field}`);
  }

  if (manifest.schemaVersion !== ROUTE_OPS_RELEASE_SCHEMA_VERSION) issues.push(`schemaVersion must be ${ROUTE_OPS_RELEASE_SCHEMA_VERSION}`);
  if (manifest.mode !== 'prepare') issues.push('mode must be prepare');
  if (manifest.workflowPath !== ROUTE_OPS_RELEASE_WORKFLOW_PATH) issues.push(`workflowPath must be ${ROUTE_OPS_RELEASE_WORKFLOW_PATH}`);
  if (manifest.repository !== 'EVNSolution/clever-route-server') issues.push('repository must be EVNSolution/clever-route-server');
  if (manifest.ref !== 'refs/heads/main' && manifest.ref !== 'main') issues.push('ref must identify main');
  if (!HEX40.test(manifest.headSha ?? '')) issues.push('headSha must be a 40-hex commit SHA');
  if (!HEX40.test(manifest.imageTag ?? '')) issues.push('imageTag must be a 40-hex commit SHA');
  if (!HEX40.test(manifest.commitSha ?? '')) issues.push('commitSha must be a 40-hex commit SHA');
  if (manifest.headSha !== manifest.imageTag || manifest.headSha !== manifest.commitSha) issues.push('headSha, imageTag, and commitSha must be identical');
  if (!HEX64.test(manifest.prismaSchemaSha ?? '')) issues.push('prismaSchemaSha must be a SHA256 hex digest');
  if (!HEX64.test(manifest.routeOpsWebStaticSha ?? '')) issues.push('routeOpsWebStaticSha must be a SHA256 hex digest');
  if (!HEX64.test(manifest.dryRunDeployControlBundleSha256 ?? '')) issues.push('dryRunDeployControlBundleSha256 must be a SHA256 hex digest');
  assertExactImage(issues, manifest, 'deliveryApiImage', RUNTIME_IMAGE_REPO);
  assertExactImage(issues, manifest, 'deliveryApiMigrateImage', MIGRATE_IMAGE_REPO);
  assertExactImage(issues, manifest, 'routeOpsWebStaticImage', FRONTEND_STATIC_IMAGE_REPO);
  if (!DEPLOY_CONTROL_BUNDLE_S3_URI.test(manifest.dryRunDeployControlBundleS3Uri ?? '')) issues.push('dryRunDeployControlBundleS3Uri must identify the approved Route Ops deploy-control bundle path');
  if (manifest.dryRunStatus !== 'Success') issues.push('dryRunStatus must be Success');
  if (!manifest.dryRunEvidenceSummary || typeof manifest.dryRunEvidenceSummary !== 'object' || Array.isArray(manifest.dryRunEvidenceSummary) || manifest.dryRunEvidenceSummary.mutation !== 'none' || manifest.dryRunEvidenceSummary.redacted !== true || Object.keys(manifest.dryRunEvidenceSummary).length !== 2) issues.push('dryRunEvidenceSummary must be exactly { mutation: none, redacted: true }');
  if (manifest.prepareRunUrl !== manifest.publishEvidenceUrl) issues.push('publishEvidenceUrl must equal prepareRunUrl for self-prepare release evidence');
  if (!GITHUB_RUN_URL.test(manifest.prepareRunUrl ?? '')) issues.push('prepareRunUrl must be a clever-route-server Actions run URL');
  if (!GITHUB_RUN_URL.test(manifest.publishEvidenceUrl ?? '')) issues.push('publishEvidenceUrl must be a clever-route-server Actions run URL');
  if (manifest.publishEvidenceContract !== PUBLISH_EVIDENCE_CONTRACT) issues.push(`publishEvidenceContract must be ${PUBLISH_EVIDENCE_CONTRACT}`);
  if (manifest.driverAppDownloadUrlPresent !== true && manifest.driverAppDownloadUrlPresent !== false) issues.push('driverAppDownloadUrlPresent must be a boolean');
  if (!HEX64.test(manifest.manifestSha256 ?? '')) issues.push('manifestSha256 must be a SHA256 hex digest');
  const expectedDigest = releaseManifestDigest(manifest);
  if (manifest.manifestSha256 && manifest.manifestSha256 !== expectedDigest) issues.push(`manifestSha256 mismatch: expected ${expectedDigest}`);

  return issues;
}

function collectSecretIssues(value, path = []) {
  const issues = [];
  if (Array.isArray(value)) {
    value.forEach((entry, index) => issues.push(...collectSecretIssues(entry, [...path, String(index)])));
    return issues;
  }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      const nextPath = [...path, key];
      if (SECRET_KEY_PATTERN.test(key) && !ALLOWED_SECRETISH_KEYS.has(key) && !ALLOWED_URL_KEYS.has(key)) {
        issues.push(`secret-like manifest key is not allowed: ${nextPath.join('.')}`);
      }
      issues.push(...collectSecretIssues(entry, nextPath));
    }
    return issues;
  }
  if (typeof value === 'string') {
    const key = path[path.length - 1] ?? '';
    if (CONTROL_CHARS.test(value)) issues.push(`control characters are not allowed at ${path.join('.') || '<root>'}`);
    for (const pattern of SECRET_VALUE_PATTERNS) {
      if (pattern.test(value)) issues.push(`secret-like or raw app-download value at ${path.join('.') || '<root>'}`);
    }
    if (/^https?:\/\//.test(value) && !ALLOWED_URL_KEYS.has(key)) {
      issues.push(`raw URL value is not allowed at ${path.join('.')}`);
    }
  }
  return issues;
}

export function validateReleasePrepareManifest(manifest) {
  const issues = [...collectManifestIssues(manifest), ...collectSecretIssues(manifest)];
  return { ok: issues.length === 0, issues };
}

export function assertReleasePrepareManifest(manifest) {
  const result = validateReleasePrepareManifest(manifest);
  if (!result.ok) throw new Error(result.issues.join('\n'));
  return manifest;
}

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  fs.writeFileSync(path, canonicalJson(value));
}

function printUsageAndExit() {
  console.error('Usage: route-ops-release-manifest.mjs <digest|stamp|validate> <manifest.json> [--expect-sha <sha>] [--output <path>]');
  process.exit(2);
}

export function main(argv = process.argv.slice(2)) {
  const [command, manifestPath, ...rest] = argv;
  if (!command || !manifestPath) printUsageAndExit();
  let expectSha = '';
  let output = '';
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--expect-sha') expectSha = rest[++i] ?? '';
    else if (rest[i] === '--output') output = rest[++i] ?? '';
    else printUsageAndExit();
  }
  const manifest = readJson(manifestPath);
  if (command === 'digest') {
    console.log(releaseManifestDigest(manifest));
    return;
  }
  if (command === 'stamp') {
    const stamped = withReleaseManifestDigest(manifest);
    if (output) writeJson(output, stamped);
    else process.stdout.write(canonicalJson(stamped));
    return;
  }
  if (command === 'validate') {
    const result = validateReleasePrepareManifest(manifest);
    if (expectSha && manifest.manifestSha256 !== expectSha) result.issues.push(`manifestSha256 does not match expected input ${expectSha}`);
    if (!result.ok || result.issues.length > 0) {
      for (const issue of result.issues) console.error(issue);
      process.exit(1);
    }
    console.log(JSON.stringify({ ok: true, manifestSha256: manifest.manifestSha256 }));
    return;
  }
  printUsageAndExit();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
