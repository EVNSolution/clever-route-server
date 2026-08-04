import { describe, expect, test, vi } from 'vitest';

import { PrismaUvisPollRepository } from '../src/modules/uvis/uvis-poll.repository.js';

const shopId = '99999999-9999-4999-8999-999999999999';
const now = new Date('2026-08-04T04:00:00.000Z');

describe('PrismaUvisPollRepository', () => {
  test('loads mapped devices with the normalized Route Ops loading start time', async () => {
    const state = createState({ claimCount: 1 });
    state.shop.findUnique.mockResolvedValueOnce({
      dsvVehicleTelematicsDevices: [{
        id: 'device-a',
        serialNumber: '012-5273-8978',
        vehicle: { licensePlate: '서울86바3800' },
        vehicleId: 'vehicle-a',
      }],
      id: shopId,
      routeOpsUiSettings: { version: 1, loadingStartTime: '23:45' },
    });
    state.routePlan.findMany.mockResolvedValueOnce([
      { routeStops: [{ estimatedArrivalAt: new Date('2026-08-04T09:30:00.000Z') }] },
      { routeStops: [{ estimatedArrivalAt: new Date('2026-08-04T10:00:00.000Z') }] },
    ]);
    const repository = new PrismaUvisPollRepository(state.prisma as never);

    await expect(repository.findShopAndDevices({
      appId: 'clever',
      now,
      shopDomain: 'dsv-demo.local',
    })).resolves.toMatchObject({
      devices: [{
        deviceId: 'device-a',
        serialNumber: '012-5273-8978',
        vehicleId: 'vehicle-a',
        vehiclePlate: '서울86바3800',
      }],
      latestFinalEstimatedArrivalAt: new Date('2026-08-04T10:00:00.000Z'),
      loadingStartTime: '23:45',
      shopId,
    });
    expect(state.routePlan.findMany).toHaveBeenCalledWith({
      select: {
        routeStops: {
          orderBy: { sequence: 'desc' },
          select: { estimatedArrivalAt: true },
          take: 1,
        },
      },
      where: {
        planDate: new Date('2026-08-04T00:00:00.000Z'),
        routeGroupingChildVersions: {
          some: {
            groupingVersion: { status: 'CURRENT' },
            status: 'CURRENT',
            supersededAt: null,
          },
        },
        shopId,
        status: { not: 'CANCELLED' },
        vehicleId: { in: ['vehicle-a'] },
      },
    });
  });

  test('uses the default loading start time when Route Ops settings are missing', async () => {
    const state = createState({ claimCount: 1 });
    state.shop.findUnique.mockResolvedValueOnce({
      dsvVehicleTelematicsDevices: [],
      id: shopId,
      routeOpsUiSettings: null,
    });
    const repository = new PrismaUvisPollRepository(state.prisma as never);

    await expect(repository.findShopAndDevices({
      appId: 'clever',
      now,
      shopDomain: 'dsv-demo.local',
    })).resolves.toMatchObject({
      loadingStartTime: '07:30',
      shopId,
    });
  });

  test('selects the next service date for midnight-wrapping preparation windows', async () => {
    const state = createState({ claimCount: 1 });
    state.shop.findUnique.mockResolvedValueOnce({
      dsvVehicleTelematicsDevices: [{
        id: 'device-a',
        serialNumber: '012-5273-8978',
        vehicle: { licensePlate: '서울86바3800' },
        vehicleId: 'vehicle-a',
      }],
      id: shopId,
      routeOpsUiSettings: { version: 1, loadingStartTime: '00:30' },
    });
    const repository = new PrismaUvisPollRepository(state.prisma as never);

    await repository.findShopAndDevices({
      appId: 'clever',
      now: new Date('2026-08-03T14:45:00.000Z'), // 23:45 Asia/Seoul on 2026-08-03.
      shopDomain: 'dsv-demo.local',
    });

    expect(state.routePlan.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        planDate: new Date('2026-08-04T00:00:00.000Z'),
      }) as unknown,
    }));
  });

  test('claims the persisted tenant lease atomically and returns poll cadence state', async () => {
    const state = createState({ claimCount: 1 });
    const repository = new PrismaUvisPollRepository(state.prisma as never);
    await expect(repository.claimLease({
      leaseDurationMs: 120_000,
      leaseToken: 'lease-token',
      now,
      shopId,
    })).resolves.toEqual({
      activeProtectionEndedAt: null,
      activity: 'ACTIVE',
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

  test('forces ACTIVE for the preparation window without writing a fake signal timestamp', async () => {
    const state = createState({ claimCount: 1 });
    const repository = new PrismaUvisPollRepository(state.prisma as never);
    await expect(repository.forceActiveForPreparationWindow({
      leaseToken: 'lease-token',
      shopId,
    })).resolves.toBe(true);
    expect(state.poll.updateMany).toHaveBeenCalledWith({
      data: {
        activity: 'ACTIVE',
        allVehiclesStoppedSince: null,
      },
      where: { leaseToken: 'lease-token', shopId },
    });
    expect(JSON.stringify(state.poll.updateMany.mock.calls)).not.toMatch(/lastActivitySignalAt/u);
  });

  test('marks active protection ended once so stopped suspicion starts fresh', async () => {
    const protectionEndedAt = new Date('2026-08-04T00:30:00.000Z');
    const state = createState({ claimCount: 1 });
    const repository = new PrismaUvisPollRepository(state.prisma as never);

    await expect(repository.markActiveProtectionEnded({
      leaseToken: 'lease-token',
      protectionEndedAt,
      shopId,
    })).resolves.toBe(true);
    expect(state.poll.updateMany).toHaveBeenCalledWith({
      data: {
        activeProtectionEndedAt: protectionEndedAt,
        activity: 'ACTIVE',
        allVehiclesStoppedSince: null,
      },
      where: {
        leaseToken: 'lease-token',
        shopId,
        OR: [
          { activeProtectionEndedAt: null },
          { activeProtectionEndedAt: { not: protectionEndedAt } },
        ],
      },
    });
    expect(JSON.stringify(state.poll.updateMany.mock.calls)).not.toMatch(/lastActivitySignalAt/u);
  });

  test('persists activity transitions from the worker boundary without storing provider identifiers', async () => {
    const state = createState({
      allVehiclesStoppedSince: new Date('2026-08-04T03:49:00.000Z'),
      claimCount: 1,
      leaseToken: 'lease-token',
    });
    const repository = new PrismaUvisPollRepository(state.prisma as never);

    await expect(repository.recordLocationActivitySignal({
      allConfiguredVehiclesStopped: true,
      gracePeriodMs: 600_000,
      hasMappedSignal: true,
      leaseToken: 'lease-token',
      now,
      shopId,
    })).resolves.toBe(true);
    expect(state.poll.updateMany).toHaveBeenLastCalledWith({
      data: {
        activity: 'DORMANT',
        allVehiclesStoppedSince: new Date('2026-08-04T03:49:00.000Z'),
        lastActivitySignalAt: now,
      },
      where: { leaseToken: 'lease-token', shopId },
    });

    await repository.recordLocationActivitySignal({
      allConfiguredVehiclesStopped: false,
      gracePeriodMs: 600_000,
      hasMappedSignal: true,
      leaseToken: 'lease-token',
      now,
      shopId,
    });
    expect(state.poll.updateMany).toHaveBeenLastCalledWith({
      data: {
        activity: 'ACTIVE',
        allVehiclesStoppedSince: null,
        lastActivitySignalAt: now,
      },
      where: { leaseToken: 'lease-token', shopId },
    });
    expect(JSON.stringify(state.poll.updateMany.mock.calls)).not.toMatch(/012|9580|sourceDevice|sourcePlate/u);
  });

  test('clears stopped accumulation when no mapped location signal is delivered', async () => {
    const state = createState({ claimCount: 1 });
    const repository = new PrismaUvisPollRepository(state.prisma as never);
    await expect(repository.recordLocationActivitySignal({
      allConfiguredVehiclesStopped: false,
      gracePeriodMs: 600_000,
      hasMappedSignal: false,
      leaseToken: 'lease-token',
      now,
      shopId,
    })).resolves.toBe(true);
    expect(state.poll.updateMany).toHaveBeenCalledWith({
      data: {
        activity: 'ACTIVE',
        allVehiclesStoppedSince: null,
      },
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

function createState(input: { allVehiclesStoppedSince?: Date | null; claimCount: number; leaseToken?: string | null }) {
  const poll = {
    findUnique: vi.fn().mockResolvedValue({
      activeProtectionEndedAt: null,
      allVehiclesStoppedSince: input.allVehiclesStoppedSince ?? null,
      leaseToken: input.leaseToken ?? 'lease-token',
    }),
    findUniqueOrThrow: vi.fn().mockResolvedValue({
      activeProtectionEndedAt: null,
      activity: 'ACTIVE',
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
    routePlan: { findMany: vi.fn().mockResolvedValue([]) },
    shop: { findUnique: vi.fn() },
    uvisTelemetryPollState: poll,
  };
  return { poll, prisma, routePlan: prisma.routePlan, shop: prisma.shop };
}
