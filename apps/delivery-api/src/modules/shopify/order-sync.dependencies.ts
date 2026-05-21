import type { PrismaClient } from '@prisma/client';

import { PrismaOrderSyncRepository } from './order-sync.repository.js';
import { ShopifyOrderSyncService } from './order-sync.service.js';
import { ShopifySessionTokenVerifier } from './session-token-verifier.js';
import type { AdminOrdersDependencies } from '../../routes/admin-orders.routes.js';

const DEFAULT_SHOPIFY_API_VERSION = '2026-04';

export type AdminOrdersRuntimeEnv = Partial<
  Record<'SHOPIFY_API_KEY' | 'SHOPIFY_API_SECRET' | 'SHOPIFY_API_VERSION', string>
>;

export function loadAdminOrdersDependencies(input: {
  env: AdminOrdersRuntimeEnv;
  prisma: PrismaClient;
}): AdminOrdersDependencies | undefined {
  const apiKey = readOptional(input.env.SHOPIFY_API_KEY);
  const apiSecret = readOptional(input.env.SHOPIFY_API_SECRET);
  if (apiKey === undefined || apiSecret === undefined) {
    return undefined;
  }

  const apiVersion = readOptional(input.env.SHOPIFY_API_VERSION) ?? DEFAULT_SHOPIFY_API_VERSION;
  void apiVersion;
  const repository = new PrismaOrderSyncRepository(input.prisma);
  return {
    orderSyncService: new ShopifyOrderSyncService({
      graphqlClient: {
        request: () => Promise.reject(new Error('Admin GraphQL client is not configured for snapshot sync routes'))
      },
      repository
    }),
    sessionTokenVerifier: new ShopifySessionTokenVerifier({ clientId: apiKey, clientSecret: apiSecret })
  };
}

function readOptional(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }
  return value.trim();
}
