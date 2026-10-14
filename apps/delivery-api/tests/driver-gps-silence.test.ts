import { describe, expect, test, vi } from 'vitest';
import { deriveDriverSilence, PrismaDriverSyncHealthService } from '../src/modules/driver/driver-sync-health.service.js';

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 10, 15, 0, 0) + seconds * 1000);

describe('driver silence classification', () => {
  const base = { lastHeartbeatReceivedAt: null, lastLocationReceivedAt: at(0), startedAt: null };

  test('uses the 1 minute warning and 5 minute critical gps thresholds', () => {
    expect(deriveDriverSilence({ ...base, now: at(59) }).gps).toBe('OK');
    expect(deriveDriverSilence({ ...base, now: at(60) })).toMatchObject({ gps: 'WARNING', gpsSilentSeconds: 60 });
    expect(deriveDriverSilence({ ...base, now: at(299) }).gps).toBe('WARNING');
    expect(deriveDriverSilence({ ...base, now: at(300) }).gps).toBe('CRITICAL');
  });

  test('counts accepted locations as device contact so a background app is not heartbeat-absent', () => {
    const state = deriveDriverSilence({ ...base, lastHeartbeatReceivedAt: at(-2400), now: at(120) });
    expect(state.contactAbsent).toBe(false);
    expect(deriveDriverSilence({ ...base, lastHeartbeatReceivedAt: at(-2400), now: at(181) }).contactAbsent).toBe(true);
  });

  test('measures silence from route start when no location arrived yet and stays quiet with no signal at all', () => {
    expect(deriveDriverSilence({ lastHeartbeatReceivedAt: null, lastLocationReceivedAt: null, now: at(90), startedAt: at(0) }).gps).toBe('WARNING');
    const unknown = deriveDriverSilence({ lastHeartbeatReceivedAt: null, lastLocationReceivedAt: null, now: at(90), startedAt: null });
    expect(unknown).toMatchObject({ contactAbsent: true, gps: 'OK', gpsSilentSeconds: null });
  });

  test('ignores a location received before the latest route start', () => {
    const state = deriveDriverSilence({ lastHeartbeatReceivedAt: null, lastLocationReceivedAt: at(-3600), now: at(30), startedAt: at(0) });
    expect(state).toMatchObject({ gps: 'OK', gpsSilentSeconds: 30 });
  });
});

describe('driver gps silence detector', () => {
  function harness(routes: unknown[]) {
    const alerts = { openOrObserve: vi.fn().mockResolvedValue({}), resolveByDedupeKey: vi.fn().mockResolvedValue(true) };
    const prisma = {
      driverRuntimeDiagnosticSnapshot: {
        findFirst: vi.fn().mockResolvedValue({
          receivedAt: at(0),
          snapshot: { lastGpsCollectedAt: '2026-10-10T15:00:00.000Z', lifecycle: 'FOREGROUND', locationTask: 'STARTED', network: 'ONLINE' }
        })
      },
      routePlan: { findMany: vi.fn().mockImplementation(() => Promise.resolve(routes)) }
    };
    let now = at(0);
    const service = new PrismaDriverSyncHealthService(prisma as never, alerts as never, () => now);
    return { advance: (seconds: number) => { now = at(seconds); }, alerts, prisma, service };
  }
  const route = (overrides: Record<string, unknown> = {}) => ({
    deliveryWorkCompletedAt: null,
    driverEvents: [{ createdAt: at(-3600) }],
    driverId: 'driver-1',
    driverRouteSessionLeases: [],
    id: 'route-1',
    routeStops: [{ deliveryStop: { status: 'PLANNED' } }],
    shopId: 'shop-1',
    trackingGeometry: { lastReceivedAt: at(0) },
    ...overrides
  });

  test('opens a warning at 60 seconds, escalates at 300 and resolves on the next fix', async () => {
    const h = harness([route()]);
    h.advance(61);
    await expect(h.service.detectOperationalHealth()).resolves.toMatchObject({ gpsSilent: 1, heartbeatAbsent: 0 });
    expect(h.alerts.openOrObserve).toHaveBeenCalledWith(expect.objectContaining({
      dedupeKey: 'GPS_SILENT:route-1:driver-1',
      severity: 'WARNING',
      type: 'GPS_SILENT'
    }));
    const opened = h.alerts.openOrObserve.mock.calls[0]?.[0] as { payload: { device: Record<string, unknown>; silentSeconds: number } };
    expect(opened.payload.silentSeconds).toBe(61);
    expect(opened.payload.device).toMatchObject({ lifecycle: 'FOREGROUND', locationTask: 'STARTED' });
    h.advance(75);
    await h.service.detectOperationalHealth();
    expect(h.alerts.openOrObserve).toHaveBeenCalledTimes(1);
    h.advance(301);
    await h.service.detectOperationalHealth();
    expect(h.alerts.openOrObserve).toHaveBeenLastCalledWith(expect.objectContaining({ severity: 'CRITICAL', type: 'GPS_SILENT' }));
    h.advance(302);
    (h.prisma.routePlan.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([route({ trackingGeometry: { lastReceivedAt: at(300) } })]);
    await h.service.detectOperationalHealth();
    expect(h.alerts.resolveByDedupeKey).toHaveBeenLastCalledWith(expect.objectContaining({ dedupeKey: 'GPS_SILENT:route-1:driver-1', resolutionCode: 'GPS_RESUMED' }));
  });

  test('does not alert for a healthy fix stream or for finished delivery work', async () => {
    const h = harness([route(), route({ deliveryWorkCompletedAt: at(-10), id: 'route-2', trackingGeometry: { lastReceivedAt: at(-3000) } }),
      route({ id: 'route-3', routeStops: [{ deliveryStop: { status: 'DELIVERED' } }], trackingGeometry: { lastReceivedAt: at(-3000) } })]);
    h.advance(20);
    await expect(h.service.detectOperationalHealth()).resolves.toEqual({ gpsSilent: 0, heartbeatAbsent: 0, routesChecked: 3 });
    expect(h.alerts.openOrObserve).not.toHaveBeenCalled();
  });

  test('refreshes an open alert at most once a minute so a 15 second scan stays cheap', async () => {
    const h = harness([route()]);
    for (const seconds of [61, 76, 91, 106, 121, 136]) {
      h.advance(seconds);
      await h.service.detectOperationalHealth();
    }
    expect(h.alerts.openOrObserve).toHaveBeenCalledTimes(2);
  });
});
