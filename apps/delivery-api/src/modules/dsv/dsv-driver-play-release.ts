import { DSV_DRIVER_ANDROID_PACKAGE_ID, type DsvDriverAppReleaseRepository, type PublishDsvDriverAndroidReleaseInput } from './dsv-driver-app-release.repository.js';

export const DSV_DRIVER_PLAY_URL = `https://play.google.com/store/apps/details?id=${DSV_DRIVER_ANDROID_PACKAGE_ID}`;
const applicationUrl = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${DSV_DRIVER_ANDROID_PACKAGE_ID}`;

export class DsvDriverPlayVerificationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'DsvDriverPlayVerificationError';
  }
}

// The trusted producer attests the exact APK package/version/name/digest. This
// verifies Play publication and rollout; it does not authenticate artifact bytes.
export async function publishVerifiedDsvDriverPlayRelease(
  input: Omit<PublishDsvDriverAndroidReleaseInput, 'minimumSupportedVersionCode'>,
  dependencies: { repository: DsvDriverAppReleaseRepository; accessToken: string; fetchImpl?: typeof fetch },
) {
  if (input.installUrl !== DSV_DRIVER_PLAY_URL || !/^[a-f0-9]{64}$/u.test(input.apkSha256)
    || input.latestVersionName.trim() === '') {
    throw new DsvDriverPlayVerificationError('PLAY_RELEASE_METADATA_INVALID');
  }
  if (await dependencies.repository.getAndroidRelease() === null) {
    throw new DsvDriverPlayVerificationError('PLAY_CURRENT_RELEASE_REQUIRED');
  }
  await verifyDsvDriverPlayProductionRelease({
    accessToken: dependencies.accessToken,
    versionCode: input.latestVersionCode,
    ...(dependencies.fetchImpl === undefined ? {} : { fetchImpl: dependencies.fetchImpl }),
  });
  return dependencies.repository.publishAndroidRelease({
    apkSha256: input.apkSha256,
    installUrl: DSV_DRIVER_PLAY_URL,
    latestVersionCode: input.latestVersionCode,
    latestVersionName: input.latestVersionName,
  });
}

// Run with a dedicated verifier identity: opening an edit invalidates that user's
// other open edit. This flow never changes a track, uploads, or commits an edit.
export async function verifyDsvDriverPlayProductionRelease(input: {
  accessToken: string;
  versionCode: number;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  if (!Number.isSafeInteger(input.versionCode) || input.versionCode <= 0) {
    throw new DsvDriverPlayVerificationError('PLAY_VERSION_CODE_INVALID');
  }
  if (input.accessToken.trim() === '') throw new DsvDriverPlayVerificationError('PLAY_CREDENTIAL_REQUIRED');
  const fetchImpl = input.fetchImpl ?? fetch;
  const request = async (path: string, method = 'GET'): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetchImpl(`${applicationUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${input.accessToken.trim()}`, 'content-type': 'application/json' },
        ...(method === 'POST' ? { body: '{}' } : {}),
        signal: AbortSignal.timeout(15_000),
        redirect: 'error',
      });
    } catch {
      throw new DsvDriverPlayVerificationError('PLAY_API_REQUEST_FAILED');
    }
    if (!response.ok) throw new DsvDriverPlayVerificationError(`PLAY_API_HTTP_${response.status}`);
    if (method === 'DELETE') return null;
    try { return await response.json(); } catch {
      throw new DsvDriverPlayVerificationError('PLAY_API_RESPONSE_INVALID');
    }
  };

  const assertPublished = (value: unknown) => {
    const releases = readRecords(value, 'releases');
    const matching = releases.filter((release) => release.track === 'production'
      && readRecords(release, 'activeArtifacts').some((artifact) => artifact.versionCode === input.versionCode));
    if (matching.length !== 1 || matching[0]?.releaseLifecycleState !== 'RELEASE_LIFECYCLE_STATE_PUBLISHED') {
      throw new DsvDriverPlayVerificationError('PLAY_RELEASE_NOT_PUBLISHED');
    }
  };

  // Lifecycle state separates review/managed-publishing queues from live users.
  assertPublished(await request('/tracks/production/releases'));
  const edit = await request('/edits', 'POST');
  if (!isRecord(edit) || typeof edit.id !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(edit.id)) {
    throw new DsvDriverPlayVerificationError('PLAY_EDIT_RESPONSE_INVALID');
  }
  const editPath = `/edits/${edit.id}`;
  try {
    const track = await request(`${editPath}/tracks/production`);
    const releases = readRecords(track, 'releases');
    const matching = releases.filter((release) => Array.isArray(release.versionCodes)
      && release.versionCodes.includes(String(input.versionCode)));
    if (!isRecord(track) || track.track !== 'production' || matching.length !== 1
      || matching[0]?.status !== 'completed' || matching[0].userFraction !== undefined
      || matching[0].countryTargeting !== undefined) {
      throw new DsvDriverPlayVerificationError('PLAY_ROLLOUT_NOT_COMPLETE');
    }
    if (releases.some((release) => release.status === 'completed' && Array.isArray(release.versionCodes)
      && release.versionCodes.some((code: unknown) => typeof code === 'string' && Number(code) > input.versionCode))) {
      throw new DsvDriverPlayVerificationError('PLAY_NEWER_COMPLETED_RELEASE_EXISTS');
    }
    // Fail closed if publication changes during the fresh-edit read.
    assertPublished(await request('/tracks/production/releases'));
  } finally {
    await request(editPath, 'DELETE');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readRecords(value: unknown, key: string): Record<string, unknown>[] {
  if (!isRecord(value) || !Array.isArray(value[key]) || !value[key].every(isRecord)) {
    throw new DsvDriverPlayVerificationError('PLAY_API_RESPONSE_INVALID');
  }
  return value[key];
}
