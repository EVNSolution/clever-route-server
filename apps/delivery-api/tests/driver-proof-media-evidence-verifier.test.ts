import { describe, expect, test } from 'vitest';

import { verifyDriverProofMediaEvidenceManifest } from '../src/modules/driver/driver-proof-media-evidence-verifier.js';

const completeManifest = `# Driver proof media production evidence manifest

## Source revision

| Field | Value |
| --- | --- |
| Source commit SHA | 7ed2ebb8f0a57157191ead53ef624160d0426139 |
| GitHub PR / merge reference | EVNSolution/clever-route-server#78 |
| Runtime environment | production synthetic validation |
| Evidence owner | release-owner |
| Private evidence storage location | private evidence workspace reference |
| Synthetic proof media only? | yes |
| Production validation approval reference, if any | n/a |

## Storage and signed access evidence

| Gate | Status | Evidence reference | Owner | Notes |
| --- | --- | --- | --- | --- |
| Object storage backend selected as s3 | approved | storage-backend-ref | platform-owner | sanitized config presence only |
| Bucket ownership approved | approved | bucket-ownership-ref | platform-owner | no bucket name in repo |
| IAM least-privilege policy approved | approved | iam-policy-ref | security-owner | no policy JSON in repo |
| Credential custody and rotation owner approved | approved | credential-custody-ref | security-owner | no access keys in repo |
| Signed PUT/DELETE smoke with synthetic media | pass | signed-write-ref | platform-owner | sanitized result only |
| Signed GET read smoke with synthetic media | pass | signed-read-ref | platform-owner | sanitized result only |
| Retention window approved | approved | retention-policy-ref | compliance-owner | matches cleanup schedule |

## Upload safety policy evidence

| Gate | Status | Evidence reference | Owner | Notes |
| --- | --- | --- | --- | --- |
| Scanner backend selection: none | approved | scanner-policy-ref | release-owner | scanner-free decision |
| Scanner-free operation approved | approved | scanner-acceptance-ref | security-owner | no scan results claimed |
| Authenticated driver and assigned-route scope enforced | pass | route-scope-ref | qa-owner | negative cases pass |
| Image MIME allowlist and matching byte signature enforced | pass | image-validation-ref | qa-owner | supported types only |
| Ten MiB file and single-file limits enforced | pass | upload-limit-ref | qa-owner | multipart limits pass |
| JPEG EXIF metadata stripping verified | pass | exif-strip-ref | qa-owner | sanitized hash and size |

## Cleanup scheduler evidence

| Gate | Status | Evidence reference | Owner | Notes |
| --- | --- | --- | --- | --- |
| Scheduler deployment selected | approved | scheduler-deploy-ref | ops-owner | host scheduler evidence |
| Cleanup command run recorded | pass | cleanup-run-ref | ops-owner | sanitized log reference |
| RetentionJobRun row persisted | pass | retention-job-run-ref | ops-owner | no media ids or storage keys |
| Cleanup logs contain no proof bytes, coordinates, customer data, phone numbers, or storage keys | pass | cleanup-log-redaction-ref | security-owner | reviewed privately |

## Private evidence storage and approvals

| Gate | Status | Evidence reference | Owner | Notes |
| --- | --- | --- | --- | --- |
| Private evidence workspace approved | approved | workspace-ref | release-owner | access controlled |
| Public issues/PRs contain sanitized references only | pass | public-redaction-ref | release-owner | no private evidence committed |
| Driver app release blockers cross-referenced | pass | driver-app-cross-ref | release-owner | app smoke/build issues linked |

## Completion decision

| Gate | Status | Notes |
| --- | --- | --- |
| Storage and signed access evidence complete | pass | verified |
| Upload safety policy evidence complete | pass | verified |
| Cleanup scheduler evidence complete | pass | verified |
| Private evidence storage approved | pass | verified |
| Sensitive evidence kept outside git | pass | verified |
| Follow-up blockers linked | pass | verified |

Production proof-media decision: approved

Decision owner: release-owner

Decision timestamp: 2026-05-13T12:00:00Z
`;

