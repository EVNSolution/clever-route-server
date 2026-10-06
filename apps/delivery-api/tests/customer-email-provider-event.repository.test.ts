import { describe, expect, test, vi } from 'vitest';

import { PrismaCustomerEmailProviderEventRepository } from '../src/modules/customer-email/customer-email-provider-event.repository.js';

describe('PrismaCustomerEmailProviderEventRepository', () => {
  test('recovers an early manual provider event through the durable attempt correlation', async () => {
    const automaticUpdate = vi.fn().mockResolvedValue({ count: 0 });
    const manualUpdate = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      $transaction: vi.fn(async (operations: Array<Promise<unknown>>) => Promise.all(operations)),
      customerEmailManualDispatchRecipient: { updateMany: manualUpdate },
      customerRouteNotificationFact: { updateMany: automaticUpdate }
    };
    const occurredAt = new Date('2026-08-29T14:35:00.000Z');

    await expect(new PrismaCustomerEmailProviderEventRepository(prisma as never).record({
      correlationId: 'attempt-correlation', occurredAt, providerMessageId: 'provider-id', status: 'DELIVERED'
    })).resolves.toBe(1);

    expect(manualUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: {
        providerEventAt: occurredAt,
        providerMessageId: 'provider-id',
        providerStatus: 'DELIVERED',
        status: 'SENT',
      },
      where: expect.objectContaining({
        OR: [
          { providerMessageId: 'provider-id' },
          { attempts: { some: { correlationId: 'attempt-correlation' } } },
        ],
        status: { in: ['PENDING', 'SENT', 'UNKNOWN'] },
      }) as unknown,
    }));
  });

  test('does not let ACCEPTED overwrite a more advanced provider status', async () => {
    const automaticUpdate = vi.fn().mockResolvedValue({ count: 0 });
    const manualUpdate = vi.fn<(input: { where: unknown }) => Promise<{ count: number }>>()
      .mockResolvedValue({ count: 0 });
    const prisma = {
      $transaction: vi.fn(async (operations: Array<Promise<unknown>>) => Promise.all(operations)),
      customerEmailManualDispatchRecipient: { updateMany: manualUpdate },
      customerRouteNotificationFact: { updateMany: automaticUpdate }
    };
    const occurredAt = new Date('2026-08-29T14:35:00.000Z');

    await new PrismaCustomerEmailProviderEventRepository(prisma as never).record({
      occurredAt, providerMessageId: 'provider-id', status: 'ACCEPTED'
    });

    const where = manualUpdate.mock.calls[0]?.[0]?.where;
    expect(where).toMatchObject({
      AND: [{
        OR: [
          { providerEventAt: null },
          { providerStatus: null },
          { providerEventAt: { lte: occurredAt }, providerStatus: { in: ['UNKNOWN'] } },
          { providerEventAt: { lt: occurredAt }, providerStatus: 'ACCEPTED' },
        ],
      }],
      OR: [{ providerMessageId: 'provider-id' }],
    });
    expect(JSON.stringify(where)).not.toContain('DELIVERED');
  });

  test.each(['SPAM', 'UNSUBSCRIBED'])('allows %s to supersede delivered evidence', async (status) => {
    const automaticUpdate = vi.fn().mockResolvedValue({ count: 0 });
    const manualUpdate = vi.fn<(input: { where: unknown }) => Promise<{ count: number }>>()
      .mockResolvedValue({ count: 1 });
    const prisma = {
      $transaction: vi.fn(async (operations: Array<Promise<unknown>>) => Promise.all(operations)),
      customerEmailManualDispatchRecipient: { updateMany: manualUpdate },
      customerRouteNotificationFact: { updateMany: automaticUpdate }
    };
    const occurredAt = new Date('2026-08-29T14:35:00.000Z');

    await new PrismaCustomerEmailProviderEventRepository(prisma as never).record({
      occurredAt, providerMessageId: 'provider-id', status
    });

    expect(manualUpdate.mock.calls[0]?.[0]?.where).toMatchObject({
      AND: [{
        OR: expect.arrayContaining([
          { providerEventAt: { lte: occurredAt }, providerStatus: { in: expect.arrayContaining(['DELIVERED']) as unknown } },
        ]) as unknown,
      }],
    });
  });
});
