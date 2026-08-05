import { describe, expect, test, vi } from 'vitest';

import {
  DsvDriverAppReleaseConflictError,
  PrismaDsvDriverAppReleaseRepository,
} from '../src/modules/dsv/dsv-driver-app-release.repository.js';

const current = {
  apkSha256: 'a'.repeat(64),
  createdAt: new Date('2026-08-05T00:00:00.000Z'),
  installUrl: 'https://drive.usercontent.google.com/download?id=fixed&export=download',
  latestVersionCode: 2,
  latestVersionName: '0.1.1',
  minimumSupportedVersionCode: 2,
  packageId: 'com.evnsolution.clever.driver',
  platform: 'android',
  publishedAt: new Date('2026-08-05T01:00:00.000Z'),
  updatedAt: new Date('2026-08-05T01:00:00.000Z'),
};

describe('DSV Driver app release repository', () => {
  test('treats an identical release injection as an idempotent retry', async () => {
    const findUnique = vi.fn().mockResolvedValue(current);
    const update = vi.fn();
    const repository = new PrismaDsvDriverAppReleaseRepository({
      dsvDriverAppRelease: { create: vi.fn(), findUnique, update },
    } as never);

    await expect(repository.publishAndroidRelease({
      apkSha256: current.apkSha256,
      installUrl: current.installUrl,
      latestVersionCode: 2,
      latestVersionName: '0.1.1',
      minimumSupportedVersionCode: 2,
    })).resolves.toMatchObject({ latestVersionCode: 2 });
    expect(update).not.toHaveBeenCalled();
  });

  test('preserves the minimum supported version when publishing a newer APK', async () => {
    const update = vi.fn<(input: unknown) => Promise<typeof current>>().mockResolvedValue({
      ...current,
      apkSha256: 'b'.repeat(64),
      latestVersionCode: 3,
      latestVersionName: '0.1.2',
    });
    const repository = new PrismaDsvDriverAppReleaseRepository({
      dsvDriverAppRelease: {
        create: vi.fn(),
        findUnique: vi.fn().mockResolvedValue(current),
        update,
      },
    } as never);

    await repository.publishAndroidRelease({
      apkSha256: 'b'.repeat(64),
      installUrl: current.installUrl,
      latestVersionCode: 3,
      latestVersionName: '0.1.2',
    });

    expect(update).toHaveBeenCalledOnce();
    const updateInput = update.mock.calls[0]?.[0] as {
      data: { minimumSupportedVersionCode: number };
    };
    expect(updateInput.data.minimumSupportedVersionCode).toBe(2);
  });

  test('rejects rollback injection', async () => {
    const repository = new PrismaDsvDriverAppReleaseRepository({
      dsvDriverAppRelease: {
        create: vi.fn(),
        findUnique: vi.fn().mockResolvedValue(current),
        update: vi.fn(),
      },
    } as never);

    await expect(repository.publishAndroidRelease({
      apkSha256: 'b'.repeat(64),
      installUrl: current.installUrl,
      latestVersionCode: 1,
      latestVersionName: '0.1.0',
    })).rejects.toBeInstanceOf(DsvDriverAppReleaseConflictError);
  });
});
