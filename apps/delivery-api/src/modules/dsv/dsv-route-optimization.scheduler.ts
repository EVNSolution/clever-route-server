import { runRouteOptimizationJob } from '../route-plans/route-optimization-job-runner.js';
import type { RouteOptimizationJobService } from '../route-plans/route-optimization-job.service.js';
import { RouteOptimizationJobActiveError } from '../route-plans/route-optimization-job.types.js';
import type { RouteOptimizationService } from '../route-plans/route-optimization.types.js';
import type { RoutePlanService } from '../route-plans/route-plan.types.js';

export type DsvRouteOptimizationScheduleInput = {
  routePlanIds: Array<string | null>;
  shopDomain: string;
};

export type DsvRouteOptimizationSchedulerPort = {
  schedule(input: DsvRouteOptimizationScheduleInput): void;
};

type DsvRouteOptimizationSchedulerOptions = {
  debounceMs?: number | undefined;
  retryMs?: number | undefined;
  timeoutBudgetMs?: number | undefined;
};

type PendingRouteOptimization = {
  generation: number;
  key: string;
  routePlanId: string;
  running: boolean;
  shopDomain: string;
  timer: NodeJS.Timeout | null;
};

const DEFAULT_DEBOUNCE_MS = 750;
const DEFAULT_RETRY_MS = 1_000;
const DEFAULT_TIMEOUT_BUDGET_MS = 45_000;

export class DsvRouteOptimizationScheduler implements DsvRouteOptimizationSchedulerPort {
  private readonly debounceMs: number;
  private readonly pending = new Map<string, PendingRouteOptimization>();
  private readonly retryMs: number;
  private readonly timeoutBudgetMs: number;

  constructor(
    private readonly services: {
      routeOptimizationJobService: Pick<RouteOptimizationJobService, 'createJob' | 'findLatestJob' | 'markApplyingResult' | 'markRunning' | 'recordEngineOutcome'>;
      routeOptimizationService: RouteOptimizationService;
      routePlanService: Pick<RoutePlanService, 'getRoutePlanDetail' | 'updateRoutePlanStops'>;
    },
    options: DsvRouteOptimizationSchedulerOptions = {},
  ) {
    this.debounceMs = normalizeDelay(options.debounceMs, DEFAULT_DEBOUNCE_MS);
    this.retryMs = normalizeDelay(options.retryMs, DEFAULT_RETRY_MS);
    this.timeoutBudgetMs = normalizeDelay(options.timeoutBudgetMs, DEFAULT_TIMEOUT_BUDGET_MS);
  }

  schedule(input: DsvRouteOptimizationScheduleInput): void {
    const shopDomain = normalizeShopDomain(input.shopDomain);
    const routePlanIds = [...new Set(input.routePlanIds.flatMap((value) => {
      const normalized = value?.trim();
      return normalized === undefined || normalized === '' ? [] : [normalized];
    }))];

    for (const routePlanId of routePlanIds) {
      const key = `${shopDomain}\u0000${routePlanId}`;
      const current = this.pending.get(key);
      if (current !== undefined) {
        current.generation += 1;
        if (!current.running) this.arm(current, this.debounceMs);
        continue;
      }

      const pending: PendingRouteOptimization = {
        generation: 1,
        key,
        routePlanId,
        running: false,
        shopDomain,
        timer: null,
      };
      this.pending.set(key, pending);
      this.arm(pending, this.debounceMs);
    }
  }

  private arm(pending: PendingRouteOptimization, delayMs: number): void {
    if (pending.running) return;
    if (pending.timer !== null) clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      pending.timer = null;
      void this.run(pending);
    }, delayMs);
    pending.timer.unref();
  }

  private async run(pending: PendingRouteOptimization): Promise<void> {
    if (pending.running || this.pending.get(pending.key) !== pending) return;
    pending.running = true;
    const generation = pending.generation;
    let retry = false;

    try {
      const detail = await this.services.routePlanService.getRoutePlanDetail({
        routePlanId: pending.routePlanId,
        shopDomain: pending.shopDomain,
      });
      if (
        detail === null
        || detail.routePlan.driverId === null
        || detail.routePlan.driverId === undefined
        || detail.stops.length < 2
      ) {
        return;
      }

      const job = await this.services.routeOptimizationJobService.createJob({
        createdBy: 'SYSTEM_WORKER',
        routePlanId: pending.routePlanId,
        shopDomain: pending.shopDomain,
        timeoutBudgetMs: this.timeoutBudgetMs,
        traceId: `dsv-route-opt:${pending.routePlanId}:${Date.now().toString(36)}`,
      });
      if (job === null) return;

      await runRouteOptimizationJob({
        initialDetail: detail,
        job,
        rejectStaleRouteShape: true,
        services: this.services,
        shopDomain: pending.shopDomain,
      });
    } catch (error) {
      retry = error instanceof RouteOptimizationJobActiveError;
    } finally {
      pending.running = false;
      if (this.pending.get(pending.key) === pending) {
        if (retry || pending.generation !== generation) {
          this.arm(pending, retry ? this.retryMs : this.debounceMs);
        } else {
          this.pending.delete(pending.key);
        }
      }
    }
  }
}

function normalizeDelay(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : fallback;
}

function normalizeShopDomain(value: string): string {
  return value.trim().toLowerCase();
}
