import type { PrismaClient } from '@prisma/client';

import { ShopifySessionTokenVerifier } from '../shopify/session-token-verifier.js';
import { PrismaAdminDriverRepository } from './admin-driver.repository.js';
import { AdminDriverService } from './admin-driver.service.js';
import type { AdminDriversDependencies } from '../../routes/admin-drivers.routes.js';

export type AdminDriverRuntimeEnv = Partial<Record<'SHOPIFY_API_KEY' | 'SHOPIFY_API_SECRET', string>>;

export function loadAdminDriverDependencies(input: {
  env: AdminDriverRuntimeEnv;
  prisma: PrismaClient;
}): AdminDriversDependencies | undefined {
  const apiKey = readOptional(input.env.SHOPIFY_API_KEY);
  const apiSecret = readOptional(input.env.SHOPIFY_API_SECRET);

  if (apiKey === undefined || apiSecret === undefined) {
    return undefined;
  }

  const repository = new PrismaAdminDriverRepository(input.prisma);
  return {
    adminDriverService: new AdminDriverService(repository),
    sessionTokenVerifier: new ShopifySessionTokenVerifier({ clientId: apiKey, clientSecret: apiSecret })
  };
}

function readOptional(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }

  return value.trim();
}
