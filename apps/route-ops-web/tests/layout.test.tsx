import { readFileSync } from 'node:fs';

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';

import { TabLayout } from '../src/components/TabLayout';
import { toTopbarNotificationItem } from '../src/App';
import { AppShell } from '../src/components/AppShell';
import {
  TopbarNotifications,
  countUnreadNotifications,
  type TopbarNotificationItem
} from '../src/components/TopbarNotifications';
import { OrdersPage } from '../src/pages/OrdersPage';
import {
  SettingsPage,
  buildSettingsSaveInput,
  getNextTemplateModalFocusIndex
} from '../src/pages/SettingsPage';
import { defaultRouteOpsUiSettings } from '../src/settingsUi';
import type {
  AdminNotificationDto,
  BootstrapPayload,
  StoreSettingsDto,
} from '../src/types';

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
    expect(html).toContain('aria-label="Open notifications"');
    expect(html).toContain('class="topbar-actions"');
  });

  test('TopbarNotifications renders an accessible empty dropdown shell', () => {
    const html = renderToStaticMarkup(<TopbarNotifications initialOpen />);

    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('class="notification-menu"');
    expect(html).toContain('Notifications');
    expect(html).toContain('No notifications yet.');
    expect(html).toContain('All caught up');
  });

  test('TopbarNotifications renders unread badges and critical route-change items', () => {
    const items: TopbarNotificationItem[] = [
      {
        body: 'Review route order and geometry.',
        createdAt: '2026-06-05T06:00:00.000Z',
        href: '/admin/ui/app/routes/route-1',
        id: 'address-change',
        read: false,
        title: 'Address changed in Woo for #1234 after it was added to Route A.',
        tone: 'critical'
      },
      {
        id: 'read-info',
        read: true,
        title: 'Sync completed',
        tone: 'success'
      }
    ];
    const html = renderToStaticMarkup(<TopbarNotifications initialOpen items={items} />);

    expect(countUnreadNotifications(items)).toBe(1);
    expect(html).toContain('class="notification-badge"');
    expect(html).toContain('1 unread');
    expect(html).toContain('notification-item--critical');
    expect(html).toContain('Address changed in Woo');
    expect(html).toContain('Review route order and geometry.');
    expect(html).toContain('dateTime="2026-06-05T06:00:00.000Z"');
    expect(html).not.toContain('disabled=""');
  });

  test('TopbarNotifications uses backend unread count when it exceeds the visible page', () => {
    const html = renderToStaticMarkup(
      <TopbarNotifications
        initialOpen
        items={[{ id: 'visible-read', read: true, title: 'Visible read', tone: 'info' }]}
        unreadCount={45}
      />
    );

    expect(html).toContain('45 unread');
    expect(html).toContain('class="notification-badge"');
  });

  test('TopbarNotifications surfaces notification load failures without claiming an empty inbox', () => {
    const html = renderToStaticMarkup(
      <TopbarNotifications
        initialOpen
        loadError="Notifications could not be loaded. Last known alerts are preserved. API unavailable"
      />
    );

    expect(html).toContain('notification-load-error');
    expect(html).toContain('Load failed');
    expect(html).toContain('Last known alerts are preserved');
    expect(html).not.toContain('No notifications yet.');
  });

  test('TopbarNotifications renders Korean copy', () => {
    const html = renderToStaticMarkup(<TopbarNotifications initialOpen locale="ko-KR" />);

    expect(html).toContain('aria-label="알림 열기"');
    expect(html).toContain('알림');
    expect(html).toContain('아직 알림이 없습니다.');
    expect(html).not.toContain('No notifications yet.');
  });

  test('Woo route-address notifications map to localized topbar copy', () => {
    const notification: AdminNotificationDto = {
      body: 'backend fallback',
      createdAt: '2026-06-05T07:00:00.000Z',
      href: '/admin/ui/app/routes/route-plan-id',
      id: 'notification-id',
      orderId: 'order-id',
      payload: { orderName: '#1035' },
      readAt: null,
      routePlanId: 'route-plan-id',
      severity: 'critical',
      title: 'backend title',
      type: 'WOO_ASSIGNED_ROUTE_ADDRESS_CHANGED'
    };

    expect(toTopbarNotificationItem(notification, 'en-CA')).toEqual(
      expect.objectContaining({
        body: '#1035 address changed in WooCommerce after route assignment. Review the route before dispatch.',
        href: '/admin/ui/app/routes/route-plan-id',
        read: false,
        title: 'Assigned route order address changed',
        tone: 'critical'
      })
    );
    expect(toTopbarNotificationItem(notification, 'ko-KR')).toEqual(
      expect.objectContaining({
        body: '#1035 주소가 경로 배정 후 WooCommerce에서 변경되었습니다. 출발 전 경로를 확인하세요.',
        title: '배정된 경로의 주문 주소 변경'
      })
    );
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

  test('Orders page secondary region is only a compact new route panel', () => {
    const html = renderToStaticMarkup(<OrdersPage bootstrap={bootstrap()} navigate={() => undefined} setError={() => undefined} />);
    expect(html).toContain('aria-label="New Route"');
    expect(html).toContain('<h2>New Route</h2>');
    expect(html).not.toContain('New route add plan');
    expect(html).not.toContain('route-plan-add-button');
    expect(html).toContain('Plan is empty.');
    expect(html).not.toContain('Use the map or order list');
    expect(html).not.toContain('Blocker editor');
    expect(html).not.toContain('Delivery metadata blockers');
  });

  test('Orders page removes route tabs and keeps only compact independent filters', () => {
    const html = renderToStaticMarkup(<OrdersPage bootstrap={bootstrap()} navigate={() => undefined} setError={() => undefined} />);
    expect(html).not.toContain('aria-label="Orders mode"');
    expect(html).not.toContain('>Planning</button>');
    expect(html).not.toContain('>History</button>');
    expect(html).not.toContain('aria-label="Order status tabs"');
    expect(html).not.toContain('>All</button>');
    expect(html).not.toContain('>Unplanned</button>');
    expect(html).not.toContain('>Planned</button>');
    expect(html).not.toContain('>Needs Review</button>');
    expect(html).not.toContain('ALL');
    expect(html).not.toContain('UNPLANNED');
    expect(html).not.toContain('PLANNED');
    expect(html).not.toContain('Planning orders');
    expect(html).not.toContain('History / all orders');
    expect(html).not.toContain('Orders map');
    expect(html).not.toContain('Imported WooCommerce stops by current filters');
    expect(html).not.toContain('Order filters');
    expect(html).toContain('Delivery date');
    expect(html).toContain('Weekday');
    expect(html).toContain('Type');
    expect(html).toContain('Area / region');
    expect(html).not.toContain('Delivery status');
    expect(html).not.toContain('Order health');
    expect(html).not.toContain('Service type');
    expect(html).not.toContain('Delivery session');
    expect(html).not.toContain('Clear filters');
    expect(html).toContain('Clear plan');
    expect(html).not.toContain('Search');
  });

  test('Orders page does not prefill the delivery date filter', () => {
    const html = renderToStaticMarkup(<OrdersPage bootstrap={bootstrap()} navigate={() => undefined} setError={() => undefined} />);

    expect(html).toContain('filter-field filter-field--date">Delivery date<span class="filter-control"><span class="order-date-picker"><button aria-expanded="false" class="order-date-picker-toggle" type="button">Date</button></span></span>');
  });

  test('Orders page renders Korean tabs filters and add-plan copy from locale', () => {
    const html = renderToStaticMarkup(<OrdersPage bootstrap={bootstrap('ko-KR')} navigate={() => undefined} setError={() => undefined} />);

    expect(html).toContain('aria-label="주문"');
    expect(html).not.toContain('주문 지도');
    expect(html).not.toContain('aria-label="주문 모드"');
    expect(html).not.toContain('>계획</button>');
    expect(html).not.toContain('>기록</button>');
    expect(html).not.toContain('aria-label="주문 상태 탭"');
    expect(html).not.toContain('>전체</button>');
    expect(html).not.toContain('>미배정</button>');
    expect(html).not.toContain('>배정됨</button>');
    expect(html).not.toContain('>리뷰 필요</button>');
    expect(html).not.toContain('주문 필터');
    expect(html).toContain('배송 날짜');
    expect(html).toContain('요일');
    expect(html).toContain('타입');
    expect(html).toContain('지역 / 구역');
    expect(html).not.toContain('배송 상태');
    expect(html).not.toContain('필터 초기화');
    expect(html).toContain('계획이 비어 있습니다.');
    expect(html).not.toContain('Orders mode');
    expect(html).not.toContain('Order filters');
    expect(html).not.toContain('Clear filters');
  });

  test('Orders CSS keeps the filter card responsive and prevents search overflow', () => {
    const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
    const filterPanelCss = extractCssRule(css, '.filter-panel');
    const orderDatePickerToggleCss = extractCssRule(css, '.order-date-picker-toggle');
    expect(css).toContain('grid-template-columns: repeat(auto-fit, minmax(min(100%, 8rem), 1fr));');
    expect(css).toContain('.filter-clear-x');
    expect(css).not.toContain('.filter-clear-button');
    expect(css).not.toContain('.filter-actions');
    expect(css).not.toContain('.filter-panel-header');
    expect(css).not.toContain('.route-plan-add-button');
    expect(css).toContain('max-width: 100%;');
    expect(filterPanelCss).toContain('overflow: visible;');
    expect(orderDatePickerToggleCss).toContain('height: 36px;');
    expect(orderDatePickerToggleCss).toContain('border: 1px solid #d9dee7;');
    expect(css).toContain('.orders-table-scroll');
    expect(css).toContain('.orders-compact-table th.orders-select-col');
    expect(css).toContain('.orders-compact-table td.orders-select-cell');
    expect(css).toContain('.orders-compact-table .orders-select-col input');
    expect(css).toContain('.orders-compact-table .orders-select-cell input');
    expect(css).toContain('text-align: center;');
    expect(css).toContain('height: 16px;');
    expect(css).toContain('margin: 0 auto;');
  });

  test('Route Builder detail CSS syncs map and card height while keeping stop order scroll-contained', () => {
    const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

    expect(css).toContain('--route-builder-detail-panel-height: clamp(620px, calc(100vh - 220px), 760px);');
    expect(css).toContain(`.route-builder-workspace .map-panel,
.route-save-panel {
  height: var(--route-builder-detail-panel-height);`);
    expect(css).toContain('.route-builder-workspace .route-ops-map-frame');
    expect(css).toContain('flex: 1 1 auto;');
    expect(css).toContain('.route-builder-card-shell');
    expect(css).toContain('overflow: hidden;');
    expect(css).toContain('.route-builder-tab-panel');
    expect(css).toContain('min-height: 0;');
    expect(css).toContain('.route-builder-tab-body--driver');
    expect(css).toContain('flex-direction: column;');
    expect(css).toContain('.route-builder-tab-body--driver .route-end-toggle');
    expect(css).toContain('margin-top: auto;');
    expect(css).toContain('.route-builder-card-footer');
    expect(css).toContain('border-top: 1px solid #e6eaf1;');
    expect(css).toContain('.route-builder-tab-body--stop-order');
    expect(css).toContain('grid-template-rows: auto minmax(0, 1fr);');
    expect(css).toContain('.route-stop-compact-toolbar');
    expect(css).toContain('.route-stop-count-badge');
    expect(css).toContain('white-space: nowrap;');
    expect(css).toContain('overscroll-behavior: contain;');
    expect(css).toContain('.route-stop-compact-row.drop-target');
    expect(css).toContain('.route-stop-compact-row.drop-before::before');
    expect(css).toContain('.route-stop-compact-row.drop-after::after');
    expect(css).toContain('@media (max-width: 980px)');
    expect(css).toContain(`.route-builder-workspace .route-ops-map-frame,
  .route-builder-workspace .route-ops-map-canvas,
  .route-builder-workspace .route-ops-map-frame svg`);
  });

  test('Route grouping CSS keeps assignment tokens circular and the split map tall', () => {
    const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

    expect(css).toContain('.route-group-map-panel .route-ops-map-frame');
    expect(css).toContain('min-height: 560px');
    expect(css).toContain('grid-template-columns: repeat(var(--route-group-area-columns, 1), minmax(24px, 1fr))');
    expect(css).toContain('.route-group-area-track::before');
    expect(css).toContain('right: 36px;');
    expect(css).toContain('aspect-ratio: 1 / 1');
    expect(css).toContain('width: 24px');
    expect(css).toContain('.route-group-area-finish');
  });

  test('Topbar notification CSS exposes the dropdown badge and tone classes', () => {
    const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

    expect(css).toContain('.notification-button');
    expect(css).toContain('.notification-badge');
    expect(css).toContain('.notification-menu');
    expect(css).toContain('.notification-item--critical');
    expect(css).toContain('position: absolute;');
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

  test('Settings page separates store and language settings without a geocode save action', () => {
    const html = renderToStaticMarkup(<SettingsPage bootstrap={bootstrap()} setError={() => undefined} />);
    expect(html).toContain('data-settings-layout="category-sections"');
    expect(html).not.toContain('Geocode &amp; save coordinates');
    expect(html).toContain('Store settings');
    expect(html).not.toContain('Language selection');
    expect(html).toContain('Stop dwell minutes');
    expect(html).toContain('Customer email notification settings');
    expect(html).toContain('Add reminder');
    expect(html).toContain('Edit template');
    expect(html).not.toContain('{{deliveryDate}}');
    expect(html).toContain('English');
    expect(html).toContain('한국어');
    expect(html).not.toContain('Service and session values');
    expect(html).not.toContain('route-scope-config-block');
    expect(html).not.toContain('EVENING_DELIVERY');
    expect(html).not.toContain('EVENING');
    expect(html).not.toContain('17:00');
    expect(html).not.toContain('Time window');
    expect(html).not.toContain('Français');
  });

  test('Settings page renders Korean page copy and provider labels', () => {
    const html = renderToStaticMarkup(<SettingsPage bootstrap={bootstrap('ko-KR')} setError={() => undefined} />);

    expect(html).toContain('매장 설정');
    expect(html).toContain('매장 주소');
    expect(html).not.toContain('주소로 좌표 저장');
    expect(html).not.toContain('언어 선택');
    expect(html).toContain('배송지 체류 시간');
    expect(html).toContain('고객 이메일 알림 설정');
    expect(html).not.toContain('서비스/세션 값');
    expect(html).not.toContain('서비스 타입');
    expect(html).not.toContain('배송 세션');
    expect(html).toContain('지도/경로 상태');
    expect(html).toContain('설정 안 됨');
    expect(html).not.toContain('Store settings');
    expect(html).not.toContain('Geocode &amp; save coordinates');
  });

  test('Settings CSS keeps responsive settings workspace rules', () => {
    const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
    const inlineCheckCss = extractCssRule(css, '.settings-inline-check');
    const inlineCheckSpanCss = extractCssRule(css, '.settings-inline-check span');
    const settingsSelectCss = extractCssRule(css, '.settings-field select');

    expect(css).toContain('.settings-workspace');
    expect(css).toContain('.ops-shell--settings');
    expect(css).toContain('.ops-shell--orders');
    expect(css).toContain('grid-template-columns: repeat(auto-fit, minmax(min(100%, 160px), 1fr));');
    expect(css).toContain('@media (max-width: 720px)');
    expect(css).toContain('.settings-modal-backdrop');
    expect(css).toContain('.settings-template-summary-card');
    expect(inlineCheckCss).toContain('display: grid;');
    expect(inlineCheckCss).toContain('grid-template-columns: auto minmax(0, 1fr);');
    expect(inlineCheckCss).toContain('width: 100%;');
    expect(inlineCheckCss).not.toContain('inline-flex');
    expect(inlineCheckSpanCss).toContain('overflow-wrap: anywhere;');
    expect(css).toContain('min-height: 42px;');
    expect(css).toContain('font-size: 14px;');
    expect(css).toContain('font-weight: 800;');
    expect(settingsSelectCss).toContain('appearance: none;');
    expect(settingsSelectCss).toContain('padding-right: 36px;');
    expect(css).not.toContain('minmax(120px, 0.9fr) minmax(120px, 1fr) minmax(140px, 1.2fr) minmax(140px, 1.2fr) minmax(90px, 0.5fr) auto');
  });

  test('Settings template modal focus wrap stays inside the modal controls', () => {
    expect(
      getNextTemplateModalFocusIndex({
        currentIndex: 0,
        focusableCount: 5,
        shiftKey: true
      })
    ).toBe(4);
    expect(
      getNextTemplateModalFocusIndex({
        currentIndex: 4,
        focusableCount: 5,
        shiftKey: false
      })
    ).toBe(0);
    expect(
      getNextTemplateModalFocusIndex({
        currentIndex: 2,
        focusableCount: 5,
        shiftKey: false
      })
    ).toBeNull();
    expect(
      getNextTemplateModalFocusIndex({
        currentIndex: -1,
        focusableCount: 5,
        shiftKey: false
      })
    ).toBeNull();
  });

  test('Settings save payload omits route-scope config management state', () => {
    const draft: StoreSettingsDto = {
      defaultDepotAddress: '123 Depot St',
      defaultDepotLatitude: 43.6532,
      defaultDepotLongitude: -79.3832,
      locale: 'ko-KR',
      routeOpsUiSettings: {
        ...defaultRouteOpsUiSettings(),
        destinationDwellMinutes: 12,
        emailNotifications: {
          ...defaultRouteOpsUiSettings().emailNotifications,
          template: { body: 'Delivery on {{deliveryDate}}', subject: 'Order {{orderNumber}}' }
        }
      },
      routeScopeConfig: {
        deliverySessions: [],
        serviceTypes: [],
        timeWindow: {
          endExample: '21:00',
          helpText: 'Use HH:MM',
          startExample: '17:00'
        },
        version: 1
      },
      shopDomain: 'tenant.example.test'
    };
    expect(buildSettingsSaveInput({ csrfToken: 'csrf', draft })).toEqual(
      expect.objectContaining({
        csrfToken: 'csrf',
        locale: 'ko-KR',
        routeOpsUiSettings: expect.objectContaining({ destinationDwellMinutes: 12 })
      })
    );
    expect(buildSettingsSaveInput({ csrfToken: 'csrf', draft })).not.toHaveProperty('routeScopeConfig');
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
    driverApp: { installUrl: 'https://clever-route.cleversystem.ai/driver-app' },
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
