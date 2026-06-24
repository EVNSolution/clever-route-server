import type { PrismaClient } from '@prisma/client';

import type { ShopifyWebhookDependencies } from '../../routes/shopify-webhook.routes.js';
import { DEFAULT_SHOPIFY_APP_ID } from './shopify-app-scope.js';
import { loadShopifyAppCredentials, type ShopifyAppCredentialsEnv } from './shopify-app-credentials.js';
import { PrismaShopifyWebhookEventRepository } from './webhook-event.repository.js';

export type ShopifyWebhookRuntimeEnv = ShopifyAppCredentialsEnv & Partial<Record<'SHOPIFY_WEBHOOK_SECRET', string>>;

type LoadShopifyWebhookDependenciesInput = {
  env: ShopifyWebhookRuntimeEnv;
  prisma: PrismaClient;
};

export function loadShopifyWebhookDependencies(
  input: LoadShopifyWebhookDependenciesInput
): ShopifyWebhookDependencies | undefined {
  const appCredentials = loadShopifyAppCredentials(input.env).map(({ appId, clientSecret }) => ({
    appId,
    clientSecret
  }));
  const legacyWebhookSecret =
    readOptional(input.env.SHOPIFY_WEBHOOK_SECRET) ?? readOptional(input.env.SHOPIFY_API_SECRET);
  if (appCredentials.length === 0 && legacyWebhookSecret !== undefined) {
    appCredentials.push({ appId: DEFAULT_SHOPIFY_APP_ID, clientSecret: legacyWebhookSecret });
  }
  if (appCredentials.length === 0) {
    return undefined;
  }

  return {
    appCredentials,
    webhookService: new PrismaShopifyWebhookEventRepository(input.prisma)
  };
}

function readOptional(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  return value.trim();
}
