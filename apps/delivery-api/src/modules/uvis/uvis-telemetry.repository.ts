import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';

export type UvisTelemetrySourceKind = 'VEHICLE_GPS' | 'TEMPERATURE_RECORDER';

export type UvisTelemetrySampleInput = {
  deviceId: string;
  sourceDeviceIdentifier: string;
  sourceKind: UvisTelemetrySourceKind;
  observedAt: Date;
  receivedAt: Date;
  staleAfter: Date;
  sourcePlate?: string | null;
  latitude?: string | null;
  longitude?: string | null;
  ignitionOn?: boolean | null;
  speedKph?: string | null;
  distanceTodayKm?: string | null;
  temperatureA?: string | null;
  temperatureB?: string | null;
};

export type UvisTelemetryStoreResult = {
  currentStatus: 'UPDATED' | 'HISTORY_ONLY' | 'UNCHANGED';
  plateStatus: 'MATCHED' | 'MISMATCH' | 'UNKNOWN';
  sampleId: string;
  sampleStatus: 'RECORDED' | 'DUPLICATE';
  shopId: string;
  vehicleId: string;
};

type DeviceRecord = {
  id: string;
  shopId: string;
  vehicleId: string;
  vehicle: {
    licensePlate: string | null;
  };
};

type UvisTelemetryPrismaClient = Pick<
  PrismaClient,
  '$transaction' | 'dsvVehicleTelematicsDevice' | 'uvisVehicleTelemetryCurrent' | 'uvisVehicleTelemetrySample'
>;

type UvisTelemetryTransactionClient = Pick<
  Prisma.TransactionClient,
  'dsvVehicleTelematicsDevice' | 'uvisVehicleTelemetryCurrent' | 'uvisVehicleTelemetrySample'
>;

const MAX_OBSERVED_AT_FUTURE_SKEW_MS = 5 * 60 * 1000;

export class UvisTelemetryDeviceNotFoundError extends Error {
  constructor(deviceId: string) {
    super(`UVIS telemetry device ${deviceId} was not found`);
    this.name = 'UvisTelemetryDeviceNotFoundError';
  }
}

export class UvisTelemetryObservedAtSkewError extends Error {
  constructor() {
    super('UVIS telemetry observedAt is too far in the future');
    this.name = 'UvisTelemetryObservedAtSkewError';
  }
}

export class PrismaUvisTelemetryRepository {
  constructor(private readonly prisma: UvisTelemetryPrismaClient) {}

  async recordSample(input: UvisTelemetrySampleInput): Promise<UvisTelemetryStoreResult> {
    return this.prisma.$transaction((transaction) => recordSampleInTransaction(transaction, input));
  }
}

