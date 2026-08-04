import type { PrismaClient } from '@prisma/client';

import { UvisClient } from './uvis-client.js';
import { loadUvisRuntimeConfig, type UvisRuntimeEnv } from './uvis-config.js';
import { PrismaUvisPollRepository } from './uvis-poll.repository.js';
import { PrismaUvisTelemetryRepository } from './uvis-telemetry.repository.js';
import { UvisTelemetryWorker, type UvisWorkerLogger } from './uvis-telemetry.worker.js';

export type UvisTelemetryRuntime = {
  close: () => Promise<void>;
  start: () => void;
};

export function createUvisTelemetryRuntime(input: {
  env?: UvisRuntimeEnv;
  logger: UvisWorkerLogger;
  prisma: PrismaClient;
}): UvisTelemetryRuntime {
  const config = loadUvisRuntimeConfig(input.env ?? process.env);
  if (config === null) return noOpRuntime();

  const pollStore = new PrismaUvisPollRepository(input.prisma);
  const telemetryStore = new PrismaUvisTelemetryRepository(input.prisma);
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
  });

  let timer: NodeJS.Timeout | null = null;
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
      timer = null;
      await (active ?? Promise.resolve());
    },
    start() {
      if (timer !== null) return;
      trigger();
      timer = setInterval(trigger, Math.min(config.locationPollIntervalMs, config.temperaturePollIntervalMs));
      timer.unref();
    },
  };
}

function noOpRuntime(): UvisTelemetryRuntime {
  return {
    close: () => Promise.resolve(),
    start: () => undefined,
  };
}
