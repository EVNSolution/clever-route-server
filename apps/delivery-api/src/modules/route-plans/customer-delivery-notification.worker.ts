import type {
  CustomerDeliveryNotificationMessage,
  CustomerDeliveryNotificationSender,
  CustomerDeliveryNotificationSendResult
} from './customer-delivery-notification.sender.js';
import type {
  CustomerDeliveryNotificationJob,
  PrismaCustomerDeliveryNotificationOutbox
} from './customer-delivery-notification.outbox.js';

type LoggerLike = {
  error?(bindings: unknown, message?: string): void;
  info?(bindings: unknown, message?: string): void;
  warn?(bindings: unknown, message?: string): void;
};

export type CustomerDeliveryNotificationWorkerOptions = {
  batchSize?: number | undefined;
  leaseMs?: number | undefined;
  maxAgeMs?: number | undefined;
  maxAttempts?: number | undefined;
  pollIntervalMs?: number | undefined;
  retryBaseDelayMs?: number | undefined;
  retryMaxDelayMs?: number | undefined;
};

type ResolvedWorkerOptions = {
  batchSize: number;
  leaseMs: number;
  maxAgeMs: number;
  maxAttempts: number;
  pollIntervalMs: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
};

const defaultOptions: ResolvedWorkerOptions = {
  batchSize: 10,
  leaseMs: 5 * 60 * 1000,
  maxAgeMs: 24 * 60 * 60 * 1000,
  maxAttempts: 8,
  pollIntervalMs: 1_000,
  retryBaseDelayMs: 30_000,
  retryMaxDelayMs: 30 * 60 * 1000
};

export class CustomerDeliveryNotificationWorker {
  private readonly options: ResolvedWorkerOptions;
  private loopPromise: Promise<void> | null = null;
  private releaseWait: (() => void) | null = null;
  private stopped = true;

