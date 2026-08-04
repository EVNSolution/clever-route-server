import { describe, expect, test } from 'vitest';

import { resolveAdminOrdersResourceFlags } from '../src/modules/shopify/order-sync.dependencies.js';

describe('admin orders resource feature flags', () => {
  test('uses the approved flag names and keeps the HMAC key as a prerequisite', () => {
    expect(resolveAdminOrdersResourceFlags({
      CLEVER_ORDERS_MAP_PROJECTION: '1',
      CLEVER_ORDERS_SELECTION_SNAPSHOTS: '1',
      CLEVER_ORDERS_SERVER_PAGINATION: '1'
    })).toEqual({ mapProjection: false, pagination: false, selectionSnapshots: false });

    expect(resolveAdminOrdersResourceFlags({
      CLEVER_ORDERS_MAP_PROJECTION: '1',
      CLEVER_ORDERS_SELECTION_SNAPSHOTS: '1',
      CLEVER_ORDERS_SERVER_PAGINATION: '1',
      ORDERS_PAGINATION_HMAC_KEY: 'secret'
    })).toEqual({ mapProjection: true, pagination: true, selectionSnapshots: true });
  });

  test('forces subordinate capabilities off when pagination is disabled', () => {
    expect(resolveAdminOrdersResourceFlags({
      CLEVER_ORDERS_MAP_PROJECTION: 'true',
      CLEVER_ORDERS_SELECTION_SNAPSHOTS: 'true',
      CLEVER_ORDERS_SERVER_PAGINATION: '0',
      ORDERS_PAGINATION_HMAC_KEY: 'secret'
    })).toEqual({ mapProjection: false, pagination: false, selectionSnapshots: false });
  });
});
