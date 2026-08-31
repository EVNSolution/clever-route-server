import { describe, expect, test, vi } from 'vitest';

import { PrismaCustomerEmailProviderEventRepository } from '../src/modules/customer-email/customer-email-provider-event.repository.js';

describe('PrismaCustomerEmailProviderEventRepository', () => {
  test('updates automatic and manual delivery evidence without recipient data', async () => {
    const automaticUpdate = vi.fn().mockResolvedValue({ count: 1 });
    const manualUpdate = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      $transaction: vi.fn(async (operations: Array<Promise<unknown>>) => Promise.all(operations)),
      customerEmailManualDispatchRecipient: { updateMany: manualUpdate },
      customerRouteNotificationFact: { updateMany: automaticUpdate }
    };
    const occurredAt = new Date('2026-08-29T14:35:00.000Z');

    await expect(new PrismaCustomerEmailProviderEventRepository(prisma as never).record({
      occurredAt, providerMessageId: 'provider-id', status: 'DELIVERED'
    })).resolves.toBe(2);

    for (const update of [automaticUpdate, manualUpdate]) {
      expect(update).toHaveBeenCalledWith({
        data: { providerEventAt: occurredAt, providerStatus: 'DELIVERED' },
        where: {
          OR: [{ providerEventAt: null }, { providerEventAt: { lte: occurredAt } }],
          providerMessageId: 'provider-id'
        }
      });
    }
  });
});
