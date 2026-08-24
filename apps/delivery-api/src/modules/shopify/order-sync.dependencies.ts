import type { PrismaClient } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';

import { loadShopifyAppCredentials, type ShopifyAppCredentialsEnv } from './shopify-app-credentials.js';
import { ShopifyAdminGraphqlClient } from './admin-graphql.client.js';
import { PrismaShopifyOrderReconciliationRepository } from './order-reconciliation.repository.js';
import { ShopifyOrderReconciliationService } from './order-reconciliation.service.js';
import { ShopifyOrderReconciliationWorker } from './order-reconciliation.worker.js';
import { PrismaOrderSyncRepository } from './order-sync.repository.js';
import { PrismaOrderQueryRepository } from './order-query.repository.js';
import { ShopifyOrderSyncService } from './order-sync.service.js';
import { ShopifySessionTokenVerifier } from './session-token-verifier.js';
import { loadTokenEncryptionKey } from '../security/token-encryption.js';
import type { AdminNotificationServiceApi } from '../notifications/admin-notification.service.js';
import type { AdminOrdersDependencies } from '../../routes/admin-orders.routes.js';
import { PrismaShopTokenRepository } from './shop-token.repository.js';
import { ShopTokenService } from './shop-token.service.js';
import { loadShopifyTokenExchangeTimeoutMs, ShopifyTokenExchangeClient } from './token-exchange.client.js';
import { DEFAULT_SHOPIFY_ADMIN_API_VERSION } from './shopify-api-version.js';

export type AdminOrdersRuntimeEnv = ShopifyAppCredentialsEnv & Partial<Record<
  | 'CLEVER_ORDERS_MAP_PROJECTION'
  | 'CLEVER_ORDERS_SELECTION_SNAPSHOTS'
  | 'CLEVER_ORDERS_SERVER_PAGINATION'
  | 'CLEVER_SHOPIFY_ORDER_RECONCILIATION_WORKER'
  | 'ORDERS_PAGINATION_HMAC_KEY'
  | 'SHOPIFY_API_VERSION'
  | 'SHOPIFY_TOKEN_EXCHANGE_TIMEOUT_MS'
  | 'SHOPIFY_TOKEN_ENCRYPTION_KEY',
  string
>>;

export function loadAdminOrdersDependencies(input: {
  adminNotificationService?: AdminNotificationServiceApi | undefined;
  env: AdminOrdersRuntimeEnv;
  prisma: PrismaClient;
}): AdminOrdersDependencies | undefined {
  return loadAdminOrdersRuntime(input)?.dependencies;
}

export function loadAdminOrdersRuntime(input: {
  adminNotificationService?: AdminNotificationServiceApi | undefined;
  env: AdminOrdersRuntimeEnv;
  logger?: Pick<FastifyBaseLogger, 'error' | 'info'> | undefined;
  prisma: PrismaClient;
}): {
  dependencies: AdminOrdersDependencies;
  reconciliationService?: ShopifyOrderReconciliationService;
  reconciliationWorker?: ShopifyOrderReconciliationWorker;
} | undefined {
  const appCredentials = loadShopifyAppCredentials(input.env);
  if (appCredentials.length === 0) {
    return undefined;
  }

  const apiVersion = readOptional(input.env.SHOPIFY_API_VERSION) ?? DEFAULT_SHOPIFY_ADMIN_API_VERSION;
  const repository = new PrismaOrderSyncRepository(
    input.prisma,
    input.adminNotificationService === undefined
      ? { createMissingShop: true }
      : { createMissingShop: true, notificationService: input.adminNotificationService },
  );
  const paginationSecret = readOptional(input.env.ORDERS_PAGINATION_HMAC_KEY);
  const resourceFlags = resolveAdminOrdersResourceFlags(input.env);
  const orderSyncService = new ShopifyOrderSyncService({
    graphqlClient: {
      request: () => Promise.reject(new Error('Admin GraphQL client is not configured for snapshot sync routes'))
    },
    ...(paginationSecret === undefined ? {} : { queryRepository: new PrismaOrderQueryRepository(input.prisma, paginationSecret) }),
    repository
  });
  const dependencies: AdminOrdersDependencies = {
    ordersMapProjectionEnabled: resourceFlags.mapProjection,
    ordersPaginationEnabled: resourceFlags.pagination,
    ordersSelectionSnapshotsEnabled: resourceFlags.selectionSnapshots,
    orderSyncService,
    sessionTokenVerifier: new ShopifySessionTokenVerifier({ appCredentials })
  };

  const encryptionKey = readOptional(input.env.SHOPIFY_TOKEN_ENCRYPTION_KEY);
  if (encryptionKey === undefined) {
    return { dependencies };
  }

  const reconciliationService = new ShopifyOrderReconciliationService({
    defaultApiVersion: apiVersion,
    graphqlClientFactory: ({ accessToken, apiVersion: graphApiVersion, shopDomain }) =>
      new ShopifyAdminGraphqlClient({ accessToken, apiVersion: graphApiVersion, shopDomain }),
    orderRepository: repository,
    repository: new PrismaShopifyOrderReconciliationRepository(input.prisma),
    shopTokenService: new ShopTokenService({
      encryptionKey: loadTokenEncryptionKey(encryptionKey),
      repository: new PrismaShopTokenRepository(input.prisma),
      tokenRefreshClient: new ShopifyTokenExchangeClient({
        appCredentials,
        timeoutMs: loadShopifyTokenExchangeTimeoutMs(input.env.SHOPIFY_TOKEN_EXCHANGE_TIMEOUT_MS)
      })
    })
  });

  return {
    dependencies: {
      ...dependencies,
      orderReconciliationService: reconciliationService,
      orderSyncService
    },
    reconciliationService,
    reconciliationWorker: new ShopifyOrderReconciliationWorker({
      enabled: readOptional(input.env.CLEVER_SHOPIFY_ORDER_RECONCILIATION_WORKER) !== '0',
      service: reconciliationService,
      ...(input.logger === undefined ? {} : { logger: input.logger })
    })
  };
}

function readOptional(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }
  return value.trim();
}

export function resolveAdminOrdersResourceFlags(env: AdminOrdersRuntimeEnv): {
  mapProjection: boolean;
  pagination: boolean;
  selectionSnapshots: boolean;
} {
  const pagination = enabled(env.CLEVER_ORDERS_SERVER_PAGINATION) && readOptional(env.ORDERS_PAGINATION_HMAC_KEY) !== undefined;
  return {
    mapProjection: pagination && enabled(env.CLEVER_ORDERS_MAP_PROJECTION),
    pagination,
    selectionSnapshots: pagination && enabled(env.CLEVER_ORDERS_SELECTION_SNAPSHOTS)
  };
}

function enabled(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/iu.test(value ?? '');
}
