import { createHmac } from 'node:crypto';
import { describe, expect, test } from 'vitest';

import { verifyShopifyWebhookHmac } from '../src/modules/shopify/webhook-hmac.js';

const clientSecret = 'shared-secret-456';
const rawBody = JSON.stringify({ id: 123, name: '#1001' });

describe('verifyShopifyWebhookHmac', () => {
  test('accepts the base64 HMAC Shopify computes from the raw request body', () => {
    const hmac = createHmac('sha256', clientSecret).update(rawBody).digest('base64');

    expect(verifyShopifyWebhookHmac({ clientSecret, hmac, rawBody })).toBe(true);
  });

  test('rejects HMAC values computed from a different body', () => {
    const hmac = createHmac('sha256', clientSecret).update('{}').digest('base64');

    expect(verifyShopifyWebhookHmac({ clientSecret, hmac, rawBody })).toBe(false);
  });

  test('rejects malformed HMAC headers without throwing', () => {
    expect(verifyShopifyWebhookHmac({ clientSecret, hmac: 'not-base64', rawBody })).toBe(false);
  });
});
