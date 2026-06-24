import { describe, expect, test, vi } from 'vitest';

import { PrismaRouteOptimizationJobRepository } from '../src/modules/route-plans/route-optimization-job.repository.js';
import { RouteOptimizationJobActiveError } from '../src/modules/route-plans/route-optimization-job.types.js';

describe('PrismaRouteOptimizationJobRepository', () => {
  test('reconciles stale QUEUED jobs before creating a new active job', async () => {
    const staleQueued = jobRecord({
      createdAt: new Date('2026-06-10T07:31:00.000Z'),
      id: 'stale-job-id',
      status: 'QUEUED'
    });
    const created = jobRecord({ id: 'new-job-id', status: 'QUEUED' });
    const prisma = createPrismaHarness({ activeJobs: [staleQueued], createdJob: created });
    const repository = new PrismaRouteOptimizationJobRepository(prisma as unknown as ConstructorParameters<typeof PrismaRouteOptimizationJobRepository>[0]);

    const result = await repository.createJob({
      queueStartBudgetMs: 100,
      routePlanId: 'route-plan-id',
      shopDomain: 'Example.myshopify.com',
      timeoutBudgetMs: 30000,
      traceId: 'trace-id'
    });

    expect(prisma.shop.findUnique).toHaveBeenCalledWith({ select: { id: true }, where: { appId_shopDomain: { appId: 'clever', shopDomain: 'example.myshopify.com' } } });
    const staleUpdate = readFirstCallArg(prisma.routeOptimizationJob.update);
    expect(staleUpdate?.data).toMatchObject({
      currentStep: 'COMPLETED',
      errorCode: 'queue_start_timeout',
      status: 'FAILED'
    });
    expect(staleUpdate?.where).toEqual({ id: 'stale-job-id' });
    const createCall = readFirstDataArg(prisma.routeOptimizationJob.create);
    expect(createCall?.data).toMatchObject({
      routePlanId: 'route-plan-id',
      shopId: 'shop-id',
      status: 'QUEUED',
      timeoutBudgetMs: 30000,
      traceId: 'trace-id'
    });
    expect(result?.id).toBe('new-job-id');
  });

  test('rejects create when a non-stale active job remains after reconciliation', async () => {
    const active = jobRecord({ createdAt: new Date(), id: 'active-job-id', status: 'QUEUED' });
    const prisma = createPrismaHarness({ activeAfterReconcile: active, activeJobs: [] });
    const repository = new PrismaRouteOptimizationJobRepository(prisma as unknown as ConstructorParameters<typeof PrismaRouteOptimizationJobRepository>[0]);

    await expect(repository.createJob({
      routePlanId: 'route-plan-id',
      shopDomain: 'example.myshopify.com',
      timeoutBudgetMs: 30000
    })).rejects.toBeInstanceOf(RouteOptimizationJobActiveError);

    expect(prisma.routeOptimizationJob.create).not.toHaveBeenCalled();
  });

  test('translates active-job unique races to RouteOptimizationJobActiveError', async () => {
    const prisma = createPrismaHarness({ createError: Object.assign(new Error('unique active job'), { code: 'P2002' }) });
    const repository = new PrismaRouteOptimizationJobRepository(prisma as unknown as ConstructorParameters<typeof PrismaRouteOptimizationJobRepository>[0]);

    await expect(repository.createJob({
      routePlanId: 'route-plan-id',
      shopDomain: 'example.myshopify.com',
      timeoutBudgetMs: 30000
    })).rejects.toBeInstanceOf(RouteOptimizationJobActiveError);
  });

  test('job lookups are read-only and do not reconcile stale jobs', async () => {
    const staleRunning = jobRecord({
      createdAt: new Date('2026-06-10T07:31:00.000Z'),
      id: 'running-job-id',
      startedAt: new Date('2026-06-10T07:31:00.000Z'),
      status: 'RUNNING',
      timeoutBudgetMs: 1
    });
    const prisma = createPrismaHarness({ activeJobs: [staleRunning], latestJob: staleRunning });
    const repository = new PrismaRouteOptimizationJobRepository(prisma as unknown as ConstructorParameters<typeof PrismaRouteOptimizationJobRepository>[0]);

    const latest = await repository.findLatestJob({ routePlanId: 'route-plan-id', shopDomain: 'example.myshopify.com' });

    expect(latest?.id).toBe('running-job-id');
    expect(prisma.routeOptimizationJob.update).not.toHaveBeenCalled();
  });

  test('reconciles stale RUNNING jobs to TIMEOUT on explicit reconciliation', async () => {
    const staleRunning = jobRecord({
      createdAt: new Date('2026-06-10T07:31:00.000Z'),
      id: 'running-job-id',
      startedAt: new Date('2026-06-10T07:31:00.000Z'),
      status: 'RUNNING',
      timeoutBudgetMs: 1
    });
    const prisma = createPrismaHarness({ activeJobs: [staleRunning], latestJob: staleRunning });
    const repository = new PrismaRouteOptimizationJobRepository(prisma as unknown as ConstructorParameters<typeof PrismaRouteOptimizationJobRepository>[0]);

    await repository.reconcileStaleActiveJobs({ routePlanId: 'route-plan-id', shopDomain: 'example.myshopify.com' });

    const runningUpdate = readFirstCallArg(prisma.routeOptimizationJob.update);
    expect(runningUpdate?.data).toMatchObject({
      currentStep: 'COMPLETED',
      errorCode: 'solver_timeout',
      status: 'TIMEOUT'
    });
    expect(runningUpdate?.where).toEqual({ id: 'running-job-id' });
  });

  test('does not resurrect terminal jobs when recording applied results', async () => {
    const terminal = jobRecord({ currentStep: 'COMPLETED', id: 'timed-out-job-id', status: 'TIMEOUT' });
    const prisma = createPrismaHarness({ currentJob: terminal });
    const repository = new PrismaRouteOptimizationJobRepository(prisma as unknown as ConstructorParameters<typeof PrismaRouteOptimizationJobRepository>[0]);

    const result = await repository.markApplied({
      engineResultSequence: [{ deliveryStopId: 'stop-id', sequence: 1, shopifyOrderGid: 'gid://shopify/Order/1' }],
      jobId: 'timed-out-job-id'
    });

    expect(result).toBeNull();
    expect(prisma.routeOptimizationJob.updateMany).not.toHaveBeenCalled();
  });

  test('claims apply step only for running jobs', async () => {
    const failed = jobRecord({ currentStep: 'COMPLETED', id: 'failed-job-id', status: 'FAILED' });
    const prisma = createPrismaHarness({ currentJob: failed });
    const repository = new PrismaRouteOptimizationJobRepository(prisma as unknown as ConstructorParameters<typeof PrismaRouteOptimizationJobRepository>[0]);

    const result = await repository.markApplyingResult({ jobId: 'failed-job-id' });

    expect(result).toBeNull();
    expect(prisma.routeOptimizationJob.updateMany).not.toHaveBeenCalled();
  });
});

