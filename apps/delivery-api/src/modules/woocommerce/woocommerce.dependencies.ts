import type { PrismaClient } from '@prisma/client';

import { PrismaOrderSyncRepository } from '../shopify/order-sync.repository.js';
import type { WooCommerceWebhookDependencies } from '../../routes/woocommerce-webhook.routes.js';
import { WooCommerceOrderClient } from './woocommerce-order.client.js';
import { WooCommerceOrderSyncService } from './woocommerce-order-sync.service.js';

export type WooCommerceRuntimeEnv = Partial<
  Record<
    | 'WOOCOMMERCE_CONSUMER_KEY'
    | 'WOOCOMMERCE_CONSUMER_SECRET'
    | 'WOOCOMMERCE_SHOP_DOMAIN'
    | 'WOOCOMMERCE_SITE_URL'
    | 'WOOCOMMERCE_WEBHOOK_SECRET'
    | 'WOOCOMMERCE_SHOP_TIMEZONE',
    string
  >
>;

export function loadWooCommerceWebhookDependencies(input: {
  env: WooCommerceRuntimeEnv;
  prisma: PrismaClient;
}): WooCommerceWebhookDependencies | undefined {
  const siteUrl = readOptional(input.env.WOOCOMMERCE_SITE_URL);
  const webhookSecret = readOptional(input.env.WOOCOMMERCE_WEBHOOK_SECRET);
  if (siteUrl === undefined || webhookSecret === undefined) {
    return undefined;
  }

  const consumerKey = readOptional(input.env.WOOCOMMERCE_CONSUMER_KEY);
  const consumerSecret = readOptional(input.env.WOOCOMMERCE_CONSUMER_SECRET);
  const shopTimezone = readOptional(input.env.WOOCOMMERCE_SHOP_TIMEZONE);
  const repository = new PrismaOrderSyncRepository(input.prisma, {
    allowAnyShopDomain: true,
    createMissingShop: true
  });
  const orderSyncService = new WooCommerceOrderSyncService({
    ...(consumerKey !== undefined && consumerSecret !== undefined
      ? { client: new WooCommerceOrderClient({ consumerKey, consumerSecret, siteUrl }) }
      : {}),
    repository,
    shopDomain: readOptional(input.env.WOOCOMMERCE_SHOP_DOMAIN) ?? hostFromSiteUrl(siteUrl),
    ...(shopTimezone === undefined ? {} : { shopTimezone }),
    siteUrl
  });

  return { orderSyncService, siteUrl, webhookSecret };
}

function hostFromSiteUrl(value: string): string {
  const withProtocol = /^https?:\/\//iu.test(value) ? value : `https://${value}`;
  return new URL(withProtocol).host.toLowerCase();
}

function readOptional(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  return value.trim();
}
