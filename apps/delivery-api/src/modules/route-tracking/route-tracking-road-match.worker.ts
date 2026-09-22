import type { RouteTrackingRoadMatchProvider } from './route-tracking.road-match.js';
import type {
  PrismaRouteTrackingRoadMatchJobRepository,
  RouteTrackingRoadMatchJob,
} from './route-tracking-road-match-job.repository.js';
import { RouteTrackingRoadMatchJobService } from './route-tracking-road-match-job.service.js';

type LoggerLike = {
  error?(bindings: unknown, message?: string): void;
  info?(bindings: unknown, message?: string): void;
  warn?(bindings: unknown, message?: string): void;
};

export type RouteTrackingRoadMatchWorkerOptions = {
  batchSize?: number;
  concurrency?: number;
  leaseMs?: number;
  maxAttempts?: number;
  pollIntervalMs?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
};

type ResolvedOptions = Required<RouteTrackingRoadMatchWorkerOptions>;

const defaults: ResolvedOptions = {
  batchSize: 8,
  concurrency: 2,
  leaseMs: 10 * 60 * 1000,
  maxAttempts: 6,
  pollIntervalMs: 2_000,
  retryBaseDelayMs: 15_000,
  retryMaxDelayMs: 15 * 60 * 1000,
};

type RepositoryLike = Pick<
  PrismaRouteTrackingRoadMatchJobRepository,
  'claimNext' | 'loadInput' | 'markDead' | 'markSucceededWithoutPath' | 'publishMatchedPath' | 'releaseForRetry' | 'renewLease' | 'requeueIfSuperseded'
>;

export class RouteTrackingRoadMatchWorker {
  private readonly options: ResolvedOptions;
  private readonly service: RouteTrackingRoadMatchJobService;
  private loopPromise: Promise<void> | null = null;
  private releaseWait: (() => void) | null = null;
  private stopped = true;

  constructor(
    private readonly repository: RepositoryLike,
    private readonly provider: RouteTrackingRoadMatchProvider,
    options: RouteTrackingRoadMatchWorkerOptions = {},
    private readonly logger?: LoggerLike,
  ) {
    this.options = {
      batchSize: positiveInteger(options.batchSize, defaults.batchSize),
      concurrency: positiveInteger(options.concurrency, defaults.concurrency),
      leaseMs: positiveInteger(options.leaseMs, defaults.leaseMs),
      maxAttempts: positiveInteger(options.maxAttempts, defaults.maxAttempts),
      pollIntervalMs: positiveInteger(options.pollIntervalMs, defaults.pollIntervalMs),
      retryBaseDelayMs: positiveInteger(options.retryBaseDelayMs, defaults.retryBaseDelayMs),
      retryMaxDelayMs: positiveInteger(options.retryMaxDelayMs, defaults.retryMaxDelayMs),
    };
    this.options.concurrency = Math.min(this.options.concurrency, this.options.batchSize);
    this.options.retryMaxDelayMs = Math.max(this.options.retryBaseDelayMs, this.options.retryMaxDelayMs);
    this.service = new RouteTrackingRoadMatchJobService(this.repository, this.provider, this.options, this.logger);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.loopPromise = this.runLoop();
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.releaseWait?.();
    await (this.loopPromise ?? Promise.resolve());
    this.loopPromise = null;
  }

  async runDueBatch(fixedNow?: Date): Promise<number> {
    const jobs: RouteTrackingRoadMatchJob[] = [];
    while (jobs.length < this.options.batchSize) {
      const job = await this.repository.claimNext({
        leaseMs: this.options.leaseMs,
        now: fixedNow ?? new Date(),
      });
      if (job === null) break;
      jobs.push(job);
    }
    for (let offset = 0; offset < jobs.length; offset += this.options.concurrency) {
      await Promise.all(jobs.slice(offset, offset + this.options.concurrency).map((job) => (
        this.service.process(job, fixedNow)
      )));
    }
    return jobs.length;
  }

  private async runLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        const processed = await this.runDueBatch();
        if (processed >= this.options.batchSize) continue;
      } catch (error) {
        this.logger?.error?.(
          { errorCode: 'ROUTE_TRACKING_ROAD_MATCH_WORKER_ITERATION_FAILED', message: errorMessage(error) },
          'route tracking road match worker iteration failed',
        );
      }
      if (this.stopped) break;
      await this.waitForNextPoll();
    }
  }

  private async waitForNextPoll(): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, this.options.pollIntervalMs);
      timer.unref?.();
      this.releaseWait = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    this.releaseWait = null;
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : 'Unknown error';
}
