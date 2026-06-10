import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  createRouteOptimizationJob,
  deleteDriver,
  getLatestRouteOptimizationJob,
  getNotifications,
  getRouteOptimizationJob,
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
  getDriverOptionLabel,
  getRouteDriverDisplay,
  getRouteOptimizationJobDetailRows,
  getRouteOptimizationJobNotice,
  getRoutePublishNotice,
  formatRoutePlanStatus,
  hasDepotCoordinates,
  isRouteOptimizationJobActive,
  isRouteVisibleToLinkedDriver,
  RouteBuilder,
  RouteStopOrderCompactList,
} from '../src/pages/RoutesPage';
import { getRoutesCopy } from '../src/i18n';
import type {
  BootstrapPayload,
  DriverDto,
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

  test('builds copyable invite text from the current code only', () => {
    expect(buildDriverInviteMessage(driverFixture())).toContain(
      'Authentication code: A1B2C3',
    );
    expect(formatDriverAuthLabel(driverFixture())).toBe('Invite pending');
    expect(formatDriverAuthLabel(linkedDriverFixture())).toBe('Linked');
    expect(buildDriverInviteMessage(driverFixture(), 'ko-KR')).toContain(
      '인증 코드: A1B2C3',
    );
    expect(formatDriverAuthLabel(driverFixture(), 'ko-KR')).toBe('초대 대기');
    expect(formatDriverAuthLabel(linkedDriverFixture(), 'ko-KR')).toBe('연결됨');
  });

  test('labels pending drivers in route assignment and route lists', () => {
    const pending = driverFixture();
    const linked = linkedDriverFixture();
    const route = routePlanFixture({ driverId: pending.id });

    expect(getDriverOptionLabel(pending)).toBe('Alex Driver · Invite pending');
    expect(getDriverOptionLabel(linked)).toBe('Minji Driver · App linked');
    expect(getRouteDriverDisplay(route, [pending, linked])).toBe(
      'Alex Driver · Invite pending',
    );
    expect(getRouteDriverDisplay(routePlanFixture({ driverId: null }), [pending])).toBe(
      'Unassigned',
    );
    expect(getRouteDriverDisplay(routePlanFixture({ driverId: 'unknown-driver' }), [pending])).toBe(
      'unknown-driver',
    );
    expect(getDriverOptionLabel(pending, 'ko-KR')).toBe('Alex Driver · 초대 대기');
    expect(getDriverOptionLabel(linked, 'ko-KR')).toBe('Minji Driver · 앱 연결됨');
    expect(getRouteDriverDisplay(routePlanFixture({ driverId: null }), [pending], 'ko-KR')).toBe(
      '미배정',
    );
    expect(formatRoutePlanStatus('DRAFT', 'ko-KR')).toBe('초안');
    expect(formatRoutePlanStatus('ASSIGNED', 'ko-KR')).toBe('배정됨');
  });

  test('localizes the exposed return-to-store Route Builder option', () => {
    expect(getRoutesCopy('en-CA').returnToStore).toBe('Return to store');
    expect(getRoutesCopy('ko-KR').returnToStore).toBe('매장으로 돌아오기');
  });

  test('explains when draft and published routes are visible to drivers', () => {
    const pending = driverFixture();
    const linked = linkedDriverFixture();
    const draftAssigned = routePlanFixture({ driverId: linked.id, status: 'DRAFT' });
    const publishedLinked = routePlanFixture({ driverId: linked.id, status: 'ASSIGNED' });
    const publishedPending = routePlanFixture({ driverId: pending.id, status: 'ASSIGNED' });

    expect(isRouteVisibleToLinkedDriver(draftAssigned, [linked])).toBe(false);
    expect(getRoutePublishNotice(draftAssigned, [linked])?.text).toContain('not visible');
    expect(isRouteVisibleToLinkedDriver(publishedLinked, [linked])).toBe(true);
    expect(getRoutePublishNotice(publishedLinked, [linked])?.text).toContain('visible');
    expect(isRouteVisibleToLinkedDriver(publishedPending, [pending])).toBe(false);
    expect(getRoutePublishNotice(publishedPending, [pending])?.text).toContain('after app authentication');
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

    expect(html).toContain('Road path ready');
    expect(html).toContain('Published route — visible to the linked driver after the app refreshes.');
    expect(html).not.toContain('Driver app visible');
    expect(html).toMatch(/aria-label="Save route"[^>]*disabled=""/);
    expect(html).toContain('Driver &amp; options');
    expect(html).toContain('Return to store');
    expect(html).not.toContain('save driver');
    expect(html).not.toContain('Publish route');
    expect(html).not.toContain('Stops ready · road path not generated');
  });

  test('RouteBuilder defaults to Driver & options tab with one aggregate Save route action', () => {
    const detail = routePlanDetailFixture({
      routePlan: routePlanFixture({ name: 'Route 2026-06-05' }),
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
    const cardHeader = extractFirstMatch(html, /<div class="route-builder-card-header">([\s\S]*?)<div aria-label="Route Builder card tabs"/);

    expect(html.match(/aria-label="Save route"/g)).toHaveLength(1);
    expect(html).toContain('class="panel side-panel route-save-panel route-builder-card-shell"');
    expect(html).toContain('class="route-builder-route-title" title="Route 2026-06-05"');
    expect(cardHeader).toContain('Route 2026-06-05');
    expect(cardHeader).toContain('class="route-row-actions route-builder-card-actions"');
    expect(cardHeader).toContain('All routes');
    expect(cardHeader).toContain('Delete');
    expect(cardHeader).not.toContain('route-stop-count-badge');
    expect(html).toContain('Driver &amp; options');
    expect(html).toContain('Stop order');
    expect(html).toContain('aria-controls="route-builder-panel-driver-options"');
    expect(html).toContain('aria-controls="route-builder-panel-stop-order"');
    expect(html).toContain('id="route-builder-panel-driver-options"');
    expect(html).toContain('aria-labelledby="route-builder-tab-driver-options"');
    expect(html).toContain('class="route-builder-tab-body route-builder-tab-body--driver"');
    expect(html).toContain('class="route-end-toggle-checkbox"');
    expect(html).toContain('Return to store');
    expect(html).toContain('class="route-builder-card-footer"');
    expect(html).not.toContain('Unsaved route changes are ready.');
    expect(html).not.toContain('Save route applies driver, return option, and stop order together.');
    expect(html).not.toContain('Not visible to driver app yet');
    expect(html).not.toContain('class="route-stop-compact-list"');
    expect(html).not.toContain('class="ops-table route-stop-table"');
    expect(html).not.toContain('save driver');
    expect(html).not.toContain('save route options');
    expect(html).not.toContain('Publish route');
  });

  test('RouteBuilder stop-order tab renders scroll-contained right-card stop table with shared Save route action', () => {
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
        bootstrap={bootstrap()}
        deletingRouteId={null}
        detail={detail}
        drivers={[driverFixture()]}
        initialBuilderTab="stop-order"
        navigate={() => undefined}
        onDeleteRoute={() => undefined}
        onRefreshRoutes={() => undefined}
        setDetail={() => undefined}
        setError={() => undefined}
      />,
    );
    const cardHeader = extractFirstMatch(html, /<div class="route-builder-card-header">([\s\S]*?)<div aria-label="Route Builder card tabs"/);
    const stopToolbar = extractFirstMatch(html, /<div class="route-stop-compact-toolbar">([\s\S]*?)<div aria-label="Stop order"/);

    expect(html.match(/aria-label="Save route"/g)).toHaveLength(1);
    expect(html).not.toContain('Route stops');
    expect(html).not.toContain('Stop order table');
    expect(html).not.toContain('Drag or use the arrow controls to preview the route order before saving.');
    expect(html).toContain('class="route-builder-tab-body route-builder-tab-body--stop-order"');
    expect(html).toContain('class="route-stop-compact-list"');
    expect(html).toContain('class="drag-handle"');
    expect(html).toContain('::');
    expect(stopToolbar).toContain('class="badge route-stop-count-badge"');
    expect(stopToolbar).toContain('11 stops');
    expect(cardHeader).not.toContain('11 stops');
    expect(html.indexOf('class="route-builder-card-footer"')).toBeGreaterThan(html.indexOf('class="route-stop-compact-list"'));
    expect(html).not.toContain('Save route applies driver, return option, and stop order together.');
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

  test('RouteStopOrderCompactList keeps stop order data and controls within side-card markup', () => {
    const detail = routePlanDetailFixture();
    const html = renderToStaticMarkup(
      <RouteStopOrderCompactList
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
    expect(html).toContain('class="drag-handle"');
    expect(html).not.toContain('route-stop-table');
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

  test('RouteBuilder shows optimization job status and locks stop order controls while active', () => {
    const detail = routePlanDetailFixture();
    const html = renderToStaticMarkup(
      <RouteBuilder
        bootstrap={bootstrap()}
        deletingRouteId={null}
        detail={detail}
        drivers={[driverFixture()]}
        initialBuilderTab="stop-order"
        initialOptimizationJob={routeOptimizationJobFixture({
          currentStep: 'CALLING_ENGINE',
          elapsedMs: 15320,
          startedAt: '2026-06-10T07:00:01.000Z',
          status: 'RUNNING',
        })}
        navigate={() => undefined}
        onDeleteRoute={() => undefined}
        onRefreshRoutes={() => undefined}
        setDetail={() => undefined}
        setError={() => undefined}
      />,
    );

    expect(isRouteOptimizationJobActive(routeOptimizationJobFixture({ status: 'RUNNING' }))).toBe(true);
    expect(html).toContain('Route optimization');
    expect(html).toContain('Route Engine is optimizing this route. This may take a while; it is not a failure.');
    expect(html).toContain('Stop order edits are locked until this job reaches a terminal state.');
    expect(html).toContain('class="route-stop-compact-list locked"');
    expect(html).toContain('Route Engine job details');
    expect(html).toContain('Calling engine');
    expect(html).toContain('15s');
    expect(html).toContain('30s');
    expect(html).toContain('route-opt:route-plan-id:test');
    expect(html).toContain('route-optimization-disclosure');
    expect(html).toContain('class="route-optimization-summary-line"');
    expect(html).toContain('class="route-optimization-details"');
    expect(html).not.toContain('class="route-optimization-log" open=""');
    expect(html).not.toContain('route-optimization-disclosure neutral" open=""');
    expect(html).toContain('Rerun optimization');
    expect(html).toMatch(/class="primary route-optimize-button" disabled=""/);
    expect(html).toMatch(
      /class="map-panel panel"[\s\S]*class="panel-heading"[\s\S]*Rerun optimization[\s\S]*Route Engine job details[\s\S]*class="route-ops-map-frame"/,
    );
    expect(html).not.toContain('route-builder-card-heading');
    expect(html).not.toMatch(/class="route-stop-compact-toolbar"[\s\S]*route-optimize-button/);
    expect(html).not.toMatch(/class="route-builder-tab-body route-builder-tab-body--stop-order"[\s\S]*Route Engine job details[\s\S]*class="route-stop-compact-list/);

    const liveElapsedRows = getRouteOptimizationJobDetailRows(routeOptimizationJobFixture({
      elapsedMs: 15320,
      startedAt: '2026-06-10T07:00:01.000Z',
      status: 'RUNNING',
    }), 'en-CA', Date.parse('2026-06-10T07:01:02.000Z'));
    expect(liveElapsedRows[2]?.value).toBe('1m 01s');
  });

  test('RouteBuilder keeps route optimization controls visible outside the Stop order tab', () => {
    const html = renderToStaticMarkup(
      <RouteBuilder
        bootstrap={bootstrap()}
        deletingRouteId={null}
        detail={routePlanDetailFixture()}
        drivers={[driverFixture()]}
        initialBuilderTab="driver-options"
        initialOptimizationJob={routeOptimizationJobFixture({
          currentStep: 'CALLING_ENGINE',
          elapsedMs: 15320,
          status: 'RUNNING',
        })}
        navigate={() => undefined}
        onDeleteRoute={() => undefined}
        onRefreshRoutes={() => undefined}
        setDetail={() => undefined}
        setError={() => undefined}
      />,
    );

    expect(html).toContain('Rerun optimization');
    expect(html).toContain('Route Engine job details');
    expect(html).toMatch(
      /class="map-panel panel"[\s\S]*class="panel-heading"[\s\S]*Rerun optimization[\s\S]*Route Engine job details[\s\S]*class="route-ops-map-frame"/,
    );
    expect(html).not.toContain('class="route-builder-tab-body route-builder-tab-body--stop-order"');
  });

  test('RouteBuilder allows explicit optimization rerun after a terminal job', () => {
    const html = renderToStaticMarkup(
      <RouteBuilder
        bootstrap={bootstrap()}
        deletingRouteId={null}
        detail={routePlanDetailFixture()}
        drivers={[driverFixture()]}
        initialBuilderTab="stop-order"
        initialOptimizationJob={routeOptimizationJobFixture({ status: 'APPLIED' })}
        navigate={() => undefined}
        onDeleteRoute={() => undefined}
        onRefreshRoutes={() => undefined}
        setDetail={() => undefined}
        setError={() => undefined}
      />,
    );

    expect(getRouteOptimizationJobNotice(routeOptimizationJobFixture({ status: 'APPLIED' }))?.tone).toBe('green');
    expect(getRouteOptimizationJobDetailRows(routeOptimizationJobFixture({ currentStep: 'APPLYING_RESULT', elapsedMs: 4200, status: 'RUNNING' }))[1]?.value).toBe('Applying result');
    expect(html).toContain('Route Engine result applied. You can still edit stops manually, or rerun optimization explicitly.');
    expect(html).toContain('Rerun optimization');
    expect(html).toMatch(
      /class="map-panel panel"[\s\S]*class="panel-heading"[\s\S]*Rerun optimization[\s\S]*Route Engine job details[\s\S]*class="route-ops-map-frame"/,
    );
    expect(html).not.toContain('route-builder-card-heading');
    expect(html).not.toContain('route-stop-compact-list locked');
    expect(html).not.toMatch(/class="primary route-optimize-button" disabled=""/);
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
    status: 'DRAFT',
    stopsCount: 2,
    updatedAt: '2026-05-26T12:00:00.000Z',
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
    timeoutBudgetMs: 30000,
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
