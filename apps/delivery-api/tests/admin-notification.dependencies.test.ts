import type { PrismaClient } from '@prisma/client';
import { describe, expect, test, vi } from 'vitest';

import { loadAdminOrdersDependencies } from '../src/modules/shopify/order-sync.dependencies.js';
import { loadWooCommerceWebhookDependencies } from '../src/modules/woocommerce/woocommerce.dependencies.js';
import { loadWordPressPluginDependencies } from '../src/modules/wordpress-plugin/wordpress-plugin.dependencies.js';
import type { AdminNotificationServiceContract } from '../src/modules/notifications/admin-notification.service.js';
import type { DecryptedWooCommerceConnection } from '../src/modules/commerce/commerce-connection.service.js';

const CREDENTIAL_KEY = `base64:${Buffer.alloc(32, 7).toString('base64')}`;

function notificationService(): AdminNotificationServiceContract {
  const service: AdminNotificationServiceContract = {
    createAdminNotification: vi.fn(),
    listNotifications: vi.fn(),
    markNotificationRead: vi.fn(),
    subscribeToNotificationChanges: vi.fn(),
  };
  return service;
}

function prisma(): PrismaClient {
  return {} as PrismaClient;
}

function connection(): DecryptedWooCommerceConnection {
  return {
    consumerKey: 'ck_test',
    consumerSecret: 'cs_test',
    credential: { fingerprint: null, rotatedAt: null, status: 'stored' },
    id: 'connection-id',
    label: null,
    lastRestSyncAt: null,
    lastWebhookAt: null,
    shopDomain: 'example.myshopify.com',
    siteUrl: 'https://woo.example.test',
    status: 'ACTIVE',
    timezone: null,
    verification: { lastVerifiedAt: null, status: null },
    webhook: { rotatedAt: null, status: 'stored' },
    webhookSecret: 'whsec_test',
  };
}

type RepositoryCarrier = {
  options: {
    repository: {
      options?: {
        notificationService?: AdminNotificationServiceContract;
      };
    };
  };
};

type WordPressSyncCarrier = {
  dependencies: {
    createOrderSyncService(input: {
      connection: DecryptedWooCommerceConnection;
    }): RepositoryCarrier;
  };
};

describe('admin notification dependency wiring', () => {
  test('threads the shared notification service into admin Shopify order sync', () => {
    const service = notificationService();
    const dependencies = loadAdminOrdersDependencies({
      adminNotificationService: service,
      env: { SHOPIFY_API_KEY: 'api-key', SHOPIFY_API_SECRET: 'api-secret' },
      prisma: prisma(),
    });

    const carrier = dependencies?.orderSyncService as unknown as RepositoryCarrier;
    expect(carrier.options.repository.options?.notificationService).toBe(service);
  });

  test('threads the shared notification service into WooCommerce webhook order sync', () => {
    const service = notificationService();
    const dependencies = loadWooCommerceWebhookDependencies({
      adminNotificationService: service,
      env: { CREDENTIAL_ENCRYPTION_KEY: CREDENTIAL_KEY },
      prisma: prisma(),
    });

    const orderSyncService = dependencies?.createOrderSyncService({
      connection: connection(),
    }) as unknown as RepositoryCarrier;
    expect(orderSyncService.options.repository.options?.notificationService).toBe(service);
  });

  test('threads the shared notification service into WordPress plugin order sync', () => {
    const service = notificationService();
    const dependencies = loadWordPressPluginDependencies({
      adminNotificationService: service,
      env: { CREDENTIAL_ENCRYPTION_KEY: CREDENTIAL_KEY },
      prisma: prisma(),
    });

    const carrier = dependencies?.syncService as unknown as WordPressSyncCarrier;
    const orderSyncService = carrier.dependencies.createOrderSyncService({
      connection: connection(),
    });
    expect(orderSyncService.options.repository.options?.notificationService).toBe(service);
  });
});
