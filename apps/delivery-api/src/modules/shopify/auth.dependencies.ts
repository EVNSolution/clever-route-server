import type { PrismaClient } from '@prisma/client';

import { loadTokenEncryptionKey } from '../security/token-encryption.js';
import { loadShopifyAppCredentials, type ShopifyAppCredentialsEnv } from './shopify-app-credentials.js';
import { PrismaShopTokenRepository } from './shop-token.repository.js';
import { ShopTokenService } from './shop-token.service.js';
import { ShopifySessionTokenVerifier } from './session-token-verifier.js';
import { loadShopifyTokenExchangeTimeoutMs, ShopifyTokenExchangeClient } from './token-exchange.client.js';
import { DEFAULT_SHOPIFY_ADMIN_API_VERSION } from './shopify-api-version.js';
import type { ShopifyAuthDependencies } from '../../routes/shopify-auth.routes.js';

export type ShopifyAuthRuntimeEnv = ShopifyAppCredentialsEnv &
  Partial<Record<'SHOPIFY_API_VERSION' | 'SHOPIFY_TOKEN_ENCRYPTION_KEY' | 'SHOPIFY_TOKEN_EXCHANGE_TIMEOUT_MS', string>>;

type CreateShopifyAuthDependenciesInput = {
  env: ShopifyAuthRuntimeEnv;
  fetchImpl?: typeof fetch;
  orderReconciliationService?: ShopifyAuthDependencies['orderReconciliationService'];
  prisma: PrismaClient;
};

export function loadShopifyAuthDependencies(
  input: CreateShopifyAuthDependenciesInput
): ShopifyAuthDependencies | undefined {
  const appCredentials = loadShopifyAppCredentials(input.env);
  const encryptionKey = readOptional(input.env.SHOPIFY_TOKEN_ENCRYPTION_KEY);

  if (appCredentials.length === 0 || encryptionKey === undefined) {
    return undefined;
  }

  const apiVersion = readOptional(input.env.SHOPIFY_API_VERSION) ?? DEFAULT_SHOPIFY_ADMIN_API_VERSION;
  const repository = new PrismaShopTokenRepository(input.prisma);
  const shopTokenService = new ShopTokenService({
    encryptionKey: loadTokenEncryptionKey(encryptionKey),
    repository
  });

  return {
    apiVersion,
    ...(input.orderReconciliationService === undefined
      ? {}
      : { orderReconciliationService: input.orderReconciliationService }),
    sessionTokenVerifier: new ShopifySessionTokenVerifier({ appCredentials }),
    shopTokenService,
    tokenExchangeClient: new ShopifyTokenExchangeClient(
      input.fetchImpl === undefined
        ? { appCredentials, timeoutMs: loadShopifyTokenExchangeTimeoutMs(input.env.SHOPIFY_TOKEN_EXCHANGE_TIMEOUT_MS) }
        : { appCredentials, fetchImpl: input.fetchImpl, timeoutMs: loadShopifyTokenExchangeTimeoutMs(input.env.SHOPIFY_TOKEN_EXCHANGE_TIMEOUT_MS) }
    )
  };
}

function readOptional(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }

  return value.trim();
}
