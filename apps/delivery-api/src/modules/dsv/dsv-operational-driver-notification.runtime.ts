import type { PrismaClient } from '@prisma/client';

import {
  loadDsvOperationalPushProvider,
  type DsvOperationalPushProvider,
} from './dsv-operational-driver-notification.provider.js';
import {
  disabledDsvOperationalNotificationSendPolicy,
  PrismaDsvOperationalDriverNotificationService,
  type DsvOperationalNotificationSendPolicySource,
} from './dsv-operational-driver-notification.service.js';

type LoggerLike = {
  error?(bindings: unknown, message?: string): void;
  warn?(bindings: unknown, message?: string): void;
};

export type DsvOperationalDriverNotificationRuntime = {
  close(): Promise<void>;
  service: PrismaDsvOperationalDriverNotificationService;
  start(): Promise<void>;
};

export function createDsvOperationalDriverNotificationRuntime(input: {
  env: Partial<Record<'FIREBASE_PROJECT_ID' | 'GOOGLE_APPLICATION_CREDENTIALS', string>>;
  logger?: LoggerLike;
  policy?: DsvOperationalNotificationSendPolicySource;
  prisma: PrismaClient;
  provider?: DsvOperationalPushProvider;
  worker?: { batchSize?: number; leaseMs?: number; pollIntervalMs?: number };
}): DsvOperationalDriverNotificationRuntime {
  const service = new PrismaDsvOperationalDriverNotificationService(
    input.prisma,
    input.provider ?? loadDsvOperationalPushProvider(input.env),
    input.policy ?? disabledDsvOperationalNotificationSendPolicy,
    {
      ...(input.worker?.batchSize === undefined ? {} : { batchSize: input.worker.batchSize }),
      ...(input.worker?.leaseMs === undefined ? {} : { leaseMs: input.worker.leaseMs }),
    },
    input.logger,
  );
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> | null = null;
  const pollIntervalMs = input.worker?.pollIntervalMs ?? 5_000;

  const run = async (): Promise<void> => {
    try {
      await service.runOnce();
    } catch (error) {
      input.logger?.error?.(
        { error: error instanceof Error ? error.message : 'unknown worker error' },
        'DSV operational notification worker iteration failed.',
      );
    }
  };

  return {
    close: async () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
      await running;
      running = null;
    },
    service,
    start: () => {
      if (timer !== null) return Promise.resolve();
      running = run().finally(() => { running = null; });
      timer = setInterval(() => {
        if (running !== null) return;
        running = run().finally(() => { running = null; });
      }, pollIntervalMs);
      timer.unref();
      return Promise.resolve();
    },
  };
}
