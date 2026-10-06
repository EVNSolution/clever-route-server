import type { PrismaClient } from '@prisma/client';

import { parseDsvGeofencePolicy } from './dsv-geofence-policy.js';
import { PrismaDsvGeofenceService } from './dsv-geofence.service.js';

export type DsvGeofenceRuntime = {
  close(): Promise<void>;
  start(): void;
};

export type DsvGeofenceRuntimeLogger = {
  error(fields: Record<string, unknown>, message: string): void;
};

export type DsvGeofenceRuntimeEnv = Partial<Record<
  | 'DSV_GEOFENCE_ENABLED'
  | 'DSV_GEOFENCE_JOB_RETRY_DELAY_MS'
  | 'DSV_GEOFENCE_JOB_RETRY_MAX_AGE_MS'
  | 'DSV_GEOFENCE_JOB_RETRY_MAX_ATTEMPTS'
  | 'DSV_GEOFENCE_POLICY_JSON'
  | 'DSV_GEOFENCE_POLL_INTERVAL_MS',
  string
>>;

export function createDsvGeofenceRuntime(input: {
  env?: DsvGeofenceRuntimeEnv;
  logger?: DsvGeofenceRuntimeLogger;
  prisma: PrismaClient;
}): DsvGeofenceRuntime {
  const env = input.env ?? process.env;
  if (env.DSV_GEOFENCE_ENABLED !== 'true') return noOpRuntime();
  const policy = parsePolicyJson(env.DSV_GEOFENCE_POLICY_JSON);
  if (policy === null) return noOpRuntime();
  const technicalRetryDelayMs = readPositiveInteger(env.DSV_GEOFENCE_JOB_RETRY_DELAY_MS);
  const technicalRetryMaxAgeMs = readPositiveInteger(env.DSV_GEOFENCE_JOB_RETRY_MAX_AGE_MS);
  const technicalRetryMaxAttempts = readPositiveInteger(env.DSV_GEOFENCE_JOB_RETRY_MAX_ATTEMPTS);
  const service = new PrismaDsvGeofenceService(input.prisma, {
    policy,
    ...(technicalRetryDelayMs === undefined ? {} : { technicalRetryDelayMs }),
    ...(technicalRetryMaxAgeMs === undefined ? {} : { technicalRetryMaxAgeMs }),
    ...(technicalRetryMaxAttempts === undefined ? {} : { technicalRetryMaxAttempts }),
  });
  const intervalMs = readInterval(env.DSV_GEOFENCE_POLL_INTERVAL_MS);
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> | null = null;

  const iteration = async (): Promise<void> => {
    try {
      await service.runOnce();
      await service.tickReminders();
    } catch (error) {
      input.logger?.error({ error }, 'DSV geofence runtime iteration failed');
    }
  };

  return {
    async close() {
      if (timer !== null) clearInterval(timer);
      timer = null;
      await running;
    },
    start() {
      if (timer !== null) return;
      const run = (): void => {
        if (running !== null) return;
        running = iteration().finally(() => { running = null; });
      };
      run();
      timer = setInterval(run, intervalMs);
      timer.unref();
    },
  };
}

function parsePolicyJson(value: string | undefined) {
  if (value === undefined) return null;
  try {
    return parseDsvGeofencePolicy(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
}

function readInterval(value: string | undefined): number {
  if (value === undefined) return 1_000;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 250 && parsed <= 60_000 ? parsed : 1_000;
}

function readPositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function noOpRuntime(): DsvGeofenceRuntime {
  return { close: () => Promise.resolve(), start: () => undefined };
}