describe('driver proof media production evidence verifier', () => {
  test('accepts a completed external production proof-media evidence manifest', () => {
    const result = verifyDriverProofMediaEvidenceManifest(completeManifest);

    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  test('rejects pending gates, blocked decisions, and sensitive production evidence values', () => {
    const incompleteManifest = completeManifest
      .replace('| Bucket ownership approved | approved | bucket-ownership-ref | platform-owner | no bucket name in repo |', '| Bucket ownership approved | pending | pending | pending | pending |')
      .replace('| Image MIME allowlist and matching byte signature enforced | pass | image-validation-ref | qa-owner | supported types only |', '| Image MIME allowlist and matching byte signature enforced | pending | pending | pending | pending |')
      .replace('| Cleanup command run recorded | pass | cleanup-run-ref | ops-owner | sanitized log reference |', '| Cleanup command run recorded | pending | pending | pending | pending |')
      .replace('Production proof-media decision: approved', 'Production proof-media decision: blocked')
      .concat('\nDRIVER_PROOF_MEDIA_S3_SECRET_ACCESS_KEY=super-secret\nAKIA1234567890ABCDEF\nBearer scanner-token\nprod-driver-proof-private-bucket\n');

    const result = verifyDriverProofMediaEvidenceManifest(incompleteManifest);

    expect(result.ok).toBe(false);
    expect(result.failures.join('\n')).toMatch(/pending placeholder/i);
    expect(result.failures.join('\n')).toMatch(/storage\/signed access row/i);
    expect(result.failures.join('\n')).toMatch(/upload safety policy row/i);
    expect(result.failures.join('\n')).toMatch(/cleanup scheduler row/i);
    expect(result.failures.join('\n')).toMatch(/production proof-media decision/i);
    expect(result.failures.join('\n')).toMatch(/sensitive or private artifact pattern/i);
  });

  test.each([
    'Authenticated driver and assigned-route scope enforced',
    'Image MIME allowlist and matching byte signature enforced',
    'Ten MiB file and single-file limits enforced',
    'JPEG EXIF metadata stripping verified'
  ])('rejects a manifest missing required upload safety gate %s', (gate) => {
    const missingSafetyGate = completeManifest.replace(new RegExp(`^\\| ${gate} .*\\n`, 'm'), '');

    const result = verifyDriverProofMediaEvidenceManifest(missingSafetyGate);

    expect(result.ok).toBe(false);
    expect(result.failures).toContain(`upload safety policy required gate "${gate}" is missing.`);
  });

  test('rejects a scanner-free manifest without its policy approval row', () => {
    const result = verifyDriverProofMediaEvidenceManifest(
      completeManifest.replace(/^\| Scanner-free operation approved .*\n/m, '')
    );

    expect(result.ok).toBe(false);
    expect(result.failures.join('\n')).toContain('Scanner-free operation approved');
  });

  test('requires scanner deployment, fixtures, and monitor evidence when http is selected', () => {
    const incompleteHttpManifest = completeManifest
      .replace('Scanner backend selection: none', 'Scanner backend selection: http')
      .replace(/^\| Scanner-free operation approved .*\n/m, '');

    const result = verifyDriverProofMediaEvidenceManifest(incompleteHttpManifest);

    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(expect.arrayContaining([
      expect.stringContaining('HTTP scanner deployment approved'),
      expect.stringContaining('HTTP scanner clean and rejected fixtures pass'),
      expect.stringContaining('HTTP scan monitor handling verified')
    ]));
  });

  test('accepts the documented complete HTTP scanner alternative', () => {
    const httpManifest = completeManifest
      .replace('Scanner backend selection: none', 'Scanner backend selection: http')
      .replace(
        /^\| Scanner-free operation approved .*$/m,
        [
          '| HTTP scanner deployment approved | approved | scanner-deploy-ref | security-owner | private endpoint |',
          '| HTTP scanner clean and rejected fixtures pass | pass | scanner-fixtures-ref | qa-owner | sanitized fixtures |',
          '| HTTP scan monitor handling verified | pass | scan-monitor-ref | ops-owner | sanitized outcomes |'
        ].join('\n')
      );

    expect(verifyDriverProofMediaEvidenceManifest(httpManifest)).toEqual({
      failures: [],
      ok: true,
      warnings: []
    });
  });
});
