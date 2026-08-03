import { PrismaClient } from '@prisma/client';

import { buildApp } from './app.js';
import { loadEnv } from './config/env.js';
import {
  loadAdminCommerceConnectionsDependencies,
  loadAdminCommerceConnectionsUiDependencies
} from './modules/commerce/admin-commerce-connections.dependencies.js';
import { loadAdminDriverDependencies } from './modules/driver/admin-driver.dependencies.js';
import { loadAdminInventoryDependencies } from './modules/inventory/inventory.dependencies.js';
import { loadAdminCustomerEmailDependencies } from './modules/customer-email/customer-email.dependencies.js';
import { loadDriverApiDependencies } from './modules/driver/driver.dependencies.js';
import { loadDriverAuthDependencies } from './modules/driver/driver-auth.dependencies.js';
import { createRouteGroupingService, loadAdminRouteGroupDependencies } from './modules/route-grouping/route-grouping.dependencies.js';
import { loadAdminRoutePlanDependencies } from './modules/route-plans/route-plan.dependencies.js';
import { createCustomerDeliveryNotificationRuntime } from './modules/route-plans/customer-delivery-notification.runtime.js';
import { loadAdminOrdersDependencies } from './modules/shopify/order-sync.dependencies.js';
import { loadShopifyAuthDependencies } from './modules/shopify/auth.dependencies.js';
import { loadShopifyWebhookDependencies } from './modules/shopify/webhook.dependencies.js';
import { loadWooCommerceWebhookDependencies } from './modules/woocommerce/woocommerce.dependencies.js';
import { createAdminNotificationRuntime } from './modules/notifications/admin-notification.dependencies.js';
import { RouteTrackingStreamHub } from './modules/route-tracking/route-tracking.stream.js';
import { loadDsvControlDependencies } from './modules/dsv/dsv-control.dependencies.js';
import { loadDsvV1ReadDependencies } from './modules/dsv/dsv-v1-read.dependencies.js';
import { loadDsvDriverAuthDependencies } from './modules/dsv/dsv-driver-auth.dependencies.js';
import { loadWordPressPluginDependencies } from './modules/wordpress-plugin/wordpress-plugin.dependencies.js';
import type { AdminRoutePlanDependencies } from './routes/admin-route-plans.routes.js';
import type { AdminRouteGroupDependencies } from './routes/admin-route-groups.routes.js';
import type { AdminDriversDependencies } from './routes/admin-drivers.routes.js';
import type { AdminInventoryDependencies } from './routes/admin-inventories.routes.js';
import type { AdminOrdersDependencies } from './routes/admin-orders.routes.js';
import type { DriverApiDependencies } from './routes/driver-events.routes.js';
import type { DriverAuthDependencies } from './routes/driver-auth.routes.js';
import type { ShopifyAuthDependencies } from './routes/shopify-auth.routes.js';
import type { ShopifyWebhookDependencies } from './routes/shopify-webhook.routes.js';
import type { WooCommerceWebhookDependencies } from './routes/woocommerce-webhook.routes.js';
import type { WordPressPluginDependencies } from './routes/wordpress-plugin.routes.js';
import type { AdminCommerceConnectionsDependencies } from './routes/admin-commerce-connections.routes.js';
import type { AdminCommerceConnectionsUiDependencies } from './routes/admin-commerce-connections-ui.routes.js';
import type { AdminCustomerEmailDependencies } from './routes/admin-customer-email.routes.js';
import type { DsvControlDependencies } from './routes/dsv-control.routes.js';
import type { DsvV1ReadDependencies } from './routes/dsv-v1-read.routes.js';
import type { DsvDriverAuthDependencies } from './routes/dsv-driver-auth.routes.js';

