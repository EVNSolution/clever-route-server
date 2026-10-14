import { describe, expect, test } from 'vitest';

import {
  customerTrackingToken,
  customerTrackingUrl,
  loadCustomerTrackingLinks,
  readCustomerTrackingToken,
} from '../src/modules/customer-tracking/customer-tracking-link.js';

const STOP_ID = '11111111-1111-4111-8111-111111111111';

describe('customer tracking links', () => {
  const links = loadCustomerTrackingLinks({ DELIVERY_API_PUBLIC_URL: 'https://route.example.com/', JWT_SECRET: 'secret-a' });

  test('signs a stop id into a public URL and reads it back', () => {
    if (links === undefined) throw new Error('links should load');
    const url = customerTrackingUrl(links, STOP_ID);

    expect(url).toMatch(/^https:\/\/route\.example\.com\/t\/11111111-1111-4111-8111-111111111111\.[A-Za-z0-9_-]{22}$/u);
    expect(readCustomerTrackingToken(links, customerTrackingToken(links, STOP_ID))).toBe(STOP_ID);
  });

  test('rejects tampered, foreign-secret, and malformed tokens', () => {
    if (links === undefined) throw new Error('links should load');
    const token = customerTrackingToken(links, STOP_ID);
    const otherLinks = loadCustomerTrackingLinks({ DELIVERY_API_PUBLIC_URL: 'https://route.example.com', JWT_SECRET: 'secret-b' });
    if (otherLinks === undefined) throw new Error('links should load');

    expect(readCustomerTrackingToken(links, token.replace(STOP_ID, '22222222-2222-4222-8222-222222222222'))).toBeNull();
    expect(readCustomerTrackingToken(otherLinks, token)).toBeNull();
    expect(readCustomerTrackingToken(links, STOP_ID)).toBeNull();
    expect(readCustomerTrackingToken(links, `${token}.extra`)).toBeNull();
    expect(readCustomerTrackingToken(links, `${STOP_ID}.short`)).toBeNull();
  });

  test('stays off without a public URL or secret', () => {
    expect(loadCustomerTrackingLinks({ JWT_SECRET: 'secret' })).toBeUndefined();
    expect(loadCustomerTrackingLinks({ DELIVERY_API_PUBLIC_URL: 'https://route.example.com' })).toBeUndefined();
  });
});
