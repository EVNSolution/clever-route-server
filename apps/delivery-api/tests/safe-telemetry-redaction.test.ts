import { describe, expect, test } from 'vitest';

import { redactTelemetry, redactTelemetryMessage } from '../src/modules/security/safe-telemetry-redaction.js';

describe('safe telemetry redaction', () => {
  test('recursively strips tokens, PII, URLs, raw payloads, and GraphQL variables', () => {
    const redacted = redactTelemetry({
      authorization: 'Bearer shpat_secret',
      correlationId: 'corr-1',
      arbitraryScalar: 'should-not-leak',
      nested: {
        customer: {
          email: 'customer@example.com',
          name: 'Noah Yoon',
          phone: '+1 416 555 1212',
          shippingAddress: '300 City Centre Dr'
        },
        graphqlVariables: { id: 'gid://shopify/Order/123' },
        url: 'https://example.myshopify.com/admin?id_token=secret#frag'
      },
      rawPayload: { note: 'leave by door' },
      surpriseObject: { safeLooking: 'but-not-allowlisted' },
      status: 'RUNNING'
    });
    const serialized = JSON.stringify(redacted);

    expect(serialized).toContain('corr-1');
    expect(serialized).toContain('RUNNING');
    expect(serialized).not.toContain('shpat_secret');
    expect(serialized).not.toContain('customer@example.com');
    expect(serialized).not.toContain('+1 416 555 1212');
    expect(serialized).not.toContain('300 City Centre Dr');
    expect(serialized).not.toContain('leave by door');
    expect(serialized).not.toContain('id_token');
    expect(serialized).not.toContain('gid://shopify/Order/123');
    expect(serialized).not.toContain('should-not-leak');
    expect(serialized).not.toContain('but-not-allowlisted');
    expect(serialized).not.toContain('safeLooking');
  });

  test('redacts sensitive error messages before persistence', () => {
    expect(redactTelemetryMessage(new Error('token=secret customer@example.com phone +1 416 555 1212'))).toBe(
      '[redacted-secret] [redacted-email] phone [redacted-phone]'
    );
  });
});
