# Route Ops manual tar deploy runbook

Use this only when the normal Route Ops release workflow cannot be used and the
operator explicitly asked for a manual/no-Actions deploy. The normal path remains
`route-ops-release.yml` `prepare` then `promote` from `main`.

This runbook records the verified 2026-06-16 fallback that deployed commit
`01934b75b047a9a9ad21fcd186004aea6e2ada01` without GitHub Actions by shipping
prebuilt Docker images through the approved deploy-control S3 prefix, loading
them on the production host, and then running `scripts/deploy-route-ops-image.sh`.

## Do not repeat these failures

- Do **not** use GitHub Actions when the user says not to. Local commands and SSM
  are enough for this fallback.
- Do **not** paste large inline multi-line shell into `aws ssm send-command` by
  hand. Generate the JSON parameters with Python so `$()`, quotes, and newlines
  are not expanded on the operator laptop.
- Do **not** upload to a new ad-hoc S3 prefix. The host role is expected to read
  from `artifacts/route-ops/prod/deploy-control/*`.
- Do **not** set `ROUTE_OPS_DRIVER_APP_DOWNLOAD_URL_PARAMETER_NAME=` expecting to
  disable the default. The deploy script uses shell default expansion; pass a real
  `ROUTE_OPS_DRIVER_APP_DOWNLOAD_URL` value instead.
- Do **not** set `ROUTE_OPS_SKIP_CANDIDATE_IMAGE_PULL=1` unless the images have
  already been loaded on the host with the exact tags in `.deploy/candidate-image.env`.

## Preconditions

- Local checkout is on the exact commit to deploy and has no uncommitted changes.
- Local verification already passed for the code being deployed.
- AWS CLI can call S3 and SSM in `ap-northeast-2`.
- Docker can build `linux/amd64` images locally.
- The production host already has `scripts/deploy-route-ops-image.sh` support for
  `ROUTE_OPS_SKIP_CANDIDATE_IMAGE_PULL=1`.
- The driver APK URL exists in host `infra/env/delivery-api.env` as
  `DRIVER_APP_DOWNLOAD_URL=...`, or the operator has an explicit replacement URL.

## 1. Build and verify local artifacts

```bash
set -euo pipefail
export AWS_REGION=ap-northeast-2
export IMAGE_TAG="$(git rev-parse --short=40 HEAD)"
export SCHEMA_SHA="$(shasum -a 256 apps/delivery-api/prisma/schema.prisma | awk '{print $1}')"

test -z "$(git status --porcelain)" || { git status --short; echo "dirty checkout; commit or stash before building deploy artifacts" >&2; exit 1; }

npm run check:workspace
node scripts/validate-route-ops-release.mjs
git diff --check
```

Build the web assets first. On Apple Silicon, if the normal `linux/amd64` web
image build fails inside qemu/esbuild, use the already built `dist` and `public`
assets for only the static image; do not rebuild the SPA inside the amd64 image.

