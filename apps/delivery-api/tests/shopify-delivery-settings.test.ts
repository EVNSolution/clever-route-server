import { describe, expect, test, vi } from 'vitest';
import {
  loadShopifyDeliveryCycle,
  readShopifyDeliveryCycle,
  ShopifyDeliverySettingsError,
} from '../src/modules/shopify/order-delivery-settings.js';
import { mapShopifyOrderNodeToDeliveryInputs, type ShopifyOrderNode } from '../src/modules/shopify/order-sync.mapper.js';

function settings(timeZone = 'America/Toronto', value: unknown = {
  deliveryCycle: { cutoffWeekday: 'TUESDAY', cutoffTime: '17:00', timeZone: 'America/Toronto' },
}) {
  return {
    shop: { ianaTimezone: timeZone },
    currentAppInstallation: { metafield: { value: JSON.stringify(value) }, legacyMetafield: null },
  };
}

describe('shop-scoped delivery settings', () => {
  test('uses the shop IANA timezone even when legacy preferences contain a Toronto default', () => {
    expect(readShopifyDeliveryCycle(settings('Asia/Seoul'))).toEqual({
      cutoffWeekday: 'TUESDAY', cutoffTime: '17:00', timeZone: 'Asia/Seoul',
    });
  });

  test('only falls back to legacy metafield when the modern metafield is absent', () => {
    const legacy = { value: JSON.stringify({ deliveryCycle: { cutoffWeekday: 'WEDNESDAY', cutoffTime: '12:30' } }) };
    expect(readShopifyDeliveryCycle({
      ...settings(), currentAppInstallation: { metafield: null, legacyMetafield: legacy },
    })).toMatchObject({ cutoffWeekday: 'WEDNESDAY', cutoffTime: '12:30' });
    expect(readShopifyDeliveryCycle({
      ...settings(), currentAppInstallation: { ...settings().currentAppInstallation, legacyMetafield: legacy },
    })).toMatchObject({ cutoffWeekday: 'TUESDAY', cutoffTime: '17:00' });
    expect(() => readShopifyDeliveryCycle({
      ...settings(), currentAppInstallation: { metafield: { value: 'invalid' }, legacyMetafield: legacy },
    })).toThrow(ShopifyDeliverySettingsError);
  });

  test('uses the app cutoff defaults only for genuinely unconfigured shops, retaining their own zone', () => {
    expect(readShopifyDeliveryCycle({
      shop: { ianaTimezone: 'America/Vancouver' },
      currentAppInstallation: { metafield: null, legacyMetafield: null },
    })).toEqual({ cutoffWeekday: 'MONDAY', cutoffTime: '23:59', timeZone: 'America/Vancouver' });
    expect(readShopifyDeliveryCycle(settings('Asia/Seoul', { language: 'ko' }))).toMatchObject({ cutoffTime: '23:59' });
  });

  test.each(['', 'invalid/zone', '+09:00'])('rejects unavailable or non-IANA shop timezone %s', (zone) => {
    expect(() => readShopifyDeliveryCycle(settings(zone))).toThrow(ShopifyDeliverySettingsError);
  });

  test.each([
    {}, { shop: {} }, { ...settings(), currentAppInstallation: null },
    { ...settings(), currentAppInstallation: {} },
    settings('America/Toronto', null), settings('America/Toronto', []),
    settings('America/Toronto', { deliveryCycle: null }),
    settings('America/Toronto', { deliveryCycle: { cutoffTime: '25:00' } }),
    settings('America/Toronto', { deliveryCycle: { cutoffTime: null } }),
    settings('America/Toronto', { deliveryCycle: { cutoffWeekday: 'TUES' } }),
  ])('rejects malformed/missing context without falling back to a default week', (data) => {
    expect(() => readShopifyDeliveryCycle(data)).toThrow(ShopifyDeliverySettingsError);
  });

  test('loads only the known app installation fields and sanitizes lookup failures', async () => {
    const request = vi.fn().mockResolvedValue(settings());
    await loadShopifyDeliveryCycle({ request });
    const query = String((request.mock.calls[0]?.[0] as { query: string }).query);
    expect(query).toContain('shop { ianaTimezone }');
    expect(query).toContain('namespace: "clever_route", key: "app_preferences"');
    expect(query).toContain('namespace: "tomatono_route", key: "app_preferences"');
    expect(request.mock.calls[0]?.[1]).toMatchObject({ signal: expect.any(AbortSignal) as AbortSignal });
    request.mockRejectedValueOnce(new Error('private-token-and-tenant-payload'));
    await expect(loadShopifyDeliveryCycle({ request })).rejects.toThrow(ShopifyDeliverySettingsError);
    request.mockRejectedValueOnce(new Error('private-token-and-tenant-payload'));
    await expect(loadShopifyDeliveryCycle({ request })).rejects.not.toThrow('private-token');
  });
});

