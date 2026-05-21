import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

import { mapWooCommerceOrderToDeliveryInputs } from '../src/modules/woocommerce/woocommerce-order.mapper.js';
import type { WooCommerceOrder } from '../src/modules/woocommerce/woocommerce-order.types.js';

const fixtureBase = new URL('./fixtures/woocommerce/', import.meta.url);

async function readFixture(name: string): Promise<WooCommerceOrder> {
  return JSON.parse(await readFile(new URL(name, fixtureBase), 'utf8')) as WooCommerceOrder;
}

describe('mapWooCommerceOrderToDeliveryInputs', () => {
  test('maps WooCommerce orders to canonical delivery inputs using standard fields and date metadata', async () => {
    const order = await readFixture('order-delivery-date-meta.json');

    const mapped = mapWooCommerceOrderToDeliveryInputs(order, { siteUrl: 'https://woo.example.test' });

    expect(mapped.order).toEqual(
      expect.objectContaining({
        currencyCode: 'CAD',
        deliveryArea: 'Markham',
        deliveryDate: '2026-05-21',
        deliveryDateSource: 'EXPLICIT_ATTRIBUTE',
        email: 'hana@example.test',
        fulfillmentStatus: 'PROCESSING',
        name: '#11388',
        phone: '+14165550101',
        readiness: 'NEEDS_REVIEW',
        reviewReasons: ['missing_coordinates'],
        shopifyOrderGid: 'woocommerce://woo.example.test/orders/11388',
        shopifyOrderLegacyId: null,
        sourceOrderId: '11388',
        sourceOrderNumber: '11388',
        sourcePlatform: 'WOOCOMMERCE',
        sourceSiteUrl: 'https://woo.example.test',
        sourceUpdatedAt: new Date('2026-05-19T20:06:34.000Z'),
        totalPriceAmount: '54.25',
        updatedAtShopify: new Date('2026-05-19T20:06:34.000Z')
      })
    );
    expect(mapped.deliveryStop).toEqual(
      expect.objectContaining({
        address1: '100 Synthetic Ave',
        city: 'Markham',
        countryCode: 'CA',
        deliveryDate: '2026-05-21',
        geocodeStatus: 'PENDING',
        phone: '+14165550101',
        postalCode: 'L3R 0A1',
        province: 'ON',
        recipientName: 'Hana Kim'
      })
    );
    expect(mapped.order.rawPayload.sourcePlatform).toBe('WOOCOMMERCE');
    expect(mapped.order.rawPayload.metadataKeys).toEqual(expect.arrayContaining(['delivery_date', 'delivery_area']));
  });

  test('keeps missing delivery date explicit instead of silently treating an order as ready', async () => {
    const order = await readFixture('order-date-pending.json');

    const mapped = mapWooCommerceOrderToDeliveryInputs(order, { siteUrl: 'woo.example.test' });

    expect(mapped.order.deliveryDate).toBeNull();
    expect(mapped.order.deliveryDateSource).toBe('MISSING');
    expect(mapped.order.readiness).toBe('NEEDS_REVIEW');
    expect(mapped.order.reviewReasons).toContain('missing_delivery_date');
    expect(mapped.order.reviewReasons).toContain('missing_route_scope');
    expect(mapped.deliveryStop?.deliveryDate).toBeNull();
  });

  test('marks cancelled-like WooCommerce statuses as not route-ready', async () => {
    const order = await readFixture('order-cancelled.json');

    const mapped = mapWooCommerceOrderToDeliveryInputs(order, { siteUrl: 'https://woo.example.test/' });

    expect(mapped.order.cancelledAt).toEqual(new Date('2026-05-19T20:06:35.000Z'));
    expect(mapped.order.readiness).toBe('NEEDS_REVIEW');
    expect(mapped.order.reviewReasons).toContain('non_deliverable_status:cancelled');
  });

  test('falls back to billing address when shipping is empty', async () => {
    const order = await readFixture('order-delivery-date-meta.json');
    order.shipping = { first_name: '', last_name: '', address_1: '', city: '', postcode: '', country: '' };

    const mapped = mapWooCommerceOrderToDeliveryInputs(order, { siteUrl: 'https://woo.example.test' });

    expect(mapped.deliveryStop).toEqual(
      expect.objectContaining({
        address1: '10 Billing Rd',
        city: 'Markham',
        phone: '+14165550101',
        recipientName: 'Hana Kim'
      })
    );
  });
});
