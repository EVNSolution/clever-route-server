import { PrismaClient } from '@prisma/client';

import { PrismaRoutesAppReleaseRepository } from '../modules/routes-app/routes-app-release.repository.js';

const args = readArguments(process.argv.slice(2));
const prisma = new PrismaClient();

try {
  const repository = new PrismaRoutesAppReleaseRepository(prisma);
  const release = await repository.publishAndroidRelease(args);
  process.stdout.write(`${JSON.stringify({ ...release, publishedAt: release.publishedAt.toISOString() })}\n`);
} finally {
  await prisma.$disconnect();
}

function readArguments(values: string[]) {
  const flags = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (key === undefined || !key.startsWith('--') || value === undefined) {
      throw new Error('Release arguments must be provided as --name value pairs');
    }
    flags.set(key.slice(2), value);
  }
  const versionCode = Number(required(flags, 'version-code'));
  const minimumVersionCode = flags.get('minimum-version-code');
  return {
    downloadUrl: required(flags, 'download-url'),
    latestVersionCode: versionCode,
    latestVersionName: required(flags, 'version-name'),
    sha256: required(flags, 'apk-sha256'),
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
