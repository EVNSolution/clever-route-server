import { generateKeyPairSync, verify } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, test, vi } from 'vitest';

import { getDsvDriverPlayVerifierAccessToken } from '../src/modules/dsv/dsv-driver-play-credentials.js';

const directory = mkdtempSync(join(tmpdir(), 'dsv-play-credentials-test-'));
const expectedEmail = 'dsv-verifier@example-project.iam.gserviceaccount.com';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const credentials = { type: 'service_account', client_email: expectedEmail,
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
const credentialFile = join(directory, 'test-credential.json');
afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe('DSV dedicated Play verifier identity', () => {
  test('CLI refuses a generic token before touching a database or Play edit', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/scripts/publish-dsv-driver-app-release.ts',
      '--verify-play-production', 'true', '--version-code', '21', '--version-name', '0.1.13',
      '--apk-sha256', 'b'.repeat(64), '--install-url', 'https://play.google.com/store/apps/details?id=com.evnsolution.clever.driver'], {
      encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, DATABASE_URL: 'postgresql://invalid:invalid@127.0.0.1:1/invalid',
        DSV_PLAY_ACCESS_TOKEN: 'generic-token-must-not-be-used', DSV_PLAY_VERIFIER_CREDENTIALS: '', DSV_PLAY_VERIFIER_EMAIL: '' },
    });
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe(JSON.stringify({ event: 'dsv_driver_release_publish_failed', code: 'PLAY_VERIFIER_IDENTITY_REQUIRED' }));
    expect(result.stdout).toBe('');
  });

  test('signs the exact service-account identity with only the Publisher scope and no user delegation', async () => {
    writeFileSync(credentialFile, JSON.stringify(credentials));
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ access_token: 'test-access-token', token_type: 'Bearer', expires_in: 3600 }));
    await expect(getDsvDriverPlayVerifierAccessToken({ credentialFile, expectedEmail, fetchImpl })).resolves.toBe('test-access-token');
    const [url, options] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://oauth2.googleapis.com/token');
    expect(options).toMatchObject({ method: 'POST', redirect: 'error' });
    const body = options!.body as URLSearchParams;
    expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const [header, payload, signature] = body.get('assertion')!.split('.');
    expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString()) as Record<string, unknown>;
    expect(claims).toEqual({ iss: expectedEmail, scope: 'https://www.googleapis.com/auth/androidpublisher',
      aud: url, iat: expect.any(Number) as unknown, exp: expect.any(Number) as unknown });
    expect(Number(claims.exp) - Number(claims.iat)).toBe(300);
    expect(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature!, 'base64url'))).toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  test('rejects missing credentials, user credentials, other service accounts and invalid keys before any network call', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    for (const value of [
      { ...credentials, type: 'authorized_user' },
      { ...credentials, client_email: 'another@example-project.iam.gserviceaccount.com' },
      { ...credentials, private_key: 'invalid-private-key' },
      {}, null,
    ]) {
      writeFileSync(credentialFile, JSON.stringify(value));
      await expect(getDsvDriverPlayVerifierAccessToken({ credentialFile, expectedEmail, fetchImpl })).rejects.toThrow();
    }
    await expect(getDsvDriverPlayVerifierAccessToken({ credentialFile: '', expectedEmail, fetchImpl }))
      .rejects.toMatchObject({ code: 'PLAY_VERIFIER_IDENTITY_REQUIRED' });
    await expect(getDsvDriverPlayVerifierAccessToken({ credentialFile, expectedEmail: 'human@example.com', fetchImpl }))
      .rejects.toMatchObject({ code: 'PLAY_VERIFIER_IDENTITY_REQUIRED' });
    await expect(getDsvDriverPlayVerifierAccessToken({ credentialFile: join(directory, 'missing'), expectedEmail, fetchImpl }))
      .rejects.toMatchObject({ code: 'PLAY_VERIFIER_CREDENTIAL_INVALID' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('sanitizes OAuth errors and rejects invalid tokens', async () => {
    writeFileSync(credentialFile, JSON.stringify(credentials));
    for (const response of [
      new Response('private provider details', { status: 403 }),
      Response.json({ access_token: 'test-token', token_type: 'Bearer', expires_in: 1 }),
      Response.json({ access_token: 'test-token', token_type: 'Other', expires_in: 3600 }),
      Response.json({ token_type: 'Bearer', expires_in: 3600 }),
    ]) {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);
      await expect(getDsvDriverPlayVerifierAccessToken({ credentialFile, expectedEmail, fetchImpl }))
        .rejects.toMatchObject({ message: expect.stringMatching(/^PLAY_VERIFIER_TOKEN_(FAILED|INVALID)$/u) as unknown });
    }
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('secret assertion upstream payload'));
    await expect(getDsvDriverPlayVerifierAccessToken({ credentialFile, expectedEmail, fetchImpl }))
      .rejects.toMatchObject({ message: 'PLAY_VERIFIER_TOKEN_FAILED' });
  });
});
