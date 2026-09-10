# Driver Proof Media API

Purpose: allow the native driver app to upload proof-of-delivery photo files after the driver has a server-issued bearer token and an assigned route/stop context.

This endpoint is a binary upload companion to `POST /driver/events`. The driver app uploads photo bytes first, receives durable media evidence, then includes the returned media reference in later `STOP_DELIVERED` or `STOP_FAILED` event payloads.

## Runtime registration

The route is registered with the Driver API runtime when `JWT_SECRET` is configured. Runtime dependencies include `DRIVER_PROOF_MEDIA_STORAGE_BACKEND`, which defaults to local filesystem storage when unset, and `DRIVER_PROOF_MEDIA_STORAGE_DIR`, which defaults to `var/driver-proof-media` for local mode. That default local path is ignored by git and is suitable for local/dev smoke only.

The repository writes, removes, and optionally creates read access through a `DriverProofMediaStorageBackend` contract. Runtime storage is selected by `DRIVER_PROOF_MEDIA_STORAGE_BACKEND`:

- unset or `local`: local filesystem write/remove under `DRIVER_PROOF_MEDIA_STORAGE_DIR`; suitable for local/dev smoke only and does not expose file URLs
- `s3`: S3-compatible object storage with SigV4 header authentication for upload/delete and SigV4 presigned GET URLs for short-lived read access

S3 mode requires `DRIVER_PROOF_MEDIA_S3_BUCKET` and `DRIVER_PROOF_MEDIA_S3_REGION`. `DRIVER_PROOF_MEDIA_S3_CREDENTIALS_PROVIDER` defaults to and only accepts `ec2-iam-role`; the server retrieves short-lived instance-profile credentials through IMDSv2 and caches them until five minutes before expiry. Static AWS access-key environment variables are unsupported. `DRIVER_PROOF_MEDIA_S3_ENDPOINT` and `DRIVER_PROOF_MEDIA_S3_FORCE_PATH_STYLE` remain optional for S3-compatible endpoints. The implementation follows AWS Signature Version 4 canonical request and presigned URL rules and uses a source-controlled test vector from the AWS S3 API reference.

`DRIVER_PROOF_MEDIA_READ_ACCESS_TTL_SECONDS` defines the short-lived signed/read access lifetime and defaults to 300 seconds. In S3 mode, the presigned URL lifetime must be within the SigV4 maximum of seven days. `DRIVER_PROOF_MEDIA_RETENTION_DAYS` defines the proof-media cleanup window and defaults to 365 days. Production Compose selects S3, enables upload reservations, and does not mount the legacy EBS proof-media directory. The bucket Lifecycle rule in `infra/aws/driver-proof-media-s3-lifecycle.json` also expires the `driver-proof/` prefix after 365 days. Scanner, IAM, bucket, signed-access, and scheduler deployment evidence must still be completed privately before production approval.

JPEG uploads are sanitized before byte persistence: valid EXIF APP1 segments are removed, and returned/stored `sha256` plus `sizeBytes` describe the sanitized bytes. If a `DriverProofMediaScanner` is configured, the scanner receives the sanitized bytes, content type, storage key, and sanitized SHA-256 before any byte write or metadata create. Runtime scanner wiring is selected by `DRIVER_PROOF_MEDIA_SCANNER_BACKEND`: unset/`none` disables scanning, while `http` posts sanitized bytes to `DRIVER_PROOF_MEDIA_SCANNER_URL` with optional `DRIVER_PROOF_MEDIA_SCANNER_BEARER_TOKEN`. The HTTP scanner must return JSON `status: clean` or `status: rejected` with a private reason. If a `DriverProofMediaScanMonitor` is configured, it receives scanner outcome metadata (`clean` or `rejected`), media id, storage key, sanitized SHA-256, content type, scan timestamp, and private rejection reason when applicable; it never receives proof file bytes. Runtime monitor wiring is selected by `DRIVER_PROOF_MEDIA_SCAN_MONITOR_BACKEND`: unset/`none` disables monitoring, while `http` posts sanitized JSON to `DRIVER_PROOF_MEDIA_SCAN_MONITOR_URL` with optional `DRIVER_PROOF_MEDIA_SCAN_MONITOR_BEARER_TOKEN`. A rejected scan aborts persistence and maps to `422 PROOF_MEDIA_REJECTED`. This reduces accidental location/device metadata retention and provides server-side scanner and monitoring integration points, but it is not proof that a production malware scanner, signed access, monitoring backend, or private object storage control is deployed.

