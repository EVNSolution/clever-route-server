import { describe, expect, test, vi } from 'vitest';

import { DSV_DRIVER_PLAY_URL, publishVerifiedDsvDriverPlayRelease } from '../src/modules/dsv/dsv-driver-play-release.js';

const candidate = { apkSha256: 'b'.repeat(64), installUrl: DSV_DRIVER_PLAY_URL, latestVersionCode: 21, latestVersionName: '0.1.13' };
const published = (state = 'PUBLISHED', versionCode = 21) => ({ releases: [{
  track: 'production', activeArtifacts: [{ versionCode }], releaseLifecycleState: `RELEASE_LIFECYCLE_STATE_${state}`,
}] });
const completed = { track: 'production', releases: [{ versionCodes: ['21'], status: 'completed' }] };

function harness(input: { summary?: unknown; track?: unknown; finalSummary?: unknown; failure?: string } = {}) {
  const methods: string[] = [];
  const fetchImpl = vi.fn<typeof fetch>((url, options) => {
    const path = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    methods.push(`${options?.method} ${path}`);
    expect(path).toMatch(/^https:\/\/androidpublisher.googleapis.com\/androidpublisher\/v3\/applications\/com\.evnsolution\.clever\.driver\//u);
    if (input.failure === options?.method || input.failure === path.split('/').at(-1)) return Promise.resolve(new Response('', { status: 403 }));
    if (options?.method === 'DELETE') return Promise.resolve(new Response(null, { status: 204 }));
    if (options?.method === 'POST') return Promise.resolve(Response.json({ id: 'verification-edit' }));
    if (path.endsWith('/tracks/production')) return Promise.resolve(Response.json(input.track ?? completed));
    return Promise.resolve(Response.json(methods.length === 1 ? input.summary ?? published() : input.finalSummary ?? published()));
  });
  const repository = {
    getAndroidRelease: vi.fn().mockResolvedValue({ latestVersionCode: 13, minimumSupportedVersionCode: 10 }),
    publishAndroidRelease: vi.fn().mockResolvedValue({ ...candidate, minimumSupportedVersionCode: 10 }),
  };
  const run = () => publishVerifiedDsvDriverPlayRelease(candidate, { repository, accessToken: 'test-token', fetchImpl });
  return { fetchImpl, methods, repository, run };
}

describe('DSV Driver verified Play production release', () => {
  test('publishes only after live lifecycle and fresh completed track checks, without raising minimum support', async () => {
    const { methods, repository, run } = harness();
    await expect(run()).resolves.toMatchObject({ latestVersionCode: 21, minimumSupportedVersionCode: 10 });
    expect(repository.publishAndroidRelease).toHaveBeenCalledExactlyOnceWith(candidate);
    expect(methods.map((method) => method.split(' ')[0])).toEqual(['GET', 'POST', 'GET', 'GET', 'DELETE']);
    expect(methods.some((method) => /:commit|:validate|bundles|apks|tracks.*(?:PATCH|PUT)/u.test(method))).toBe(false);
  });

  test.each(['DRAFT', 'NOT_SENT_FOR_REVIEW', 'IN_REVIEW', 'APPROVED_NOT_PUBLISHED', 'NOT_APPROVED', 'UNSPECIFIED'])(
    'does not start an edit or change the registry for lifecycle %s', async (state) => {
      const { fetchImpl, repository, run } = harness({ summary: published(state) });
      await expect(run()).rejects.toMatchObject({ code: 'PLAY_RELEASE_NOT_PUBLISHED' });
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(repository.publishAndroidRelease).not.toHaveBeenCalled();
    },
  );

  test.each([
    { versionCodes: ['21'], status: 'draft' },
    { versionCodes: ['21'], status: 'inProgress', userFraction: 0.5 },
    { versionCodes: ['21'], status: 'halted', userFraction: 0.5 },
    { versionCodes: ['21'], status: 'completed', userFraction: 1 },
    { versionCodes: ['21'], status: 'completed', countryTargeting: { countries: ['KR'] } },
    { versionCodes: ['22'], status: 'completed' },
  ])('rejects partial, halted, mismatched or contradictory track metadata: %j', async (release) => {
    const { methods, repository, run } = harness({ track: { track: 'production', releases: [release] } });
    await expect(run()).rejects.toMatchObject({ code: 'PLAY_ROLLOUT_NOT_COMPLETE' });
    expect(methods.at(-1)).toContain('DELETE');
    expect(repository.publishAndroidRelease).not.toHaveBeenCalled();
  });

  test('does not accept a different track or a newer completed production release', async () => {
    for (const track of [
      { ...completed, track: 'internal' },
      { track: 'production', releases: [...completed.releases, { versionCodes: ['22'], status: 'completed' }] },
    ]) {
      const { repository, run } = harness({ track });
      await expect(run()).rejects.toThrow();
      expect(repository.publishAndroidRelease).not.toHaveBeenCalled();
    }
  });

  test('does not advance a draft 0.1.14 artifact merely because it exists beside the live release', async () => {
    const { repository, fetchImpl } = harness({ summary: { releases: [...published().releases, ...published('DRAFT', 22).releases] } });
    await expect(publishVerifiedDsvDriverPlayRelease({ ...candidate, latestVersionCode: 22, latestVersionName: '0.1.14' },
      { repository, fetchImpl, accessToken: 'test-token' })).rejects.toMatchObject({ code: 'PLAY_RELEASE_NOT_PUBLISHED' });
    expect(repository.publishAndroidRelease).not.toHaveBeenCalled();
  });

  test('requires publication to remain live until verification finishes', async () => {
    const { repository, run } = harness({ finalSummary: published('IN_REVIEW') });
    await expect(run()).rejects.toMatchObject({ code: 'PLAY_RELEASE_NOT_PUBLISHED' });
    expect(repository.publishAndroidRelease).not.toHaveBeenCalled();
  });

  test.each(['GET', 'POST', 'DELETE'])('fails closed on Play %s permission or transport errors', async (failure) => {
    const { repository, run } = harness({ failure });
    await expect(run()).rejects.toMatchObject({ code: 'PLAY_API_HTTP_403' });
    expect(repository.publishAndroidRelease).not.toHaveBeenCalled();
  });

  test('rejects absent credentials, invalid metadata and uninitialized minimum support', async () => {
    const { repository, fetchImpl } = harness();
    await expect(publishVerifiedDsvDriverPlayRelease(candidate, { repository, fetchImpl, accessToken: '' }))
      .rejects.toMatchObject({ code: 'PLAY_CREDENTIAL_REQUIRED' });
    await expect(publishVerifiedDsvDriverPlayRelease({ ...candidate, installUrl: 'https://example.test/wrong-app' },
      { repository, fetchImpl, accessToken: 'test-token' })).rejects.toMatchObject({ code: 'PLAY_RELEASE_METADATA_INVALID' });
    repository.getAndroidRelease.mockResolvedValueOnce(null);
    await expect(publishVerifiedDsvDriverPlayRelease(candidate, { repository, fetchImpl, accessToken: 'test-token' }))
      .rejects.toMatchObject({ code: 'PLAY_CURRENT_RELEASE_REQUIRED' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(repository.publishAndroidRelease).not.toHaveBeenCalled();
  });

  test('sanitizes transport errors instead of exposing bearer tokens or provider payloads', async () => {
    const { repository, fetchImpl } = harness();
    fetchImpl.mockRejectedValueOnce(new Error('secret bearer test-token upstream body'));
    await expect(publishVerifiedDsvDriverPlayRelease(candidate, { repository, fetchImpl, accessToken: 'test-token' }))
      .rejects.toMatchObject({ message: 'PLAY_API_REQUEST_FAILED' });
    expect(repository.publishAndroidRelease).not.toHaveBeenCalled();
  });
});
