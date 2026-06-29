import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import helmet from '@fastify/helmet';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyRequest, FastifyServerOptions } from 'fastify';

import {
  registerAdminRoutePlanRoutes,
  type AdminRoutePlanDependencies
} from './routes/admin-route-plans.routes.js';
import {
  registerAdminRouteGroupRoutes,
  type AdminRouteGroupDependencies
} from './routes/admin-route-groups.routes.js';
import {
  registerAdminCommerceConnectionsRoutes,
  type AdminCommerceConnectionsDependencies
} from './routes/admin-commerce-connections.routes.js';
import {
  registerAdminCommerceConnectionsUiRoutes,
  type AdminCommerceConnectionsUiDependencies
} from './routes/admin-commerce-connections-ui.routes.js';
import { registerAdminDriversRoutes, type AdminDriversDependencies } from './routes/admin-drivers.routes.js';
import { registerAdminInventoryRoutes, type AdminInventoryDependencies } from './routes/admin-inventories.routes.js';
import { registerAdminOrdersRoutes, type AdminOrdersDependencies } from './routes/admin-orders.routes.js';
import { registerApiDocsRoutes } from './routes/api-docs.routes.js';
import { registerDriverEventRoutes, type DriverApiDependencies } from './routes/driver-events.routes.js';
import { registerDriverAuthRoutes, type DriverAuthDependencies } from './routes/driver-auth.routes.js';
import { registerJsonBodyParser } from './routes/json-body-parser.js';
import { registerPrivacyRoutes } from './routes/privacy.routes.js';
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
import {
  registerWordPressPluginRoutes,
  type WordPressPluginDependencies
} from './routes/wordpress-plugin.routes.js';

export type BuildAppOptions = {
  adminCommerceConnections?: AdminCommerceConnectionsDependencies;
  adminCommerceConnectionsUi?: AdminCommerceConnectionsUiDependencies;
  adminDrivers?: AdminDriversDependencies;
  adminInventories?: AdminInventoryDependencies;
  adminOrders?: AdminOrdersDependencies;
  adminRouteGroups?: AdminRouteGroupDependencies;
  adminRoutePlans?: AdminRoutePlanDependencies;
  corsOrigin?: false | string;
  driverApi?: DriverApiDependencies;
  driverAuth?: DriverAuthDependencies;
  logger?: FastifyServerOptions['logger'];
  shopifyAuth?: ShopifyAuthDependencies;
  shopifyWebhook?: ShopifyWebhookDependencies;
  wooCommerceWebhook?: WooCommerceWebhookDependencies;
  wordPressPlugin?: WordPressPluginDependencies;
};

type AppLoggerOption = Exclude<FastifyServerOptions['logger'], undefined>;

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: withSafeRequestLogging(options.logger ?? false) });
  app.setErrorHandler((error, request, reply) => {
    if (isPrismaSchemaDriftError(error)) {
      const code = request.url.startsWith('/admin/inventories')
        ? 'INVENTORY_SCHEMA_NOT_READY'
        : 'DELIVERY_SCHEMA_NOT_READY';
      request.log.error({ code, error }, 'delivery api schema is not up to date');
      return reply.code(500).send({
        data: null,
        error: {
          code,
          message: 'Delivery API storage schema is not up to date. Apply the delivery API database migration and retry.'
        }
      });
    }

    throw error;
  });

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
  registerPrivacyRoutes(app);
  registerHealthRoutes(app);

  if (options.adminCommerceConnections !== undefined) {
    registerAdminCommerceConnectionsRoutes(app, options.adminCommerceConnections);
  }

  if (options.adminCommerceConnectionsUi !== undefined) {
    registerAdminCommerceConnectionsUiRoutes(app, options.adminCommerceConnectionsUi);
  }

  if (options.adminDrivers !== undefined) {
    registerAdminDriversRoutes(app, options.adminDrivers);
  }

  if (options.adminInventories !== undefined) {
    registerAdminInventoryRoutes(app, options.adminInventories);
  }

  if (options.adminOrders !== undefined) {
    registerAdminOrdersRoutes(app, options.adminOrders);
  }

  if (options.adminRouteGroups !== undefined) {
    registerAdminRouteGroupRoutes(app, options.adminRouteGroups);
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

  if (options.wordPressPlugin !== undefined) {
    registerWordPressPluginRoutes(app, options.wordPressPlugin);
  }

  return app;
}

function isPrismaSchemaDriftError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2022';
}

function withSafeRequestLogging(logger: AppLoggerOption): AppLoggerOption {
  if (logger === false) return false;
  if (logger === true) {
    return { serializers: { req: serializeRequestForLog } };
  }
  return {
    ...logger,
    serializers: {
      ...logger.serializers,
      req: serializeRequestForLog
    }
  };
}

function serializeRequestForLog(request: FastifyRequest): {
  host: string;
  method: string;
  remoteAddress: string;
  remotePort: number;
  url: string;
} {
  return {
    host: request.hostname,
    method: request.method,
    remoteAddress: request.ip,
    remotePort: request.raw.socket.remotePort ?? 0,
    url: redactSensitiveUrl(request.url)
  };
}

export function redactSensitiveUrl(value: string): string {
  if (value.startsWith('/driver/route-map-preview/')) {
    try {
      const url = new URL(value, 'https://clever-route.local');
      if (url.searchParams.has('signature')) {
        url.searchParams.set('signature', '[redacted]');
      }
      if (url.searchParams.has('previewId')) {
        url.searchParams.set('previewId', '[redacted]');
      }
      if (url.searchParams.has('expires')) {
        url.searchParams.set('expires', '[redacted]');
      }
      return `/driver/route-map-preview/[redacted]${url.search}`;
    } catch {
      return '/driver/route-map-preview/[redacted]';
    }
  }
  if (!value.startsWith('/admin/ui/plugin-launch')) return value;
  try {
    const url = new URL(value, 'https://clever-route.local');
    if (url.searchParams.has('token')) {
      url.searchParams.set('token', '[redacted]');
    }
    return `${url.pathname}${url.search}`;
  } catch {
    return '/admin/ui/plugin-launch?token=[redacted]';
  }
}
