import { describe, expect, test } from 'vitest';

import { buildDriverProofMediaEvidenceSeed } from '../src/modules/driver/driver-proof-media-evidence-seed.js';

describe('driver proof media production evidence seed', () => {
  test('renders source revision, config presence, evidence gates, and tracking issues without secret values', () => {
    const markdown = buildDriverProofMediaEvidenceSeed({
      env: {
        DRIVER_PROOF_MEDIA_STORAGE_BACKEND: 's3',
        DRIVER_PROOF_MEDIA_S3_BUCKET: 'prod-driver-proof-private-bucket',
        DRIVER_PROOF_MEDIA_S3_CREDENTIALS_PROVIDER: 'ec2-iam-role',
        DRIVER_PROOF_MEDIA_S3_REGION: 'us-east-1',
        DRIVER_PROOF_MEDIA_S3_ENDPOINT: 'https://s3.private.example',
        DRIVER_PROOF_MEDIA_S3_FORCE_PATH_STYLE: 'true',
        DRIVER_PROOF_MEDIA_READ_ACCESS_TTL_SECONDS: '300',
        DRIVER_PROOF_MEDIA_RETENTION_DAYS: '365',
        DRIVER_PROOF_MEDIA_SCANNER_BACKEND: 'http',
        DRIVER_PROOF_MEDIA_SCANNER_URL: 'https://scanner.private.example/scan',
        DRIVER_PROOF_MEDIA_SCANNER_BEARER_TOKEN: 'scanner-bearer-secret',
        DRIVER_PROOF_MEDIA_SCAN_MONITOR_BACKEND: 'http',
        DRIVER_PROOF_MEDIA_SCAN_MONITOR_URL: 'https://monitor.private.example/scan',
        DRIVER_PROOF_MEDIA_SCAN_MONITOR_BEARER_TOKEN: 'monitor-bearer-secret',
        DRIVER_PROOF_MEDIA_CLEANUP_EVIDENCE_REF: 'private://evidence/proof-media-cleanup'
      },
      sourceCommitSha: 'abc123def456',
      sourceRef: 'cc-202-proof-media-evidence-seed'
    });

    expect(markdown).toContain('# Driver proof media production evidence seed');
    expect(markdown).toContain('| Source commit SHA | `abc123def456` |');
    expect(markdown).toContain('| Source ref | `cc-202-proof-media-evidence-seed` |');
    expect(markdown).toContain('| Storage backend | `s3` |');
    expect(markdown).toContain('| `DRIVER_PROOF_MEDIA_S3_BUCKET` | present |');
    expect(markdown).toContain('| `DRIVER_PROOF_MEDIA_S3_CREDENTIALS_PROVIDER` | `ec2-iam-role` |');
    expect(markdown).toContain('| `DRIVER_PROOF_MEDIA_SCANNER_BACKEND` | `http` |');
    expect(markdown).toContain('| `DRIVER_PROOF_MEDIA_SCAN_MONITOR_BACKEND` | `http` |');
    expect(markdown).toContain('| `DRIVER_PROOF_MEDIA_CLEANUP_EVIDENCE_REF` | present |');
    expect(markdown).toContain('Bucket ownership, Block Public Access, disabled versioning/Object Lock, and IAM least-privilege approval');
    expect(markdown).toContain('EVNSolution/clever-route-server#71');
    expect(markdown).toContain('EVNSolution/clever-routes-app#73');

    expect(markdown).not.toContain('prod-driver-proof-private-bucket');
    expect(markdown).not.toContain('https://s3.private.example');
    expect(markdown).not.toContain('https://scanner.private.example');
    expect(markdown).not.toContain('scanner-bearer-secret');
    expect(markdown).not.toContain('private://evidence/proof-media-cleanup');
  });

  test('marks missing production hardening configuration without failing seed generation', () => {
    const markdown = buildDriverProofMediaEvidenceSeed({
      env: {},
      sourceCommitSha: 'unknown',
      sourceRef: 'dev'
    });

    expect(markdown).toContain('| Storage backend | `local` |');
    expect(markdown).toContain('| `DRIVER_PROOF_MEDIA_S3_BUCKET` | missing |');
    expect(markdown).toContain('| `DRIVER_PROOF_MEDIA_SCANNER_BACKEND` | `none` |');
    expect(markdown).toContain('| `DRIVER_PROOF_MEDIA_SCAN_MONITOR_BACKEND` | `none` |');
    expect(markdown).toContain('| `DRIVER_PROOF_MEDIA_CLEANUP_EVIDENCE_REF` | missing |');
    expect(markdown).toContain('scanner deliberately disabled; record approval privately');
    expect(markdown).toContain('This seed is not proof that production storage or cleanup is deployed.');
  });
});