```bash
npm --prefix apps/route-ops-web run build

STATIC_CONTEXT="$(mktemp -d)"
cp -R apps/route-ops-web/dist "$STATIC_CONTEXT/dist"
cp -R apps/route-ops-web/public "$STATIC_CONTEXT/public"
cat > "$STATIC_CONTEXT/Dockerfile" <<'DOCKERFILE'
FROM alpine:3.20
ARG IMAGE_TAG
ARG PRISMA_SCHEMA_SHA
LABEL org.opencontainers.image.revision=$IMAGE_TAG
LABEL org.clever-route.image-role=route-ops-web-static
LABEL org.clever-route.prisma-schema-sha=$PRISMA_SCHEMA_SHA
WORKDIR /opt/route-ops-web
COPY dist ./dist
COPY public ./public
DOCKERFILE

docker build --platform linux/amd64 \
  --build-arg IMAGE_TAG="$IMAGE_TAG" \
  --build-arg PRISMA_SCHEMA_SHA="$SCHEMA_SHA" \
  -t "ghcr.io/evnsolution/clever-route-server-route-ops-web-static:$IMAGE_TAG" \
  "$STATIC_CONTEXT"

docker build --platform linux/amd64 \
  -f apps/delivery-api/Dockerfile \
  --target runtime \
  --label "org.opencontainers.image.revision=$IMAGE_TAG" \
  --label "org.clever-route.prisma-schema-sha=$SCHEMA_SHA" \
  --label "org.clever-route.image-role=runtime" \
  -t "ghcr.io/evnsolution/clever-route-server-delivery-api:$IMAGE_TAG" .

docker build --platform linux/amd64 \
  -f apps/delivery-api/Dockerfile \
  --target migrate \
  --label "org.opencontainers.image.revision=$IMAGE_TAG" \
  --label "org.clever-route.prisma-schema-sha=$SCHEMA_SHA" \
  --label "org.clever-route.image-role=migrate" \
  -t "ghcr.io/evnsolution/clever-route-server-delivery-api-migrate:$IMAGE_TAG" .
```

Verify image labels before upload:

```bash
for image in \
  "ghcr.io/evnsolution/clever-route-server-route-ops-web-static:$IMAGE_TAG" \
  "ghcr.io/evnsolution/clever-route-server-delivery-api:$IMAGE_TAG" \
  "ghcr.io/evnsolution/clever-route-server-delivery-api-migrate:$IMAGE_TAG"
do
  docker image inspect "$image" \
    --format '{{.Architecture}} {{index .Config.Labels "org.opencontainers.image.revision"}} {{index .Config.Labels "org.clever-route.image-role"}} {{index .Config.Labels "org.clever-route.prisma-schema-sha"}}'
done
```

Expected: `amd64`, the exact 40-character `IMAGE_TAG`, the correct image role,
and `SCHEMA_SHA`.

## 2. Package and upload through the approved prefix

```bash
export RELEASE_UTC="$(date -u +%Y%m%dT%H%M%SZ)"
export BUCKET=route-ops-artifacts-902837199612-ap-northeast-2
export PREFIX="artifacts/route-ops/prod/deploy-control/manual-${RELEASE_UTC}/${IMAGE_TAG}/manual-tar"
export IMAGES_TAR="/tmp/clever-route-images-${IMAGE_TAG}.tar.gz"
export SOURCE_TAR="/tmp/clever-route-source-${IMAGE_TAG}.tar.gz"

docker save \
  "ghcr.io/evnsolution/clever-route-server-route-ops-web-static:$IMAGE_TAG" \
  "ghcr.io/evnsolution/clever-route-server-delivery-api:$IMAGE_TAG" \
  "ghcr.io/evnsolution/clever-route-server-delivery-api-migrate:$IMAGE_TAG" \
  | gzip -1 > "$IMAGES_TAR"

git archive --format=tar.gz -o "$SOURCE_TAR" HEAD

shasum -a 256 "$IMAGES_TAR" "$SOURCE_TAR"
aws s3 cp "$IMAGES_TAR" "s3://${BUCKET}/${PREFIX}/images.tar.gz" --sse AES256
aws s3 cp "$SOURCE_TAR" "s3://${BUCKET}/${PREFIX}/source.tar.gz" --sse AES256
```

If S3 returns 403, verify the key starts with
`artifacts/route-ops/prod/deploy-control/`. Do not invent another prefix.

## 3. Generate the host script and send SSM safely

The host script downloads the image/source tarballs, verifies SHA-256, loads the
images, preserves the currently deployed `ROUTE_ENGINE_IMAGE`, injects the driver
APK URL and smoke secret from host env, then runs the deploy script without
pulling candidate images. The source tar sync is intentionally included because
the production host is a deploy directory, not a live git checkout.

