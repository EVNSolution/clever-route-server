import type { Prisma, PrismaClient } from '@prisma/client';

import { appScopedShopWhere } from '../shopify/shopify-app-scope.js';
import { normalizeDsvDriverPhone } from './dsv-driver-identity.js';

export type DsvDriverAccountLinkReview = {
  accountId: string;
  accountName: string;
  accountPhoneLast4: string | null;
  createdAt: string;
  driverId: string;
  driverName: string;
  driverPhoneLast4: string | null;
  reason: 'NAME_MISMATCH' | 'PHONE_MISMATCH';
};

export type DsvDriverAccountLinkService = {
  approve(input: {
    accountId: string;
    actorId: string;
    driverId: string;
    requestId: string;
    shopDomain: string;
  }): Promise<{ accountId: string; driverId: string }>;
  listPending(input: { shopDomain: string }): Promise<DsvDriverAccountLinkReview[]>;
};

type DriverAccountLinkPrismaClient = Pick<
  PrismaClient,
  '$transaction' | 'driver' | 'driverAccount' | 'shop'
>;

export class DsvDriverAccountLinkCandidateError extends Error {
  constructor(public readonly code: 'CONFLICT' | 'NOT_FOUND' = 'CONFLICT') {
    super(code === 'NOT_FOUND' ? 'Driver account link candidate was not found' : 'Driver account link candidate is no longer eligible');
    this.name = 'DsvDriverAccountLinkCandidateError';
  }
}

export class PrismaDsvDriverAccountLinkService implements DsvDriverAccountLinkService {
  constructor(private readonly prisma: DriverAccountLinkPrismaClient) {}

  async listPending(input: { shopDomain: string }): Promise<DsvDriverAccountLinkReview[]> {
    const shop = await this.prisma.shop.findUnique({
      select: { id: true },
      where: appScopedShopWhere({ shopDomain: input.shopDomain.trim().toLowerCase() }),
    });
    if (shop === null) return [];
    const [drivers, accounts] = await Promise.all([
      this.prisma.driver.findMany({
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { createdAt: true, displayName: true, id: true, phone: true },
        where: { accountId: null, dsvProfile: { isNot: null }, shopId: shop.id, status: 'ACTIVE' },
      }),
      this.prisma.driverAccount.findMany({
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { createdAt: true, id: true, name: true, phone: true },
        where: {
          drivers: { none: { dsvProfile: { isNot: null }, status: 'ACTIVE' } },
          name: { not: null },
          status: 'ACTIVE',
        },
      }),
    ]);
    const reviews: DsvDriverAccountLinkReview[] = [];
    for (const account of accounts) {
      if (account.name === null) continue;
      const accountPhone = normalizeDsvDriverPhone(account.phone);
      for (const driver of drivers) {
        const driverPhone = normalizeDsvDriverPhone(driver.phone ?? '');
        const nameMatches = driver.displayName.trim() === account.name.trim();
        const phoneMatches = driverPhone !== '' && driverPhone === accountPhone;
        if (nameMatches === phoneMatches) continue;
        reviews.push({
          accountId: account.id,
          accountName: account.name,
          accountPhoneLast4: last4(accountPhone),
          createdAt: account.createdAt.toISOString(),
          driverId: driver.id,
          driverName: driver.displayName,
          driverPhoneLast4: last4(driverPhone),
          reason: nameMatches ? 'PHONE_MISMATCH' : 'NAME_MISMATCH',
        });
      }
    }
    return reviews.sort((left, right) => right.createdAt.localeCompare(left.createdAt)
      || left.driverName.localeCompare(right.driverName)
      || left.driverId.localeCompare(right.driverId));
  }

  async approve(input: {
    accountId: string;
    actorId: string;
    driverId: string;
    requestId: string;
    shopDomain: string;
  }): Promise<{ accountId: string; driverId: string }> {
    const shop = await this.prisma.shop.findUnique({
      select: { id: true },
      where: appScopedShopWhere({ shopDomain: input.shopDomain.trim().toLowerCase() }),
    });
    if (shop === null) throw new DsvDriverAccountLinkCandidateError('NOT_FOUND');
    return this.prisma.$transaction(async (tx) => {
      const [account, driver] = await Promise.all([
        tx.driverAccount.findFirst({
          select: { id: true, name: true, phone: true, status: true },
          where: {
            drivers: { none: { dsvProfile: { isNot: null }, status: 'ACTIVE' } },
            id: input.accountId,
            name: { not: null },
            status: 'ACTIVE',
          },
        }),
        tx.driver.findFirst({
          select: { accountId: true, displayName: true, id: true, phone: true, status: true },
          where: { accountId: null, dsvProfile: { isNot: null }, id: input.driverId, shopId: shop.id, status: 'ACTIVE' },
        }),
      ]);
      if (account === null || account.name === null || driver === null) {
        throw new DsvDriverAccountLinkCandidateError('NOT_FOUND');
      }
      const nameMatches = account.name.trim() === driver.displayName.trim();
      const accountPhone = normalizeDsvDriverPhone(account.phone);
      const driverPhone = normalizeDsvDriverPhone(driver.phone ?? '');
      const phoneMatches = driverPhone !== '' && driverPhone === accountPhone;
      if (!nameMatches && !phoneMatches) throw new DsvDriverAccountLinkCandidateError();
      const linked = await tx.driver.updateMany({
        data: {
          accountId: account.id,
          authSubject: `driver-${driver.id}`,
          inviteCode: null,
          inviteCodeExpiresAt: null,
        },
        where: { accountId: null, id: driver.id, shopId: shop.id, status: 'ACTIVE' },
      });
      if (linked.count !== 1) throw new DsvDriverAccountLinkCandidateError();
      await tx.dsvAuditEvent.create({
        data: {
          actorId: input.actorId,
          actorType: 'DSV_ADMIN',
          entityId: driver.id,
          entityType: 'DRIVER_ACCOUNT_LINK',
          eventType: 'DRIVER_ACCOUNT_LINK_APPROVED',
          principalType: 'DSV_ADMIN',
          redactedDiff: {
            accountLinked: true,
            matchBasis: nameMatches ? 'NAME' : 'PHONE',
          } satisfies Prisma.InputJsonObject,
          redactionClass: 'PII_REDACTED',
          requestId: input.requestId,
          shopId: shop.id,
        },
      });
      return { accountId: account.id, driverId: driver.id };
    });
  }
}

function last4(phone: string): string | null {
  return phone.length < 4 ? null : phone.slice(-4);
}