const env = loadEnv();
const prisma = new PrismaClient();
const adminCommerceConnections = loadAdminCommerceConnectionsDependencies({ env: process.env, prisma });
const adminDrivers = loadAdminDriverDependencies({ env: process.env, prisma });
const adminInventories = loadAdminInventoryDependencies({ env: process.env, prisma });
const adminCustomerEmail = loadAdminCustomerEmailDependencies({ env: process.env, prisma });
const routeGroupingService = createRouteGroupingService({ env: process.env, prisma });
const adminRouteGroups = loadAdminRouteGroupDependencies({ env: process.env, prisma, routeGroupingService });
const routeTrackingStreamHub = new RouteTrackingStreamHub();
const adminRoutePlans = loadAdminRoutePlanDependencies({ env: process.env, prisma, routeTrackingStreamHub });
const adminNotificationRuntime = createAdminNotificationRuntime({
  ...(process.env.DATABASE_URL === undefined
    ? {}
    : { databaseUrl: process.env.DATABASE_URL }),
  prisma
});
const adminNotificationService = adminNotificationRuntime.service;
const dsvControl = loadDsvControlDependencies({ env: process.env, nodeEnv: env.nodeEnv, prisma, routeGroupingService });
const dsvDriverAuth = loadDsvDriverAuthDependencies({ env: process.env, nodeEnv: env.nodeEnv, prisma });
const dsvV1Read = loadDsvV1ReadDependencies({ env: process.env, nodeEnv: env.nodeEnv, prisma });
const adminOrders = loadAdminOrdersDependencies({
  adminNotificationService,
  env: process.env,
  prisma
});
const adminCommerceConnectionsUi = loadAdminCommerceConnectionsUiDependencies({
  adminCommerceConnections,
  adminDrivers,
  adminOrders,
  adminRoutePlans,
  adminNotificationService,
  env: process.env,
  nodeEnv: env.nodeEnv,
  prisma
});
const driverApi = loadDriverApiDependencies({
  adminNotificationService,
  env: process.env,
  prisma,
  routeGroupingService,
  routeTrackingStreamHub
});
const driverAuth = loadDriverAuthDependencies({ env: process.env, prisma });
const shopifyAuth = loadShopifyAuthDependencies({ env: process.env, prisma });
const shopifyWebhook = loadShopifyWebhookDependencies({ env: process.env, prisma });
const wooCommerceWebhook = loadWooCommerceWebhookDependencies({
  adminNotificationService,
  env: process.env,
  prisma
});
const wordPressPlugin = loadWordPressPluginDependencies({
  adminNotificationService,
  env: process.env,
  prisma
});
const logger = env.nodeEnv === 'test' ? false : { level: env.logLevel };
const app = await buildApp(
  createBuildAppOptions({
    adminCommerceConnections,
    adminCommerceConnectionsUi,
    adminCustomerEmail,
    adminDrivers,
    adminInventories,
    adminOrders,
    adminRouteGroups,
    adminRoutePlans,
    corsOrigin: readCorsOrigin(process.env.SHOPIFY_APP_URL),
    driverApi,
    driverAuth,
    dsvControl,
    dsvDriverAuth,
    dsvV1Read,
    logger,
    shopifyAuth,
    shopifyWebhook,
    wooCommerceWebhook,
    wordPressPlugin
  })
);
const customerDeliveryNotificationRuntime = createCustomerDeliveryNotificationRuntime({
  env: process.env,
  logger: app.log,
  prisma
});

try {
  await app.listen({ host: '0.0.0.0', port: env.port });
  await adminNotificationRuntime.start();
  await customerDeliveryNotificationRuntime.start();
  app.log.info({ port: env.port }, 'clever-route-server listening');
} catch (error) {
  app.log.error(error, 'failed to start clever-route-server');
  await Promise.allSettled([
    app.close(),
    adminNotificationRuntime.close(),
    customerDeliveryNotificationRuntime.close(),
    prisma.$disconnect()
  ]);
  process.exitCode = 1;
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().finally(() => {
      void Promise.all([
        adminNotificationRuntime.close(),
        customerDeliveryNotificationRuntime.close()
      ]).finally(() => {
        void prisma.$disconnect().finally(() => {
          process.kill(process.pid, signal);
        });
      });
    });
  });
}

