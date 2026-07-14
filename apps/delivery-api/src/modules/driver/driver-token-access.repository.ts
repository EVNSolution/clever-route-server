import type { PrismaClient } from '@prisma/client';
import { normalizeDriverCommerceDomain } from './driver-commerce-domain.js';

export type DriverTokenAccessPrismaClient = Pick<PrismaClient, 'driver' | 'driverAccount'>;

export type DriverAccountTokenAccessCheckInput = {
  accountId: string;
  tokenVersion: number;
};

export type DriverTokenAccessCheckInput = {
  driverId: string;
  shopDomain: string;
  tokenVersion: number;
};

export class PrismaDriverTokenAccessRepository {
  constructor(private readonly prisma: DriverTokenAccessPrismaClient) {}

  async isDriverAccountAccessTokenActive(input: DriverAccountTokenAccessCheckInput): Promise<boolean> {
    const account = await this.prisma.driverAccount.findUnique({
      select: { status: true, tokenVersion: true },
      where: { id: input.accountId }
    });

    return account?.status === 'ACTIVE' && account.tokenVersion === input.tokenVersion;
  }

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

export type DriverTokenAccessRepositoryApi = Pick<
  PrismaDriverTokenAccessRepository,
  'isDriverAccessTokenActive' | 'isDriverAccountAccessTokenActive'
>;
