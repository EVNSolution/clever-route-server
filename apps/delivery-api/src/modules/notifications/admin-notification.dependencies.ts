import type { PrismaClient } from '@prisma/client';

import { PrismaAdminNotificationRepository } from './admin-notification.repository.js';
import { PostgresAdminNotificationStreamBridge } from './admin-notification.postgres-stream.js';
import { AdminNotificationService } from './admin-notification.service.js';
import { AdminNotificationStreamHub } from './admin-notification.stream.js';

type LoggerLike = {
  error?(bindings: unknown, message?: string): void;
  info?(bindings: unknown, message?: string): void;
  warn?(bindings: unknown, message?: string): void;
};

export type AdminNotificationRuntime = {
  close(): Promise<void>;
  service: AdminNotificationService;
  start(): Promise<void>;
};

export function createAdminNotificationRuntime(input: {
  databaseUrl?: string | undefined;
  logger?: LoggerLike | undefined;
  prisma: PrismaClient;
}): AdminNotificationRuntime {
  const streamHub = new AdminNotificationStreamHub();
  const repository = new PrismaAdminNotificationRepository(input.prisma);
  const bridge =
    input.databaseUrl === undefined || input.databaseUrl.trim() === ''
      ? null
      : new PostgresAdminNotificationStreamBridge({
          connectionString: input.databaseUrl,
          logger: input.logger,
          streamHub,
        });

  return {
    close: () => bridge?.close() ?? Promise.resolve(),
    service: new AdminNotificationService(repository, streamHub, bridge ?? streamHub),
    start: () => bridge?.start() ?? Promise.resolve(),
  };
}

export function createAdminNotificationService(input: {
  prisma: PrismaClient;
}): AdminNotificationService {
  return createAdminNotificationRuntime(input).service;
}