  constructor(
    private readonly outbox: PrismaCustomerDeliveryNotificationOutbox,
    private readonly sender: CustomerDeliveryNotificationSender,
    options: CustomerDeliveryNotificationWorkerOptions = {},
    private readonly logger?: LoggerLike
  ) {
    this.options = {
      batchSize: options.batchSize ?? defaultOptions.batchSize,
      leaseMs: options.leaseMs ?? defaultOptions.leaseMs,
      maxAgeMs: options.maxAgeMs ?? defaultOptions.maxAgeMs,
      maxAttempts: options.maxAttempts ?? defaultOptions.maxAttempts,
      pollIntervalMs: options.pollIntervalMs ?? defaultOptions.pollIntervalMs,
      retryBaseDelayMs: options.retryBaseDelayMs ?? defaultOptions.retryBaseDelayMs,
      retryMaxDelayMs: options.retryMaxDelayMs ?? defaultOptions.retryMaxDelayMs
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

  async runDueBatch(fixedNow?: Date): Promise<number> {
    let processed = 0;
    for (; processed < this.options.batchSize; processed += 1) {
      const claimNow = fixedNow ?? new Date();
      const job = await this.outbox.claimNext({
        leaseMs: this.options.leaseMs,
        now: claimNow
      });
      if (job === null) break;
      await this.processJob(job, fixedNow);
    }
    return processed;
  }

  private async runLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        const processed = await this.runDueBatch();
        if (processed >= this.options.batchSize) continue;
      } catch (error) {
        this.logger?.error?.(
          { error: error instanceof Error ? error.message : 'unknown worker error' },
          'customer delivery notification worker iteration failed'
        );
      }
      if (this.stopped) break;
      await this.waitForNextPoll();
    }
  }

  private async processJob(job: CustomerDeliveryNotificationJob, fixedNow?: Date): Promise<void> {
    const startedAt = fixedNow ?? new Date();
    const payload = buildJobMessage(job);
    if ('error' in payload) {
      await this.outbox.markDead({
        errorCode: payload.error.code,
        errorMessage: payload.error.message,
        factId: job.factId,
        leaseToken: job.leaseToken,
        now: startedAt,
        provider: this.sender.providerName
      });
      this.logger?.warn?.(
        { attemptCount: job.attemptCount, errorCode: payload.error.code, factId: job.factId },
        'customer delivery notification moved to dead letter state'
      );
      return;
    }

    if (startedAt.getTime() - job.occurredAt.getTime() > this.options.maxAgeMs) {
      await this.outbox.markDead({
        errorCode: 'CUSTOMER_NOTIFICATION_EXPIRED',
        errorMessage: 'Customer notification exceeded the delivery age limit.',
        factId: job.factId,
        leaseToken: job.leaseToken,
        now: startedAt,
        provider: this.sender.providerName
      });
      this.logger?.warn?.(
        { attemptCount: job.attemptCount, errorCode: 'CUSTOMER_NOTIFICATION_EXPIRED', factId: job.factId },
        'customer delivery notification moved to dead letter state'
      );
      return;
    }

    let sendResult: CustomerDeliveryNotificationSendResult;
    try {
      sendResult = await this.sender.send(payload.message);
    } catch (error) {
      sendResult = {
        errorCode: 'CUSTOMER_NOTIFICATION_SENDER_ERROR',
        errorMessage: error instanceof Error ? error.message : 'Customer notification sender failed.',
        provider: this.sender.providerName,
        retryable: true,
        status: 'FAILED'
      };
    }
    const settledAt = fixedNow ?? new Date();

    if (sendResult.status === 'SENT') {
      await this.outbox.markSent({
        factId: job.factId,
        leaseToken: job.leaseToken,
        now: settledAt,
        provider: sendResult.provider,
        providerMessageId: sendResult.providerMessageId
      });
      this.logger?.info?.(
        { attemptCount: job.attemptCount, factId: job.factId, provider: sendResult.provider },
        'customer delivery notification sent'
      );
      return;
    }

    const errorCode = sendResult.errorCode ?? 'CUSTOMER_NOTIFICATION_SEND_FAILED';
    const errorMessage = sendResult.errorMessage ?? 'Customer notification sender failed.';
    if (sendResult.retryable === true && job.attemptCount < this.options.maxAttempts) {
      const nextAttemptAt = new Date(settledAt.getTime() + retryDelayMs(job.attemptCount, this.options));
      await this.outbox.releaseForRetry({
        errorCode,
        errorMessage,
        factId: job.factId,
        leaseToken: job.leaseToken,
        nextAttemptAt,
        provider: sendResult.provider
      });
      this.logger?.warn?.(
        { attemptCount: job.attemptCount, errorCode, factId: job.factId, nextAttemptAt: nextAttemptAt.toISOString() },
        'customer delivery notification scheduled for retry'
      );
      return;
    }

    await this.outbox.markDead({
      errorCode,
      errorMessage,
      factId: job.factId,
      leaseToken: job.leaseToken,
      now: settledAt,
      provider: sendResult.provider
    });
    this.logger?.warn?.(
      { attemptCount: job.attemptCount, errorCode, factId: job.factId },
      'customer delivery notification moved to dead letter state'
    );
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

function buildJobMessage(job: CustomerDeliveryNotificationJob):
  | { message: CustomerDeliveryNotificationMessage }
  | { error: { code: string; message: string } } {
  if (job.idempotencyKey === null || job.deliveryStopId === null || job.routePlanId === null) {
    return {
      error: {
        code: 'CUSTOMER_NOTIFICATION_PAYLOAD_INCOMPLETE',
        message: 'Customer notification is missing its durable route payload.'
      }
    };
  }
  if (job.recipientEmail === null || job.recipientEmail.trim() === '') {
    return {
      error: {
        code: 'CUSTOMER_EMAIL_MISSING',
        message: 'Customer email is missing from the notification snapshot.'
      }
    };
  }
  if (!isNotificationUiStatus(job.requestedUiStatus)) {
    return {
      error: {
        code: 'CUSTOMER_NOTIFICATION_STATUS_INVALID',
        message: 'Customer notification status is invalid.'
      }
    };
  }
  return {
    message: {
      deliveryStopId: job.deliveryStopId,
      idempotencyKey: job.idempotencyKey,
      orderId: job.orderId,
      recipientEmail: job.recipientEmail,
      routePlanId: job.routePlanId,
      shopDomain: job.shopDomain,
      status: job.requestedUiStatus
    }
  };
}

function isNotificationUiStatus(value: string | null): value is 'COMPLETED' | 'IN_PROGRESS' | 'READY' {
  return value === 'COMPLETED' || value === 'IN_PROGRESS' || value === 'READY';
}

function retryDelayMs(
  attemptCount: number,
  options: ResolvedWorkerOptions
): number {
  const exponent = Math.max(attemptCount - 1, 0);
  return Math.min(options.retryBaseDelayMs * (2 ** exponent), options.retryMaxDelayMs);
}
