# Route Ops GitHub OIDC + AWS SSM deploy

The Route Ops release path is `.github/workflows/route-ops-release.yml`, which consolidates image publish, no-mutation SSM dry validation, immutable release manifest creation, and later manifest-only promotion. The older split SSM deploy workflow has been removed to keep production deployment on one reviewed manual lane.

This is the approved OIDC + SSM deployment shape after the publish-only GHCR model. It keeps normal deployment out of operator laptops:

```text
GitHub Actions workflow_dispatch
→ GitHub OIDC temporary AWS credentials
→ AWS Systems Manager Run Command
→ custom Route Ops deploy document
→ host-local deploy wrapper
→ existing deploy script smoke-before-promote
```

Production execution is **not automatic**. The release workflow exists so a maintainer can intentionally run `mode=prepare`, review the no-mutation dry-run summary and release manifest digest, then run `mode=promote` for that exact manifest. The implementation must not store PEM keys, long-lived AWS keys, admin smoke secrets, runtime `.env`, database credentials, cookies, or production secrets in GitHub.

## Workflow controls

`.github/workflows/route-ops-release.yml` is the primary workflow and is intentionally split by job permission boundary:

- `workflow_dispatch` only; no `push`, PR, schedule, or workflow_run production deploy.
- `refs/heads/main` only.
- `mode=prepare` requires `deployed_base_ref`, validates the actor allowlist before AWS credentials are requested, builds/pushes images in a `packages: write` job, runs `dryRun=true` SSM validation in a separate `id-token: write` job, and emits the immutable `route-ops-release-manifest` artifact.
- `mode=promote` accepts only `release_run_id` and `release_manifest_sha256`, verifies the prepare artifact, validates the manifest digest/provenance, checks out the exact commit recorded by the manifest, regenerates the bundle with `dryRun=false`, and deploys through the same custom SSM document.
- The manifest may record `driverAppDownloadUrlPresent: true/false`, but must not contain the raw driver APK URL.
- The manifest no longer carries route_engine image/digest/evidence; promote verifies the Route Ops release manifest only. Optimizer activation is host-env driven (`VROOM_BASE_URL` preferred with internal DNS `http://vroom:3000`; legacy `ROUTE_ENGINE_BASE_URL` compatibility only).
- No job should have both `packages: write` and `id-token: write`.


## Deploy-control S3 artifact handoff

The production host currently keeps `/srv/clever-route-server` as a deploy directory, not a live Git checkout. The release workflow therefore prepares a narrow non-secret deploy-control bundle, uploads it to S3, and passes the S3 URI, SHA-256 digest, plus the masked driver APK URL handoff through the reviewed custom SSM document. The APK URL must not be written into the bundle or echoed in logs.

This intentionally avoids using SSM document parameters as file transport. The selected production artifact location is:

```text
bucket: route-ops-artifacts-902837199612-ap-northeast-2
prefix: artifacts/route-ops/prod/deploy-control/<github-run-id>/<commit-sha>/
bundle: route-ops-deploy-control.tar.gz
```

Rationale: read-only AWS inspection on 2026-06-08 confirmed account `902837199612`, region `ap-northeast-2`, and a Route Ops specific bucket named `route-ops-artifacts-902837199612-ap-northeast-2`. The bucket has public access blocked, default SSE-S3 (`AES256`), and a lifecycle rule for `artifacts/route-ops/prod/deploy-control/` that expires current objects after 90 days, noncurrent versions after 30 days, and aborts incomplete multipart uploads after 7 days. No unrelated existing bucket is reused.

The bundle contains only these reviewed, non-secret deploy-control files plus a non-secret `deploy-control-manifest.json`:

```text
infra/caddy/Caddyfile
infra/compose/docker-compose.prod.yml
infra/vroom/config.yml
scripts/deploy-route-ops-image.sh
scripts/rollback-route-ops-image.sh
scripts/ssm-route-ops-deploy.sh
scripts/provision-route-engine-graph-from-s3.sh
scripts/smoke-route-ops-production.mjs
scripts/route-ops-deploy-control-bundle.sh
```

The manifest records immutable deploy metadata (`imageTag`, `commitSha`, schema SHA, runtime/migrate image names, publish evidence URL, GitHub run id, S3 URI, dry-run flag) and the exact file allowlist. The release workflow checks out `imageTag` before bundling, so `commitSha` and the deploy-control file contents are pinned to the same commit as the image being activated. It must not contain production secrets, runtime `.env` content, database credentials, cookies, GHCR tokens, SSM Parameter Store secret values, or admin smoke secrets.

Guardrails:

