import { PrismaClient } from '@prisma/client';

import { DEFAULT_WORDPRESS_PLUGIN_PAIRING_CODE_TTL_MINUTES } from '../modules/wordpress-plugin/wordpress-plugin-auth.service.js';
import { PrismaWordPressPluginRepository } from '../modules/wordpress-plugin/wordpress-plugin.repository.js';

const prisma = new PrismaClient();

try {
  const connectionId = readRequiredEnv('WORDPRESS_PLUGIN_PAIRING_CONNECTION_ID');
  const expiresInMinutes = DEFAULT_WORDPRESS_PLUGIN_PAIRING_CODE_TTL_MINUTES;
  const now = new Date();
  const repository = new PrismaWordPressPluginRepository(prisma);
  const result = await repository.createPairingCode({
    commerceConnectionId: connectionId,
    expiresAt: new Date(now.getTime() + expiresInMinutes * 60_000),
    issuedAt: now,
    issuedBy: readOptionalEnv('WORDPRESS_PLUGIN_PAIRING_ISSUED_BY')
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
