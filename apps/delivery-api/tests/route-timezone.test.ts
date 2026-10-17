import { describe, expect, test } from 'vitest';

import { resolveCustomerEmailTimezone } from '../src/modules/customer-email/customer-email.service.js';
import { centerTimezoneFromCoordinates, resolveRouteTimezone } from '../src/modules/route-ops/route-timezone.js';

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

describe('resolveRouteTimezone', () => {
  test('the center timezone wins over every route and connection value', () => {
    expect(resolveRouteTimezone({
      centerTimezone: 'America/Toronto',
      commerceConnections: [{ timezone: 'Asia/Seoul' }],
      constraints: { timezone: 'UTC', routeScope: { timezone: 'Asia/Seoul' }, scheduledStartTimeZone: 'Asia/Seoul' }
    })).toBe('America/Toronto');
  });

  test('uses route values in a fixed order when the center has none', () => {
    expect(resolveRouteTimezone({ constraints: { routeScope: { timezone: 'Asia/Seoul' }, scheduledStartTimeZone: 'America/Toronto' } })).toBe('Asia/Seoul');
    expect(resolveRouteTimezone({ constraints: { scheduledStartTimeZone: 'America/Toronto' } })).toBe('America/Toronto');
  });

  test('skips invalid values and uses one unambiguous connection timezone', () => {
    expect(resolveRouteTimezone({
      centerTimezone: 'not-a-timezone',
      commerceConnections: [{ timezone: 'America/Toronto' }, { timezone: 'America/Toronto' }],
      constraints: { timezone: 'also-not-valid' }
    })).toBe('America/Toronto');
  });

  test('returns null instead of guessing when nothing is known or connections disagree', () => {
    expect(resolveRouteTimezone({})).toBeNull();
    expect(resolveRouteTimezone({ commerceConnections: [{ timezone: 'America/Toronto' }, { timezone: 'Asia/Seoul' }] })).toBeNull();
  });
});
