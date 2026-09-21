import { safeErrorTelemetry } from '../security/safe-telemetry-redaction.js';

type CompletionAssistanceWorkerService = {
  processDue(): Promise<number>;
};

type LoggerLike = {
  error?(bindings: unknown, message?: string): void;
  info?(bindings: unknown, message?: string): void;
};

export class CompletionAssistanceRuntime {
  private timer: NodeJS.Timeout | null = null;
  private pending: Promise<void> | null = null;

  constructor(
    private readonly service: CompletionAssistanceWorkerService,
    private readonly enabled: boolean,
    private readonly logger?: LoggerLike,
    private readonly intervalMs = 60_000
  ) {}

  start(): void {
    if (!this.enabled) {
      this.logger?.info?.({ event: 'completion_assistance_worker_disabled' }, 'completion assistance worker disabled');
      return;
    }
    if (this.timer !== null) return;
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), this.intervalMs);
    this.timer.unref();
  }

  async close(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    await this.pending;
  }

  async runOnce(): Promise<void> {
    if (!this.enabled || this.pending !== null) return;
    this.pending = this.processDue();
    try {
      await this.pending;
    } finally {
      this.pending = null;
    }
  }

  private async processDue(): Promise<void> {
    try {
      const processed = await this.service.processDue();
      this.logger?.info?.({ event: 'completion_assistance_worker_scan', processed }, 'completion assistance worker scan completed');
    } catch (error) {
      this.logger?.error?.({
        ...safeErrorTelemetry(error),
        errorCode: 'COMPLETION_ASSISTANCE_WORKER_FAILED',
        event: 'completion_assistance_worker_failed'
      }, 'completion assistance worker scan failed');
    }
  }
}