describe('configured cutoff uses each shop local clock', () => {
  test.each([
    ['America/Toronto', '2026-09-29T20:59:00Z', '2026-10-02'],
    ['America/Toronto', '2026-09-29T21:00:00Z', '2026-10-09'],
    ['America/Toronto', '2026-09-29T21:01:00Z', '2026-10-09'],
    ['America/Toronto', '2026-11-10T21:59:00Z', '2026-11-13'],
    ['America/Toronto', '2026-11-10T22:00:00Z', '2026-11-20'],
    ['America/Toronto', '2026-11-10T22:01:00Z', '2026-11-20'],
    ['America/Vancouver', '2026-09-29T21:01:00Z', '2026-10-02'],
    ['Asia/Seoul', '2026-09-29T07:59:00Z', '2026-10-02'],
    ['Asia/Seoul', '2026-09-29T08:00:00Z', '2026-10-09'],
    ['Asia/Seoul', '2026-09-29T08:01:00Z', '2026-10-09'],
    ['Asia/Kolkata', '2026-09-29T11:29:00Z', '2026-10-02'],
    ['Asia/Kolkata', '2026-09-29T11:30:00Z', '2026-10-09'],
  ])('%s at %s maps Friday to %s', (zone, processedAt, expectedDate) => {
    const deliveryCycle = readShopifyDeliveryCycle(settings(zone));
    const result = mapShopifyOrderNodeToDeliveryInputs(order(processedAt), { deliveryCycle });
    expect(result.order.deliveryDate).toBe(expectedDate);
    expect(result.deliveryTimeZone).toBe(zone);
    expect(result.order.rawPayload.deliveryTimeZone).toBe(zone);
    expect(result.deliveryFact?.mappingDiagnostics).toMatchObject({ deliveryTimeZone: zone });
  });

  test('keeps shop-local received date and explicit delivery date while leaving free-text notes pending', () => {
    const deliveryCycle = readShopifyDeliveryCycle(settings('Asia/Seoul'));
    const node = order('2026-09-28T16:30:00Z');
    expect(mapShopifyOrderNodeToDeliveryInputs(node, { deliveryCycle }).order.orderDateLocal).toBe('2026-09-29');
    expect(mapShopifyOrderNodeToDeliveryInputs({ ...node, customAttributes: [
      ...node.customAttributes ?? [], { key: 'Delivery Date', value: '2026-10-16' },
    ] }, { deliveryCycle }).order.deliveryDate).toBe('2026-10-16');
    expect(mapShopifyOrderNodeToDeliveryInputs({ ...node, customAttributes: [], note: 'Friday please' }, { deliveryCycle }).order.deliveryDate).toBeNull();
  });
});

function order(processedAt: string): ShopifyOrderNode {
  return {
    id: 'gid://shopify/Order/123', legacyResourceId: '123', name: '#123',
    currentTotalPriceSet: null, displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'UNFULFILLED',
    email: null, phone: null, shippingAddress: null, processedAt, createdAt: processedAt,
    updatedAt: processedAt, customAttributes: [{ key: 'Delivery Day', value: 'Friday 5pm to 9pm' }],
  };
}
