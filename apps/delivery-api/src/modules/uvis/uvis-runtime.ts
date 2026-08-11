import type { PrismaClient } from '@prisma/client';

import { UvisClient } from './uvis-client.js';
import { loadUvisRuntimeConfig, type UvisRuntimeEnv } from './uvis-config.js';
import { PrismaUvisPollRepository } from './uvis-poll.repository.js';
import { PrismaUvisTelemetryRepository } from './uvis-telemetry.repository.js';
import { UvisTelemetryWorker, type UvisWorkerLogger } from './uvis-telemetry.worker.js';
import {
  PrismaUvisVehicleTrailMaterializationRepository,
  serviceDateForInstant,
  UVIS_ROAD_MATCH_GPS_PRECISION_METERS,
  UVIS_ROAD_MATCH_MAX_POINTS,
  UVIS_ROAD_MATCH_TIMEOUT_MS,
  UvisVehicleTrailMaterializationQueue,
} from './uvis-vehicle-trail-materializer.js';
import { readConfiguredCoverageBaseUrls, type RouteEngineRuntimeEnv } from '../route-plans/route-engine-coverage.js';
import { OsrmRouteTrackingRoadMatchProvider } from '../route-tracking/route-tracking.road-match.js';

export type UvisTelemetryRuntime = {
  close: () => Promise<void>;
  start: () => void;
};

export function createUvisTelemetryRuntime(input: {
  env?: UvisRuntimeEnv & RouteEngineRuntimeEnv & Partial<Record<'UVIS_ROAD_MATCH_TIMEOUT_MS', string>>;
  logger: UvisWorkerLogger;
  prisma: PrismaClient;
}): UvisTelemetryRuntime {
  const config = loadUvisRuntimeConfig(input.env ?? process.env);
  if (config === null) return noOpRuntime();

  const pollStore = new PrismaUvisPollRepository(input.prisma);
  const telemetryStore = new PrismaUvisTelemetryRepository(input.prisma);
  const roadMatchProvider = createRoadMatchProvider(input.env ?? process.env);
  const trailMaterializationQueue = new UvisVehicleTrailMaterializationQueue({
    logger: input.logger,
    repository: new PrismaUvisVehicleTrailMaterializationRepository(input.prisma),
    ...(roadMatchProvider === undefined ? {} : { roadMatchProvider }),
  });
  const worker = new UvisTelemetryWorker({
    appId: config.appId,
    client: new UvisClient(config.client),
    leaseDurationMs: Math.max(120_000, config.client.timeoutMs * 8),
    locationDormantGracePeriodMs: config.locationDormantGracePeriodMs,
    locationDormantHeartbeatIntervalMs: config.locationDormantHeartbeatIntervalMs,
    locationPollIntervalMs: config.locationPollIntervalMs,
    logger: input.logger,
    pollStore,
    shopDomain: config.shopDomain,
    telemetryStore,
    temperaturePollIntervalMs: config.temperaturePollIntervalMs,
    trailMaterializationQueue,
  });

  let timer: NodeJS.Timeout | null = null;
  let midnightTimer: NodeJS.Timeout | null = null;
  let lastServiceDate = serviceDateForInstant(new Date());
  let active: Promise<void> | null = null;
  const trigger = (): void => {
    if (active !== null) return;
    active = worker.runOnce()
      .catch(() => {
        input.logger.error({ errorCode: 'RUNTIME_ERROR' }, 'UVIS telemetry runtime iteration failed');
      })
      .finally(() => {
        active = null;
      });
  };

  return {
    async close() {
      if (timer !== null) clearInterval(timer);
      if (midnightTimer !== null) clearInterval(midnightTimer);
      timer = null;
      midnightTimer = null;
      await (active ?? Promise.resolve());
    },
    start() {
      if (timer !== null) return;
      void trailMaterializationQueue.recoverCurrentDay().catch(() => {
        input.logger.warn({}, 'UVIS trail current-day recovery failed');
      });
      void trailMaterializationQueue.finalizePreviousDay().catch(() => {
        input.logger.warn({}, 'UVIS trail previous-day finalization failed');
      });
      trigger();
      timer = setInterval(trigger, Math.min(config.locationPollIntervalMs, config.temperaturePollIntervalMs));
      timer.unref();
      midnightTimer = setInterval(() => {
        const serviceDate = serviceDateForInstant(new Date());
        if (serviceDate === lastServiceDate) return;
        lastServiceDate = serviceDate;
        void trailMaterializationQueue.finalizePreviousDay().catch(() => {
          input.logger.warn({}, 'UVIS trail previous-day finalization failed');
        });
      }, 60_000);
      midnightTimer.unref();
    },
  };
}

function noOpRuntime(): UvisTelemetryRuntime {
  return {
    close: () => Promise.resolve(),
    start: () => undefined,
  };
}

function createRoadMatchProvider(
  env: RouteEngineRuntimeEnv & Partial<Record<'UVIS_ROAD_MATCH_TIMEOUT_MS', string>>,
): OsrmRouteTrackingRoadMatchProvider | undefined {
  const baseUrls = readConfiguredCoverageBaseUrls(env, 'OSRM');
  if (Object.keys(baseUrls).length === 0) return undefined;
  return new OsrmRouteTrackingRoadMatchProvider({
    baseUrls,
    gpsPrecisionMeters: UVIS_ROAD_MATCH_GPS_PRECISION_METERS,
    maxMatchPoints: UVIS_ROAD_MATCH_MAX_POINTS,
    timeoutMs: readTimeout(env.UVIS_ROAD_MATCH_TIMEOUT_MS),
  });
}

function readTimeout(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : UVIS_ROAD_MATCH_TIMEOUT_MS;
}
