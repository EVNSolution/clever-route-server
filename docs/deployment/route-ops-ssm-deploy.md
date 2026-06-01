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
- The image tag must be reachable from `origin/main`.
- The publish run URL is machine-verified through the GitHub Actions API: repository, workflow, event, conclusion, branch, and SHA must match.
- The deploy target tag must resolve to exactly one managed node total, that node must be `Online`, and SSM Agent must be version `3.3.2746.0` or later for `ENV_VAR` interpolation support.
- The workflow sends the command to the resolved instance ID, not back to a mutable tag selector.
- SSM uses `max-concurrency=1` and `max-errors=0`, and the workflow asserts `Command.TargetCount == 1`.
- If `ROUTE_OPS_RECONCILE_INGRESS_WITH_AWS_RUNSHELLSCRIPT=true` is deliberately enabled and IAM allows it, the workflow reconciles the Route Ops Caddy ingress on the same resolved instance ID with a fixed no-secret command that force-recreates only the `caddy` service from `/srv/clever-route-server/infra/caddy/Caddyfile`.
- Logs are redacted status summaries only; command parameters contain no production secrets.

## GitHub variables

Use GitHub repository/org **variables**, not secrets, for non-secret identifiers:

```text
DEPLOY_ALLOWED_ACTORS=github-user-1,github-user-2
AWS_ROUTE_OPS_DEPLOY_ROLE_ARN=arn:aws:iam::<account-id>:role/<role-name>
AWS_REGION=ca-central-1
SSM_ROUTE_OPS_TARGET_TAG_KEY=Service
SSM_ROUTE_OPS_TARGET_TAG_VALUE=CleverRouteProduction
SSM_ROUTE_OPS_DOCUMENT_NAME=CleverRoute-RouteOpsDeploy
SSM_ROUTE_OPS_DOCUMENT_VERSION=1
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

The GitHub deploy role should primarily invoke the reviewed custom document against the production managed node target. Do not grant broad EC2/IAM/Secrets permissions. If `AWS-RunShellScript` is ever allowed for this workflow, keep it opt-in through `ROUTE_OPS_RECONCILE_INGRESS_WITH_AWS_RUNSHELLSCRIPT=true` and limited to the fixed Route Ops Caddy ingress reconcile command in `.github/workflows/route-ops-ssm-deploy.yml`; do not use it for image deploy, rollback, secrets, database mutation, or arbitrary operator shell.

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
        "arn:aws:ssm:<region>:<account-id>:document/AWS-RunShellScript",
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

AWS resource-level support differs by Systems Manager API and target style. If a specific condition/resource is not enforceable in your AWS account, document that residual risk and keep the compensating controls: custom document for deploy, fixed ingress reconcile command, exact target-count preflight, `max-concurrency=1`, `max-errors=0`, and branch/CODEOWNERS controls.

## Custom SSM document

Production image deploy must use a reviewed custom SSM document. `AWS-RunShellScript` is not the image deploy path; the only production workflow exception is the fixed Route Ops Caddy ingress reconcile command that force-recreates the already-reviewed `caddy` service from this repo before smoke.

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
mainSteps:
  - action: aws:runShellScript
    name: routeOpsDeploy
    inputs:
      timeoutSeconds: '900'
      runCommand:
        - 'cd /srv/clever-route-server'
        - 'IMAGE_TAG="$SSM_ImageTag" PRISMA_SCHEMA_SHA="$SSM_PrismaSchemaSha" DELIVERY_API_IMAGE="$SSM_RuntimeImage" DELIVERY_API_MIGRATE_IMAGE="$SSM_MigrateImage" PUBLISH_EVIDENCE_URL="$SSM_PublishEvidence" scripts/ssm-route-ops-deploy.sh'
```

Pin the reviewed `DocumentVersion` in GitHub variable `SSM_ROUTE_OPS_DOCUMENT_VERSION` and update it deliberately when the document changes.

## Host wrapper

`scripts/ssm-route-ops-deploy.sh` runs on the EC2 host. It:

- validates image tag/schema/image coordinates again;
- takes an exclusive `.deploy/route-ops-deploy.lock` lock before `.deploy/*` mutation;
- reads `CLEVER_ADMIN_WEB_LOGIN_SECRET` locally from `infra/env/delivery-api.env` if `ROUTE_OPS_SMOKE_LOGIN_SECRET` is not already set by a host-local secure source;
- never prints the secret;
- calls `scripts/deploy-route-ops-image.sh`;
- records non-secret `PUBLISH_EVIDENCE_URL` to `.deploy/deploy-evidence.jsonl` after a successful deploy.

`deploy-route-ops-image.sh` and `rollback-route-ops-image.sh` also acquire the same lock unless a wrapper already holds it. This keeps emergency Session Manager commands from racing the workflow path.

## Host disk and image retention guard

`deploy-route-ops-image.sh` owns the production Docker image retention guard so normal SSM deploys do not depend on manual host cleanup.

Before `docker compose pull delivery-api delivery-api-migrate`, the script checks `/` and Docker's root directory from `docker info --format '{{.DockerRootDir}}'`. The defaults are:

```text
ROUTE_OPS_DEPLOY_MIN_FREE_MB=4096
ROUTE_OPS_DEPLOY_MIN_FREE_PERCENT=20
```

If either threshold is not met, the script prunes stale Route Ops images once and checks disk again before pulling the new image. If disk is still below threshold, the deploy fails before image pull/promotion and prints a disk summary.

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
```

The cleanup must not run `docker system prune`, `docker volume prune`, or `docker container prune`; it removes explicit stale Route Ops image refs only. A post-promote cleanup runs after smoke succeeds so the host keeps the current image and one previous rollback image by default.

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
5. The host deploy script verifies labels/schema and runs smoke before promotion.
6. If smoke fails, the deploy script restores current image metadata and the workflow fails.

## Rollback

Rollback remains host-side through SSM Session Manager or a future separate rollback workflow:

```bash
cd /srv/clever-route-server
export ROUTE_OPS_SMOKE_LOGIN_SECRET=<read locally; never paste into GitHub or SSM parameters>
scripts/rollback-route-ops-image.sh
```

The rollback script uses `.deploy/previous-image.env`, checks schema compatibility, runs smoke before promotion, and restores pre-rollback current metadata on failure.

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