async function recordSampleInTransaction(
  transaction: UvisTelemetryTransactionClient,
  input: UvisTelemetrySampleInput,
): Promise<UvisTelemetryStoreResult> {
  if (input.observedAt.getTime() - input.receivedAt.getTime() > MAX_OBSERVED_AT_FUTURE_SKEW_MS) {
    throw new UvisTelemetryObservedAtSkewError();
  }

  const device = await transaction.dsvVehicleTelematicsDevice.findUnique({
    include: {
      vehicle: {
        select: { licensePlate: true },
      },
    },
    where: { id: input.deviceId },
  }) as DeviceRecord | null;

  if (device === null) throw new UvisTelemetryDeviceNotFoundError(input.deviceId);

  const plateStatus = resolvePlateStatus(device.vehicle.licensePlate, input.sourcePlate);
  const sampleData = telemetryData(device, input, plateStatus);
  const sample = await createSample(transaction, input, sampleData);
  if (sample.duplicate) {
    return {
      currentStatus: 'UNCHANGED',
      plateStatus,
      sampleId: sample.id,
      sampleStatus: 'DUPLICATE',
      shopId: device.shopId,
      vehicleId: device.vehicleId,
    };
  }

  const currentData = {
    ...sampleData,
    lastSampleId: sample.id,
  };

  const updated = await transaction.uvisVehicleTelemetryCurrent.updateMany({
    data: currentData,
    where: {
      deviceId: device.id,
      observedAt: { lte: input.observedAt },
      shopId: device.shopId,
      sourceKind: input.sourceKind,
    },
  });

  if (updated.count > 0) {
    return {
      currentStatus: 'UPDATED',
      plateStatus,
      sampleId: sample.id,
      sampleStatus: 'RECORDED',
      shopId: device.shopId,
      vehicleId: device.vehicleId,
    };
  }

  const existingCurrent = await transaction.uvisVehicleTelemetryCurrent.findUnique({
    select: { id: true, observedAt: true },
    where: {
      shopId_deviceId_sourceKind: {
        deviceId: device.id,
        shopId: device.shopId,
        sourceKind: input.sourceKind,
      },
    },
  });

  if (existingCurrent !== null) {
    return {
      currentStatus: 'HISTORY_ONLY',
      plateStatus,
      sampleId: sample.id,
      sampleStatus: 'RECORDED',
      shopId: device.shopId,
      vehicleId: device.vehicleId,
    };
  }

  try {
    await transaction.uvisVehicleTelemetryCurrent.create({
      data: currentData,
    });
    return {
      currentStatus: 'UPDATED',
      plateStatus,
      sampleId: sample.id,
      sampleStatus: 'RECORDED',
      shopId: device.shopId,
      vehicleId: device.vehicleId,
    };
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const concurrentUpdate = await transaction.uvisVehicleTelemetryCurrent.updateMany({
      data: currentData,
      where: {
        deviceId: device.id,
        observedAt: { lte: input.observedAt },
        shopId: device.shopId,
        sourceKind: input.sourceKind,
      },
    });
    return {
      currentStatus: concurrentUpdate.count > 0 ? 'UPDATED' : 'HISTORY_ONLY',
      plateStatus,
      sampleId: sample.id,
      sampleStatus: 'RECORDED',
      shopId: device.shopId,
      vehicleId: device.vehicleId,
    };
  }
}

async function createSample(
  transaction: UvisTelemetryTransactionClient,
  input: UvisTelemetrySampleInput,
  sampleData: ReturnType<typeof telemetryData>,
): Promise<{ duplicate: boolean; id: string }> {
  try {
    const sample = await transaction.uvisVehicleTelemetrySample.create({
      data: sampleData,
      select: { id: true },
    });
    return { duplicate: false, id: sample.id };
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const existing = await transaction.uvisVehicleTelemetrySample.findUnique({
      select: { id: true },
      where: {
        deviceId_sourceKind_observedAt: {
          deviceId: input.deviceId,
          observedAt: input.observedAt,
          sourceKind: input.sourceKind,
        },
      },
    });
    if (existing === null) throw error;
    return { duplicate: true, id: existing.id };
  }
}

function telemetryData(
  device: DeviceRecord,
  input: UvisTelemetrySampleInput,
  plateStatus: UvisTelemetryStoreResult['plateStatus'],
) {
  return withoutUndefined({
    deviceId: device.id,
    distanceTodayKm: input.distanceTodayKm,
    ignitionOn: input.ignitionOn,
    latitude: input.latitude,
    longitude: input.longitude,
    observedAt: input.observedAt,
    plateMatched: plateStatus === 'UNKNOWN' ? null : plateStatus === 'MATCHED',
    receivedAt: input.receivedAt,
    shopId: device.shopId,
    sourceDeviceIdentifier: input.sourceDeviceIdentifier,
    sourceKind: input.sourceKind,
    sourcePlate: input.sourcePlate === undefined ? undefined : input.sourcePlate,
    speedKph: input.speedKph,
    staleAfter: input.staleAfter,
    temperatureA: input.temperatureA,
    temperatureB: input.temperatureB,
    vehicleId: device.vehicleId,
  });
}

function resolvePlateStatus(vehiclePlate: string | null, sourcePlate: string | null | undefined): UvisTelemetryStoreResult['plateStatus'] {
  const normalizedSourcePlate = normalizePlate(sourcePlate);
  const normalizedVehiclePlate = normalizePlate(vehiclePlate);
  if (normalizedSourcePlate === null || normalizedVehiclePlate === null) return 'UNKNOWN';
  return normalizedSourcePlate === normalizedVehiclePlate ? 'MATCHED' : 'MISMATCH';
}

function normalizePlate(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const normalized = value.replace(/\s+/gu, '').toUpperCase();
  return normalized.length === 0 ? null : normalized;
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): {
  [K in keyof T as undefined extends T[K] ? K : K]: Exclude<T[K], undefined>;
} {
  return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined)) as never;
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  ) || (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}
