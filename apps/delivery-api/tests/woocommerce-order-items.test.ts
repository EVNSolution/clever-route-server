import { describe, expect, test } from 'vitest';

import {
  aggregateOrderItems,
  fingerprintOrderItems,
  parseWooCommerceOrderItems
} from '../src/modules/order-items/order-items.js';

describe('WooCommerce order items', () => {
  test('parses Woo line items with product variation grouping inputs', () => {
    const result = parseWooCommerceOrderItems([
      {
        product_id: 101,
        variation_id: 202,
        name: 'Tomato Box',
        sku: 'TB-1',
        quantity: 2,
        meta_data: [
          { key: 'Size', value: 'Large' },
          { key: '_hidden', value: 'ignore me' }
        ]
      }
    ]);

    expect(result.reviewReasons).toEqual([]);
    expect(result.items).toEqual([
      {
        productId: 101,
        variationId: 202,
        name: 'Tomato Box',
        sku: 'TB-1',
        options: [{ key: 'Size', value: 'Large' }],
        quantity: 2
      }
    ]);
  });

  test('returns item review reasons for missing or invalid lines', () => {
    expect(parseWooCommerceOrderItems([]).reviewReasons).toEqual(['missing_order_items']);
    expect(
      parseWooCommerceOrderItems([
        { product_id: null, name: '', quantity: 0 }
      ]).reviewReasons
    ).toEqual(['missing_item_product_id', 'missing_item_quantity', 'missing_item_name']);
  });

  test('aggregates by product and variation and creates stable fingerprints', () => {
    const items = [
      { productId: 2, variationId: 0, name: 'B', sku: null, options: [], quantity: 1 },
      { productId: 1, variationId: 7, name: 'A', sku: 'A-7', options: [{ key: 'Color', value: 'Red' }], quantity: 2 },
      { productId: 1, variationId: 7, name: 'A', sku: 'A-7', options: [{ key: 'Color', value: 'Red' }], quantity: 3 }
    ];

    const summary = aggregateOrderItems(items);

    expect(summary.totalQuantity).toBe(6);
    expect(summary.itemTypes).toBe(2);
    expect(summary.items).toEqual([
      { productId: 1, variationId: 7, name: 'A', sku: 'A-7', options: [{ key: 'Color', value: 'Red' }], quantity: 5 },
      { productId: 2, variationId: 0, name: 'B', sku: null, options: [], quantity: 1 }
    ]);
    expect(summary.fingerprint).toBe(fingerprintOrderItems([...summary.items].reverse()));
  });
});
