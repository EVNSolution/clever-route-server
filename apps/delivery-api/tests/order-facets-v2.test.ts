import { describe, expect, test } from 'vitest';

import { countV2Facets, type V2FacetOrder } from '../src/modules/shopify/order-facets-v2.js';

const now = new Date('2026-10-15T15:00:00.000Z');

function order(overrides: Partial<V2FacetOrder>): V2FacetOrder {
  return {
    cancelled: false,
    crv: false,
    cvHasPlan: false,
    cvPlanStatus: null,
    facts: [{ area: 'North', date: '2026-10-16', due: false, open: false, st: 'DELIVERY' }],
    fs: 'paid',
    ful: 'UNFULFILLED',
    legacyRouteStatuses: [],
    manual: null,
    stops: [{ due: false, hasTwe: true, status: 'PENDING' }],
    ...overrides,
  };
}

const count = (rows: { value: string; count: number }[], value: string) => rows.find((row) => row.value === value)?.count;

describe('countV2Facets', () => {
  test('counts each option without its own dimension but with every other selected filter', () => {
    const orders = [
      order({}),
      order({ facts: [{ area: 'north', date: null, due: null, open: true, st: 'PICKUP' }], fs: 'pending' }),
      order({ fs: 'refunded', manual: 'PAID' }),
      order({ facts: [], stops: [] }),
    ];
    const result = countV2Facets(orders, { filterVersion: '2', paymentStatuses: ['PAID'], serviceTypes: ['DELIVERY'] }, now);

    expect(result.totalCount).toBe(2);
    // Payment options ignore the payment filter but keep serviceTypes=DELIVERY.
    expect(count(result.facets.paymentStatuses, 'PAID')).toBe(2);
    expect(count(result.facets.paymentStatuses, 'REFUNDED')).toBe(0);
    // Service options ignore the service filter but keep paymentStatuses=PAID.
    expect(count(result.facets.serviceTypes, 'DELIVERY')).toBe(2);
    expect(count(result.facets.serviceTypes, 'UNKNOWN')).toBe(1);
    // Area values are matched case-insensitively.
    expect(count(result.facets.areas, 'North')).toBe(2);
  });

  test('reports orders without stops or with an invalid route version as unknown progress', () => {
    const orders = [order({ stops: [] }), order({ crv: true, cvHasPlan: false }), order({})];
    const result = countV2Facets(orders, { filterVersion: '2' }, now);

    expect(count(result.facets.deliveryProgress, 'unknown')).toBe(2);
    expect(count(result.facets.deliveryProgress, 'unplanned')).toBe(1);
  });

  test('treats an awaiting route as planned and a past open pickup as elapsed', () => {
    const orders = [
      order({ legacyRouteStatuses: ['PUBLISHED'] }),
      order({ facts: [{ area: null, date: '2026-10-14', due: null, open: true, st: 'PICKUP' }], stops: [{ due: null, hasTwe: false, status: 'PENDING' }] }),
    ];
    const result = countV2Facets(orders, { filterVersion: '2', orderedDateTimeZone: 'America/Toronto' }, now);

    expect(count(result.facets.deliveryProgress, 'planned')).toBe(1);
    expect(count(result.facets.deliveryProgress, 'pickup_elapsed')).toBe(1);
    expect(count(result.facets.areas, '__MISSING__')).toBe(1);
  });
});
