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
      expect(response.body).toContain('https://clever-route-api.cleversystem.ai/privacy');
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

  test('GET /driver-app/privacy serves the Driver privacy policy with account deletion details', async () => {
    const app = await buildApp();

    try {
      const response = await app.inject({ method: 'GET', url: '/driver-app/privacy' });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.body).toContain('CLEVER Driver 개인정보 처리방침');
      expect(response.body).toContain('https://clever-route-api.cleversystem.ai/driver-app/privacy');
      expect(response.body).toContain('이브이앤솔루션 주식회사');
      expect(response.body).toContain('서울특별시 동작구 노량진로 10');
      expect(response.body).toContain('mailto:chase@evnsolution.com');
      expect(response.body).toContain('070-8028-3180');
      expect(response.body).toContain('계정 삭제');
      expect(response.body).toContain('기기 화면에만 표시');
      expect(response.body).toContain('백그라운드 위치를 수집하거나 서버로 전송하지 않습니다');
      expect(response.body).not.toContain('pending operator/legal confirmation');
    } finally {
      await app.close();
    }
  });

  test('GET /driver-app/support serves a public support page with real contact information', async () => {
    const app = await buildApp();

    try {
      const response = await app.inject({ method: 'GET', url: '/driver-app/support' });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.body).toContain('CLEVER Driver 지원');
      expect(response.body).toContain('https://clever-route-api.cleversystem.ai/driver-app/support');
      expect(response.body).toContain('EV&amp;Solution Co., Ltd.');
      expect(response.body).toContain('서울특별시 동작구 노량진로 10');
      expect(response.body).toContain('mailto:sumz@evnsolution.com');
      expect(response.body).toContain('tel:070-7954-4180');
      expect(response.body).toContain('mailto:chase@evnsolution.com');
      expect(response.body).toContain('tel:070-8028-3180');
      expect(response.body).toContain('0504-011-2955');
      expect(response.body).toContain('계정 삭제 요청');
      expect(response.body).not.toContain('pending');
    } finally {
      await app.close();
    }
  });
});
