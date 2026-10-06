import { PrismaClient } from '@prisma/client';

import { DsvDriverAppReleaseConflictError, PrismaDsvDriverAppReleaseRepository } from '../modules/dsv/dsv-driver-app-release.repository.js';
import { getDsvDriverPlayVerifierAccessToken } from '../modules/dsv/dsv-driver-play-credentials.js';
import { DsvDriverPlayVerificationError, publishVerifiedDsvDriverPlayRelease } from '../modules/dsv/dsv-driver-play-release.js';

const args = readArguments(process.argv.slice(2));
const prisma = new PrismaClient();

try {
  if (args.verifyPlayProduction && args.minimumSupportedVersionCode !== undefined) {
    throw new Error('Play synchronization must not set the minimum supported version');
  }
  const accessToken = args.verifyPlayProduction ? await getDsvDriverPlayVerifierAccessToken({
    credentialFile: process.env.DSV_PLAY_VERIFIER_CREDENTIALS ?? '',
    expectedEmail: process.env.DSV_PLAY_VERIFIER_EMAIL ?? '',
  }) : '';
  const repository = new PrismaDsvDriverAppReleaseRepository(prisma);
  const previous = await repository.getAndroidRelease();
  const release = args.verifyPlayProduction
    ? await publishVerifiedDsvDriverPlayRelease(args, { repository, accessToken })
    : await repository.publishAndroidRelease(args);
  process.stdout.write(`${JSON.stringify({ event: 'dsv_driver_release_published', verifiedPlayProduction: args.verifyPlayProduction,
    outcome: previous?.latestVersionCode === release.latestVersionCode ? 'unchanged' : 'published',
    previousVersionCode: previous?.latestVersionCode ?? null,
    ...release, publishedAt: release.publishedAt.toISOString() })}\n`);
} catch (error) {
  const code = error instanceof DsvDriverPlayVerificationError ? error.code
    : error instanceof DsvDriverAppReleaseConflictError ? 'RELEASE_CONFLICT' : 'RELEASE_PUBLISH_FAILED';
  process.stderr.write(`${JSON.stringify({ event: 'dsv_driver_release_publish_failed', code })}\n`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}

function readArguments(values: string[]) {
  const allowed = new Set(['version-code', 'version-name', 'apk-sha256', 'install-url', 'minimum-version-code', 'verify-play-production']);
  const flags = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (key === undefined || !key.startsWith('--') || value === undefined) {
      throw new Error('Release arguments must be provided as --name value pairs');
    }
    const name = key.slice(2);
    if (!allowed.has(name) || flags.has(name)) throw new Error('Unknown or duplicate release argument');
    flags.set(name, value);
  }
  const versionCode = Number(required(flags, 'version-code'));
  const minimumVersionCode = flags.get('minimum-version-code');
  const verifyPlayProduction = flags.get('verify-play-production');
  if (verifyPlayProduction !== undefined && verifyPlayProduction !== 'true') {
    throw new Error('--verify-play-production must be true when provided');
  }
  return {
    apkSha256: required(flags, 'apk-sha256'),
    installUrl: required(flags, 'install-url'),
    latestVersionCode: versionCode,
    latestVersionName: required(flags, 'version-name'),
    verifyPlayProduction: verifyPlayProduction === 'true',
    ...(minimumVersionCode === undefined
      ? {}
      : { minimumSupportedVersionCode: Number(minimumVersionCode) }),
  };
}

function required(flags: Map<string, string>, name: string): string {
  const value = flags.get(name)?.trim();
  if (value === undefined || value === '') throw new Error(`--${name} is required`);
  return value;
}
