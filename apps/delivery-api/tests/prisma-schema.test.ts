import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

const schemaPath = new URL('../prisma/schema.prisma', import.meta.url);
const commerceConnectionMigrationPath = new URL(
  '../prisma/migrations/20260521074000_add_commerce_connections/migration.sql',
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
    expect(schema).toMatch(/@@unique\(\[shopDomain\]\)/);
  });

  test('defines core delivery operation models and idempotency constraints', async () => {
    const schema = await readSchema();

    for (const modelName of [
      'ShopifyWebhookEvent',
      'CommerceConnection',
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
    expect(schema).toContain('commerceConnections');
    expect(schema).toContain('consumerKeyCiphertext');
    expect(schema).toContain('consumerSecretCiphertext');
    expect(schema).toContain('webhookSecretCiphertext');
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
});
