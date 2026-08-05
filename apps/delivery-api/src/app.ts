import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
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
  registerAdminCustomerEmailRoutes,
  type AdminCustomerEmailDependencies
} from './routes/admin-customer-email.routes.js';
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
import { registerDsvControlRoutes, type DsvControlDependencies } from './routes/dsv-control.routes.js';
import { registerDsvV1ReadRoutes, type DsvV1ReadDependencies } from './routes/dsv-v1-read.routes.js';
import { registerDsvDriverAuthRoutes, type DsvDriverAuthDependencies } from './routes/dsv-driver-auth.routes.js';
import {
  registerDsvDriverAppReleaseRoutes,
  type DsvDriverAppReleaseDependencies
} from './routes/dsv-driver-app-release.routes.js';

export type BuildAppOptions = {
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
  dsvDriverAppRelease?: DsvDriverAppReleaseDependencies;
  dsvV1Read?: DsvV1ReadDependencies;
  logger?: FastifyServerOptions['logger'];
  shopifyAuth?: ShopifyAuthDependencies;
  shopifyWebhook?: ShopifyWebhookDependencies;
  wooCommerceWebhook?: WooCommerceWebhookDependencies;
  wordPressPlugin?: WordPressPluginDependencies;
};

type AppLoggerOption = Exclude<FastifyServerOptions['logger'], undefined>;
type DsvApiSurfaceCategory = 'v1_read' | 'canonical_assignment_command_alias' | 'legacy_read' | 'legacy_write';

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: withSafeRequestLogging(options.logger ?? false) });
  app.addHook('onResponse', (request, reply, done) => {
    logDsvApiSurfaceRequest(request, reply);
    done();
  });
  app.setErrorHandler((error, request, reply) => {
    if (hasStatusCode(error, 429)) {
      return reply.code(429).send({
        data: null,
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many authentication attempts. Try again later.'
        }
      });
    }
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
  if (options.dsvDriverAuth !== undefined) {
    await app.register(rateLimit, {
      global: false
    });
  }
  registerApiDocsRoutes(app);
  registerPrivacyRoutes(app);
  registerHealthRoutes(app);

  if (options.adminCommerceConnections !== undefined) {
    registerAdminCommerceConnectionsRoutes(app, options.adminCommerceConnections);
  }

  if (options.adminCommerceConnectionsUi !== undefined) {
    registerAdminCommerceConnectionsUiRoutes(app, options.adminCommerceConnectionsUi);
  }

  if (options.adminCustomerEmail !== undefined) {
    registerAdminCustomerEmailRoutes(app, options.adminCustomerEmail);
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

  if (options.dsvControl !== undefined) {
    registerDsvControlRoutes(app, options.dsvControl);
  }

  if (options.dsvDriverAuth !== undefined) {
    registerDsvDriverAuthRoutes(app, options.dsvDriverAuth);
  }

  if (options.dsvDriverAppRelease !== undefined) {
    registerDsvDriverAppReleaseRoutes(app, options.dsvDriverAppRelease);
  }

  if (options.dsvV1Read !== undefined) {
    registerDsvV1ReadRoutes(app, options.dsvV1Read);
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

function hasStatusCode(error: unknown, statusCode: number): boolean {
  return typeof error === 'object'
    && error !== null
    && 'statusCode' in error
    && error.statusCode === statusCode;
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

function logDsvApiSurfaceRequest(
  request: FastifyRequest,
  reply: { elapsedTime: number; statusCode: number },
): void {
  const classification = classifyDsvApiSurfaceRequest(request.method, request.url, request.routeOptions.url);
  if (classification === null) return;

  request.log.info({
    callerSurface: readCallerSurface(request),
    durationMs: Math.round(reply.elapsedTime),
    event: 'dsv_api_surface_request',
    legacyCategory: classification.legacyCategory,
    method: request.method,
    path: redactSensitiveUrl(pathWithQuery(request.url)),
    requestId: request.id,
    route: classification.route,
    statusCode: reply.statusCode,
  }, 'DSV API surface request classified');
}

function classifyDsvApiSurfaceRequest(
  method: string,
  url: string,
  matchedRoute: string | undefined,
): { legacyCategory: DsvApiSurfaceCategory; route: string } | null {
  const path = pathname(url);
  if (!path.startsWith('/api/dsv')) return null;

  const normalizedMethod = method.toUpperCase();
  if (normalizedMethod === 'GET' && path.startsWith('/api/dsv/v1/')) {
    return { legacyCategory: 'v1_read', route: matchedRoute ?? path };
  }

  const assignmentAliasRoute = assignmentCommandAliasRoute(normalizedMethod, path);
  if (assignmentAliasRoute !== null) {
    return { legacyCategory: 'canonical_assignment_command_alias', route: assignmentAliasRoute };
  }

  if (path.startsWith('/api/dsv/v1/')) return null;
  if (normalizedMethod === 'GET' || normalizedMethod === 'HEAD') {
    return { legacyCategory: 'legacy_read', route: matchedRoute ?? path };
  }
  if (normalizedMethod === 'POST' || normalizedMethod === 'PUT' || normalizedMethod === 'PATCH' || normalizedMethod === 'DELETE') {
    return { legacyCategory: 'legacy_write', route: matchedRoute ?? path };
  }
  return null;
}

function assignmentCommandAliasRoute(method: string, path: string): string | null {
  if (method !== 'POST') return null;
  const match = /^\/api\/dsv\/seller-orders\/[^/]+\/assignment\/(reassign|unassign)$/u.exec(path);
  if (match === null) return null;
  return `/api/dsv/seller-orders/:sellerOrderId/assignment/${match[1]}`;
}

function readCallerSurface(request: FastifyRequest): string {
  const value = request.headers['x-caller-surface'];
  if (typeof value !== 'string') return 'unknown';
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 120) return 'unknown';
  return /^[A-Za-z0-9._:-]+$/u.test(trimmed) ? trimmed : 'unknown';
}

function pathname(url: string): string {
  try {
    return new URL(url, 'https://clever-route.local').pathname;
  } catch {
    return url.split('?')[0] ?? url;
  }
}

function pathWithQuery(url: string): string {
  try {
    const parsed = new URL(url, 'https://clever-route.local');
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}
