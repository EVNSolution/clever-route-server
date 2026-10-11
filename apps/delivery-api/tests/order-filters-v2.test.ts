import type { Prisma } from '@prisma/client';
import { describe, expect, test } from 'vitest';
import { readOrdersV2Filters } from '../src/modules/shopify/order-filters-v2.js';
import { toCanonicalOrderWhere } from '../src/modules/shopify/order-sync.repository.js';

describe('orders v2 filter boundary', () => {
  test('normalizes multi values as OR, independent dimensions as AND, and inclusive DST dates', () => {
    const filters = readOrdersV2Filters({
      filterVersion: '2',
      serviceTypes: ['PICKUP', 'DELIVERY', 'PICKUP'],
      fulfillmentStatuses: ['UNFULFILLED', 'PARTIALLY_FULFILLED'],
      paymentStatuses: ['PENDING'],
      receivedDateFrom: '2026-03-08',
      receivedDateTo: '2026-03-08',
      orderedDateTimeZone: 'America/Toronto',
    });
    expect(filters.serviceTypes).toEqual(['DELIVERY', 'PICKUP']);
    const query = JSON.stringify(
      toCanonicalOrderWhere('shop', filters, new Date('2026-10-01T12:00:00Z')),
    );
    expect(query).toContain('2026-03-08T05:00:00.000Z');
    expect(query).toContain('2026-03-09T04:00:00.000Z');
    expect(query).toContain('PARTIALLY_FULFILLED');
    expect(query).toContain('cleverManualPaymentStatus');
    expect(query).not.toContain('READY_TO_PLAN');
  });
  test.each([
    { filterVersion: '3' },
    { filterVersion: '2', deliveryState: 'planned' },
    { filterVersion: '2', scheduledDateFrom: '2026-02-30' },
    { filterVersion: '2', scheduledDateMissing: 'true', scheduledWeekdays: ['FRIDAY'] },
    { filterVersion: '2', receivedDateFrom: '2026-10-01' },
    { filterVersion: '2', serviceTypes: ['nope'] },
    { filterVersion: '2', scheduledDateTo: ['2026-10-01', '2026-10-02'] },
  ])('rejects ambiguous or unsupported requests %j', (query) => {
    expect(() => readOrdersV2Filters(query)).toThrow();
  });
  test('unselected means all including cancelled and missing data', () => {
    expect(toCanonicalOrderWhere('shop', readOrdersV2Filters({ filterVersion: '2' }))).toEqual({
      shopId: 'shop',
      AND: [
        { sourcePlatform: { not: 'CUSTOM' } },
        {
          OR: [
            { sellerOrderSourceKind: null },
            { sellerOrderSourceKind: { not: 'CLEVER_ROUTE_COPY' } },
          ],
        },
      ],
    });
  });

  test('normalizes the dedicated order number prefix without widening to broad search', () => {
    const filters = readOrdersV2Filters({
      filterVersion: '2',
      orderNumberPrefix: '  #233  ',
    });

    expect(filters).toEqual({ filterVersion: '2', orderNumberPrefix: '233' });
    const clauses = toCanonicalOrderWhere('shop', filters).AND as Prisma.OrderWhereInput[];
    expect(clauses).toContainEqual({
      OR: [
        { name: { mode: 'insensitive', startsWith: '233' } },
        { name: { mode: 'insensitive', startsWith: '#233' } },
      ],
    });
  });

  test('escapes Prisma LIKE metacharacters in literal order number prefixes', () => {
    const where = toCanonicalOrderWhere(
      'shop',
      readOrdersV2Filters({ filterVersion: '2', orderNumberPrefix: '#WEB_%' + '\\' }),
    );

    expect(JSON.stringify(where)).toContain(JSON.stringify('WEB\\_\\%\\\\').slice(1, -1));
  });

  test.each(['#', '##', '##233', '# #233'])('rejects unsupported hash prefixes without widening the cohort: %s', (orderNumberPrefix) => {
    expect(() => readOrdersV2Filters({ filterVersion: '2', orderNumberPrefix })).toThrow(
      'invalid order number prefix',
    );
  });
});