Manual or cron-style retention cleanup uses:

```bash
npm run driver:proof-media:cleanup
```

The command does not start the HTTP server. It connects Prisma, applies `DRIVER_PROOF_MEDIA_RETENTION_DAYS`, runs the proof-media repository cleanup, records a sanitized `RetentionJobRun`, disconnects Prisma, and prints JSON with `scanned`, `deleted`, `missingFiles`, `uploadedBefore`, `deletedAt`, and `evidenceRecorded`.

Uploads reserve a `PENDING_UPLOAD` database row before object storage is written and become readable only after a compare-and-set transition to `READY`. Hourly cleanup first claims a stale `PENDING_UPLOAD` row as `CLEANING`; it deliberately retains that fenced reservation for one cleanup lease so a delayed upload cannot create an untracked object. A later pass after lease expiry removes the object and deletes the same-token `CLEANING` reservation. Storage PUT and DELETE calls are bounded; a failed or timed-out DELETE retains the durable `CLEANING` row for retry. Normal retention and read APIs select only `READY`, so referenced proof is never treated as an orphan.

`runDriverProofMediaRetentionCleanup()` accepts an optional `DriverProofMediaCleanupMonitor`. The monitor receives sanitized cleanup-run evidence: scanned count, deleted count, missing file count, `uploadedBefore`, `deletedAt`, retention days, and optional batch limit. The monitor payload intentionally excludes media ids, storage keys, file bytes, customer addresses, coordinates, phone numbers, and proof images. The default cleanup command wires `PrismaDriverProofMediaCleanupMonitor`, which creates a `RetentionJobRun` row with `jobName=driver-proof-media-retention-cleanup`, `status=SUCCEEDED`, sanitized counts, cutoff timestamps, and optional private `DRIVER_PROOF_MEDIA_CLEANUP_EVIDENCE_REF`. A production scheduler can run the command and reference private job/log evidence through that env value, but deployed scheduler evidence still remains a release blocker.

Before filling production proof-media release evidence, generate a non-secret
runtime/source seed with:

```bash
npm run driver:proof-media:evidence:seed
```

The seed prints current source commit/ref, proof-media runtime config presence,
remaining private evidence gates, and tracking issues without printing bucket
names, endpoints, access keys, bearer tokens, storage keys, proof bytes, or
completed evidence references. Copy the seed into the approved private evidence
workspace and fill real bucket/IAM, signed URL, upload-safety policy, cleanup
scheduler, and private evidence-store references there. Copy
`docs/proof-media-production-evidence-manifest.template.md` into that private
workspace for the release candidate. After filling it, validate a local working
copy with:

```bash
npm run driver:proof-media:evidence:verify -- /path/to/private/proof-media-production-evidence-manifest-<date>-<sha>.md
```

The verifier is a local completeness and leak guard; it does not prove the
private evidence is authentic or owner-approved.

## GET `/driver/proof-media/:mediaId/access`

Request:

```http
GET /driver/proof-media/11111111-1111-4111-8111-111111111111/access
Authorization: Bearer <server-issued driver JWT>
```

Success, when the storage backend supports short-lived read access:

```json
{
  "data": {
    "kind": "photo",
    "mediaId": "11111111-1111-4111-8111-111111111111",
    "contentType": "image/jpeg",
    "url": "https://object-storage.example/signed/read-url",
    "expiresAt": "2026-05-12T10:05:00.000Z"
  },
  "error": null
}
```

The access route verifies the same account/route bearer token as upload, resolves the current Store driver reference from the token route assignment, scopes the media row to that route/reference/Store, requires `deletedAt: null`, and only then asks the storage backend to create a short-lived read URL. It does not expose raw bytes, storage keys, other driver media, deleted media, scanner internals, or object-storage provider credentials. DSV administrators use the separately authenticated `/api/dsv/v1/proof-media/:mediaId/access` contract described below.

Missing or invalid bearer tokens return `401`. Invalid media ids return `400`. A bearer-token driver that is not allowed to read the media receives `403` without route/stop details. If the configured storage backend cannot create read access, the route returns `503`:

```json
{
  "data": null,
  "error": {
    "code": "PROOF_MEDIA_ACCESS_UNAVAILABLE",
    "message": "Proof media access is not configured"
  }
}
```

The default local filesystem backend intentionally does not create public file URLs. S3 mode implements `createReadAccess()` with presigned URLs and uses temporary EC2 instance-role credentials obtained through IMDSv2.

## POST `/driver/proof-media`

Request:

```http
POST /driver/proof-media
Authorization: Bearer <server-issued driver JWT>
Content-Type: multipart/form-data; boundary=...
```

Multipart fields:

| Field | Required | Notes |
| --- | ---: | --- |
| `deliveryStopId` | Yes | Stop id from the authenticated driver's assigned route. |
| `routePlanId` | Yes | Route plan id from route access/assigned route context. |
| `source` | Yes | `camera` or `library`. |
| `file` | Yes | One JPEG, PNG, WebP, HEIC, or HEIF image up to 10 MiB. The declared MIME type must match the file signature. |

Success:

```json
{
  "data": {
    "kind": "photo",
    "mediaId": "11111111-1111-4111-8111-111111111111",
    "deliveryStopIds": ["11111111-1111-4111-8111-111111111112", "11111111-1111-4111-8111-111111111113"],
    "storageKey": "driver-proof/example.myshopify.com/route-plan-id/stop-id/11111111-1111-4111-8111-111111111111.jpg",
    "contentType": "image/jpeg",
    "source": "camera",
    "uploadedAt": "2026-05-12T10:00:00.000Z",
    "sizeBytes": 12345,
    "sha256": "sha256-hex"
  },
  "error": null
}
```

Missing or invalid bearer tokens return `401`:

```json
{
  "data": null,
  "error": { "code": "UNAUTHORIZED", "message": "Missing driver bearer token" }
}
```

Invalid multipart payloads return `400`:

```json
{
  "data": null,
  "error": { "code": "BAD_REQUEST", "message": "Invalid proof media upload payload" }
}
```

A bearer-token driver that is not assigned to the `routePlanId`/`deliveryStopId` scope receives `403` without route/stop details:

```json
{
  "data": null,
  "error": { "code": "FORBIDDEN", "message": "Proof media route scope rejected" }
}
```

Scanner-rejected proof media returns `422` without route/stop details, scanner internals, stored bytes, or metadata:

```json
{
  "data": null,
  "error": { "code": "PROOF_MEDIA_REJECTED", "message": "Proof media rejected by safety scan" }
}
```

## Persistence model

`DriverProofMedia` stores upload metadata under the verified account/route assignment boundary:

- shop, driver, route plan, and delivery stop references
- `kind: PHOTO`
- upload lifecycle (`PENDING_UPLOAD` reservation, cleanup-owned `CLEANING`, readable `READY`)
- source (`CAMERA` or `LIBRARY`)
- MIME type, original filename, storage key, sanitized byte size, sanitized SHA-256 hash
- upload timestamp and optional future deletion timestamp

