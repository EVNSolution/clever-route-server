import { createHmac } from 'node:crypto';
import { describe, expect, test } from 'vitest';

import { verifyShopifySessionToken } from '../src/modules/shopify/session-token-verifier.js';

const clientId = 'client-id-123';
const clientSecret = 'shared-secret-456';
const now = new Date('2026-05-07T05:00:00.000Z');

function signTestSessionToken(
  overrides: Record<string, unknown> = {},
  headerOverrides: Record<string, unknown> = {}
): string {
  const header = { alg: 'HS256', typ: 'JWT', ...headerOverrides };
  const payload = {
    aud: clientId,
    dest: 'https://example.myshopify.com',
    exp: Math.floor(now.getTime() / 1000) + 60,
    iat: Math.floor(now.getTime() / 1000),
    iss: 'https://example.myshopify.com/admin',
    jti: 'f8912129-1af6-4cad-9ca3-76b0f7621087',
    nbf: Math.floor(now.getTime() / 1000) - 5,
    sid: 'aaea182f2732d44c23057c0fea584021a4485b2bd25d3eb7fd349313ad24c685',
    sub: '42',
    ...overrides
  };
  const encodedHeader = encodeBase64Url(JSON.stringify(header));
  const encodedPayload = encodeBase64Url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = createHmac('sha256', clientSecret)
    .update(signingInput)
    .digest('base64url');

  return `${signingInput}.${signature}`;
}

describe('verifyShopifySessionToken', () => {
  test('accepts a valid Shopify session token and returns shop context', () => {
    const verified = verifyShopifySessionToken(signTestSessionToken(), {
      clientId,
      clientSecret,
      expectedShopDomain: 'example.myshopify.com',
      now
    });

    expect(verified).toEqual({
      shopDomain: 'example.myshopify.com',
      subject: '42'
    });
  });

  test('rejects a token with an invalid signature', () => {
    const token = `${signTestSessionToken().slice(0, -1)}x`;

    expect(() =>
      verifyShopifySessionToken(token, { clientId, clientSecret, now })
    ).toThrow('Invalid Shopify session token signature');
  });

  test('rejects tokens that do not declare the Shopify HS256 JWT algorithm', () => {
    const token = signTestSessionToken({}, { alg: 'none', typ: 'JWT' });

    expect(() =>
      verifyShopifySessionToken(token, { clientId, clientSecret, now })
    ).toThrow('Shopify session token algorithm mismatch');
  });

  test('rejects expired tokens', () => {
    const token = signTestSessionToken({ exp: Math.floor(now.getTime() / 1000) - 1 });

    expect(() =>
      verifyShopifySessionToken(token, { clientId, clientSecret, now })
    ).toThrow('Shopify session token has expired');
  });

  test('rejects tokens issued for another app client id', () => {
    const token = signTestSessionToken({ aud: 'other-client-id' });

    expect(() =>
      verifyShopifySessionToken(token, { clientId, clientSecret, now })
    ).toThrow('Shopify session token audience mismatch');
  });

  test('rejects expected shop mismatches', () => {
    const token = signTestSessionToken();

    expect(() =>
      verifyShopifySessionToken(token, {
        clientId,
        clientSecret,
        expectedShopDomain: 'other.myshopify.com',
        now
      })
    ).toThrow('Shopify session token shop mismatch');
  });
});

function encodeBase64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}
