import { describe, expect, test, vi } from 'vitest';

import {
  ROUTES_APP_ANDROID_PACKAGE_ID,
  RoutesAppReleaseConflictError,
  PrismaRoutesAppReleaseRepository,
} from '../src/modules/routes-app/routes-app-release.repository.js';

const currentArtifact = {
  createdAt: new Date('2026-08-05T00:00:00.000Z'),
  distributionChannel: 'direct',
  downloadUrl: 'https://downloads.example.test/clever-routes-2.apk',
  id: '00000000-0000-0000-0000-000000000002',
  minimumSupportedVersionCode: 1,
  packageId: ROUTES_APP_ANDROID_PACKAGE_ID,
  platform: 'android',
  publishedAt: new Date('2026-08-05T01:00:00.000Z'),
  sha256: 'a'.repeat(64),
  versionCode: 2,
  versionName: '1.0.1',
};

const currentChannel = {
  channel: 'direct',
  createdAt: new Date('2026-08-05T00:00:00.000Z'),
  currentArtifact: currentArtifact,
  currentArtifactId: currentArtifact.id,
  platform: 'android',
  updatedAt: new Date('2026-08-05T01:00:00.000Z'),
};

function createPrismaMock(tx: unknown) {
  return {
    $transaction: vi.fn((callback: (client: unknown) => Promise<unknown>) => callback(tx)),
  };
}

describe('Routes app release repository', () => {
  test('treats an identical release publish as an idempotent retry', async () => {
    const updateMany = vi.fn();
    const tx = {
      routesAppReleaseArtifact: { create: vi.fn(), findUnique: vi.fn() },
      routesAppReleaseChannel: {
        create: vi.fn(),
        findUnique: vi.fn().mockResolvedValue(currentChannel),
        updateMany,
      },
    };
    const repository = new PrismaRoutesAppReleaseRepository(createPrismaMock(tx) as never);

    await expect(repository.publishAndroidRelease({
      downloadUrl: currentArtifact.downloadUrl,
      latestVersionCode: 2,
      latestVersionName: '1.0.1',
      minimumSupportedVersionCode: 1,
      sha256: currentArtifact.sha256,
    })).resolves.toMatchObject({
      latestVersionCode: 2,
      packageId: ROUTES_APP_ANDROID_PACKAGE_ID,
    });
    expect(updateMany).not.toHaveBeenCalled();
  });

  test('preserves the current minimum supported version when publishing a newer APK without an override', async () => {
    const nextArtifact = {
      ...currentArtifact,
      downloadUrl: 'https://downloads.example.test/clever-routes-3.apk',
      id: '00000000-0000-0000-0000-000000000003',
      sha256: 'b'.repeat(64),
      versionCode: 3,
      versionName: '1.0.2',
    };
    const create = vi.fn().mockResolvedValue(nextArtifact);
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const tx = {
      routesAppReleaseArtifact: { create, findUnique: vi.fn().mockResolvedValue(null) },
      routesAppReleaseChannel: {
        create: vi.fn(),
        findUnique: vi.fn().mockResolvedValue(currentChannel),
        updateMany,
      },
    };
    const repository = new PrismaRoutesAppReleaseRepository(createPrismaMock(tx) as never);

    await repository.publishAndroidRelease({
      downloadUrl: nextArtifact.downloadUrl,
      latestVersionCode: 3,
      latestVersionName: '1.0.2',
      sha256: nextArtifact.sha256,
    });

    const createInput = create.mock.calls[0]?.[0] as {
      data: { minimumSupportedVersionCode: number; packageId: string; versionCode: number };
    };
    expect(createInput.data.minimumSupportedVersionCode).toBe(1);
    expect(createInput.data.packageId).toBe(ROUTES_APP_ANDROID_PACKAGE_ID);
    expect(createInput.data.versionCode).toBe(3);
    expect(updateMany).toHaveBeenCalledWith({
      data: { currentArtifactId: nextArtifact.id },
      where: {
        channel: 'direct',
        currentArtifactId: currentArtifact.id,
        platform: 'android',
      },
    });
  });

  test('rejects rollback and same-version metadata changes', async () => {
    const tx = {
      routesAppReleaseArtifact: { create: vi.fn(), findUnique: vi.fn() },
      routesAppReleaseChannel: {
        create: vi.fn(),
        findUnique: vi.fn().mockResolvedValue(currentChannel),
        updateMany: vi.fn(),
      },
    };
    const repository = new PrismaRoutesAppReleaseRepository(createPrismaMock(tx) as never);

    await expect(repository.publishAndroidRelease({
      downloadUrl: currentArtifact.downloadUrl,
      latestVersionCode: 1,
      latestVersionName: '1.0.0',
      sha256: 'b'.repeat(64),
    })).rejects.toBeInstanceOf(RoutesAppReleaseConflictError);

    await expect(repository.publishAndroidRelease({
      downloadUrl: 'https://downloads.example.test/changed.apk',
      latestVersionCode: 2,
      latestVersionName: '1.0.1',
      minimumSupportedVersionCode: 1,
      sha256: currentArtifact.sha256,
    })).rejects.toBeInstanceOf(RoutesAppReleaseConflictError);
  });

  test('fails the publish when the current pointer changed concurrently', async () => {
    const nextArtifact = {
      ...currentArtifact,
      id: '00000000-0000-0000-0000-000000000003',
      sha256: 'b'.repeat(64),
      versionCode: 3,
      versionName: '1.0.2',
    };
    const tx = {
      routesAppReleaseArtifact: {
        create: vi.fn().mockResolvedValue(nextArtifact),
        findUnique: vi.fn().mockResolvedValue(null),
      },
      routesAppReleaseChannel: {
        create: vi.fn(),
        findUnique: vi.fn().mockResolvedValue(currentChannel),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const repository = new PrismaRoutesAppReleaseRepository(createPrismaMock(tx) as never);

    await expect(repository.publishAndroidRelease({
      downloadUrl: nextArtifact.downloadUrl,
      latestVersionCode: 3,
      latestVersionName: '1.0.2',
      sha256: nextArtifact.sha256,
    })).rejects.toBeInstanceOf(RoutesAppReleaseConflictError);
  });
});
