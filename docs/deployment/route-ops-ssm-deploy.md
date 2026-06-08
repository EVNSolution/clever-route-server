# Route Ops GitHub OIDC + AWS SSM deploy

This is the approved next step after the publish-only GHCR model. It keeps normal deployment out of operator laptops:

```text
GitHub Actions workflow_dispatch
→ GitHub OIDC temporary AWS credentials
→ AWS Systems Manager Run Command
→ custom Route Ops deploy document
→ host-local deploy wrapper
→ existing deploy script smoke-before-promote
```

Production execution is **not automatic**. The workflow exists so a maintainer can intentionally run a deploy after reviewing the image publish. The implementation must not store PEM keys, long-lived AWS keys, admin smoke secrets, runtime `.env`, database credentials, cookies, or production secrets in GitHub.

## Workflow controls

`.github/workflows/route-ops-ssm-deploy.yml` is intentionally narrow:

- `workflow_dispatch` only; no `push`, PR, schedule, or workflow_run production deploy.
- `refs/heads/main` only.
- `DEPLOY_ALLOWED_ACTORS` is required and fail-closed before AWS credentials are requested.
- `permissions: contents: read`, `actions: read`, and `id-token: write` only. `actions: read` is used only to verify the publish workflow run evidence before AWS credentials are requested.
- No `packages: write`; this workflow does not build or push images.
- Inputs must be immutable publish coordinates:
  - `image_tag`: 40-hex git SHA.
  - `prisma_schema_sha`: 64-hex schema SHA.
  - `delivery_api_image`: `ghcr.io/evnsolution/clever-route-server-delivery-api:<sha>`.
  - `delivery_api_migrate_image`: `ghcr.io/evnsolution/clever-route-server-delivery-api-migrate:<sha>`.
  - `publish_evidence_url`: successful Route Ops publish run URL.
- `route_engine` is not built by this repository's publish workflow. The host
  wrapper derives the pinned worker image
  `ROUTE_ENGINE_IMAGE=ghcr.io/evnsolution/route-engine-worker:f65a1402ec24bef24b7975f0a7f0d320e5773bc0`
  and the required graph mount
  `ROUTE_ENGINE_GRAPH_HOST_DIR=/srv/clever-route-server/data/route-engine/parquet`
  unless an operator deliberately overrides them from a host-local source.
- The image tag must be reachable from `origin/main`.
- The publish run URL is machine-verified through the GitHub Actions API: repository, workflow, event, conclusion, branch, and SHA must match.
- The deploy target tag must resolve to exactly one managed node total, that node must be `Online`, and SSM Agent must be version `3.3.2746.0` or later for `ENV_VAR` interpolation support.
- The workflow sends the command to the resolved instance ID, not back to a mutable tag selector.
- SSM uses `max-concurrency=1` and `max-errors=0`, and the workflow asserts `Command.TargetCount == 1`.
- Before the custom deploy document runs the image activation wrapper, the workflow prepares a small reviewed deploy-control bundle and passes it to the same custom SSM document. The host verifies and extracts that bundle inside the custom document before deploy. This keeps the host wrapper, compose file, smoke script, and Caddy config aligned with the image being activated without turning the host directory into a mutable Git checkout or granting `AWS-RunShellScript` as a general source-sync path.
- If `ROUTE_OPS_RECONCILE_INGRESS_WITH_AWS_RUNSHELLSCRIPT=true` is deliberately enabled and IAM allows it, the workflow reconciles the Route Ops Caddy ingress on the same resolved instance ID with a fixed no-secret command that force-recreates only the `caddy` service from `/srv/clever-route-server/infra/caddy/Caddyfile`.
- Logs are redacted status summaries only; command parameters contain no production secrets.

## Deploy-control source sync

The production host currently keeps `/srv/clever-route-server` as a deploy directory, not a live Git checkout. The deploy workflow therefore prepares a narrow source bundle, and the custom SSM deploy document syncs that bundle before invoking the host wrapper so repo-reviewed deploy controls match the image being activated.

This source sync does **not** add S3, a new EC2 instance, EBS expansion, GitHub secrets, runtime `.env`, Parameter Store payloads, database credentials, or broad `AWS-RunShellScript` permission. It uses the same GitHub OIDC → custom AWS SSM Run Command path and an inline, deterministic tarball containing only these allowlisted files:

```text
infra/caddy/Caddyfile
infra/compose/docker-compose.prod.yml
scripts/deploy-route-ops-image.sh
scripts/rollback-route-ops-image.sh
scripts/ssm-route-ops-deploy.sh
scripts/smoke-route-ops-production.mjs
```

