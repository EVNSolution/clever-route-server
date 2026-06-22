import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  ApiError,
  createRouteOptimizationJob,
  deleteDriver,
  generateRouteGroupingChildRoutes,
  getLatestRouteOptimizationJob,
  getNotifications,
  getRouteOptimizationJob,
  openNotificationChangeStream,
  markNotificationRead,
  publishRoute,
  regenerateDriverInviteCode,
  saveRoute,
} from '../src/api';
import {
  DriverTable,
  DriversPage,
  buildCountrySearchOption,
  buildDriverInviteMessage,
  filterCountrySearchOptions,
  formatDriverAuthLabel,
  matchCountrySearchInput,
} from '../src/pages/DriversPage';
import {
  buildRouteSaveDraftInput,
  getChildRouteSequenceColor,
  getDriverOptionLabel,
  getRouteDriverDisplay,
  getRoutePublishBadge,
  formatRouteChildDriverName,
  formatRouteChildStopTitle,
  formatRoutePlanNameForDisplay,
  formatRoutePlanStatus,
  getRouteStopSequenceDisplay,
  hasDepotCoordinates,
  isRouteVisibleToLinkedDriver,
  RouteBuilder,
  RouteListTable,
  RouteStopOrderCompactList,
  shouldTryRouteGroupFallback,
} from '../src/pages/RoutesPage';
import { getRoutesCopy } from '../src/i18n';
import type {
  BootstrapPayload,
  DriverDto,
  RouteGroupingSummaryDto,
  RouteOptimizationJobDto,
  RoutePlanDetailDto,
  RoutePlanSummaryDto,
} from '../src/types';

