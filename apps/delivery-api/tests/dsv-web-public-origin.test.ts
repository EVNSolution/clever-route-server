import { describe, expect, test } from 'vitest';

import { loadDsvWebPublicOrigin } from '../src/modules/dsv/dsv-web-public-origin.js';

describe('DSV web public origin', () => {
  test('accepts and normalizes an exact HTTPS origin in production', () => {
    expect(loadDsvWebPublicOrigin(' https://DSV.Example.com:8443/ ', 'production')).toBe('https://dsv.example.com:8443');
  });

  test.each([
    'http://dsv.example.com',
    'http://localhost:5173',
    'https://user:password@dsv.example.com',
    'https://dsv.example.com/driver/password-reset',
    'https://dsv.example.com/?tenant=dsv',
    'https://dsv.example.com/#fragment',
  ])('rejects non-production-safe or non-origin value %s', (value) => {
    expect(() => loadDsvWebPublicOrigin(value, 'production')).toThrow(/HTTPS origin/u);
  });

  test('permits local HTTP only outside production for same-origin web development', () => {
    expect(loadDsvWebPublicOrigin('http://localhost:5173/', 'development')).toBe('http://localhost:5173');
    expect(loadDsvWebPublicOrigin('http://[::1]:5173', 'test')).toBe('http://[::1]:5173');
    expect(loadDsvWebPublicOrigin('http://127.0.0.1:5173', 'test')).toBe('http://127.0.0.1:5173');
  });
});
