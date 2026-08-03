import { PrismaClient } from '@prisma/client';

import { seedDsvDriverTestIdentity } from '../modules/dsv/dsv-driver-test-identity.seed.js';

const prisma = new PrismaClient();

try {
  const unexpectedArguments = process.argv.slice(2).filter((argument) => argument !== '--apply');
  if (unexpectedArguments.length > 0) throw new Error('Only --apply is supported');
  if (process.env.NODE_ENV !== 'production') {
    throw new Error('This guarded seed is allowed only with NODE_ENV=production');
  }

  const result = await seedDsvDriverTestIdentity({
    apply: process.argv.includes('--apply'),
    approval: requiredEnv('CLEVER_DSV_DRIVER_TEST_IDENTITY_APPROVAL'),
    driverId: requiredEnv('CLEVER_DSV_DRIVER_TEST_IDENTITY_DRIVER_ID'),
    expectedName: requiredEnv('CLEVER_DSV_DRIVER_TEST_IDENTITY_EXPECTED_NAME'),
    identitySecret: requiredEnv('DSV_DRIVER_IDENTITY_SECRET'),
    prisma,
    residentNumberFront: requiredEnv('CLEVER_DSV_DRIVER_TEST_RESIDENT_NUMBER_FRONT'),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await prisma.$disconnect();
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === '') throw new Error(`${name} is required`);
  return value;
}
