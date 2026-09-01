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

  test('GET /routes-app/privacy serves the CLEVER Routes privacy notice without authentication', async () => {
    const app = await buildApp();

    try {
      const response = await app.inject({ method: 'GET', url: '/routes-app/privacy' });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.body).toContain('CLEVER Routes 개인정보 처리방침');
      expect(response.body).toContain('EV&amp;Solution Co., Ltd.');
      expect(response.body).toContain('활성 배송 경로');
      expect(response.body).toContain('전경 및 백그라운드');
      expect(response.body).toContain('정밀 위치');
      expect(response.body).toContain('증빙 사진');
      expect(response.body).toContain('EXIF');
      expect(response.body).toContain('비공개 저장소');
      expect(response.body).toContain('기본 180일');
      expect(response.body).toContain('해결된 순서 이벤트 재시도 증거는 기본 90일');
      expect(response.body).toContain('미해결 또는 조정이 필요한 기록은 해결될 때까지');
      expect(response.body).toContain('서명, 수령인 이름, 배송 메모');
      expect(response.body).toContain('경로 및 정차 활동');
      expect(response.body).toContain('푸시 토큰');
      expect(response.body).toContain('기기 식별자');
      expect(response.body).toContain('Firebase Cloud Messaging');
      expect(response.body).toContain('Google Maps 또는 Waze');
      expect(response.body).toContain('/routes-app/account-deletion');
      expect(response.body).not.toContain('CLEVER Driver 개인정보 처리방침');
    } finally {
      await app.close();
    }
  });

  test('GET /routes-app/support serves Routes-specific support and safe contact guidance', async () => {
    const app = await buildApp();

    try {
      const response = await app.inject({ method: 'GET', url: '/routes-app/support' });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.body).toContain('CLEVER Routes 지원');
      expect(response.body).toContain('이브이앤솔루션 주식회사');
      expect(response.body).toContain('mailto:');
      expect(response.body).toContain('/routes-app/privacy');
      expect(response.body).toContain('/routes-app/account-deletion');
      expect(response.body).toContain('비밀번호, PIN, 인증 토큰 또는 증빙 사진을 보내지 마세요');
      expect(response.body).not.toContain('DSV 배송원');
    } finally {
      await app.close();
    }
  });

  test('GET /routes-app/account-deletion provides verified external intake without an unsafe public deletion form', async () => {
    const app = await buildApp();

    try {
      const response = await app.inject({ method: 'GET', url: '/routes-app/account-deletion' });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.body).toContain('CLEVER Routes 계정 및 데이터 삭제 요청');
      expect(response.body).toContain('mailto:');
      expect(response.body).toContain('등록된 연락처');
      expect(response.body).toContain('일회성 본인 확인');
      expect(response.body).toContain('활성 배송 경로');
      expect(response.body).toContain('30일 이내');
      expect(response.body).toContain('로그인 세션과 푸시 토큰');
      expect(response.body).toContain('삭제하거나 익명화');
      expect(response.body).toContain('배송, 분쟁, 보안, 계약 또는 법적 의무');
      expect(response.body).toContain('비밀번호, PIN, 인증 토큰 또는 증빙 사진을 이메일로 보내지 마세요');
      expect(response.body).not.toMatch(/<form\b/iu);
      expect(response.body).not.toMatch(/<input\b/iu);
      expect(response.body).not.toContain('href="tel:');
    } finally {
      await app.close();
    }
  });
});
