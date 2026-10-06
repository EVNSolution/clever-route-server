import { afterEach, describe, expect, test, vi } from 'vitest';

import { DsvRouteOptimizationScheduler } from '../src/modules/dsv/dsv-route-optimization.scheduler.js';
import type { RoutePlanDetail } from '../src/modules/route-plans/route-plan.types.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('DsvRouteOptimizationScheduler', () => {
  test('returns immediately, coalesces route changes, and runs optimization after the quiet period', async () => {
    vi.useFakeTimers();
    const detail = routeDetail();
    const job = {
      id: 'job-1',
      routePlanId: detail.routePlan.id,
      status: 'QUEUED',
    };
    const createJob = vi.fn().mockResolvedValue(job);
    const getRoutePlanDetail = vi.fn().mockResolvedValue(detail);
    const refreshRouteGeometryForRoutePlan = vi.fn();
    const updateRoutePlanStops = vi.fn().mockResolvedValue(detail);
    const optimizeStopOrderWithDiagnostics = vi.fn().mockResolvedValue({
      ok: true,
      result: {
        missingCoordinateStops: 0,
        source: 'osrm-trip',
        stops: [
          { deliveryStopId: 'stop-2', sequence: 1, shopifyOrderGid: 'gid://dsv/Order/2' },
          { deliveryStopId: 'stop-1', sequence: 2, shopifyOrderGid: 'gid://dsv/Order/1' },
        ],
      },
    });
    const scheduler = new DsvRouteOptimizationScheduler({
      routeOptimizationJobService: {
        createJob,
        findLatestJob: vi.fn().mockResolvedValue({ ...job, status: 'RUNNING' }),
        markApplyingResult: vi.fn().mockResolvedValue({ ...job, status: 'RUNNING' }),
        markRunning: vi.fn().mockResolvedValue({ ...job, status: 'RUNNING' }),
        recordEngineOutcome: vi.fn().mockResolvedValue({ ...job, status: 'APPLIED' }),
      },
      routeOptimizationService: {
        optimizeStopOrder: vi.fn(),
        optimizeStopOrderWithDiagnostics,
      },
      routePlanService: {
        getRoutePlanDetail,
        refreshRouteGeometryForRoutePlan,
        updateRoutePlanStops,
      },
    }, { debounceMs: 50 });

    scheduler.schedule({ routePlanIds: ['route-1'], shopDomain: 'DSV-DEMO.LOCAL' });
    scheduler.schedule({ routePlanIds: ['route-1'], shopDomain: 'dsv-demo.local' });

    expect(getRoutePlanDetail).not.toHaveBeenCalled();
    expect(createJob).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(49);
    expect(createJob).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(createJob).toHaveBeenCalledTimes(1);
    expect(refreshRouteGeometryForRoutePlan).not.toHaveBeenCalled();
    expect(optimizeStopOrderWithDiagnostics).toHaveBeenCalledTimes(1);
    expect(updateRoutePlanStops).toHaveBeenCalledWith(expect.objectContaining({
      mutationContext: { jobId: 'job-1', source: 'route_optimization_job' },
      routePlanId: 'route-1',
      shopDomain: 'dsv-demo.local',
    }));
  });

  test('logs a structured warning when an optimization job cannot be created', async () => {
    vi.useFakeTimers();
    const logger = { warn: vi.fn() };
    const scheduler = new DsvRouteOptimizationScheduler({
      routeOptimizationJobService: {
        createJob: vi.fn().mockRejectedValue(new Error('database unavailable')),
        findLatestJob: vi.fn(),
        markApplyingResult: vi.fn(),
        markRunning: vi.fn(),
        recordEngineOutcome: vi.fn(),
      },
      routeOptimizationService: {
        optimizeStopOrder: vi.fn(),
      },
      routePlanService: {
        getRoutePlanDetail: vi.fn().mockResolvedValue(routeDetail()),
        refreshRouteGeometryForRoutePlan: vi.fn(),
        updateRoutePlanStops: vi.fn(),
      },
    }, { debounceMs: 0, logger });

    scheduler.schedule({ routePlanIds: ['route-1'], shopDomain: 'dsv-demo.local' });
    await vi.advanceTimersByTimeAsync(0);

    expect(logger.warn).toHaveBeenCalledWith({
      errorType: 'Error',
      event: 'dsv_route_optimization_schedule_failed',
      routePlanId: 'route-1',
      shopDomain: 'dsv-demo.local',
    }, 'DSV route optimization scheduling failed');
  });

  test('refreshes geometry to materialize planned ETA for an assigned single-stop route', async () => {
    vi.useFakeTimers();
    const detail = routeDetail();
    detail.routePlan.stopsCount = 1;
    detail.stops = [detail.stops[0]!];
    const createJob = vi.fn();
    const refreshRouteGeometryForRoutePlan = vi.fn().mockResolvedValue(detail);
    const scheduler = new DsvRouteOptimizationScheduler({
      routeOptimizationJobService: {
        createJob,
        findLatestJob: vi.fn(),
        markApplyingResult: vi.fn(),
        markRunning: vi.fn(),
        recordEngineOutcome: vi.fn(),
      },
      routeOptimizationService: { optimizeStopOrder: vi.fn() },
      routePlanService: {
        getRoutePlanDetail: vi.fn().mockResolvedValue(detail),
        refreshRouteGeometryForRoutePlan,
        updateRoutePlanStops: vi.fn(),
      },
    }, { debounceMs: 0 });

    scheduler.schedule({ routePlanIds: ['route-1'], shopDomain: 'DSV-DEMO.LOCAL' });
    await vi.advanceTimersByTimeAsync(0);

    expect(refreshRouteGeometryForRoutePlan).toHaveBeenCalledWith({
      routePlanId: 'route-1',
      shopDomain: 'dsv-demo.local',
      source: 'EXPLICIT_REFRESH',
    });
    expect(createJob).not.toHaveBeenCalled();
  });

  test.each(['FAILED', 'TIMEOUT'] as const)(
    'falls back to geometry-only ETA generation when READY route optimization ends as %s',
    async (jobStatus) => {
      vi.useFakeTimers();
      const detail = routeDetail();
      const job = {
        id: 'job-timeout',
        routePlanId: detail.routePlan.id,
        status: 'QUEUED',
      };
      const refreshRouteGeometryForRoutePlan = vi.fn().mockResolvedValue(detail);
      const updateRoutePlanStops = vi.fn();
      const scheduler = new DsvRouteOptimizationScheduler({
        routeOptimizationJobService: {
          createJob: vi.fn().mockResolvedValue(job),
          findLatestJob: vi.fn().mockResolvedValue({ ...job, status: jobStatus }),
          markApplyingResult: vi.fn(),
          markRunning: vi.fn().mockResolvedValue({ ...job, status: 'RUNNING' }),
          recordEngineOutcome: vi.fn().mockResolvedValue({ ...job, status: jobStatus }),
        },
        routeOptimizationService: {
          optimizeStopOrder: vi.fn(),
          optimizeStopOrderWithDiagnostics: vi.fn().mockResolvedValue({
            failure: {
              code: jobStatus === 'TIMEOUT' ? 'solver_timeout' : 'network_error',
              elapsedMs: 10_000,
              message: 'OSRM Trip request failed.',
            },
            ok: false,
          }),
        },
        routePlanService: {
          getRoutePlanDetail: vi.fn().mockResolvedValue(detail),
          refreshRouteGeometryForRoutePlan,
          updateRoutePlanStops,
        },
      }, { debounceMs: 0 });

      scheduler.schedule({ routePlanIds: ['route-1'], shopDomain: 'DSV-DEMO.LOCAL' });
      await vi.advanceTimersByTimeAsync(0);

      expect(updateRoutePlanStops).not.toHaveBeenCalled();
      expect(refreshRouteGeometryForRoutePlan).toHaveBeenCalledWith({
        routePlanId: 'route-1',
        shopDomain: 'dsv-demo.local',
        source: 'EXPLICIT_REFRESH',
      });
    },
  );

  test.each(['IN_PROGRESS', 'COMPLETED'])('never optimizes or refreshes an assigned %s route', async (status) => {
    vi.useFakeTimers();
    const detail = routeDetail();
    detail.routePlan.status = status;
    const createJob = vi.fn();
    const optimizeStopOrder = vi.fn();
    const refreshRouteGeometryForRoutePlan = vi.fn();
    const scheduler = new DsvRouteOptimizationScheduler({
      routeOptimizationJobService: {
        createJob,
        findLatestJob: vi.fn(),
        markApplyingResult: vi.fn(),
        markRunning: vi.fn(),
        recordEngineOutcome: vi.fn(),
      },
      routeOptimizationService: { optimizeStopOrder },
      routePlanService: {
        getRoutePlanDetail: vi.fn().mockResolvedValue(detail),
        refreshRouteGeometryForRoutePlan,
        updateRoutePlanStops: vi.fn(),
      },
    }, { debounceMs: 0 });

    scheduler.schedule({ routePlanIds: ['route-1'], shopDomain: 'dsv-demo.local' });
    await vi.advanceTimersByTimeAsync(0);

    expect(createJob).not.toHaveBeenCalled();
    expect(optimizeStopOrder).not.toHaveBeenCalled();
    expect(refreshRouteGeometryForRoutePlan).not.toHaveBeenCalled();
  });

  test('skips empty and unassigned routes without refreshing geometry or creating jobs', async () => {
    vi.useFakeTimers();
    const empty = routeDetail();
    empty.routePlan.id = 'route-empty';
    empty.routePlan.stopsCount = 0;
    empty.stops = [];
    const unassigned = routeDetail();
    unassigned.routePlan.driverId = null;
    unassigned.routePlan.id = 'route-unassigned';
    const createJob = vi.fn();
    const refreshRouteGeometryForRoutePlan = vi.fn();
    const scheduler = new DsvRouteOptimizationScheduler({
      routeOptimizationJobService: {
        createJob,
        findLatestJob: vi.fn(),
        markApplyingResult: vi.fn(),
        markRunning: vi.fn(),
        recordEngineOutcome: vi.fn(),
      },
      routeOptimizationService: { optimizeStopOrder: vi.fn() },
      routePlanService: {
        getRoutePlanDetail: vi.fn()
          .mockResolvedValueOnce(empty)
          .mockResolvedValueOnce(unassigned),
        refreshRouteGeometryForRoutePlan,
        updateRoutePlanStops: vi.fn(),
      },
    }, { debounceMs: 0 });

    scheduler.schedule({ routePlanIds: ['route-empty', 'route-unassigned'], shopDomain: 'dsv-demo.local' });
    await vi.advanceTimersByTimeAsync(0);

    expect(refreshRouteGeometryForRoutePlan).not.toHaveBeenCalled();
    expect(createJob).not.toHaveBeenCalled();
  });
});

