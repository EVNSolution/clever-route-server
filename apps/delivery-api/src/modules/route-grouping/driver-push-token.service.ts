import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

export type UpsertDriverPushTokenInput = {
  appId: string;
  appVersion?: string | null;
  deviceId?: string | null;
  devicePushToken: string;
  driverId: string;
  locale?: string | null;
  platform: string;
  timezone?: string | null;
};

export type DriverPushTokenService = {
  upsertDriverPushToken(input: UpsertDriverPushTokenInput): Promise<{ id: string; status: string }>;
  revokeDriverPushToken(input: { devicePushToken: string; driverId: string }): Promise<{ revoked: boolean }>;
};

export class PrismaDriverPushTokenService implements DriverPushTokenService {
  constructor(private readonly prisma: PrismaClient) {}

  async upsertDriverPushToken(input: UpsertDriverPushTokenInput): Promise<{ id: string; status: string }> {
    const driver = await this.prisma.driver.findUnique({ select: { id: true, shopId: true }, where: { id: input.driverId } });
    if (driver === null) throw new Error('DRIVER_NOT_FOUND');
    const tokenHash = hashPushToken(input.devicePushToken);
    const record = await this.prisma.driverPushToken.upsert({
      create: {
        appId: input.appId,
        appVersion: input.appVersion ?? null,
        deviceId: input.deviceId ?? null,
        devicePushToken: input.devicePushToken,
        driverId: driver.id,
        lastSeenAt: new Date(),
        locale: input.locale ?? null,
        platform: input.platform,
        shopId: driver.shopId,
        status: 'ACTIVE',
        timezone: input.timezone ?? null,
        tokenHash
      },
      update: {
        appId: input.appId,
        appVersion: input.appVersion ?? null,
        deviceId: input.deviceId ?? null,
        devicePushToken: input.devicePushToken,
        lastSeenAt: new Date(),
        locale: input.locale ?? null,
        platform: input.platform,
        revokedAt: null,
        status: 'ACTIVE',
        timezone: input.timezone ?? null
      },
      where: { driverId_tokenHash: { driverId: driver.id, tokenHash } }
    });
    return { id: record.id, status: record.status };
  }

  async revokeDriverPushToken(input: { devicePushToken: string; driverId: string }): Promise<{ revoked: boolean }> {
    const result = await this.prisma.driverPushToken.updateMany({
      data: { revokedAt: new Date(), status: 'REVOKED' },
      where: { driverId: input.driverId, tokenHash: hashPushToken(input.devicePushToken) }
    });
    return { revoked: result.count > 0 };
  }
}

export function hashPushToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
