import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { deleteDriver, publishRoute, regenerateDriverInviteCode } from '../src/api';
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
  getDriverOptionLabel,
  getRouteDriverDisplay,
  getRoutePublishNotice,
  formatRoutePlanStatus,
  isRouteVisibleToLinkedDriver,
} from '../src/pages/RoutesPage';
import type { BootstrapPayload, DriverDto, RoutePlanSummaryDto } from '../src/types';

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
    const inviteCellHtml = extractFirstMatch(html, /<td><div class="driver-invite-actions">([\s\S]*?)<\/div><\/td>/);

    expect(tableHeaderHtml).toContain('Driver');
    expect(tableHeaderHtml).toContain('Phone');
    expect(tableHeaderHtml).toContain('Status');
    expect(tableHeaderHtml).toContain('App access');
    expect(tableHeaderHtml).toContain('Invite code / action');
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
    status: 'DRAFT',
    stopsCount: 2,
    updatedAt: '2026-05-26T12:00:00.000Z',
    ...overrides,
  };
}

function bootstrap(): BootstrapPayload {
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
  };
}

function extractFirstMatch(value: string, pattern: RegExp): string {
  return pattern.exec(value)?.[1] ?? '';
}
