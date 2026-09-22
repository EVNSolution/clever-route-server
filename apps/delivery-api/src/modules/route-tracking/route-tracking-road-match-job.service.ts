import type {
  RouteTrackingRoadMatchClassifyingProvider,
  RouteTrackingRoadMatchOutcome,
  RouteTrackingRoadMatchProvider,
} from './route-tracking.road-match.js';
import type {
  PrismaRouteTrackingRoadMatchJobRepository,
  RouteTrackingRoadMatchJob,
} from './route-tracking-road-match-job.repository.js';

type RepositoryLike = Pick<
  PrismaRouteTrackingRoadMatchJobRepository,
  'loadInput' | 'markDead' | 'markSucceededWithoutPath' | 'publishMatchedPath' | 'releaseForRetry' | 'renewLease' | 'requeueIfSuperseded'
>;

type LoggerLike = {
  info?(bindings: unknown, message?: string): void;
  warn?(bindings: unknown, message?: string): void;
};

export class RouteTrackingRoadMatchJobService {
  constructor(
    private readonly repository: RepositoryLike,
    private readonly provider: RouteTrackingRoadMatchProvider,
    private readonly options: { leaseMs: number; maxAttempts: number; retryBaseDelayMs: number; retryMaxDelayMs: number },
    private readonly logger?: LoggerLike,
  ) {}

  async process(job: RouteTrackingRoadMatchJob, fixedNow?: Date): Promise<void> {
    const input = await this.repository.loadInput(job);
    const settledAt = (): Date => fixedNow ?? new Date();
    if (input === null || !matchesClaimedInput(input, job)) {
      const now = settledAt();
      if (!await this.repository.requeueIfSuperseded({ job, now })) {
        await this.retryOrDead(job, now, 'ROUTE_TRACKING_ROAD_MATCH_INPUT_UNAVAILABLE', 'The claimed raw route tracking input is unavailable.');
      }
      return;
    }

    let outcome: RouteTrackingRoadMatchOutcome;
    try {
      outcome = await this.withLeaseHeartbeat(job, () => (
        isClassifyingProvider(this.provider)
          ? this.provider.matchWithStatus(input)
          : this.provider.match(input).then((path) => ({ path, retryable: false }))
      ));
    } catch (error) {
      outcome = { path: null, retryable: true };
      this.logger?.warn?.(
        { errorCode: 'ROUTE_TRACKING_ROAD_MATCH_PROVIDER_ERROR', message: errorMessage(error), routePlanId: job.routePlanId },
        'route tracking road match provider failed',
      );
    }

    const now = settledAt();
    if (outcome.retryable) {
      await this.retryOrDead(job, now, 'ROUTE_TRACKING_ROAD_MATCH_RETRYABLE', 'Road matching returned a retryable outcome.');
      return;
    }
    if (outcome.path === null) {
      if (!await this.repository.markSucceededWithoutPath({ job, now })) {
        await this.repository.requeueIfSuperseded({ job, now });
      }
      return;
    }
    if (
      outcome.path.inputPointCount !== job.targetSourcePointCount
      || Date.parse(outcome.path.lastInputOccurredAt) !== job.targetLastInputOccurredAt.getTime()
    ) {
      await this.retryOrDead(job, now, 'ROUTE_TRACKING_ROAD_MATCH_OUTPUT_VERSION_MISMATCH', 'Road matching returned a result for a different input version.');
      return;
    }
    const published = await this.repository.publishMatchedPath({ job, now, path: outcome.path });
    if (published) {
      this.logger?.info?.(
        { attemptCount: job.attemptCount, routePlanId: job.routePlanId },
        'route tracking road match job completed',
      );
    } else {
      await this.repository.requeueIfSuperseded({ job, now });
    }
  }

  private async retryOrDead(job: RouteTrackingRoadMatchJob, now: Date, errorCode: string, errorMessageText: string): Promise<void> {
    if (job.attemptCount < this.options.maxAttempts) {
      const released = await this.repository.releaseForRetry({
        errorCode,
        errorMessage: errorMessageText,
        job,
        nextAttemptAt: new Date(now.getTime() + retryDelayMs(job.attemptCount, this.options)),
      });
      if (!released) await this.repository.requeueIfSuperseded({ job, now });
      return;
    }
    if (!await this.repository.markDead({ errorCode, errorMessage: errorMessageText, job, now })) {
      await this.repository.requeueIfSuperseded({ job, now });
    }
  }

  private async withLeaseHeartbeat<T>(job: RouteTrackingRoadMatchJob, operation: () => Promise<T>): Promise<T> {
    const heartbeatMs = Math.max(1_000, Math.floor(this.options.leaseMs / 3));
    let renewing = false;
    const timer = setInterval(() => {
      if (renewing) return;
      renewing = true;
      void this.repository.renewLease({ job, leaseMs: this.options.leaseMs, now: new Date() })
        .catch((error) => {
          this.logger?.warn?.(
            { errorCode: 'ROUTE_TRACKING_ROAD_MATCH_LEASE_RENEWAL_FAILED', message: errorMessage(error), routePlanId: job.routePlanId },
            'route tracking road match lease renewal failed',
          );
        })
        .finally(() => { renewing = false; });
    }, heartbeatMs);
    timer.unref?.();
    try {
      return await operation();
    } finally {
      clearInterval(timer);
    }
  }
}

function isClassifyingProvider(provider: RouteTrackingRoadMatchProvider): provider is RouteTrackingRoadMatchClassifyingProvider {
  return typeof (provider as Partial<RouteTrackingRoadMatchClassifyingProvider>).matchWithStatus === 'function';
}

function matchesClaimedInput(
  input: { samples: Array<{ occurredAt: string }>; sourcePointCount: number },
  job: RouteTrackingRoadMatchJob,
): boolean {
  return input.sourcePointCount === job.targetSourcePointCount
    && Date.parse(input.samples.at(-1)?.occurredAt ?? '') === job.targetLastInputOccurredAt.getTime();
}

function retryDelayMs(
  attemptCount: number,
  options: { retryBaseDelayMs: number; retryMaxDelayMs: number },
): number {
  return Math.min(options.retryMaxDelayMs, options.retryBaseDelayMs * (2 ** Math.max(0, attemptCount - 1)));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : 'Unknown error';
}