type RouteOptimizationJobWriteCall = {
  data: Record<string, unknown>;
  where: { id: string };
};

type MockWithCalls = {
  mock: { calls: unknown[][] };
};

function readFirstCallArg(mock: MockWithCalls): RouteOptimizationJobWriteCall | undefined {
  const value = mock.mock.calls[0]?.[0];
  return isRouteOptimizationJobWriteCall(value) ? value : undefined;
}

function readFirstDataArg(mock: MockWithCalls): { data: Record<string, unknown> } | undefined {
  const value = mock.mock.calls[0]?.[0];
  return isDataCall(value) ? value : undefined;
}

function isRouteOptimizationJobWriteCall(value: unknown): value is RouteOptimizationJobWriteCall {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { data?: unknown; where?: unknown };
  return typeof candidate.data === 'object' && candidate.data !== null && isWhereId(candidate.where);
}

function isDataCall(value: unknown): value is { data: Record<string, unknown> } {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { data?: unknown };
  return typeof candidate.data === 'object' && candidate.data !== null;
}

function isWhereId(value: unknown): value is { id: string } {
  return typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'string';
}

function createPrismaHarness(input: {
  activeAfterReconcile?: ReturnType<typeof jobRecord> | null;
  activeJobs?: Array<ReturnType<typeof jobRecord>>;
  createError?: Error & { code: string };
  createdJob?: ReturnType<typeof jobRecord>;
  currentJob?: ReturnType<typeof jobRecord> | null;
  latestJob?: ReturnType<typeof jobRecord> | null;
  updateManyCount?: number;
} = {}) {
  const routeOptimizationJob = {
    create: vi.fn().mockImplementation(() => input.createError === undefined
      ? Promise.resolve(input.createdJob ?? jobRecord({ id: 'created-job-id' }))
      : Promise.reject(input.createError)),
    findFirst: vi.fn().mockResolvedValue(input.activeAfterReconcile ?? null),
    findMany: vi.fn().mockResolvedValue(input.activeJobs ?? []),
    findUnique: vi.fn().mockResolvedValue(input.currentJob ?? null),
    update: vi.fn().mockImplementation((call: RouteOptimizationJobWriteCall) => Promise.resolve({
      ...jobRecord({ id: call.where.id }),
      ...call.data,
      updatedAt: new Date()
    })),
    updateMany: vi.fn().mockResolvedValue({ count: input.updateManyCount ?? 1 })
  };
  routeOptimizationJob.findFirst.mockImplementation((args?: { orderBy?: unknown }) => {
    if (args?.orderBy !== undefined) {
      return Promise.resolve(input.latestJob ?? null);
    }
    return Promise.resolve(input.activeAfterReconcile ?? null);
  });
  const prisma = {
    $transaction: vi.fn((callback: (tx: unknown) => unknown) => callback(prisma)),
    routeOptimizationJob,
    routePlan: {
      findFirst: vi.fn().mockResolvedValue({ id: 'route-plan-id' })
    },
    shop: {
      findUnique: vi.fn().mockResolvedValue({ id: 'shop-id' })
    }
  };
  return prisma;
}

function jobRecord(input: Partial<{
  appliedAt: Date | null;
  createdAt: Date;
  currentStep: string;
  elapsedMs: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  finishedAt: Date | null;
  id: string;
  startedAt: Date | null;
  status: string;
  timeoutBudgetMs: number;
}> = {}) {
  const createdAt = input.createdAt ?? new Date('2026-06-10T07:32:00.000Z');
  return {
    appliedAt: input.appliedAt ?? null,
    createdAt,
    createdBy: null,
    currentStep: input.currentStep ?? 'QUEUED',
    elapsedMs: input.elapsedMs ?? null,
    engineResultSequence: null,
    errorCode: input.errorCode ?? null,
    errorMessage: input.errorMessage ?? null,
    finishedAt: input.finishedAt ?? null,
    id: input.id ?? 'job-id',
    invalidatedReason: null,
    routePlanId: 'route-plan-id',
    shopId: 'shop-id',
    startedAt: input.startedAt ?? null,
    status: input.status ?? 'QUEUED',
    timeoutBudgetMs: input.timeoutBudgetMs ?? 30000,
    traceId: 'trace-id',
    updatedAt: createdAt
  };
}