describe('Route Ops driver invite and route assignment UI helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test('renders pending invite codes and linked app access without exposing raw auth subjects', () => {
    const html = renderToStaticMarkup(
      <DriverTable drivers={[driverFixture(), linkedDriverFixture()]} />,
    );
    const tableHeaderHtml = extractFirstMatch(html, /<thead>([\s\S]*?)<\/thead>/);
    const inviteCellHtml = extractFirstMatch(html, /<td class="driver-invite-action-column"><div class="driver-invite-actions">([\s\S]*?)<\/div><\/td>/);

    expect(tableHeaderHtml).toContain('Driver');
    expect(tableHeaderHtml).toContain('Phone');
    expect(tableHeaderHtml).toContain('Status');
    expect(tableHeaderHtml).toContain('App access');
    expect(tableHeaderHtml).toContain('Invite code / action');
    expect(tableHeaderHtml).toContain('class="driver-invite-action-column"');
    expect(tableHeaderHtml).not.toContain('Last seen / joined');
    expect(tableHeaderHtml).not.toContain('Recent events');
    expect(html).toContain('A1B2C3');
    expect(inviteCellHtml).toContain('copy');
    expect(inviteCellHtml).toContain('re-login');
    expect(inviteCellHtml).toContain('delete');
    expect(html).toContain('<small>Linked</small>');
    expect(html).toContain('<span class="badge">Active</span>');
    expect(html).toContain('<span class="status-pill ok">Linked</span>');
    expect(html).toContain('<span class="status-pill warn">Invite pending</span>');
    expect(html).toContain('No active code');
    expect(html).toContain('No expiry');
    expect(html).not.toContain('Copy invite');
    expect(html).not.toContain('Re-login code');
    expect(html).not.toContain('Regenerate');
    expect(html).not.toContain('Delete');
    expect(html).not.toContain('App linked');
    expect(html).not.toContain('Not seen yet');
    expect(html).not.toContain('Joined');
    expect(html).not.toContain('authSubject');
    expect(html).not.toContain('refreshToken');

    expect(html.match(/class="driver-invite-actions"/g)).toHaveLength(2);
    expect(html.match(/class="driver-invite-meta-stack"/g)).toHaveLength(2);
    expect(html.match(/class="driver-invite-meta"/g)).toHaveLength(4);
    expect(html.match(/class="driver-invite-controls"/g)).toHaveLength(2);
    expect(inviteCellHtml).toMatch(/<div class="driver-invite-controls"><button[^>]*>copy<\/button><button[^>]*>re-login<\/button><button class="danger subtle"[^>]*>delete<\/button><\/div>/);
  });

  test('drivers page KPI shortens linked app copy', () => {
    const html = renderToStaticMarkup(
      <DriversPage bootstrap={bootstrap()} setError={() => undefined} />,
    );
    const driverKpisHtml = extractFirstMatch(html, /<div class="summary-strip compact-kpis driver-kpis"[\s\S]*?>([\s\S]*?)<\/div><p class="empty-state"/);

    expect(driverKpisHtml).toContain('<span>Linked</span>');
    expect(driverKpisHtml).not.toContain('App linked');
  });

  test('driver create form uses a searchable country combobox without placeholders', () => {
    const html = renderToStaticMarkup(
      <DriversPage bootstrap={bootstrap()} setError={() => undefined} />,
    );

    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-label="Search country"');
    expect(html).toContain('value="United States (US +1)"');
    expect(html).not.toContain('<select');
    expect(html).not.toContain('placeholder=');
    expect(html).not.toContain('Enter a valid number in national format to preview E.164.');
    expect(html).not.toContain('Pending drivers can be assigned in Route Builder now.');
  });

  test('country phone input helpers support searchable country names codes and calling prefixes', () => {
    const options = [
      buildCountrySearchOption('CA'),
      buildCountrySearchOption('KR'),
      buildCountrySearchOption('US'),
    ];

    expect(filterCountrySearchOptions(options, 'korea').map((option) => option.countryCode)).toEqual(['KR']);
    expect(filterCountrySearchOptions(options, 'kr').map((option) => option.countryCode)).toEqual(['KR']);
    expect(filterCountrySearchOptions(options, '+82').map((option) => option.countryCode)).toEqual(['KR']);
    expect(filterCountrySearchOptions(options, '+1').map((option) => option.countryCode)).toEqual(['CA', 'US']);
    expect(matchCountrySearchInput(options, 'Canada')?.countryCode).toBe('CA');
    expect(matchCountrySearchInput(options, 'US')?.countryCode).toBe('US');
  });

  test('builds copyable invite text from the app install link and current code', () => {
    expect(
      buildDriverInviteMessage(
        driverFixture(),
        'en-CA',
        'https://clever-route.cleversystem.ai/driver-app',
      ),
    ).toBe('Install CLEVER Driver:\nhttps://clever-route.cleversystem.ai/driver-app\n\nAuthentication code: A1B2C3');
    expect(buildDriverInviteMessage(driverFixture())).toBe('Authentication code: A1B2C3');
    expect(formatDriverAuthLabel(driverFixture())).toBe('Invite pending');
    expect(formatDriverAuthLabel(linkedDriverFixture())).toBe('Linked');
    expect(
      buildDriverInviteMessage(
        driverFixture(),
        'ko-KR',
        'https://clever-route.cleversystem.ai/driver-app',
      ),
    ).toBe('CLEVER Driver 앱 설치:\nhttps://clever-route.cleversystem.ai/driver-app\n\n인증 코드: A1B2C3');
    expect(formatDriverAuthLabel(driverFixture(), 'ko-KR')).toBe('초대 대기');
    expect(formatDriverAuthLabel(linkedDriverFixture(), 'ko-KR')).toBe('연결됨');
  });

  test('labels route assignment drivers by name only', () => {
    const pending = driverFixture();
    const linked = linkedDriverFixture();
    const route = routePlanFixture({ driverId: pending.id });

    expect(getDriverOptionLabel(pending)).toBe('Alex Driver');
    expect(getDriverOptionLabel(linked)).toBe('Minji Driver');
    expect(getRouteDriverDisplay(route, [pending, linked])).toBe('Alex Driver');
    expect(getRouteDriverDisplay(routePlanFixture({ driverId: null }), [pending])).toBe(
      'Unassigned',
    );
    expect(getRouteDriverDisplay(routePlanFixture({ driverId: 'unknown-driver' }), [pending])).toBe(
      'unknown-driver',
    );
    expect(getDriverOptionLabel(pending, 'ko-KR')).toBe('Alex Driver');
    expect(getDriverOptionLabel(linked, 'ko-KR')).toBe('Minji Driver');
    expect(getRouteDriverDisplay(routePlanFixture({ driverId: null }), [pending], 'ko-KR')).toBe(
      '미배정',
    );
    expect(formatRoutePlanStatus('DRAFT', 'ko-KR')).toBe('초안');
    expect(formatRoutePlanStatus('ASSIGNED', 'ko-KR')).toBe('배정됨');
  });


  test('falls back from a missing legacy route plan only for 404 route-plan misses', () => {
    expect(shouldTryRouteGroupFallback(new ApiError('Route plan not found', 404, 'NOT_FOUND'))).toBe(true);
    expect(shouldTryRouteGroupFallback(new ApiError('Forbidden', 403, 'FORBIDDEN'))).toBe(false);
    expect(shouldTryRouteGroupFallback(new Error('network failed'))).toBe(false);
  });

  test('routes list renders driver split groups as parent rows with nested child routes', () => {
    const childRoute = routePlanFixture({
      id: 'child-route-id',
      name: 'Route 2026-06-19 — Alex Driver v1',
      stopsCount: 5,
    });
    const routeGroups: RouteGroupingSummaryDto[] = [
      routeGroupingFixture({
        children: [
          {
            childVersion: 1,
            displayStatus: 'DRAFT',
            driverId: 'driver-pending',
            driverName: 'Alex Driver',
            notificationStatus: 'NOT_REQUIRED',
            routePlan: childRoute,
            routePlanId: childRoute.id,
            stopsCount: 5,
          },
        ],
      }),
    ];
    const html = renderToStaticMarkup(
      <RouteListTable
        deletingRouteId={null}
        drivers={[driverFixture()]}
        navigate={() => undefined}
        onDeleteRoute={() => undefined}
        routeGroups={routeGroups}
        routes={[]}
      />,
    );

    expect(html).toContain('class="route-group-row route-group-parent-row"');
    expect(html).toContain('Route 2026-06-19');
    expect(html).toContain('<th>Split</th>');
    expect(html).not.toContain('<th>Driver</th>');
    expect(html).toContain('aria-label="Toggle child routes"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('class="route-group-child-row"');
    expect(html).toContain('<span class="route-tree-title">Alex Driver</span>');
    expect(html).not.toContain('<td>Alex Driver</td>');
    expect(html.match(/<button type="button">Open<\/button>/g)).toHaveLength(2);
    expect(html).not.toContain('Parent workbench');
    expect(html).not.toContain('Child 1');
    expect(html).not.toContain('Route 2026-06-19 - Alex');
    expect(html).not.toContain('Route 2026-06-19 — Alex Driver v1');
    expect(html).not.toContain('NOT_REQUIRED');
    expect(html).not.toContain('Stop order');
  });

  test('routes list can collapse a driver split parent without rendering child rows', () => {
    const childRoute = routePlanFixture({
      id: 'child-route-id',
      name: 'Route 2026-06-19 — Alex Driver v1',
      stopsCount: 5,
    });
    const html = renderToStaticMarkup(
      <RouteListTable
        collapsedRouteGroupIds={new Set(['group-id'])}
        deletingRouteId={null}
        drivers={[driverFixture()]}
        navigate={() => undefined}
        onDeleteRoute={() => undefined}
        routeGroups={[
          routeGroupingFixture({
            children: [
              {
                childVersion: 1,
                displayStatus: 'DRAFT',
                driverId: 'driver-pending',
                driverName: 'Alex Driver',
                notificationStatus: 'NOT_REQUIRED',
                routePlan: childRoute,
                routePlanId: childRoute.id,
                stopsCount: 5,
              },
            ],
          }),
        ]}
        routes={[]}
      />,
    );

    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('Route 2026-06-19');
    expect(html).not.toContain('<span class="route-tree-title">Alex Driver</span>');
    expect(html).not.toContain('class="route-group-child-row"');
  });

  test('formats child route rows with the full driver name only', () => {
    expect(
      formatRouteChildDriverName({
        driverName: 'Alex Driver',
        routePlan: routePlanFixture({ name: 'Route 2026-06-21 — Alex Driver v1' }),
      }),
    ).toBe('Alex Driver');
    expect(
      formatRouteChildDriverName({ driverName: 'Minji Lee', routePlan: null }),
    ).toBe('Minji Lee');
  });

  test('hides generated child route version suffixes in route detail titles', () => {
    expect(formatRoutePlanNameForDisplay('Route 2026-06-19 — Jamie Test v1')).toBe('Route 2026-06-19 — Jamie Test');
    expect(formatRoutePlanNameForDisplay('Route 2026-06-19 — Jamie Test')).toBe('Route 2026-06-19 — Jamie Test');
  });

  test('hides child driver suffixes in child route stop titles', () => {
    expect(formatRouteChildStopTitle('Route 2026-06-19 — 임 지인 v1')).toBe('Route 2026-06-19');
    expect(formatRouteChildStopTitle('Route 2026-06-19 — Jamie Test')).toBe('Route 2026-06-19');
    expect(formatRouteChildStopTitle('Route 2026-06-19')).toBe('Route 2026-06-19');
  });

  test('keeps child route sequence strip labels tied to the saved stop order while draft order changes', () => {
    const savedLabels = new Map([
      ['stop-1', 1],
      ['stop-2', 2],
      ['stop-3', 3],
    ]);

    expect(getRouteStopSequenceDisplay({ deliveryStopId: 'stop-2', sequence: 1 }, savedLabels)).toBe(2);
    expect(getRouteStopSequenceDisplay({ deliveryStopId: 'stop-1', sequence: 2 }, savedLabels)).toBe(1);
    expect(getRouteStopSequenceDisplay({ deliveryStopId: 'stop-4', sequence: 4 }, savedLabels)).toBe(4);
  });

  test('uses black child sequence rails until the child route is being edited', () => {
    expect(getChildRouteSequenceColor(false)).toBe('#111827');
    expect(getChildRouteSequenceColor(true)).toBe('#2563eb');
  });

  test('localizes the exposed return-to-store Route Builder option', () => {
    expect(getRoutesCopy('en-CA').returnToStore).toBe('Return to store');
    expect(getRoutesCopy('ko-KR').returnToStore).toBe('매장으로 돌아오기');
  });

  test('summarizes draft and published route state for the map badge', () => {
    const pending = driverFixture();
    const linked = linkedDriverFixture();
    const draftAssigned = routePlanFixture({ driverId: linked.id, status: 'DRAFT' });
    const publishedLinked = routePlanFixture({ driverId: linked.id, status: 'ASSIGNED' });
    const publishedPending = routePlanFixture({ driverId: pending.id, status: 'ASSIGNED' });

    expect(isRouteVisibleToLinkedDriver(draftAssigned, [linked])).toBe(false);
    expect(getRoutePublishBadge(draftAssigned)?.text).toBe('Draft');
    expect(isRouteVisibleToLinkedDriver(publishedLinked, [linked])).toBe(true);
    expect(getRoutePublishBadge(publishedLinked)?.text).toBe('Published');
    expect(isRouteVisibleToLinkedDriver(publishedPending, [pending])).toBe(false);
    expect(getRoutePublishBadge(publishedPending)?.text).toBe('Published');
    expect(getRoutePublishBadge(publishedLinked, 'ko-KR')?.text).toBe('게시됨');
  });

  test('renders assigned past route geometry while unchanged edit controls stay disabled', () => {
    const linked = linkedDriverFixture();
    const detail = routePlanDetailFixture({
      routeGeometry: { coordinates: [[-79.5, 43.7], [-79.4, 43.65]], type: 'LineString' },
      routePlan: routePlanFixture({
        deliveryDate: '2026-05-30',
        driverId: linked.id,
        planDate: '2026-05-30',
        status: 'ASSIGNED',
      }),
    });

    const html = renderToStaticMarkup(
      <RouteBuilder
        isChildRouteDetail
        bootstrap={bootstrap({
          routerConfig: { coverage: 'ontario', provider: 'osrm', status: 'configured' },
        })}
        deletingRouteId={null}
        detail={detail}
        drivers={[linked]}
        navigate={() => undefined}
        onDeleteRoute={() => undefined}
        onRefreshRoutes={() => undefined}
        setDetail={() => undefined}
        setError={() => undefined}
      />,
    );

    expect(html).not.toContain('Road path ready');
    expect(html).toContain('class="route-visibility-button green" disabled="" type="button">Visible to driver</button>');
    expect(html).not.toContain('Published route — visible to the linked driver after the app refreshes.');
    expect(html).not.toContain('Driver app visible');
    expect(html).toMatch(/aria-label="Save route"[^>]*disabled=""/);
    expect(html).toContain('class="panel route-group-areas-card route-child-sequence-card"');
    expect(html).toContain('Return to store');
    expect(html).not.toContain('save driver');
    expect(html).not.toContain('Publish route');
    expect(html).not.toContain('Stops ready · road path not generated');
  });

  test('RouteBuilder renders a full-width child sequence card with one aggregate Save route action', () => {
    const detail = routePlanDetailFixture({
      routePlan: routePlanFixture({ name: 'Route 2026-06-05' }),
    });
    const html = renderToStaticMarkup(
      <RouteBuilder
        isChildRouteDetail
        bootstrap={bootstrap()}
        deletingRouteId={null}
        detail={detail}
        drivers={[driverFixture()]}
        navigate={() => undefined}
        onDeleteRoute={() => undefined}
        onRefreshRoutes={() => undefined}
        setDetail={() => undefined}
        setError={() => undefined}
      />,
    );

    expect(html.match(/aria-label="Save route"/g)).toHaveLength(1);
    expect(html).toContain('class="tab-layout primary-expanded"');
    expect(html).toContain('class="panel route-group-areas-card route-child-sequence-card"');
    expect(html).toContain('<span class="eyebrow">Route stops</span>');
    expect(html).toContain('<h3>Route 2026-06-05</h3>');
    expect(html).not.toContain('<h3>Route 2026-06-05 — Alex Driver</h3>');
    expect(extractFirstMatch(html, /<div class="route-child-sequence-header">([\s\S]*?)<\/div><div class="route-group-area-list/)).not.toContain('Save route');
    expect(html).toContain('class="route-map-header-actions"');
    expect(html).toContain('class="route-visibility-button orange" disabled="" type="button">Send to driver</button>');
    expect(html).not.toContain('class="danger subtle route-map-delete-button"');
    expect(html).toContain('class="route-group-area-driver route-group-area-driver--assignable route-child-sequence-driver"');
    expect(html).not.toContain('class="route-group-area-swatch"');
    expect(html).toContain('<option value="" selected="">Unassigned</option>');
    expect(html).toContain('Alex Driver');
    expect(html).not.toContain('App linked');
    expect(html).not.toContain('Invite pending');
    expect(html).toContain('aria-label="Store start"');
    expect(html).not.toContain('class="route-child-sequence-customer"');
    expect(html).not.toContain('title="Jane Customer">Jane</span>');
    expect(html).toContain('aria-label="Drag to reorder #1001"');
    expect(html).not.toContain('route-child-sequence-node-actions');
    expect(html).not.toContain('aria-label="Move #1001 down"');
    expect(html).not.toContain('aria-label="Move #1002 up"');
    expect(html).toContain('>Finish</span>');
    expect(html).toContain('class="route-child-sequence-footer"');
    expect(html).toMatch(/class="route-child-sequence-footer"[\s\S]*Return to store[\s\S]*Save route/);
    expect(html).not.toContain('class="summary-strip compact-kpis route-summary-kpis"');
    expect(html).toContain('class="route-item-summary-heading-actions"');
    expect(html).toContain('class="tab-secondary" data-tab-region="secondary" hidden=""');
    expect(html).not.toContain('class="panel side-panel route-save-panel route-builder-card-shell"');
    expect(html).not.toContain('Driver &amp; options');
    expect(html).not.toContain('aria-controls="route-builder-panel-driver-options"');
    expect(html).not.toContain('aria-controls="route-builder-panel-stop-order"');
    expect(html).not.toContain('class="route-builder-card-footer"');
    expect(html).not.toContain('Unsaved route changes are ready.');
    expect(html).not.toContain('Save route applies driver, return option, and stop order together.');
    expect(html).not.toContain('Not visible to driver app yet');
    expect(html).not.toContain('class="route-stop-compact-list"');
    expect(html).not.toContain('class="ops-table route-stop-table"');
    expect(html).not.toContain('save driver');
    expect(html).not.toContain('save route options');
    expect(html).not.toContain('Publish route');
  });

  test('RouteBuilder keeps standalone routes on the side-control layout', () => {
    const baseDetail = routePlanDetailFixture();
    const detail = routePlanDetailFixture({
      stops: [
        {
          ...baseDetail.stops[0]!,
          items: [{
            name: 'Tomato box',
            options: [{ key: 'Size', value: 'Large' }],
            productId: 101,
            quantity: 2,
            sku: 'TOM-L',
            variationId: 7,
          }],
        },
        baseDetail.stops[1]!,
      ],
    });
    const html = renderToStaticMarkup(
      <RouteBuilder
        bootstrap={bootstrap()}
        deletingRouteId={null}
        detail={detail}
        drivers={[driverFixture()]}
        navigate={() => undefined}
        onDeleteRoute={() => undefined}
        onRefreshRoutes={() => undefined}
        setDetail={() => undefined}
        setError={() => undefined}
      />,
    );

    expect(html).not.toContain('class="tab-layout primary-expanded"');
    expect(html).toContain('class="panel side-panel route-save-panel route-builder-card-shell"');
    expect(html).toContain('class="route-state-list"');
    expect(html).toContain('class="route-stop-item-lines"');
    expect(html).toContain('Tomato box (Size: Large) × 2');
    expect(html).not.toContain('class="panel route-group-areas-card route-child-sequence-card"');
  });

  test('RouteBuilder renders child route stop order as a map-below sequence track', () => {
    const baseDetail = routePlanDetailFixture();
    const stops: RoutePlanDetailDto['stops'] = Array.from({ length: 11 }, (_, index) => ({
      ...baseDetail.stops[index % baseDetail.stops.length]!,
      deliveryStopId: `stop-${index + 1}`,
      orderId: `order-${index + 1}`,
      orderName: `#${11000 + index}`,
      sequence: index + 1,
      sourceOrderId: `gid://woocommerce/Order/${11000 + index}`,
    }));
    const detail = routePlanDetailFixture({
      routePlan: routePlanFixture({ name: 'Route 2026-06-05', stopsCount: stops.length }),
      stops,
    });
    const html = renderToStaticMarkup(
      <RouteBuilder
        isChildRouteDetail
        bootstrap={bootstrap()}
        deletingRouteId={null}
        detail={detail}
        drivers={[driverFixture()]}
        navigate={() => undefined}
        onDeleteRoute={() => undefined}
        onRefreshRoutes={() => undefined}
        setDetail={() => undefined}
        setError={() => undefined}
      />,
    );

    expect(html.match(/aria-label="Save route"/g)).toHaveLength(1);
    expect(html).toContain('class="tab-layout primary-expanded"');
    expect(html).toContain('class="panel route-group-areas-card route-child-sequence-card"');
    expect(html).toContain('style="--route-group-area-columns:11"');
    expect(html).toContain('aria-label="Drag to reorder #11000"');
    expect(html).toContain('aria-label="Drag to reorder #11010"');
    expect(html).toContain('>11</span>');
    expect(html).not.toContain('class="route-child-sequence-node-actions"');
    expect(html).not.toContain('class="route-builder-tab-body route-builder-tab-body--stop-order"');
    expect(html).not.toContain('class="route-stop-compact-list"');
    expect(html).not.toContain('class="route-stop-count-badge"');
    expect(html).not.toContain('class="drag-handle"');
    expect(html).not.toContain('::');
    expect(html).not.toContain('class="ops-table route-stop-table"');
  });

  test('route end draft payload preserves one aggregate save command shape', () => {
    const detail = routePlanDetailFixture();
    const draftStops = [...detail.stops].reverse();

    expect(hasDepotCoordinates(detail.routePlan)).toBe(true);
    expect(buildRouteSaveDraftInput({
      csrfToken: 'csrf-token',
      detail,
      driverId: 'driver-id',
      draftStops,
      routeEndMode: 'RETURN_TO_DEPOT',
    })).toEqual({
      csrfToken: 'csrf-token',
      driverId: 'driver-id',
      expectedUpdatedAt: '2026-05-26T12:00:00.000Z',
      routeEndMode: 'RETURN_TO_DEPOT',
      routePlanId: 'route-plan-id',
      stops: [
        { deliveryStopId: 'stop-2', sourceOrderId: 'gid://woocommerce/Order/1002' },
        { deliveryStopId: 'stop-1', sourceOrderId: 'gid://woocommerce/Order/1001' },
      ],
    });
  });

  test('RouteBuilder blocks enabling return-to-store when depot coordinates are missing', () => {
    const detail = routePlanDetailFixture({
      routePlan: routePlanFixture({
        depot: { latitude: null, longitude: null },
        routeEndMode: 'END_AT_LAST_STOP',
      }),
    });
    const html = renderToStaticMarkup(
      <RouteBuilder
        isChildRouteDetail
        bootstrap={bootstrap()}
        deletingRouteId={null}
        detail={detail}
        drivers={[driverFixture()]}
        navigate={() => undefined}
        onDeleteRoute={() => undefined}
        onRefreshRoutes={() => undefined}
        setDetail={() => undefined}
        setError={() => undefined}
      />,
    );

    expect(hasDepotCoordinates(detail.routePlan)).toBe(false);
    expect(html).toContain('Return to store requires saved store coordinates.');
    expect(html).toMatch(/<input[^>]*disabled=""[^>]*type="checkbox"/);
  });

  test('RouteBuilder blocks preserving an already-returning route when depot coordinates are invalid', () => {
    const detail = routePlanDetailFixture({
      routePlan: routePlanFixture({
        depot: { latitude: Number.NaN, longitude: -79.3832 },
        routeEndMode: 'RETURN_TO_DEPOT',
      }),
    });
    const html = renderToStaticMarkup(
      <RouteBuilder
        isChildRouteDetail
        bootstrap={bootstrap()}
        deletingRouteId={null}
        detail={detail}
        drivers={[driverFixture()]}
        navigate={() => undefined}
        onDeleteRoute={() => undefined}
        onRefreshRoutes={() => undefined}
        setDetail={() => undefined}
        setError={() => undefined}
      />,
    );

    expect(hasDepotCoordinates(detail.routePlan)).toBe(false);
    expect(html).toContain('Return to store requires saved store coordinates.');
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*checked=""/);
    expect(html).toMatch(/aria-label="Save route"[^>]*disabled=""/);
  });

  test('RouteStopOrderCompactList keeps stop order data without item-line dumps', () => {
    const detail = routePlanDetailFixture();
    const html = renderToStaticMarkup(
      <RouteStopOrderCompactList
        showItems={false}
        draggingStopId={null}
        dropPreview={null}
        onDragEnd={() => undefined}
        onDragStart={() => undefined}
        onDrop={() => undefined}
        onDropPreview={() => undefined}
        onMove={() => undefined}
        stops={detail.stops}
      />,
    );

    expect(html).toContain('role="list"');
    expect(html).toContain('role="listitem"');
    expect(html).toContain('#1001');
    expect(html).toContain('Jane Customer · 100 King St W, Toronto, ON');
    expect(html).toContain('Toronto');
    expect(html).not.toContain('class="drag-handle"');
    expect(html).not.toContain('::');
    expect(html).not.toContain('route-stop-table');
    expect(html).not.toContain('route-stop-item-lines');
  });

  test('RouteBuilder renders clean route item totals and removes the stop item dump', () => {
    const item = {
      name: '토마토 <span class="divider">/</span> Tomato&nbsp;box',
      options: [{ key: 'Size', value: 'Large &amp; Red' }],
      productId: 101,
      quantity: 3,
      sku: 'TOM-L',
      variationId: 7,
    };
    const detail = routePlanDetailFixture({
      routePlan: routePlanFixture({
        itemSummary: {
          changedSincePublish: false,
          fingerprint: 'fingerprint',
          itemTypes: 1,
          items: [item],
          totalQuantity: 3,
        },
      }),
    });

    const html = renderToStaticMarkup(
      <RouteBuilder
        isChildRouteDetail
        bootstrap={bootstrap()}
        deletingRouteId={null}
        detail={detail}
        drivers={[driverFixture()]}
        navigate={() => undefined}
        onDeleteRoute={() => undefined}
        onRefreshRoutes={() => undefined}
        setDetail={() => undefined}
        setError={() => undefined}
      />,
    );

    expect(html).toContain('<span class="route-item-summary-metric">Total<strong>3</strong></span>');
    expect(html).toContain('<span class="route-item-summary-metric">Types<strong>1</strong></span>');
    expect(html).toContain('Route items');
    expect(html).toContain('토마토 / Tomato box');
    expect(html).toContain('Size: Large &amp; Red');
    expect(html).toContain('<th>Item</th><th>Options</th><th>Qty</th>');
    expect(html).not.toContain('Stop notes and items');
    expect(html).not.toContain('<th>SKU</th>');
    expect(html).not.toContain('TOM-L');
    expect(html).not.toContain('&lt;span');
  });

  test('RouteStopOrderCompactList marks the dragged row and drop preview target', () => {
    const detail = routePlanDetailFixture();
    const html = renderToStaticMarkup(
      <RouteStopOrderCompactList
        draggingStopId="stop-1"
        dropPreview={{ position: 'after', targetStopId: 'stop-2' }}
        onDragEnd={() => undefined}
        onDragStart={() => undefined}
        onDrop={() => undefined}
        onDropPreview={() => undefined}
        onMove={() => undefined}
        stops={detail.stops}
      />,
    );

    expect(html).toContain('class="route-stop-compact-list drag-active"');
    expect(html).toContain('class="route-stop-compact-row dragging"');
    expect(html).toContain('class="route-stop-compact-row drop-target drop-after"');
    expect(html).toContain('data-drop-preview="after"');
  });

  test('RouteBuilder does not expose route optimization job status or lock controls', () => {
    const detail = routePlanDetailFixture();
    const html = renderToStaticMarkup(
      <RouteBuilder
        isChildRouteDetail
        bootstrap={bootstrap()}
        deletingRouteId={null}
        detail={detail}
        drivers={[driverFixture()]}
        navigate={() => undefined}
        onDeleteRoute={() => undefined}
        onRefreshRoutes={() => undefined}
        setDetail={() => undefined}
        setError={() => undefined}
      />,
    );

    expect(html).not.toContain('Route optimization');
    expect(html).not.toContain('Stop order edits are locked until this job reaches a terminal state.');
    expect(html).not.toContain('class="route-stop-compact-list locked"');
    expect(html).not.toContain('Route Engine job details');
    expect(html).not.toContain('route-opt:route-plan-id:test');
    expect(html).not.toContain('Trace ID');
    expect(html).not.toContain('route-optimization-disclosure');
    expect(html).not.toContain('Rerun optimization');
    expect(html).not.toContain('route-optimize-button');
    expect(html).not.toContain('route-builder-card-heading');
  });

  test('RouteBuilder keeps driver and return controls editable without optimization lock', () => {
    const html = renderToStaticMarkup(
      <RouteBuilder
        isChildRouteDetail
        bootstrap={bootstrap()}
        deletingRouteId={null}
        detail={routePlanDetailFixture()}
        drivers={[driverFixture()]}
        navigate={() => undefined}
        onDeleteRoute={() => undefined}
        onRefreshRoutes={() => undefined}
        setDetail={() => undefined}
        setError={() => undefined}
      />,
    );

    expect(html).not.toContain('Rerun optimization');
    expect(html).not.toContain('Route Engine job details');
    expect(html).not.toMatch(/<select disabled="">/);
    expect(html).not.toMatch(/class="route-end-toggle-checkbox" disabled=""/);
    expect(html).not.toContain('class="route-builder-tab-body route-builder-tab-body--stop-order"');
  });

  test('RouteBuilder omits terminal optimization job copy from normal route detail', () => {
    const html = renderToStaticMarkup(
      <RouteBuilder
        isChildRouteDetail
        bootstrap={bootstrap()}
        deletingRouteId={null}
        detail={routePlanDetailFixture()}
        drivers={[driverFixture()]}
        navigate={() => undefined}
        onDeleteRoute={() => undefined}
        onRefreshRoutes={() => undefined}
        setDetail={() => undefined}
        setError={() => undefined}
      />,
    );

    expect(html).not.toContain('Route Engine result applied.');
    expect(html).not.toContain('Applied at');
    expect(html).not.toContain('Finished at');
    expect(html).not.toContain('Rerun optimization');
    expect(html).not.toContain('route-builder-card-heading');
    expect(html).not.toContain('route-stop-compact-list locked');
    expect(html).not.toContain('route-optimize-button');
  });

  test('route optimization job API helpers use the protected Route Ops endpoints', async () => {
    const fetchMock = vi.fn((url: string) =>
      Promise.resolve(
        new Response(
          JSON.stringify({ data: { job: routeOptimizationJobFixture({ id: url.includes('latest') ? 'latest-job-id' : 'job-id' }) }, error: null }),
          {
            headers: { 'Content-Type': 'application/json' },
            status: 200,
          },
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('window', { location: { search: '?shopDomain=tenant-a.example.test' } });

    await createRouteOptimizationJob('route/id', 'csrf-token');
    await getLatestRouteOptimizationJob('route/id');
    await getRouteOptimizationJob('route/id', 'job/id');

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/admin/ui/app/api/routes/route%2Fid/optimize-jobs?shopDomain=tenant-a.example.test',
      expect.objectContaining({
        body: '{}',
        credentials: 'same-origin',
        headers: expect.objectContaining({ 'X-CSRF-Token': 'csrf-token' }),
        method: 'POST',
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/admin/ui/app/api/routes/route%2Fid/optimize-jobs/latest?shopDomain=tenant-a.example.test',
      expect.objectContaining({
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      '/admin/ui/app/api/routes/route%2Fid/optimize-jobs/job%2Fid?shopDomain=tenant-a.example.test',
      expect.objectContaining({
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      }),
    );
  });

  test('route grouping child generation posts to the protected Route Ops API with CSRF', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ data: { routeGroup: routeGroupingFixture() }, error: null }), {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('window', { location: { search: '?shopDomain=tenant-a.example.test' } });

    await generateRouteGroupingChildRoutes({ csrfToken: 'csrf-token', routeGroupId: 'group/id' });
    await generateRouteGroupingChildRoutes({ confirmRisk: true, csrfToken: 'csrf-token', routeGroupId: 'group/id' });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/admin/ui/app/api/route-groups/group%2Fid/generate-child-routes?shopDomain=tenant-a.example.test',
      expect.objectContaining({
        body: '{"confirmRisk":false}',
        credentials: 'same-origin',
        headers: expect.objectContaining({ 'X-CSRF-Token': 'csrf-token' }),
        method: 'POST',
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/admin/ui/app/api/route-groups/group%2Fid/generate-child-routes?shopDomain=tenant-a.example.test',
      expect.objectContaining({
        body: '{"confirmRisk":true}',
        credentials: 'same-origin',
        headers: expect.objectContaining({ 'X-CSRF-Token': 'csrf-token' }),
        method: 'POST',
      }),
    );
  });

  test('regenerateDriverInviteCode posts to the protected Route Ops API with CSRF', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ data: { drivers: [] }, error: null }), {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('window', { location: { search: '?shopDomain=tenant-a.example.test' } });

    await regenerateDriverInviteCode({ csrfToken: 'csrf-token', driverId: 'driver/id' });

    expect(fetchMock).toHaveBeenCalledWith(
      '/admin/ui/app/api/drivers/driver%2Fid/regenerate-invite-code?shopDomain=tenant-a.example.test',
      expect.objectContaining({
        body: '{}',
        credentials: 'same-origin',
        headers: expect.objectContaining({ 'X-CSRF-Token': 'csrf-token' }),
        method: 'POST',
      }),
    );
  });

  test('deleteDriver calls the protected Route Ops API with CSRF', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ data: { drivers: [] }, error: null }), {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('window', { location: { search: '?shopDomain=tenant-a.example.test' } });

    await deleteDriver({ csrfToken: 'csrf-token', driverId: 'driver/id' });

    expect(fetchMock).toHaveBeenCalledWith(
      '/admin/ui/app/api/drivers/driver%2Fid?shopDomain=tenant-a.example.test',
      expect.objectContaining({
        body: '{}',
        credentials: 'same-origin',
        headers: expect.objectContaining({ 'X-CSRF-Token': 'csrf-token' }),
        method: 'DELETE',
      }),
    );
  });

  test('publishRoute posts to the protected Route Ops API with CSRF', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              routeGeometry: null,
              routePlan: routePlanFixture({ status: 'ASSIGNED' }),
              routeStopPoints: [],
              stops: [],
            },
            error: null,
          }),
          {
            headers: { 'Content-Type': 'application/json' },
            status: 200,
          },
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('window', { location: { search: '?shopDomain=tenant-a.example.test' } });

    await publishRoute('route/id', 'csrf-token');

    expect(fetchMock).toHaveBeenCalledWith(
      '/admin/ui/app/api/routes/route%2Fid/publish?shopDomain=tenant-a.example.test',
      expect.objectContaining({
        body: '{}',
        credentials: 'same-origin',
        headers: expect.objectContaining({ 'X-CSRF-Token': 'csrf-token' }),
        method: 'POST',
      }),
    );
  });

  test('saveRoute patches aggregate route state with CSRF', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              routeGeometry: null,
              routePlan: routePlanFixture({ driverId: 'driver-id', status: 'ASSIGNED' }),
              routeStopPoints: [],
              saveOperations: [{ name: 'driver', reason: 'driver_changed', status: 'applied' }],
              stops: [],
            },
            error: null,
          }),
          {
            headers: { 'Content-Type': 'application/json' },
            status: 200,
          },
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('window', { location: { search: '?shopDomain=tenant-a.example.test' } });

    await saveRoute({
      csrfToken: 'csrf-token',
      driverId: 'driver-id',
      expectedUpdatedAt: '2026-05-26T12:00:00.000Z',
      routeEndMode: 'END_AT_LAST_STOP',
      routePlanId: 'route/id',
      stops: [{ deliveryStopId: 'stop-1', sourceOrderId: 'source-1' }],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/admin/ui/app/api/routes/route%2Fid?shopDomain=tenant-a.example.test',
      expect.objectContaining({
        body: JSON.stringify({
          driverId: 'driver-id',
          expectedUpdatedAt: '2026-05-26T12:00:00.000Z',
          routeEndMode: 'END_AT_LAST_STOP',
          stops: [{ deliveryStopId: 'stop-1', sourceOrderId: 'source-1' }],
        }),
        credentials: 'same-origin',
        headers: expect.objectContaining({ 'X-CSRF-Token': 'csrf-token' }),
        method: 'PATCH',
      }),
    );
  });

  test('getNotifications reads the Route Ops notification API with workspace query', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: { notifications: [], unreadCount: 0 },
            error: null,
          }),
          {
            headers: { 'Content-Type': 'application/json' },
            status: 200,
          },
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('window', { location: { search: '?shopDomain=tenant-a.example.test' } });

    await getNotifications('limit=5');

    expect(fetchMock).toHaveBeenCalledWith(
      '/admin/ui/app/api/notifications?limit=5&shopDomain=tenant-a.example.test',
      expect.objectContaining({
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      }),
    );
  });

  test('openNotificationChangeStream listens only for notification invalidations and closes cleanly', () => {
    const instances: FakeEventSource[] = [];
    class FakeEventSource {
      readonly close = vi.fn();
      readonly listeners = new Map<string, Set<() => void>>();
      onerror: ((this: EventSource, event: Event) => unknown) | null = null;

      constructor(readonly url: string) {
        instances.push(this);
      }

      addEventListener(type: string, listener: () => void): void {
        const listeners = this.listeners.get(type) ?? new Set<() => void>();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }

      removeEventListener(type: string, listener: () => void): void {
        this.listeners.get(type)?.delete(listener);
      }

      emit(type: string): void {
        for (const listener of this.listeners.get(type) ?? []) {
          listener();
        }
      }
    }
    const EventSourceStub = FakeEventSource as unknown as typeof EventSource;
    const onNotificationsChanged = vi.fn();
    vi.stubGlobal('EventSource', EventSourceStub);
    vi.stubGlobal('window', { location: { search: '?shopDomain=tenant-a.example.test' } });

    const subscription = openNotificationChangeStream({
      onNotificationsChanged,
    });
    const source = instances[0];

    expect(source?.url).toBe(
      '/admin/ui/app/api/notifications/stream?shopDomain=tenant-a.example.test',
    );
    source?.emit('message');
    expect(onNotificationsChanged).not.toHaveBeenCalled();
    source?.emit('open');
    expect(onNotificationsChanged).not.toHaveBeenCalled();
    source?.emit('notifications_changed');
    expect(onNotificationsChanged).toHaveBeenCalledTimes(1);
    source?.onerror?.call(source as unknown as EventSource, new Event('error'));
    expect(onNotificationsChanged).toHaveBeenCalledTimes(1);

    subscription?.close();
    source?.emit('open');
    source?.emit('notifications_changed');
    expect(onNotificationsChanged).toHaveBeenCalledTimes(1);
    expect(source?.close).toHaveBeenCalledTimes(1);
  });

  test('markNotificationRead patches the protected notification API with CSRF', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              notification: {
                body: null,
                createdAt: '2026-06-05T07:00:00.000Z',
                href: null,
                id: 'notification-id',
                orderId: null,
                payload: null,
                readAt: '2026-06-05T07:01:00.000Z',
                routePlanId: null,
                severity: 'info',
                title: 'Read',
                type: 'SYSTEM',
              },
            },
            error: null,
          }),
          {
            headers: { 'Content-Type': 'application/json' },
            status: 200,
          },
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('window', { location: { search: '?shopDomain=tenant-a.example.test' } });

    await markNotificationRead({
      csrfToken: 'csrf-token',
      notificationId: 'notification/id',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/admin/ui/app/api/notifications/notification%2Fid/read?shopDomain=tenant-a.example.test',
      expect.objectContaining({
        body: '{}',
        credentials: 'same-origin',
        headers: expect.objectContaining({ 'X-CSRF-Token': 'csrf-token' }),
        method: 'PATCH',
      }),
    );
  });
});

