import { PrismaClient } from '@prisma/client';

import { PrismaWordPressPluginRepository } from '../modules/wordpress-plugin/wordpress-plugin.repository.js';

const prisma = new PrismaClient();

try {
  const connectionId = readRequiredEnv('WORDPRESS_PLUGIN_PAIRING_CONNECTION_ID');
  const expiresInMinutes = readPositiveInteger(process.env.WORDPRESS_PLUGIN_PAIRING_TTL_MINUTES ?? '15');
  const now = new Date();
  const repository = new PrismaWordPressPluginRepository(prisma);
  const result = await repository.createPairingCode({
    commerceConnectionId: connectionId,
    expiresAt: new Date(now.getTime() + expiresInMinutes * 60_000),
    issuedAt: now,
    issuedBy: readOptionalEnv('WORDPRESS_PLUGIN_PAIRING_ISSUED_BY'),
    siteUrl: readOptionalEnv('WORDPRESS_PLUGIN_PAIRING_SITE_URL')
  });

  console.log(
    JSON.stringify(
      {
        code: result.code,
        commerceConnectionId: connectionId,
        expiresAt: result.expiresAt.toISOString(),
        siteUrl: result.siteUrl
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

function readPositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error('WORDPRESS_PLUGIN_PAIRING_TTL_MINUTES must be a positive integer');
  }
  return parsed;
}
