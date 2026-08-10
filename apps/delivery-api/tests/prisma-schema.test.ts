import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

const schemaPath = new URL('../prisma/schema.prisma', import.meta.url);
const commerceConnectionMigrationPath = new URL(
  '../prisma/migrations/20260521074000_add_commerce_connections/migration.sql',
  import.meta.url
);
const wordpressPluginMigrationPath = new URL(
  '../prisma/migrations/20260522013000_add_wordpress_plugin_access/migration.sql',
  import.meta.url
);
const wooOnboardingMigrationPath = new URL(
  '../prisma/migrations/20260522043000_add_woocommerce_onboarding_admin/migration.sql',
  import.meta.url
);
const adminSettingsMigrationPath = new URL(
  '../prisma/migrations/20260526061000_add_shop_admin_settings/migration.sql',
  import.meta.url
);
const commerceSyncRunsMigrationPath = new URL(
  '../prisma/migrations/20260529011000_add_commerce_sync_runs/migration.sql',
  import.meta.url
);
const rawOrderIngestsMigrationPath = new URL(
  '../prisma/migrations/20260603012000_add_commerce_raw_order_ingests/migration.sql',
  import.meta.url
);
const routeScopeConfigMigrationPath = new URL(
  '../prisma/migrations/20260530004000_add_shop_route_scope_config/migration.sql',
  import.meta.url
);
const orderItemsMigrationPath = new URL(
  '../prisma/migrations/20260616093000_add_order_items/migration.sql',
  import.meta.url
);
const routeOpsUiSettingsMigrationPath = new URL(
  '../prisma/migrations/20260618022500_add_route_ops_ui_settings/migration.sql',
  import.meta.url
);
const deliveryCustomerProfilesMigrationPath = new URL(
  '../prisma/migrations/20260618093000_add_delivery_customer_profiles/migration.sql',
  import.meta.url
);
const rawOrderIngestEventsMigrationPath = new URL(
  '../prisma/migrations/20260619030000_add_commerce_raw_order_ingest_events/migration.sql',
  import.meta.url
);
const shopAppScopeMigrationPath = new URL(
  '../prisma/migrations/20260624033000_add_shop_app_scope/migration.sql',
  import.meta.url
);
const driverPhonePinAccountsMigrationPath = new URL(
  '../prisma/migrations/20260714070000_add_driver_phone_pin_accounts/migration.sql',
  import.meta.url
);
const driverAccountNameMigrationPath = new URL(
  '../prisma/migrations/20260715083000_add_driver_account_name/migration.sql',
  import.meta.url
);
const readyRoutePlanStatusMigrationPath = new URL(
  '../prisma/migrations/20260716143000_add_ready_route_plan_status/migration.sql',
  import.meta.url
);
const readyRouteDefaultsMigrationPath = new URL(
  '../prisma/migrations/20260716143100_set_ready_route_defaults/migration.sql',
  import.meta.url
);
const driverRouteAccountScopeMigrationPath = new URL(
  '../prisma/migrations/20260716170000_scope_driver_access_to_account_route/migration.sql',
  import.meta.url
);
const driverAccountDeletionMigrationPath = new URL(
  '../prisma/migrations/20260727180000_scope_deletion_request_to_driver_account/migration.sql',
  import.meta.url
);
const multiRouteMembershipMigrationPath = new URL(
  '../prisma/migrations/20260722090000_allow_safe_multi_route_membership/migration.sql',
  import.meta.url
);
const pickupCompletedMigrationPath = new URL(
  '../prisma/migrations/20260728120000_add_pickup_completed_driver_event/migration.sql',
  import.meta.url
);
const pickupCompletedUniqueIndexMigrationPath = new URL(
  '../prisma/migrations/20260728124500_add_pickup_completed_unique_index/migration.sql',
  import.meta.url
);
const timeConstraintAcknowledgedMigrationPath = new URL(
  '../prisma/migrations/20260803120000_add_time_constraint_acknowledged_driver_event/migration.sql',
  import.meta.url
);
const accountScopedPushTokenMigrationPath = new URL(
  '../prisma/migrations/20260731140000_account_scope_driver_push_tokens/migration.sql',
  import.meta.url
);
const geocodingCacheMigrationPath = new URL(
  '../prisma/migrations/20260802090000_add_geocoding_cache/migration.sql',
  import.meta.url
);
const uvisTelemetryMigrationPath = new URL(
  '../prisma/migrations/20260804170000_add_uvis_vehicle_telematics/migration.sql',
  import.meta.url
);
const dsvConditionTemperaturePolicyMigrationPath = new URL(
  '../prisma/migrations/20260805120000_add_dsv_condition_temperature_policy/migration.sql',
  import.meta.url
);
const uvisTrailMaterializationMigrationPath = new URL(
  '../prisma/migrations/20260810150000_add_uvis_vehicle_trail_materializations/migration.sql',
  import.meta.url
);

