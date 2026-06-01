import { describe, expect, test } from 'vitest';

import { normalizeDriverCommerceDomain } from '../src/modules/driver/driver-commerce-domain.js';

describe('normalizeDriverCommerceDomain', () => {
  test('normalizes CLEVER customer and Shopify domains without Shopify-only coupling', () => {
    expect(normalizeDriverCommerceDomain(' Dev1.TomatonoFood.com ')).toBe('dev1.tomatonofood.com');
    expect(normalizeDriverCommerceDomain('https://dev1.tomatonofood.com/admin/path?x=1#top')).toBe('dev1.tomatonofood.com');
    expect(normalizeDriverCommerceDomain('Example.myshopify.com')).toBe('example.myshopify.com');
  });

  test.each([
    '',
    'localhost',
    '.example.com',
    'example.com.',
    'example..com',
    'bad_domain.example.com',
    'example.com:443',
    'example.com/../../secret',
    'https://example.com/..',
    `${'a'.repeat(64)}.example.com`,
    `${'a'.repeat(250)}.com`
  ])('rejects invalid commerce domain %s', (value) => {
    expect(() => normalizeDriverCommerceDomain(value)).toThrow('Commerce domain is not a valid customer domain');
  });
});
