import { describe, expect, test } from 'vitest';

import {
  aggregateOrderItems,
  fingerprintOrderItems,
  parseWooCommerceOrderItems,
  toOrderItemDto
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

  test('sanitizes dirty Woo item names and option values', () => {
    const result = parseWooCommerceOrderItems([
      {
        product_id: 101,
        variation_id: 202,
        name: '토마토 <span class="divider">/</span> Tomato&nbsp;Box',
        sku: 'TB-1',
        quantity: 2,
        meta_data: [
          { key: '옵션 <span>구분</span>', value: 'Large &amp; Red' },
          { key: 'Packaging', value: { display_value: '<span>Gift</span> Box', value: 'fallback' } },
          { key: '_hidden', value: '<span>ignore me</span>' }
        ]
      }
    ]);

    expect(result.reviewReasons).toEqual([]);
    expect(result.items).toEqual([
      {
        productId: 101,
        variationId: 202,
        name: '토마토 / Tomato Box',
        sku: 'TB-1',
        options: [
          { key: '옵션 구분', value: 'Large & Red' },
          { key: 'Packaging', value: 'Gift Box' }
        ],
        quantity: 2
      }
    ]);
  });

  test('sanitizes persisted order item readback for legacy rows', () => {
    expect(toOrderItemDto({
      name: 'Legacy <span>Tomato</span>',
      options: [{ key: 'Size', value: 'Large &amp; Red' }],
      productId: 101,
      quantity: 2,
      sku: ' SKU-1 ',
      variationId: 7
    })).toEqual({
      name: 'Legacy Tomato',
      options: [{ key: 'Size', value: 'Large & Red' }],
      productId: 101,
      quantity: 2,
      sku: 'SKU-1',
      variationId: 7
    });
  });

  test('returns item review reasons for missing or invalid lines', () => {
    expect(parseWooCommerceOrderItems([]).reviewReasons).toEqual(['missing_order_items']);
    expect(
      parseWooCommerceOrderItems([
        { product_id: null, name: '', quantity: 0 }
      ]).reviewReasons
    ).toEqual(['missing_item_product_id', 'missing_item_quantity', 'missing_item_name']);
  });

  test('aggregates by product, variation, and canonical options', () => {
    const items = [
      { productId: 2, variationId: 0, name: 'B', sku: null, options: [], quantity: 1 },
      { productId: 1, variationId: 7, name: 'A', sku: 'A-7', options: [{ key: 'Color', value: 'Red' }], quantity: 2 },
      { productId: 1, variationId: 7, name: 'Display renamed', sku: 'NEW-SKU', options: [{ key: 'Color', value: 'Red' }], quantity: 3 },
      { productId: 1, variationId: 7, name: 'A', sku: 'A-7', options: [{ key: 'Color', value: 'Blue' }], quantity: 4 }
    ];

    const summary = aggregateOrderItems(items);

    expect(summary.totalQuantity).toBe(10);
    expect(summary.itemTypes).toBe(3);
    expect(summary.items).toEqual([
      { productId: 1, variationId: 7, name: 'A', sku: 'A-7', options: [{ key: 'Color', value: 'Blue' }], quantity: 4 },
      { productId: 1, variationId: 7, name: 'A', sku: 'A-7', options: [{ key: 'Color', value: 'Red' }], quantity: 5 },
      { productId: 2, variationId: 0, name: 'B', sku: null, options: [], quantity: 1 }
    ]);
    expect(summary.fingerprint).toBe(fingerprintOrderItems([...summary.items].reverse()));
  });

  test('fingerprint is stable for option order and display-only noise', () => {
    const base = aggregateOrderItems([
      {
        productId: 1,
        variationId: 7,
        name: 'Tomato Box',
        sku: 'A-7',
        options: [
          { key: 'Color', value: 'Red' },
          { key: 'Size', value: 'Large' }
        ],
        quantity: 2
      }
    ]).fingerprint;

    const equivalent = aggregateOrderItems([
      {
        productId: 1,
        variationId: 7,
        name: '<span>Tomato</span> Box Renamed',
        sku: 'DIFFERENT-SKU',
        options: [
          { key: 'Size', value: 'Large' },
          { key: 'Color', value: 'Red' }
        ],
        quantity: 2
      }
    ]).fingerprint;

    const changedOption = aggregateOrderItems([
      {
        productId: 1,
        variationId: 7,
        name: 'Tomato Box',
        sku: 'A-7',
        options: [
          { key: 'Color', value: 'Blue' },
          { key: 'Size', value: 'Large' }
        ],
        quantity: 2
      }
    ]).fingerprint;

    const changedQuantity = aggregateOrderItems([
      {
        productId: 1,
        variationId: 7,
        name: 'Tomato Box',
        sku: 'A-7',
        options: [
          { key: 'Color', value: 'Red' },
          { key: 'Size', value: 'Large' }
        ],
        quantity: 3
      }
    ]).fingerprint;

    expect(equivalent).toBe(base);
    expect(changedOption).not.toBe(base);
    expect(changedQuantity).not.toBe(base);
  });
});
