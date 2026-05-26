import type { PrismaClient } from '@prisma/client';

import type { AdminCommerceConnectionsDependencies } from '../../routes/admin-commerce-connections.routes.js';
import type { AdminCommerceConnectionsUiDependencies } from '../../routes/admin-commerce-connections-ui.routes.js';
import type { AdminOrdersDependencies } from '../../routes/admin-orders.routes.js';
import type { AdminRoutePlanDependencies } from '../../routes/admin-route-plans.routes.js';
import { PrismaRoutePlanRepository } from '../route-plans/route-plan.repository.js';
import { RoutePlanAdminService } from '../route-plans/route-plan.service.js';
import { OsrmRouteGeometryProvider } from '../route-plans/osrm-route-geometry.client.js';
import { PrismaOrderSyncRepository } from '../shopify/order-sync.repository.js';
import { ShopifyOrderSyncService } from '../shopify/order-sync.service.js';
import { DEFAULT_ADMIN_UI_COOKIE_NAME, isStrongAdminWebSecret } from '../../routes/admin-ui-session.js';
import { loadCredentialEncryptionKey } from './commerce-credential-encryption.js';
import { PrismaCommerceConnectionRepository } from './commerce-connection.repository.js';
import { CommerceConnectionCredentialService } from './commerce-connection.service.js';
import { parseAllowedShopDomains, StaticAdminCommerceTokenVerifier } from './admin-commerce-auth.js';
import { WooCommerceConnectionOnboardingService } from './woocommerce-connection-onboarding.service.js';
import { WooCommerceConnectionVerifier } from './woocommerce-connection-verifier.js';

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
    | 'OSRM_BASE_URL',
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
  adminOrders?: AdminOrdersDependencies | undefined;
  adminRoutePlans?: AdminRoutePlanDependencies | undefined;
  env: AdminCommerceConnectionsRuntimeEnv;
  nodeEnv: string;
  prisma?: PrismaClient | undefined;
}): AdminCommerceConnectionsUiDependencies | undefined {
  if (input.adminCommerceConnections === undefined) return undefined;

  const loginSecret = readOptional(input.env.CLEVER_ADMIN_WEB_LOGIN_SECRET);
  const sessionSecret = readOptional(input.env.CLEVER_ADMIN_WEB_SESSION_SECRET);
  if (!isStrongAdminWebSecret(loginSecret) || !isStrongAdminWebSecret(sessionSecret)) {
    return undefined;
  }

  const actorSubject = readOptional(input.env.CLEVER_ADMIN_API_ACTOR) ?? 'internal-web-operator';
  const cookieName = readOptional(input.env.CLEVER_ADMIN_WEB_COOKIE_NAME) ?? DEFAULT_ADMIN_UI_COOKIE_NAME;
  const publicBaseUrl = readOptional(input.env.DELIVERY_API_PUBLIC_URL);
  if (input.nodeEnv === 'production' && publicBaseUrl === undefined) {
    return undefined;
  }

  return {
    actor: {
      allowedShopDomains: parseAllowedShopDomains(input.env.CLEVER_ADMIN_ALLOWED_SHOP_DOMAINS),
      subject: actorSubject
    },
    cookieName,
    loginSecret,
    onboardingService: input.adminCommerceConnections.onboardingService,
    ...readAdminUiOrderSyncService(input),
    ...(publicBaseUrl === undefined ? {} : { publicBaseUrl }),
    ...readAdminUiRoutePlanService(input),
    secureCookies: input.nodeEnv !== 'development' && input.nodeEnv !== 'test',
    sessionSecret
  };
}

function readAdminUiOrderSyncService(input: {
  adminOrders?: AdminOrdersDependencies | undefined;
  prisma?: PrismaClient | undefined;
}): Pick<AdminCommerceConnectionsUiDependencies, 'orderSyncService'> {
  if (input.adminOrders !== undefined) {
    return { orderSyncService: input.adminOrders.orderSyncService };
  }
  if (input.prisma === undefined) return {};
  return {
    orderSyncService: new ShopifyOrderSyncService({
      graphqlClient: {
        request: () => Promise.reject(new Error('Admin UI order list does not use Shopify GraphQL snapshot sync'))
      },
      repository: new PrismaOrderSyncRepository(input.prisma)
    })
  };
}

function readAdminUiRoutePlanService(input: {
  adminRoutePlans?: AdminRoutePlanDependencies | undefined;
  env: AdminCommerceConnectionsRuntimeEnv;
  prisma?: PrismaClient | undefined;
}): Pick<AdminCommerceConnectionsUiDependencies, 'routePlanService'> {
  if (input.adminRoutePlans !== undefined) {
    return { routePlanService: input.adminRoutePlans.routePlanService };
  }
  if (input.prisma === undefined) return {};
  return {
    routePlanService: new RoutePlanAdminService(
      new PrismaRoutePlanRepository(input.prisma),
      new OsrmRouteGeometryProvider({ baseUrl: readOptional(input.env.OSRM_BASE_URL) })
    )
  };
}

function readOptional(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  return value.trim();
}
