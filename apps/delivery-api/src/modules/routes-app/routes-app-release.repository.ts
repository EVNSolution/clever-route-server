import type { Prisma, PrismaClient } from '@prisma/client';

export const ROUTES_APP_ANDROID_PACKAGE_ID = 'com.evnsolution.clever.routes';

const ANDROID_PLATFORM = 'android';
const DIRECT_CHANNEL = 'direct';
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export type RoutesAppAndroidRelease = {
  distributionChannel: 'direct';
  downloadUrl: string;
  latestVersionCode: number;
  latestVersionName: string;
  minimumSupportedVersionCode: number;
  packageId: string;
  platform: 'android';
  publishedAt: Date;
  sha256: string;
};

export type PublishRoutesAppAndroidReleaseInput = {
  downloadUrl: string;
  latestVersionCode: number;
  latestVersionName: string;
  minimumSupportedVersionCode?: number;
  sha256: string;
};

export type RoutesAppReleaseRepository = {
  getAndroidRelease(): Promise<RoutesAppAndroidRelease | null>;
  publishAndroidRelease(input: PublishRoutesAppAndroidReleaseInput): Promise<RoutesAppAndroidRelease>;
};

export class RoutesAppReleaseConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoutesAppReleaseConflictError';
  }
}

export class PrismaRoutesAppReleaseRepository implements RoutesAppReleaseRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async getAndroidRelease(): Promise<RoutesAppAndroidRelease | null> {
    const current = await this.prisma.routesAppReleaseChannel.findUnique({
      include: { currentArtifact: true },
      where: {
        channel_platform: {
          channel: DIRECT_CHANNEL,
          platform: ANDROID_PLATFORM,
        },
      },
    });
    return current === null ? null : toAndroidRelease(current.currentArtifact);
  }

  async publishAndroidRelease(
    input: PublishRoutesAppAndroidReleaseInput,
  ): Promise<RoutesAppAndroidRelease> {
    const normalized = normalizePublishInput(input);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const currentChannel = await tx.routesAppReleaseChannel.findUnique({
          include: { currentArtifact: true },
          where: {
            channel_platform: {
              channel: DIRECT_CHANNEL,
              platform: ANDROID_PLATFORM,
            },
          },
        });
        const current = currentChannel?.currentArtifact;

        if (current !== undefined) {
          if (normalized.latestVersionCode < current.versionCode) {
            throw new RoutesAppReleaseConflictError('Release versionCode cannot be rolled back');
          }
          if (normalized.latestVersionCode === current.versionCode) {
            if (isSameRelease(current, normalized)) return toAndroidRelease(current);
            throw new RoutesAppReleaseConflictError(
              'The published versionCode already points to different release metadata',
            );
          }
        }

        const minimumSupportedVersionCode =
          normalized.minimumSupportedVersionCode ?? current?.minimumSupportedVersionCode ?? normalized.latestVersionCode;
        if (minimumSupportedVersionCode > normalized.latestVersionCode) {
          throw new Error('minimumSupportedVersionCode cannot exceed latestVersionCode');
        }
        const artifact = await findOrCreateArtifact(tx, {
          ...normalized,
          minimumSupportedVersionCode,
        });

        if (currentChannel === null) {
          await tx.routesAppReleaseChannel.create({
            data: {
              channel: DIRECT_CHANNEL,
              currentArtifactId: artifact.id,
              platform: ANDROID_PLATFORM,
            },
          });
          return toAndroidRelease(artifact);
        }

        const updated = await tx.routesAppReleaseChannel.updateMany({
          data: { currentArtifactId: artifact.id },
          where: {
            channel: DIRECT_CHANNEL,
            currentArtifactId: currentChannel.currentArtifactId,
            platform: ANDROID_PLATFORM,
          },
        });
        if (updated.count !== 1) {
          throw new RoutesAppReleaseConflictError('Release state changed while publishing; retry');
        }
        return toAndroidRelease(artifact);
      });
    } catch (error) {
      if (isPrismaUniqueError(error)) {
        throw new RoutesAppReleaseConflictError('Release state changed while publishing; retry');
      }
      throw error;
    }
  }
}

type RoutesAppReleaseTx = Prisma.TransactionClient;
type NormalizedPublishInput = ReturnType<typeof normalizePublishInput>;
type NormalizedArtifactInput = NormalizedPublishInput & {
  minimumSupportedVersionCode: number;
};

