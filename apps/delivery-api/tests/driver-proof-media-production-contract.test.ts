import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

import { DEFAULT_DRIVER_PROOF_MEDIA_RETENTION_DAYS } from '../src/modules/driver/driver.dependencies.js';

const repoFile = (path: string): string => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');

describe('Driver POD production contract', () => {
  test('keeps application, privacy, and scheduled cleanup retention at 365 days', () => {
    const envExample = repoFile('apps/delivery-api/.env.example');
    const privacy = repoFile('apps/delivery-api/src/routes/privacy.routes.ts');
    const runbook = repoFile('apps/delivery-api/docs/deployment/driver-proof-media-s3.md');

    expect(DEFAULT_DRIVER_PROOF_MEDIA_RETENTION_DAYS).toBe(365);
    expect(envExample).toContain('DRIVER_PROOF_MEDIA_RETENTION_DAYS=365');
    expect(privacy).toContain('기본 365일');
    expect(runbook).toContain('DRIVER_PROOF_MEDIA_RETENTION_DAYS=365');
  });

  test('selects private S3 with an EC2 IAM role and no proof-media EBS mount in production', () => {
    const compose = repoFile('infra/compose/docker-compose.prod.yml');
    const envExample = repoFile('apps/delivery-api/.env.example');
    const deploy = repoFile('scripts/ssm-simple-route-ops-deploy.sh');

    expect(compose).toContain('DRIVER_PROOF_MEDIA_STORAGE_BACKEND: s3');
    expect(compose).toContain('DRIVER_PROOF_MEDIA_S3_CREDENTIALS_PROVIDER: ec2-iam-role');
    expect(compose).not.toContain('/data/driver-proof-media:/app/var/driver-proof-media');
    expect(envExample).not.toContain('DRIVER_PROOF_MEDIA_S3_ACCESS_KEY_ID=');
    expect(envExample).not.toContain('DRIVER_PROOF_MEDIA_S3_SECRET_ACCESS_KEY=');
    expect(deploy).toContain("'DRIVER_PROOF_MEDIA_S3_ACCESS_KEY_ID'");
    expect(deploy).toContain('retired_proof_media_keys');
    expect(repoFile('apps/delivery-api/docs/deployment/driver-proof-media-s3.md'))
      .toContain('Keep bucket versioning disabled');
  });

  test('ships least-privilege object permissions and the exact 365-day lifecycle rule', () => {
    const lifecycle = JSON.parse(repoFile('infra/aws/driver-proof-media-s3-lifecycle.json')) as {
      Rules: Array<{ Expiration: { Days: number }; Filter: { Prefix: string }; Status: string }>;
    };
    const policy = JSON.parse(repoFile('infra/aws/driver-proof-media-iam-policy.template.json')) as {
      Statement: Array<{ Action: string[]; Resource: string }>;
    };

    expect(lifecycle.Rules).toEqual([
      expect.objectContaining({
        Expiration: { Days: 365 },
        Filter: { Prefix: 'driver-proof/' },
        Status: 'Enabled'
      })
    ]);
    expect(policy.Statement[0]).toMatchObject({
      Action: ['s3:DeleteObject', 's3:GetObject', 's3:PutObject'],
      Resource: '${DRIVER_PROOF_MEDIA_BUCKET_ARN}/driver-proof/*'
    });
  });

  test('documents the scanner-free upload validation contract in API references', () => {
    const expected = 'One JPEG, PNG, WebP, HEIC, or HEIF image up to 10 MiB. The declared MIME type must match the file signature.';
    const evidenceTemplate = repoFile('apps/delivery-api/docs/proof-media-production-evidence-manifest.template.md');

    expect(repoFile('apps/delivery-api/docs/api/driver-proof-media.md')).toContain(expected);
    expect(repoFile('apps/delivery-api/docs/api/openapi.yaml')).toContain(expected);
    expect(evidenceTemplate).toContain('| Scanner backend selection: none |');
    expect(evidenceTemplate).toContain('| Scanner-free operation approved |');
    expect(evidenceTemplate).toContain('`HTTP scanner deployment approved`');
    expect(evidenceTemplate).toContain('`HTTP scanner clean and rejected fixtures pass`');
    expect(evidenceTemplate).toContain('`HTTP scan monitor handling verified`');
  });
});