Guardrails:

- secret-like paths are rejected before bundling and again on the host (`*.env`, `*.env.*`, `*secret*`, `*token*`, `*cookie*`, `*storageState*`);
- the bundle is deterministic and SHA-256 verified on the host before extraction;
- the host verifies the exact tar manifest before copying files;
- the inline bundle is capped at 60KB and its base64 form is capped at 20KB for the custom document parameter;
- existing host files are backed up under `.deploy/source-backups/<image-tag>-<github-run-id>-<timestamp>/` before replacement;
- shell deploy scripts must pass `bash -n` after sync;
- the command is sent only to the resolved instance ID, uses `max-concurrency=1`, `max-errors=0`, and asserts `TargetCount == 1`;
- source prep runs before optional Caddy ingress reconcile, and the custom deploy document syncs the files before image activation.

This keeps the deploy role constrained to reviewed custom documents while allowing the host-local deploy wrapper, compose contract, and smoke test to evolve safely with the repository.

## GitHub variables

Use GitHub repository/org **variables**, not secrets, for non-secret identifiers:

```text
DEPLOY_ALLOWED_ACTORS=github-user-1,github-user-2
AWS_ROUTE_OPS_DEPLOY_ROLE_ARN=arn:aws:iam::<account-id>:role/<role-name>
AWS_REGION=ca-central-1
SSM_ROUTE_OPS_TARGET_TAG_KEY=Service
SSM_ROUTE_OPS_TARGET_TAG_VALUE=CleverRouteProduction
SSM_ROUTE_OPS_DOCUMENT_NAME=CleverRoute-RouteOpsDeploy
SSM_ROUTE_OPS_DOCUMENT_VERSION=<pinned-reviewed-version>
```

Do not add production secrets to GitHub. The smoke login secret is read on the host by `scripts/ssm-route-ops-deploy.sh` from `infra/env/delivery-api.env` or, in a future hardening step, by the instance role from AWS secure storage.

## OIDC trust boundary

Phase 1 uses the explicit OIDC trust boundary supported by GitHub/AWS:

```text
repo:EVNSolution/clever-route-server:ref:refs/heads/main
```

Do not claim workflow-path pinning unless a customized `sub` claim is configured and tested. Compensating controls are required:

- only `.github/workflows/route-ops-ssm-deploy.yml` may reference `AWS_ROUTE_OPS_DEPLOY_ROLE_ARN`;
- CI/publish workflows must not request `id-token: write` for this deploy role;
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

The GitHub deploy role should primarily invoke the reviewed custom document against the production managed node target. Do not grant broad EC2/IAM/Secrets permissions. Deploy-control source sync is part of the reviewed custom document, not a generic `AWS-RunShellScript` send. `AWS-RunShellScript` use, if granted at all, is restricted to the optional fixed Caddy ingress reconcile when `ROUTE_OPS_RECONCILE_INGRESS_WITH_AWS_RUNSHELLSCRIPT=true`. Do not use it for image deploy, rollback, source sync, secrets, database mutation outside the reviewed wrapper, or arbitrary operator shell.

