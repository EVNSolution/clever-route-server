export type DsvGeofenceMode = 'OFF' | 'SHADOW' | 'LIVE';

export type DsvGeofencePolicy = {
  mode: DsvGeofenceMode;
  policyVersion: string;
  warehouseRadiusMeters: number;
  warehouseExitRadiusMeters: number;
  destinationRadiusMeters: number;
  destinationExitRadiusMeters: number;
  arrivalDwellSeconds: number;
  arrivalMinSamples: number;
  exitDwellSeconds: number;
  exitMinSamples: number;
  maxGapSeconds: number;
  maxObservationDelaySeconds: number;
  futureToleranceSeconds: number;
  maxSpeedKph: number;
  reminderIntervalSeconds: number;
  maxReminderCount: number | null;
  notificationTtlSeconds: number;
};

export function parseDsvGeofencePolicy(value: unknown): DsvGeofencePolicy | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (source.mode === 'OFF') return null;
  if (source.mode !== 'SHADOW' && source.mode !== 'LIVE') return null;
  const policyVersion = readString(source.policyVersion);
  const warehouseRadiusMeters = readPositiveNumber(source.warehouseRadiusMeters);
  const warehouseExitRadiusMeters = readPositiveNumber(source.warehouseExitRadiusMeters);
  const destinationRadiusMeters = readPositiveNumber(source.destinationRadiusMeters);
  const destinationExitRadiusMeters = readPositiveNumber(source.destinationExitRadiusMeters);
  const arrivalDwellSeconds = readNonNegativeNumber(source.arrivalDwellSeconds);
  const arrivalMinSamples = readPositiveInteger(source.arrivalMinSamples);
  const exitDwellSeconds = readNonNegativeNumber(source.exitDwellSeconds);
  const exitMinSamples = readPositiveInteger(source.exitMinSamples);
  const maxGapSeconds = readPositiveNumber(source.maxGapSeconds);
  const maxObservationDelaySeconds = readNonNegativeNumber(source.maxObservationDelaySeconds);
  const futureToleranceSeconds = readNonNegativeNumber(source.futureToleranceSeconds);
  const maxSpeedKph = readPositiveNumber(source.maxSpeedKph);
  const reminderIntervalSeconds = readPositiveNumber(source.reminderIntervalSeconds);
  const notificationTtlSeconds = readPositiveNumber(source.notificationTtlSeconds);
  const maxReminderCount = source.maxReminderCount === null
    ? null
    : readPositiveInteger(source.maxReminderCount);

  if (
    policyVersion === null
    || warehouseRadiusMeters === null
    || warehouseExitRadiusMeters === null
    || warehouseExitRadiusMeters <= warehouseRadiusMeters
    || destinationRadiusMeters === null
    || destinationExitRadiusMeters === null
    || destinationExitRadiusMeters <= destinationRadiusMeters
    || arrivalDwellSeconds === null
    || arrivalMinSamples === undefined
    || exitDwellSeconds === null
    || exitMinSamples === undefined
    || maxGapSeconds === null
    || maxObservationDelaySeconds === null
    || futureToleranceSeconds === null
    || maxSpeedKph === null
    || reminderIntervalSeconds === null
    || reminderIntervalSeconds < 300
    || notificationTtlSeconds === null
    || maxReminderCount === undefined
  ) return null;

  return {
    arrivalDwellSeconds,
    arrivalMinSamples,
    destinationExitRadiusMeters,
    destinationRadiusMeters,
    exitDwellSeconds,
    exitMinSamples,
    futureToleranceSeconds,
    maxGapSeconds,
    maxObservationDelaySeconds,
    maxReminderCount,
    maxSpeedKph,
    mode: source.mode,
    notificationTtlSeconds,
    policyVersion,
    reminderIntervalSeconds,
    warehouseExitRadiusMeters,
    warehouseRadiusMeters,
  };
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readPositiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function readNonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}
