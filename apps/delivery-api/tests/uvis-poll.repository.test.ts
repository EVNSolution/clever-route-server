import { describe, expect, test, vi } from 'vitest';

import { PrismaUvisPollRepository } from '../src/modules/uvis/uvis-poll.repository.js';

const shopId = '99999999-9999-4999-8999-999999999999';
const now = new Date('2026-08-04T04:00:00.000Z');

describe('PrismaUvisPollRepository', () => {
  test('claims the persisted tenant lease atomically and returns poll cadence state', async () => {
    const state = createState({ claimCount: 1 });
    const repository = new PrismaUvisPollRepository(state.prisma as never);
    await expect(repository.claimLease({
      leaseDurationMs: 120_000,
      leaseToken: 'lease-token',
      now,
      shopId,
    })).resolves.toEqual({
      lastLocationStartedAt: null,
      lastTemperatureStartedAt: null,
      shopId,
    });
    expect(state.poll.updateMany).toHaveBeenCalledWith({
      data: {
        leaseExpiresAt: new Date('2026-08-04T04:02:00.000Z'),
        leaseToken: 'lease-token',
      },
      where: {
        OR: [
          { leaseExpiresAt: null },
          { leaseExpiresAt: { lte: now } },
          { leaseToken: 'lease-token' },
        ],
        shopId,
      },
    });
  });

  test('skips polling when another live lease owns the tenant', async () => {
    const state = createState({ claimCount: 0 });
    const repository = new PrismaUvisPollRepository(state.prisma as never);
    await expect(repository.claimLease({ leaseDurationMs: 120_000, leaseToken: 'loser', now, shopId })).resolves.toBeNull();
    expect(state.poll.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  test('updates kind-specific health fields and only releases the matching lease', async () => {
    const state = createState({ claimCount: 1 });
    const repository = new PrismaUvisPollRepository(state.prisma as never);
    await repository.markStarted({ kind: 'temperature', leaseToken: 'lease-token', now, shopId });
    await repository.markFailed({ errorCode: 'TIMEOUT', kind: 'temperature', leaseToken: 'lease-token', now, shopId });
    await repository.markSucceeded({ kind: 'location', leaseToken: 'lease-token', now, shopId });
    await repository.releaseLease({ leaseToken: 'lease-token', shopId });
    expect(state.poll.updateMany).toHaveBeenNthCalledWith(1, {
      data: { lastTemperatureStartedAt: now },
      where: { leaseToken: 'lease-token', shopId },
    });
    expect(state.poll.updateMany).toHaveBeenNthCalledWith(2, {
      data: { lastTemperatureErrorCode: 'TIMEOUT', lastTemperatureFailedAt: now },
      where: { leaseToken: 'lease-token', shopId },
    });
    expect(state.poll.updateMany).toHaveBeenNthCalledWith(3, {
      data: { lastLocationErrorCode: null, lastLocationSucceededAt: now },
      where: { leaseToken: 'lease-token', shopId },
    });
    expect(state.poll.updateMany).toHaveBeenLastCalledWith({
      data: { leaseExpiresAt: null, leaseToken: null },
      where: { leaseToken: 'lease-token', shopId },
    });
  });

  test('reports lost leases when guarded status writes update zero rows', async () => {
    const state = createState({ claimCount: 0 });
    const repository = new PrismaUvisPollRepository(state.prisma as never);

    await expect(repository.markStarted({ kind: 'location', leaseToken: 'lost', now, shopId })).resolves.toBe(false);
    await expect(repository.markSucceeded({ kind: 'location', leaseToken: 'lost', now, shopId })).resolves.toBe(false);
    await expect(repository.markFailed({ errorCode: 'TIMEOUT', kind: 'location', leaseToken: 'lost', now, shopId })).resolves.toBe(false);
  });
});

function createState(input: { claimCount: number }) {
  const poll = {
    findUniqueOrThrow: vi.fn().mockResolvedValue({
      lastLocationStartedAt: null,
      lastTemperatureStartedAt: null,
      shopId,
    }),
    updateMany: vi.fn().mockResolvedValue({ count: input.claimCount }),
    upsert: vi.fn().mockResolvedValue({ shopId }),
  };
  const transaction = { uvisTelemetryPollState: poll };
  const prisma = {
    $transaction: vi.fn((operation: (client: typeof transaction) => unknown) => operation(transaction)),
    shop: { findUnique: vi.fn() },
    uvisTelemetryPollState: poll,
  };
  return { poll, prisma };
}