function driverFixture(overrides: Partial<DriverDto> = {}): DriverDto {
  return {
    appLinked: false,
    authStatus: 'INVITE_PENDING',
    createdAt: '2026-05-26T12:00:00.000Z',
    displayName: 'Alex Driver',
    id: 'driver-pending',
    inviteCode: 'A1B2C3',
    inviteCodeExpiresAt: '2026-05-27T12:00:00.000Z',
    lastSeenAt: null,
    phone: '+14165550123',
    recentEventsCount: 2,
    status: 'PENDING',
    updatedAt: '2026-05-26T12:00:00.000Z',
    ...overrides,
  };
}

function linkedDriverFixture(): DriverDto {
  return driverFixture({
    appLinked: true,
    authStatus: 'APP_LINKED',
    displayName: 'Minji Driver',
    id: 'driver-linked',
    inviteCode: null,
    inviteCodeExpiresAt: null,
    lastSeenAt: '2026-05-27T15:00:00.000Z',
    status: 'ACTIVE',
  });
}

function routePlanFixture(overrides: Partial<RoutePlanSummaryDto> = {}): RoutePlanSummaryDto {
  return {
    createdAt: '2026-05-26T12:00:00.000Z',
    deliveryAreas: ['Toronto'],
    deliveryDate: '2026-05-26',
    depot: { latitude: 43.6532, longitude: -79.3832 },
    driverId: null,
    id: 'route-plan-id',
    missingCoordinates: 0,
    name: 'Route draft',
    planDate: '2026-05-26',
    routeEndMode: 'END_AT_LAST_STOP',
    routeGroupingChild: null,
    status: 'DRAFT',
    stopsCount: 2,
    updatedAt: '2026-05-26T12:00:00.000Z',
    ...overrides,
  };
}

