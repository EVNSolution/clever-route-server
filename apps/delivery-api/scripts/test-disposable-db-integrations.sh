#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "--plan" ]]; then
  printf '%s\n' \
    'G003: 127.0.0.1:55433 / clever_g003' \
    'G003 populated upgrade: 127.0.0.1:55434 / clever_g003_upgrade' \
    'G002: 127.0.0.1:55488 / clever_g002' \
    'G002 populated upgrade: 127.0.0.1:55489 / clever_g002_upgrade' \
    'Email reconciliation: 127.0.0.1:55491 / clever_email_reconciliation' \
    'G010: 127.0.0.1:55477 / clever_g007_g010_eta' \
    'G005: 127.0.0.1:55466 / clever_g005' \
    'G006: 127.0.0.1:55490 / clever_g006'
  exit 0
fi

if [[ "${CLEVER_RUN_DISPOSABLE_DB_TESTS:-}" != "1" ]]; then
  echo 'Set CLEVER_RUN_DISPOSABLE_DB_TESTS=1 to create and destroy isolated local PostgreSQL containers.' >&2
  exit 2
fi

command -v docker >/dev/null 2>&1 || { echo 'docker is required.' >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo 'docker daemon is not available.' >&2; exit 1; }

audit_suffix="$$-${RANDOM}"
declare -a audit_containers=()

