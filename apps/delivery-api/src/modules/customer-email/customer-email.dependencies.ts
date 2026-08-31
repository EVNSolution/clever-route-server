import type { PrismaClient } from '@prisma/client';

import { CustomerEmailService } from './customer-email.service.js';
import {
  loadCustomerEmailTransport,
  type CustomerEmailTransportEnv,
} from './customer-email-transport.js';
import { loadShopifyAppCredentials, type ShopifyAppCredentialsEnv } from '../shopify/shopify-app-credentials.js';
import { ShopifySessionTokenVerifier } from '../shopify/session-token-verifier.js';
import type { AdminCustomerEmailDependencies } from '../../routes/admin-customer-email.routes.js';
import { PrismaCustomerDeliveryNotificationAttemptRepository } from './customer-delivery-notification-attempt.repository.js';
import { PrismaCustomerEmailProviderEventRepository } from './customer-email-provider-event.repository.js';

export const DEFAULT_CUSTOMER_EMAIL_ASSETS_DIR = 'var/customer-email-assets';

export type CustomerEmailRuntimeEnv = CustomerEmailTransportEnv & ShopifyAppCredentialsEnv & Partial<Record<
  'BREVO_WEBHOOK_BEARER_TOKEN' | 'CUSTOMER_EMAIL_ASSETS_DIR' | 'DELIVERY_API_PUBLIC_URL',
  string
>>;

export function loadAdminCustomerEmailDependencies(input: {
  env: CustomerEmailRuntimeEnv;
  prisma: PrismaClient;
}): AdminCustomerEmailDependencies | undefined {
  const appCredentials = loadShopifyAppCredentials(input.env);
  if (appCredentials.length === 0) return undefined;
  const logoAssets = loadLogoAssets(input.env);
  const providerWebhookToken = readOptional(input.env.BREVO_WEBHOOK_BEARER_TOKEN);
  return {
    customerEmailService: new CustomerEmailService(
      input.prisma,
      loadCustomerEmailTransport(input.env),
      new PrismaCustomerDeliveryNotificationAttemptRepository(input.prisma)
    ),
    ...(logoAssets === undefined ? {} : { logoAssets }),
    ...(providerWebhookToken === undefined ? {} : {
      providerWebhook: {
        repository: new PrismaCustomerEmailProviderEventRepository(input.prisma),
        token: providerWebhookToken
      }
    }),
    sessionTokenVerifier: new ShopifySessionTokenVerifier({ appCredentials }),
  };
}

function readOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized === '' ? undefined : normalized;
}

function loadLogoAssets(env: CustomerEmailRuntimeEnv): AdminCustomerEmailDependencies['logoAssets'] {
  const publicBaseUrl = readPublicBaseUrl(env.DELIVERY_API_PUBLIC_URL);
  if (publicBaseUrl === undefined) return undefined;
  return {
    directory: readOptional(env.CUSTOMER_EMAIL_ASSETS_DIR) ?? DEFAULT_CUSTOMER_EMAIL_ASSETS_DIR,
    publicBaseUrl,
  };
}

function readPublicBaseUrl(value: string | undefined): string | undefined {
  const normalized = readOptional(value);
  if (normalized === undefined) return undefined;
  try {
    const url = new URL(normalized);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('not http(s)');
    url.pathname = url.pathname.replace(/\/+$/u, '');
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/+$/u, '');
  } catch {
    throw new Error('DELIVERY_API_PUBLIC_URL must be an http(s) URL for customer email logo assets');
  }
}
