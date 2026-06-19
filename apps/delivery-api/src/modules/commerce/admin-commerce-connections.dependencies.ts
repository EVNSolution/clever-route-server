import type { PrismaClient } from '@prisma/client';

import type { AdminCommerceConnectionsDependencies } from '../../routes/admin-commerce-connections.routes.js';
import type { AdminCommerceConnectionsUiDependencies } from '../../routes/admin-commerce-connections-ui.routes.js';
import type { AdminDriversDependencies } from '../../routes/admin-drivers.routes.js';
import type { AdminOrdersDependencies } from '../../routes/admin-orders.routes.js';
import type { AdminRoutePlanDependencies } from '../../routes/admin-route-plans.routes.js';
import { PrismaAdminDriverRepository } from '../driver/admin-driver.repository.js';
import { AdminDriverService } from '../driver/admin-driver.service.js';
import { PrismaRoutePlanRepository } from '../route-plans/route-plan.repository.js';
import { PrismaRouteOptimizationJobRepository } from '../route-plans/route-optimization-job.repository.js';
import { RouteOptimizationJobService } from '../route-plans/route-optimization-job.service.js';
import { RoutePlanAdminService } from '../route-plans/route-plan.service.js';
import { OsrmRouteGeometryProvider } from '../route-plans/osrm-route-geometry.client.js';
import {
  RouteEngineRouteOptimizationClient,
  type RouteEngineMode,
  type RouteEngineObjective
} from '../route-plans/route-engine-route-optimizer.client.js';
import { VroomRouteOptimizationClient } from '../route-plans/vroom-route-optimizer.client.js';
import { PrismaOrderSyncRepository } from '../shopify/order-sync.repository.js';
import { PrismaAdminNotificationRepository } from '../notifications/admin-notification.repository.js';
import { AdminNotificationService } from '../notifications/admin-notification.service.js';
import { ShopifyOrderSyncService } from '../shopify/order-sync.service.js';
import { createWooCommerceOrderClientFromConnection } from '../woocommerce/woocommerce-order.client.js';
import { WooCommerceOrderSyncService } from '../woocommerce/woocommerce-order-sync.service.js';
import { DEFAULT_WORDPRESS_PLUGIN_PAIRING_CODE_TTL_MINUTES } from '../wordpress-plugin/wordpress-plugin-auth.service.js';
import { PrismaOrderIngestAuditService } from '../wordpress-plugin/order-ingest-audit.service.js';
import { PrismaWordPressPluginRepository } from '../wordpress-plugin/wordpress-plugin.repository.js';
import { WordPressPluginSyncRequestService } from '../wordpress-plugin/wordpress-plugin-sync.service.js';
import {
  DEFAULT_ADMIN_UI_COOKIE_NAME,
  isStrongAdminWebSecret,
  isValidAdminWebLoginSecret
} from '../../routes/admin-ui-session.js';
import { loadCredentialEncryptionKey } from './commerce-credential-encryption.js';
import { PrismaCommerceConnectionRepository } from './commerce-connection.repository.js';
import { CommerceConnectionCredentialService } from './commerce-connection.service.js';
import { parseAllowedShopDomains, StaticAdminCommerceTokenVerifier } from './admin-commerce-auth.js';
import { AdminWooSyncService } from './admin-woocommerce-sync.service.js';
import { PrismaAdminStoreSettingsService } from './admin-store-settings.service.js';
import { WooCommerceConnectionOnboardingService } from './woocommerce-connection-onboarding.service.js';
import {
  assertHttpsWooSiteUrl,
  assertResolvedWooSiteHostIsPublic,
  WooCommerceConnectionVerifier
} from './woocommerce-connection-verifier.js';
import { loadGeocodingService } from '../geocoding/geocoding.dependencies.js';
import { PrismaDeliveryCustomerProfileService } from '../delivery-customer/delivery-customer-profile.service.js';
import { loadDriverPushProvider } from '../route-grouping/driver-push.provider.js';
import { PrismaRouteGroupingService } from '../route-grouping/route-grouping.service.js';

