# Driver POD private S3 rollout

This runbook changes Driver proof-of-delivery media from the legacy host bind
mount to a private S3 bucket. The application uses the EC2 instance profile and
IMDSv2 temporary credentials. Do not put AWS access keys in the application
environment, SSM parameters, Compose files, evidence records, or this repository.

The repository templates are:

- `infra/aws/driver-proof-media-iam-policy.template.json`: object-only runtime permissions for the `driver-proof/` prefix
- `infra/aws/driver-proof-media-s3-lifecycle.json`: 365-day object expiration and one-day incomplete multipart cleanup

## Before rollout

The first S3 switch requires a bridge release. The old runtime requires static S3
credentials and cannot boot after the new environment removes them. Deploy an
approved IAM-role-capable runtime and the additive migration first, using the
existing local backend and Compose mount with uploads paused. Verify its image
digest, health, and `org.clever-route.proof-media-iam-role-capability=1` label, then
record `DRIVER_PROOF_MEDIA_IAM_ROLE_CAPABILITY_VERSION=1` alongside that digest in
the protected current-image manifest. Do not relabel an older image. The generic
S3 rollout checks both the manifest and the actual rollback image label before
changing Compose or the application environment; it deliberately blocks the
first switch without this bridge.

While uploads are paused, inventory existing non-expired local POD rows and copy
their sanitized bytes to the private S3 bucket under the same storage keys. Verify
each byte count and SHA-256 against its row, retain the original `uploadedAt` for
the 365-day application cutoff, and reconcile row/object counts. Missing or
mismatched objects block the switch. Keep the local rollback evidence protected
until the S3 smoke and recovery rehearsal pass; retire the local originals through
the approved migration cleanup instead of leaving an indefinite second copy.

Record the following in the approved private evidence workspace. Use synthetic
proof media only and keep bucket names, role names, signed URLs, storage keys,
scanner endpoints, account ids, addresses, and screenshots out of git.

1. Record the current API image digest, database migration state, proof-media
   backend, retention value, reservation flag, cleanup timer status, and the
   latest sanitized `RetentionJobRun` result.
2. Create or select a dedicated bucket in the same AWS Region as the API. Enable
   S3 Block Public Access for every setting, Bucket owner enforced Object
   Ownership, and default server-side encryption. Keep bucket versioning disabled
   and Object Lock disabled so application DELETE and the 365-day Lifecycle rule
   remove the object bytes instead of leaving noncurrent versions behind.
3. Apply `driver-proof-media-s3-lifecycle.json` and verify that the enabled rule
   has prefix `driver-proof/` and `Expiration.Days=365`.
4. Render the IAM policy template into the private workspace with the real bucket
   ARN. Attach it to the API EC2 instance profile role. The application role must
   have only `s3:PutObject`, `s3:GetObject`, and `s3:DeleteObject` for the proof
   prefix; bucket administration stays with the platform role.
5. Configure the EC2 metadata endpoint as enabled, IMDSv2 required, and response
   hop limit `2` for the Docker container. Confirm the container can obtain the
   role name and temporary session credentials without printing credential values.
6. Set only these S3 runtime values in the protected application environment:

   ```dotenv
   DRIVER_PROOF_MEDIA_STORAGE_BACKEND=s3
   DRIVER_PROOF_MEDIA_S3_CREDENTIALS_PROVIDER=ec2-iam-role
   DRIVER_PROOF_MEDIA_S3_BUCKET=<private value>
   DRIVER_PROOF_MEDIA_S3_REGION=<region>
   DRIVER_PROOF_MEDIA_READ_ACCESS_TTL_SECONDS=300
   DRIVER_PROOF_MEDIA_RESERVATIONS_ENABLED=true
   DRIVER_PROOF_MEDIA_RETENTION_DAYS=365
   ```

7. Set `DRIVER_PROOF_MEDIA_SCANNER_BACKEND=none` and
   `DRIVER_PROOF_MEDIA_SCAN_MONITOR_BACKEND=none` for an approved scanner-free
   policy. Record that decision privately without claiming scan results. HTTP
   scanner and monitor adapters remain available; when selected, configure their
   URLs and keep bearer tokens in the approved secret store.
8. Verify `clever-driver-event-attempt-retention.timer` is enabled and that its
   runner includes `driver:proof-media:cleanup`.

AWS references: [EC2 role credentials through IMDSv2](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/instance-metadata-security-credentials.html),
[container metadata hop limit](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/configuring-instance-metadata-options.html),
[S3 Block Public Access](https://docs.aws.amazon.com/AmazonS3/latest/userguide/access-control-block-public-access.html),
and [S3 Lifecycle expiration](https://docs.aws.amazon.com/AmazonS3/latest/userguide/lifecycle-expire-general-considerations.html).

## Synthetic rollout verification

After deploying an approved exact SHA, capture sanitized results for this sequence:

1. Upload a synthetic JPEG containing disposable EXIF metadata for a destination
   that has at least two delivery stops. Verify one `READY` media row, one object,
   stripped EXIF, the sanitized SHA-256, and one link row for every destination
   stop.
2. Repeat the same idempotency request. Verify the existing media id and linked
   stop ids are returned without another object.
3. Sign in as a DSV administrator with `dsv:records:read`, request the POD access
   endpoint, and verify the response contains the linked stop ids and a five-minute
   S3 URL without a storage key.
4. Verify the signed URL succeeds before expiry and fails after expiry. Verify a
   customer session, another Store, missing session, non-READY media, and deleted
   media cannot obtain access.
5. Verify authentication, assigned-route scope, the image MIME allowlist,
   matching byte signatures, the ten MiB/single-file limits, and JPEG EXIF
   stripping. When the optional HTTP scanner is selected, also run its clean and
   rejected fixtures and verify rejected bytes never create a media row or S3
   object.
6. Seed one synthetic `READY` row immediately before the 365-day cutoff and one
   immediately older. Run cleanup and verify only the older object, media row,
   and stop links are removed while the sanitized cleanup aggregate remains.
7. Force one synthetic S3 DELETE failure. Verify the claimed row remains retryable,
   rerun cleanup after recovery, and verify deletion converges without exposing the
   object publicly.

## After rollout

Record the deployed image digest, migration ids, effective non-secret settings,
bucket public-access and lifecycle summaries, instance-profile and IMDSv2 checks,
upload-safety policy references, signed-access expiry result, multi-stop link
counts, cleanup retry result, timer status, and sanitized `RetentionJobRun` id in
the private evidence manifest. Run:

```bash
npm run driver:proof-media:evidence:seed
npm run driver:proof-media:evidence:verify -- /path/to/private/completed-manifest.md
```

The source-controlled seed and verifier check completeness and accidental leaks;
they do not replace owner review of the private AWS and runtime evidence.
