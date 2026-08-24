import { afterEach, describe, expect, test, vi } from 'vitest';
import type { AddressInfo } from 'node:net';

import { buildApp } from '../src/app.js';
import { ROUTE_TRACKING_V1_POLICY } from '../src/modules/route-tracking/route-tracking.policy.js';
import { RouteTrackingStreamHub } from '../src/modules/route-tracking/route-tracking.stream.js';
import type { AdminRoutePlanDependencies } from '../src/routes/admin-route-plans.routes.js';

const openApps: Array<Awaited<ReturnType<typeof buildApp>>> = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
});

describe('Admin route tracking routes', () => {
  test('returns a scoped v1 tracking snapshot with server policy and bounded positions', async () => {
    const { dependencies, getRouteTrackingSnapshot, routePlanExists } = createDependencyHarness();
    const app = await buildApp({ adminRoutePlans: dependencies });
    openApps.push(app);

    const response = await app.inject({
      headers: { authorization: 'Bearer session-token', 'x-clever-app-id': 'clever-route-dev' },
      method: 'GET',
      url: '/admin/route-plans/route-plan-id/tracking'
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: trackingSnapshot(),
      error: null
    });
    expect(routePlanExists).toHaveBeenCalledWith({
      appId: 'clever-route-dev',
      routePlanId: 'route-plan-id',
      shopDomain: 'example.myshopify.com'
    });
    expect(getRouteTrackingSnapshot).toHaveBeenCalledWith({ routePlanId: 'route-plan-id' });
  });

  test('streams exact tracking_snapshot and tracking_position SSE envelopes', async () => {
    const routeTrackingStreamHub = new RouteTrackingStreamHub();
    const { dependencies } = createDependencyHarness({ routeTrackingStreamHub });
    const app = await buildApp({ adminRoutePlans: dependencies });
    openApps.push(app);
    await app.listen({ port: 0 });
    const address = app.server.address() as AddressInfo;
    const abortController = new AbortController();

    const response = await fetch(`http://127.0.0.1:${address.port}/admin/route-plans/route-plan-id/tracking/stream`, {
      headers: { authorization: 'Bearer session-token', 'x-clever-app-id': 'clever-route-dev' },
      signal: abortController.signal
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store, no-transform');
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('x-accel-buffering')).toBe('no');

    routeTrackingStreamHub.publishPosition({
      driverId: 'driver-id',
      eventId: 'driver-event-2',
      latitude: 43.7,
      longitude: -79.4,
      occurredAt: '2026-05-07T12:00:20.000Z',
      receivedAt: '2026-05-07T12:00:21.000Z',
      routePlanId: 'route-plan-id',
      schemaVersion: 'route_tracking.v1'
    });
    routeTrackingStreamHub.publishProgress({
      deliveryStopId: 'stop-id',
      driverId: 'driver-id',
      eventId: 'driver-progress-2',
      eventType: 'STOP_ARRIVED',
      occurredAt: '2026-05-07T12:00:22.000Z',
      receivedAt: '2026-05-07T12:00:23.000Z',
      routePlanId: 'route-plan-id',
      schemaVersion: 'route_tracking.v1'
    });

    const body = await readUntil(response, 'driver-progress-2');
    abortController.abort();
    expect(body).toContain('retry: 3000');
    expect(body).toContain('event: tracking_snapshot');
    expect(body).toContain(`data: ${JSON.stringify(trackingSnapshot())}`);
    expect(body).toContain('event: tracking_position');
    expect(body).toContain('"schemaVersion":"route_tracking.v1"');
    expect(body).toContain('"routePlanId":"route-plan-id"');
    expect(body).toContain('"eventId":"driver-event-2"');
    expect(body).toContain('"driverId":"driver-id"');
    expect(body).toContain('"latitude":43.7');
    expect(body).toContain('"longitude":-79.4');
    expect(body).toContain('"occurredAt":"2026-05-07T12:00:20.000Z"');
    expect(body).toContain('"receivedAt":"2026-05-07T12:00:21.000Z"');
    expect(body).toContain('event: tracking_progress');
    expect(body).toContain('"eventType":"STOP_ARRIVED"');
  });

  test('queues a committed position while the reconnect snapshot is loading', async () => {
    const routeTrackingStreamHub = new RouteTrackingStreamHub();
    const { dependencies } = createDependencyHarness({ routeTrackingStreamHub });
    let releaseSnapshot: (() => void) | undefined;
    let markSnapshotStarted: (() => void) | undefined;
    const snapshotStarted = new Promise<void>((resolve) => { markSnapshotStarted = resolve; });
    const snapshotReleased = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
    dependencies.routeTrackingService = {
      getRouteTrackingSnapshot: vi.fn(async () => {
        markSnapshotStarted?.();
        await snapshotReleased;
        return trackingSnapshot();
      })
    };
    const app = await buildApp({ adminRoutePlans: dependencies });
    openApps.push(app);
    await app.listen({ port: 0 });
    const address = app.server.address() as AddressInfo;
    const abortController = new AbortController();

    const responsePromise = fetch(`http://127.0.0.1:${address.port}/admin/route-plans/route-plan-id/tracking/stream`, {
      headers: { authorization: 'Bearer session-token', 'x-clever-app-id': 'clever-route-dev' },
      signal: abortController.signal
    });
    await snapshotStarted;
    routeTrackingStreamHub.publishPosition({
      driverId: 'driver-id',
      eventId: 'during-snapshot',
      latitude: 43.71,
      longitude: -79.41,
      occurredAt: '2026-05-07T12:00:30.000Z',
      receivedAt: '2026-05-07T12:00:31.000Z',
      routePlanId: 'route-plan-id',
      schemaVersion: 'route_tracking.v1'
    });
    releaseSnapshot?.();

    const response = await responsePromise;
    const body = await readUntil(response, 'during-snapshot');
    abortController.abort();
    expect(body).toContain('event: tracking_snapshot');
    expect(body).toContain('event: tracking_position');
    expect(body).toContain('"eventId":"during-snapshot"');
  });

  test('reconciles durable GPS missed by the process-local stream hub on heartbeat', async () => {
    let heartbeat: (() => void) | undefined;
    const routeTrackingStreamHub = new RouteTrackingStreamHub();
    const { dependencies, getRouteTrackingSnapshot } = createDependencyHarness({ routeTrackingStreamHub });
    const reconciledSnapshot = trackingSnapshot({
      eventId: 'driver-event-from-another-process',
      latitude: 43.71,
      longitude: -79.41,
      occurredAt: '2026-05-07T12:00:30.000Z',
      receivedAt: '2026-05-07T12:00:31.000Z'
    });
    getRouteTrackingSnapshot
      .mockResolvedValueOnce(trackingSnapshot())
      .mockResolvedValueOnce(reconciledSnapshot);
    const app = await buildApp({ adminRoutePlans: dependencies });
    openApps.push(app);
    await app.listen({ port: 0 });
    const address = app.server.address() as AddressInfo;
    const abortController = new AbortController();
    vi.spyOn(globalThis, 'setInterval').mockImplementation((callback) => {
      heartbeat = callback;
      return { unref: vi.fn() } as unknown as NodeJS.Timeout;
    });

    const response = await fetch(`http://127.0.0.1:${address.port}/admin/route-plans/route-plan-id/tracking/stream`, {
      headers: { authorization: 'Bearer session-token', 'x-clever-app-id': 'clever-route-dev' },
      signal: abortController.signal
    });
    expect(response.status).toBe(200);
    heartbeat?.();
    const body = await readUntil(response, 'driver-event-from-another-process');
    abortController.abort();

    expect(body.match(/event: tracking_snapshot/g)).toHaveLength(2);
    expect(body).toContain('"eventId":"driver-event-from-another-process"');
  });

  test('redacts caught route tracking stream errors even when caller serializers request raw errors', async () => {
    const privateMessage = 'token=stream-secret stream@example.invalid +1 416 555 0109 91 Stream Avenue';
    const logLines: string[] = [];
    let heartbeat: (() => void) | undefined;
    const routeTrackingStreamHub = new RouteTrackingStreamHub();
    const { dependencies, getRouteTrackingSnapshot } = createDependencyHarness({ routeTrackingStreamHub });
    getRouteTrackingSnapshot
      .mockResolvedValueOnce(trackingSnapshot())
      .mockRejectedValueOnce(new Error(privateMessage));
    vi.spyOn(globalThis, 'setInterval').mockImplementation((callback) => {
      heartbeat = callback;
      return { unref: vi.fn() } as unknown as NodeJS.Timeout;
    });
    const app = await buildApp({
      adminRoutePlans: dependencies,
      logger: {
        level: 'warn',
        serializers: {
          err: () => ({ message: privateMessage, stack: privateMessage, type: 'RawError' }),
          error: () => ({ message: privateMessage, stack: privateMessage })
        },
        stream: { write: (line: string) => logLines.push(line) }
      }
    });
    openApps.push(app);
    await app.listen({ port: 0 });
    const address = app.server.address() as AddressInfo;
    const abortController = new AbortController();

    const response = await fetch(`http://127.0.0.1:${address.port}/admin/route-plans/route-plan-id/tracking/stream`, {
      headers: { authorization: 'Bearer session-token', 'x-clever-app-id': 'clever-route-dev' },
      signal: abortController.signal
    });
    expect(response.status).toBe(200);
    heartbeat?.();
    await vi.waitFor(() => expect(logLines.join('\n')).toContain('Route tracking stream reconciliation failed'));
    abortController.abort();

    const serialized = logLines.join('\n');
    expect(serialized).toContain('errorCode');
    expect(serialized).not.toContain(privateMessage);
    expect(serialized).not.toContain('stream-secret');
    expect(serialized).not.toContain('stream@example.invalid');
    expect(serialized).not.toContain('stack');
  });
});

function createDependencyHarness(input: {
  routeTrackingStreamHub?: RouteTrackingStreamHub;
} = {}): {
  dependencies: AdminRoutePlanDependencies;
  getRouteTrackingSnapshot: ReturnType<
    typeof vi.fn<NonNullable<AdminRoutePlanDependencies['routeTrackingService']>['getRouteTrackingSnapshot']>
  >;
  routePlanExists: ReturnType<
    typeof vi.fn<NonNullable<AdminRoutePlanDependencies['routePlanService']['routePlanExists']>>
  >;
} {
  const routePlanExists = vi.fn<NonNullable<AdminRoutePlanDependencies['routePlanService']['routePlanExists']>>(
    () => Promise.resolve(true)
  );
  const getRouteTrackingSnapshot = vi.fn<
    NonNullable<AdminRoutePlanDependencies['routeTrackingService']>['getRouteTrackingSnapshot']
  >(() => Promise.resolve(trackingSnapshot()));
  const noopDetail = vi.fn(() => Promise.resolve(null));
  return {
    dependencies: {
      routePlanService: {
        assignRoutePlanDriver: noopDetail,
        createRoutePlan: vi.fn() as never,
        deleteRoutePlan: vi.fn() as never,
        getRoutePlanDetail: noopDetail,
        listRoutePlans: vi.fn() as never,
        publishRoutePlan: noopDetail,
        routePlanExists,
        updateRoutePlanOptions: noopDetail,
        updateRoutePlanStops: noopDetail
      },
      routeTrackingService: { getRouteTrackingSnapshot },
      ...(input.routeTrackingStreamHub === undefined ? {} : { routeTrackingStreamHub: input.routeTrackingStreamHub }),
      sessionTokenVerifier: {
        verify: vi.fn(() => ({
          appId: 'clever-route-dev',
          shopDomain: 'example.myshopify.com',
          subject: 'shopify-user-id'
        }))
      }
    },
    getRouteTrackingSnapshot,
    routePlanExists
  };
}

function trackingSnapshot(positionOverrides: Partial<{
  eventId: string;
  latitude: number;
  longitude: number;
  occurredAt: string;
  receivedAt: string;
}> = {}) {
  const position = {
    driverId: 'driver-id',
    eventId: 'driver-event-1',
    latitude: 43.65,
    longitude: -79.38,
    occurredAt: '2026-05-07T12:00:00.000Z',
    receivedAt: '2026-05-07T12:00:01.000Z',
    routePlanId: 'route-plan-id',
    schemaVersion: 'route_tracking.v1' as const,
    ...positionOverrides
  };
  return {
    latestPosition: position,
    policy: ROUTE_TRACKING_V1_POLICY,
    progress: {
      completedStopIds: ['stop-completed'],
      currentStage: 'AT_STOP' as const,
      currentStopId: 'stop-current',
      failedStopIds: [],
      latestEvent: {
        deliveryStopId: 'stop-current',
        driverId: 'driver-id',
        eventId: 'driver-progress-1',
        eventType: 'STOP_ARRIVED' as const,
        occurredAt: '2026-05-07T12:00:05.000Z',
        receivedAt: '2026-05-07T12:00:06.000Z',
        routePlanId: 'route-plan-id',
        schemaVersion: 'route_tracking.v1' as const
      }
    },
    recentPositions: [position],
    routePlanId: 'route-plan-id',
    schemaVersion: 'route_tracking.v1' as const,
    serverTime: '2026-05-07T12:00:10.000Z',
    status: 'LIVE' as const
  };
}

async function readUntil(response: Response, expected: string): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error('missing response body');
  const decoder = new TextDecoder();
  let body = '';
  for (let index = 0; index < 20; index += 1) {
    const result = await reader.read();
    if (result.value instanceof Uint8Array) {
      body += decoder.decode(result.value, { stream: !result.done });
    }
    if (body.includes(expected) || result.done) return body;
  }
  throw new Error(`stream did not include ${expected}`);
}
