import type { PrismaClient } from '@prisma/client';

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
        shop: { shopDomain: normalizeShopDomain(input.shopDomain) },
        status: 'ACTIVE'
      }
    });

    return driver !== null && driver.tokenVersion === input.tokenVersion;
  }
}

function normalizeShopDomain(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const withoutProtocol = trimmed.replace(/^https?:\/\//u, '').replace(/\/$/u, '');

  if (!withoutProtocol.endsWith('.myshopify.com')) {
    throw new Error('Shop domain must end with .myshopify.com');
  }

  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/u.test(withoutProtocol)) {
    throw new Error('Shop domain is not a valid myshopify.com domain');
  }

  return withoutProtocol;
}