export type AdminCommerceConnectionsRuntimeEnv = Partial<
  Record<
    | 'CLEVER_ADMIN_ALLOWED_SHOP_DOMAINS'
    | 'CLEVER_ADMIN_API_ACTOR'
    | 'CLEVER_ADMIN_API_TOKEN'
    | 'CLEVER_ADMIN_WEB_COOKIE_NAME'
    | 'CLEVER_ADMIN_WEB_LOGIN_SECRET'
    | 'CLEVER_ADMIN_WEB_SESSION_SECRET'
    | 'CREDENTIAL_ENCRYPTION_KEY'
    | 'DELIVERY_API_PUBLIC_URL'
    | 'DRIVER_APP_DOWNLOAD_URL'
    | 'GEOCODING_CACHE_TTL_DAYS'
    | 'GEOCODING_PROVIDER_MODE'
    | 'GEOCODING_RATE_LIMIT_PER_SECOND'
    | 'GEOCODING_SEARCH_URL'
    | 'GEOCODING_TIMEOUT_MS'
    | 'GEOCODING_USER_AGENT'
    | 'FIREBASE_PROJECT_ID'
    | 'GOOGLE_APPLICATION_CREDENTIALS'
    | 'OSRM_BASE_URL'
    | 'OSRM_TIMEOUT_MS'
    | 'ROUTE_ENGINE_BASE_URL'
    | 'ROUTE_ENGINE_INTERNAL_TOKEN'
    | 'ROUTE_ENGINE_MODE'
    | 'ROUTE_ENGINE_OBJECTIVE'
    | 'ROUTE_ENGINE_SERVICE_REGION'
    | 'ROUTE_ENGINE_TIMEOUT_MS'
    | 'ROUTE_OPS_ROUTER_COVERAGE'
    | 'VROOM_BASE_URL'
    | 'VROOM_TIMEOUT_MS'
    | 'WOOCOMMERCE_SHOP_TIMEZONE',
    string
  >
>;

export function loadAdminCommerceConnectionsDependencies(input: {
  env: AdminCommerceConnectionsRuntimeEnv;
  prisma: PrismaClient;
}): AdminCommerceConnectionsDependencies | undefined {
  const adminToken = readOptional(input.env.CLEVER_ADMIN_API_TOKEN);
  const rawCredentialKey = readOptional(input.env.CREDENTIAL_ENCRYPTION_KEY);
  if (adminToken === undefined || rawCredentialKey === undefined) {
    return undefined;
  }

  const repository = new PrismaCommerceConnectionRepository(input.prisma, {
    createMissingShop: true
  });
  const credentialStore = new CommerceConnectionCredentialService({
    credentialKey: loadCredentialEncryptionKey(rawCredentialKey),
    repository
  });

  const actorSubject = readOptional(input.env.CLEVER_ADMIN_API_ACTOR);
  const publicBaseUrl = readOptional(input.env.DELIVERY_API_PUBLIC_URL);

  return {
    adminTokenVerifier: new StaticAdminCommerceTokenVerifier({
      ...(actorSubject === undefined ? {} : { actorSubject }),
      allowedShopDomains: parseAllowedShopDomains(input.env.CLEVER_ADMIN_ALLOWED_SHOP_DOMAINS),
      token: adminToken
    }),
    onboardingService: new WooCommerceConnectionOnboardingService({
      credentialStore,
      repository,
      verifier: new WooCommerceConnectionVerifier()
    }),
    ...(publicBaseUrl === undefined ? {} : { publicBaseUrl })
  };
}

