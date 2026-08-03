import type { PrismaClient } from '@prisma/client';

import { CustomerEmailService } from './customer-email.service.js';
import {
  loadCustomerEmailTransport,
  type CustomerEmailTransportEnv,
} from './customer-email-transport.js';
import { loadShopifyAppCredentials, type ShopifyAppCredentialsEnv } from '../shopify/shopify-app-credentials.js';
import { ShopifySessionTokenVerifier } from '../shopify/session-token-verifier.js';
import type { AdminCustomerEmailDependencies } from '../../routes/admin-customer-email.routes.js';

export type CustomerEmailRuntimeEnv = CustomerEmailTransportEnv & ShopifyAppCredentialsEnv;

export function loadAdminCustomerEmailDependencies(input: {
  env: CustomerEmailRuntimeEnv;
  prisma: PrismaClient;
}): AdminCustomerEmailDependencies | undefined {
  const appCredentials = loadShopifyAppCredentials(input.env);
  if (appCredentials.length === 0) return undefined;
  return {
    customerEmailService: new CustomerEmailService(input.prisma, loadCustomerEmailTransport(input.env)),
    sessionTokenVerifier: new ShopifySessionTokenVerifier({ appCredentials }),
  };
}
