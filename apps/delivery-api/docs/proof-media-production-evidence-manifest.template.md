# Driver proof media production evidence manifest template

## Use and storage rules

Copy this template into the approved private production evidence store for each
proof-media hardening release candidate. Do not commit completed manifests,
bucket names, IAM policies, access keys, bearer tokens, scanner endpoints,
storage keys, proof files, raw logs, customer data, phone numbers, coordinates,
or private evidence screenshots to this repository.

Recommended private filename:

```text
proof-media-production-evidence-manifest-<yyyyMMdd>-<shortsha>.md
```

Before filling a copied manifest, seed the private evidence record from the
selected source revision:

```bash
npm run driver:proof-media:evidence:seed
```

After filling the external copy, validate a local working copy from this repo:

```bash
npm run driver:proof-media:evidence:verify -- /path/to/private/proof-media-production-evidence-manifest-<yyyyMMdd>-<shortsha>.md
```

The verifier should pass only after all `pending` placeholders are removed,
storage/signed-access, upload safety policy, cleanup scheduler, and private
evidence storage rows are approved or passing, and the production proof-media
decision is `approved`. The verifier does not prove the private evidence is
authentic; owner-controlled review remains required.

## Source revision

| Field | Value |
| --- | --- |
| Source commit SHA | pending |
| GitHub PR / merge reference | pending |
| Runtime environment | pending |
| Evidence owner | pending |
| Private evidence storage location | pending |
| Synthetic proof media only? | yes / no |
| Production validation approval reference, if any | pending / n/a |

## Storage and signed access evidence

| Gate | Status | Evidence reference | Owner | Notes |
| --- | --- | --- | --- | --- |
| Object storage backend selected as s3 | pending | pending | pending | sanitized config presence only |
| Bucket ownership approved | pending | pending | pending | do not paste bucket names |
| IAM least-privilege object policy approved | pending | pending | pending | instance profile role; do not paste policy JSON |
| IMDSv2 required and container hop limit 2 | pending | pending | pending | sanitized metadata-options evidence only |
| Static AWS keys absent from application runtime | pending | pending | pending | temporary role credentials only |
| S3 Block Public Access and Object Ownership approved | pending | pending | pending | do not paste bucket names |
| Bucket versioning and Object Lock disabled | pending | pending | pending | required for 365-day physical object deletion |
| S3 Lifecycle expiration is 365 days | pending | pending | pending | `driver-proof/` prefix summary only |
| Signed PUT/DELETE smoke with synthetic media | pending | pending | pending | sanitized result only |
| Signed GET read smoke with synthetic media | pending | pending | pending | sanitized result only |
| Multi-stop POD linkage smoke with synthetic media | pending | pending | pending | one object; all destination stop ids |
| Signed GET expiry after five minutes | pending | pending | pending | never store the signed URL in evidence |
| Retention window approved | pending | pending | pending | 365-day S3 and DB cleanup match |

## Upload safety policy evidence

| Gate | Status | Evidence reference | Owner | Notes |
| --- | --- | --- | --- | --- |
| Scanner backend selection: none | pending | pending | pending | replace none with http when the optional adapter is selected |
| Scanner-free operation approved | pending | pending | pending | do not claim clean/rejected scanning when backend is none |
| Authenticated driver and assigned-route scope enforced | pending | pending | pending | unauthorized and cross-route requests fail |
| Image MIME allowlist and matching byte signature enforced | pending | pending | pending | JPEG, PNG, WebP, HEIC, or HEIF only |
| Ten MiB file and single-file limits enforced | pending | pending | pending | multipart limits remain active |
| JPEG EXIF metadata stripping verified | pending | pending | pending | hash and size describe sanitized bytes |

When `http` is selected, replace the two scanner-free rows with passing rows
using these exact gate labels:

- `Scanner backend selection: http`
- `HTTP scanner deployment approved`
- `HTTP scanner clean and rejected fixtures pass`
- `HTTP scan monitor handling verified`

Do not add those rows or claim scan results when `none` is selected.

## Cleanup scheduler evidence

| Gate | Status | Evidence reference | Owner | Notes |
| --- | --- | --- | --- | --- |
| Scheduler deployment selected | pending | pending | pending | host scheduler evidence |
| Cleanup command run recorded | pending | pending | pending | sanitized log reference |
| RetentionJobRun row persisted | pending | pending | pending | no media ids or storage keys |
| 365-day cutoff boundary passes | pending | pending | pending | immediately before and after cutoff |
| Failed object deletion converges on retry | pending | pending | pending | synthetic object and sanitized counts |
| Cleanup logs contain no proof bytes, coordinates, customer data, phone numbers, or storage keys | pending | pending | pending | reviewed privately |

## Private evidence storage and approvals

| Gate | Status | Evidence reference | Owner | Notes |
| --- | --- | --- | --- | --- |
| Private evidence workspace approved | pending | pending | pending | access controlled |
| Public issues/PRs contain sanitized references only | pending | pending | pending | no private evidence committed |
| Driver app release blockers cross-referenced | pending | pending | pending | app smoke/build issues linked |

## Completion decision

| Gate | Status | Notes |
| --- | --- | --- |
| Storage and signed access evidence complete | pending | pending |
| Upload safety policy evidence complete | pending | pending |
| Cleanup scheduler evidence complete | pending | pending |
| Private evidence storage approved | pending | pending |
| Sensitive evidence kept outside git | pending | pending |
| Follow-up blockers linked | pending | pending |

Production proof-media decision: `approved` / `rejected` / `blocked`

Decision owner:

Decision timestamp:

## Follow-up issue map

| Blocker | Issue | Status / evidence reference |
| --- | --- | --- |
| Delivery-server production proof-media evidence | EVNSolution/clever-route-server#71 | pending |
| Routes-app native build/store/privacy evidence | EVNSolution/clever-routes-app#73 | pending |
| Routes-app physical iOS/Android smoke evidence | EVNSolution/clever-routes-app#72 | pending |