async function findOrCreateArtifact(
  tx: RoutesAppReleaseTx,
  input: NormalizedArtifactInput,
): Promise<{
  distributionChannel: string;
  downloadUrl: string;
  id: string;
  minimumSupportedVersionCode: number;
  packageId: string;
  platform: string;
  publishedAt: Date;
  sha256: string;
  versionCode: number;
  versionName: string;
}> {
  const existing = await tx.routesAppReleaseArtifact.findUnique({
    where: {
      platform_packageId_versionCode: {
        packageId: ROUTES_APP_ANDROID_PACKAGE_ID,
        platform: ANDROID_PLATFORM,
        versionCode: input.latestVersionCode,
      },
    },
  });
  if (existing !== null) {
    if (isSameRelease(existing, input)) return existing;
    throw new RoutesAppReleaseConflictError(
      'The published versionCode already exists with different release metadata',
    );
  }

  return tx.routesAppReleaseArtifact.create({
    data: {
      distributionChannel: DIRECT_CHANNEL,
      downloadUrl: input.downloadUrl,
      minimumSupportedVersionCode: input.minimumSupportedVersionCode,
      packageId: ROUTES_APP_ANDROID_PACKAGE_ID,
      platform: ANDROID_PLATFORM,
      publishedAt: new Date(),
      sha256: input.sha256,
      versionCode: input.latestVersionCode,
      versionName: input.latestVersionName,
    },
  });
}

function normalizePublishInput(input: PublishRoutesAppAndroidReleaseInput) {
  const downloadUrl = input.downloadUrl.trim();
  const latestVersionName = input.latestVersionName.trim();
  const sha256 = input.sha256.trim().toLowerCase();
  if (!Number.isInteger(input.latestVersionCode) || input.latestVersionCode <= 0) {
    throw new Error('latestVersionCode must be a positive integer');
  }
  if (latestVersionName === '') throw new Error('latestVersionName is required');
  if (
    input.minimumSupportedVersionCode !== undefined
    && (!Number.isInteger(input.minimumSupportedVersionCode) || input.minimumSupportedVersionCode <= 0)
  ) {
    throw new Error('minimumSupportedVersionCode must be a positive integer');
  }
  if (
    input.minimumSupportedVersionCode !== undefined
    && input.minimumSupportedVersionCode > input.latestVersionCode
  ) {
    throw new Error('minimumSupportedVersionCode cannot exceed latestVersionCode');
  }
  if (!SHA256_PATTERN.test(sha256)) throw new Error('sha256 must be a SHA-256 hex digest');
  if (!isHttpsUrl(downloadUrl)) throw new Error('downloadUrl must use HTTPS');
  return {
    downloadUrl,
    latestVersionCode: input.latestVersionCode,
    latestVersionName,
    ...(input.minimumSupportedVersionCode === undefined
      ? {}
      : { minimumSupportedVersionCode: input.minimumSupportedVersionCode }),
    sha256,
  };
}

function isSameRelease(
  record: {
    distributionChannel: string;
    downloadUrl: string;
    minimumSupportedVersionCode: number;
    packageId: string;
    platform: string;
    sha256: string;
    versionCode: number;
    versionName: string;
  },
  input: NormalizedPublishInput,
): boolean {
  const minimumSupportedVersionCode = input.minimumSupportedVersionCode
    ?? record.minimumSupportedVersionCode;
  return record.distributionChannel === DIRECT_CHANNEL
    && record.downloadUrl === input.downloadUrl
    && record.minimumSupportedVersionCode === minimumSupportedVersionCode
    && record.packageId === ROUTES_APP_ANDROID_PACKAGE_ID
    && record.platform === ANDROID_PLATFORM
    && record.sha256 === input.sha256
    && record.versionCode === input.latestVersionCode
    && record.versionName === input.latestVersionName;
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function isPrismaUniqueError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'P2002';
}

function toAndroidRelease(record: {
  distributionChannel: string;
  downloadUrl: string;
  minimumSupportedVersionCode: number;
  packageId: string;
  platform: string;
  publishedAt: Date;
  sha256: string;
  versionCode: number;
  versionName: string;
}): RoutesAppAndroidRelease {
  if (record.platform !== ANDROID_PLATFORM) throw new Error('Unsupported routes app platform');
  if (record.distributionChannel !== DIRECT_CHANNEL) throw new Error('Unsupported routes app channel');
  return {
    distributionChannel: DIRECT_CHANNEL,
    downloadUrl: record.downloadUrl,
    latestVersionCode: record.versionCode,
    latestVersionName: record.versionName,
    minimumSupportedVersionCode: record.minimumSupportedVersionCode,
    packageId: record.packageId,
    platform: ANDROID_PLATFORM,
    publishedAt: record.publishedAt,
    sha256: record.sha256,
  };
}
