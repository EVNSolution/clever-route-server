import { describe, expect, test, vi } from 'vitest';

import {
  cleanupTerminalShopifyWebhookEvents,
  loadShopifyWebhookTerminalRetentionDays
} from '../src/modules/shopify/webhook-event-retention.js';

describe('Shopify webhook terminal retention', () => {
  test('defaults to a 30-day duplicate window and rejects shorter configuration', () => {
    expect(loadShopifyWebhookTerminalRetentionDays({})).toBe(30);
    expect(loadShopifyWebhookTerminalRetentionDays({ SHOPIFY_WEBHOOK_TERMINAL_RETENTION_DAYS: '45' })).toBe(45);
    expect(() => loadShopifyWebhookTerminalRetentionDays({ SHOPIFY_WEBHOOK_TERMINAL_RETENTION_DAYS: '29' }))
      .toThrow('must be at least 30');
  });

  test('calculates a bounded cutoff and delegates only terminal cleanup', async () => {
    const deleteExpiredTerminalWebhookEvents = vi.fn()
      .mockResolvedValueOnce({ deleted: 10, scanned: 10 })
      .mockResolvedValueOnce({ deleted: 2, scanned: 2 });
    await expect(cleanupTerminalShopifyWebhookEvents({
      limit: 10,
      now: new Date('2026-08-24T00:00:00.000Z'),
      repository: { deleteExpiredTerminalWebhookEvents },
      retentionDays: 30
    })).resolves.toEqual({
      completedBefore: new Date('2026-07-25T00:00:00.000Z'),
      continuationRequired: false,
      deleted: 12,
      scanned: 12
    });
    expect(deleteExpiredTerminalWebhookEvents).toHaveBeenNthCalledWith(1, {
      completedBefore: new Date('2026-07-25T00:00:00.000Z'),
      limit: 10
    });
    expect(deleteExpiredTerminalWebhookEvents).toHaveBeenNthCalledWith(2, {
      completedBefore: new Date('2026-07-25T00:00:00.000Z'),
      limit: 10
    });
  });

  test('drains more than one legacy batch in a single scheduled invocation', async () => {
    const deleteExpiredTerminalWebhookEvents = vi.fn()
      .mockResolvedValueOnce({ deleted: 100, scanned: 100 })
      .mockResolvedValueOnce({ deleted: 100, scanned: 100 })
      .mockResolvedValueOnce({ deleted: 1, scanned: 1 });
    await expect(cleanupTerminalShopifyWebhookEvents({
      now: new Date('2026-08-24T00:00:00.000Z'),
      repository: { deleteExpiredTerminalWebhookEvents },
      retentionDays: 30
    })).resolves.toMatchObject({ continuationRequired: false, deleted: 201, scanned: 201 });
    expect(deleteExpiredTerminalWebhookEvents).toHaveBeenCalledTimes(3);
  });
});