```bash
export IMAGES_SHA="$(shasum -a 256 "$IMAGES_TAR" | awk '{print $1}')"
export SOURCE_SHA="$(shasum -a 256 "$SOURCE_TAR" | awk '{print $1}')"
export IMAGES_S3_URI="s3://${BUCKET}/${PREFIX}/images.tar.gz"
export SOURCE_S3_URI="s3://${BUCKET}/${PREFIX}/source.tar.gz"
export PRISMA_SCHEMA_SHA="$SCHEMA_SHA"
export HOST_SCRIPT="/tmp/route-ops-manual-host-${IMAGE_TAG}.sh"

cat > "$HOST_SCRIPT" <<'HOST'
#!/usr/bin/env bash
set -euo pipefail
: "${IMAGE_TAG:?}"
: "${IMAGES_S3_URI:?}"
: "${SOURCE_S3_URI:?}"
: "${IMAGES_SHA:?}"
: "${SOURCE_SHA:?}"
: "${PRISMA_SCHEMA_SHA:?}"

APP_DIR=/srv/clever-route-server
WORK_DIR="/tmp/route-ops-manual-${IMAGE_TAG}"
export AWS_REGION="${AWS_REGION:-ap-northeast-2}"
mkdir -p "$WORK_DIR"
cd "$WORK_DIR"

aws s3 cp "$IMAGES_S3_URI" images.tar.gz
aws s3 cp "$SOURCE_S3_URI" source.tar.gz
printf '%s  images.tar.gz\n' "$IMAGES_SHA" | sha256sum -c -
printf '%s  source.tar.gz\n' "$SOURCE_SHA" | sha256sum -c -

docker load -i images.tar.gz

cd "$APP_DIR"
current_env=.deploy/current-image.env
test -f "$current_env"
current_route_engine_image="$(grep -m1 '^ROUTE_ENGINE_IMAGE=' "$current_env" | cut -d= -f2- || true)"
: "${current_route_engine_image:?missing current ROUTE_ENGINE_IMAGE in $current_env}"
export ROUTE_ENGINE_IMAGE="$current_route_engine_image"
current_route_engine_graph_host_dir="$(grep -m1 '^ROUTE_ENGINE_GRAPH_HOST_DIR=' "$current_env" | cut -d= -f2- || true)"
if [ -n "$current_route_engine_graph_host_dir" ]; then
  export ROUTE_ENGINE_GRAPH_HOST_DIR="$current_route_engine_graph_host_dir"
fi

if [ -z "${ROUTE_OPS_DRIVER_APP_DOWNLOAD_URL:-}" ]; then
  ROUTE_OPS_DRIVER_APP_DOWNLOAD_URL="$(grep -m1 '^DRIVER_APP_DOWNLOAD_URL=' infra/env/delivery-api.env | cut -d= -f2-)"
fi
: "${ROUTE_OPS_DRIVER_APP_DOWNLOAD_URL:?missing DRIVER_APP_DOWNLOAD_URL}"

if [ -z "${ROUTE_OPS_SMOKE_LOGIN_SECRET:-}" ]; then
  secret_line="$(grep -m1 '^CLEVER_ADMIN_WEB_LOGIN_SECRET=' infra/env/delivery-api.env || true)"
  ROUTE_OPS_SMOKE_LOGIN_SECRET="${secret_line#CLEVER_ADMIN_WEB_LOGIN_SECRET=}"
  ROUTE_OPS_SMOKE_LOGIN_SECRET="$(printf '%s' "$ROUTE_OPS_SMOKE_LOGIN_SECRET" | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")"
fi
: "${ROUTE_OPS_SMOKE_LOGIN_SECRET:?missing CLEVER_ADMIN_WEB_LOGIN_SECRET}"

cd "$WORK_DIR"
mkdir -p source
rm -rf source/*
tar -xzf source.tar.gz -C source
rsync -a --delete \
  --exclude '.deploy/' \
  --exclude 'data/' \
  --exclude 'infra/env/' \
  --exclude 'var/' \
  source/ "$APP_DIR/"
cd "$APP_DIR"

export DELIVERY_API_IMAGE="ghcr.io/evnsolution/clever-route-server-delivery-api:${IMAGE_TAG}"
export DELIVERY_API_MIGRATE_IMAGE="ghcr.io/evnsolution/clever-route-server-delivery-api-migrate:${IMAGE_TAG}"
export ROUTE_OPS_WEB_STATIC_IMAGE="ghcr.io/evnsolution/clever-route-server-route-ops-web-static:${IMAGE_TAG}"
export ROUTE_OPS_WEB_STATIC_VOLUME="clever-route-route-ops-web-static-${IMAGE_TAG}"
export PRISMA_SCHEMA_SHA
export ROUTE_OPS_COMPOSE_PROJECT_NAME=clever-route
export ROUTE_OPS_SMOKE_BASE_URL=https://clever-route.cleversystem.ai
export ROUTE_OPS_SMOKE_SHOP_DOMAIN=tomatonofood.com
export ROUTE_OPS_SKIP_GHCR_LOGIN=1
export ROUTE_OPS_SKIP_CANDIDATE_IMAGE_PULL=1
export ROUTE_OPS_DRIVER_APP_DOWNLOAD_URL
export ROUTE_OPS_SMOKE_LOGIN_SECRET

scripts/deploy-route-ops-image.sh
HOST
chmod +x "$HOST_SCRIPT"
aws s3 cp "$HOST_SCRIPT" "s3://${BUCKET}/${PREFIX}/manual-host.sh" --sse AES256
```