function createBuildAppOptions(input: {
  adminCommerceConnections: AdminCommerceConnectionsDependencies | undefined;
  adminCommerceConnectionsUi: AdminCommerceConnectionsUiDependencies | undefined;
  adminCustomerEmail: AdminCustomerEmailDependencies | undefined;
  adminDrivers: AdminDriversDependencies | undefined;
  adminInventories: AdminInventoryDependencies | undefined;
  adminOrders: AdminOrdersDependencies | undefined;
  adminRouteGroups: AdminRouteGroupDependencies | undefined;
  adminRoutePlans: AdminRoutePlanDependencies | undefined;
  corsOrigin: false | string;
  driverApi: DriverApiDependencies | undefined;
  driverAuth: DriverAuthDependencies | undefined;
  dsvControl: DsvControlDependencies | undefined;
  dsvDriverAuth: DsvDriverAuthDependencies | undefined;
  dsvV1Read: DsvV1ReadDependencies | undefined;
  logger: false | { level: string };
  shopifyAuth: ShopifyAuthDependencies | undefined;
  shopifyWebhook: ShopifyWebhookDependencies | undefined;
  wooCommerceWebhook: WooCommerceWebhookDependencies | undefined;
  wordPressPlugin: WordPressPluginDependencies | undefined;
}): {
  adminCommerceConnections?: AdminCommerceConnectionsDependencies;
  adminCommerceConnectionsUi?: AdminCommerceConnectionsUiDependencies;
  adminCustomerEmail?: AdminCustomerEmailDependencies;
  adminDrivers?: AdminDriversDependencies;
  adminInventories?: AdminInventoryDependencies;
  adminOrders?: AdminOrdersDependencies;
  adminRouteGroups?: AdminRouteGroupDependencies;
  adminRoutePlans?: AdminRoutePlanDependencies;
  corsOrigin?: false | string;
  driverApi?: DriverApiDependencies;
  driverAuth?: DriverAuthDependencies;
  dsvControl?: DsvControlDependencies;
  dsvDriverAuth?: DsvDriverAuthDependencies;
  dsvV1Read?: DsvV1ReadDependencies;
  logger: false | { level: string };
  shopifyAuth?: ShopifyAuthDependencies;
  shopifyWebhook?: ShopifyWebhookDependencies;
  wooCommerceWebhook?: WooCommerceWebhookDependencies;
  wordPressPlugin?: WordPressPluginDependencies;
} {
  return {
    ...(input.adminCommerceConnections === undefined ? {} : { adminCommerceConnections: input.adminCommerceConnections }),
    ...(input.adminCommerceConnectionsUi === undefined ? {} : { adminCommerceConnectionsUi: input.adminCommerceConnectionsUi }),
    ...(input.adminCustomerEmail === undefined ? {} : { adminCustomerEmail: input.adminCustomerEmail }),
    ...(input.adminDrivers === undefined ? {} : { adminDrivers: input.adminDrivers }),
    ...(input.adminInventories === undefined ? {} : { adminInventories: input.adminInventories }),
    ...(input.adminOrders === undefined ? {} : { adminOrders: input.adminOrders }),
    ...(input.adminRouteGroups === undefined ? {} : { adminRouteGroups: input.adminRouteGroups }),
    ...(input.adminRoutePlans === undefined ? {} : { adminRoutePlans: input.adminRoutePlans }),
    corsOrigin: input.corsOrigin,
    ...(input.driverApi === undefined ? {} : { driverApi: input.driverApi }),
    ...(input.driverAuth === undefined ? {} : { driverAuth: input.driverAuth }),
    ...(input.dsvControl === undefined ? {} : { dsvControl: input.dsvControl }),
    ...(input.dsvDriverAuth === undefined ? {} : { dsvDriverAuth: input.dsvDriverAuth }),
    ...(input.dsvV1Read === undefined ? {} : { dsvV1Read: input.dsvV1Read }),
    logger: input.logger,
    ...(input.shopifyAuth === undefined ? {} : { shopifyAuth: input.shopifyAuth }),
    ...(input.shopifyWebhook === undefined ? {} : { shopifyWebhook: input.shopifyWebhook }),
    ...(input.wooCommerceWebhook === undefined ? {} : { wooCommerceWebhook: input.wooCommerceWebhook }),
    ...(input.wordPressPlugin === undefined ? {} : { wordPressPlugin: input.wordPressPlugin })
  };
}

function readCorsOrigin(value: string | undefined): false | string {
  if (value === undefined || value.trim() === '') {
    return false;
  }

  return value.trim();
}
