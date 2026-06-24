import type { Prisma, PrismaClient, RouteOptimizationJob } from '@prisma/client';

import {
  RouteOptimizationJobActiveError,
  type CreateRouteOptimizationJobInput,
  type FindLatestRouteOptimizationJobInput,
  type FindRouteOptimizationJobInput,
  type ReconcileRouteOptimizationJobsInput,
  type RouteOptimizationJobDto,
  type RouteOptimizationJobRepository
} from './route-optimization-job.types.js';
import { appScopedShopWhere } from '../shopify/shopify-app-scope.js';

const DEFAULT_QUEUE_START_BUDGET_MS = 10000;
const DEFAULT_TIMEOUT_BUDGET_MS = 180000;
const MAX_TIMEOUT_BUDGET_MS = 3600000;
const MIN_TIMEOUT_BUDGET_MS = 100;
const ACTIVE_JOB_STATUSES = ['QUEUED', 'RUNNING'] as const;

type RouteOptimizationJobPrismaClient = Pick<
  PrismaClient,
  '$transaction' | 'routeOptimizationJob' | 'routePlan' | 'shop'
>;

type RouteOptimizationJobRecord = RouteOptimizationJob;

export class PrismaRouteOptimizationJobRepository implements RouteOptimizationJobRepository {
  constructor(private readonly prisma: RouteOptimizationJobPrismaClient) {}

  async createJob(input: CreateRouteOptimizationJobInput): Promise<RouteOptimizationJobDto | null> {
    const shopDomain = normalizeShopDomain(input.shopDomain);
    const timeoutBudgetMs = normalizeTimeoutBudgetMs(input.timeoutBudgetMs);
    const queueStartBudgetMs = normalizeQueueStartBudgetMs(input.queueStartBudgetMs);

    return this.prisma.$transaction(async (tx) => {
      const shop = await tx.shop.findUnique({ select: { id: true }, where: appScopedShopWhere({ appId: input.appId, shopDomain }) });
      if (shop === null) return null;

      const routePlan = await tx.routePlan.findFirst({
        select: { id: true },
        where: { id: input.routePlanId, shopId: shop.id }
      });
      if (routePlan === null) return null;

      await reconcileStaleActiveJobsInTransaction(tx, {
        now: new Date(),
        queueStartBudgetMs,
        routePlanId: routePlan.id,
        shopId: shop.id
      });

      const activeJob = await tx.routeOptimizationJob.findFirst({
        select: { id: true },
        where: {
          routePlanId: routePlan.id,
          status: { in: [...ACTIVE_JOB_STATUSES] }
        }
      });
      if (activeJob !== null) {
        throw new RouteOptimizationJobActiveError();
      }

      const job = await tx.routeOptimizationJob.create({
        data: {
          createdBy: normalizeNullableText(input.createdBy),
          currentStep: 'QUEUED',
          routePlanId: routePlan.id,
          shopId: shop.id,
          status: 'QUEUED',
          timeoutBudgetMs,
          traceId: normalizeTraceId(input.traceId, routePlan.id)
        }
      }).catch((error: unknown) => {
        if (isPrismaUniqueConstraintError(error)) {
          throw new RouteOptimizationJobActiveError();
        }
        throw error;
      });

      return toRouteOptimizationJobDto(job);
    });
  }

  async findJob(input: FindRouteOptimizationJobInput): Promise<RouteOptimizationJobDto | null> {
    const shopDomain = normalizeShopDomain(input.shopDomain);
    return this.prisma.$transaction(async (tx) => {
      const shop = await tx.shop.findUnique({ select: { id: true }, where: appScopedShopWhere({ appId: input.appId, shopDomain }) });
      if (shop === null) return null;
      const job = await tx.routeOptimizationJob.findFirst({
        where: {
          id: input.jobId,
          routePlanId: input.routePlanId,
          shopId: shop.id
        }
      });
      return job === null ? null : toRouteOptimizationJobDto(job);
    });
  }

  async findLatestJob(input: FindLatestRouteOptimizationJobInput): Promise<RouteOptimizationJobDto | null> {
    const shopDomain = normalizeShopDomain(input.shopDomain);
    return this.prisma.$transaction(async (tx) => {
      const shop = await tx.shop.findUnique({ select: { id: true }, where: appScopedShopWhere({ appId: input.appId, shopDomain }) });
      if (shop === null) return null;
      const job = await tx.routeOptimizationJob.findFirst({
        orderBy: { createdAt: 'desc' },
        where: {
          routePlanId: input.routePlanId,
          shopId: shop.id
        }
      });
      return job === null ? null : toRouteOptimizationJobDto(job);
    });
  }

  async markRunning(input: { jobId: string }): Promise<RouteOptimizationJobDto | null> {
    const startedAt = new Date();
    return this.updateJobIfActive(input.jobId, {
      currentStep: 'CALLING_ENGINE',
      startedAt,
      status: 'RUNNING'
    }, {
      currentStep: 'QUEUED',
      status: 'QUEUED'
    });
  }

