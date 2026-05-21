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
storage/signed-access, scanner/monitoring, cleanup scheduler, and private
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
| IAM least-privilege policy approved | pending | pending | pending | do not paste policy JSON |
| Credential custody and rotation owner approved | pending | pending | pending | do not paste access keys |
| Signed PUT/DELETE smoke with synthetic media | pending | pending | pending | sanitized result only |
| Signed GET read smoke with synthetic media | pending | pending | pending | sanitized result only |
| Retention window approved | pending | pending | pending | match cleanup schedule |

## Scanner and monitoring evidence

| Gate | Status | Evidence reference | Owner | Notes |
| --- | --- | --- | --- | --- |
| HTTP scanner deployment selected | pending | pending | pending | keep endpoint private |
| Scanner endpoint auth/secret custody approved | pending | pending | pending | keep token private |
| Clean scan smoke passes with synthetic media | pending | pending | pending | sanitized result only |
| Rejected scan smoke blocks storage metadata | pending | pending | pending | no rule names in public evidence |
| Scan monitor or alert route deployed | pending | pending | pending | sanitized alert evidence |
| Incident response owner approved | pending | pending | pending | on-call owner recorded privately |

## Cleanup scheduler evidence

| Gate | Status | Evidence reference | Owner | Notes |
| --- | --- | --- | --- | --- |
| Scheduler deployment selected | pending | pending | pending | host scheduler evidence |
| Cleanup command run recorded | pending | pending | pending | sanitized log reference |
| RetentionJobRun row persisted | pending | pending | pending | no media ids or storage keys |
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
| Scanner and monitoring evidence complete | pending | pending |
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
| Driver-app native build/store/privacy evidence | EVNSolution/clever-driver-app#73 | pending |
| Driver-app physical iOS/Android smoke evidence | EVNSolution/clever-driver-app#72 | pending |
