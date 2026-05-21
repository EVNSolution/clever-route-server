import type { PrismaClient } from '@prisma/client';

import type { ShopifyWebhookDependencies } from '../../routes/shopify-webhook.routes.js';
import { PrismaShopifyWebhookEventRepository } from './webhook-event.repository.js';

export type ShopifyWebhookRuntimeEnv = Partial<Record<'SHOPIFY_API_SECRET', string>>;

type LoadShopifyWebhookDependenciesInput = {
  env: ShopifyWebhookRuntimeEnv;
  prisma: PrismaClient;
};

export function loadShopifyWebhookDependencies(
  input: LoadShopifyWebhookDependenciesInput
): ShopifyWebhookDependencies | undefined {
  const clientSecret = readOptional(input.env.SHOPIFY_API_SECRET);
  if (clientSecret === undefined) {
    return undefined;
  }

  return {
    clientSecret,
    webhookService: new PrismaShopifyWebhookEventRepository(input.prisma)
  };
}

function readOptional(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }

  return value.trim();
}
