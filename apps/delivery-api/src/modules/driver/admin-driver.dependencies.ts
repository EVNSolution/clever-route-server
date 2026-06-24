import type { PrismaClient } from '@prisma/client';

import { loadShopifyAppCredentials, type ShopifyAppCredentialsEnv } from '../shopify/shopify-app-credentials.js';
import { ShopifySessionTokenVerifier } from '../shopify/session-token-verifier.js';
import { PrismaAdminDriverRepository } from './admin-driver.repository.js';
import { AdminDriverService } from './admin-driver.service.js';
import type { AdminDriversDependencies } from '../../routes/admin-drivers.routes.js';

export type AdminDriverRuntimeEnv = ShopifyAppCredentialsEnv;

export function loadAdminDriverDependencies(input: {
  env: AdminDriverRuntimeEnv;
  prisma: PrismaClient;
}): AdminDriversDependencies | undefined {
  const appCredentials = loadShopifyAppCredentials(input.env);

  if (appCredentials.length === 0) {
    return undefined;
  }

  const repository = new PrismaAdminDriverRepository(input.prisma);
  return {
    adminDriverService: new AdminDriverService(repository),
    sessionTokenVerifier: new ShopifySessionTokenVerifier({ appCredentials })
  };
}