cleanup() {
  local container_name
  for container_name in "${audit_containers[@]:-}"; do
    docker rm -f "$container_name" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT

start_postgres() {
  local container_name="$1"
  local host_port="$2"
  local database_name="$3"
  local database_user="$4"
  local database_password="$5"

  docker run --detach --rm \
    --name "$container_name" \
    --publish "127.0.0.1:${host_port}:5432" \
    --env "POSTGRES_DB=${database_name}" \
    --env "POSTGRES_USER=${database_user}" \
    --env "POSTGRES_PASSWORD=${database_password}" \
    postgres:17-bookworm >/dev/null
  audit_containers+=("$container_name")

  local attempt
  for attempt in {1..60}; do
    if docker exec "$container_name" pg_isready -U "$database_user" -d "$database_name" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done

  echo "PostgreSQL did not become ready: ${container_name}" >&2
  return 1
}

g003_container="clever-api-audit-g003-${audit_suffix}"
g003_upgrade_container="clever-api-audit-g003-upgrade-${audit_suffix}"
g002_container="clever-api-audit-g002-${audit_suffix}"
email_reconciliation_container="clever-api-audit-email-reconciliation-${audit_suffix}"
g002_upgrade_container="clever-api-audit-g002-upgrade-${audit_suffix}"
g010_container="clever-api-audit-g010-${audit_suffix}"
g005_container="clever-api-audit-g005-${audit_suffix}"
g006_container="clever-api-audit-g006-${audit_suffix}"

g003_url='postgresql://clever_g003:clever_g003@127.0.0.1:55433/clever_g003?schema=public'
g002_url='postgresql://clever_g002:clever_g002@127.0.0.1:55488/clever_g002?schema=public'
email_reconciliation_url='postgresql://clever_email_reconciliation:clever_email_reconciliation@127.0.0.1:55491/clever_email_reconciliation?schema=public'
g010_url='postgresql://clever_g007:clever_g007@127.0.0.1:55477/clever_g007_g010_eta?schema=public'
g005_url='postgresql://clever_g005:clever_g005@127.0.0.1:55466/clever_g005?schema=public'
g006_url='postgresql://clever_g006:clever_g006@127.0.0.1:55490/clever_g006?schema=public'

start_postgres "$g003_container" 55433 clever_g003 clever_g003 clever_g003
start_postgres "$g003_upgrade_container" 55434 clever_g003_upgrade clever_g003_upgrade clever_g003_upgrade
start_postgres "$g002_container" 55488 clever_g002 clever_g002 clever_g002
start_postgres "$email_reconciliation_container" 55491 clever_email_reconciliation clever_email_reconciliation clever_email_reconciliation
start_postgres "$g002_upgrade_container" 55489 clever_g002_upgrade clever_g002_upgrade clever_g002_upgrade
start_postgres "$g010_container" 55477 clever_g007_g010_eta clever_g007 clever_g007
start_postgres "$g005_container" 55466 clever_g005 clever_g005 clever_g005
start_postgres "$g006_container" 55490 clever_g006 clever_g006 clever_g006

docker exec -i "$g002_upgrade_container" psql -v ON_ERROR_STOP=1 -U clever_g002_upgrade -d clever_g002_upgrade <<'SQL'
CREATE TABLE driver_event_attempts (
  id UUID PRIMARY KEY,
  "requestId" TEXT NOT NULL UNIQUE,
  "shopId" UUID NOT NULL,
  "driverId" UUID NOT NULL,
  "routePlanId" UUID NOT NULL,
  "clientEventId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "occurredAt" TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'ADMITTED',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE driver_event_attempts ADD CONSTRAINT driver_event_attempts_status_check
  CHECK (status IN ('ADMITTED', 'APPLIED', 'DUPLICATE', 'REJECTED', 'TRANSIENT_FAILURE'));
INSERT INTO driver_event_attempts
  (id, "requestId", "shopId", "driverId", "routePlanId", "clientEventId", "eventType", "occurredAt", status, "createdAt")
VALUES
  ('71000000-0000-4000-8000-000000000001', 'upgrade-1', '72000000-0000-4000-8000-000000000001', '73000000-0000-4000-8000-000000000001', '74000000-0000-4000-8000-000000000001', 'lineage', 'ROUTE_COMPLETED', now(), 'ADMITTED', '2026-08-24T01:00:00Z'),
  ('71000000-0000-4000-8000-000000000002', 'upgrade-2', '72000000-0000-4000-8000-000000000001', '73000000-0000-4000-8000-000000000001', '74000000-0000-4000-8000-000000000001', 'lineage', 'ROUTE_COMPLETED', now(), 'TRANSIENT_FAILURE', '2026-08-24T02:00:00Z');
SQL
docker exec -i "$g002_upgrade_container" psql -v ON_ERROR_STOP=1 -U clever_g002_upgrade -d clever_g002_upgrade \
  < prisma/migrations/20260824170000_harden_driver_event_attempt_evidence/migration.sql
upgrade_rows="$(docker exec "$g002_upgrade_container" psql -At -U clever_g002_upgrade -d clever_g002_upgrade \
  -c 'SELECT status || '"'"':'"'"' || "attemptNumber" FROM driver_event_attempts ORDER BY "attemptNumber"')"
[[ "$upgrade_rows" == $'ACCEPTED:1\nFAILED:2' ]] || { echo "Unexpected populated G002 upgrade rows: ${upgrade_rows}" >&2; exit 1; }
echo 'G002 populated pre-hardening migration upgrade: PASS'

docker exec -i "$g002_upgrade_container" psql -v ON_ERROR_STOP=1 -U clever_g002_upgrade -d clever_g002_upgrade <<'SQL'
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE shops (
  id UUID PRIMARY KEY,
  "appId" TEXT NOT NULL
);
INSERT INTO shops VALUES ('77000000-0000-4000-8000-000000000001', 'clever');
CREATE TABLE shopify_webhook_events (
  id UUID PRIMARY KEY,
  "shopId" UUID NOT NULL,
  "webhookId" TEXT NOT NULL,
  topic TEXT NOT NULL,
  status TEXT NOT NULL,
  payload JSONB NOT NULL,
  "processedAt" TIMESTAMPTZ,
  "updatedAt" TIMESTAMPTZ NOT NULL
);
INSERT INTO shopify_webhook_events (id, "shopId", "webhookId", topic, status, payload, "processedAt", "updatedAt") VALUES
  ('75000000-0000-4000-8000-000000000001', '77000000-0000-4000-8000-000000000001', 'upgrade-processed', 'orders/create', 'PROCESSED', '{"email":"historical@g008.invalid","shipping_address":{"address1":"PII Street"}}', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z'),
  ('75000000-0000-4000-8000-000000000002', '77000000-0000-4000-8000-000000000001', 'upgrade-retry', 'orders/updated', 'RETRY_WAIT', '{"id":6002,"email":"retry@g008.invalid"}', NULL, '2026-08-01T00:00:00Z'),
  ('75000000-0000-4000-8000-000000000003', '77000000-0000-4000-8000-000000000001', 'upgrade-dead', 'orders/fulfilled', 'DEAD_LETTER', '{"id":6003,"shipping_address":{"address1":"Dead Letter Street"}}', NULL, '2026-08-01T00:00:00Z');
CREATE TABLE driver_proof_media (
  id UUID PRIMARY KEY,
  "createdAt" TIMESTAMPTZ NOT NULL
);
INSERT INTO driver_proof_media VALUES
  ('76000000-0000-4000-8000-000000000001', '2026-08-01T00:00:00Z');
SQL
docker exec -i "$g002_upgrade_container" psql -v ON_ERROR_STOP=1 -U clever_g002_upgrade -d clever_g002_upgrade \
  < prisma/migrations/20260824233000_minimize_webhook_payload_lifecycle/migration.sql
docker exec -i "$g002_upgrade_container" psql -v ON_ERROR_STOP=1 -U clever_g002_upgrade -d clever_g002_upgrade <<'SQL'
INSERT INTO shopify_webhook_events (id, "shopId", "webhookId", topic, status, payload, "payloadRedactedAt", "processedAt", "updatedAt") VALUES
  ('75000000-0000-4000-8000-000000000004', '77000000-0000-4000-8000-000000000001', 'upgrade-redacted', 'orders/create', 'RETRY_WAIT', '{"orderId":"gid://shopify/Order/6006","redacted":true,"schema":"shopify_order_reference_v1"}', '2026-08-02T00:00:00Z', NULL, '2026-08-02T00:00:00Z');
SQL
docker exec -i "$g002_upgrade_container" psql -v ON_ERROR_STOP=1 -U clever_g002_upgrade -d clever_g002_upgrade \
  < prisma/migrations/20260824234000_reserve_proof_media_uploads/migration.sql
docker exec -i "$g002_upgrade_container" psql -v ON_ERROR_STOP=1 -U clever_g002_upgrade -d clever_g002_upgrade \
  < prisma/migrations/20260824235000_prevent_redacted_order_recreation/migration.sql
docker exec -i "$g002_upgrade_container" psql -v ON_ERROR_STOP=1 -U clever_g002_upgrade -d clever_g002_upgrade \
  < prisma/migrations/20260824236000_fence_proof_media_cleanup/migration.sql
g008_upgrade_rows="$(docker exec "$g002_upgrade_container" psql -At -U clever_g002_upgrade -d clever_g002_upgrade \
  -c 'SELECT "webhookId" || '"'"':'"'"' || (payload->>'"'"'schema'"'"') || '"'"':'"'"' || COALESCE(payload->>'"'"'orderId'"'"', '"'"'terminal'"'"') || '"'"':'"'"' || ("payloadRedactedAt" IS NOT NULL)::text FROM shopify_webhook_events ORDER BY "webhookId"')"
[[ "$g008_upgrade_rows" == $'upgrade-dead:shopify_order_reference_v1:gid://shopify/Order/6003:true\nupgrade-processed:shopify_webhook_tombstone_v1:terminal:true\nupgrade-redacted:shopify_order_reference_v1:gid://shopify/Order/6006:true\nupgrade-retry:shopify_order_reference_v1:gid://shopify/Order/6002:true' ]] || { echo "Unexpected populated G008 webhook upgrade rows: ${g008_upgrade_rows}" >&2; exit 1; }
g008_tombstones="$(docker exec "$g002_upgrade_container" psql -At -U clever_g002_upgrade -d clever_g002_upgrade \
  -c 'SELECT "appId" || '"'"':'"'"' || "shopifyOrderLegacyId" || '"'"':'"'"' || "complianceWebhookId" FROM shopify_order_redaction_tombstones')"
[[ "$g008_tombstones" == 'clever:6006:migration:upgrade-redacted' ]] || { echo "Unexpected populated G008 redaction tombstones: ${g008_tombstones}" >&2; exit 1; }
g008_proof_status="$(docker exec "$g002_upgrade_container" psql -At -U clever_g002_upgrade -d clever_g002_upgrade \
  -c 'SELECT "uploadStatus" FROM driver_proof_media')"
[[ "$g008_proof_status" == 'READY' ]] || { echo "Unexpected populated G008 proof upgrade status: ${g008_proof_status}" >&2; exit 1; }
echo 'G008 populated privacy/proof migration upgrade: PASS'

docker exec -i "$g003_upgrade_container" psql -v ON_ERROR_STOP=1 -U clever_g003_upgrade -d clever_g003_upgrade <<'SQL'
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE shops (id UUID PRIMARY KEY);
CREATE TABLE route_plans (id UUID PRIMARY KEY);
CREATE TABLE drivers (id UUID PRIMARY KEY);
CREATE TABLE customer_route_notification_facts (id UUID PRIMARY KEY);
CREATE TABLE customer_email_manual_dispatch_recipients (id UUID PRIMARY KEY);
CREATE TABLE admin_notifications (
  id UUID PRIMARY KEY,
  "shopId" UUID NOT NULL REFERENCES shops(id),
  type TEXT NOT NULL,
  severity TEXT NOT NULL,
  "dedupeKey" TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  href TEXT,
  "routePlanId" UUID,
  payload JSONB,
  "readAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL,
  "updatedAt" TIMESTAMPTZ NOT NULL,
  UNIQUE ("shopId", "dedupeKey")
);
INSERT INTO shops VALUES
  ('91000000-0000-4000-8000-000000000001'),
  ('91000000-0000-4000-8000-000000000002');
INSERT INTO admin_notifications
  (id, "shopId", type, severity, "dedupeKey", title, payload, "readAt", "createdAt", "updatedAt")
VALUES
  ('92000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000001', 'LEGACY_A', 'critical', 'legacy:a', 'A', '{"safe":"a"}', '2026-08-20T01:00:00Z', '2026-08-20T00:00:00Z', '2026-08-20T01:00:00Z'),
  ('92000000-0000-4000-8000-000000000002', '91000000-0000-4000-8000-000000000002', 'LEGACY_B', 'warning', 'legacy:b', 'B', '{"safe":"b"}', NULL, '2026-08-21T00:00:00Z', '2026-08-21T01:00:00Z');
SQL
docker exec -i "$g003_upgrade_container" psql -v ON_ERROR_STOP=1 -U clever_g003_upgrade -d clever_g003_upgrade \
  < prisma/migrations/20260824200000_route_operational_health/migration.sql
docker exec -i "$g003_upgrade_container" psql -v ON_ERROR_STOP=1 -U clever_g003_upgrade -d clever_g003_upgrade <<'SQL'
INSERT INTO alert_conditions ("shopId", "dedupeKey", type, "routePlanId", "createdAt", "updatedAt")
SELECT "shopId", "dedupeKey", type, "routePlanId", "createdAt", "updatedAt" FROM admin_notifications
ON CONFLICT ("shopId", "dedupeKey") DO NOTHING;
INSERT INTO alert_cycles ("conditionId", "legacyNotificationId", severity, payload, "openedAt", "lastObservedAt", "readAt", "compatibilityMetadata", "retainedUntil", "createdAt", "updatedAt")
SELECT condition.id, notification.id,
  CASE WHEN notification.severity = 'critical' THEN 'CRITICAL' ELSE 'WARNING' END,
  notification.payload, notification."createdAt", notification."updatedAt", notification."readAt",
  jsonb_build_object('source', 'ADMIN_NOTIFICATION_BACKFILL', 'legacyNotificationId', notification.id),
  notification."createdAt" + INTERVAL '365 days', notification."createdAt", notification."updatedAt"
FROM admin_notifications notification
JOIN alert_conditions condition ON condition."shopId" = notification."shopId" AND condition."dedupeKey" = notification."dedupeKey"
WHERE NOT EXISTS (SELECT 1 FROM alert_cycles existing WHERE existing."legacyNotificationId" = notification.id);
SQL
g003_upgrade_counts="$(docker exec "$g003_upgrade_container" psql -At -U clever_g003_upgrade -d clever_g003_upgrade -c 'SELECT (SELECT count(*) FROM alert_conditions) || '"'"':'"'"' || (SELECT count(*) FROM alert_cycles) || '"'"':'"'"' || (SELECT count(*) FROM alert_cycles WHERE "readAt" IS NOT NULL)')"
[[ "$g003_upgrade_counts" == '2:2:1' ]] || { echo "Unexpected populated G003 upgrade counts: ${g003_upgrade_counts}" >&2; exit 1; }
g003_upgrade_manifest="$(docker exec "$g003_upgrade_container" psql -At -U clever_g003_upgrade -d clever_g003_upgrade -c 'SELECT condition."shopId" || '"'"':'"'"' || encode(digest(string_agg(cycle.id::text || '"'"':'"'"' || cycle.severity || '"'"':'"'"' || cycle."openedAt"::text, '"'"','"'"' ORDER BY cycle.id), '"'"'sha256'"'"'), '"'"'hex'"'"') FROM alert_cycles cycle JOIN alert_conditions condition ON condition.id = cycle."conditionId" GROUP BY condition."shopId" ORDER BY condition."shopId"')"
[[ "$(printf '%s\n' "$g003_upgrade_manifest" | wc -l | tr -d ' ')" == '2' ]] || { echo 'Missing per-shop G003 migration manifest' >&2; exit 1; }
printf 'G003 populated migration upgrade: PASS\n%s\n' "$g003_upgrade_manifest"

for database_url in "$g002_url" "$email_reconciliation_url" "$g003_url" "$g010_url" "$g005_url" "$g006_url"; do
  DATABASE_URL="$database_url" npm run prisma:migrate:deploy
done

G002_DATABASE_TARGET_CLASS='safe-local-g002-disposable' \
DATABASE_URL="$g002_url" \
DRIVER_EVENT_CONTRACT_V2_DATABASE_URL="$g002_url" \
ROUTE_OPERATIONAL_HEALTH_DATABASE_URL="$g002_url" \
npm test -- driver-event-contract-v2.integration.test.ts route-operational-health.integration.test.ts

DATABASE_URL="$email_reconciliation_url" \
EMAIL_RECONCILIATION_DATABASE_TARGET_CLASS='safe-local-email-reconciliation-disposable' \
EMAIL_RECONCILIATION_DATABASE_URL="$email_reconciliation_url" \
npm test -- customer-email-reconciliation.integration.test.ts

G003_DATABASE_TARGET_CLASS='safe-local-g003-temp-cluster' \
DATABASE_URL="$g003_url" \
npm test -- dsv-dispatch-import-g003-integration.test.ts

G004_DATABASE_TARGET_CLASS='safe-local-g010-disposable' \
DATABASE_URL="$g010_url" \
DSV_G010_DATABASE_URL="$g010_url" \
npm test -- dsv-assignment-command.integration.test.ts dsv-g009-tenant-composite-fks.integration.test.ts

G005_DATABASE_TARGET_CLASS='safe-local-g005-temp-cluster' \
DATABASE_URL="$g005_url" \
npm test -- dsv-v1-read-query.integration.test.ts

G006_DATABASE_TARGET_CLASS='safe-local-g006-disposable' \
SHOP_PRIVACY_INVARIANT_DATABASE_TARGET_CLASS='safe-local-disposable' \
DATABASE_URL="$g006_url" \
SHOPIFY_WEBHOOK_DURABILITY_DATABASE_URL="$g006_url" \
npm test -- shopify-webhook-durability.integration.test.ts shop-privacy-db-invariant.integration.test.ts
