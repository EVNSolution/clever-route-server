import { PrismaClient } from '@prisma/client';

import { PrismaDsvAdminAccountRepository } from '../modules/dsv/dsv-admin-account.repository.js';

const prisma = new PrismaClient();

try {
  const loginId = requiredEnv('CLEVER_DSV_BOOTSTRAP_ADMIN_ID');
  const password = requiredEnv('CLEVER_DSV_BOOTSTRAP_ADMIN_PASSWORD');
  const displayName = process.env.CLEVER_DSV_BOOTSTRAP_ADMIN_DISPLAY_NAME?.trim();
  const resetExisting = process.env.CLEVER_DSV_BOOTSTRAP_ADMIN_RESET?.trim().toLowerCase() === 'true';
  const result = await new PrismaDsvAdminAccountRepository(prisma).bootstrap({
    ...(displayName === undefined || displayName === '' ? {} : { displayName }),
    loginId,
    password,
    resetExisting,
  });
  process.stdout.write(`DSV admin account ready: ${loginId} (${result.created ? 'created' : result.reset ? 'reset' : 'unchanged'})\n`);
} finally {
  await prisma.$disconnect();
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === '') throw new Error(`${name} is required`);
  return value;
}
