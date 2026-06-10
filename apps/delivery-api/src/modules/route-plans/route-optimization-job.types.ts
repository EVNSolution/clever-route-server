import type { Prisma } from '@prisma/client';
import type { RouteOptimizationResult } from './route-engine-route-optimizer.client.js';

export type RouteOptimizationJobStatus = 'QUEUED' | 'RUNNING' | 'APPLIED' | 'TIMEOUT' | 'FAILED' | 'CANCELLED';

export type RouteOptimizationJobStep = 'QUEUED' | 'CALLING_ENGINE' | 'APPLYING_RESULT' | 'COMPLETED';

export type RouteOptimizationJobDto = {
  appliedAt: string | null;
  createdAt: string;
  createdBy: string | null;
  currentStep: RouteOptimizationJobStep;
  elapsedMs: number | null;
  engineResultSequence: Prisma.JsonValue;
  errorCode: string | null;
  errorMessage: string | null;
  finishedAt: string | null;
  id: string;
  invalidatedReason: string | null;
  routePlanId: string;
  shopId: string;
  startedAt: string | null;
  status: RouteOptimizationJobStatus;
  timeoutBudgetMs: number;
  traceId: string;
  updatedAt: string;
};

export type CreateRouteOptimizationJobInput = {
  createdBy?: string | null | undefined;
  queueStartBudgetMs?: number | undefined;
  routePlanId: string;
  shopDomain: string;
  timeoutBudgetMs: number;
  traceId?: string | undefined;
};

export type FindRouteOptimizationJobInput = {
  jobId: string;
  routePlanId: string;
  shopDomain: string;
};

export type FindLatestRouteOptimizationJobInput = {
  routePlanId: string;
  shopDomain: string;
};

export type ReconcileRouteOptimizationJobsInput = {
  queueStartBudgetMs?: number | undefined;
  routePlanId?: string | undefined;
  shopDomain: string;
};

export type RouteOptimizationJobRepository = {
  createJob(input: CreateRouteOptimizationJobInput): Promise<RouteOptimizationJobDto | null>;
  findJob(input: FindRouteOptimizationJobInput): Promise<RouteOptimizationJobDto | null>;
  findLatestJob(input: FindLatestRouteOptimizationJobInput): Promise<RouteOptimizationJobDto | null>;
  markApplied(input: {
    engineResultSequence: RouteOptimizationResult['stops'];
    jobId: string;
  }): Promise<RouteOptimizationJobDto | null>;
  markApplyingResult(input: { jobId: string }): Promise<RouteOptimizationJobDto | null>;
  markFailed(input: {
    elapsedMs?: number | null | undefined;
    errorCode: string;
    errorMessage: string;
    jobId: string;
  }): Promise<RouteOptimizationJobDto | null>;
  markRunning(input: { jobId: string }): Promise<RouteOptimizationJobDto | null>;
  markTimedOut(input: {
    elapsedMs?: number | null | undefined;
    errorCode?: string | undefined;
    errorMessage?: string | undefined;
    jobId: string;
  }): Promise<RouteOptimizationJobDto | null>;
  reconcileStaleActiveJobs(input: ReconcileRouteOptimizationJobsInput): Promise<RouteOptimizationJobDto[]>;
};

export class RouteOptimizationJobActiveError extends Error {
  readonly code = 'ROUTE_OPTIMIZATION_JOB_ACTIVE';

  constructor(message = 'A route optimization job is already active for this route.') {
    super(message);
    this.name = 'RouteOptimizationJobActiveError';
  }
}
