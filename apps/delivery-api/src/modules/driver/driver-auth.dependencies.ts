import type { PrismaClient } from '@prisma/client';
import { PrismaDriverAuthRepository } from './driver-auth.repository.js';
import { PrismaDriverTokenAccessRepository } from './driver-token-access.repository.js';
import { PrismaDriverPushTokenService } from '../route-grouping/driver-push-token.service.js';
import type { DriverAuthDependencies } from '../../routes/driver-auth.routes.js';
import { readDriverJwtSecret } from './driver-token-verifier.js';

type LoadDriverAuthDependenciesInput = {
  env: Partial<Record<'JWT_SECRET', string>>;
  prisma: PrismaClient;
};

export function loadDriverAuthDependencies(
  input: LoadDriverAuthDependenciesInput
): DriverAuthDependencies | undefined {
  const jwtSecret = readDriverJwtSecret(input.env.JWT_SECRET);
  if (jwtSecret === undefined) return undefined;

  return {
    driverAuthRepository: new PrismaDriverAuthRepository(input.prisma),
    driverTokenAccessRepository: new PrismaDriverTokenAccessRepository(input.prisma),
    pushTokenService: new PrismaDriverPushTokenService(input.prisma),
    jwtSecret
  };
}
