import { describe, expect, test } from 'vitest';

import {
  classifyShopifySessionTokenFailure,
  logRejectedAdminSessionToken
} from '../src/routes/admin-session-auth.js';

describe('admin session auth diagnostics', () => {
  test.each([
    ['Shopify session token audience mismatch', 'audience_mismatch'],
    ['Invalid Shopify session token signature', 'signature_mismatch'],
    ['Shopify session token has expired', 'expired'],
    ['Shopify session token is not active yet', 'not_active_yet'],
    ['Shopify session token issuer mismatch', 'issuer_mismatch'],
    ['Shopify session token shop mismatch', 'shop_mismatch'],
    ['Shopify session token must be a JWT', 'malformed_jwt'],
    ['unexpected verifier failure', 'verification_failed']
  ])('classifies %s as %s', (message, reason) => {
    expect(classifyShopifySessionTokenFailure(new Error(message))).toBe(reason);
  });

  test('logs a sanitized reason without token material', () => {
    const logEntries: Array<{ message: string; payload: unknown }> = [];
    const fakeLogger = {
      warn: (payload: unknown, message: string) => logEntries.push({ message, payload })
    };

    logRejectedAdminSessionToken({
      error: new Error('Shopify session token audience mismatch'),
      log: fakeLogger as never,
      surface: 'admin_drivers'
    });

    expect(logEntries).toEqual([
      {
        message: 'shopify admin session token rejected',
        payload: {
          event: 'shopify_admin_session_token_rejected',
          reason: 'audience_mismatch',
          surface: 'admin_drivers'
        }
      }
    ]);
    expect(JSON.stringify(logEntries)).not.toContain('session-token');
  });
});
