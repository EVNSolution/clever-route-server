import { createHmac } from 'node:crypto';
import { describe, expect, test } from 'vitest';

import {
  createOrdersFilterHash,
  decodeOrdersCursor,
  encodeOrdersCursor,
  InvalidOrdersCursorError
} from '../src/modules/shopify/order-pagination.js';

const secret = 'test-orders-cursor-secret-with-sufficient-entropy';
const now = new Date('2026-08-04T00:00:00.000Z');

describe('orders cursor', () => {
  test('round-trips canonical decimal BigInt tuples without JSON number loss', () => {
    const filterHash = createOrdersFilterHash({ deliveryArea: 'Toronto', search: 'private' }, secret);
    const cursor = encodeOrdersCursor({
      appId: 'clever',
      boundary: 'after',
      filterHash,
      orderId: '00000000-0000-0000-0000-000000000001',
      readWatermark: '2026-08-04T00:00:00.000Z',
      sequence: '9223372036854775807',
      shopId: '00000000-0000-0000-0000-000000000002'
    }, secret, { now });

    expect(cursor).not.toContain('private');
    expect(decodeOrdersCursor(cursor, {
      appId: 'clever',
      boundary: 'after',
      filterHash,
      shopId: '00000000-0000-0000-0000-000000000002'
    }, secret, { now })).toMatchObject({ sequence: '9223372036854775807' });
  });

  test.each([
    ['wrong boundary', { boundary: 'before' as const }],
    ['wrong app', { appId: 'other' }],
    ['wrong filter', { filterHash: 'hmac-sha256:other' }],
    ['wrong shop', { shopId: 'other' }]
  ])('rejects %s before repository use', (_label, override) => {
    const expected = {
      appId: 'clever',
      boundary: 'after' as const,
      filterHash: 'hmac-sha256:filter',
      shopId: 'shop-id'
    };
    const cursor = encodeOrdersCursor({
      ...expected,
      orderId: 'order-id',
      readWatermark: now.toISOString(),
      sequence: '1035'
    }, secret, { now });

    expect(() => decodeOrdersCursor(cursor, { ...expected, ...override }, secret, { now }))
      .toThrow(InvalidOrdersCursorError);
  });

  test('rejects expired and tampered cursors', () => {
    const context = {
      appId: 'clever', boundary: 'after' as const, filterHash: 'hash', orderId: 'order',
      readWatermark: now.toISOString(), sequence: '1', shopId: 'shop'
    };
    const cursor = encodeOrdersCursor(context, secret, { now, ttlMs: 1 });
    expect(() => decodeOrdersCursor(cursor, context, secret, { now: new Date(now.getTime() + 2) }))
      .toThrow(InvalidOrdersCursorError);
    expect(() => decodeOrdersCursor(`${cursor}x`, context, secret, { now }))
      .toThrow(InvalidOrdersCursorError);
  });

  test.each([
    ['leading zero', { sequence: '01' }],
    ['negative', { sequence: '-1' }],
    ['fraction', { sequence: '1.5' }],
    ['exponent', { sequence: '1e3' }],
    ['overflow', { sequence: '9223372036854775808' }],
    ['string expiry', { expiresAt: String(now.getTime() + 10_000) }],
    ['unsafe expiry', { expiresAt: Number.MAX_VALUE }],
    ['string issued at', { issuedAt: String(now.getTime()) }],
    ['wrong page size', { pageSize: 49 }],
    ['stale sort version', { sortSchemaVersion: 0 }]
  ])('rejects signed payload with %s', (_label, mutation) => {
    const context = {
      appId: 'clever', boundary: 'after' as const, filterHash: 'hash', orderId: 'order',
      readWatermark: now.toISOString(), sequence: '1', shopId: 'shop'
    };
    const cursor = mutateSignedCursor(encodeOrdersCursor(context, secret, { now }), mutation);
    expect(() => decodeOrdersCursor(cursor, context, secret, { now })).toThrow(InvalidOrdersCursorError);
  });
});

function mutateSignedCursor(cursor: string, mutation: Record<string, unknown>): string {
  const [body] = cursor.split('.');
  if (body === undefined) throw new Error('missing cursor body');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
  const mutated = Buffer.from(JSON.stringify({ ...payload, ...mutation })).toString('base64url');
  const signature = createHmac('sha256', secret).update(mutated).digest('hex');
  return `${mutated}.${signature}`;
}
