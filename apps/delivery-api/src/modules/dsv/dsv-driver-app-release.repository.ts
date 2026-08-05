import type { PrismaClient } from '@prisma/client';

export const DSV_DRIVER_ANDROID_PACKAGE_ID = 'com.evnsolution.clever.driver';
const ANDROID_PLATFORM = 'android';
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export type DsvDriverAppRelease = {
  apkSha256: string;
  installUrl: string;
  latestVersionCode: number;
  latestVersionName: string;
  minimumSupportedVersionCode: number;
  packageId: string;
  platform: 'android';
  publishedAt: Date;
};

export type PublishDsvDriverAndroidReleaseInput = {
  apkSha256: string;
  installUrl: string;
  latestVersionCode: number;
  latestVersionName: string;
  minimumSupportedVersionCode?: number;
};

export type DsvDriverAppReleaseRepository = {
  getAndroidRelease(): Promise<DsvDriverAppRelease | null>;
  publishAndroidRelease(input: PublishDsvDriverAndroidReleaseInput): Promise<DsvDriverAppRelease>;
};

export class DsvDriverAppReleaseConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DsvDriverAppReleaseConflictError';
  }
}

export class PrismaDsvDriverAppReleaseRepository implements DsvDriverAppReleaseRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async getAndroidRelease(): Promise<DsvDriverAppRelease | null> {
    const release = await this.prisma.dsvDriverAppRelease.findUnique({
      where: { platform: ANDROID_PLATFORM },
    });
    return release === null ? null : toRelease(release);
  }

  async publishAndroidRelease(
    input: PublishDsvDriverAndroidReleaseInput,
  ): Promise<DsvDriverAppRelease> {
    const normalized = normalizePublishInput(input);
    const current = await this.prisma.dsvDriverAppRelease.findUnique({
      where: { platform: ANDROID_PLATFORM },
    });
    if (current === null) {
      const created = await this.prisma.dsvDriverAppRelease.create({
        data: {
          ...normalized,
          minimumSupportedVersionCode:
            normalized.minimumSupportedVersionCode ?? normalized.latestVersionCode,
          packageId: DSV_DRIVER_ANDROID_PACKAGE_ID,
          platform: ANDROID_PLATFORM,
          publishedAt: new Date(),
        },
      });
      return toRelease(created);
    }

    const minimumSupportedVersionCode =
      normalized.minimumSupportedVersionCode ?? current.minimumSupportedVersionCode;
    if (normalized.latestVersionCode < current.latestVersionCode) {
      throw new DsvDriverAppReleaseConflictError('Release versionCode cannot be rolled back');
    }
    if (minimumSupportedVersionCode > normalized.latestVersionCode) {
      throw new Error('minimumSupportedVersionCode cannot exceed latestVersionCode');
    }
    if (normalized.latestVersionCode === current.latestVersionCode) {
      if (
        current.apkSha256 === normalized.apkSha256
        && current.installUrl === normalized.installUrl
        && current.latestVersionName === normalized.latestVersionName
        && current.minimumSupportedVersionCode === minimumSupportedVersionCode
      ) {
        return toRelease(current);
      }
      throw new DsvDriverAppReleaseConflictError(
        'The published versionCode already points to different release metadata',
      );
    }

    const updated = await this.prisma.dsvDriverAppRelease.update({
      data: {
        ...normalized,
        minimumSupportedVersionCode,
        packageId: DSV_DRIVER_ANDROID_PACKAGE_ID,
        publishedAt: new Date(),
      },
      where: { platform: ANDROID_PLATFORM },
    });
    return toRelease(updated);
  }
}

function normalizePublishInput(input: PublishDsvDriverAndroidReleaseInput) {
  const installUrl = input.installUrl.trim();
  const latestVersionName = input.latestVersionName.trim();
  const apkSha256 = input.apkSha256.trim().toLowerCase();
  if (!Number.isInteger(input.latestVersionCode) || input.latestVersionCode <= 0) {
    throw new Error('latestVersionCode must be a positive integer');
  }
  if (latestVersionName === '') throw new Error('latestVersionName is required');
  if (!SHA256_PATTERN.test(apkSha256)) throw new Error('apkSha256 must be a SHA-256 hex digest');
  if (!isHttpsUrl(installUrl)) throw new Error('installUrl must use HTTPS');
  if (
    input.minimumSupportedVersionCode !== undefined
    && (!Number.isInteger(input.minimumSupportedVersionCode)
      || input.minimumSupportedVersionCode <= 0)
  ) {
    throw new Error('minimumSupportedVersionCode must be a positive integer');
  }
  return {
    apkSha256,
    installUrl,
    latestVersionCode: input.latestVersionCode,
    latestVersionName,
    ...(input.minimumSupportedVersionCode === undefined
      ? {}
      : { minimumSupportedVersionCode: input.minimumSupportedVersionCode }),
  };
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function toRelease(record: {
  apkSha256: string;
  installUrl: string;
  latestVersionCode: number;
  latestVersionName: string;
  minimumSupportedVersionCode: number;
  packageId: string;
  platform: string;
  publishedAt: Date;
}): DsvDriverAppRelease {
  if (record.platform !== ANDROID_PLATFORM) throw new Error('Unsupported driver app platform');
  return { ...record, platform: ANDROID_PLATFORM };
}