function routeGroupingFixture(overrides: Partial<RouteGroupingSummaryDto> = {}): RouteGroupingSummaryDto {
  return {
    children: [],
    currentVersion: 1,
    displayStatus: 'READY',
    id: 'group-id',
    name: 'Route 2026-06-19',
    planDate: '2026-06-19',
    status: 'CURRENT',
    totalOrders: 5,
    unresolvedOrders: 0,
    updatedAt: '2026-06-19T12:00:00.000Z',
    warningState: [],
    ...overrides,
  };
}

function bootstrap(overrides: Partial<BootstrapPayload> = {}): BootstrapPayload {
  return {
    appUrls: {
      dashboard: '/admin/ui/app',
      drivers: '/admin/ui/app/drivers',
      orders: '/admin/ui/app/orders',
      routes: '/admin/ui/app/routes',
      settings: '/admin/ui/app/settings',
    },
    csrfToken: 'csrf-token',
    driverApp: { installUrl: 'https://clever-route.cleversystem.ai/driver-app' },
    mapConfig: {
      allowedHosts: [],
      attribution: null,
      providerMode: null,
      status: 'not_configured',
      styleAudit: null,
      styleUrl: null,
    },
    mode: 'internal-admin',
    routerConfig: { provider: null, status: 'not_configured' },
    shopDomain: 'dev1.tomatonofood.com',
    ...overrides,
  };
}