  async markApplyingResult(input: { jobId: string }): Promise<RouteOptimizationJobDto | null> {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.routeOptimizationJob.findUnique({ where: { id: input.jobId } });
      if (current === null || current.status !== 'RUNNING') return null;
      const now = new Date();
      if (isStaleActiveJob(current, now, DEFAULT_QUEUE_START_BUDGET_MS)) {
        await tx.routeOptimizationJob.update({
          data: {
            currentStep: 'COMPLETED',
            elapsedMs: elapsedMs(current.startedAt ?? current.createdAt, now),
            errorCode: 'solver_timeout',
            errorMessage: 'Route optimization exceeded its result wait limit before result application.',
            finishedAt: now,
            status: 'TIMEOUT'
          },
          where: { id: current.id }
        });
        return null;
      }

      const updated = await tx.routeOptimizationJob.updateMany({
        data: { currentStep: 'APPLYING_RESULT' },
        where: { id: input.jobId, status: 'RUNNING' }
      });
      if (updated.count === 0) return null;
      const claimed = await tx.routeOptimizationJob.findUnique({ where: { id: input.jobId } });
      return claimed === null ? null : toRouteOptimizationJobDto(claimed);
    });
  }

  async markApplied(input: { engineResultSequence: Array<{ deliveryStopId: string; sequence: number; shopifyOrderGid: string }>; jobId: string }): Promise<RouteOptimizationJobDto | null> {
    const now = new Date();
    const current = await this.prisma.routeOptimizationJob.findUnique({ where: { id: input.jobId } });
    if (current === null || current.status !== 'RUNNING' || current.currentStep !== 'APPLYING_RESULT') {
      return null;
    }
    return this.updateJobIfActive(input.jobId, {
      appliedAt: now,
      currentStep: 'COMPLETED',
      elapsedMs: elapsedMs(current?.startedAt ?? current?.createdAt ?? now, now),
      engineResultSequence: input.engineResultSequence,
      finishedAt: now,
      status: 'APPLIED'
    }, {
      currentStep: 'APPLYING_RESULT',
      status: 'RUNNING'
    });
  }

  async markTimedOut(input: {
    elapsedMs?: number | null | undefined;
    errorCode?: string | undefined;
    errorMessage?: string | undefined;
    jobId: string;
  }): Promise<RouteOptimizationJobDto | null> {
    const now = new Date();
    const current = await this.prisma.routeOptimizationJob.findUnique({ where: { id: input.jobId } });
    return this.updateJob(input.jobId, {
      currentStep: 'COMPLETED',
      elapsedMs: input.elapsedMs ?? elapsedMs(current?.startedAt ?? current?.createdAt ?? now, now),
      errorCode: input.errorCode ?? 'solver_timeout',
      errorMessage: safeErrorMessage(input.errorMessage ?? 'Route optimization timed out.'),
      finishedAt: now,
      status: 'TIMEOUT'
    });
  }

  async markFailed(input: {
    elapsedMs?: number | null | undefined;
    errorCode: string;
    errorMessage: string;
    jobId: string;
  }): Promise<RouteOptimizationJobDto | null> {
    const now = new Date();
    const current = await this.prisma.routeOptimizationJob.findUnique({ where: { id: input.jobId } });
    return this.updateJob(input.jobId, {
      currentStep: 'COMPLETED',
      elapsedMs: input.elapsedMs ?? elapsedMs(current?.startedAt ?? current?.createdAt ?? now, now),
      errorCode: normalizeErrorCode(input.errorCode),
      errorMessage: safeErrorMessage(input.errorMessage),
      finishedAt: now,
      status: 'FAILED'
    });
  }

  async reconcileStaleActiveJobs(input: ReconcileRouteOptimizationJobsInput): Promise<RouteOptimizationJobDto[]> {
    const shopDomain = normalizeShopDomain(input.shopDomain);
    return this.prisma.$transaction(async (tx) => {
      const shop = await tx.shop.findUnique({ select: { id: true }, where: appScopedShopWhere({ appId: input.appId, shopDomain }) });
      if (shop === null) return [];
      return reconcileStaleActiveJobsInTransaction(tx, {
        now: new Date(),
        queueStartBudgetMs: normalizeQueueStartBudgetMs(input.queueStartBudgetMs),
        routePlanId: input.routePlanId,
        shopId: shop.id
      });
    });
  }

  private async updateJob(jobId: string, data: Prisma.RouteOptimizationJobUpdateInput): Promise<RouteOptimizationJobDto | null> {
    const job = await this.prisma.routeOptimizationJob.update({ data, where: { id: jobId } }).catch((error: unknown) => {
      if (isPrismaNotFoundError(error)) return null;
      throw error;
    });
    return job === null ? null : toRouteOptimizationJobDto(job);
  }

  private async updateJobIfActive(
    jobId: string,
    data: Prisma.RouteOptimizationJobUpdateManyMutationInput,
    where: Pick<Prisma.RouteOptimizationJobWhereInput, 'currentStep' | 'status'>
  ): Promise<RouteOptimizationJobDto | null> {
    const result = await this.prisma.routeOptimizationJob.updateMany({
      data,
      where: { id: jobId, ...where }
    });
    if (result.count === 0) return null;
    const job = await this.prisma.routeOptimizationJob.findUnique({ where: { id: jobId } });
    return job === null ? null : toRouteOptimizationJobDto(job);
  }
}

