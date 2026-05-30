import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';

import { TabLayout } from '../src/components/TabLayout';
import { OrdersPage } from '../src/pages/OrdersPage';
import {
  SettingsPage,
  addRouteScopeValue,
  buildSettingsSaveInput,
  removeRouteScopeValue,
  updateRouteScopeValue
} from '../src/pages/SettingsPage';
import { defaultRouteScopeConfig } from '../src/routeScopeConfig';
import type { BootstrapPayload, StoreSettingsDto } from '../src/types';

describe('route ops layout components', () => {
  test('TabLayout renders primary secondary and lower regions', () => {
    const html = renderToStaticMarkup(<TabLayout title="Orders" primary={<div>Map</div>} secondary={<div>Tray</div>} lower={<div>Table</div>} />);
    expect(html).toContain('data-tab-region="primary"');
    expect(html).toContain('data-tab-region="secondary"');
    expect(html).toContain('data-tab-region="lower"');
  });

  test('primaryExpanded hides secondary and uses the expanded class', () => {
    const html = renderToStaticMarkup(<TabLayout title="Orders" primary={<div>Map</div>} secondary={<div>Tray</div>} primaryExpanded />);
    expect(html).toContain('primary-expanded');
    expect(html).toContain('hidden=""');
  });

  test('Orders page secondary region is only a compact add plan panel', () => {
    const html = renderToStaticMarkup(<OrdersPage bootstrap={bootstrap()} navigate={() => undefined} setError={() => undefined} />);
    expect(html).toContain('aria-label="New route add plan"');
    expect(html).toContain('Add plan');
    expect(html).toContain('Plan is empty.');
    expect(html).not.toContain('Blocker editor');
    expect(html).not.toContain('Delivery metadata blockers');
  });

  test('Orders page keeps route tabs and filter controls before the table region', () => {
    const html = renderToStaticMarkup(<OrdersPage bootstrap={bootstrap()} navigate={() => undefined} setError={() => undefined} />);
    expect(html).toContain('ALL');
    expect(html).toContain('UNPLANNED');
    expect(html).toContain('PLANNED');
    expect(html).toContain('Needs Review');
    expect(html).toContain('Delivery date');
    expect(html).toContain('Area / region');
    expect(html).toContain('Delivery status');
    expect(html).toContain('Order health');
    expect(html).toContain('Search');
  });

  test('Settings page exposes only English and Korean locale options with geocode action', () => {
    const html = renderToStaticMarkup(<SettingsPage bootstrap={bootstrap()} setError={() => undefined} />);
    expect(html).toContain('Geocode &amp; save coordinates');
    expect(html).toContain('English');
    expect(html).toContain('한국어');
    expect(html).toContain('Service and session values');
    expect(html).toContain('EVENING_DELIVERY');
    expect(html).toContain('EVENING');
    expect(html).toContain('17:00');
    expect(html).not.toContain('Français');
  });

  test('Settings route-scope helpers add edit remove values and build the save payload', () => {
    const baseConfig = defaultRouteScopeConfig();
    const withCustomService = addRouteScopeValue(baseConfig, 'serviceTypes');
    expect(withCustomService.serviceTypes.at(-1)).toEqual(expect.objectContaining({
      builtIn: false,
      enabled: true,
      value: 'CUSTOM_SERVICE_1'
    }));

    const edited = updateRouteScopeValue(
      withCustomService,
      'serviceTypes',
      withCustomService.serviceTypes.length - 1,
      { description: 'Morning routes', enabled: false, label: 'Morning', value: 'MORNING_DELIVERY' }
    );
    expect(edited.serviceTypes.at(-1)).toEqual(expect.objectContaining({
      description: 'Morning routes',
      enabled: false,
      label: 'Morning',
      value: 'MORNING_DELIVERY'
    }));

    const removed = removeRouteScopeValue(edited, 'serviceTypes', edited.serviceTypes.length - 1);
    expect(removed.serviceTypes).toHaveLength(baseConfig.serviceTypes.length);

    const draft: StoreSettingsDto = {
      defaultDepotAddress: '123 Depot St',
      defaultDepotLatitude: 43.6532,
      defaultDepotLongitude: -79.3832,
      locale: 'ko-KR',
      routeScopeConfig: edited,
      shopDomain: 'tenant.example.test'
    };
    expect(buildSettingsSaveInput({ csrfToken: 'csrf', draft, routeScopeConfig: edited })).toEqual(
      expect.objectContaining({
        csrfToken: 'csrf',
        locale: 'ko-KR',
        routeScopeConfig: edited
      })
    );
  });
});

function bootstrap(): BootstrapPayload {
  return {
    appUrls: {
      dashboard: '/admin/ui/app',
      drivers: '/admin/ui/app/drivers',
      orders: '/admin/ui/app/orders',
      routes: '/admin/ui/app/routes',
      settings: '/admin/ui/app/settings'
    },
    csrfToken: 'test-csrf',
    mapConfig: {
      allowedHosts: [],
      attribution: null,
      providerMode: null,
      status: 'not_configured',
      styleAudit: null,
      styleUrl: null
    },
    mode: 'internal-admin',
    routerConfig: { status: 'not_configured' },
    shopDomain: 'dev1.tomatonofood.com'
  };
}