function routeOptimizationJobFixture(overrides: Partial<RouteOptimizationJobDto> = {}): RouteOptimizationJobDto {
  return {
    appliedAt: null,
    createdAt: '2026-06-10T07:00:00.000Z',
    createdBy: 'web-operator',
    currentStep: 'QUEUED',
    elapsedMs: null,
    engineResultSequence: null,
    errorCode: null,
    errorMessage: null,
    finishedAt: null,
    id: 'job-id',
    invalidatedReason: null,
    routePlanId: 'route-plan-id',
    shopId: 'shop-id',
    startedAt: null,
    status: 'QUEUED',
    timeoutBudgetMs: 180000,
    traceId: 'route-opt:route-plan-id:test',
    updatedAt: '2026-06-10T07:00:00.000Z',
    ...overrides,
  };
}

function routePlanDetailFixture(overrides: Partial<RoutePlanDetailDto> = {}): RoutePlanDetailDto {
  return {
    routeGeometry: null,
    routePlan: routePlanFixture(),
    routeStopPoints: [],
    stops: [
      {
        addressLabel: '100 King St W, Toronto, ON',
        coordinates: { latitude: 43.6532, longitude: -79.3832 },
        deliveryArea: 'Toronto',
        deliveryStopId: 'stop-1',
        items: [],
        orderId: 'order-1',
        orderName: '#1001',
        recipientName: 'Jane Customer',
        sequence: 1,
        sourceOrderId: 'gid://woocommerce/Order/1001',
        status: 'PENDING',
      },
      {
        addressLabel: '200 King St W, Toronto, ON',
        coordinates: { latitude: 43.65, longitude: -79.4 },
        deliveryArea: 'Toronto',
        deliveryStopId: 'stop-2',
        items: [],
        orderId: 'order-2',
        orderName: '#1002',
        recipientName: 'John Customer',
        sequence: 2,
        sourceOrderId: 'gid://woocommerce/Order/1002',
        status: 'PENDING',
      },
    ],
    ...overrides,
  };
}

function extractFirstMatch(value: string, pattern: RegExp): string {
  return pattern.exec(value)?.[1] ?? '';
}
