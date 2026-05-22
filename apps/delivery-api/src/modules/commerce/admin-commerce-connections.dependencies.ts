import type { PrismaClient } from '@prisma/client';

import type { AdminCommerceConnectionsDependencies } from '../../routes/admin-commerce-connections.routes.js';
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
    | 'CREDENTIAL_ENCRYPTION_KEY'
    | 'DELIVERY_API_PUBLIC_URL'
    | 'NODE_ENV',
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
      verifier: new WooCommerceConnectionVerifier({
        allowLocalHttp: isLocalWooHttpRuntime(input.env.NODE_ENV),
        allowPrivateNetworkUrls: isLocalWooHttpRuntime(input.env.NODE_ENV)
      })
    }),
    ...(publicBaseUrl === undefined ? {} : { publicBaseUrl })
  };
}

function readOptional(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  return value.trim();
}

function isLocalWooHttpRuntime(nodeEnv: string | undefined): boolean {
  return nodeEnv === 'development' || nodeEnv === 'test';
}
