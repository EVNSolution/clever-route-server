import type { PrismaClient } from '@prisma/client';

import { PrismaCommerceConnectionRepository } from '../commerce/commerce-connection.repository.js';
import { assertHttpsWooSiteUrl, assertResolvedWooSiteHostIsPublic } from '../commerce/woocommerce-connection-verifier.js';
import { CommerceConnectionCredentialService } from '../commerce/commerce-connection.service.js';
import { loadCredentialEncryptionKey } from '../commerce/commerce-credential-encryption.js';
import { PrismaOrderSyncRepository } from '../shopify/order-sync.repository.js';
import { createWooCommerceOrderClientFromConnection } from '../woocommerce/woocommerce-order.client.js';
import { WooCommerceOrderSyncService } from '../woocommerce/woocommerce-order-sync.service.js';
import type { WordPressPluginDependencies } from '../../routes/wordpress-plugin.routes.js';
import { WordPressPluginAuthService } from './wordpress-plugin-auth.service.js';
import { PrismaWordPressPluginRepository } from './wordpress-plugin.repository.js';
import { WordPressPluginSyncRequestService } from './wordpress-plugin-sync.service.js';

export type WordPressPluginRuntimeEnv = Partial<
  Record<'CREDENTIAL_ENCRYPTION_KEY' | 'WOOCOMMERCE_SHOP_TIMEZONE', string>
>;

export function loadWordPressPluginDependencies(input: {
  env: WordPressPluginRuntimeEnv;
  prisma: PrismaClient;
}): WordPressPluginDependencies | undefined {
  const rawCredentialKey = readOptional(input.env.CREDENTIAL_ENCRYPTION_KEY);
  if (rawCredentialKey === undefined) {
    return undefined;
  }

  const credentialKey = loadCredentialEncryptionKey(rawCredentialKey);
  const shopTimezone = readOptional(input.env.WOOCOMMERCE_SHOP_TIMEZONE);
  const connectionRepository = new PrismaCommerceConnectionRepository(input.prisma, {
    createMissingShop: true
  });
  const connectionService = new CommerceConnectionCredentialService({
    credentialKey,
    repository: connectionRepository
  });
  const orderRepository = new PrismaOrderSyncRepository(input.prisma, {
    allowAnyShopDomain: true,
    createMissingShop: true
  });
  const wordpressRepository = new PrismaWordPressPluginRepository(input.prisma);
  const authService = new WordPressPluginAuthService({ repository: wordpressRepository });

  return {
    authService,
    mappingService: {
      readMapping: () => Promise.resolve(wordpressRepository.readMapping())
    },
    routeResultService: wordpressRepository,
    syncService: new WordPressPluginSyncRequestService({
      connectionService,
      validateConnectionSiteUrl: async ({ connection }) => {
        const siteUrl = assertHttpsWooSiteUrl(connection.siteUrl);
        await assertResolvedWooSiteHostIsPublic(siteUrl);
      },
      createOrderSyncService: ({ connection }) => {
        const resolvedTimezone = connection.timezone ?? shopTimezone;
        return new WooCommerceOrderSyncService({
          client: createWooCommerceOrderClientFromConnection(connection),
          repository: orderRepository,
          shopDomain: connection.shopDomain,
          ...(resolvedTimezone === undefined ? {} : { shopTimezone: resolvedTimezone }),
          siteUrl: connection.siteUrl
        });
      },
      freshnessRepository: wordpressRepository
    })
  };
}

function readOptional(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  return value.trim();
}