- secret-like paths, source symlinks, source hardlinks, and non-regular source files are rejected before bundling; secret-like paths are also rejected again on the host (`*.env`, `*.env.*`, `*secret*`, `*token*`, `*cookie*`, `*storageState*`);
- GitHub uploads the deterministic bundle with `aws s3 cp ... --sse AES256`;
- SSM parameters are reduced to `DeployControlBundleS3Uri`, `DeployControlBundleSha256`, and the masked `DriverAppDownloadUrl` exception only;
- the host downloads with `aws s3 cp`, computes SHA-256 locally, and fails closed on mismatch;
- S3 ETag is never used for integrity;
- the host verifies the exact tar manifest and rejects non-regular tar members such as symlinks or hardlinks before extraction;
- the custom SSM document validates manifest keys, file allowlist, path safety, extracted regular-file types, S3 URI, dry-run flag, SHA/tag/image patterns, and publish evidence URL inline before executing any code from the downloaded bundle;
- dry-run mode exits after S3 download, SHA-256 verification, and inline manifest validation, before persistent host writes, file sync, or deployment;
- non-dry-run mode creates `.deploy/source-backups/<image-tag>-<github-run-id>-<timestamp>/`, syncs only the inline allowlisted files, syntax-checks shell scripts, then invokes `scripts/ssm-route-ops-deploy.sh`.
- `scripts/validate-route-ops-release.mjs` statically checks that the helper allowlist, inline SSM allowlist, tar entry set, and manifest key set stay synchronized with the canonical deploy-control contract.

### Bucket setup and lifecycle commands

Do not run these as part of normal deploy. They are one-time setup/reconciliation commands for an approved operator if the bucket or lifecycle is missing:

```bash
aws sts get-caller-identity
aws s3 ls
aws s3api head-bucket --bucket route-ops-artifacts-902837199612-ap-northeast-2
aws s3api create-bucket \
  --bucket route-ops-artifacts-902837199612-ap-northeast-2 \
  --region ap-northeast-2 \
  --create-bucket-configuration LocationConstraint=ap-northeast-2
aws s3api put-public-access-block \
  --bucket route-ops-artifacts-902837199612-ap-northeast-2 \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-encryption \
  --bucket route-ops-artifacts-902837199612-ap-northeast-2 \
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
cat > /tmp/route-ops-deploy-control-lifecycle.json <<'JSON'
{
  "Rules": [
    {
      "ID": "expire-route-ops-deploy-control-after-90-days",
      "Status": "Enabled",
      "Filter": { "Prefix": "artifacts/route-ops/prod/deploy-control/" },
      "Expiration": { "Days": 90 },
      "NoncurrentVersionExpiration": { "NoncurrentDays": 30 },
      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 7 }
    }
  ]
}
JSON
aws s3api put-bucket-lifecycle-configuration \
  --bucket route-ops-artifacts-902837199612-ap-northeast-2 \
  --lifecycle-configuration file:///tmp/route-ops-deploy-control-lifecycle.json
```

### Dry validation command

The first run after changing this flow must be a no-mutation dry validation. Prefer the consolidated release workflow prepare mode:

```bash
gh workflow run route-ops-release.yml \
  --ref main \
  -f mode=prepare \
  -f deployed_base_ref=<current-production-git-sha>
```

Dry validation must show: selected bucket/key, bundle byte size, expected and actual SHA-256, reduced SSM parameter sizes, deploy-control source checkout pinned to the image tag, source regular-file validation before staging, successful S3 upload, successful host S3 download, inline manifest validation result, and `no production files synced and no deploy script executed`. In the consolidated lane, the prepare run must also publish a `route-ops-release-manifest` artifact whose `manifestSha256` is the only promote handoff.

### Production retry gate

A production retry (`dry_run=false`) or release `mode=promote` remains blocked until all of these are true:

1. this PR is merged and the reviewed custom SSM document version is updated/pinned in `SSM_ROUTE_OPS_DOCUMENT_VERSION`;
2. GitHub deploy role has only the prefix-scoped S3 write permissions documented below;
3. the EC2/SSM execution role has only the prefix-scoped S3 read permissions documented below;
4. release `mode=prepare` succeeds with the same bucket/prefix/document path and without Caddy reconcile or any other production mutation;
5. an operator explicitly approves the production mutation;
6. for the consolidated release workflow, the operator supplies only `release_run_id` and `release_manifest_sha256` to promote the previously reviewed prepare manifest.

## GitHub variables

Use GitHub repository/org **variables**, not secrets, for non-secret identifiers:

```text
DEPLOY_ALLOWED_ACTORS=github-user-1,github-user-2
AWS_ROUTE_OPS_DEPLOY_ROLE_ARN=arn:aws:iam::<account-id>:role/<role-name>
AWS_REGION=ap-northeast-2
SSM_ROUTE_OPS_TARGET_TAG_KEY=Service
SSM_ROUTE_OPS_TARGET_TAG_VALUE=clever-delivery-server
SSM_ROUTE_OPS_DOCUMENT_NAME=CleverRoute-RouteOpsDeploy
SSM_ROUTE_OPS_DOCUMENT_VERSION=<pinned-reviewed-version>
```

