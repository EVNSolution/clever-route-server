import { describe, expect, test } from 'vitest';
import { orderedDateBoundary } from '../src/modules/shopify/ordered-date-range.js';
import { toCanonicalOrderWhere } from '../src/modules/shopify/order-sync.repository.js';

describe('store ordered-date range contract', () => {
  test.each([
    ['2026-07-14', '2026-07-14T04:00:00.000Z', '2026-07-15T04:00:00.000Z', 24],
    ['2026-01-13', '2026-01-13T05:00:00.000Z', '2026-01-14T05:00:00.000Z', 24],
    ['2026-03-08', '2026-03-08T05:00:00.000Z', '2026-03-09T04:00:00.000Z', 23],
    ['2026-11-01', '2026-11-01T04:00:00.000Z', '2026-11-02T05:00:00.000Z', 25]
  ])('%s uses independent Toronto midnights (%s to %s)', (date, start, end, hours) => {
    const from = orderedDateBoundary(date, 'America/Toronto');
    const to = orderedDateBoundary(date, 'America/Toronto', true);
    expect(from.toISOString()).toBe(start);
    expect(to.toISOString()).toBe(end);
    expect((to.getTime() - from.getTime()) / 3_600_000).toBe(hours);
    const where = toCanonicalOrderWhere('shop', { orderedDateFrom: date, orderedDateTo: date, orderedDateTimeZone: 'America/Toronto' });
    expect(where.AND).toEqual(expect.arrayContaining([{ processedAt: { gte: from } }, { processedAt: { lt: to } }]));
  });
  test('an omitted timezone preserves the legacy UTC inclusive/exclusive API contract', () => {
    expect(orderedDateBoundary('2026-11-01').toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(orderedDateBoundary('2026-11-01', undefined, true).toISOString()).toBe('2026-11-02T00:00:00.000Z');
  });
  test('host/browser timezone does not override the specified store zone', () => {
    const previous = process.env.TZ;
    try {
      for (const zone of ['Asia/Seoul', 'America/Los_Angeles', 'UTC']) {
        process.env.TZ = zone;
        expect(orderedDateBoundary('2026-11-01', 'America/Toronto').toISOString()).toBe('2026-11-01T04:00:00.000Z');
      }
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });
  test('invalid IANA timezone fails instead of silently applying a fixed offset', () => {
    expect(() => orderedDateBoundary('2026-11-01', 'Invalid/Store')).toThrow();
  });
});