Generate SSM parameters with Python. This avoids local shell expansion corrupting
the host command.

```bash
export HOST_SCRIPT_S3_URI="s3://${BUCKET}/${PREFIX}/manual-host.sh"
read -r TARGET_COUNT INSTANCE_ID PING_STATUS <<< "$(aws ssm describe-instance-information \
  --region "$AWS_REGION" \
  --filters Key=tag:Service,Values=clever-delivery-server \
  --query '[length(InstanceInformationList), InstanceInformationList[0].InstanceId, InstanceInformationList[0].PingStatus]' \
  --output text)"
test "$TARGET_COUNT" = "1" || { echo "expected exactly one clever-delivery-server SSM target; got ${TARGET_COUNT}" >&2; exit 1; }
test "$PING_STATUS" = "Online" || { echo "SSM target ${INSTANCE_ID} is not Online: ${PING_STATUS}" >&2; exit 1; }
test "$INSTANCE_ID" != "None" && test -n "$INSTANCE_ID"

python3 - <<'PY' > /tmp/route-ops-manual-ssm.json
import json, os, shlex
inner = f'''set -euo pipefail
export AWS_REGION={shlex.quote(os.environ.get('AWS_REGION', 'ap-northeast-2'))}
export IMAGE_TAG={shlex.quote(os.environ['IMAGE_TAG'])}
export IMAGES_S3_URI={shlex.quote(os.environ['IMAGES_S3_URI'])}
export SOURCE_S3_URI={shlex.quote(os.environ['SOURCE_S3_URI'])}
export IMAGES_SHA={shlex.quote(os.environ['IMAGES_SHA'])}
export SOURCE_SHA={shlex.quote(os.environ['SOURCE_SHA'])}
export PRISMA_SCHEMA_SHA={shlex.quote(os.environ['PRISMA_SCHEMA_SHA'])}
aws s3 cp {shlex.quote(os.environ['HOST_SCRIPT_S3_URI'])} /tmp/route-ops-manual-host.sh
chmod +x /tmp/route-ops-manual-host.sh
/tmp/route-ops-manual-host.sh
'''
print(json.dumps({"commands": ["bash -lc " + shlex.quote(inner)]}))
PY

COMMAND_ID="$(aws ssm send-command \
  --region "$AWS_REGION" \
  --instance-ids "$INSTANCE_ID" \
  --document-name AWS-RunShellScript \
  --comment "Route Ops manual tar deploy ${IMAGE_TAG}" \
  --parameters file:///tmp/route-ops-manual-ssm.json \
  --query Command.CommandId \
  --output text)"
echo "$COMMAND_ID"

aws ssm wait command-executed \
  --region "$AWS_REGION" \
  --command-id "$COMMAND_ID" \
  --instance-id "$INSTANCE_ID"

aws ssm get-command-invocation \
  --region "$AWS_REGION" \
  --command-id "$COMMAND_ID" \
  --instance-id "$INSTANCE_ID" \
  --query '{Status:Status,ResponseCode:ResponseCode,Stdout:StandardOutputContent,Stderr:StandardErrorContent}' \
  --output json
```