export function loadAdminCommerceConnectionsUiDependencies(input: {
  adminCommerceConnections: AdminCommerceConnectionsDependencies | undefined;
  adminDrivers?: AdminDriversDependencies | undefined;
  adminOrders?: AdminOrdersDependencies | undefined;
  adminRoutePlans?: AdminRoutePlanDependencies | undefined;
  env: AdminCommerceConnectionsRuntimeEnv;
  nodeEnv: string;
  prisma?: PrismaClient | undefined;
}): AdminCommerceConnectionsUiDependencies | undefined {
  if (input.adminCommerceConnections === undefined) return undefined;

  const loginSecret = readOptional(input.env.CLEVER_ADMIN_WEB_LOGIN_SECRET);
  const sessionSecret = readOptional(input.env.CLEVER_ADMIN_WEB_SESSION_SECRET);
  if (!isValidAdminWebLoginSecret(loginSecret) || !isStrongAdminWebSecret(sessionSecret)) {
    return undefined;
  }

  const actorSubject = readOptional(input.env.CLEVER_ADMIN_API_ACTOR) ?? 'internal-web-operator';
  const cookieName = readOptional(input.env.CLEVER_ADMIN_WEB_COOKIE_NAME) ?? DEFAULT_ADMIN_UI_COOKIE_NAME;
  const publicBaseUrl = readOptional(input.env.DELIVERY_API_PUBLIC_URL);
  const driverAppDownloadUrl = readOptionalHttpUrl(
    input.env.DRIVER_APP_DOWNLOAD_URL,
    'DRIVER_APP_DOWNLOAD_URL'
  );
  if (input.nodeEnv === 'production' && publicBaseUrl === undefined) {
    return undefined;
  }

  const routePlanDeps = readAdminUiRoutePlanService(input);
  const routeGeometryRefresher = routePlanDeps.routePlanService?.refreshRouteGeometryForRoutePlan === undefined
    ? undefined
    : {
        refreshRouteGeometryForRoutePlan:
          routePlanDeps.routePlanService.refreshRouteGeometryForRoutePlan.bind(routePlanDeps.routePlanService)
      };

  return {
    actor: {
      allowedShopDomains: parseAllowedShopDomains(input.env.CLEVER_ADMIN_ALLOWED_SHOP_DOMAINS),
      subject: actorSubject
    },
    cookieName,
    loginSecret,
    ...readAdminUiDeliveryCustomerService(input),
    ...readAdminUiDriverService(input),
    geocodingService: loadGeocodingService({ env: input.env }),
    onboardingService: input.adminCommerceConnections.onboardingService,
    ...readAdminUiNotificationService(input),
    ...readAdminUiOrderIngestAuditService(input),
    ...readAdminUiOrderSyncService(input),
    ...readAdminUiPairingCodeService(input),
    ...readAdminUiRouteOptimizationService(input.env),
    ...readAdminUiWooSyncService(input),
    ...(driverAppDownloadUrl === undefined ? {} : { driverAppDownloadUrl }),
    ...(publicBaseUrl === undefined ? {} : { publicBaseUrl }),
    ...routePlanDeps,
    ...readAdminUiRouteGroupingService(input, routeGeometryRefresher),
    secureCookies: input.nodeEnv !== 'development' && input.nodeEnv !== 'test',
    sessionSecret,
    ...readAdminUiSettingsService(input)
  };
}

function readAdminUiPairingCodeService(input: {
  prisma?: PrismaClient | undefined;
}): Pick<AdminCommerceConnectionsUiDependencies, 'pairingCodeService'> {
  if (input.prisma === undefined) return {};
  const wordpressRepository = new PrismaWordPressPluginRepository(input.prisma);
  return {
    pairingCodeService: {
      async createPairingCode({
        commerceConnectionId,
        issuedAt,
        issuedBy,
        siteUrl
      }) {
        const result = await wordpressRepository.createPairingCode({
          commerceConnectionId,
          expiresAt: new Date(
            issuedAt.getTime() +
              DEFAULT_WORDPRESS_PLUGIN_PAIRING_CODE_TTL_MINUTES * 60_000
          ),
          issuedAt,
          issuedBy,
          siteUrl
        });
        return {
          code: result.code,
          expiresAt: result.expiresAt,
          siteUrl: result.siteUrl
        };
      }
    }
  };
}

function readAdminUiWooSyncService(input: {
  env: AdminCommerceConnectionsRuntimeEnv;
  prisma?: PrismaClient | undefined;
}): Pick<AdminCommerceConnectionsUiDependencies, 'wooSyncService'> {
  const rawCredentialKey = readOptional(input.env.CREDENTIAL_ENCRYPTION_KEY);
  if (input.prisma === undefined || rawCredentialKey === undefined) return {};

  const connectionRepository = new PrismaCommerceConnectionRepository(input.prisma, {
    createMissingShop: true
  });
  const connectionService = new CommerceConnectionCredentialService({
    credentialKey: loadCredentialEncryptionKey(rawCredentialKey),
    repository: connectionRepository
  });
  const orderRepository = new PrismaOrderSyncRepository(input.prisma, {
    allowAnyShopDomain: true,
    createMissingShop: true
  });
  const wordpressRepository = new PrismaWordPressPluginRepository(input.prisma);
  const geocodingService = loadGeocodingService({ env: input.env });
  const shopTimezone = readOptional(input.env.WOOCOMMERCE_SHOP_TIMEZONE);
  const syncService = new WordPressPluginSyncRequestService({
    connectionService,
    createOrderSyncService: ({ connection }) => {
      const resolvedTimezone = connection.timezone ?? shopTimezone;
      return new WooCommerceOrderSyncService({
        client: createWooCommerceOrderClientFromConnection(connection),
        connectionId: connection.id,
        geocodingService,
        repository: orderRepository,
        shopDomain: connection.shopDomain,
        ...(resolvedTimezone === undefined ? {} : { shopTimezone: resolvedTimezone }),
        siteUrl: connection.siteUrl
      });
    },
    freshnessRepository: wordpressRepository,
    syncRunRepository: wordpressRepository,
    validateConnectionSiteUrl: async ({ connection }) => {
      const siteUrl = assertHttpsWooSiteUrl(connection.siteUrl);
      await assertResolvedWooSiteHostIsPublic(siteUrl);
    }
  });

  return {
    wooSyncService: new AdminWooSyncService({
      prisma: input.prisma,
      syncService
    })
  };
}

