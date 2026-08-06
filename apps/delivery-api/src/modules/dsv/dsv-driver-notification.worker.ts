import type { PrismaClient } from '@prisma/client';

import type { PrismaDsvDriverNotificationDispatcher } from './dsv-driver-notification.dispatcher.js';

type LoggerLike = {
  error?(bindings: unknown, message?: string): void;
  warn?(bindings: unknown, message?: string): void;
};

type DsvDriverNotificationWorkerPrismaClient = Pick<PrismaClient, 'driverRouteNotificationAttempt'>;

export type DsvDriverNotificationWorkerOptions = {
  batchSize?: number | undefined;
  failedRetryDelayMs?: number | undefined;
  pendingRetryDelayMs?: number | undefined;
  pollIntervalMs?: number | undefined;
};

type ResolvedWorkerOptions = {
  batchSize: number;
  failedRetryDelayMs: number;
  pendingRetryDelayMs: number;
  pollIntervalMs: number;
};

const defaultOptions: ResolvedWorkerOptions = {
  batchSize: 10,
  failedRetryDelayMs: 30_000,
  pendingRetryDelayMs: 30_000,
  pollIntervalMs: 1_000
};

export class DsvDriverNotificationWorker {
  private readonly options: ResolvedWorkerOptions;
  private loopPromise: Promise<void> | null = null;
  private releaseWait: (() => void) | null = null;
  private stopped = true;

  constructor(
    private readonly prisma: DsvDriverNotificationWorkerPrismaClient,
    private readonly dispatcher: PrismaDsvDriverNotificationDispatcher,
    options: DsvDriverNotificationWorkerOptions = {},
    private readonly logger?: LoggerLike
  ) {
    this.options = {
      batchSize: options.batchSize ?? defaultOptions.batchSize,
      failedRetryDelayMs: options.failedRetryDelayMs ?? defaultOptions.failedRetryDelayMs,
      pendingRetryDelayMs: options.pendingRetryDelayMs ?? defaultOptions.pendingRetryDelayMs,
      pollIntervalMs: options.pollIntervalMs ?? defaultOptions.pollIntervalMs
    };
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.loopPromise = this.runLoop();
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.releaseWait?.();
    await this.loopPromise;
    this.loopPromise = null;
  }

  async runDueBatch(now = new Date()): Promise<number> {
    const dueAttempts = await this.prisma.driverRouteNotificationAttempt.findMany({
      orderBy: [{ attemptedAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
      take: this.options.batchSize,
      where: {
        OR: [
          { attemptedAt: { lte: new Date(now.getTime() - this.options.pendingRetryDelayMs) }, status: 'PENDING' },
          { attemptedAt: { lte: new Date(now.getTime() - this.options.failedRetryDelayMs) }, status: 'FAILED' }
        ]
      }
    });
    for (const attempt of dueAttempts) {
      await this.dispatcher.dispatchAttemptId(attempt.id, now);
    }
    return dueAttempts.length;
  }

  private async runLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        const processed = await this.runDueBatch();
        if (processed >= this.options.batchSize) continue;
      } catch (error) {
        this.logger?.error?.(
          { error: error instanceof Error ? error.message : 'unknown worker error' },
          'DSV driver notification worker iteration failed'
        );
      }
      if (this.stopped) break;
      await this.waitForNextPoll();
    }
  }

  private async waitForNextPoll(): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, this.options.pollIntervalMs);
      this.releaseWait = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    this.releaseWait = null;
  }
}
