import { describe, expect, test } from 'vitest';
import { buildApp } from '../src/app.js';

describe('password reset proxy boundary', () => {
  test('separates clients at one trusted Caddy hop and ignores spoofed deeper hops', async () => {
    const app = await buildApp({
      trustedProxyAddresses: ['172.20.0.2'],
      dsvDriverAuth: {
        jwtSecret: 'test-secret', repository: {} as never,
        passwordResetService: {
          complete: () => Promise.resolve(), issueLink: () => Promise.resolve(null), validateLink: () => Promise.resolve(null),
        },
      },
    });
    try {
      const probe = (forwarded: string, remoteAddress = '172.20.0.2') => app.inject({
        method: 'POST', url: '/api/dsv/driver/auth/password-reset/validate', remoteAddress,
        headers: { 'x-forwarded-for': forwarded }, payload: { token: 'A'.repeat(43) },
      });
      for (let i = 0; i < 20; i += 1) expect((await probe('198.51.100.1')).statusCode).toBe(401);
      const limited = await probe('198.51.100.1');
      expect(limited.statusCode).toBe(429);
      expect(limited.headers['cache-control']).toBe('no-store');
      expect((await probe('198.51.100.2')).statusCode).toBe(401);
      expect((await probe('203.0.113.1, 198.51.100.1')).statusCode).toBe(429);
      for (let i = 0; i < 20; i += 1) expect((await probe(`203.0.113.${i + 1}`, '172.20.0.99')).statusCode).toBe(401);
      expect((await probe('203.0.113.50', '172.20.0.99')).statusCode).toBe(429);
    } finally { await app.close(); }
  });

  test.each([
    '/api/dsv/drivers/11111111-1111-4111-8111-111111111111/password-reset-link',
    '/api/dsv/driver/auth/password-reset/validate',
    '/api/dsv/driver/auth/password-reset/complete',
  ])('marks capability responses non-cacheable even when unavailable: %s', async (url) => {
    const app = await buildApp();
    try {
      const response = await app.inject({ method: 'POST', url, payload: {} });
      expect(response.headers['cache-control']).toBe('no-store');
    } finally { await app.close(); }
  });
});
