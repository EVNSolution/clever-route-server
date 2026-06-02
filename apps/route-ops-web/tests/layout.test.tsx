import { readFileSync } from 'node:fs';

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';

import { TabLayout } from '../src/components/TabLayout';
import { AppShell } from '../src/components/AppShell';
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

  test('AppShell exposes the active page as a scoped shell class', () => {
    const html = renderToStaticMarkup(
      <AppShell
        activePage="settings"
        bootstrap={bootstrap()}
        error={null}
        navItems={[{ label: 'Settings', page: 'settings', path: '/admin/ui/app/settings' }]}
        navigate={() => undefined}
        title="Settings"
      >
        <div>Settings body</div>
      </AppShell>
    );
    expect(html).toContain('ops-shell--settings');
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
    expect(html).toContain('All');
    expect(html).toContain('Unplanned');
    expect(html).toContain('Planned');
    expect(html).toContain('Needs Review');
    expect(html).not.toContain('ALL');
    expect(html).not.toContain('UNPLANNED');
    expect(html).not.toContain('PLANNED');
    expect(html).toContain('Planning orders');
    expect(html).toContain('History / all orders');
    expect(html).toContain('Delivery date');
    expect(html).toContain('Area / region');
    expect(html).toContain('Delivery status');
    expect(html).toContain('Order health');
    expect(html).toContain('Service type');
    expect(html).toContain('Delivery session');
    expect(html).toContain('Evening Delivery');
    expect(html).toContain('Clear filters');
    expect(html).toContain('Clear plan');
    expect(html).toContain('Search');
  });

  test('Orders CSS keeps the filter card responsive and prevents search overflow', () => {
    const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
    expect(css).toContain('grid-template-columns: repeat(auto-fit, minmax(min(100%, 9.5rem), 1fr));');
    expect(css).toContain('.filter-actions');
    expect(css).toContain('max-width: 100%;');
    expect(css).toContain('.orders-table-scroll');
  });

  test('Settings page exposes only English and Korean locale options with geocode action', () => {
    const html = renderToStaticMarkup(<SettingsPage bootstrap={bootstrap()} setError={() => undefined} />);
    expect(html).toContain('data-settings-layout="category-sections"');
    expect(html).toContain('Geocode &amp; save coordinates');
    expect(html).toContain('English');
    expect(html).toContain('한국어');
    expect(html).toContain('Service and session values');
    expect(html).toContain('route-scope-config-block');
    expect(html).toContain('EVENING_DELIVERY');
    expect(html).toContain('EVENING');
    expect(html).not.toContain('17:00');
    expect(html).not.toContain('Time window');
    expect(html).not.toContain('Français');
  });

  test('Settings CSS uses responsive route value rows instead of the old fixed six-column grid', () => {
    const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
    expect(css).toContain('.settings-workspace');
    expect(css).toContain('.ops-shell--settings');
    expect(css).toContain('.ops-shell--orders');
    expect(css).toContain('grid-template-columns: repeat(auto-fit, minmax(min(100%, 160px), 1fr));');
    expect(css).toContain('font-size: 12px;');
    expect(css).toContain('@media (max-width: 720px)');
    expect(css).not.toContain('minmax(120px, 0.9fr) minmax(120px, 1fr) minmax(140px, 1.2fr) minmax(140px, 1.2fr) minmax(90px, 0.5fr) auto');
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