The supplied `deliveryStopId` is the compatibility anchor. The server resolves its order destination and links the single media object to every stop for that destination in the same Store and route plan. Callers cannot supply or expand the linked stop set. When the anchor order has no destination id, only the anchor stop is linked.

The repository checks all of the following before writing bytes or metadata:

- the bearer-token `accountId` still owns the token `routePlanId` through its current Store driver reference
- Store id, Store domain, and driver-reference id are derived from that route assignment
- the multipart `routePlanId` equals the token route id and remains in an active/assigned route state
- `deliveryStopId` is a stop in that route plan
- every derived linked stop belongs to the same Store, route plan, and destination
- any configured `DriverProofMediaScanner` returns `status: "clean"` for the sanitized bytes

## Data minimization and retention notes

- The API returns metadata only; it does not echo raw file bytes.
- Do not log multipart bodies, file bytes, customer addresses, or real proof images.
- Use synthetic proof images in tests and public PR evidence.
- JPEG EXIF APP1 metadata is stripped before local byte storage and before `sha256` / `sizeBytes` are recorded.
- The scan hook runs after EXIF stripping and before storage/metadata writes; scan rejection should not leak scanner rule names or signature details to the driver response.
- The scan monitor hook records clean/rejected scanner outcome metadata without proof file bytes. Private monitoring backends may receive the scanner rejection reason, but public issue/PR/store evidence should use sanitized references only.
- `PrismaDriverProofMediaRepository.deleteExpiredProofMedia()` selects undeleted metadata older than the configured cutoff, removes stored bytes through the configured storage backend, and hard-deletes the media row and its stop links. The sanitized `RetentionJobRun` aggregate remains as cleanup evidence.
- Stale upload reconciliation atomically claims `PENDING_UPLOAD` as `CLEANING` with a cleanup token before removing bytes. Finalization can change only `PENDING_UPLOAD` to `READY`; if finalization wins, cleanup never removes the object, and if cleanup wins, finalization fails safely. A failed removal retains the fenced `CLEANING` row for lease-expiry retry.
- Missing objects are treated idempotently and still result in media-row deletion so repeated cleanup can converge.
- The cleanup monitor hook records cleanup run counts and cutoffs in `RetentionJobRun` without media ids, storage keys, coordinates, customer data, or proof bytes.
- Storage keys are resolved under the configured storage root before deletion; keys that escape the root are rejected before metadata is deleted.
- `src/scripts/cleanup-driver-proof-media.ts` is the operational entry point for manual or scheduled cleanup. Local development can still select the non-public filesystem backend. Route Ops production Compose selects private S3 and does not bind-mount an EBS proof-media directory.
- Production bucket/IAM ownership approval, IMDSv2 instance-profile evidence, signed URL evidence, an explicit scanner-free or HTTP-scanner policy decision, deployed cleanup scheduler evidence, and private evidence storage remain release gates. Scanner-free operation retains authenticated route scope, the image MIME allowlist, byte-signature checks, the ten MiB/single-file limits, and JPEG EXIF stripping. Follow `docs/deployment/driver-proof-media-s3.md`.

## GET `/api/dsv/v1/proof-media/:mediaId/access`

This DSV administrator endpoint requires a valid DSV web session with
`dsv:records:read`. It scopes the `READY`, non-deleted media row to the
administrator's Store and returns metadata, all linked `deliveryStopIds`, a
five-minute presigned S3 URL, and `expiresAt`. It never returns `storageKey`, raw
bytes, or AWS credentials. Customer sessions and other Stores cannot use this
endpoint. Responses use `Cache-Control: private, no-store`.

## Adjacent APIs

- Driver route access lookup: `docs/api/driver-route-access.md`
- Driver consent record: `docs/api/driver-consents.md`
- Driver assigned route read: `docs/api/driver-assigned-route.md`
- Driver events, including `STOP_DELIVERED` and `STOP_FAILED` proof references: `POST /driver/events`