function routeDetail(): RoutePlanDetail {
  return {
    routeGeometry: null,
    routeMetrics: null,
    routePlan: {
      createdAt: '2026-07-31T00:00:00.000Z',
      deliveryAreas: ['서울'],
      deliveryDays: ['Friday'],
      depot: { latitude: 37.4563, longitude: 126.7052 },
      driverId: 'driver-1',
      id: 'route-1',
      missingCoordinates: 0,
      name: '서울 배송',
      planDate: '2026-07-31',
      routeEndMode: 'END_AT_LAST_STOP',
      status: 'READY',
      stopsCount: 2,
      updatedAt: '2026-07-31T00:00:00.000Z',
    },
    routeStopPoints: [],
    stops: [
      routeStop(1, 37.5665, 126.978),
      routeStop(2, 37.5172, 127.0473),
    ],
  };
}

function routeStop(sequence: number, latitude: number, longitude: number): RoutePlanDetail['stops'][number] {
  return {
    address: {
      address1: '서울특별시',
      address2: null,
      city: '서울',
      countryCode: 'KR',
      postalCode: null,
      province: null,
    },
    attributes: [],
    coordinates: { latitude, longitude },
    deliveryArea: '서울',
    deliveryDay: 'Friday',
    deliveryStopId: `stop-${sequence}`,
    financialStatus: null,
    fulfillmentStatus: null,
    orderId: `order-${sequence}`,
    orderName: `#${sequence}`,
    paymentStatus: null,
    recipientName: null,
    sequence,
    shopifyOrderGid: `gid://dsv/Order/${sequence}`,
    status: 'PENDING',
  };
}
