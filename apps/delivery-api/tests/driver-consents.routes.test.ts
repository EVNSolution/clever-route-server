import { createHmac } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';

import { buildApp } from '../src/app.js';

const secret = 'driver-secret';
const now = new Date('2026-05-12T05:50:00.000Z');

describe('Driver consents route', () => {
  test('rejects consent submission without a driver bearer token', async () => {
    const { app, recordDriverConsents } = await createAppHarness();

    try {
      const response = await app.inject({
        method: 'POST',
        payload: consentPayload(),
        url: '/driver/consents'
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        data: null,
        error: { code: 'UNAUTHORIZED', message: 'Missing driver bearer token' }
      });
      expect(recordDriverConsents).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('rejects invalid consent payloads before recording', async () => {
    const { app, recordDriverConsents } = await createAppHarness();

    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${driverToken()}` },
        method: 'POST',
        payload: { ...consentPayload(), consents: [{ type: 'LOCATION_INFORMATION', version: 'location-v1', accepted: true }] },
        url: '/driver/consents'
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        data: null,
        error: { code: 'BAD_REQUEST', message: 'Invalid driver consent payload' }
      });
      expect(recordDriverConsents).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('records required location and personal-info consent for an authenticated driver', async () => {
    const { app, recordDriverConsents } = await createAppHarness();

    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${driverToken()}` },
        method: 'POST',
        payload: consentPayload(),
        url: '/driver/consents'
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({
        data: {
          status: 'CONSENT_RECORDED',
          recordedAt: '2026-05-12T05:50:00.000Z',
          records: [
            { accepted: true, type: 'LOCATION_INFORMATION', version: 'location-v1' },
            { accepted: true, type: 'PERSONAL_INFORMATION', version: 'privacy-v1' }
          ]
        },
        error: null
      });
      expect(recordDriverConsents).toHaveBeenCalledWith({
        appContext: { appVersion: '0.1.0' },
        consents: [
          { accepted: true, type: 'LOCATION_INFORMATION', version: 'location-v1' },
          { accepted: true, type: 'PERSONAL_INFORMATION', version: 'privacy-v1' }
        ],
        deviceContext: { platform: 'ios' },
        driverId: 'driver-id',
        recordedAt: now,
        routeContext: '11111111-1111-4111-8111-111111111111',
        shopDomain: 'example.myshopify.com'
      });
    } finally {
      await app.close();
    }
  });
});

async function createAppHarness() {
  const recordDriverConsents = vi.fn(() =>
    Promise.resolve({
      status: 'CONSENT_RECORDED' as const,
      recordedAt: now.toISOString(),
      records: [
        { accepted: true, type: 'LOCATION_INFORMATION' as const, version: 'location-v1' },
        { accepted: true, type: 'PERSONAL_INFORMATION' as const, version: 'privacy-v1' }
      ]
    })
  );
  const app = await buildApp({
    driverApi: {
      driverConsentService: { recordDriverConsents },
      driverEventService: { recordDriverEvent: vi.fn() },
      jwtSecret: secret,
      now: () => now
    }
  });

  return { app, recordDriverConsents };
}

function consentPayload(): Record<string, unknown> {
  return {
    appContext: { appVersion: '0.1.0' },
    consents: [
      { accepted: true, type: 'LOCATION_INFORMATION', version: 'location-v1' },
      { accepted: true, type: 'PERSONAL_INFORMATION', version: 'privacy-v1' }
    ],
    deviceContext: { platform: 'ios' },
    recordedAt: now.toISOString(),
    routeContext: '11111111-1111-4111-8111-111111111111'
  };
}

function driverToken(): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    aud: 'clever-delivery-driver',
    driverId: 'driver-id',
    exp: Math.floor(now.getTime() / 1000) + 60,
    iat: Math.floor(now.getTime() / 1000),
    shopDomain: 'example.myshopify.com',
    sub: 'driver-auth-subject',
    tokenVersion: 0
  };
  const encodedHeader = Buffer.from(JSON.stringify(header), 'utf8').toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = createHmac('sha256', secret).update(signingInput).digest('base64url');

  return `${signingInput}.${signature}`;
}
