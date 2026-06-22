import { describe, expect, test, vi } from 'vitest';

import { RouteOptimizationJobService } from '../src/modules/route-plans/route-optimization-job.service.js';
import type { RouteOptimizationJobRepository } from '../src/modules/route-plans/route-optimization-job.types.js';

const job = {
  appliedAt: null,
  createdAt: '2026-06-10T07:32:00.000Z',
  createdBy: null,
  currentStep: 'QUEUED' as const,
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
  status: 'QUEUED' as const,
  timeoutBudgetMs: 30000,
  traceId: 'trace-id',
  updatedAt: '2026-06-10T07:32:00.000Z'
};

describe('RouteOptimizationJobService', () => {
  test('records successful engine outcome as applied with stop sequence', async () => {
    const { markApplied, repository } = createRepository();
    const service = new RouteOptimizationJobService(repository);

    await service.recordEngineOutcome({
      jobId: 'job-id',
      outcome: {
        ok: true,
        result: {
          missingCoordinateStops: 0,
          source: 'vroom',
          stops: [{ deliveryStopId: 'stop-2', sequence: 1, shopifyOrderGid: 'gid://woocommerce/Order/2' }]
        }
      }
    });

    expect(markApplied).toHaveBeenCalledWith({
      engineResultSequence: [{ deliveryStopId: 'stop-2', sequence: 1, shopifyOrderGid: 'gid://woocommerce/Order/2' }],
      jobId: 'job-id'
    });
  });

  test('records solver timeout as TIMEOUT instead of generic failure', async () => {
    const { markFailed, markTimedOut, repository } = createRepository();
    const service = new RouteOptimizationJobService(repository);

    await service.recordEngineOutcome({
      jobId: 'job-id',
      outcome: {
        failure: {
          code: 'solver_timeout',
          elapsedMs: 30001,
          message: 'route_engine request timed out.'
        },
        ok: false
      }
    });

    expect(markTimedOut).toHaveBeenCalledWith({
      elapsedMs: 30001,
      errorCode: 'solver_timeout',
      errorMessage: 'route_engine request timed out.',
      jobId: 'job-id'
    });
    expect(markFailed).not.toHaveBeenCalled();
  });

  test('records graph-not-ready and invalid payload as typed failures', async () => {
    const { markFailed, repository } = createRepository();
    const service = new RouteOptimizationJobService(repository);

    await service.recordEngineOutcome({
      jobId: 'job-id',
      outcome: {
        failure: {
          code: 'graph_not_ready',
          elapsedMs: 12,
          httpStatus: 503,
          message: 'route_engine responded with HTTP 503.'
        },
        ok: false
      }
    });

    expect(markFailed).toHaveBeenCalledWith({
      elapsedMs: 12,
      errorCode: 'graph_not_ready',
      errorMessage: 'route_engine responded with HTTP 503.',
      jobId: 'job-id'
    });
  });
});

function createRepository() {
  const createJob = vi.fn().mockResolvedValue(job);
  const findJob = vi.fn().mockResolvedValue(job);
  const findLatestJob = vi.fn().mockResolvedValue(job);
  const markApplied = vi.fn().mockResolvedValue({ ...job, status: 'APPLIED' as const });
  const markApplyingResult = vi.fn().mockResolvedValue({ ...job, currentStep: 'APPLYING_RESULT' as const });
  const markFailed = vi.fn().mockResolvedValue({ ...job, status: 'FAILED' as const });
  const markRunning = vi.fn().mockResolvedValue({ ...job, status: 'RUNNING' as const });
  const markTimedOut = vi.fn().mockResolvedValue({ ...job, status: 'TIMEOUT' as const });
  const reconcileStaleActiveJobs = vi.fn().mockResolvedValue([]);
  const repository = {
    createJob,
    findJob,
    findLatestJob,
    markApplied,
    markApplyingResult,
    markFailed,
    markRunning,
    markTimedOut,
    reconcileStaleActiveJobs
  } satisfies RouteOptimizationJobRepository;
  return { markApplied, markFailed, markTimedOut, repository };
}
