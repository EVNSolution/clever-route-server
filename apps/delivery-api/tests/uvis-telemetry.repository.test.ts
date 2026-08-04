import { describe, expect, test, vi } from 'vitest';

import {
  PrismaUvisTelemetryRepository,
  UvisTelemetryDeviceNotFoundError,
  UvisTelemetryObservedAtSkewError,
} from '../src/modules/uvis/uvis-telemetry.repository.js';

const shopId = '99999999-9999-4999-8999-999999999999';
const vehicleId = '77777777-7777-4777-8777-777777777777';
const deviceId = '55555555-5555-4555-8555-555555555555';
const sourceDeviceIdentifier = 'fake-uvis-device';
const observedAt = new Date('2026-08-04T01:15:00.000Z');
const receivedAt = new Date('2026-08-04T01:16:00.000Z');
const staleAfter = new Date('2026-08-04T01:20:00.000Z');

describe('PrismaUvisTelemetryRepository', () => {
  test('records normalized telemetry history and creates the first current row without raw payload storage', async () => {
    const { current, prisma, sample } = createHarness({
      currentUpdateCount: 0,
      existingCurrent: null,
      sampleId: 'sample-id',
      vehiclePlate: '21사 6101',
    });
    const repository = new PrismaUvisTelemetryRepository(prisma as never);

    await expect(repository.recordSample({
      deviceId,
      distanceTodayKm: '82.40',
      ignitionOn: true,
      latitude: '37.5665000',
      longitude: '126.9780000',
      observedAt,
      receivedAt,
      sourceDeviceIdentifier,
      sourceKind: 'VEHICLE_GPS',
      sourcePlate: '21사6101',
      speedKph: '42.10',
      staleAfter,
    })).resolves.toEqual({
      currentStatus: 'UPDATED',
      plateStatus: 'MATCHED',
      sampleId: 'sample-id',
      sampleStatus: 'RECORDED',
      shopId,
      vehicleId,
    });

    expect(sample.create).toHaveBeenCalledWith({
      data: {
        deviceId,
        distanceTodayKm: '82.40',
        ignitionOn: true,
        latitude: '37.5665000',
        longitude: '126.9780000',
        observedAt,
        plateMatched: true,
        receivedAt,
        shopId,
        sourceDeviceIdentifier,
        sourceKind: 'VEHICLE_GPS',
        sourcePlate: '21사6101',
        speedKph: '42.10',
        staleAfter,
        vehicleId,
      },
      select: { id: true },
    });
    const sampleCreateInput = sample.create.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    const sampleData = sampleCreateInput.data;
    expect(sampleData).not.toHaveProperty('payload');
    expect(sampleData).not.toHaveProperty('rawPayload');
    expect(sampleData).not.toHaveProperty('vendorPayload');
    expect(current.create).toHaveBeenCalledWith({
      data: {
        ...sampleData,
        lastSampleId: 'sample-id',
      },
    });
  });

  test('keeps a late-arriving sample in history without overwriting current state', async () => {
    const { current, prisma, sample } = createHarness({
      currentUpdateCount: 0,
      existingCurrent: { id: 'current-id', observedAt: new Date('2026-08-04T01:30:00.000Z') },
      sampleId: 'late-sample-id',
      vehiclePlate: '21사 6101',
    });
    const repository = new PrismaUvisTelemetryRepository(prisma as never);

    await expect(repository.recordSample({
      deviceId,
      observedAt,
      receivedAt,
      sourceDeviceIdentifier,
      sourceKind: 'TEMPERATURE_RECORDER',
      sourcePlate: '21사 6101',
      staleAfter,
      temperatureA: '2.50',
      temperatureB: '3.10',
    })).resolves.toEqual({
      currentStatus: 'HISTORY_ONLY',
      plateStatus: 'MATCHED',
      sampleId: 'late-sample-id',
      sampleStatus: 'RECORDED',
      shopId,
      vehicleId,
    });

    expect(sample.create).toHaveBeenCalledOnce();
    expect(current.create).not.toHaveBeenCalled();
    const currentUpdateInput = current.updateMany.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
      where: Record<string, unknown>;
    };
    expect(currentUpdateInput.data).toMatchObject({
      lastSampleId: 'late-sample-id',
      temperatureA: '2.50',
      temperatureB: '3.10',
    });
    expect(currentUpdateInput.where).toEqual({
        deviceId,
        observedAt: { lte: observedAt },
        shopId,
        sourceKind: 'TEMPERATURE_RECORDER',
    });
  });

  test('treats device source kind observedAt conflicts as duplicate samples and leaves current unchanged', async () => {
    const { current, prisma, sample } = createHarness({
      createSampleError: Object.assign(new Error('duplicate telemetry sample'), { code: 'P2002' }),
      existingSampleId: 'existing-sample-id',
      vehiclePlate: '21사 6101',
    });
    const repository = new PrismaUvisTelemetryRepository(prisma as never);

    await expect(repository.recordSample({
      deviceId,
      observedAt,
      receivedAt,
      sourceDeviceIdentifier,
      sourceKind: 'VEHICLE_GPS',
      staleAfter,
    })).resolves.toEqual({
      currentStatus: 'UNCHANGED',
      plateStatus: 'UNKNOWN',
      sampleId: 'existing-sample-id',
      sampleStatus: 'DUPLICATE',
      shopId,
      vehicleId,
    });

    expect(sample.findUnique).toHaveBeenCalledWith({
      select: { id: true },
      where: {
        deviceId_sourceKind_observedAt: {
          deviceId,
          observedAt,
          sourceKind: 'VEHICLE_GPS',
        },
      },
    });
    expect(current.updateMany).not.toHaveBeenCalled();
    expect(current.create).not.toHaveBeenCalled();
  });

  test('returns plate mismatch without remapping the device vehicle', async () => {
    const { current, prisma, sample } = createHarness({
      currentUpdateCount: 1,
      sampleId: 'mismatch-sample-id',
      vehiclePlate: '21사 6101',
    });
    const repository = new PrismaUvisTelemetryRepository(prisma as never);

    await expect(repository.recordSample({
      deviceId,
      observedAt,
      receivedAt,
      sourceDeviceIdentifier,
      sourceKind: 'VEHICLE_GPS',
      sourcePlate: '99허9999',
      staleAfter,
    })).resolves.toMatchObject({
      currentStatus: 'UPDATED',
      plateStatus: 'MISMATCH',
      sampleId: 'mismatch-sample-id',
      vehicleId,
    });

    const sampleCreateInput = sample.create.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    const currentUpdateInput = current.updateMany.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(sampleCreateInput.data).toMatchObject({
      plateMatched: false,
      sourcePlate: '99허9999',
      vehicleId,
    });
    expect(currentUpdateInput.data).toMatchObject({
      plateMatched: false,
      vehicleId,
    });
  });

  test('throws a scoped not-found error for unknown devices', async () => {
    const { prisma } = createHarness({ device: null });
    const repository = new PrismaUvisTelemetryRepository(prisma as never);

    await expect(repository.recordSample({
      deviceId,
      observedAt,
      receivedAt,
      sourceDeviceIdentifier,
      sourceKind: 'VEHICLE_GPS',
      staleAfter,
    })).rejects.toBeInstanceOf(UvisTelemetryDeviceNotFoundError);
  });

  test('rejects provider timestamps more than five minutes ahead of receipt before storing samples', async () => {
    const { current, device, prisma, sample } = createHarness({});
    const repository = new PrismaUvisTelemetryRepository(prisma as never);

    await expect(repository.recordSample({
      deviceId,
      observedAt: new Date(receivedAt.getTime() + 300_001),
      receivedAt,
      sourceDeviceIdentifier,
      sourceKind: 'VEHICLE_GPS',
      staleAfter,
    })).rejects.toBeInstanceOf(UvisTelemetryObservedAtSkewError);

    expect(device.findUnique).not.toHaveBeenCalled();
    expect(sample.create).not.toHaveBeenCalled();
    expect(current.updateMany).not.toHaveBeenCalled();
    expect(current.create).not.toHaveBeenCalled();
  });
});