Do not add production secrets to GitHub except the masked `DRIVER_APP_DOWNLOAD_URL` repository secret used to hand the driver APK location into the reviewed SSM document parameter file. The workflow must never echo that value; the custom SSM document exports it as `ROUTE_OPS_DRIVER_APP_DOWNLOAD_URL`, and `scripts/deploy-route-ops-image.sh` writes it to host env with redacted logs before restarting the delivery API. The smoke login secret is read on the host by `scripts/ssm-route-ops-deploy.sh` from `infra/env/delivery-api.env` or, in a future hardening step, by the instance role from AWS secure storage.

## OIDC trust boundary

Phase 1 uses the explicit OIDC trust boundary supported by GitHub/AWS:

```text
repo:EVNSolution/clever-route-server:ref:refs/heads/main
```

Do not claim workflow-path pinning unless a customized `sub` claim is configured and tested. Compensating controls are required:

- only `.github/workflows/route-ops-release.yml` may reference `AWS_ROUTE_OPS_DEPLOY_ROLE_ARN`;
- CI workflows must not request `id-token: write` for this deploy role, and release workflow image-publish jobs must stay separate from OIDC deploy jobs;
- branch protection/CODEOWNERS must cover workflow, deploy scripts, SSM docs, and deployment docs;
- deploy actor allowlist must fail closed before `aws-actions/configure-aws-credentials`.

