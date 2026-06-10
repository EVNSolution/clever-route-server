import type {
  RouteOptimizationOutcome,
  RouteOptimizationFailureCode,
  RouteOptimizationService,
} from './route-engine-route-optimizer.client.js';
import type { RouteOptimizationJobService } from './route-optimization-job.service.js';
import type { RouteOptimizationJobDto } from './route-optimization-job.types.js';
import type { RoutePlanDetail, RoutePlanService } from './route-plan.types.js';

type RouteOptimizationJobRunnerLogger = {
  info?(bindings: Record<string, unknown>, message: string): void;
  warn?(bindings: Record<string, unknown>, message: string): void;
};

export type RouteOptimizationJobRunnerServices = {
  routeOptimizationJobService: Pick<
    RouteOptimizationJobService,
    'findLatestJob' | 'markApplyingResult' | 'markRunning' | 'recordEngineOutcome'
  >;
  routeOptimizationService?: RouteOptimizationService | undefined;
  routePlanService: Pick<RoutePlanService, 'getRoutePlanDetail' | 'updateRoutePlanStops'>;
};

export type RunRouteOptimizationJobInput = {
  initialDetail: RoutePlanDetail | null;
  job: RouteOptimizationJobDto;
  logger?: RouteOptimizationJobRunnerLogger | undefined;
  sanitizeError?: ((error: unknown) => string) | undefined;
  services: RouteOptimizationJobRunnerServices;
  shopDomain: string;
};

export async function runRouteOptimizationJob(
  input: RunRouteOptimizationJobInput,
): Promise<void> {
  const jobService = input.services.routeOptimizationJobService;
  const running = await jobService.markRunning(input.job.id);
  if (running === null) {
    input.logger?.warn?.(
      { jobId: input.job.id, routePlanId: input.job.routePlanId },
      'route optimization job disappeared before execution',
    );
    return;
  }

  const startedAt = Date.now();
  const detail =
    input.initialDetail ??
    (await input.services.routePlanService.getRoutePlanDetail({
      routePlanId: input.job.routePlanId,
      shopDomain: input.shopDomain,
    }));
  if (detail === null) {
    await jobService.recordEngineOutcome({
      jobId: input.job.id,
      outcome: routeOptimizationFailureOutcome({
        code: 'invalid_input',
        elapsedMs: elapsedSince(startedAt),
        message: 'Route plan was not found before route optimization could run.',
      }),
    });
    return;
  }

  const sanitizeError = input.sanitizeError ?? defaultSanitizeRouteOptimizationError;
  let outcome: RouteOptimizationOutcome;
  try {
    outcome = await runRouteOptimizationEngine({
      detail,
      routeOptimizationService: input.services.routeOptimizationService,
      shopDomain: input.shopDomain,
      startedAt,
    });
  } catch (error) {
    outcome = routeOptimizationFailureOutcome({
      code: 'route_engine_unavailable',
      elapsedMs: elapsedSince(startedAt),
      message: `Route Engine optimization failed unexpectedly: ${sanitizeError(error)}`,
    });
  }

  if (!outcome.ok) {
    await jobService.recordEngineOutcome({ jobId: input.job.id, outcome });
    return;
  }

  const latest = await jobService.findLatestJob({
    routePlanId: input.job.routePlanId,
    shopDomain: input.shopDomain,
  });
  if (latest?.id !== input.job.id) {
    await jobService.recordEngineOutcome({
      jobId: input.job.id,
      outcome: routeOptimizationFailureOutcome({
        code: 'invalid_input',
        elapsedMs: elapsedSince(startedAt),
        message: 'Route optimization result was not applied because a newer optimization job exists.',
      }),
    });
    return;
  }
  if (latest.status !== 'RUNNING') {
    input.logger?.warn?.(
      {
        jobId: input.job.id,
        routePlanId: input.job.routePlanId,
        status: latest.status,
      },
      'route optimization result skipped because job is no longer running',
    );
    return;
  }

  const applying = await jobService.markApplyingResult(input.job.id);
  if (applying === null) {
    input.logger?.warn?.(
      { jobId: input.job.id, routePlanId: input.job.routePlanId },
      'route optimization result skipped because job could not claim the apply step',
    );
    return;
  }
  try {
    const updated = await input.services.routePlanService.updateRoutePlanStops({
      mutationContext: {
        jobId: input.job.id,
        source: 'route_optimization_job',
      },
      payload: { stops: outcome.result.stops },
      routePlanId: input.job.routePlanId,
      shopDomain: input.shopDomain,
    });
    if (updated === null) {
      await jobService.recordEngineOutcome({
        jobId: input.job.id,
        outcome: routeOptimizationFailureOutcome({
          code: 'invalid_input',
          elapsedMs: elapsedSince(startedAt),
          message: 'Route optimization result could not be applied because the route plan was not found.',
        }),
      });
      return;
    }
  } catch (error) {
    await jobService.recordEngineOutcome({
      jobId: input.job.id,
      outcome: routeOptimizationFailureOutcome({
        code: 'invalid_input',
        elapsedMs: elapsedSince(startedAt),
        message: `Route optimization result could not be applied: ${sanitizeError(error)}`,
      }),
    });
    return;
  }

  const applied = await jobService.recordEngineOutcome({ jobId: input.job.id, outcome });
  if (applied === null) {
    input.logger?.warn?.(
      { jobId: input.job.id, routePlanId: input.job.routePlanId },
      'route optimization result applied to stops but terminal job state was no longer claimable',
    );
    return;
  }
  input.logger?.info?.(
    {
      jobId: input.job.id,
      routePlanId: input.job.routePlanId,
      shopDomain: input.shopDomain,
      stopsCount: outcome.result.stops.length,
    },
    'route optimization job applied route_engine result',
  );
}

async function runRouteOptimizationEngine(input: {
  detail: RoutePlanDetail;
  routeOptimizationService: RouteOptimizationService | undefined;
  shopDomain: string;
  startedAt: number;
}): Promise<RouteOptimizationOutcome> {
  if (input.routeOptimizationService === undefined) {
    return routeOptimizationFailureOutcome({
      code: 'route_engine_unavailable',
      elapsedMs: elapsedSince(input.startedAt),
      message: 'Route Engine optimization service is not configured.',
    });
  }

  if (input.routeOptimizationService.optimizeStopOrderWithDiagnostics !== undefined) {
    return input.routeOptimizationService.optimizeStopOrderWithDiagnostics({
      detail: input.detail,
      shopDomain: input.shopDomain,
    });
  }

  const result = await input.routeOptimizationService.optimizeStopOrder({
    detail: input.detail,
    shopDomain: input.shopDomain,
  });
  if (result === null || result.source !== 'route_engine') {
    return routeOptimizationFailureOutcome({
      code: 'fallback_not_applied',
      elapsedMs: elapsedSince(input.startedAt),
      message: 'Legacy route optimization service did not return a route_engine result; no fallback was applied.',
    });
  }
  return { ok: true, result };
}

function routeOptimizationFailureOutcome(input: {
  code: RouteOptimizationFailureCode;
  elapsedMs: number;
  message: string;
}): RouteOptimizationOutcome {
  return {
    failure: {
      code: input.code,
      elapsedMs: input.elapsedMs,
      message: input.message,
    },
    ok: false,
  };
}

function elapsedSince(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

function defaultSanitizeRouteOptimizationError(error: unknown): string {
  return error instanceof Error && error.name === 'AbortError'
    ? 'Route Engine request aborted'
    : 'Route Engine optimization failed';
}
