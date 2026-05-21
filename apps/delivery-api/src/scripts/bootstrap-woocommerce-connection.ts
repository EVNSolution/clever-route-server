import { PrismaClient } from '@prisma/client';

import { loadCredentialEncryptionKey } from '../modules/commerce/commerce-credential-encryption.js';
import { PrismaCommerceConnectionRepository } from '../modules/commerce/commerce-connection.repository.js';
import { CommerceConnectionCredentialService } from '../modules/commerce/commerce-connection.service.js';

const prisma = new PrismaClient();

try {
  const service = new CommerceConnectionCredentialService({
    credentialKey: loadCredentialEncryptionKey(process.env.CREDENTIAL_ENCRYPTION_KEY),
    repository: new PrismaCommerceConnectionRepository(prisma, { createMissingShop: true })
  });
  const connection = await service.upsertWooCommerceConnection({
    consumerKey: readRequiredEnv('WOOCOMMERCE_BOOTSTRAP_CONSUMER_KEY'),
    consumerSecret: readRequiredEnv('WOOCOMMERCE_BOOTSTRAP_CONSUMER_SECRET'),
    label: readOptionalEnv('WOOCOMMERCE_BOOTSTRAP_LABEL'),
    shopDomain: readRequiredEnv('WOOCOMMERCE_BOOTSTRAP_SHOP_DOMAIN'),
    siteUrl: readRequiredEnv('WOOCOMMERCE_BOOTSTRAP_SITE_URL'),
    timezone: readOptionalEnv('WOOCOMMERCE_BOOTSTRAP_TIMEZONE'),
    webhookSecret: readRequiredEnv('WOOCOMMERCE_BOOTSTRAP_WEBHOOK_SECRET')
  });

  console.log(
    JSON.stringify(
      {
        connectionId: connection.id,
        label: connection.label,
        shopDomain: connection.shopDomain,
        siteUrl: connection.siteUrl,
        status: connection.status,
        webhookPath: `/woocommerce/webhooks/${connection.id}/orders`
      },
      null,
      2
    )
  );
} finally {
  await prisma.$disconnect();
}

function readRequiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function readOptionalEnv(name: string): string | null {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') return null;
  return value.trim();
}
