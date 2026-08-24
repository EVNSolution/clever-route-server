import { describe, expect, test, vi } from 'vitest';
import { Writable } from 'node:stream';

import { buildApp } from '../src/app.js';
import { signDriverRouteToken } from '../src/modules/driver/driver-token-verifier.js';

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
        accountId: 'account-id',
        appContext: { appVersion: '0.1.0' },
        consents: [
          { accepted: true, type: 'LOCATION_INFORMATION', version: 'location-v1' },
          { accepted: true, type: 'PERSONAL_INFORMATION', version: 'privacy-v1' }
        ],
        deviceContext: { platform: 'ios' },
        recordedAt: now,
        routePlanId: '11111111-1111-4111-8111-111111111111'
      });
    } finally {
      await app.close();
    }
  });

  test('rejects consent context outside the token route assignment', async () => {
    const { app, recordDriverConsents } = await createAppHarness();

    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${driverToken()}` },
        method: 'POST',
        payload: { ...consentPayload(), routeContext: 'other-route-plan-id' },
        url: '/driver/consents'
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        data: null,
        error: { code: 'ROUTE_ASSIGNMENT_ACCOUNT_MISMATCH', message: 'Driver route assignment rejected' }
      });
      expect(recordDriverConsents).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('returns a deterministic consent failure without leaking repository details', async () => {
    const { app } = await createAppHarness({ recordError: new Error('database unavailable') });

    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${driverToken()}` },
        method: 'POST',
        payload: consentPayload(),
        url: '/driver/consents'
      });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({
        data: null,
        error: { code: 'CONSENT_RECORD_FAILED', message: 'Driver consent could not be recorded' }
      });
      expect(response.body).not.toContain('database unavailable');
    } finally {
      await app.close();
    }
  });

  test('redacts hostile consent repository errors from structured logs', async () => {
    let logOutput = '';
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        logOutput += String(chunk);
        callback();
      }
    });
    const { app } = await createAppHarness({
      logger: { level: 'error', stream },
      recordError: new Error('token=secret customer@example.invalid at 99 Private Street')
    });

    try {
      await app.inject({
        headers: { authorization: `Bearer ${driverToken()}` },
        method: 'POST',
        payload: consentPayload(),
        url: '/driver/consents'
      });

      expect(logOutput).toContain('CONSENT_RECORD_FAILED');
      expect(logOutput).not.toContain('token=secret');
      expect(logOutput).not.toContain('customer@example.invalid');
      expect(logOutput).not.toContain('99 Private Street');
    } finally {
      await app.close();
    }
  });
});

async function createAppHarness(input: {
  logger?: { level: string; stream: Writable };
  recordError?: Error;
} = {}) {
  const recordDriverConsents = vi.fn(() => input.recordError === undefined
    ? Promise.resolve({
      status: 'CONSENT_RECORDED' as const,
      recordedAt: now.toISOString(),
      records: [
        { accepted: true, type: 'LOCATION_INFORMATION' as const, version: 'location-v1' },
        { accepted: true, type: 'PERSONAL_INFORMATION' as const, version: 'privacy-v1' }
      ]
    })
    : Promise.reject(input.recordError)
  );
  const app = await buildApp({
    logger: input.logger,
    driverApi: {
      driverConsentService: { recordDriverConsents },
      driverEventService: {
        admitDriverEventAttempt: vi.fn(() => Promise.resolve({ attemptId: 'attempt-id', attemptNumber: 1 })),
        finalizeDriverEventAttempt: vi.fn(() => Promise.resolve()),
        recordDriverEvent: vi.fn()
      },
      driverTokenAccessRepository: {
        isDriverAccessTokenActive: vi.fn(() => Promise.resolve(false)),
        isDriverAccountAccessTokenActive: vi.fn(() => Promise.resolve(true)),
        resolveDriverRouteAccess: vi.fn(() => Promise.resolve({
          accountId: 'account-id',
          driverId: 'driver-id',
          routePlanId: '11111111-1111-4111-8111-111111111111',
          shopDomain: 'example.myshopify.com',
          shopId: 'shop-id'
        }))
      },
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
  return signDriverRouteToken({
    accountId: 'account-id',
    expiresInSeconds: 60,
    routePlanId: '11111111-1111-4111-8111-111111111111',
    subject: 'driver-account:account-id',
    tokenVersion: 0
  }, { now, secret }).token;
}
