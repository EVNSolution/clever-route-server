import { describe, expect, test } from 'vitest';

import { loadShopifyAppCredentials } from '../src/modules/shopify/shopify-app-credentials.js';

describe('loadShopifyAppCredentials', () => {
  test('loads default, dev, and explicit Shopify app credentials from env', () => {
    expect(
      loadShopifyAppCredentials({
        SHOPIFY_API_KEY: ' main-client ',
        SHOPIFY_API_SECRET: ' main-secret ',
        SHOPIFY_DEV_API_KEY: 'dev-client',
        SHOPIFY_DEV_API_SECRET: 'dev-secret',
        SHOPIFY_APP_CREDENTIALS: 'partner-app:partner-client:partner-secret'
      })
    ).toEqual([
      { appId: 'clever', clientId: 'main-client', clientSecret: 'main-secret' },
      { appId: 'clever-route-dev', clientId: 'dev-client', clientSecret: 'dev-secret' },
      { appId: 'partner-app', clientId: 'partner-client', clientSecret: 'partner-secret' }
    ]);
  });

  test('requires duplicate app credentials to be identical', () => {
    expect(() =>
      loadShopifyAppCredentials({
        SHOPIFY_API_KEY: 'main-client',
        SHOPIFY_API_SECRET: 'main-secret',
        SHOPIFY_APP_CREDENTIALS: 'clever:other-client:other-secret'
      })
    ).toThrow('Duplicate Shopify app credential for clever');
  });

  test('rejects invalid app credential entries', () => {
    expect(() =>
      loadShopifyAppCredentials({
        SHOPIFY_APP_CREDENTIALS: 'bad entry:client:secret'
      })
    ).toThrow('Shopify app id is invalid');
  });
});