A successful 2026-06-16 run used SSM command
`5dfee14e-0a03-484d-b79d-151b3ed277b6` for git SHA
`57448233f27e0cf310fdcc90e7e95f2ad2e2ae3d`.

## 4. Required post-deploy checks

Run a read-only SSM check after the deploy command succeeds:

```bash
python3 - <<'PY' > /tmp/route-ops-postdeploy-check.json
import json, shlex
inner = r'''set -euo pipefail
cd /srv/clever-route-server
printf 'current image env:\n'
sed -n '1,120p' .deploy/current-image.env
printf '\ncontainers:\n'
docker compose -p clever-route --env-file .deploy/current-image.env -f infra/compose/docker-compose.prod.yml ps delivery-api route-engine
printf '\nproof media host dir:\n'
stat -c '%u:%g %a %n' /srv/clever-route-server/data/driver-proof-media
printf '\nproof media container dir:\n'
docker compose -p clever-route --env-file .deploy/current-image.env -f infra/compose/docker-compose.prod.yml exec -T delivery-api sh -lc 'stat -c "%u:%g %a %n" /app/var/driver-proof-media && test -w /app/var/driver-proof-media && echo writable:yes'
printf '\nhealth:\n'
curl -fsS https://clever-route.cleversystem.ai/healthz
printf '\nproof-media unauth route check:\n'
curl -sS -o /tmp/proof.out -w '%{http_code}\n' -X POST https://clever-route.cleversystem.ai/driver/proof-media
cat /tmp/proof.out
'''
print(json.dumps({"commands": ["bash -lc " + shlex.quote(inner)]}))
PY

CHECK_ID="$(aws ssm send-command \
  --region "$AWS_REGION" \
  --instance-ids "$INSTANCE_ID" \
  --document-name AWS-RunShellScript \
  --comment "Route Ops postdeploy check ${IMAGE_TAG}" \
  --parameters file:///tmp/route-ops-postdeploy-check.json \
  --query Command.CommandId \
  --output text)"
aws ssm wait command-executed --region "$AWS_REGION" --command-id "$CHECK_ID" --instance-id "$INSTANCE_ID"
aws ssm get-command-invocation --region "$AWS_REGION" --command-id "$CHECK_ID" --instance-id "$INSTANCE_ID" --output json
```

Expected evidence:

- `.deploy/current-image.env` points to the deployed `IMAGE_TAG` for runtime,
  migrate, and static images.
- `delivery-api` is running and healthy.
- `/srv/clever-route-server/data/driver-proof-media` is `100:101` and `750`.
- Container `/app/var/driver-proof-media` is writable.
- `/healthz` succeeds.
- Unauthenticated `POST /driver/proof-media` returns `401 Missing driver bearer
  token`; authenticated mobile upload must return `201` and show `Photo uploaded`
  in the app.

## Rollback

Use the existing rollback script on the host. Do not invent a second rollback
path for this fallback.

```bash
cd /srv/clever-route-server
export ROUTE_OPS_SMOKE_LOGIN_SECRET=<read from host env or secret store>
scripts/rollback-route-ops-image.sh
```
