import type { PrismaClient } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';

import type { ShopifyWebhookDependencies } from '../../routes/shopify-webhook.routes.js';
import { loadTokenEncryptionKey } from '../security/token-encryption.js';
import { ShopifyAdminGraphqlClient } from './admin-graphql.client.js';
import { PrismaOrderSyncRepository } from './order-sync.repository.js';
import { ShopifyOrderWebhookProcessor } from './order-webhook.processor.js';
import { ShopifyOrderWebhookWorker } from './order-webhook.worker.js';
import { DEFAULT_SHOPIFY_APP_ID } from './shopify-app-scope.js';
import { loadShopifyAppCredentials, type ShopifyAppCredentialsEnv } from './shopify-app-credentials.js';
import { PrismaShopTokenRepository } from './shop-token.repository.js';
import { ShopTokenService } from './shop-token.service.js';
import { loadShopifyTokenExchangeTimeoutMs, ShopifyTokenExchangeClient } from './token-exchange.client.js';
import { PrismaShopifyWebhookEventRepository } from './webhook-event.repository.js';
import { DEFAULT_SHOPIFY_ADMIN_API_VERSION } from './shopify-api-version.js';

export type ShopifyWebhookRuntimeEnv = ShopifyAppCredentialsEnv &
  Partial<Record<'CLEVER_SHOPIFY_ORDER_WEBHOOK_WORKER' | 'SHOPIFY_API_VERSION' | 'SHOPIFY_TOKEN_ENCRYPTION_KEY' | 'SHOPIFY_TOKEN_EXCHANGE_TIMEOUT_MS' | 'SHOPIFY_WEBHOOK_BODY_LIMIT_BYTES' | 'SHOPIFY_WEBHOOK_SECRET', string>>;

const DEFAULT_SHOPIFY_WEBHOOK_BODY_LIMIT_BYTES = 5 * 1024 * 1024;
const MIN_SHOPIFY_WEBHOOK_BODY_LIMIT_BYTES = 1024 * 1024;
const MAX_SHOPIFY_WEBHOOK_BODY_LIMIT_BYTES = 10 * 1024 * 1024;

type LoadShopifyWebhookDependenciesInput = {
  env: ShopifyWebhookRuntimeEnv;
  prisma: PrismaClient;
};

export function loadShopifyWebhookDependencies(
  input: LoadShopifyWebhookDependenciesInput
): ShopifyWebhookDependencies | undefined {
  return loadShopifyWebhookRuntime(input)?.dependencies;
}

export function loadShopifyWebhookRuntime(
  input: LoadShopifyWebhookDependenciesInput & { logger?: Pick<FastifyBaseLogger, 'error' | 'info'> }
): { dependencies: ShopifyWebhookDependencies; worker?: ShopifyOrderWebhookWorker } | undefined {
  const shopifyAppCredentials = loadShopifyAppCredentials(input.env);
  const appCredentials = shopifyAppCredentials.map(({ appId, clientSecret }) => ({
    appId,
    clientSecret
  }));
  const legacyWebhookSecret =
    readOptional(input.env.SHOPIFY_WEBHOOK_SECRET) ?? readOptional(input.env.SHOPIFY_API_SECRET);
  if (appCredentials.length === 0 && legacyWebhookSecret !== undefined) {
    appCredentials.push({ appId: DEFAULT_SHOPIFY_APP_ID, clientSecret: legacyWebhookSecret });
  }
  if (appCredentials.length === 0) {
    return undefined;
  }

  const webhookService = new PrismaShopifyWebhookEventRepository(input.prisma);
  const encryptionKey = readOptional(input.env.SHOPIFY_TOKEN_ENCRYPTION_KEY);
  const bodyLimitBytes = loadShopifyWebhookBodyLimitBytes(input.env.SHOPIFY_WEBHOOK_BODY_LIMIT_BYTES);

  if (encryptionKey === undefined) {
    return {
      dependencies: {
        appCredentials,
        bodyLimitBytes,
        webhookService
      }
    };
  }

  const processor = new ShopifyOrderWebhookProcessor({
    defaultApiVersion: readOptional(input.env.SHOPIFY_API_VERSION) ?? DEFAULT_SHOPIFY_ADMIN_API_VERSION,
    eventStore: webhookService,
    graphqlClientFactory: ({ accessToken, apiVersion, shopDomain }) =>
      new ShopifyAdminGraphqlClient({ accessToken, apiVersion, shopDomain }),
    orderRepository: new PrismaOrderSyncRepository(input.prisma),
    shopTokenService: new ShopTokenService({
      encryptionKey: loadTokenEncryptionKey(encryptionKey),
      repository: new PrismaShopTokenRepository(input.prisma),
      tokenRefreshClient: new ShopifyTokenExchangeClient({
        appCredentials: shopifyAppCredentials,
        timeoutMs: loadShopifyTokenExchangeTimeoutMs(input.env.SHOPIFY_TOKEN_EXCHANGE_TIMEOUT_MS)
      })
    })
  });

  return {
    dependencies: {
      appCredentials,
      bodyLimitBytes,
      orderWebhookProcessor: processor,
      webhookService
    },
    worker: new ShopifyOrderWebhookWorker({
      enabled: readOptional(input.env.CLEVER_SHOPIFY_ORDER_WEBHOOK_WORKER) !== '0',
      processor,
      ...(input.logger === undefined ? {} : { logger: input.logger })
    })
  };
}

export function loadShopifyWebhookBodyLimitBytes(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return DEFAULT_SHOPIFY_WEBHOOK_BODY_LIMIT_BYTES;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < MIN_SHOPIFY_WEBHOOK_BODY_LIMIT_BYTES || parsed > MAX_SHOPIFY_WEBHOOK_BODY_LIMIT_BYTES) {
    throw new Error(`SHOPIFY_WEBHOOK_BODY_LIMIT_BYTES must be an integer between ${MIN_SHOPIFY_WEBHOOK_BODY_LIMIT_BYTES} and ${MAX_SHOPIFY_WEBHOOK_BODY_LIMIT_BYTES}`);
  }
  return parsed;
}

function readOptional(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  return value.trim();
}
