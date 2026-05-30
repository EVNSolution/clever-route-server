import type { PrismaClient } from '@prisma/client';

import { loadCredentialEncryptionKey } from '../commerce/commerce-credential-encryption.js';
import { PrismaCommerceConnectionRepository } from '../commerce/commerce-connection.repository.js';
import { CommerceConnectionCredentialService } from '../commerce/commerce-connection.service.js';
import { loadGeocodingService } from '../geocoding/geocoding.dependencies.js';
import { PrismaOrderSyncRepository } from '../shopify/order-sync.repository.js';
import type { WooCommerceWebhookDependencies } from '../../routes/woocommerce-webhook.routes.js';
import { createWooCommerceOrderClientFromConnection } from './woocommerce-order.client.js';
import { WooCommerceOrderSyncService } from './woocommerce-order-sync.service.js';

export type WooCommerceRuntimeEnv = Partial<
  Record<
    | 'CREDENTIAL_ENCRYPTION_KEY'
    | 'GEOCODING_CACHE_TTL_DAYS'
    | 'GEOCODING_PROVIDER_MODE'
    | 'GEOCODING_PUBLIC_BULK_MAX_ATTEMPTS'
    | 'GEOCODING_RATE_LIMIT_PER_SECOND'
    | 'GEOCODING_SEARCH_URL'
    | 'GEOCODING_TIMEOUT_MS'
    | 'GEOCODING_USER_AGENT'
    | 'WOOCOMMERCE_SHOP_TIMEZONE',
    string
  >
>;

export function loadWooCommerceWebhookDependencies(input: {
  env: WooCommerceRuntimeEnv;
  prisma: PrismaClient;
}): WooCommerceWebhookDependencies | undefined {
  const rawCredentialKey = readOptional(input.env.CREDENTIAL_ENCRYPTION_KEY);
  if (rawCredentialKey === undefined) {
    return undefined;
  }

  const credentialKey = loadCredentialEncryptionKey(rawCredentialKey);
  const shopTimezone = readOptional(input.env.WOOCOMMERCE_SHOP_TIMEZONE);
  const orderRepository = new PrismaOrderSyncRepository(input.prisma, {
    allowAnyShopDomain: true,
    createMissingShop: true
  });
  const connectionRepository = new PrismaCommerceConnectionRepository(input.prisma, {
    createMissingShop: true
  });
  const connectionService = new CommerceConnectionCredentialService({
    credentialKey,
    repository: connectionRepository
  });
  const geocodingService = loadGeocodingService({ env: input.env });

  return {
    connectionService,
    createOrderSyncService: ({ connection }) => {
      const resolvedTimezone = connection.timezone ?? shopTimezone;
      return new WooCommerceOrderSyncService({
        client: createWooCommerceOrderClientFromConnection(connection),
        connectionId: connection.id,
        geocodingService,
        repository: orderRepository,
        shopDomain: connection.shopDomain,
        ...(resolvedTimezone === undefined ? {} : { shopTimezone: resolvedTimezone }),
        siteUrl: connection.siteUrl
      });
    }
  };
}

function readOptional(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  return value.trim();
}
