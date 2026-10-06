import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import type { ShopifyAppCredential } from './shopify-app-credentials.js';

export const SHOPIFY_TOKEN_BROKER_PATH = '/shopify/auth/offline-token';
export const SHOPIFY_TOKEN_BROKER_REFRESH_MARKER = 'clever-route-managed-v1';

type TokenBrokerBody = {
  clientId: string;
  shopDomain: string;
  operation: 'exchange' | 'refresh';
  sessionToken?: string;
};

export type VerifiedTokenBrokerRequest = TokenBrokerBody & { appId: string };

/** Server-to-server authentication. A browser-held Shopify ID token is insufficient. */
export class ShopifyTokenBrokerVerifier {
  constructor(private readonly options: {
    appCredentials: ShopifyAppCredential[];
    now?: () => Date;
  }) {}

  verify(input: {
    body: unknown;
    timestamp?: string | undefined;
    signature?: string | undefined;
  }): VerifiedTokenBrokerRequest {
    const body = parseBody(input.body);
    const credential = this.options.appCredentials.find((item) => item.clientId === body.clientId);
    const nowSeconds = Math.floor((this.options.now?.() ?? new Date()).getTime() / 1_000);
    if (
      credential === undefined
      || !/^\d{10}$/u.test(input.timestamp ?? '')
      || Math.abs(Number(input.timestamp) - nowSeconds) > 60
      || !/^[a-f0-9]{64}$/u.test(input.signature ?? '')
    ) throw new Error('Invalid token authority request');

    // Canonical fields bind the app, shop, grant and subject token. The short
    // replay window is safe only because the authority reuses healthy tokens.
    const bodyHash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const signingInput = [
      'clever-shopify-token-authority-v1', 'POST', SHOPIFY_TOKEN_BROKER_PATH,
      input.timestamp, bodyHash
    ].join('\n');
    const expected = createHmac('sha256', credential.clientSecret).update(signingInput).digest();
    if (!timingSafeEqual(expected, Buffer.from(input.signature ?? '', 'hex'))) {
      throw new Error('Invalid token authority request');
    }
    return { appId: credential.appId, ...body };
  }
}

function parseBody(value: unknown): TokenBrokerBody {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid token authority request');
  }
  const body = value as Record<string, unknown>;
  if (
    Object.keys(body).some((key) => !['clientId', 'shopDomain', 'operation', 'sessionToken'].includes(key))
    || typeof body.clientId !== 'string' || body.clientId.length === 0 || body.clientId.length > 128
    || typeof body.shopDomain !== 'string' || body.shopDomain.length > 253
    || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/u.test(body.shopDomain)
    || !['exchange', 'refresh'].includes(String(body.operation))
    || (body.operation === 'exchange' && (
      typeof body.sessionToken !== 'string' || body.sessionToken.length === 0 || body.sessionToken.length > 8_192
    ))
    || (body.operation === 'refresh' && body.sessionToken !== undefined)
  ) throw new Error('Invalid token authority request');
  return {
    clientId: body.clientId,
    shopDomain: body.shopDomain,
    operation: body.operation as 'exchange' | 'refresh',
    ...(body.operation === 'exchange' ? { sessionToken: body.sessionToken as string } : {})
  };
}
