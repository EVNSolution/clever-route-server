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

async function readSchema(): Promise<string> {
  return readFile(schemaPath, 'utf8');
}

describe('Prisma schema', () => {
  test('defines shop-level encrypted Shopify Admin API token storage', async () => {
    const schema = await readSchema();

    expect(schema).toContain('model Shop');
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
    expect(schema).toMatch(/@@unique\(\[shopDomain\]\)/);
  });

  test('defines core delivery operation models and idempotency constraints', async () => {
    const schema = await readSchema();

    for (const modelName of [
      'ShopifyWebhookEvent',
      'CommerceConnection',
      'CommerceConnectionAuditLog',
      'CommerceSyncRun',
      'CommerceRawOrderIngest',
      'WordPressPluginToken',
      'WordPressPluginPairingCode',
      'Order',
      'DeliveryStop',
      'RoutePlan',
      'RoutePlanStop',
      'Driver',
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
    expect(schema).toMatch(/@@index\(\[shopId, sourcePlatform, sourceSiteUrl, sourceOrderNumber\]/);
    expect(schema).toMatch(/@@unique\(\[routePlanId, sequence\]/);
    expect(schema).toMatch(/@@unique\(\[routePlanId, deliveryStopId\]/);
    expect(schema).toContain('enum DriverConsentType');
    expect(schema).toContain('enum DriverProofMediaKind');
    expect(schema).toContain('enum DriverProofMediaSource');
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
});
