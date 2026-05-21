import { describe, expect, test, vi } from 'vitest';

import { PrismaDriverTokenAccessRepository } from '../src/modules/driver/driver-token-access.repository.js';

describe('PrismaDriverTokenAccessRepository', () => {
  test('accepts an active linked driver token only when the token version still matches', async () => {
    const { prisma } = createPrismaHarness({ tokenVersion: 3 });
    const repository = new PrismaDriverTokenAccessRepository(prisma as never);

    await expect(
      repository.isDriverAccessTokenActive({
        driverId: 'driver-id',
        shopDomain: 'Example.myshopify.com',
        tokenVersion: 3
      })
    ).resolves.toBe(true);

    expect(prisma.driver.findFirst).toHaveBeenCalledWith({
      select: { tokenVersion: true },
      where: {
        authSubject: { not: null },
        id: 'driver-id',
        shop: { shopDomain: 'example.myshopify.com' },
        status: 'ACTIVE'
      }
    });
  });

  test('rejects older tokens after relogin increments the driver token version', async () => {
    const { prisma } = createPrismaHarness({ tokenVersion: 4 });
    const repository = new PrismaDriverTokenAccessRepository(prisma as never);

    await expect(
      repository.isDriverAccessTokenActive({
        driverId: 'driver-id',
        shopDomain: 'example.myshopify.com',
        tokenVersion: 3
      })
    ).resolves.toBe(false);
  });

  test('rejects tokens for drivers no longer linked to the app', async () => {
    const { prisma } = createPrismaHarness({ driver: null });
    const repository = new PrismaDriverTokenAccessRepository(prisma as never);

    await expect(
      repository.isDriverAccessTokenActive({
        driverId: 'driver-id',
        shopDomain: 'example.myshopify.com',
        tokenVersion: 0
      })
    ).resolves.toBe(false);
  });
});

function createPrismaHarness(input: {
  driver?: { tokenVersion: number } | null;
  tokenVersion?: number;
} = {}): {
  prisma: {
    driver: {
      findFirst: ReturnType<typeof vi.fn>;
    };
  };
} {
  const driver =
    input.driver === undefined ? { tokenVersion: input.tokenVersion ?? 0 } : input.driver;

  return {
    prisma: {
      driver: {
        findFirst: vi.fn(() => Promise.resolve(driver))
      }
    }
  };
}
