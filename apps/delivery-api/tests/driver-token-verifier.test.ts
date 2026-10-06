import { createHmac } from 'node:crypto';
import { describe, expect, test } from 'vitest';

import {
  readDriverJwtSecret,
  signDriverRouteToken,
  verifyDriverRouteToken,
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

describe('verifyDriverRouteToken', () => {
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

  test.each([
    [{ aud: 'clever-delivery-driver' }, 'audience mismatch'],
    [{ aud: 'clever-driver-account' }, 'audience mismatch'],
    [{ exp: Math.floor(now.getTime() / 1000) }, 'has expired'],
    [{ nbf: Math.floor(now.getTime() / 1000) + 1 }, 'not active yet'],
  ])('rejects incompatible scope or time claims %j', (claims, message) => {
    expect(() => verifyDriverRouteToken(signClaims(claims), { now, secret })).toThrow(message);
  });

  test('rejects tokens with invalid signatures', () => {
    const token = signClaims({});
    const [header, payload, signature] = token.split('.');
    const invalidSignature = `${signature?.[0] === 'x' ? 'y' : 'x'}${signature?.slice(1)}`;

    expect(() => verifyDriverRouteToken(`${header}.${payload}.${invalidSignature}`, { now, secret })).toThrow('Invalid driver token signature');
  });
});

function decodePayload(token: string): Record<string, unknown> {
  const encodedPayload = token.split('.')[1];
  if (encodedPayload === undefined) throw new Error('missing token payload');
  return JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as Record<string, unknown>;
}

function signClaims(overrides: Record<string, unknown>): string {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const payload = {
    accountId: 'account-id',
    aud: 'clever-delivery-driver-route',
    exp: issuedAt + 900,
    iat: issuedAt,
    routePlanId: 'route-plan-id',
    sub: 'driver-account:account-id',
    ...overrides,
  };
  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = Buffer.from(JSON.stringify(header), 'utf8').toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = createHmac('sha256', secret).update(signingInput).digest('base64url');

  return `${signingInput}.${signature}`;
}
