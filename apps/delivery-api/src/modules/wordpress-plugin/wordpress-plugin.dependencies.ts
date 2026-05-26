import type { PrismaClient } from '@prisma/client';

import { PrismaCommerceConnectionRepository } from '../commerce/commerce-connection.repository.js';
import { assertHttpsWooSiteUrl, assertResolvedWooSiteHostIsPublic } from '../commerce/woocommerce-connection-verifier.js';
import { CommerceConnectionCredentialService } from '../commerce/commerce-connection.service.js';
import { loadCredentialEncryptionKey } from '../commerce/commerce-credential-encryption.js';
import { PrismaOrderSyncRepository } from '../shopify/order-sync.repository.js';
import { createWooCommerceOrderClientFromConnection } from '../woocommerce/woocommerce-order.client.js';
import { WooCommerceOrderSyncService } from '../woocommerce/woocommerce-order-sync.service.js';
import type { WordPressPluginDependencies } from '../../routes/wordpress-plugin.routes.js';
import { createAdminWebLaunchToken, isStrongAdminWebSecret } from '../../routes/admin-ui-session.js';
import { WordPressPluginAuthService } from './wordpress-plugin-auth.service.js';
import { PrismaWordPressPluginRepository } from './wordpress-plugin.repository.js';
import { WordPressPluginSyncRequestService } from './wordpress-plugin-sync.service.js';

export type WordPressPluginRuntimeEnv = Partial<
  Record<
    'CLEVER_ADMIN_WEB_SESSION_SECRET' | 'CREDENTIAL_ENCRYPTION_KEY' | 'DELIVERY_API_PUBLIC_URL' | 'WOOCOMMERCE_SHOP_TIMEZONE',
    string
  >
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
    ...readAdminLaunchService(input.env),
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

function readAdminLaunchService(env: WordPressPluginRuntimeEnv): Pick<WordPressPluginDependencies, 'adminLaunchService'> {
  const publicBaseUrl = readOptional(env.DELIVERY_API_PUBLIC_URL)?.replace(/\/+$/u, '');
  const sessionSecret = readOptional(env.CLEVER_ADMIN_WEB_SESSION_SECRET);
  if (publicBaseUrl === undefined || !isStrongAdminWebSecret(sessionSecret)) {
    return {};
  }
  return {
    adminLaunchService: {
      createAdminLaunch: ({ context, section }) => {
        const returnPath = buildAdminLaunchReturnPath({ section, shopDomain: context.shopDomain });
        const launch = createAdminWebLaunchToken({
          returnPath,
          sessionSecret,
          shopDomain: context.shopDomain,
          subject: `wordpress-plugin:${context.shopDomain}`
        });
        const launchUrl = new URL('/admin/ui/plugin-launch', publicBaseUrl);
        launchUrl.searchParams.set('token', launch.token);
        return Promise.resolve({ expiresAt: launch.expiresAt, launchUrl: launchUrl.toString() });
      }
    }
  };
}

function buildAdminLaunchReturnPath(input: {
  section: 'drivers' | 'orders' | 'route-plans' | 'settings';
  shopDomain: string;
}): string {
  const pathBySection = {
    drivers: '/admin/ui/drivers',
    orders: '/admin/ui/orders',
    'route-plans': '/admin/ui/route-plans',
    settings: '/admin/ui/settings'
  } satisfies Record<'drivers' | 'orders' | 'route-plans' | 'settings', string>;
  const params = new URLSearchParams({ shopDomain: input.shopDomain });
  return `${pathBySection[input.section]}?${params.toString()}`;
}

function readOptional(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  return value.trim();
}