function readAdminUiNotificationService(input: {
  prisma?: PrismaClient | undefined;
}): Pick<AdminCommerceConnectionsUiDependencies, 'notificationService'> {
  if (input.prisma === undefined) return {};
  return {
    notificationService: new AdminNotificationService(
      new PrismaAdminNotificationRepository(input.prisma)
    )
  };
}


function readAdminUiDeliveryCustomerService(input: {
  prisma?: PrismaClient | undefined;
}): Pick<AdminCommerceConnectionsUiDependencies, 'deliveryCustomerService'> {
  if (input.prisma === undefined) return {};
  return {
    deliveryCustomerService: new PrismaDeliveryCustomerProfileService(input.prisma)
  };
}

function readAdminUiDriverService(input: {
  adminDrivers?: AdminDriversDependencies | undefined;
  prisma?: PrismaClient | undefined;
}): Pick<AdminCommerceConnectionsUiDependencies, 'driverService'> {
  if (input.adminDrivers !== undefined) {
    return { driverService: input.adminDrivers.adminDriverService };
  }
  if (input.prisma === undefined) return {};
  return { driverService: new AdminDriverService(new PrismaAdminDriverRepository(input.prisma)) };
}

function readAdminUiOrderIngestAuditService(input: {
  prisma?: PrismaClient | undefined;
}): Pick<AdminCommerceConnectionsUiDependencies, 'orderIngestAuditService'> {
  if (input.prisma === undefined) return {};
  return {
    orderIngestAuditService: new PrismaOrderIngestAuditService(input.prisma)
  };
}

function readAdminUiOrderSyncService(input: {
  adminOrders?: AdminOrdersDependencies | undefined;
  prisma?: PrismaClient | undefined;
}): Pick<AdminCommerceConnectionsUiDependencies, 'orderSyncService'> {
  if (input.prisma === undefined) {
    return input.adminOrders === undefined ? {} : { orderSyncService: input.adminOrders.orderSyncService };
  }
  return {
    orderSyncService: new ShopifyOrderSyncService({
      graphqlClient: {
        request: () => Promise.reject(new Error('Admin UI order list does not use Shopify GraphQL snapshot sync'))
      },
      repository: new PrismaOrderSyncRepository(input.prisma, {
        allowAnyShopDomain: true,
        createMissingShop: true
      })
    })
  };
}

function readAdminUiRouteOptimizationService(
  env: AdminCommerceConnectionsRuntimeEnv
): Pick<AdminCommerceConnectionsUiDependencies, 'routeOptimizationService'> {
  const vroomBaseUrl = readOptional(env.VROOM_BASE_URL);
  const routeEngineBaseUrl = readOptional(env.ROUTE_ENGINE_BASE_URL);
  if (vroomBaseUrl !== undefined && routeEngineBaseUrl !== undefined) {
    throw new Error('VROOM_BASE_URL and ROUTE_ENGINE_BASE_URL cannot both be set for one Route Ops runtime');
  }
  if (vroomBaseUrl !== undefined) {
    return {
      routeOptimizationService: new VroomRouteOptimizationClient({
        baseUrl: vroomBaseUrl,
        ...optionalTimeout(env.VROOM_TIMEOUT_MS)
      })
    };
  }
  if (routeEngineBaseUrl === undefined) return {};

  const internalToken = readOptional(env.ROUTE_ENGINE_INTERNAL_TOKEN);
  if (internalToken === undefined) {
    throw new Error('ROUTE_ENGINE_INTERNAL_TOKEN is required when ROUTE_ENGINE_BASE_URL is set');
  }

  return {
    routeOptimizationService: new RouteEngineRouteOptimizationClient({
      baseUrl: routeEngineBaseUrl,
      internalToken,
      mode: readOptionalRouteEngineMode(env.ROUTE_ENGINE_MODE),
      objective: readOptionalRouteEngineObjective(env.ROUTE_ENGINE_OBJECTIVE),
      serviceRegion: readOptional(env.ROUTE_ENGINE_SERVICE_REGION) ?? readOptional(env.ROUTE_OPS_ROUTER_COVERAGE),
      ...optionalTimeout(env.ROUTE_ENGINE_TIMEOUT_MS)
    })
  };
}

