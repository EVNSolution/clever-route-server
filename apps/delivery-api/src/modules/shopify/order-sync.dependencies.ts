import type { PrismaClient } from '@prisma/client';

import { loadShopifyAppCredentials, type ShopifyAppCredentialsEnv } from './shopify-app-credentials.js';
import { PrismaOrderSyncRepository } from './order-sync.repository.js';
import { ShopifyOrderSyncService } from './order-sync.service.js';
import { ShopifySessionTokenVerifier } from './session-token-verifier.js';
import type { AdminNotificationServiceApi } from '../notifications/admin-notification.service.js';
import type { AdminOrdersDependencies } from '../../routes/admin-orders.routes.js';

const DEFAULT_SHOPIFY_API_VERSION = '2026-04';

export type AdminOrdersRuntimeEnv = ShopifyAppCredentialsEnv & Partial<Record<'SHOPIFY_API_VERSION', string>>;

export function loadAdminOrdersDependencies(input: {
  adminNotificationService?: AdminNotificationServiceApi | undefined;
  env: AdminOrdersRuntimeEnv;
  prisma: PrismaClient;
}): AdminOrdersDependencies | undefined {
  const appCredentials = loadShopifyAppCredentials(input.env);
  if (appCredentials.length === 0) {
    return undefined;
  }

  const apiVersion = readOptional(input.env.SHOPIFY_API_VERSION) ?? DEFAULT_SHOPIFY_API_VERSION;
  void apiVersion;
  const repository = new PrismaOrderSyncRepository(
    input.prisma,
    input.adminNotificationService === undefined
      ? { createMissingShop: true }
      : { createMissingShop: true, notificationService: input.adminNotificationService },
  );
  return {
    orderSyncService: new ShopifyOrderSyncService({
      graphqlClient: {
        request: () => Promise.reject(new Error('Admin GraphQL client is not configured for snapshot sync routes'))
      },
      repository
    }),
    sessionTokenVerifier: new ShopifySessionTokenVerifier({ appCredentials })
  };
}

function readOptional(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }
  return value.trim();
}
