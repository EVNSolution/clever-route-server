import type { PrismaClient } from '@prisma/client';

import { readConfiguredCoverageBaseUrls, type RouteEngineRuntimeEnv } from '../route-plans/route-engine-coverage.js';
import { PrismaRouteTrackingRoadMatchJobRepository } from './route-tracking-road-match-job.repository.js';
import { OsrmRouteTrackingRoadMatchProvider } from './route-tracking.road-match.js';
import { RouteTrackingRoadMatchWorker } from './route-tracking-road-match.worker.js';

export type RouteTrackingRoadMatchRuntimeEnv = RouteEngineRuntimeEnv & Partial<Record<
  | 'ROUTE_TRACKING_ROAD_MATCH_BATCH_SIZE'
  | 'ROUTE_TRACKING_ROAD_MATCH_CONCURRENCY'
  | 'ROUTE_TRACKING_ROAD_MATCH_LEASE_MS'
  | 'ROUTE_TRACKING_ROAD_MATCH_MAX_ATTEMPTS'
  | 'ROUTE_TRACKING_ROAD_MATCH_POLL_INTERVAL_MS'
  | 'ROUTE_TRACKING_ROAD_MATCH_RETRY_BASE_DELAY_MS'
  | 'ROUTE_TRACKING_ROAD_MATCH_RETRY_MAX_DELAY_MS'
  | 'ROUTE_TRACKING_ROAD_MATCH_TIMEOUT_MS',
  string
>>;

type LoggerLike = {
  error(bindings: unknown, message?: string): void;
  info(bindings: unknown, message?: string): void;
  warn(bindings: unknown, message?: string): void;
};

export type RouteTrackingRoadMatchRuntime = {
  close(): Promise<void>;
  start(): void;
};

export function createRouteTrackingRoadMatchRuntime(input: {
  env: RouteTrackingRoadMatchRuntimeEnv;
  logger: LoggerLike;
  prisma: PrismaClient;
}): RouteTrackingRoadMatchRuntime {
  const baseUrls = readConfiguredCoverageBaseUrls(input.env, 'OSRM');
  if (Object.keys(baseUrls).length === 0) return noOpRuntime();

  const provider = new OsrmRouteTrackingRoadMatchProvider({
    baseUrls,
    timeoutMs: readPositiveInteger(input.env.ROUTE_TRACKING_ROAD_MATCH_TIMEOUT_MS) ?? 30_000,
  });
  const worker = new RouteTrackingRoadMatchWorker(
    new PrismaRouteTrackingRoadMatchJobRepository(input.prisma),
    provider,
    {
      ...optionalNumber('batchSize', input.env.ROUTE_TRACKING_ROAD_MATCH_BATCH_SIZE),
      ...optionalNumber('concurrency', input.env.ROUTE_TRACKING_ROAD_MATCH_CONCURRENCY),
      ...optionalNumber('leaseMs', input.env.ROUTE_TRACKING_ROAD_MATCH_LEASE_MS),
      ...optionalNumber('maxAttempts', input.env.ROUTE_TRACKING_ROAD_MATCH_MAX_ATTEMPTS),
      ...optionalNumber('pollIntervalMs', input.env.ROUTE_TRACKING_ROAD_MATCH_POLL_INTERVAL_MS),
      ...optionalNumber('retryBaseDelayMs', input.env.ROUTE_TRACKING_ROAD_MATCH_RETRY_BASE_DELAY_MS),
      ...optionalNumber('retryMaxDelayMs', input.env.ROUTE_TRACKING_ROAD_MATCH_RETRY_MAX_DELAY_MS),
    },
    input.logger,
  );
  return {
    close: () => worker.close(),
    start: () => worker.start(),
  };
}

function noOpRuntime(): RouteTrackingRoadMatchRuntime {
  return { close: () => Promise.resolve(), start: () => undefined };
}

function optionalNumber<Key extends string>(key: Key, value: string | undefined): Partial<Record<Key, number>> {
  const parsed = readPositiveInteger(value);
  return parsed === undefined ? {} : { [key]: parsed } as Partial<Record<Key, number>>;
}

function readPositiveInteger(value: string | undefined): number | undefined {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
