import type { DeleteExpiredTerminalWebhookEventsResult } from './webhook-event.repository.js';

export const DEFAULT_SHOPIFY_WEBHOOK_TERMINAL_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_MAX_ROWS = 10_000;

export type ShopifyWebhookRetentionRepository = {
  deleteExpiredTerminalWebhookEvents(input: {
    completedBefore: Date;
    limit?: number | undefined;
  }): Promise<DeleteExpiredTerminalWebhookEventsResult>;
};

export function loadShopifyWebhookTerminalRetentionDays(env: {
  SHOPIFY_WEBHOOK_TERMINAL_RETENTION_DAYS?: string | undefined;
}): number {
  const raw = env.SHOPIFY_WEBHOOK_TERMINAL_RETENTION_DAYS?.trim();
  if (raw === undefined || raw === '') return DEFAULT_SHOPIFY_WEBHOOK_TERMINAL_RETENTION_DAYS;
  const days = Number(raw);
  if (!Number.isInteger(days) || days < DEFAULT_SHOPIFY_WEBHOOK_TERMINAL_RETENTION_DAYS) {
    throw new Error(`SHOPIFY_WEBHOOK_TERMINAL_RETENTION_DAYS must be at least ${DEFAULT_SHOPIFY_WEBHOOK_TERMINAL_RETENTION_DAYS}`);
  }
  return days;
}

export async function cleanupTerminalShopifyWebhookEvents(input: {
  deadlineAt?: number | undefined;
  limit?: number | undefined;
  maxRows?: number | undefined;
  now?: Date | undefined;
  repository: ShopifyWebhookRetentionRepository;
  retentionDays: number;
}): Promise<DeleteExpiredTerminalWebhookEventsResult & {
  completedBefore: Date;
  continuationRequired: boolean;
}> {
  const now = input.now ?? new Date();
  const completedBefore = new Date(now.getTime() - input.retentionDays * DAY_MS);
  const batchSize = input.limit ?? DEFAULT_BATCH_SIZE;
  const maxRows = input.maxRows ?? DEFAULT_MAX_ROWS;
  let deleted = 0;
  let scanned = 0;
  let continuationRequired = false;
  while (scanned < maxRows) {
    if (input.deadlineAt !== undefined && Date.now() >= input.deadlineAt) {
      continuationRequired = true;
      break;
    }
    const limit = Math.min(batchSize, maxRows - scanned);
    const result = await input.repository.deleteExpiredTerminalWebhookEvents({ completedBefore, limit });
    deleted += result.deleted;
    scanned += result.scanned;
    if (result.scanned < limit) break;
    if (scanned >= maxRows) continuationRequired = true;
  }
  return { completedBefore, continuationRequired, deleted, scanned };
}
