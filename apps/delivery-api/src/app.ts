import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import helmet from '@fastify/helmet';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';

import {
  registerAdminRoutePlanRoutes,
  type AdminRoutePlanDependencies
} from './routes/admin-route-plans.routes.js';
import { registerAdminDriversRoutes, type AdminDriversDependencies } from './routes/admin-drivers.routes.js';
import { registerAdminOrdersRoutes, type AdminOrdersDependencies } from './routes/admin-orders.routes.js';
import { registerApiDocsRoutes } from './routes/api-docs.routes.js';
import { registerDriverEventRoutes, type DriverApiDependencies } from './routes/driver-events.routes.js';
import { registerDriverAuthRoutes, type DriverAuthDependencies } from './routes/driver-auth.routes.js';
import { registerJsonBodyParser } from './routes/json-body-parser.js';
import { registerHealthRoutes } from './routes/health.routes.js';
import { registerShopifyAuthRoutes, type ShopifyAuthDependencies } from './routes/shopify-auth.routes.js';
import {
  registerShopifyWebhookRoutes,
  type ShopifyWebhookDependencies
} from './routes/shopify-webhook.routes.js';
import {
  registerWooCommerceWebhookRoutes,
  type WooCommerceWebhookDependencies
} from './routes/woocommerce-webhook.routes.js';

type BuildAppOptions = {
  adminDrivers?: AdminDriversDependencies;
  adminOrders?: AdminOrdersDependencies;
  adminRoutePlans?: AdminRoutePlanDependencies;
  corsOrigin?: false | string;
  driverApi?: DriverApiDependencies;
  driverAuth?: DriverAuthDependencies;
  logger?: FastifyServerOptions['logger'];
  shopifyAuth?: ShopifyAuthDependencies;
  shopifyWebhook?: ShopifyWebhookDependencies;
  wooCommerceWebhook?: WooCommerceWebhookDependencies;
};

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });

  registerJsonBodyParser(app);
  await app.register(multipart, {
    limits: {
      fields: 8,
      fileSize: 10 * 1024 * 1024,
      files: 1,
      parts: 12
    }
  });
  await app.register(helmet);
  await app.register(cors, { origin: options.corsOrigin ?? false });
  registerApiDocsRoutes(app);
  registerHealthRoutes(app);

  if (options.adminDrivers !== undefined) {
    registerAdminDriversRoutes(app, options.adminDrivers);
  }

  if (options.adminOrders !== undefined) {
    registerAdminOrdersRoutes(app, options.adminOrders);
  }

  if (options.adminRoutePlans !== undefined) {
    registerAdminRoutePlanRoutes(app, options.adminRoutePlans);
  }

  if (options.driverApi !== undefined) {
    registerDriverEventRoutes(app, options.driverApi);
  }

  if (options.driverAuth !== undefined) {
    registerDriverAuthRoutes(app, options.driverAuth);
  }

  if (options.shopifyAuth !== undefined) {
    registerShopifyAuthRoutes(app, options.shopifyAuth);
  }

  if (options.shopifyWebhook !== undefined) {
    registerShopifyWebhookRoutes(app, options.shopifyWebhook);
  }

  if (options.wooCommerceWebhook !== undefined) {
    registerWooCommerceWebhookRoutes(app, options.wooCommerceWebhook);
  }

  return app;
}
