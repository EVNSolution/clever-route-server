# Edge Caddy deploy lane

This is the public ingress lane for CLEVER Route. It owns `infra/caddy/Caddyfile`
and the Caddy reload boundary for all public hostnames that enter the shared server.
It exists so Route Ops runtime deploys and Shopify app deploys do not rewrite each
other's routing layer.

## Ownership boundary

- Script: `scripts/ssm-edge-caddy-deploy.sh`
- GitHub workflow: `.github/workflows/edge-caddy-deploy.yml`
- Caddyfile: `infra/caddy/Caddyfile`
- Runtime lane intentionally excluded: no image build, no `clever-route-api` recreate,
  no Prisma migration, no Route Ops static staging, and no Shopify app container deploy.

Current host blocks:

```text
clever-route-api.cleversystem.ai      -> clever-route-api:3000
clever-route.cleversystem.ai          -> clever-route-api:3000      [legacy Route API alias]
clever-route-app.cleversystem.ai      -> clever-route-app:3000      [external Shopify compose, production]
clever-route-app-dev.cleversystem.ai  -> clever-route-app-dev:3000  [external Shopify compose, dev]
clever-admin.cleversystem.ai          -> clever-route-app:3000      [legacy Shopify production alias]
clever-kfood-app.cleversystem.ai      -> clever-kfood-app:3000      [external Shopify compose, K-food]
```

## SSM host work

A real Edge Caddy deploy does this in order:

1. Takes `.deploy/edge-caddy-deploy.lock.d`.
2. Renders the reviewed `infra/caddy/Caddyfile` as `.deploy/Caddyfile.candidate.*`.
3. Validates the candidate with `caddy:2-alpine` before mutating the live file.
4. Backs up the host Caddyfile to `.deploy/Caddyfile.before-edge-*`.
5. Installs the candidate to `infra/caddy/Caddyfile`.
6. Validates the live Caddy container config.
7. Reloads Caddy in place; it does not restart the container.
8. Public-smokes canonical and legacy Route API hosts plus Shopify prod/dev/K-food hosts.
9. Restores the backup and reloads Caddy if validation, reload, or smoke fails.
10. Appends `.deploy/deploy-history.jsonl` with `lane=edge-caddy`.

Dry-run stops after candidate validation and performs no ingress mutation.

## Commands

Local static checks:

```bash
bash -n scripts/ssm-edge-caddy-deploy.sh tests/deploy/ssm-edge-caddy-deploy.test.sh
tests/deploy/ssm-edge-caddy-deploy.test.sh
scripts/ssm-edge-caddy-deploy.sh --dry-run --no-send
```

Safe host dry-run through SSM:

```bash
scripts/ssm-edge-caddy-deploy.sh --dry-run
```

GitHub Actions dry-run:

```bash
gh workflow run "Edge Caddy deploy" --repo EVNSolution/clever-route-server --ref main \
  -f source_ref=main -f dry_run=true -f skip_smoke=false
```

GitHub Actions production reload:

```bash
gh workflow run "Edge Caddy deploy" --repo EVNSolution/clever-route-server --ref main \
  -f source_ref=main -f dry_run=false -f skip_smoke=false
```

Use `skip_smoke=true` only for a deliberate incident-response exception; otherwise the
lane should fail closed and restore the previous Caddyfile on any public 5xx/connectivity
failure.

## Deployment order with runtime lanes

For an ingress-affecting change, deploy in this order:

1. Edge Caddy dry-run.
2. Affected app/runtime lane dry-run or preflight.
3. Edge Caddy production reload when the upstream service names already exist on the
   shared Docker network.
4. Affected app/runtime production deploy.
5. Public smoke for every hostname touched.

For backend-only Route Ops releases, skip this lane and use `Route Ops simple deploy`.
Add new host blocks here only after their upstream service names are approved and
reachable on the shared Docker network.

## IAM note

The workflow currently reuses `AWS_ROUTE_OPS_DEPLOY_ROLE_ARN` to reach the same SSM target.
The script/workflow boundary is separated now; a stricter follow-up is to split the IAM role
or SSM document permission so Edge Caddy operators cannot invoke Route Ops runtime deploys,
and runtime deploy operators cannot rewrite ingress.
