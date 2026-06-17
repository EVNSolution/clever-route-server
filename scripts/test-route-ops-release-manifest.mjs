#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  PUBLISH_EVIDENCE_CONTRACT,
  canonicalJson,
  releaseManifestDigest,
  validateReleasePrepareManifest,
  withReleaseManifestDigest,
} from './route-ops-release-manifest.mjs';

const sha = '0123456789abcdef0123456789abcdef01234567';
const sha2 = 'abcdef0123456789abcdef0123456789abcdef01';
const hex64 = 'a'.repeat(64);

function validManifest(overrides = {}) {
  return withReleaseManifestDigest({
    schemaVersion: 1,
    mode: 'prepare',
    workflowName: 'Route Ops release',
    workflowPath: '.github/workflows/route-ops-release.yml',
    releaseRunId: '123456789',
    releaseRunAttempt: '1',
    artifactName: 'route-ops-release-manifest',
    repository: 'EVNSolution/clever-route-server',
    ref: 'refs/heads/main',
    headSha: sha,
    actor: 'jiin',
    createdAt: '2026-06-15T00:00:00Z',
    deployedBaseRef: sha2,
    allowComposeImageVariableBootstrap: false,
    allowGeocodeOsrmLane: false,
    allowCommerceSyncLane: false,
    imageTag: sha,
    commitSha: sha,
    prismaSchemaSha: hex64,
    routeOpsWebStaticSha: 'b'.repeat(64),
    deliveryApiImage: `ghcr.io/evnsolution/clever-route-server-delivery-api:${sha}`,
    deliveryApiMigrateImage: `ghcr.io/evnsolution/clever-route-server-delivery-api-migrate:${sha}`,
    routeOpsWebStaticImage: `ghcr.io/evnsolution/clever-route-server-route-ops-web-static:${sha}`,
    prepareRunUrl: 'https://github.com/EVNSolution/clever-route-server/actions/runs/123456789',
    publishEvidenceUrl: 'https://github.com/EVNSolution/clever-route-server/actions/runs/123456789',
    publishEvidenceContract: PUBLISH_EVIDENCE_CONTRACT,
    dryRunDeployControlBundleS3Uri: `s3://route-ops-artifacts-902837199612-ap-northeast-2/artifacts/route-ops/prod/deploy-control/123/${sha}/route-ops-deploy-control.tar.gz`,
    dryRunDeployControlBundleSha256: 'c'.repeat(64),
    dryRunSsmCommandId: 'cmd-123',
    dryRunStatus: 'Success',
    dryRunEvidenceSummary: { mutation: 'none', redacted: true },
    driverAppDownloadUrlPresent: true,
    ...overrides,
  });
}

const stamped = validManifest();
assert.equal(validateReleasePrepareManifest(stamped).ok, true);
assert.equal(stamped.manifestSha256, releaseManifestDigest(stamped));
assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}\n');

const missing = { ...stamped };
delete missing.workflowPath;
assert.match(validateReleasePrepareManifest(missing).issues.join('\n'), /workflowPath/);

const wrongDigest = { ...stamped, manifestSha256: '0'.repeat(64) };
assert.match(validateReleasePrepareManifest(wrongDigest).issues.join('\n'), /manifestSha256 mismatch/);

const wrongEvidence = validManifest({ publishEvidenceUrl: 'https://github.com/EVNSolution/clever-route-server/actions/runs/111111111' });
assert.match(validateReleasePrepareManifest(wrongEvidence).issues.join('\n'), /publishEvidenceUrl must equal prepareRunUrl/);

const nonPrepare = validManifest({ mode: 'promote' });
assert.match(validateReleasePrepareManifest(nonPrepare).issues.join('\n'), /mode must be prepare/);


const rawAppUrl = validManifest({ dryRunEvidenceSummary: { leaked: 'https://drive.google.com/file/d/example/view?usp=sharing' } });
assert.match(validateReleasePrepareManifest(rawAppUrl).issues.join('\n'), /secret-like or raw app-download value/);

const apkLeak = validManifest({ dryRunEvidenceSummary: { leaked: 'https://example.com/app-release.apk' } });
assert.match(validateReleasePrepareManifest(apkLeak).issues.join('\n'), /secret-like or raw app-download value/);

const secretKey = validManifest({ dryRunEvidenceSummary: { adminPassword: 'not-ok' } });
assert.match(validateReleasePrepareManifest(secretKey).issues.join('\n'), /secret-like manifest key/);


const outputInjection = validManifest({ deliveryApiImage: `ghcr.io/evnsolution/clever-route-server-delivery-api:${sha}\nextra_output=pwned` });
assert.match(validateReleasePrepareManifest(outputInjection).issues.join('\n'), /control characters|deliveryApiImage/);

const wrongImageRepo = validManifest({ deliveryApiImage: `ghcr.io/evnsolution/not-route-ops:${sha}` });
assert.match(validateReleasePrepareManifest(wrongImageRepo).issues.join('\n'), /deliveryApiImage/);

const wrongImageTag = validManifest({ routeOpsWebStaticImage: `ghcr.io/evnsolution/clever-route-server-route-ops-web-static:${sha2}` });
assert.match(validateReleasePrepareManifest(wrongImageTag).issues.join('\n'), /routeOpsWebStaticImage tag must match imageTag/);

const unknownField = validManifest({ unexpected: 'nope' });
assert.match(validateReleasePrepareManifest(unknownField).issues.join('\n'), /unknown field: unexpected/);


console.log(JSON.stringify({ ok: true, tests: 12 }));
