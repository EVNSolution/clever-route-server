import { describe, expect, test } from 'vitest';

import { createAdminRouteGeometryProvider } from '../src/modules/route-plans/route-plan.dependencies.js';
import { CoverageAwareRouteGeometryProvider } from '../src/modules/route-plans/route-engine-coverage.js';
import { OsrmRouteGeometryProvider } from '../src/modules/route-plans/osrm-route-geometry.client.js';

describe('admin route plan dependencies', () => {
  test('selects a coverage-aware geometry provider when Korea and Ontario are configured', () => {
    const provider = createAdminRouteGeometryProvider({
      OSRM_BASE_URL: 'http://osrm-ontario:5000',
      OSRM_KOREA_BASE_URL: 'http://osrm-korea:5000',
      SHOPIFY_API_KEY: 'test-key',
      SHOPIFY_API_SECRET: 'test-secret',
    });

    expect(provider).toBeInstanceOf(CoverageAwareRouteGeometryProvider);
  });

  test('selects a coverage-aware geometry provider when only the Korea regional URL is explicit', () => {
    const provider = createAdminRouteGeometryProvider({
      OSRM_KOREA_BASE_URL: 'http://osrm-korea:5000',
      SHOPIFY_API_KEY: 'test-key',
      SHOPIFY_API_SECRET: 'test-secret',
    });

    expect(provider).toBeInstanceOf(CoverageAwareRouteGeometryProvider);
  });

  test('preserves the legacy single-coverage provider contract', () => {
    const provider = createAdminRouteGeometryProvider({
      OSRM_BASE_URL: 'http://osrm-ontario:5000',
      SHOPIFY_API_KEY: 'test-key',
      SHOPIFY_API_SECRET: 'test-secret',
    });

    expect(provider).toBeInstanceOf(OsrmRouteGeometryProvider);
  });
});