Example skeleton:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SendOnlyRouteOpsDeployDocument",
      "Effect": "Allow",
      "Action": "ssm:SendCommand",
      "Resource": [
        "arn:aws:ssm:<region>:<account-id>:document/CleverRoute-RouteOpsDeploy",
        "arn:aws:ec2:<region>:<account-id>:instance/<production-instance-id>"
      ],
      "Condition": {
        "StringEquals": {
          "ssm:resourceTag/Service": "CleverRouteProduction"
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

Add `arn:aws:ssm:<region>:<account-id>:document/AWS-RunShellScript` only if the optional fixed Caddy ingress reconcile path is deliberately enabled and reviewed.

AWS resource-level support differs by Systems Manager API and target style. If a specific condition/resource is not enforceable in your AWS account, document that residual risk and keep the compensating controls: custom document for deploy/source sync, optional fixed ingress reconcile command, exact target-count preflight, `max-concurrency=1`, `max-errors=0`, and branch/CODEOWNERS controls.

## Custom SSM document

Production image deploy must use the reviewed custom SSM document stored in `infra/ssm/route-ops-deploy-document.json`. `AWS-RunShellScript` is not the image deploy or source-sync path; the only optional production workflow exception is the fixed Route Ops Caddy ingress reconcile command that force-recreates the already-reviewed `caddy` service from this repo before smoke.

Use schema 2.2 and prefer `interpolationType: ENV_VAR` so parameters are exposed as environment variables. The host wrapper still validates every value before invoking the deploy script.

Example document skeleton:

```yaml
schemaVersion: '2.2'
description: Clever Route Ops pinned image deploy
parameters:
  ImageTag:
    type: String
    interpolationType: ENV_VAR
    allowedPattern: '^[0-9a-fA-F]{40}$'
  PrismaSchemaSha:
    type: String
    interpolationType: ENV_VAR
    allowedPattern: '^[0-9a-fA-F]{64}$'
  RuntimeImage:
    type: String
    interpolationType: ENV_VAR
    allowedPattern: '^ghcr\.io/evnsolution/clever-route-server-delivery-api:[0-9a-fA-F]{40}$'
  MigrateImage:
    type: String
    interpolationType: ENV_VAR
    allowedPattern: '^ghcr\.io/evnsolution/clever-route-server-delivery-api-migrate:[0-9a-fA-F]{40}$'
  PublishEvidence:
    type: String
    interpolationType: ENV_VAR
    allowedPattern: '^https://github\.com/EVNSolution/clever-route-server/actions/runs/[0-9]+/?$'
  DeployControlBundleBase64:
    type: String
    interpolationType: ENV_VAR
    allowedPattern: '^[A-Za-z0-9+/=]+$'
    maxChars: 20000
  DeployControlBundleSha:
    type: String
    interpolationType: ENV_VAR
    allowedPattern: '^[0-9a-fA-F]{64}$'
  GitHubRunId:
    type: String
    interpolationType: ENV_VAR
    allowedPattern: '^[0-9]+$'
mainSteps:
  - action: aws:runShellScript
    name: routeOpsDeploy
    inputs:
      timeoutSeconds: '900'
      runCommand:
        - 'set -eu'
        - 'cd /srv/clever-route-server'
        - '<verify SHA + exact manifest, back up files under .deploy/source-backups, sync allowlisted deploy controls, bash -n shell scripts>'
        - 'IMAGE_TAG="$SSM_ImageTag" PRISMA_SCHEMA_SHA="$SSM_PrismaSchemaSha" DELIVERY_API_IMAGE="$SSM_RuntimeImage" DELIVERY_API_MIGRATE_IMAGE="$SSM_MigrateImage" PUBLISH_EVIDENCE_URL="$SSM_PublishEvidence" scripts/ssm-route-ops-deploy.sh'
```

Pin the reviewed `DocumentVersion` in GitHub variable `SSM_ROUTE_OPS_DOCUMENT_VERSION` and update it deliberately when the document changes.

## Host wrapper

`scripts/ssm-route-ops-deploy.sh` runs on the EC2 host. It:

- validates image tag/schema/image coordinates again, including the `route-ops-web-static` frontend artifact image and SHA-scoped Docker volume derived from the immutable git SHA;
- derives and validates the pinned `route_engine` worker image and an absolute
  `ROUTE_ENGINE_GRAPH_HOST_DIR`;
- exports `ROUTE_OPS_COMPOSE_PROJECT_NAME=clever-route` by default and all production compose calls use `docker compose -p "$ROUTE_OPS_COMPOSE_PROJECT_NAME"`; the top-level compose `name:` is defense in depth, not the primary selector;
- takes an exclusive `.deploy/route-ops-deploy.lock` lock before `.deploy/*` mutation;
- reads `CLEVER_ADMIN_WEB_LOGIN_SECRET` locally from `infra/env/delivery-api.env` if `ROUTE_OPS_SMOKE_LOGIN_SECRET` is not already set by a host-local secure source;
- never prints the secret;
- calls `scripts/deploy-route-ops-image.sh`, which first backs up host-local
  `infra/env/delivery-api.env`, enables the internal `route_engine` URL/token
  if unset, stages the `route-ops-web-static` artifact into a SHA-scoped named
  volume, validates the mounted `route_engine` graph parquet manifest against
  the worker image label, smokes `route_engine` from a one-off `delivery-api`
  runtime container, and only then recreates `delivery-api` to switch mounts;
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
  `http://route-engine:8080/readyz`, then posts a non-customer
  `POST /v1/solve` request with two smoke stops and verifies `status=solved`,
  `engine.name=route_engine`, `external_calls=false`, and positive
  distance/duration.

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

1. Run `Route Ops image publish` on `main`.
2. Confirm the redacted publish summary:
   - image tag;
   - schema SHA;
   - runtime/migrate image names;
   - successful workflow run URL.
3. Run `Route Ops SSM deploy` with those exact values.
4. The workflow verifies:
   - actor allowlist;
   - branch;
   - image tag reachable from `origin/main`;
   - publish evidence URL;
   - custom SSM document name/version;
   - exactly one online managed target.
5. The host deploy script verifies labels/schema, verifies the mounted
   `route_engine` graph manifest, runs the candidate migrate image, smokes
   `route_engine` from the `delivery-api` runtime network, and runs Route Ops
   smoke before promotion.
6. If smoke fails, the deploy script restores current image metadata and the workflow fails.

## Rollback

Rollback remains host-side through SSM Session Manager or a future separate rollback workflow:

```bash
cd /srv/clever-route-server
export ROUTE_OPS_SMOKE_LOGIN_SECRET=<read locally; never paste into GitHub or SSM parameters>
scripts/rollback-route-ops-image.sh
```

The rollback script uses `.deploy/previous-image.env`, checks schema
compatibility, verifies any enabled `route_engine` graph mount before activation,
runs smoke before promotion, and restores pre-rollback current metadata on
failure. During the first static-artifact cutover, rollback normalizes legacy
`.deploy/current-image.env` or `.deploy/previous-image.env` files that lack
`ROUTE_OPS_WEB_STATIC_IMAGE`, `ROUTE_OPS_WEB_STATIC_VOLUME`,
`ROUTE_ENGINE_IMAGE`, or `ROUTE_ENGINE_GRAPH_HOST_DIR` by deriving the
SHA-scoped defaults before backend service mutation. If that derivation cannot
be proven, rollback fails closed.

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
- 15-minute timeout;
- no scheduled/nightly runs;
- no large artifacts.

If GitHub Actions quota is exhausted, do not weaken guards. Use Session Manager emergency runbook only after separate approval.

## Frontend static artifact handoff

The SSM path deploys three immutable images for the same clever-route-server git
SHA: runtime, migrate, and `route-ops-web-static`. The host wrapper exports
`ROUTE_OPS_WEB_STATIC_IMAGE=ghcr.io/evnsolution/clever-route-server-route-ops-web-static:<ImageTag>`
and `ROUTE_OPS_WEB_STATIC_VOLUME=clever-route-route-ops-web-static-<ImageTag>`
when the command does not pass them explicitly. It also exports the separately
published `ROUTE_ENGINE_IMAGE` and `ROUTE_ENGINE_GRAPH_HOST_DIR`. The deploy
script writes those values to `.deploy/candidate-image.env`, pulls
`route-ops-web-static delivery-api delivery-api-migrate route-engine`, runs the
one-shot `route-ops-web-static` compose service against the candidate
SHA-scoped volume, starts `route-engine` only after graph manifest validation,
and only then recreates `delivery-api` to mount the new static volume and load
the internal `ROUTE_ENGINE_BASE_URL=http://route-engine:8080` contract. This
preserves the backend-authenticated `/admin/ui/app/*` shell while keeping the
frontend static artifact and the Python optimizer worker separately
identifiable and avoiding a candidate SPA/current backend mismatch during
migration failure.

## Route Engine production graph contract

`route_engine` intentionally keeps large graph/cache artifacts out of the worker
image layer. Production readiness therefore requires a host-local read-only
mount:

```text
ROUTE_ENGINE_GRAPH_HOST_DIR=/srv/clever-route-server/data/route-engine/parquet
/app/routing_engine/v7_out/parquet:ro
```

The deploy and rollback scripts fail closed before `delivery-api` activation if:

- the directory is missing;
- no `*.parquet` files are present;
- any parquet file is still a Git LFS pointer;
- the normalized host manifest does not match the worker image label
  `org.clever-route.graph-manifest-sha`.

On the first production activation, `deploy-route-ops-image.sh` backs up
`infra/env/delivery-api.env`, fills only missing `ROUTE_ENGINE_*` values, writes
`ROUTE_ENGINE_GRAPH_MANIFEST_SHA` from the image label, starts the internal
`route-engine` service through `--profile route-engine`, and smokes it from a
one-off `delivery-api` container. If any graph or smoke check fails, it restores
the pre-deploy env file and does not promote `.deploy/current-image.env`.

The graph smoke is non-customer: it calls `/readyz` and `POST /v1/solve` with a
fixed Toronto-area two-stop payload, expects `external_calls=false`, and verifies
positive route distance/duration before the public Route Ops smoke runs.
