import type { PrismaClient } from '@prisma/client';

import {
  loadCustomerDeliveryNotificationSender,
  type CustomerDeliveryNotificationRuntimeEnv
} from './customer-delivery-notification.sender.js';
import { PrismaCustomerDeliveryNotificationOutbox } from './customer-delivery-notification.outbox.js';
import { CustomerDeliveryNotificationWorker } from './customer-delivery-notification.worker.js';

type LoggerLike = {
  error?(bindings: unknown, message?: string): void;
  info?(bindings: unknown, message?: string): void;
  warn?(bindings: unknown, message?: string): void;
};

export type CustomerDeliveryNotificationRuntime = {
  close(): Promise<void>;
  enabled: boolean;
  start(): Promise<void>;
};

export function createCustomerDeliveryNotificationRuntime(input: {
  env: CustomerDeliveryNotificationRuntimeEnv;
  logger?: LoggerLike | undefined;
  prisma: PrismaClient;
}): CustomerDeliveryNotificationRuntime {
  const sender = loadCustomerDeliveryNotificationSender(input.env);
  if (sender === undefined) {
    return {
      close: () => Promise.resolve(),
      enabled: false,
      start: () => Promise.resolve()
    };
  }

  const worker = new CustomerDeliveryNotificationWorker(
    new PrismaCustomerDeliveryNotificationOutbox(input.prisma),
    sender,
    {},
    input.logger
  );
  return {
    close: () => worker.close(),
    enabled: true,
    start: () => {
      worker.start();
      return Promise.resolve();
    }
  };
}
