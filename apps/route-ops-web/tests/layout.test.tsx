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

  test('AppShell renders Korean navigation and store labels when locale is ko-KR', () => {
    const html = renderToStaticMarkup(
      <AppShell
        activePage="orders"
        bootstrap={bootstrap('ko-KR')}
        error={null}
        navItems={[
          { label: '대시보드', page: 'dashboard', path: '/admin/ui/app/dashboard' },
          { label: '주문', page: 'orders', path: '/admin/ui/app/orders' },
          { label: '경로', page: 'routes', path: '/admin/ui/app/routes' },
          { label: '배송원 및 차량', page: 'drivers', path: '/admin/ui/app/drivers' },
          { label: '설정', page: 'settings', path: '/admin/ui/app/settings' },
        ]}
        navigate={() => undefined}
        title="주문"
      >
        <div>본문</div>
      </AppShell>
    );

    expect(html).toContain('aria-label="운영 메뉴"');
    expect(html).toContain('>주문</button>');
    expect(html).toContain('>배송원 및 차량</button>');
    expect(html).toContain('<span class="store-label">매장</span>');
    expect(html).toContain('<h1>주문</h1>');
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
    expect(html).toContain('aria-label="Orders mode"');
    expect(html).toContain('>Planning</button>');
    expect(html).toContain('>History</button>');
    expect(html).toContain('aria-label="Order status tabs"');
    expect(html).toContain('All');
    expect(html).toContain('Unplanned');
    expect(html).toContain('Planned');
    expect(html).toContain('Needs Review');
    expect(html).not.toContain('ALL');
    expect(html).not.toContain('UNPLANNED');
    expect(html).not.toContain('PLANNED');
    expect(html).not.toContain('Planning orders');
    expect(html).not.toContain('History / all orders');
    expect(html).toContain('Order filters');
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

  test('Orders page renders Korean tabs filters and add-plan copy from locale', () => {
    const html = renderToStaticMarkup(<OrdersPage bootstrap={bootstrap('ko-KR')} navigate={() => undefined} setError={() => undefined} />);

    expect(html).toContain('aria-label="주문"');
    expect(html).toContain('주문 지도');
    expect(html).toContain('aria-label="주문 모드"');
    expect(html).toContain('>계획</button>');
    expect(html).toContain('>기록</button>');
    expect(html).toContain('aria-label="주문 상태 탭"');
    expect(html).toContain('>전체</button>');
    expect(html).toContain('>미배정</button>');
    expect(html).toContain('>배정됨</button>');
    expect(html).toContain('>리뷰 필요</button>');
    expect(html).toContain('주문 필터');
    expect(html).toContain('배송 날짜');
    expect(html).toContain('지역 / 구역');
    expect(html).toContain('배송 상태');
    expect(html).toContain('필터 초기화');
    expect(html).toContain('계획이 비어 있습니다.');
    expect(html).not.toContain('Orders mode');
    expect(html).not.toContain('Order filters');
    expect(html).not.toContain('Clear filters');
  });

  test('Orders CSS keeps the filter card responsive and prevents search overflow', () => {
    const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
    expect(css).toContain('grid-template-columns: repeat(auto-fit, minmax(min(100%, 9.5rem), 1fr));');
    expect(css).toContain('.filter-panel-header');
    expect(css).not.toContain('.filter-actions');
    expect(css).toContain('max-width: 100%;');
    expect(css).toContain('.orders-table-scroll');
  });

  test('Drivers CSS keeps invite actions stable inside the horizontally scrolling table', () => {
    const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
    const driverTableCss = extractCssRule(css, '.driver-table');
    const driverInviteColumnCss = extractCssRule(css, '.driver-table .driver-invite-action-column');
    const driverInviteActionsCss = extractCssRule(css, '.driver-invite-actions');
    const driverInviteMetaCss = extractCssRule(css, '.driver-invite-meta');
    const driverInviteControlsCss = extractCssRule(css, '.driver-invite-controls');
    const driverInviteButtonCss = extractCssRule(css, '.driver-invite-controls button');

    expect(css).toContain('overflow-x: auto;');
    expect(driverTableCss).toContain('min-width: 980px;');
    expect(driverInviteColumnCss).toContain('min-width: 360px;');
    expect(driverInviteActionsCss).toContain('min-width: 360px;');
    expect(driverInviteActionsCss).not.toContain('min(100%, 360px)');
    expect(driverInviteMetaCss).toContain('white-space: nowrap;');
    expect(driverInviteControlsCss).toContain('flex-wrap: nowrap;');
    expect(driverInviteControlsCss).toContain('white-space: nowrap;');
    expect(driverInviteButtonCss).toContain('flex: 0 0 auto;');
    expect(driverInviteButtonCss).toContain('white-space: nowrap;');
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

  test('Settings page renders Korean page copy and provider labels', () => {
    const html = renderToStaticMarkup(<SettingsPage bootstrap={bootstrap('ko-KR')} setError={() => undefined} />);

    expect(html).toContain('매장 설정');
    expect(html).toContain('매장 주소');
    expect(html).toContain('주소로 좌표 저장');
    expect(html).toContain('서비스/세션 값');
    expect(html).toContain('서비스 타입');
    expect(html).toContain('배송 세션');
    expect(html).toContain('지도/경로 상태');
    expect(html).toContain('설정 안 됨');
    expect(html).not.toContain('Store settings');
    expect(html).not.toContain('Geocode &amp; save coordinates');
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

function extractCssRule(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = css.indexOf('}', start);
  expect(end).toBeGreaterThan(start);
  return css.slice(start, end + 1);
}

function bootstrap(locale?: BootstrapPayload['locale']): BootstrapPayload {
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
    locale,
    routerConfig: { status: 'not_configured' },
    shopDomain: 'dev1.tomatonofood.com'
  };
}
