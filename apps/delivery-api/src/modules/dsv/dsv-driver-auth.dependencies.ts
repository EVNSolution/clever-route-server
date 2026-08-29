import type { PrismaClient } from '@prisma/client';

import type { DsvDriverAuthDependencies } from '../../routes/dsv-driver-auth.routes.js';
import { PrismaDsvDriverAuthRepository } from './dsv-driver-auth.repository.js';

export type DsvDriverAuthRuntimeEnv = Partial<Record<
  'CLEVER_DSV_DRIVER_AUTH_ENABLED' | 'JWT_SECRET',
  string
>>;

export function loadDsvDriverAuthDependencies(input: {
  env: DsvDriverAuthRuntimeEnv;
  nodeEnv: string;
  prisma: PrismaClient;
}): DsvDriverAuthDependencies | undefined {
  const enabled = readBoolean(input.env.CLEVER_DSV_DRIVER_AUTH_ENABLED);
  if (enabled !== true) return undefined;

  const jwtSecret = input.env.JWT_SECRET?.trim();
  if (jwtSecret === undefined || jwtSecret === '') {
    throw new Error('CLEVER_DSV_DRIVER_AUTH_ENABLED=true requires JWT_SECRET');
  }
  return {
    jwtSecret,
    repository: new PrismaDsvDriverAuthRepository(input.prisma),
  };
}

function readBoolean(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized === '') return undefined;
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error('CLEVER_DSV_DRIVER_AUTH_ENABLED must be true or false');
}
