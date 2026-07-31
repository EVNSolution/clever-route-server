import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

export type UpsertDriverPushTokenInput = {
  accountId: string;
  appId: string;
  appVersion?: string | null;
  deviceId?: string | null;
  devicePushToken: string;
  locale?: string | null;
  platform: string;
  timezone?: string | null;
};

export type DriverPushTokenService = {
  upsertDriverPushToken(input: UpsertDriverPushTokenInput): Promise<{ id: string; status: string }>;
  revokeDriverPushToken(input: { accountId: string; devicePushToken: string }): Promise<{ revoked: boolean }>;
};

export class PrismaDriverPushTokenService implements DriverPushTokenService {
  constructor(private readonly prisma: PrismaClient) {}

  async upsertDriverPushToken(input: UpsertDriverPushTokenInput): Promise<{ id: string; status: string }> {
    const tokenHash = hashPushToken(input.devicePushToken);
    const record = await this.prisma.driverPushToken.upsert({
      create: {
        accountId: input.accountId,
        appId: input.appId,
        appVersion: input.appVersion ?? null,
        deviceId: input.deviceId ?? null,
        devicePushToken: input.devicePushToken,
        lastSeenAt: new Date(),
        locale: input.locale ?? null,
        platform: input.platform,
        status: 'ACTIVE',
        timezone: input.timezone ?? null,
        tokenHash
      },
      update: {
        accountId: input.accountId,
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
      where: { tokenHash }
    });
    return { id: record.id, status: record.status };
  }

  async revokeDriverPushToken(input: { accountId: string; devicePushToken: string }): Promise<{ revoked: boolean }> {
    const result = await this.prisma.driverPushToken.updateMany({
      data: { revokedAt: new Date(), status: 'REVOKED' },
      where: { accountId: input.accountId, tokenHash: hashPushToken(input.devicePushToken) }
    });
    return { revoked: result.count > 0 };
  }
}

export function hashPushToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
