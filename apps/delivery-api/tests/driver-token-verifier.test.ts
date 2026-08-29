import { createHmac } from 'node:crypto';
import { describe, expect, test } from 'vitest';

import {
  readDriverJwtSecret,
  signDriverRouteToken,
  signDriverToken,
  verifyDriverRouteToken,
  verifyDriverToken
} from '../src/modules/driver/driver-token-verifier.js';

const secret = 'driver-secret';
const now = new Date('2026-05-07T06:10:00Z');

describe('readDriverJwtSecret', () => {
  test('keeps the API disabled when absent and rejects weak configured secrets', () => {
    expect(readDriverJwtSecret(undefined)).toBeUndefined();
    expect(readDriverJwtSecret('   ')).toBeUndefined();
    expect(() => readDriverJwtSecret('short-secret')).toThrow(
      'JWT_SECRET must contain at least 32 characters'
    );
    expect(readDriverJwtSecret('  test-driver-jwt-secret-32-characters  ')).toBe(
      'test-driver-jwt-secret-32-characters'
    );
  });
});

describe('verifyDriverToken', () => {
  test('signs route access with only the global account and assigned route scope', () => {
    const result = signDriverRouteToken(
      {
        accountId: 'account-id',
        expiresInSeconds: 900,
        routePlanId: 'route-plan-id',
        subject: 'driver-account:account-id',
        tokenVersion: 7
      },
      { now, secret }
    );

    expect(verifyDriverRouteToken(result.token, { now, secret })).toEqual({
      accountId: 'account-id',
      issuedAt: new Date('2026-05-07T06:10:00.000Z'),
      routePlanId: 'route-plan-id',
      subject: 'driver-account:account-id',
      tokenVersion: 7
    });
    expect(decodePayload(result.token)).not.toHaveProperty('driverId');
    expect(decodePayload(result.token)).not.toHaveProperty('shopDomain');
  });

  test('signs a short-lived driver JWT that the verifier accepts', () => {
    const result = signDriverToken(
      {
        driverId: 'driver-id',
        expiresInSeconds: 900,
        shopDomain: 'Example.myshopify.com',
        subject: 'driver:driver-id'
      },
      { now, secret }
    );

    expect(result.expiresAt).toBe('2026-05-07T06:25:00.000Z');
    expect(verifyDriverToken(result.token, { now, secret })).toEqual({
      driverId: 'driver-id',
      issuedAt: new Date('2026-05-07T06:10:00.000Z'),
      shopDomain: 'example.myshopify.com',
      subject: 'driver:driver-id',
      tokenVersion: 0
    });
  });

  test('signs and verifies driver JWTs for Woo/customer domains', () => {
    const result = signDriverToken(
      {
        driverId: 'driver-id',
        expiresInSeconds: 900,
        shopDomain: 'Dev1.TomatonoFood.com',
        subject: 'driver:driver-id',
        tokenVersion: 4
      },
      { now, secret }
    );

    expect(verifyDriverToken(result.token, { now, secret })).toEqual({
      driverId: 'driver-id',
      issuedAt: new Date('2026-05-07T06:10:00.000Z'),
      shopDomain: 'dev1.tomatonofood.com',
      subject: 'driver:driver-id',
      tokenVersion: 4
    });
  });

  test('accepts a server-issued driver JWT and returns driver context', () => {
    const token = legacySignDriverToken({
      aud: 'clever-delivery-driver',
      driverId: 'driver-id',
      exp: Math.floor(now.getTime() / 1000) + 60,
      iat: Math.floor(now.getTime() / 1000),
      shopDomain: 'example.myshopify.com',
      sub: 'driver-auth-subject',
      tokenVersion: 3
    });

    expect(verifyDriverToken(token, { now, secret })).toEqual({
      driverId: 'driver-id',
      issuedAt: new Date('2026-05-07T06:10:00.000Z'),
      shopDomain: 'example.myshopify.com',
      subject: 'driver-auth-subject',
      tokenVersion: 3
    });
  });

  test('rejects invalid commerce domains in server-issued tokens', () => {
    expect(() => signDriverToken(
      {
        driverId: 'driver-id',
        expiresInSeconds: 900,
        shopDomain: 'localhost',
        subject: 'driver:driver-id'
      },
      { now, secret }
    )).toThrow('Commerce domain is not a valid customer domain');
  });

  test('rejects tokens with invalid signatures', () => {
    const token = `${legacySignDriverToken({
      aud: 'clever-delivery-driver',
      driverId: 'driver-id',
      exp: Math.floor(now.getTime() / 1000) + 60,
      shopDomain: 'example.myshopify.com',
      sub: 'driver-auth-subject'
    }).slice(0, -1)}x`;

    expect(() => verifyDriverToken(token, { now, secret })).toThrow('Invalid driver token signature');
  });
});

function decodePayload(token: string): Record<string, unknown> {
  const encodedPayload = token.split('.')[1];
  if (encodedPayload === undefined) throw new Error('missing token payload');
  return JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as Record<string, unknown>;
}

function legacySignDriverToken(payload: Record<string, unknown>): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = Buffer.from(JSON.stringify(header), 'utf8').toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = createHmac('sha256', secret).update(signingInput).digest('base64url');

  return `${signingInput}.${signature}`;
}
