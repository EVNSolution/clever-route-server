import { describe, expect, test, vi } from 'vitest';
import { DRIVER_GPS_CHECK_APP_ID, PrismaDriverGpsCheckPushService } from '../src/modules/driver/driver-gps-check-push.service.js';
import { hashPushToken } from '../src/modules/route-grouping/driver-push-token.service.js';

function harness(options: { accountId?: string | null; tokens?: Array<{ devicePushToken: string; id: string }>; provider?: unknown } = {}) {
  const prisma = {
    driver: { findUnique: vi.fn().mockResolvedValue({ accountId: options.accountId === undefined ? 'acct-1' : options.accountId }) },
    driverPushToken: {
      findMany: vi.fn().mockResolvedValue(options.tokens ?? [{ devicePushToken: 'tok-a', id: 'id-a' }]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 })
    }
  };
  const provider = options.provider ?? { providerName: 'fake', sendGpsCheck: vi.fn().mockResolvedValue({ providerMessageId: 'm', status: 'SENT' }), sendRouteNotification: vi.fn() };
  return { prisma, provider, service: new PrismaDriverGpsCheckPushService(prisma as never, provider as never, () => new Date('2026-10-14T01:00:00.000Z')) };
}
const input = { driverId: 'driver-1', routePlanId: 'route-1', severity: 'WARNING' as const, silentSeconds: 61 };

describe('driver gps check push service', () => {
  test('targets only active android tokens of the CLEVER Routes app for the driver account', async () => {
    const h = harness();
    await expect(h.service.send(input)).resolves.toMatchObject({ failed: 0, invalidated: 0, reason: null, sent: 1 });
    expect(h.prisma.driverPushToken.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { accountId: 'acct-1', appId: DRIVER_GPS_CHECK_APP_ID, platform: 'android', status: 'ACTIVE' }
    }));
    expect((h.provider as { sendGpsCheck: ReturnType<typeof vi.fn> }).sendGpsCheck).toHaveBeenCalledWith(expect.objectContaining({
      devicePushToken: 'tok-a', routePlanId: 'route-1', severity: 'WARNING', silentSeconds: 61, sentAt: '2026-10-14T01:00:00.000Z'
    }));
  });

  test('reports a missing token or missing provider without sending', async () => {
    await expect(harness({ tokens: [] }).service.send(input)).resolves.toMatchObject({ reason: 'NO_ACTIVE_TOKEN', sent: 0 });
    await expect(harness({ accountId: null }).service.send(input)).resolves.toMatchObject({ reason: 'NO_ACTIVE_TOKEN', sent: 0 });
    await expect(harness({ provider: { providerName: 'x', sendRouteNotification: vi.fn() } }).service.send(input)).resolves.toMatchObject({ reason: 'NO_PROVIDER', sent: 0 });
  });

  test('marks a token the provider rejects as invalid', async () => {
    const provider = { providerName: 'fake', sendGpsCheck: vi.fn().mockResolvedValue({ invalidToken: true, status: 'FAILED' }), sendRouteNotification: vi.fn() };
    const h = harness({ provider });
    await expect(h.service.send(input)).resolves.toMatchObject({ failed: 1, invalidated: 1, sent: 0 });
    expect(h.prisma.driverPushToken.updateMany).toHaveBeenCalledWith({
      data: { revokedAt: new Date('2026-10-14T01:00:00.000Z'), status: 'INVALID' },
      where: { id: 'id-a', tokenHash: hashPushToken('tok-a') }
    });
  });
});
