import { describe, expect, test, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import type { DsvDriverAppReleaseRepository } from '../src/modules/dsv/dsv-driver-app-release.repository.js';

const release = {
  apkSha256: 'a'.repeat(64),
  installUrl: 'https://drive.usercontent.google.com/download?id=fixed&export=download',
  latestVersionCode: 2,
  latestVersionName: '0.1.1',
  minimumSupportedVersionCode: 2,
  packageId: 'com.evnsolution.clever.driver',
  platform: 'android' as const,
  publishedAt: new Date('2026-08-05T01:00:00.000Z'),
};

describe('DSV Driver app release route', () => {
  test('returns the current Android release without authentication and disables caching', async () => {
    const getAndroidRelease = vi.fn<DsvDriverAppReleaseRepository['getAndroidRelease']>()
      .mockResolvedValue(release);
    const repository: DsvDriverAppReleaseRepository = {
      getAndroidRelease,
      publishAndroidRelease: vi.fn(),
    };
    const app = await buildApp({
      dsvDriverAppRelease: {
        repository,
      },
    });

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/dsv/driver/app-release/android',
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json()).toEqual({
        data: { ...release, publishedAt: '2026-08-05T01:00:00.000Z' },
        error: null,
      });
    } finally {
      await app.close();
    }
  });

  test('returns a stable not-published response before the first release is injected', async () => {
    const app = await buildApp({
      dsvDriverAppRelease: {
        repository: {
          getAndroidRelease: vi.fn().mockResolvedValue(null),
          publishAndroidRelease: vi.fn(),
        },
      },
    });

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/dsv/driver/app-release/android',
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        data: null,
        error: {
          code: 'APP_RELEASE_NOT_PUBLISHED',
          message: 'CLEVER Driver Android release has not been published',
        },
      });
    } finally {
      await app.close();
    }
  });
});