async function reconcileStaleActiveJobsInTransaction(
  tx: Pick<Prisma.TransactionClient, 'routeOptimizationJob'>,
  input: { now: Date; queueStartBudgetMs: number; routePlanId?: string | undefined; shopId: string }
): Promise<RouteOptimizationJobDto[]> {
  const activeJobWhere: Prisma.RouteOptimizationJobWhereInput = {
    shopId: input.shopId,
    status: { in: [...ACTIVE_JOB_STATUSES] }
  };
  if (input.routePlanId !== undefined) {
    activeJobWhere.routePlanId = input.routePlanId;
  }

  const activeJobs = await tx.routeOptimizationJob.findMany({
    where: activeJobWhere
  });
  const staleJobs = activeJobs.filter((job) => isStaleActiveJob(job, input.now, input.queueStartBudgetMs));
  const updated: RouteOptimizationJobDto[] = [];

  for (const job of staleJobs) {
    const record = job;
    const status = record.status === 'RUNNING' ? 'TIMEOUT' : 'FAILED';
    const errorCode = record.status === 'RUNNING' ? 'solver_timeout' : 'queue_start_timeout';
    const errorMessage = record.status === 'RUNNING'
      ? 'Route optimization exceeded its result wait limit.'
      : 'Route optimization job did not start before the queue start budget.';
    const stale = await tx.routeOptimizationJob.update({
      data: {
        currentStep: 'COMPLETED',
        elapsedMs: elapsedMs(record.startedAt ?? record.createdAt, input.now),
        errorCode,
        errorMessage,
        finishedAt: input.now,
        status
      },
      where: { id: record.id }
    });
    updated.push(toRouteOptimizationJobDto(stale));
  }

  return updated;
}

function isStaleActiveJob(job: RouteOptimizationJobRecord, now: Date, queueStartBudgetMs: number): boolean {
  if (job.status === 'QUEUED') {
    return now.getTime() - job.createdAt.getTime() > queueStartBudgetMs;
  }
  if (job.status === 'RUNNING') {
    if (job.currentStep === 'APPLYING_RESULT') {
      return now.getTime() - job.updatedAt.getTime() > queueStartBudgetMs;
    }
    const startedAt = job.startedAt ?? job.createdAt;
    return now.getTime() - startedAt.getTime() > job.timeoutBudgetMs;
  }
  return false;
}

function toRouteOptimizationJobDto(job: RouteOptimizationJobRecord): RouteOptimizationJobDto {
  return {
    appliedAt: job.appliedAt?.toISOString() ?? null,
    createdAt: job.createdAt.toISOString(),
    createdBy: job.createdBy,
    currentStep: job.currentStep,
    elapsedMs: job.elapsedMs,
    engineResultSequence: job.engineResultSequence,
    errorCode: job.errorCode,
    errorMessage: job.errorMessage,
    finishedAt: job.finishedAt?.toISOString() ?? null,
    id: job.id,
    invalidatedReason: job.invalidatedReason,
    routePlanId: job.routePlanId,
    shopId: job.shopId,
    startedAt: job.startedAt?.toISOString() ?? null,
    status: job.status,
    timeoutBudgetMs: job.timeoutBudgetMs,
    traceId: job.traceId,
    updatedAt: job.updatedAt.toISOString()
  };
}

function normalizeShopDomain(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeTimeoutBudgetMs(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_TIMEOUT_BUDGET_MS;
  return Math.min(MAX_TIMEOUT_BUDGET_MS, Math.max(MIN_TIMEOUT_BUDGET_MS, Math.floor(value)));
}

function normalizeQueueStartBudgetMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_QUEUE_START_BUDGET_MS;
  return Math.min(MAX_TIMEOUT_BUDGET_MS, Math.max(MIN_TIMEOUT_BUDGET_MS, Math.floor(value)));
}

function normalizeNullableText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function normalizeTraceId(value: string | undefined, routePlanId: string): string {
  const trimmed = value?.trim() ?? '';
  if (trimmed !== '') return trimmed.slice(0, 128);
  return `route-opt:${routePlanId}:${Date.now().toString(36)}`;
}

function normalizeErrorCode(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_:-]+/gu, '_');
  return (normalized === '' ? 'route_optimization_failed' : normalized).slice(0, 128);
}

function safeErrorMessage(value: string): string {
  return value.replace(/Bearer\s+[^\s]+/giu, 'Bearer [redacted]').slice(0, 500);
}

function elapsedMs(startedAt: Date, finishedAt: Date): number {
  return Math.max(0, finishedAt.getTime() - startedAt.getTime());
}

function isPrismaNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2025';
}

function isPrismaUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}