async function readSchema(): Promise<string> {
  return readFile(schemaPath, 'utf8');
}

describe('Prisma schema', () => {
  test('enforces UVIS current last sample tenant device and source integrity', async () => {
    const schema = await readSchema();
    const migration = await readFile(uvisTelemetryMigrationPath, 'utf8');
    const currentModel = /model UvisVehicleTelemetryCurrent \{(?<body>[\s\S]*?)\n\}/u.exec(schema)?.groups?.body ?? '';
    const sampleModel = /model UvisVehicleTelemetrySample \{(?<body>[\s\S]*?)\n\}/u.exec(schema)?.groups?.body ?? '';

    expect(currentModel).toContain('lastSampleId');
    expect(currentModel).toContain('fields: [lastSampleId, shopId, deviceId, sourceKind]');
    expect(currentModel).toContain('references: [id, shopId, deviceId, sourceKind]');
    expect(sampleModel).toContain('@@unique([id, shopId, deviceId, sourceKind])');
    expect(migration).toContain('CREATE UNIQUE INDEX "uvis_vehicle_telemetry_samples_id_shopId_deviceId_sourceKind_key"');
    expect(migration).toContain('FOREIGN KEY ("lastSampleId", "shopId", "deviceId", "sourceKind")');
    expect(migration).toContain('REFERENCES "uvis_vehicle_telemetry_samples"("id", "shopId", "deviceId", "sourceKind")');
  });

  test('adds additive UVIS vehicle trail materialization storage scoped by shop vehicle and service day', async () => {
    const schema = await readSchema();
    const migration = await readFile(uvisTrailMaterializationMigrationPath, 'utf8');
    const model = /model UvisVehicleTrailMaterialization \{(?<body>[\s\S]*?)\n\}/u.exec(schema)?.groups?.body ?? '';

    expect(model).toMatch(/serviceDate\s+DateTime\s+@db\.Date/u);
    expect(model).toContain('schemaVersion     String');
    expect(model).toContain('sourceWatermark   String');
    expect(model).toContain('sourceSampleCount Int');
    expect(model).toContain('document          Json');
    expect(model).toContain('@@unique([shopId, vehicleId, serviceDate, schemaVersion])');
    expect(migration).toContain('CREATE TABLE "uvis_vehicle_trail_materializations"');
    expect(migration).toContain('"document" JSONB NOT NULL');
    expect(migration).toContain('FOREIGN KEY ("vehicleId", "shopId") REFERENCES "vehicles"("id", "shopId")');
  });

  test('adds DSV condition temperature policy without changing import row condition ownership', async () => {
    const schema = await readSchema();
    const migration = await readFile(dsvConditionTemperaturePolicyMigrationPath, 'utf8');
    const conditionModel = /model DsvTransportCondition \{(?<body>[\s\S]*?)\n\}/u.exec(schema)?.groups?.body ?? '';
    const importRowModel = /model DsvDispatchImportRow \{(?<body>[\s\S]*?)\n\}/u.exec(schema)?.groups?.body ?? '';

    expect(conditionModel).toContain('temperatureAlertEnabled Boolean                      @default(false)');
    expect(conditionModel).toContain('temperatureMinC         Decimal?                     @db.Decimal(6, 2)');
    expect(conditionModel).toContain('temperatureMaxC         Decimal?                     @db.Decimal(6, 2)');
    expect(importRowModel).toContain('fields: [conditionId, shopId], references: [id, shopId]');
    expect(migration).toContain('ADD COLUMN "temperatureAlertEnabled" BOOLEAN NOT NULL DEFAULT false');
    expect(migration).toContain('ADD COLUMN "temperatureMinC" DECIMAL(6,2)');
    expect(migration).toContain('ADD COLUMN "temperatureMaxC" DECIMAL(6,2)');
    expect(migration).toContain('"temperatureMinC" <= "temperatureMaxC"');
  });

  test('owns mobile Push installations by the global driver account', async () => {
    const schema = await readSchema();
    const migration = await readFile(accountScopedPushTokenMigrationPath, 'utf8');
    const pushTokenModel = /model DriverPushToken \{(?<body>[\s\S]*?)\n\}/u.exec(schema)?.groups?.body ?? '';

    expect(pushTokenModel).toMatch(/accountId\s+String\s+@db\.Uuid/u);
    expect(pushTokenModel).toContain('account         DriverAccount');
    expect(pushTokenModel).toMatch(/tokenHash\s+String\s+@unique/u);
    expect(pushTokenModel).not.toContain('shopId');
    expect(pushTokenModel).not.toContain('driverId');
    expect(migration).toContain('SET "accountId" = driver."accountId"');
    expect(migration).toContain('DELETE FROM "driver_push_tokens"');
    expect(migration).toContain('ROW_NUMBER() OVER');
    expect(migration).toContain('PARTITION BY "tokenHash"');
    expect(migration).toContain('DROP COLUMN "shopId"');
    expect(migration).toContain('DROP COLUMN "driverId"');
    expect(migration).toContain('REFERENCES "driver_accounts"("id")');
  });

  test('defines persistent geocoding cache with TTL lookup indexes', async () => {
    const schema = await readSchema();
    const migration = await readFile(geocodingCacheMigrationPath, 'utf8');
    const geocodingCache = /model GeocodingCache \{(?<body>[\s\S]*?)\n\}/u.exec(schema)?.groups?.body ?? '';

    expect(geocodingCache).toContain('shopDomain String');
    expect(geocodingCache).toContain('cacheKey   String');
    expect(geocodingCache).toContain('result     Json');
    expect(geocodingCache).toContain('expiresAt  DateTime');
    expect(geocodingCache).toContain('@@unique([shopDomain, cacheKey])');
    expect(geocodingCache).toContain('@@index([expiresAt])');
    expect(geocodingCache).toContain('@@map("geocoding_caches")');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "geocoding_caches"');
    expect(migration).toContain('"result" JSONB NOT NULL');
    expect(migration).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "geocoding_caches_shopDomain_cacheKey_key"');
    expect(migration).toContain('CREATE INDEX IF NOT EXISTS "geocoding_caches_expiresAt_idx"');
  });

  test('defines pickup completed as an additive driver event migration', async () => {
    const schema = await readSchema();
    const migration = await readFile(pickupCompletedMigrationPath, 'utf8');
    const indexMigration = await readFile(pickupCompletedUniqueIndexMigrationPath, 'utf8');
    const driverEventType = /enum DriverEventType \{(?<body>[\s\S]*?)\n\}/u.exec(schema)?.groups?.body ?? '';

    expect(driverEventType).toContain('PICKUP_COMPLETED');
    expect(migration.trim()).toBe(`ALTER TYPE "DriverEventType" ADD VALUE IF NOT EXISTS 'PICKUP_COMPLETED';`);
    expect(migration).not.toContain('CREATE UNIQUE INDEX');
    expect(indexMigration).not.toContain('ALTER TYPE "DriverEventType" ADD VALUE');
    expect(indexMigration).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "driver_events_pickup_completed_driver_route_key"');
    expect(indexMigration).toContain('ON "driver_events"("driverId", "routePlanId")');
    expect(indexMigration).toContain(
      'WHERE "eventType" = \'PICKUP_COMPLETED\' AND "driverId" IS NOT NULL AND "routePlanId" IS NOT NULL'
    );
    expect(schema).not.toContain('PickupEtaSnapshot');
  });

  test('defines time constraint acknowledgement as an additive driver event migration', async () => {
    const schema = await readSchema();
    const migration = await readFile(timeConstraintAcknowledgedMigrationPath, 'utf8');
    const driverEventType = /enum DriverEventType \{(?<body>[\s\S]*?)\n\}/u.exec(schema)?.groups?.body ?? '';

    expect(driverEventType).toContain('TIME_CONSTRAINT_ACKNOWLEDGED');
    expect(migration.trim()).toBe(`ALTER TYPE "DriverEventType" ADD VALUE IF NOT EXISTS 'TIME_CONSTRAINT_ACKNOWLEDGED';`);
    expect(migration).not.toContain('CREATE TABLE');
  });

  test('allows multiple planning memberships while retaining indexed stop lookup', async () => {
    const schema = await readSchema();
    const migration = await readFile(multiRouteMembershipMigrationPath, 'utf8');
    const routePlanStop = /model RoutePlanStop \{(?<body>[\s\S]*?)\n\}/u.exec(schema)?.groups?.body ?? '';
    const branchOrderLock = /model RouteGroupingBranchOrderLock \{(?<body>[\s\S]*?)\n\}/u.exec(schema)?.groups?.body ?? '';

    expect(routePlanStop).toContain('@@unique([routePlanId, deliveryStopId])');
    expect(routePlanStop).not.toContain('@@unique([deliveryStopId])');
    expect(routePlanStop).toContain('@@index([deliveryStopId])');
    expect(branchOrderLock).toContain('@@unique([groupingId, orderId])');
    expect(migration).toContain('DROP INDEX IF EXISTS "route_plan_stops_deliveryStopId_key"');
    expect(migration).toContain('CREATE INDEX IF NOT EXISTS "route_plan_stops_deliveryStopId_idx"');
    expect(migration).toContain('DROP INDEX IF EXISTS "route_grouping_branch_order_locks_shopId_orderId_key"');
    expect(migration).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "route_grouping_branch_order_locks_groupingId_orderId_key"');
  });

  test('defines Ready as the initial route execution state with an additive migration', async () => {
    const schema = await readSchema();
    const migration = await readFile(readyRoutePlanStatusMigrationPath, 'utf8');
    const defaultsMigration = await readFile(readyRouteDefaultsMigrationPath, 'utf8');

    const routePlanStatus = /enum RoutePlanStatus \{(?<body>[\s\S]*?)\n\}/u.exec(schema)?.groups?.body ?? '';
    for (const status of ['READY', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']) {
      expect(routePlanStatus).toContain(status);
    }
    expect(routePlanStatus).toMatch(/DRAFT[\s\S]*PUBLISHED[\s\S]*CANCELLED[\s\S]*OPTIMIZED[\s\S]*ASSIGNED[\s\S]*IN_PROGRESS[\s\S]*COMPLETED[\s\S]*READY/u);
    expect(schema).toMatch(/model RoutePlan \{[\s\S]*status\s+RoutePlanStatus\s+@default\(READY\)/u);
    expect(schema).toMatch(/model RouteGrouping \{[\s\S]*status\s+RouteGroupingStatus\s+@default\(READY\)/u);
    expect(migration).toContain(`ALTER TYPE "RoutePlanStatus" ADD VALUE IF NOT EXISTS 'READY'`);
    expect(defaultsMigration).toContain('ALTER TABLE "route_plans" ALTER COLUMN "status" SET DEFAULT \'READY\'');
    expect(defaultsMigration).toContain('ALTER TABLE "route_groupings" ALTER COLUMN "status" SET DEFAULT \'READY\'');
  });

  test('defines shop-level encrypted Shopify Admin API token storage', async () => {
    const schema = await readSchema();

    expect(schema).toContain('model Shop');
    expect(schema).toContain('appId');
    expect(schema).toContain('shopDomain');
    expect(schema).toContain('shopifyShopGid');
    expect(schema).toContain('adminAccessTokenCiphertext');
    expect(schema).toContain('adminAccessTokenExpiresAt');
    expect(schema).toContain('adminRefreshTokenCiphertext');
    expect(schema).toContain('adminRefreshTokenExpiresAt');
    expect(schema).toContain('tokenScopes');
    expect(schema).toContain('installedAt');
    expect(schema).toContain('uninstalledAt');
    expect(schema).toContain('defaultDepotAddress');
    expect(schema).toContain('defaultDepotLatitude');
    expect(schema).toContain('defaultDepotLongitude');
    expect(schema).toContain('locale');
    expect(schema).toContain('routeScopeConfig');
    expect(schema).toContain('routeOpsUiSettings');
    expect(schema).toMatch(/@@unique\(\[appId, shopDomain\]\)/);
    expect(schema).toMatch(/@@unique\(\[appId, shopifyShopGid\]\)/);
    expect(schema).toMatch(/@@index\(\[shopDomain\]\)/);
  });

  test('ships a migration for Shopify app-scoped shops', async () => {
    const migration = await readFile(shopAppScopeMigrationPath, 'utf8');

    expect(migration).toContain('ADD COLUMN "appId" TEXT NOT NULL DEFAULT \'clever\'');
    expect(migration).toContain('DROP INDEX IF EXISTS "shops_shopDomain_key"');
    expect(migration).toContain('DROP INDEX IF EXISTS "shops_shopifyShopGid_key"');
    expect(migration).toContain('CREATE UNIQUE INDEX "shops_appId_shopDomain_key"');
    expect(migration).toContain('CREATE UNIQUE INDEX "shops_appId_shopifyShopGid_key"');
    expect(migration).toContain('CREATE INDEX "shops_shopDomain_idx"');
  });

  test('defines core delivery operation models and idempotency constraints', async () => {
    const schema = await readSchema();

    for (const modelName of [
      'ShopifyWebhookEvent',
      'CommerceConnection',
      'CommerceConnectionAuditLog',
      'CommerceSyncRun',
      'CommerceRawOrderIngest',
      'CommerceRawOrderIngestEvent',
      'WordPressPluginToken',
      'WordPressPluginPairingCode',
      'Order',
      'OrderItem',
      'DeliveryStop',
      'RoutePlan',
      'RoutePlanStop',
      'Driver',
      'DriverAccount',
      'DriverAccountSession',
      'DriverSession',
      'DriverConsentRecord',
      'DriverProofMedia',
      'RetentionJobRun',
      'Vehicle',
      'DriverEvent'
    ]) {
      expect(schema).toContain(`model ${modelName}`);
    }

    expect(schema).toMatch(/@@unique\(\[shopId, webhookId\]/);
    expect(schema).toContain('enum CommerceSourcePlatform');
    expect(schema).toContain('enum CommerceConnectionStatus');
    expect(schema).toContain('enum CommerceSyncRunStatus');
    expect(schema).toContain('enum CommerceRawOrderIngestStatus');
    expect(schema).toContain('commerceConnections');
    expect(schema).toContain('commerceSyncRuns');
    expect(schema).toContain('commerceRawOrderIngests');
    expect(schema).toContain('commerceRawOrderIngestEvents');
    expect(schema).toContain('consumerKeyCiphertext');
    expect(schema).toContain('consumerSecretCiphertext');
    expect(schema).toContain('webhookSecretCiphertext');
    expect(schema).toContain('lastWebhookAt');
    expect(schema).toContain('lastRestSyncAt');
    expect(schema).toContain('lastVerifiedAt');
    expect(schema).toContain('lastVerificationStatus');
    expect(schema).toContain('credentialRotatedAt');
    expect(schema).toContain('webhookSecretRotatedAt');
    expect(schema).toContain('credentialFingerprint');
    expect(schema).toContain('commerceConnectionAuditLogs');
    expect(schema).toMatch(/@@unique\(\[shopId, platform, siteUrl\]/);
    expect(schema).toMatch(/@@index\(\[shopId, platform, status\]/);
    expect(schema).toContain('sourcePlatform');
    expect(schema).toContain('sourceOrderId');
    expect(schema).toContain('sourceOrderNumber');
    expect(schema).toContain('sourceUpdatedAt');
    expect(schema).toMatch(/@@unique\(\[shopId, shopifyOrderGid\]/);
    expect(schema).toMatch(/@@unique\(\[shopId, sourcePlatform, sourceSiteUrl, sourceOrderId\]/);
    expect(schema).toMatch(/@@unique\(\[orderId, lineIndex\]/);
    expect(schema).toMatch(/@@index\(\[shopId, productId, variationId\]/);
    expect(schema).toMatch(/@@index\(\[shopId, sourcePlatform, sourceSiteUrl, sourceOrderNumber\]/);
    expect(schema).toMatch(/@@unique\(\[routePlanId, sequence\]/);
    expect(schema).toMatch(/@@unique\(\[routePlanId, deliveryStopId\]/);
    expect(schema).toContain('enum DriverConsentType');
    expect(schema).toContain('enum DriverProofMediaKind');
    expect(schema).toContain('enum DriverProofMediaSource');
    expect(schema).toMatch(/@@unique\(\[accountId, consentType, consentVersion\]/);
    expect(schema).toMatch(/@@unique\(\[driverId, consentType, consentVersion\]/);
    expect(schema).toMatch(/@@unique\(\[shopId, storageKey\]/);
    expect(schema).toMatch(/@@index\(\[shopId, routePlanId, deliveryStopId, uploadedAt\]/);
    expect(schema).toContain('enum RetentionJobRunStatus');
    expect(schema).toContain('enum WordPressPluginTokenStatus');
    expect(schema).toContain('tokenHash');
    expect(schema).toContain('tokenPrefix');
    expect(schema).toContain('codeHash');
    expect(schema).toContain('failedAttemptCount');
    expect(schema).toMatch(/@@index\(\[commerceConnectionId, status\]/);
    expect(schema).toMatch(/@@index\(\[commerceConnectionId, createdAt\]/);
    expect(schema).toMatch(/@@index\(\[commerceConnectionId, status, createdAt\]/);
    expect(schema).toMatch(/@@unique\(\[commerceConnectionId, sourceOrderId, rawPayloadSha256\]/);
    expect(schema).toMatch(/@@unique\(\[syncRunId, chunkId, sourceOrderId, rawPayloadSha256\]/);
    expect(schema).toMatch(/@@index\(\[syncRunId, status, receivedAt\]/);
    expect(schema).toMatch(/@@index\(\[commerceConnectionId, sourceOrderId, receivedAt\]/);
    expect(schema).toContain('sourceLine');
    expect(schema).toContain('rawOrderIngestId');
    expect(schema).toContain('raw_ingest_events_shop_order_number_createdAt_idx');
    expect(schema).toContain('raw_ingest_events_raw_ingest_createdAt_idx');
    expect(schema).toContain('requestPayload');
    expect(schema).toContain('geocodeResolved');
    expect(schema).toContain('geocodeFailed');
    expect(schema).toContain('jobName');
    expect(schema).toContain('scannedCount');
    expect(schema).toContain('deletedCount');
    expect(schema).toContain('missingFilesCount');
    expect(schema).toMatch(/@@index\(\[jobName, finishedAt\]/);
    expect(schema).toMatch(/@@unique\(\[driverId, clientEventId\]/);
  });

  test('uses PostgreSQL datasource and Prisma client generator', async () => {
    const schema = await readSchema();

    expect(schema).toContain('provider = "postgresql"');
    expect(schema).toContain('env("DATABASE_URL")');
    expect(schema).toContain('provider = "prisma-client-js"');
  });

  test('preserves global consent and delivery evidence when a Store driver reference is deleted', async () => {
    const schema = await readSchema();
    const migration = await readFile(driverRouteAccountScopeMigrationPath, 'utf8');

    expect(schema).toMatch(/model DriverConsentRecord \{[\s\S]*accountId\s+String\?[\s\S]*account\s+DriverAccount\?\s+@relation\(fields: \[accountId\], references: \[id\], onDelete: SetNull\)/u);
    expect(schema).toMatch(/model DriverConsentRecord \{[\s\S]*shopId\s+String\?[\s\S]*shop\s+Shop\?\s+@relation\(fields: \[shopId\], references: \[id\], onDelete: SetNull\)/u);
    expect(schema).toMatch(/model DriverConsentRecord \{[\s\S]*driverId\s+String\?[\s\S]*driver\s+Driver\?\s+@relation\(fields: \[driverId\], references: \[id\], onDelete: SetNull\)/u);
    for (const modelName of ['DriverProofMedia', 'DriverRouteFeedback', 'DriverRouteNotificationAttempt', 'DriverEvent']) {
      const model = new RegExp(`model ${modelName} \\{(?<body>[\\s\\S]*?)\\n\\}`, 'u').exec(schema)?.groups?.body ?? '';
      expect(model).toMatch(/driverId\s+String\?/u);
      expect(model).toMatch(/driver\s+Driver\?\s+@relation\(fields: \[driverId\], references: \[id\], onDelete: SetNull\)/u);
    }

    expect(migration).toContain('ADD COLUMN "accountId" UUID');
    expect(migration.trim()).toMatch(/^BEGIN;[\s\S]*COMMIT;$/u);
    expect(migration).toContain('ROW_NUMBER() OVER');
    expect(migration).toContain('ranked.account_rank = 1');
    expect(migration).toContain('driver_consent_records_accountId_consentType_consentVersion_key');
    expect(migration).toContain('REFERENCES "driver_accounts"("id")');
    expect(migration).toContain('ALTER TABLE "driver_consent_records" ALTER COLUMN "shopId" DROP NOT NULL');
    for (const tableName of [
      'driver_consent_records',
      'driver_proof_media',
      'driver_route_feedback',
      'driver_route_notification_attempts',
      'driver_events'
    ]) {
      expect(migration).toContain(`ALTER TABLE "${tableName}" ALTER COLUMN "driverId" DROP NOT NULL`);
    }
    expect(migration.match(/ON DELETE SET NULL ON UPDATE CASCADE/g)).toHaveLength(7);
  });

  test('ships a migration for phone-owned driver PIN accounts', async () => {
    const migration = await readFile(driverPhonePinAccountsMigrationPath, 'utf8');

    expect(migration).toContain('CREATE TABLE "driver_accounts"');
    expect(migration).toContain('CREATE UNIQUE INDEX "driver_accounts_phone_key"');
    expect(migration).toContain('ALTER TABLE "drivers" ADD COLUMN "accountId" UUID');
    expect(migration).toContain('CREATE TABLE "driver_account_sessions"');
    expect(migration).toContain('ON DELETE CASCADE ON UPDATE CASCADE');
  });

  test('keeps the self-chosen account name nullable and separate from shop driver display names', async () => {
    const schema = await readSchema();
    const migration = await readFile(driverAccountNameMigrationPath, 'utf8');
    const accountModel = /model DriverAccount \{(?<body>[\s\S]*?)\n\}/u.exec(schema)?.groups?.body ?? '';

    expect(accountModel).toMatch(/name\s+String\?\s+@db\.VarChar\(80\)/u);
    expect(migration).toContain('ALTER TABLE "driver_accounts" ADD COLUMN "name" VARCHAR(80)');
    expect(migration).not.toContain('drivers');
  });

  test('scopes account deletion requests to the global phone account without cascading history', async () => {
    const schema = await readSchema();
    const migration = await readFile(driverAccountDeletionMigrationPath, 'utf8');

    expect(schema).toMatch(/model DriverAccountDeletionRequest \{[\s\S]*accountId\s+String\?\s+@unique[\s\S]*account\s+DriverAccount\?\s+@relation\(fields: \[accountId\], references: \[id\], onDelete: SetNull\)/u);
    expect(schema).toMatch(/model DriverAccountDeletionRequest \{[\s\S]*shopDomain\s+String\?/u);
    expect(migration).toContain('ADD COLUMN "accountId" UUID');
    expect(migration).toContain('ALTER COLUMN "shopDomain" DROP NOT NULL');
    expect(migration).toContain('driver_account_deletion_requests_accountId_key');
    expect(migration).toContain('REFERENCES "driver_accounts"("id")');
    expect(migration).toContain('ON DELETE SET NULL');
    expect(migration.trim()).toMatch(/^BEGIN;[\s\S]*COMMIT;$/u);
  });

  test('ships a migration for the WooCommerce connection store rollout', async () => {
    const migration = await readFile(commerceConnectionMigrationPath, 'utf8');

    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "commerce_connections"');
    expect(migration).toContain('"CommerceConnectionStatus"');
    expect(migration).toContain('"consumerKeyCiphertext"');
    expect(migration).toContain('"webhookSecretCiphertext"');
    expect(migration).toContain('"orders_shopId_sourcePlatform_sourceSiteUrl_sourceOrderId_key"');
  });

  test('ships a migration for the WordPress plugin connector auth rollout', async () => {
    const migration = await readFile(wordpressPluginMigrationPath, 'utf8');

    expect(migration).toContain('CREATE TYPE "WordPressPluginTokenStatus"');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "lastWebhookAt"');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "wordpress_plugin_tokens"');
    expect(migration).toContain('"tokenHash" TEXT NOT NULL');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "wordpress_plugin_pairing_codes"');
    expect(migration).toContain('"codeHash" TEXT NOT NULL');
  });

  test('ships a migration for WooCommerce onboarding metadata and audit logs', async () => {
    const migration = await readFile(wooOnboardingMigrationPath, 'utf8');

    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "lastVerifiedAt"');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "credentialFingerprint"');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "commerce_connection_audit_logs"');
    expect(migration).toContain('"actorSubject" TEXT NOT NULL');
    expect(migration).toContain('"metadata" JSONB');
    expect(migration).toContain('"commerce_connection_audit_logs_shopId_createdAt_idx"');
  });

  test('ships a migration for shop admin route defaults', async () => {
    const migration = await readFile(adminSettingsMigrationPath, 'utf8');

    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "defaultDepotAddress"');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "defaultDepotLatitude"');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "defaultDepotLongitude"');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "locale"');
  });

  test('ships a migration for shop route-scope config', async () => {
    const migration = await readFile(routeScopeConfigMigrationPath, 'utf8');

    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "routeScopeConfig" JSONB');
  });

  test('ships a migration for durable WooCommerce REST sync runs', async () => {
    const migration = await readFile(commerceSyncRunsMigrationPath, 'utf8');

    expect(migration).toContain('CREATE TYPE "CommerceSyncRunStatus"');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "commerce_sync_runs"');
    expect(migration).toContain('"requestPayload" JSONB NOT NULL');
    expect(migration).toContain('"geocodeResolved" INTEGER');
    expect(migration).toContain('"commerce_sync_runs_commerceConnectionId_status_createdAt_idx"');
    expect(migration).toContain('"commerce_sync_runs_shopId_platform_createdAt_idx"');
    expect(migration).toContain('"commerce_sync_runs_one_active_per_connection_idx"');
    expect(migration).toContain('WHERE "status" IN (\'QUEUED\', \'RUNNING\')');
  });

  test('ships a migration for durable raw WooCommerce order ingest rows', async () => {
    const migration = await readFile(rawOrderIngestsMigrationPath, 'utf8');

    expect(migration).toContain('CREATE TYPE "CommerceRawOrderIngestStatus"');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "commerce_raw_order_ingests"');
    expect(migration).toContain('"rawPayload" JSONB NOT NULL');
    expect(migration).toContain('"rawPayloadSha256" TEXT NOT NULL');
    expect(migration).toContain('"commerce_raw_order_ingests_connection_order_hash_key"');
    expect(migration).toContain('"commerce_raw_order_ingests_run_chunk_order_hash_key"');
    expect(migration).toContain('"commerce_raw_order_ingests_syncRunId_status_receivedAt_idx"');
    expect(migration).toContain('"commerce_raw_order_ingests_connection_order_receivedAt_idx"');
  });

  test('ships a migration for source-aware raw ingest audit events', async () => {
    const migration = await readFile(rawOrderIngestEventsMigrationPath, 'utf8');

    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "commerce_raw_order_ingest_events"');
    expect(migration).toContain('"sourceLine" TEXT NOT NULL');
    expect(migration).toContain('"rawOrderIngestId" UUID');
    expect(migration).toContain('ON DELETE SET NULL ON UPDATE CASCADE');
    expect(migration).toContain('"raw_ingest_events_shop_order_number_createdAt_idx"');
    expect(migration).toContain('"raw_ingest_events_raw_ingest_createdAt_idx"');
    expect(migration).toContain('"raw_ingest_events_shop_code_createdAt_idx"');
  });

  test('ships tenant-scoped delivery customer profile storage for admin memos', async () => {
    const schema = await readSchema();
    const migration = await readFile(deliveryCustomerProfilesMigrationPath, 'utf8');

    expect(schema).toContain('model DeliveryCustomerProfile');
    expect(schema).toContain('adminMemo');
    expect(schema).toContain('addressFingerprint');
    expect(schema).toMatch(/@@unique\(\[shopId, orderId\]\)/);
    expect(schema).toMatch(/@@index\(\[shopId, addressFingerprint\]\)/);
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "delivery_customer_profiles"');
    expect(migration).toContain('"adminMemo" TEXT');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "delivery_customer_profile_order_links"');
    expect(migration).toContain('"delivery_customer_profile_order_links_shopId_orderId_key"');
  });

  test('ships a migration for normalized WooCommerce order items', async () => {
    const migration = await readFile(orderItemsMigrationPath, 'utf8');

    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "order_items"');
    expect(migration).toContain('"productId" INTEGER NOT NULL');
    expect(migration).toContain('"variationId" INTEGER NOT NULL DEFAULT 0');
    expect(migration).toContain('"options" JSONB NOT NULL');
    expect(migration).toContain('"order_items_shopId_productId_variationId_idx"');
  });
});

  test('adds route ops UI settings without dropping route scope config', async () => {
    const schema = await readSchema();
    const migration = await readFile(routeOpsUiSettingsMigrationPath, 'utf8');

    expect(schema).toMatch(/routeOpsUiSettings\s+Json\?/);
    expect(schema).toMatch(/routeScopeConfig\s+Json\?/);
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "routeOpsUiSettings" JSONB');
    expect(migration).not.toContain('DROP COLUMN "routeScopeConfig"');
  });
