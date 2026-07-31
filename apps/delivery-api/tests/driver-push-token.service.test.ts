import { describe, expect, test, vi } from 'vitest';

import { hashPushToken, PrismaDriverPushTokenService } from '../src/modules/route-grouping/driver-push-token.service.js';

describe('driver push token service', () => {
  test('upserts an installation for the global driver account without a Store driver reference', async () => {
    type UpsertArgs = {
      create: Record<string, unknown>;
      update: Record<string, unknown>;
      where: { tokenHash: string };
    };
    const upsert = vi.fn((args: UpsertArgs) => {
      void args;
      return Promise.resolve({ id: 'push-token-id', status: 'ACTIVE' });
    });
    const service = new PrismaDriverPushTokenService({
      driverPushToken: { upsert }
    } as never);

    const result = await service.upsertDriverPushToken({
      accountId: 'account-id',
      appId: 'com.evnsolution.clever.routes',
      appVersion: '1.1.0',
      deviceId: 'installation-id',
      devicePushToken: 'native-device-token',
      locale: 'en-CA',
      platform: 'android',
      timezone: 'America/Toronto'
    });

    expect(result).toEqual({ id: 'push-token-id', status: 'ACTIVE' });
    expect(upsert).toHaveBeenCalledOnce();
    const [upsertArgs] = upsert.mock.calls[0] ?? [];
    expect(upsertArgs?.create).toMatchObject({
      accountId: 'account-id',
      devicePushToken: 'native-device-token',
      tokenHash: hashPushToken('native-device-token')
    });
    expect(upsertArgs?.update).toMatchObject({
      accountId: 'account-id',
      deviceId: 'installation-id',
      revokedAt: null,
      status: 'ACTIVE'
    });
    expect(upsertArgs?.where).toEqual({
      tokenHash: hashPushToken('native-device-token')
    });
  });

  test('revokes only the matching installation owned by the account', async () => {
    type UpdateManyArgs = {
      data: Record<string, unknown>;
      where: { accountId: string; tokenHash: string };
    };
    const updateMany = vi.fn((args: UpdateManyArgs) => {
      void args;
      return Promise.resolve({ count: 1 });
    });
    const service = new PrismaDriverPushTokenService({
      driverPushToken: { updateMany }
    } as never);

    await expect(service.revokeDriverPushToken({
      accountId: 'account-id',
      devicePushToken: 'native-device-token'
    })).resolves.toEqual({ revoked: true });
    expect(updateMany).toHaveBeenCalledOnce();
    const [updateArgs] = updateMany.mock.calls[0] ?? [];
    expect(updateArgs?.data).toMatchObject({ status: 'REVOKED' });
    expect(updateArgs?.where).toEqual({
      accountId: 'account-id',
      tokenHash: hashPushToken('native-device-token')
    });
  });
});
