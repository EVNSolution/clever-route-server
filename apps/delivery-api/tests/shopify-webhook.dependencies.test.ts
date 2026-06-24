import type { PrismaClient } from '@prisma/client';
import { describe, expect, test } from 'vitest';

import { loadShopifyWebhookDependencies } from '../src/modules/shopify/webhook.dependencies.js';

describe('loadShopifyWebhookDependencies', () => {
  test('stays disabled when no Shopify webhook secret material is configured', () => {
    expect(loadShopifyWebhookDependencies({ env: {}, prisma: prisma() })).toBeUndefined();
  });

  test('uses the legacy Shopify API secret as a default webhook-only fallback', () => {
    const dependencies = loadShopifyWebhookDependencies({
      env: { SHOPIFY_API_SECRET: 'shared-secret' },
      prisma: prisma()
    });

    expect(dependencies?.appCredentials).toEqual([
      { appId: 'clever', clientSecret: 'shared-secret' }
    ]);
  });

  test('loads app-specific webhook secrets from Shopify app credentials', () => {
    const dependencies = loadShopifyWebhookDependencies({
      env: {
        SHOPIFY_DEV_API_KEY: 'dev-client-id',
        SHOPIFY_DEV_API_SECRET: 'dev-secret'
      },
      prisma: prisma()
    });

    expect(dependencies?.appCredentials).toEqual([
      { appId: 'clever-route-dev', clientSecret: 'dev-secret' }
    ]);
  });
});

function prisma(): PrismaClient {
  return {} as PrismaClient;
}
