import { describe, expect, test } from 'vitest';

import { resolveCustomerEmailTimezone } from '../src/modules/customer-email/customer-email.service.js';
import { centerTimezoneFromCoordinates } from '../src/modules/route-ops/center-timezone.js';

describe('centerTimezoneFromCoordinates', () => {
  test('maps center coordinates to the IANA timezone', () => {
    expect(centerTimezoneFromCoordinates(43.65, -79.38)).toBe('America/Toronto');
    expect(centerTimezoneFromCoordinates(37.56, 126.97)).toBe('Asia/Seoul');
  });

  test('returns null without usable coordinates', () => {
    expect(centerTimezoneFromCoordinates(null, 126.97)).toBeNull();
    expect(centerTimezoneFromCoordinates(95, 200)).toBeNull();
  });
});

describe('resolveCustomerEmailTimezone', () => {
  test('prefers the tenant center timezone over route and connection values', () => {
    expect(resolveCustomerEmailTimezone({
      constraints: { timezone: 'UTC' },
      shop: { commerceConnections: [{ timezone: 'America/Los_Angeles' }], defaultDepotTimezone: 'Asia/Seoul' }
    })).toBe('Asia/Seoul');
  });

  test('falls back to the route value when the center has no timezone', () => {
    expect(resolveCustomerEmailTimezone({
      constraints: { timezone: 'America/Toronto' },
      shop: { commerceConnections: [], defaultDepotTimezone: null }
    })).toBe('America/Toronto');
  });
});
