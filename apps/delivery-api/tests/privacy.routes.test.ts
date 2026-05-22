import { describe, expect, test } from 'vitest';

import { buildApp } from '../src/app.js';

describe('privacy routes', () => {
  test('GET /privacy serves the public privacy notice from the route server domain', async () => {
    const app = await buildApp();

    try {
      const response = await app.inject({ method: 'GET', url: '/privacy' });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.body).toContain('Clever Route 개인정보 처리방침');
      expect(response.body).toContain('https://clever-route.cleversystem.ai/privacy');
      expect(response.body).toContain('WordPress/WooCommerce');
      expect(response.body).toContain('Consumer Key');
      expect(response.body).toContain('webhook secret');
      expect(response.body).toContain('proof-of-delivery');
      expect(response.body).toContain('Privacy, support, account, or data deletion requests');
      expect(response.body).toContain('pending operator/legal confirmation');
      expect(response.body).not.toMatch(/[A-Z0-9._%+-]+@(gmail|naver|daum|hanmail|icloud|outlook|hotmail)\.[A-Z]{2,}/iu);
      expect(response.body).not.toContain('mailto:');
      expect(response.body).not.toContain('admin.cleversystem.ai');
      expect(response.body).not.toContain('Shopify embedded app');
    } finally {
      await app.close();
    }
  });

  test('GET /privacy can render an operator-configured contact without hardcoding personal email', async () => {
    const previousContact = process.env.PRIVACY_CONTACT_EMAIL;
    process.env.PRIVACY_CONTACT_EMAIL = 'privacy@example.com';
    const app = await buildApp();

    try {
      const response = await app.inject({ method: 'GET', url: '/privacy' });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('mailto:privacy@example.com');
      expect(response.body).not.toMatch(/[A-Z0-9._%+-]+@(gmail|naver|daum|hanmail|icloud|outlook|hotmail)\.[A-Z]{2,}/iu);
    } finally {
      if (previousContact === undefined) {
        delete process.env.PRIVACY_CONTACT_EMAIL;
      } else {
        process.env.PRIVACY_CONTACT_EMAIL = previousContact;
      }
      await app.close();
    }
  });

  test('GET /privacy rejects malformed configured privacy contact before rendering HTML', async () => {
    const previousContact = process.env.PRIVACY_CONTACT_EMAIL;
    process.env.PRIVACY_CONTACT_EMAIL = 'privacy"onclick="alert(1)@example.com';
    const app = await buildApp();

    try {
      const response = await app.inject({ method: 'GET', url: '/privacy' });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('pending operator/legal confirmation');
      expect(response.body).not.toContain('onclick');
      expect(response.body).not.toContain('mailto:privacy');
    } finally {
      if (previousContact === undefined) {
        delete process.env.PRIVACY_CONTACT_EMAIL;
      } else {
        process.env.PRIVACY_CONTACT_EMAIL = previousContact;
      }
      await app.close();
    }
  });

  test('GET /privacy-policy redirects legacy policy links to /privacy', async () => {
    const app = await buildApp();

    try {
      const response = await app.inject({ method: 'GET', url: '/privacy-policy' });

      expect(response.statusCode).toBeGreaterThanOrEqual(300);
      expect(response.statusCode).toBeLessThan(400);
      expect(response.headers.location).toBe('/privacy');
    } finally {
      await app.close();
    }
  });
});
