import { describe, expect, test, vi } from 'vitest';

import {
  DestinationTipConflictError,
  PrismaDsvControlRepository,
} from '../src/modules/dsv/dsv-control.repository.js';

describe('PrismaDsvControlRepository', () => {
  test('updates a tip only when the requested revision still matches', async () => {
    const transactionTip = {
      findFirst: vi.fn(() => Promise.resolve({ revision: 4 })),
      updateMany: vi.fn(() => Promise.resolve({ count: 0 })),
    };
    const prisma = {
      $transaction: vi.fn((callback: (tx: unknown) => Promise<unknown>) => callback({ destinationTip: transactionTip })),
      deliveryCustomerProfile: {
        findFirst: vi.fn(() => Promise.resolve({ id: 'destination-id', mergedIntoProfileId: null })),
      },
      shop: { findUnique: vi.fn(() => Promise.resolve({ id: 'shop-id' })) },
    };
    const repository = new PrismaDsvControlRepository(prisma as never);

    await expect(repository.updateDestinationTip({
      actor: 'operator',
      body: '수정된 주의사항',
      destinationId: 'destination-id',
      revision: 3,
      shopDomain: 'tomatonofood.com',
      tipId: 'tip-id',
    })).rejects.toEqual(new DestinationTipConflictError(4));

    const expectedWhere: unknown = expect.objectContaining({ id: 'tip-id', revision: 3, shopId: 'shop-id' });
    expect(transactionTip.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expectedWhere }));
  });
});