function readAdminUiRoutePlanService(input: {
  adminRoutePlans?: AdminRoutePlanDependencies | undefined;
  env: AdminCommerceConnectionsRuntimeEnv;
  prisma?: PrismaClient | undefined;
}): Pick<AdminCommerceConnectionsUiDependencies, 'routeOptimizationJobService' | 'routePlanService'> {
  if (input.prisma === undefined) {
    return input.adminRoutePlans === undefined ? {} : { routePlanService: input.adminRoutePlans.routePlanService };
  }
  const osrmBaseUrl = readOptional(input.env.OSRM_BASE_URL);
  const routeOptimizationJobService = new RouteOptimizationJobService(
    new PrismaRouteOptimizationJobRepository(input.prisma),
  );
  return {
    routeOptimizationJobService,
    routePlanService: new RoutePlanAdminService(
      new PrismaRoutePlanRepository(input.prisma, { allowAnyShopDomain: true }),
      osrmBaseUrl === undefined
        ? undefined
        : new OsrmRouteGeometryProvider({
            baseUrl: osrmBaseUrl,
            ...optionalTimeout(input.env.OSRM_TIMEOUT_MS),
          }),
      routeOptimizationJobService,
    )
  };
}


function readAdminUiRouteGroupingService(
  input: {
    env: AdminCommerceConnectionsRuntimeEnv;
    prisma?: PrismaClient | undefined;
  },
  routeGeometryRefresher?: ConstructorParameters<typeof PrismaRouteGroupingService>[2]
): Pick<AdminCommerceConnectionsUiDependencies, 'routeGroupingService'> {
  if (input.prisma === undefined) return {};
  return {
    routeGroupingService: new PrismaRouteGroupingService(
      input.prisma,
      loadDriverPushProvider(input.env),
      routeGeometryRefresher,
    ),
  };
}

function readAdminUiSettingsService(input: {
  prisma?: PrismaClient | undefined;
}): Pick<AdminCommerceConnectionsUiDependencies, 'settingsService'> {
  if (input.prisma === undefined) return {};
  return { settingsService: new PrismaAdminStoreSettingsService(input.prisma) };
}


function readOptionalRouteEngineMode(value: string | undefined): RouteEngineMode | undefined {
  const normalized = readOptional(value);
  if (normalized === undefined) return undefined;
  if (normalized === 'road_graph' || normalized === 'fixture') return normalized;
  throw new Error('ROUTE_ENGINE_MODE must be road_graph or fixture');
}

function readOptionalRouteEngineObjective(value: string | undefined): RouteEngineObjective | undefined {
  const normalized = readOptional(value);
  if (normalized === undefined) return undefined;
  if (normalized === 'minimize_duration' || normalized === 'minimize_distance') return normalized;
  throw new Error('ROUTE_ENGINE_OBJECTIVE must be minimize_duration or minimize_distance');
}

function readOptional(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  return value.trim();
}

function readOptionalHttpUrl(value: string | undefined, name: string): string | undefined {
  const normalized = readOptional(value);
  if (normalized === undefined) return undefined;
  try {
    const url = new URL(normalized);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
  } catch {
    // Fall through to the explicit configuration error below.
  }
  throw new Error(`${name} must be an http(s) URL`);
}

function readOptionalNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function optionalTimeout(value: string | undefined): { timeoutMs?: number } {
  const timeoutMs = readOptionalNumber(value);
  return timeoutMs === undefined ? {} : { timeoutMs };
}
