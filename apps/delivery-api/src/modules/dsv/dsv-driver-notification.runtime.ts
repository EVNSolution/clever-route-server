import type { PrismaClient } from '@prisma/client';

import { loadDriverPushProvider } from '../route-grouping/driver-push.provider.js';
import { PrismaDsvDriverNotificationDispatcher } from './dsv-driver-notification.dispatcher.js';
import { DsvDriverNotificationWorker } from './dsv-driver-notification.worker.js';

type LoggerLike = {
  error?(bindings: unknown, message?: string): void;
  warn?(bindings: unknown, message?: string): void;
};

export type DsvDriverNotificationRuntimeEnv = Partial<Record<
  'FIREBASE_PROJECT_ID' | 'GOOGLE_APPLICATION_CREDENTIALS',
  string
>>;

export type DsvDriverNotificationRuntime = {
  close(): Promise<void>;
  dispatcher: PrismaDsvDriverNotificationDispatcher;
  start(): Promise<void>;
};

export function createDsvDriverNotificationRuntime(input: {
  env: DsvDriverNotificationRuntimeEnv;
  logger?: LoggerLike | undefined;
  prisma: PrismaClient;
}): DsvDriverNotificationRuntime {
  const dispatcher = new PrismaDsvDriverNotificationDispatcher(
    input.prisma,
    loadDriverPushProvider(input.env),
    input.logger
  );
  const worker = new DsvDriverNotificationWorker(input.prisma, dispatcher, {}, input.logger);
  return {
    close: () => worker.close(),
    dispatcher,
    start: () => {
      worker.start();
      return Promise.resolve();
    }
  };
}
