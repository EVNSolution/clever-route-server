import { sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { DsvDriverPlayVerificationError } from './dsv-driver-play-release.js';

const tokenUrl = 'https://oauth2.googleapis.com/token';
const scope = 'https://www.googleapis.com/auth/androidpublisher';

// No ADC/user-token fallback or user impersonation: the configured principal owns
// only verification edits, never the producer's upload/Console edit.
export async function getDsvDriverPlayVerifierAccessToken(input: {
  credentialFile: string;
  expectedEmail: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  if (input.credentialFile.trim() === ''
    || !/^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/u.test(input.expectedEmail)) {
    throw new DsvDriverPlayVerificationError('PLAY_VERIFIER_IDENTITY_REQUIRED');
  }
  let credentials: unknown;
  try { credentials = JSON.parse(await readFile(input.credentialFile, 'utf8')); } catch {
    throw new DsvDriverPlayVerificationError('PLAY_VERIFIER_CREDENTIAL_INVALID');
  }
  if (typeof credentials !== 'object' || credentials === null
    || !('type' in credentials) || credentials.type !== 'service_account'
    || !('client_email' in credentials) || credentials.client_email !== input.expectedEmail
    || !('private_key' in credentials) || typeof credentials.private_key !== 'string') {
    throw new DsvDriverPlayVerificationError('PLAY_VERIFIER_IDENTITY_MISMATCH');
  }
  const issuedAt = Math.floor(Date.now() / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
    iss: input.expectedEmail, scope, aud: tokenUrl, iat: issuedAt, exp: issuedAt + 300,
  })}`;
  let assertion: string;
  try {
    assertion = `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), credentials.private_key).toString('base64url')}`;
  } catch {
    throw new DsvDriverPlayVerificationError('PLAY_VERIFIER_CREDENTIAL_INVALID');
  }
  let response: Response;
  let token: unknown;
  try {
    response = await (input.fetchImpl ?? fetch)(tokenUrl, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    });
    if (!response.ok) throw new Error('Token request rejected');
    token = await response.json();
  } catch {
    throw new DsvDriverPlayVerificationError('PLAY_VERIFIER_TOKEN_FAILED');
  }
  if (typeof token !== 'object' || token === null
    || !('access_token' in token) || typeof token.access_token !== 'string' || token.access_token.trim() === ''
    || !('token_type' in token) || token.token_type !== 'Bearer'
    || !('expires_in' in token) || typeof token.expires_in !== 'number' || token.expires_in <= 60) {
    throw new DsvDriverPlayVerificationError('PLAY_VERIFIER_TOKEN_INVALID');
  }
  return token.access_token;
}
