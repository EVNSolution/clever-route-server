import type { RouteOptimizationOutcome } from './route-engine-route-optimizer.client.js';
import type {
  CreateRouteOptimizationJobInput,
  FindLatestRouteOptimizationJobInput,
  FindRouteOptimizationJobInput,
  ReconcileRouteOptimizationJobsInput,
  RouteOptimizationJobDto,
  RouteOptimizationJobRepository
} from './route-optimization-job.types.js';

export class RouteOptimizationJobService {
  constructor(private readonly repository: RouteOptimizationJobRepository) {}

  createJob(input: CreateRouteOptimizationJobInput): Promise<RouteOptimizationJobDto | null> {
    return this.repository.createJob(input);
  }

  findJob(input: FindRouteOptimizationJobInput): Promise<RouteOptimizationJobDto | null> {
    return this.repository.findJob(input);
  }

  findLatestJob(input: FindLatestRouteOptimizationJobInput): Promise<RouteOptimizationJobDto | null> {
    return this.repository.findLatestJob(input);
  }

  markRunning(jobId: string): Promise<RouteOptimizationJobDto | null> {
    return this.repository.markRunning({ jobId });
  }

  markApplyingResult(jobId: string): Promise<RouteOptimizationJobDto | null> {
    return this.repository.markApplyingResult({ jobId });
  }

  recordEngineOutcome(input: { jobId: string; outcome: RouteOptimizationOutcome }): Promise<RouteOptimizationJobDto | null> {
    if (input.outcome.ok) {
      return this.repository.markApplied({
        engineResultSequence: input.outcome.result.stops,
        jobId: input.jobId
      });
    }

    if (input.outcome.failure.code === 'solver_timeout') {
      return this.repository.markTimedOut({
        elapsedMs: input.outcome.failure.elapsedMs,
        errorCode: input.outcome.failure.code,
        errorMessage: input.outcome.failure.message,
        jobId: input.jobId
      });
    }

    return this.repository.markFailed({
      elapsedMs: input.outcome.failure.elapsedMs,
      errorCode: input.outcome.failure.code,
      errorMessage: input.outcome.failure.message,
      jobId: input.jobId
    });
  }

  reconcileStaleActiveJobs(input: ReconcileRouteOptimizationJobsInput): Promise<RouteOptimizationJobDto[]> {
    return this.repository.reconcileStaleActiveJobs(input);
  }
}