Example trust policy skeleton, with account/provider values filled in AWS only:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::<account-id>:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": "repo:EVNSolution/clever-route-server:ref:refs/heads/main"
        }
      }
    }
  ]
}
```

## Deploy role policy shape

The GitHub deploy role should primarily invoke the reviewed custom document against the production managed node target and write the deploy-control artifact to only the approved Route Ops S3 prefix. Do not grant broad EC2/IAM/Secrets permissions. Deploy-control source sync is part of the reviewed custom document, not a generic `AWS-RunShellScript` send. `AWS-RunShellScript` use, if granted at all, is restricted to the optional fixed Caddy ingress reconcile when `ROUTE_OPS_RECONCILE_INGRESS_WITH_AWS_RUNSHELLSCRIPT=true`. Do not use it for image deploy, rollback, source sync, secrets, database mutation outside the reviewed wrapper, or arbitrary operator shell.

GitHub deploy role minimum S3 permission:

```json
{
  "Sid": "WriteRouteOpsDeployControlArtifacts",
  "Effect": "Allow",
  "Action": ["s3:PutObject"],
  "Resource": "arn:aws:s3:::route-ops-artifacts-902837199612-ap-northeast-2/artifacts/route-ops/prod/deploy-control/*",
  "Condition": {
    "StringEquals": {
      "s3:x-amz-server-side-encryption": "AES256"
    }
  }
}
```

If the deploy role also performs explicit bucket metadata checks, add only the minimal required bucket metadata actions and constrain them to `arn:aws:s3:::route-ops-artifacts-902837199612-ap-northeast-2`. Do not grant whole-bucket write outside `artifacts/route-ops/prod/deploy-control/*`.

SSM/EC2 execution role minimum S3 permission:

```json
{
  "Sid": "ReadRouteOpsDeployControlArtifacts",
  "Effect": "Allow",
  "Action": ["s3:GetObject"],
  "Resource": "arn:aws:s3:::route-ops-artifacts-902837199612-ap-northeast-2/artifacts/route-ops/prod/deploy-control/*"
}
```

`ListBucket` is not needed for the current `aws s3 cp s3://bucket/key file` path. If future diagnostics require listing, constrain it to the prefix condition:

```json
{
  "Sid": "ListOnlyRouteOpsDeployControlPrefix",
  "Effect": "Allow",
  "Action": "s3:ListBucket",
  "Resource": "arn:aws:s3:::route-ops-artifacts-902837199612-ap-northeast-2",
  "Condition": {
    "StringLike": {
      "s3:prefix": "artifacts/route-ops/prod/deploy-control/*"
    }
  }
}
```

The existing SSM permissions still need the reviewed document and exact production instance target:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SendOnlyRouteOpsDeployDocument",
      "Effect": "Allow",
      "Action": "ssm:SendCommand",
      "Resource": [
        "arn:aws:ssm:ap-northeast-2:902837199612:document/CleverRoute-RouteOpsDeploy",
        "arn:aws:ec2:ap-northeast-2:902837199612:instance/<production-instance-id>"
      ],
      "Condition": {
        "StringEquals": {
          "ssm:resourceTag/Service": "clever-delivery-server"
        }
      }
    },
    {
      "Sid": "PollOwnCommand",
      "Effect": "Allow",
      "Action": [
        "ssm:GetCommandInvocation",
        "ssm:ListCommandInvocations",
        "ssm:ListCommands",
        "ssm:DescribeInstanceInformation"
      ],
      "Resource": "*"
    }
  ]
}
```

Add `arn:aws:ssm:ap-northeast-2:902837199612:document/AWS-RunShellScript` only if the optional fixed Caddy ingress reconcile path is deliberately enabled and reviewed.

AWS resource-level support differs by Systems Manager API and target style. If a specific condition/resource is not enforceable in your AWS account, document that residual risk and keep the compensating controls: custom document for deploy/source sync, optional fixed ingress reconcile command, exact target-count preflight, `max-concurrency=1`, `max-errors=0`, dry-run first, and branch/CODEOWNERS controls.

## Custom SSM document

Production image deploy must use the reviewed custom SSM document stored in `infra/ssm/route-ops-deploy-document.json`. `AWS-RunShellScript` is not the image deploy or source-sync path; the only optional production workflow exception is the fixed Route Ops Caddy ingress reconcile command that force-recreates the already-reviewed `caddy` service from this repo before smoke.

Use schema 2.2 and `interpolationType: ENV_VAR`. The custom document accepts only the deploy-control bundle pointer and digest; image tag, schema SHA, runtime/migrate images, publish evidence, and dry-run state are validated from the non-secret manifest after S3 download and SHA-256 verification.

Example document skeleton:

```yaml
schemaVersion: '2.2'
description: Clever Route Ops pinned image deploy via S3 deploy-control bundle
parameters:
  DeployControlBundleS3Uri:
    type: String
    interpolationType: ENV_VAR
    allowedPattern: '^s3://route-ops-artifacts-902837199612-ap-northeast-2/artifacts/route-ops/prod/deploy-control/[0-9]+/[0-9a-fA-F]{40}/route-ops-deploy-control\.tar\.gz$'
    maxChars: 256
  DeployControlBundleSha256:
    type: String
    interpolationType: ENV_VAR
    allowedPattern: '^[0-9a-fA-F]{64}$'
    maxChars: 64
mainSteps:
  - action: aws:runShellScript
    name: routeOpsDeploy
    inputs:
      timeoutSeconds: '7200'
      runCommand:
        - 'set -eu'
        - 'cd /srv/clever-route-server'
        - 'aws s3 cp "$SSM_DeployControlBundleS3Uri" "$bundle_path" --no-progress'
        - '<compute local sha256 and compare to SSM_DeployControlBundleSha256; fail closed on mismatch>'
        - '<verify exact tar manifest and reject non-regular tar members before extraction>'
        - '<inline validate deploy-control-manifest.json allowlist and dryRun flag; do not execute bundled helper before validation>'
        - '<if dryRun=true: log no-mutation success and exit>'
        - '<sync allowlisted deploy-control files, syntax-check scripts, then run scripts/ssm-route-ops-deploy.sh with manifest-derived env>'
```

Pin the reviewed `DocumentVersion` in GitHub variable `SSM_ROUTE_OPS_DOCUMENT_VERSION` and update it deliberately when the document changes.

## Host wrapper

`scripts/ssm-route-ops-deploy.sh` runs on the EC2 host. It:

- validates image tag/schema/image coordinates again, including the `route-ops-web-static` frontend artifact image and SHA-scoped Docker volume derived from the immutable git SHA;
- derives frontend static artifact metadata and validates optional legacy
  `ROUTE_ENGINE_IMAGE` only when provided;
- exports `ROUTE_OPS_COMPOSE_PROJECT_NAME=clever-route` by default and all production compose calls use `docker compose -p "$ROUTE_OPS_COMPOSE_PROJECT_NAME"`; the top-level compose `name:` is defense in depth, not the primary selector;
- takes an exclusive `.deploy/route-ops-deploy.lock` lock before `.deploy/*` mutation;
- reads `CLEVER_ADMIN_WEB_LOGIN_SECRET` locally from `infra/env/delivery-api.env` if `ROUTE_OPS_SMOKE_LOGIN_SECRET` is not already set by a host-local secure source;
- never prints the secret;
- writes non-secret deploy trace artifacts under
  `.deploy/traces/<github-run-id-or-manual-id>-<image-tag>/` before service
  mutation. The required files are `state.jsonl` for step start/end/fail events,
  `deploy.log` for point-in-time snapshots, `ssm-wrapper.log` for host wrapper
  stdout/stderr, and `route_engine_smoke.monitor.log` while route_engine warmup
  or solve smoke is running. These files are intentionally host-local so they
  survive SSM output truncation, GitHub job timeout, and partial deploy failure;
- calls `scripts/deploy-route-ops-image.sh`, which stages the
  `route-ops-web-static` artifact, runs guarded migration/backfill, activates
  OSRM and VROOM only when `VROOM_BASE_URL` is configured, activates legacy
  route_engine only when `ROUTE_ENGINE_BASE_URL` is configured, and only then
  recreates `delivery-api` to switch mounts;
- treats `EXIT`, `INT`, and `TERM` as cleanup paths: if the deploy is interrupted
  before `delivery-api` promotion, the wrapper restores the pre-deploy host env
  and stops a candidate `route-engine` service that was already started;
- records non-secret `PUBLISH_EVIDENCE_URL` to `.deploy/deploy-evidence.jsonl` after a successful deploy.

`deploy-route-ops-image.sh` and `rollback-route-ops-image.sh` also acquire the same lock unless a wrapper already holds it. This keeps emergency Session Manager commands from racing the workflow path.

The host deploy/rollback scripts now fail closed before any service mutation when:

- `ROUTE_OPS_COMPOSE_PROJECT_NAME` is anything other than exactly `clever-route`;
- a legacy implicit Route Ops container is still running under `com.docker.compose.project=compose` for `caddy`, `delivery-api`, `delivery-api-migrate`, `postgres`, `osrm-ontario`, or `route-engine`.

This means normal image deploys must wait until the one-time compose-project migration/cutover has completed. Do not bypass this guard with environment overrides.

## Compose project isolation and migration guard

Route Ops production must not run under Docker Compose's implicit/default `compose` project. The canonical project is:

```text
ROUTE_OPS_COMPOSE_PROJECT_NAME=clever-route
```

Every Route Ops deploy, rollback, Caddy reconcile, and OSRM compose command must use:

```bash
docker compose -p "$ROUTE_OPS_COMPOSE_PROJECT_NAME" --env-file .deploy/current-image.env -f infra/compose/docker-compose.prod.yml config --quiet
```

The compose file also declares `name: ${ROUTE_OPS_COMPOSE_PROJECT_NAME:-clever-route}` so ad-hoc `config` output is self-documenting, but scripts must still pass `-p`. `COMPOSE_PROJECT_NAME` is exported only as a secondary guard.

### Read-only preflight before any production migration

Run through SSM Session Manager/Run Command and keep output redacted:

```bash
cd /srv/clever-route-server
docker compose ls
docker ps -a --format '{{.Names}}|{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.service"}}|{{.Label "com.docker.compose.project.config_files"}}|{{.Image}}|{{.Status}}|{{.Ports}}'
docker inspect compose-caddy-1 compose-delivery-api-1 compose-postgres-1 clever-route-caddy-1 clever-route-delivery-api-1 clever-route-postgres-1 \
  --format '{{.Name}}|{{json .Config.Labels}}|{{json .Mounts}}' 2>/dev/null || true
docker ps -a --filter name=osrm --format '{{.Names}}|{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.service"}}|{{.Status}}|{{.Ports}}'
find /srv/clever-route-server/data/route-engine/parquet -maxdepth 1 -type f -name '*.parquet' -printf '%f\n' 2>/dev/null | sort
curl -fsS https://clever-route.cleversystem.ai/healthz
```

Before any stop/start, prove:

- exactly which Caddy owns 80/443 and that it uses this repo's `infra/caddy/Caddyfile`;
- the active delivery-api image revision matches `.deploy/current-image.env`;
- the active Postgres data root is `/srv/clever-route-server/data/postgres`;
- duplicate Postgres containers, if present, do not point at different data roots;
- OSRM port `127.0.0.1:5000` is free or owned by the Route Ops OSRM container that will be cut over.
- `route_engine` graph parquet artifacts are present under
  `/srv/clever-route-server/data/route-engine/parquet`, are not Git LFS pointer
  files, and match the `org.clever-route.graph-manifest-sha` label on the
  pinned worker image before `route-engine` is started.

Stop and escalate if the active Route Ops DB bind mount cannot be proven. Do not run project-wide `docker compose -p compose down`, `docker system prune -a`, `docker volume prune`, or `docker container prune`.

### Controlled cutover order

This cutover is a separate production action, not part of repo-side implementation tests.

1. Acquire `.deploy/route-ops-deploy.lock`.
2. Preserve or intentionally reissue Caddy cert storage before changing the serving Caddy:
   - preferred: copy/attach the existing Route Ops Caddy data/config volume to the `clever-route` project;
   - fallback: document intentional reissue only after DNS points to this host and ports are free.
3. Stop only verified old Route Ops containers by exact name plus labels, not the shared `compose` project:
   - stop `compose-caddy-1` first to free 80/443;
   - stop `compose-delivery-api-1` and any old Route Ops `delivery-api-migrate` one-off to prevent old/new DB writer overlap;
   - stop `compose-postgres-1` only after proving it is the active Route Ops Postgres with service label `postgres`, this repo compose config label, and the verified bind mount;
   - stop `compose-osrm-ontario-1` first if OSRM is enabled because it owns `127.0.0.1:5000`;
   - do not stop unrelated containers such as `compose-shopify-app-1`.
4. Hard rule: old and new Route Ops Postgres containers must never run concurrently against the same verified bind mount.
5. Start the coherent unit under `clever-route`:

```bash
export ROUTE_OPS_COMPOSE_PROJECT_NAME=clever-route
docker compose -p "$ROUTE_OPS_COMPOSE_PROJECT_NAME" --env-file .deploy/current-image.env -f infra/compose/docker-compose.prod.yml up -d --no-build postgres
docker compose -p "$ROUTE_OPS_COMPOSE_PROJECT_NAME" --env-file .deploy/current-image.env -f infra/compose/docker-compose.prod.yml run --rm delivery-api-migrate
docker compose -p "$ROUTE_OPS_COMPOSE_PROJECT_NAME" --env-file .deploy/current-image.env -f infra/compose/docker-compose.prod.yml --profile route-engine up -d --no-build route-engine
docker compose -p "$ROUTE_OPS_COMPOSE_PROJECT_NAME" --env-file .deploy/current-image.env -f infra/compose/docker-compose.prod.yml up -d --no-build delivery-api caddy
```

If OSRM is enabled, include `--profile osrm up -d osrm-ontario` only after the old OSRM service has released port 5000. Otherwise keep OSRM disabled and verify the app fails closed for route geometry.
If `route_engine` graph data cannot be proven, do not start `route-engine` and
do not restart `delivery-api` with `ROUTE_ENGINE_BASE_URL` enabled.

### Caddy certificate volume handoff

Docker Compose volume names are project-scoped. For the current implicit project, Caddy volumes are expected to be:

```text
compose_caddy-data
compose_caddy-config
```

For the new Route Ops project, the expected names are:

```text
clever-route_caddy-data
clever-route_caddy-config
```

Confirm the real source volumes before copying:

```bash
docker inspect compose-caddy-1 --format '{{range .Mounts}}{{.Name}} -> {{.Destination}}{{"\n"}}{{end}}'
docker volume inspect compose_caddy-data compose_caddy-config >/dev/null
docker volume create clever-route_caddy-data
docker volume create clever-route_caddy-config
docker run --rm -v compose_caddy-data:/from:ro -v clever-route_caddy-data:/to alpine sh -c 'cp -a /from/. /to/'
docker run --rm -v compose_caddy-config:/from:ro -v clever-route_caddy-config:/to alpine sh -c 'cp -a /from/. /to/'
docker run --rm -v clever-route_caddy-data:/data:ro alpine sh -c 'test -d /data/caddy || test -d /data'
```

Do not print certificate material. If either source volume cannot be verified, do not copy guessed volumes. Use the documented intentional reissue fallback only after confirming DNS and rate-limit risk.

### Post-cutover smoke and cleanup gate

Before cleanup, verify:

- exactly one Caddy binds 80/443 and its project label is `clever-route`;
- `/healthz` returns ok;
- unauthenticated `/admin/ui/app/drivers?shopDomain=dev1.tomatonofood.com` redirects to `/admin/ui/login`;
- authenticated smoke passes for `/admin/ui/app`, `/admin/ui/app/orders`, `/admin/ui/app/drivers`, `/admin/ui/app/api/bootstrap`, `/admin/ui/app/api/drivers`, vendor assets, CSP/map config;
- OSRM road geometry works when enabled or returns null/empty geometry on failure; no fake straight line.
- `route_engine` smoke from the `delivery-api` runtime network reaches
  `http://route-engine:8080/readyz`, posts authenticated `POST /internal/warmup`
  to build the road graph V8 router cache, then posts a non-customer
  `POST /v1/solve` request with two smoke stops and verifies `status=solved`,
  `engine.name=route_engine`, `external_calls=false`, and positive
  distance/duration. The readiness fetch timeout defaults to 5 seconds per
  attempt, the warmup timeout defaults to 600 seconds, and the solve smoke
  timeout defaults to 180 seconds plus a 5-second response guard. Override only
  with `ROUTE_ENGINE_READY_SMOKE_TIMEOUT_MS`,
  `ROUTE_ENGINE_WARMUP_SMOKE_TIMEOUT_MS`, or
  `ROUTE_ENGINE_SOLVE_SMOKE_TIMEOUT_MS` when a reviewed production incident
  requires it.

If this smoke fails, do not rely on the final SSM summary alone. First inspect
the latest host trace directory:

```bash
cd /srv/clever-route-server
latest_trace="$(find .deploy/traces -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -n | tail -1 | cut -d' ' -f2-)"
tail -n 80 "$latest_trace/state.jsonl"
tail -n 200 "$latest_trace/route_engine_smoke.monitor.log"
tail -n 200 "$latest_trace/deploy.log"
```

The trace must distinguish:

- GitHub workflow timeout: no terminal SSM status before the Actions poll budget;
- SSM document timeout: SSM command failed/timed out while host trace still shows
  the last active step;
- route_engine warmup timeout: `state.jsonl` shows `ensure_route_engine` and the
  monitor log shows the route-engine container/cache/resource state during the
  warmup interval;
- app smoke failure after promotion candidate startup: `state.jsonl` advances
  past `restart_delivery_api` and then fails in `production_smoke`.

Cleanup after successful smoke is removal of already-stopped old Route Ops containers by exact name/label allowlist only. Do not remove volumes or bind-mounted data.

### Rollback during migration

If smoke fails before cleanup after new Postgres started:

1. stop the newly created `clever-route` Caddy/app/Postgres as needed;
2. restart the prior verified old Postgres first;
3. restart the old delivery-api;
4. restart the old Caddy;
5. preserve `.deploy/current-image.env` and record the failure.

After cleanup has succeeded, rollback stays within the `clever-route` project using `.deploy/previous-image.env`; it must not resurrect implicit `compose` Route Ops containers.

## Host disk and image retention guard

`deploy-route-ops-image.sh` owns the production Docker image retention guard so normal SSM deploys do not depend on manual host cleanup.

Before `docker compose --profile route-engine pull route-ops-web-static delivery-api delivery-api-migrate route-engine`, the script checks `/` and Docker's root directory from `docker info --format '{{.DockerRootDir}}'`. The defaults are:

```text
ROUTE_OPS_DEPLOY_MIN_FREE_MB=4096
ROUTE_OPS_DEPLOY_MIN_FREE_PERCENT=20
```

The script always prunes stale Route Ops images before pulling a new image, then checks disk again after cleanup and after pull. If either threshold is not met after cleanup, the deploy fails before promotion and prints a disk summary.

The retention cleanup is intentionally narrow. It keeps current, previous, candidate, and active images:

- images referenced by `.deploy/current-image.env`;
- images referenced by `.deploy/previous-image.env`;
- images referenced by `.deploy/candidate-image.env` and the current deploy inputs;
- images currently used by running containers;
- extra tags listed in `ROUTE_OPS_IMAGE_KEEP_TAGS`.

It may remove only old SHA-tagged images from:

```text
ghcr.io/evnsolution/clever-route-server-delivery-api:<sha>
ghcr.io/evnsolution/clever-route-server-delivery-api-migrate:<sha>
ghcr.io/evnsolution/clever-route-server-route-ops-web-static:<sha>
ghcr.io/evnsolution/route-engine-worker:<sha>
```

The cleanup must not run `docker system prune`, `docker volume prune`, or `docker container prune`; it removes explicit stale Route Ops image refs only. Static artifacts use SHA-scoped named volumes (`ROUTE_OPS_WEB_STATIC_VOLUME`) so staging a candidate frontend does not mutate the volume currently mounted by the running backend. A post-promote cleanup runs after smoke succeeds so the host keeps the current image and one previous rollback image by default.

Optional host-side knobs:

```text
ROUTE_OPS_IMAGE_KEEP_TAGS=<space-or-comma-separated extra SHA tags or image refs>
ROUTE_OPS_IMAGE_PRUNE_DRY_RUN=1
ROUTE_OPS_PRUNE_LEGACY_LOCAL_IMAGE=1
```

## Operator flow

Primary release lane:

1. Run `Route Ops release` on `main` with `mode=prepare`.
2. Confirm the redacted prepare summary, no-mutation SSM dry validation, and `route-ops-release-manifest` artifact.
   The manifest artifact is retained for 14 days; after expiry, run a fresh prepare instead of promoting stale coordinates.
3. Run `Route Ops release` on `main` with `mode=promote`, passing only `release_run_id` and `release_manifest_sha256`.
4. The promote workflow verifies the prepare run/artifact/digest, checks out the exact manifest commit, regenerates the bundle with `dryRun=false`, and invokes the same constrained SSM document.
5. If smoke fails, the deploy script restores current image metadata and the workflow fails.

Fallback split lane:

1. Run `Route Ops image publish` on `main`.
2. Confirm the redacted publish summary:
   - image tag;
   - schema SHA;
   - runtime/migrate image names;
   - successful workflow run URL.
3. Run `Route Ops SSM deploy` with those exact values and `dry_run=true` first.
4. The workflow verifies:
   - actor allowlist;
   - branch;
   - image tag reachable from `origin/main`;
   - deploy-control source checkout pinned to the image tag commit;
   - publish evidence URL;
   - S3 artifact upload to the approved Route Ops deploy-control prefix;
   - reduced SSM parameter sizes;
   - custom SSM document name/version;
   - exactly one online managed target.
5. In dry-run mode the host downloads the S3 bundle, verifies SHA-256, validates
   the manifest allowlist inline, and exits before persistent host writes, source
   sync, or deployment.
6. After dry validation passes and production mutation is separately approved,
   rerun with `dry_run=false`.
7. The host deploy script verifies labels/schema, verifies the mounted
   optimizer service state only when enabled, then runs the candidate migrate image through
   `apps/delivery-api/scripts/guard-prisma-db-push.sh`. The guard recomputes
   `apps/delivery-api/prisma/schema.prisma`, requires it to match the manifest
   `PRISMA_SCHEMA_SHA`, and does not pass `--accept-data-loss`; a missing or
   mismatched schema SHA fails before Prisma can run `db push`. After that it
   smokes VROOM/legacy route_engine only when configured and runs Route Ops smoke
   before promotion.
8. If smoke fails, the deploy script restores current image metadata and the workflow fails.

## Rollback

Rollback remains host-side through SSM Session Manager or a future separate rollback workflow:

```bash
cd /srv/clever-route-server
export ROUTE_OPS_SMOKE_LOGIN_SECRET=<read locally; never paste into GitHub or SSM parameters>
scripts/rollback-route-ops-image.sh
```

The rollback script uses `.deploy/previous-image.env`, checks schema
compatibility, verifies any enabled optimizer before activation, runs smoke
before promotion, and restores pre-rollback current metadata on failure. During
the first static-artifact cutover, rollback normalizes legacy
`.deploy/current-image.env` or `.deploy/previous-image.env` files that lack
`ROUTE_OPS_WEB_STATIC_IMAGE` or `ROUTE_OPS_WEB_STATIC_VOLUME` by deriving the
SHA-scoped defaults before backend service mutation. If that derivation cannot be
proven, rollback fails closed.

## Public SSH inbound policy

Normal deploy does not require public SSH inbound or an operator IP allowlist. Before closing existing SSH ingress, verify:

1. SSM Agent is online and version `3.3.2746.0` or later.
2. Session Manager shell works for an authorized operator.
3. A read-only/no-op SSM preflight works.
4. The custom deploy document exists with reviewed parameter patterns.

Any SSH break-glass path is outside normal deploy and must be time-boxed, logged, and closed after use.

## Billing controls

The deploy workflow is cheap by design:

- no Docker build;
- no package push;
- manual-only;
- 120-minute workflow timeout with a 2-hour custom SSM document timeout, because
  optimizer and map-service startup can be much longer than a normal web image
  swap and must fail with trace evidence rather than truncated SSM output;
- no scheduled/nightly runs;
- no large artifacts.

If GitHub Actions quota is exhausted, do not weaken guards. Use Session Manager emergency runbook only after separate approval.

## Frontend static artifact handoff

The SSM path deploys three immutable images for the same clever-route-server git
SHA: runtime, migrate, and `route-ops-web-static`. The host wrapper exports
`ROUTE_OPS_WEB_STATIC_IMAGE=ghcr.io/evnsolution/clever-route-server-route-ops-web-static:<ImageTag>`
and `ROUTE_OPS_WEB_STATIC_VOLUME=clever-route-route-ops-web-static-<ImageTag>`
when the command does not pass them explicitly. The deploy script writes those
values to `.deploy/candidate-image.env`, pulls the core images plus only
configured optimizer support images, runs the one-shot `route-ops-web-static`
compose service against the candidate SHA-scoped volume, starts OSRM/VROOM only
when `VROOM_BASE_URL` is configured, starts legacy route_engine only when
`ROUTE_ENGINE_BASE_URL` is configured, and only then recreates `delivery-api` to
mount the new static volume. This preserves the backend-authenticated
`/admin/ui/app/*` shell while keeping frontend static artifact and optimizer
runtime separately identifiable.

## Route Engine production graph contract

`route_engine` intentionally keeps large graph/cache artifacts out of the worker
image layer. Production readiness therefore requires a host-local read-only
mount:

```text
ROUTE_ENGINE_GRAPH_HOST_DIR=/srv/clever-route-server/data/route-engine/graphs/current/parquet
/app/routing_engine/v7_out/parquet:ro
```

The deploy and rollback scripts first call
`scripts/provision-route-engine-graph-from-s3.sh` when the expected graph
manifest is absent or mismatched locally. They then fail closed before
`delivery-api` activation if:

- the directory is missing;
- no `*.parquet` files are present;
- any parquet file is still a Git LFS pointer;
- the normalized host manifest does not match the worker image label
  `org.clever-route.graph-manifest-sha`.

On compatibility activation, `deploy-route-ops-image.sh` starts the internal
`route-engine` service through `--profile route-engine` only when
`ROUTE_ENGINE_BASE_URL` is already configured and `ROUTE_ENGINE_IMAGE` is
explicit. It no longer fills missing `ROUTE_ENGINE_*` values or auto-enables
route_engine.

The graph smoke is non-customer: it calls `/readyz`, authenticated
`POST /internal/warmup`, and `POST /v1/solve` with a fixed Toronto-area two-stop
payload, expects `external_calls=false`, and verifies positive route
distance/duration before the public Route Ops smoke runs. A smoke timeout is a
failed deploy, not a degraded success; do not retry production until the host env
and `route-engine` service state have been checked against the currently
promoted `.deploy/current-image.env`.

During this smoke, `route_engine_smoke.monitor.log` records the route-engine
container status, Docker stats, cache volume size/file listing, and recent
route_engine logs at `ROUTE_ENGINE_TRACE_MONITOR_INTERVAL_SECONDS` intervals
(default 30 seconds). If `/internal/warmup` blocks longer than expected, this log
is the primary evidence for whether cache files are growing, CPU/memory are
active, or the container stopped/OOM-killed.
