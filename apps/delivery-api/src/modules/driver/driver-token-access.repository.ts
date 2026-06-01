import type { PrismaClient } from '@prisma/client';
import { normalizeDriverCommerceDomain } from './driver-commerce-domain.js';

export type DriverTokenAccessPrismaClient = Pick<PrismaClient, 'driver'>;

export type DriverTokenAccessCheckInput = {
  driverId: string;
  shopDomain: string;
  tokenVersion: number;
};

export type DriverTokenAccessRepositoryContract = {
  isDriverAccessTokenActive(input: DriverTokenAccessCheckInput): Promise<boolean>;
};

export class PrismaDriverTokenAccessRepository implements DriverTokenAccessRepositoryContract {
  constructor(private readonly prisma: DriverTokenAccessPrismaClient) {}

  async isDriverAccessTokenActive(input: DriverTokenAccessCheckInput): Promise<boolean> {
    const driver = await this.prisma.driver.findFirst({
      select: { tokenVersion: true },
      where: {
        authSubject: { not: null },
        id: input.driverId,
        shop: { shopDomain: normalizeDriverCommerceDomain(input.shopDomain) },
        status: 'ACTIVE'
      }
    });

    return driver !== null && driver.tokenVersion === input.tokenVersion;
  }
}
