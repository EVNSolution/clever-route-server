import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { regenerateDriverInviteCode } from '../src/api';
import {
  DriverTable,
  buildDriverInviteMessage,
  formatDriverAuthLabel,
} from '../src/pages/DriversPage';
import { getDriverOptionLabel, getRouteDriverDisplay } from '../src/pages/RoutesPage';
import type { DriverDto, RoutePlanSummaryDto } from '../src/types';

describe('Route Ops driver invite and route assignment UI helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test('renders pending invite codes and linked app access without exposing raw auth subjects', () => {
    const html = renderToStaticMarkup(
      <DriverTable drivers={[driverFixture(), linkedDriverFixture()]} />,
    );

    expect(html).toContain('Driver');
    expect(html).toContain('Phone');
    expect(html).toContain('App access');
    expect(html).toContain('Invite code / action');
    expect(html).toContain('A1B2C3');
    expect(html).toContain('Copy invite');
    expect(html).toContain('Regenerate');
    expect(html).toContain('App linked');
    expect(html).toContain('No active code');
    expect(html).toContain('Re-login code');
    expect(html).not.toContain('authSubject');
    expect(html).not.toContain('refreshToken');
  });

  test('builds copyable invite text from the current code only', () => {
    expect(buildDriverInviteMessage(driverFixture())).toContain(
      'Authentication code: A1B2C3',
    );
    expect(formatDriverAuthLabel(driverFixture())).toBe('Invite pending');
    expect(formatDriverAuthLabel(linkedDriverFixture())).toBe('App linked');
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
