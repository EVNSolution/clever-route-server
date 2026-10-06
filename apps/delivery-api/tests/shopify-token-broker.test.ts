import { createHash, createHmac } from 'node:crypto';
import { describe, expect, test } from 'vitest';

import { ShopifyTokenBrokerVerifier } from '../src/modules/shopify/token-broker-auth.js';

const now = new Date('2026-05-07T01:00:00.000Z');
const clientSecret = 'main-client-secret';
const devClientSecret = 'dev-client-secret';
const credentials = [
  { appId: 'clever', clientId: 'main-client-id', clientSecret },
  { appId: 'clever-route-dev', clientId: 'dev-client-id', clientSecret: devClientSecret }
];

describe('ShopifyTokenBrokerVerifier', () => {
  test('verifies the exact canonical exchange body and returns app/shop authority', () => {
    const verifier = new ShopifyTokenBrokerVerifier({ appCredentials: credentials, now: () => now });
    const body = exchangeBody();
    const timestamp = nowSeconds();
    expect(verifier.verify({ body, signature: sign(body, timestamp, clientSecret), timestamp })).toEqual({
      appId: 'clever', clientId: 'main-client-id', operation: 'exchange',
      sessionToken: 'session-token', shopDomain: 'example.myshopify.com'
    });
  });

  test('verifies refresh without accepting or inventing a session token', () => {
    const verifier = new ShopifyTokenBrokerVerifier({ appCredentials: credentials, now: () => now });
    const body = refreshBody();
    const timestamp = nowSeconds();
    expect(verifier.verify({ body, signature: sign(body, timestamp, clientSecret), timestamp })).toEqual({
      appId: 'clever', clientId: 'main-client-id', operation: 'refresh', shopDomain: 'example.myshopify.com'
    });
  });

  test.each([
    ['missing signature', { signature: undefined }],
    ['invalid signature', { signature: '00'.repeat(32) }],
    ['stale timestamp', { timestamp: String(Number(nowSeconds()) - 301) }],
    ['future timestamp', { timestamp: String(Number(nowSeconds()) + 301) }]
  ])('rejects %s', (_label, override) => {
    const verifier = new ShopifyTokenBrokerVerifier({ appCredentials: credentials, now: () => now });
    const body = exchangeBody();
    const timestamp = 'timestamp' in override ? override.timestamp : nowSeconds();
    const signature = 'signature' in override
      ? override.signature
      : sign(body, timestamp, clientSecret);
    expect(() => verifier.verify({
      body,
      signature,
      timestamp
    })).toThrow();
  });

  test('rejects body tampering, cross-app signatures, and unknown client ids', () => {
    const verifier = new ShopifyTokenBrokerVerifier({ appCredentials: credentials, now: () => now });
    const timestamp = nowSeconds();
    const mainBody = exchangeBody();
    expect(() => verifier.verify({
      body: { ...mainBody, shopDomain: 'other.myshopify.com' },
      signature: sign(mainBody, timestamp, clientSecret), timestamp
    })).toThrow();

    const devBody = { ...mainBody, clientId: 'dev-client-id' };
    expect(() => verifier.verify({
      body: devBody, signature: sign(devBody, timestamp, clientSecret), timestamp
    })).toThrow();

    const unknownBody = { ...mainBody, clientId: 'unknown-client-id' };
    expect(() => verifier.verify({
      body: unknownBody, signature: sign(unknownBody, timestamp, clientSecret), timestamp
    })).toThrow();
  });

  test.each([
    { ...exchangeBody(), operation: 'password' },
    { ...exchangeBody(), extra: true },
    { ...exchangeBody(), sessionToken: '' },
    { ...refreshBody(), sessionToken: 'not-allowed' },
    { ...exchangeBody(), shopDomain: 'https://example.com' }
  ])('rejects malformed or unsupported canonical body %#', (body) => {
    const verifier = new ShopifyTokenBrokerVerifier({ appCredentials: credentials, now: () => now });
    const timestamp = nowSeconds();
    expect(() => verifier.verify({
      body, signature: sign(body, timestamp, clientSecret), timestamp
    })).toThrow();
  });
});

function exchangeBody() {
  return {
    clientId: 'main-client-id', shopDomain: 'example.myshopify.com',
    operation: 'exchange' as const, sessionToken: 'session-token'
  };
}

function refreshBody() {
  return { clientId: 'main-client-id', shopDomain: 'example.myshopify.com', operation: 'refresh' as const };
}

function nowSeconds(): string {
  return String(Math.floor(now.getTime() / 1000));
}

function sign(body: unknown, timestamp: string, secret: string): string {
  const bodyHash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
  const canonical = ['clever-shopify-token-authority-v1', 'POST', '/shopify/auth/offline-token', timestamp, bodyHash].join('\n');
  return createHmac('sha256', secret).update(canonical).digest('hex');
}
