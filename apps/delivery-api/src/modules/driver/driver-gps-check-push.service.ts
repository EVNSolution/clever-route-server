import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { DriverPushProvider } from '../route-grouping/driver-push.provider.js';
import { hashPushToken } from '../route-grouping/driver-push-token.service.js';

/** Only the CLEVER Routes app understands driver_gps_check; the legacy driver app tokens are skipped. */
export const DRIVER_GPS_CHECK_APP_ID = 'com.evnsolution.clever.routes';

export type DriverGpsCheckPushResult = {
  failed: number;
  invalidated: number;
  pushId: string;
  reason: 'NO_ACTIVE_TOKEN' | 'NO_PROVIDER' | null;
  sent: number;
};

export type DriverGpsCheckPusher = {
  send(input: {
    driverId: string;
    routePlanId: string;
    severity: 'CRITICAL' | 'WARNING';
    silentSeconds: number;
  }): Promise<DriverGpsCheckPushResult>;
};

export class PrismaDriverGpsCheckPushService implements DriverGpsCheckPusher {
  constructor(
    private readonly prisma: Pick<PrismaClient, 'driver' | 'driverPushToken'>,
    private readonly provider: DriverPushProvider,
    private readonly now: () => Date = () => new Date()
  ) {}

  async send(input: { driverId: string; routePlanId: string; severity: 'CRITICAL' | 'WARNING'; silentSeconds: number }): Promise<DriverGpsCheckPushResult> {
    const pushId = randomUUID();
    const empty = { failed: 0, invalidated: 0, pushId, sent: 0 };
    if (this.provider.sendGpsCheck === undefined) return { ...empty, reason: 'NO_PROVIDER' };
    const driver = await this.prisma.driver.findUnique({ select: { accountId: true }, where: { id: input.driverId } });
    if (driver?.accountId === null || driver === null) return { ...empty, reason: 'NO_ACTIVE_TOKEN' };
    const tokens = await this.prisma.driverPushToken.findMany({
      orderBy: { lastSeenAt: 'desc' },
      where: { accountId: driver.accountId, appId: DRIVER_GPS_CHECK_APP_ID, platform: 'android', status: 'ACTIVE' }
    });
    if (tokens.length === 0) return { ...empty, reason: 'NO_ACTIVE_TOKEN' };
    const sentAt = this.now().toISOString();
    const send = this.provider.sendGpsCheck.bind(this.provider);
    const results = await Promise.all(tokens.map(async (token) => ({
      result: await send({
        devicePushToken: token.devicePushToken,
        pushId,
        routePlanId: input.routePlanId,
        sentAt,
        severity: input.severity,
        silentSeconds: input.silentSeconds
      }),
      token
    })));
    let invalidated = 0;
    for (const { result, token } of results) {
      if (result.invalidToken !== true) continue;
      const updated = await this.prisma.driverPushToken.updateMany({
        data: { revokedAt: this.now(), status: 'INVALID' },
        where: { id: token.id, tokenHash: hashPushToken(token.devicePushToken) }
      });
      invalidated += updated.count;
    }
    return {
      failed: results.filter(({ result }) => result.status === 'FAILED').length,
      invalidated,
      pushId,
      reason: null,
      sent: results.filter(({ result }) => result.status === 'SENT').length
    };
  }
}
