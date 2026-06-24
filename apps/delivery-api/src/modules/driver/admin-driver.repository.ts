import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

import type {
  AdminDriverRow,
  CreatePendingDriverRecordInput,
  DeleteAdminDriverInput,
  ListAdminDriversInput,
  RegenerateInviteCodeInput
} from './admin-driver.types.js';
import { appScopedShopWhere, normalizeShopifyAppId } from '../shopify/shopify-app-scope.js';

type AdminDriverPrismaClient = Pick<PrismaClient, 'driver' | 'driverSession' | 'shop'>;

const INVITE_CODE_TTL_HOURS = 24;

type DriverRecord = {
  _count?: { driverEvents?: number };
  authSubject: string | null;
  createdAt: Date;
  displayName: string;
  id: string;
  inviteCode: string | null;
  inviteCodeExpiresAt: Date | null;
  lastSeenAt: Date | null;
  phone: string | null;
  status: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';
  tokenVersion: number;
  tokensInvalidatedAt: Date | null;
  updatedAt: Date;
};

const driverInclude = { _count: { select: { driverEvents: true } } } as const;

export class PrismaAdminDriverRepository {
  constructor(private readonly prisma: AdminDriverPrismaClient) {}

  async createPendingDriver(input: CreatePendingDriverRecordInput): Promise<AdminDriverRow> {
    const appId = normalizeShopifyAppId(input.appId);
    const shopDomain = normalizeShopDomain(input.shopDomain);
    const shop = await this.prisma.shop.upsert({
      create: { appId, shopDomain },
      update: {},
      where: appScopedShopWhere({ appId, shopDomain })
    });
    const displayName = normalizeDisplayName(input.displayName) ?? input.phone;

    const inviteCode = generateInviteCode();
    const inviteCodeExpiresAt = new Date(Date.now() + INVITE_CODE_TTL_HOURS * 60 * 60 * 1000);

    const existing = await this.prisma.driver.findFirst({
      include: driverInclude,
      where: { phone: input.phone, shopId: shop.id }
    });

    if (existing !== null) {
      const driver = await this.prisma.driver.update({
        data: { displayName, phone: input.phone, inviteCode, inviteCodeExpiresAt },
        include: driverInclude,
        where: { id: existing.id }
      });
      return toAdminDriverRow(driver);
    }

    const driver = await this.prisma.driver.create({
      data: {
        authSubject: null,
        displayName,
        phone: input.phone,
        shopId: shop.id,
        status: 'ACTIVE',
        inviteCode,
        inviteCodeExpiresAt
      },
      include: driverInclude
    });

    return toAdminDriverRow(driver);
  }

  async listDrivers(input: ListAdminDriversInput): Promise<AdminDriverRow[]> {
    const appId = normalizeShopifyAppId(input.appId);
    const shopDomain = normalizeShopDomain(input.shopDomain);
    const shop = await this.prisma.shop.findUnique({
      select: { id: true },
      where: appScopedShopWhere({ appId, shopDomain })
    });
    if (shop === null) {
      return [];
    }

    const drivers = await this.prisma.driver.findMany({
      include: driverInclude,
      orderBy: [{ createdAt: 'desc' }, { displayName: 'asc' }],
      where: { shopId: shop.id }
    });

    return drivers.map((driver) => toAdminDriverRow(driver));
  }

  async deleteDriver(input: DeleteAdminDriverInput): Promise<string> {
    const appId = normalizeShopifyAppId(input.appId);
    const shopDomain = normalizeShopDomain(input.shopDomain);
    const shop = await this.prisma.shop.findUnique({
      select: { id: true },
      where: appScopedShopWhere({ appId, shopDomain })
    });
    if (shop === null) {
      throw new Error('Shop not found');
    }

    const deletedDriver = await this.prisma.driver.delete({
      select: { id: true },
      where: { id: input.driverId, shopId: shop.id }
    });

    return deletedDriver.id;
  }

  async regenerateInviteCode(input: RegenerateInviteCodeInput): Promise<AdminDriverRow> {
    const appId = normalizeShopifyAppId(input.appId);
    const shopDomain = normalizeShopDomain(input.shopDomain);
    const shop = await this.prisma.shop.findUnique({
      select: { id: true },
      where: appScopedShopWhere({ appId, shopDomain })
    });
    if (shop === null) {
      throw new Error('Shop not found');
    }

    const inviteCode = generateInviteCode();
    const inviteCodeExpiresAt = new Date(Date.now() + INVITE_CODE_TTL_HOURS * 60 * 60 * 1000);
    const tokensInvalidatedAt = new Date();

    const driver = await this.prisma.driver.update({
      data: {
        authSubject: null,
        inviteCode,
        inviteCodeExpiresAt,
        tokensInvalidatedAt,
        tokenVersion: { increment: 1 }
      },
      include: driverInclude,
      where: { id: input.driverId, shopId: shop.id }
    });
    await this.prisma.driverSession.updateMany({
      data: { revokedAt: tokensInvalidatedAt },
      where: { driverId: driver.id, revokedAt: null }
    });

    return toAdminDriverRow(driver);
  }
}

function toAdminDriverRow(driver: DriverRecord): AdminDriverRow {
  const isInvitePending = driver.authSubject === null;
  return {
    authStatus: isInvitePending ? 'INVITE_PENDING' : 'APP_LINKED',
    authSubject: isInvitePending ? null : 'present',
    createdAt: driver.createdAt.toISOString(),
    displayName: driver.displayName,
    id: driver.id,
    inviteCode: driver.inviteCode,
    inviteCodeExpiresAt: driver.inviteCodeExpiresAt?.toISOString() ?? null,
    lastSeenAt: driver.lastSeenAt?.toISOString() ?? null,
    phone: driver.phone,
    recentEventsCount: driver._count?.driverEvents ?? 0,
    status: isInvitePending ? 'PENDING' : driver.status,
    updatedAt: driver.updatedAt.toISOString()
  };
}

function normalizeDisplayName(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function normalizeShopDomain(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const withoutProtocol = trimmed.replace(/^https?:\/\//u, '').replace(/\/.*$/u, '');

  if (
    withoutProtocol === '' ||
    withoutProtocol.length > 255 ||
    withoutProtocol.startsWith('.') ||
    withoutProtocol.endsWith('.') ||
    !withoutProtocol.includes('.') ||
    !/^[a-z0-9.-]+$/u.test(withoutProtocol)
  ) {
    throw new Error('Shop domain is not a valid customer domain');
  }

  return withoutProtocol;
}

function generateInviteCode(): string {
  return randomBytes(3).toString('hex').toUpperCase();
}