function createHarness(input: {
  createSampleError?: Error;
  currentUpdateCount?: number;
  device?: { id: string; shopId: string; vehicleId: string; vehicle: { licensePlate: string | null } } | null;
  existingCurrent?: { id: string; observedAt: Date } | null;
  existingSampleId?: string;
  sampleId?: string;
  vehiclePlate?: string | null;
}) {
  const sample = {
    create: vi.fn((args: unknown) => {
      void args;
      if (input.createSampleError !== undefined) return Promise.reject(input.createSampleError);
      return Promise.resolve({ id: input.sampleId ?? 'sample-id' });
    }),
    findUnique: vi.fn((args: unknown) => {
      void args;
      return Promise.resolve({ id: input.existingSampleId ?? 'existing-sample-id' });
    }),
  };
  const current = {
    create: vi.fn((args: unknown) => {
      void args;
      return Promise.resolve({ id: 'current-id' });
    }),
    findUnique: vi.fn((args: unknown) => {
      void args;
      return Promise.resolve(input.existingCurrent ?? null);
    }),
    updateMany: vi.fn((args: unknown) => {
      void args;
      return Promise.resolve({ count: input.currentUpdateCount ?? 0 });
    }),
  };
  const device = {
    findUnique: vi.fn((args: unknown) => {
      void args;
      return Promise.resolve(input.device === undefined
        ? {
          id: deviceId,
          shopId,
          vehicle: { licensePlate: input.vehiclePlate ?? null },
          vehicleId,
        }
        : input.device);
    }),
  };
  const transaction = {
    dsvVehicleTelematicsDevice: device,
    uvisVehicleTelemetryCurrent: current,
    uvisVehicleTelemetrySample: sample,
  };
  const prisma = {
    $transaction: vi.fn((operation: (client: typeof transaction) => unknown) => operation(transaction)),
    ...transaction,
  };
  return { current, device, prisma, sample };
}
