import type { PrismaClient } from '@prisma/client';

import type { AdminInventoryDependencies } from '../../routes/admin-inventories.routes.js';
import { loadShopifyAppCredentials, type ShopifyAppCredentialsEnv } from '../shopify/shopify-app-credentials.js';
import { ShopifySessionTokenVerifier } from '../shopify/session-token-verifier.js';
import { PrismaInventoryService } from './inventory.service.js';

export type AdminInventoryRuntimeEnv = ShopifyAppCredentialsEnv;

export function loadAdminInventoryDependencies(input: {
  env: AdminInventoryRuntimeEnv;
  prisma: PrismaClient;
}): AdminInventoryDependencies | undefined {
  const appCredentials = loadShopifyAppCredentials(input.env);
  if (appCredentials.length === 0) return undefined;
  return {
    inventoryService: new PrismaInventoryService(input.prisma),
    sessionTokenVerifier: new ShopifySessionTokenVerifier({ appCredentials })
  };
}
