import type { PrismaClient } from '@prisma/client';
import { PrismaDriverAuthRepository } from './driver-auth.repository.js';
import { PrismaDriverPushTokenService } from '../route-grouping/driver-push-token.service.js';
import type { DriverAuthDependencies } from '../../routes/driver-auth.routes.js';

type LoadDriverAuthDependenciesInput = {
  env: Partial<Record<'JWT_SECRET', string>>;
  prisma: PrismaClient;
};

export function loadDriverAuthDependencies(
  input: LoadDriverAuthDependenciesInput
): DriverAuthDependencies | undefined {
  const jwtSecret = input.env.JWT_SECRET?.trim();
  if (!jwtSecret) {
    return undefined;
  }

  return {
    driverAuthRepository: new PrismaDriverAuthRepository(input.prisma),
    pushTokenService: new PrismaDriverPushTokenService(input.prisma),
    jwtSecret
  };
}
