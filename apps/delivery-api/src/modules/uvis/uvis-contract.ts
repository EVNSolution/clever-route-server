export type UvisTelemetryKind = 'location' | 'temperature';

export type UvisLocationReading = {
  deviceId: string;
  plateNumber: string;
  latitude: number;
  longitude: number;
  recordedAt: Date;
  ignitionOn: boolean | null;
  dayDistanceKm: number | null;
  gpsSpeedKph: number | null;
};

export type UvisTemperatureReading = {
  deviceId: string;
  plateNumber: string;
  latitude: number;
  longitude: number;
  recordedAt: Date;
  temperatureA: number | null;
  temperatureB: number | null;
};

export type UvisClientErrorCode =
  | 'AUTH_FAILED'
  | 'HTTP_ERROR'
  | 'INVALID_CONFIG'
  | 'INVALID_RESPONSE'
  | 'NETWORK_ERROR'
  | 'RATE_LIMITED'
  | 'TIMEOUT';

export class UvisClientError extends Error {
  readonly code: UvisClientErrorCode;
  readonly operation: 'access-key' | UvisTelemetryKind;
  readonly status: number | null;
  readonly transient: boolean;

  constructor(input: {
    code: UvisClientErrorCode;
    message: string;
    operation: 'access-key' | UvisTelemetryKind;
    status?: number | null;
    transient: boolean;
  }) {
    super(input.message);
    this.name = 'UvisClientError';
    this.code = input.code;
    this.operation = input.operation;
    this.status = input.status ?? null;
    this.transient = input.transient;
  }
}

export function parseUvisAccessKeyResponse(payload: unknown): string {
  const record = objectOrNull(Array.isArray(payload) ? payload[0] : payload);
  if (record === null) {
    throw invalidResponse('access-key', 'UVIS access-key response was invalid.');
  }

  const accessKey = readRequiredString(record, ['AccessKey', 'ACCESS_KEY', 'accessKey']);
  if (accessKey === null) {
    throw invalidResponse('access-key', 'UVIS access-key response did not include an access key.');
  }
  return accessKey;
}

export function parseUvisLocationResponse(payload: unknown): UvisLocationReading[] {
  return readArrayPayload(payload, 'location').map((record) => {
    const deviceId = readRequiredString(record, ['TID_ID']);
    const plateNumber = readRequiredString(record, ['CM_NUMBER']);
    const latitude = readCoordinate(record.BI_X_POSITION, 'latitude');
    const longitude = readCoordinate(record.BI_Y_POSITION, 'longitude');
    const recordedAt = parseUvisDateTime(record.BI_DATE, record.BI_TIME);
    if (deviceId === null || plateNumber === null || latitude === null || longitude === null || recordedAt === null) {
      throw invalidResponse('location', 'UVIS location response contained invalid identity, coordinates, or datetime.');
    }

    return {
      dayDistanceKm: readOptionalNumber(record.BI_DAY_DISTANCE),
      deviceId,
      gpsSpeedKph: readOptionalNumber(record.BI_GPS_SPEED),
      ignitionOn: readIgnition(record.BI_TURN_ONOFF),
      latitude,
      longitude,
      plateNumber,
      recordedAt,
    };
  });
}

export function parseUvisTemperatureResponse(payload: unknown): UvisTemperatureReading[] {
  return readArrayPayload(payload, 'temperature').map((record) => {
    const deviceId = readRequiredString(record, ['TID_ID']);
    const plateNumber = readRequiredString(record, ['CM_NUMBER']);
    const latitude = readCoordinate(record.TPL_X_POSITION, 'latitude');
    const longitude = readCoordinate(record.TPL_Y_POSITION, 'longitude');
    const recordedAt = parseUvisDateTime(record.TPL_DATE, record.TPL_TIME);
    if (deviceId === null || plateNumber === null || latitude === null || longitude === null || recordedAt === null) {
      throw invalidResponse('temperature', 'UVIS temperature response contained invalid identity, coordinates, or datetime.');
    }
    const temperatureA = readSignedTemperature(record.TPL_SIGNAL_A, record.TPL_DEGREE_A);
    const temperatureB = readSignedTemperature(record.TPL_SIGNAL_B, record.TPL_DEGREE_B);
    if ((hasValue(record.TPL_DEGREE_A) && temperatureA === null) || (hasValue(record.TPL_DEGREE_B) && temperatureB === null)) {
      throw invalidResponse('temperature', 'UVIS temperature response contained invalid signed temperature.');
    }

    return {
      deviceId,
      latitude,
      longitude,
      plateNumber,
      recordedAt,
      temperatureA,
      temperatureB,
    };
  });
}

function readArrayPayload(payload: unknown, operation: UvisTelemetryKind): Array<Record<string, unknown>> {
  if (Array.isArray(payload)) return payload.map((item) => requireRecord(item, operation));

  const root = objectOrNull(payload);
  const candidate =
    root?.Data ?? root?.Result ?? root?.List ?? objectOrNull(root?.response)?.Data ?? objectOrNull(root?.response)?.Result;
  if (Array.isArray(candidate)) return candidate.map((item) => requireRecord(item, operation));

  throw invalidResponse(operation, `UVIS ${operation} response did not include an array payload.`);
}

function requireRecord(value: unknown, operation: UvisTelemetryKind): Record<string, unknown> {
  const record = objectOrNull(value);
  if (record === null) {
    throw invalidResponse(operation, `UVIS ${operation} response included a non-object row.`);
  }
  return record;
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readRequiredString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const raw = record[key];
    if (typeof raw === 'string' && raw.trim() !== '') return raw.trim();
    if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  }
  return null;
}

function readCoordinate(value: unknown, kind: 'latitude' | 'longitude'): number | null {
  const parsed = readOptionalNumber(value);
  if (parsed === null) return null;
  if (kind === 'latitude') return parsed >= -90 && parsed <= 90 ? parsed : null;
  return parsed >= -180 && parsed <= 180 ? parsed : null;
}

function readOptionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (normalized === '') return null;
  if (!/^[+-]?\d+(?:\.\d+)?$/u.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function readIgnition(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
    return null;
  }
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  if (['1', 'Y', 'YES', 'ON', 'TRUE'].includes(normalized)) return true;
  if (['0', 'N', 'NO', 'OFF', 'FALSE'].includes(normalized)) return false;
  return null;
}

function readSignedTemperature(signal: unknown, degree: unknown): number | null {
  const unsigned = readOptionalNumber(degree);
  if (unsigned === null) return null;
  const sign = readTemperatureSign(signal);
  if (sign === null) return null;
  const signed = Math.abs(unsigned) * sign;
  return signed >= -100 && signed <= 100 ? signed : null;
}

function readTemperatureSign(value: unknown): 1 | -1 | null {
  if (value === null || value === undefined || value === '') return 1;
  const raw =
    typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : typeof value === 'string'
        ? value.trim().toUpperCase()
        : '';
  if (['+', 'P', 'PLUS', 'POSITIVE', '0', '1'].includes(raw)) return 1;
  if (['-', 'M', 'MINUS', 'NEGATIVE', '2'].includes(raw)) return -1;
  return null;
}

function hasValue(value: unknown): boolean {
  return value !== null && value !== undefined && value !== '';
}

function parseUvisDateTime(dateValue: unknown, timeValue: unknown): Date | null {
  const date = typeof dateValue === 'number' ? String(dateValue) : typeof dateValue === 'string' ? dateValue.trim() : '';
  const time = typeof timeValue === 'number' ? String(timeValue).padStart(6, '0') : typeof timeValue === 'string' ? timeValue.trim().padStart(6, '0') : '';
  if (!/^\d{8}$/u.test(date) || !/^\d{6}$/u.test(time)) return null;

  const year = date.slice(0, 4);
  const month = date.slice(4, 6);
  const day = date.slice(6, 8);
  const hour = time.slice(0, 2);
  const minute = time.slice(2, 4);
  const second = time.slice(4, 6);
  const parsed = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}+09:00`);
  if (Number.isNaN(parsed.getTime())) return null;
  const seoulWallClock = new Date(parsed.getTime() + (9 * 60 * 60 * 1000));
  return seoulWallClock.getUTCFullYear() === Number(year)
    && seoulWallClock.getUTCMonth() + 1 === Number(month)
    && seoulWallClock.getUTCDate() === Number(day)
    && seoulWallClock.getUTCHours() === Number(hour)
    && seoulWallClock.getUTCMinutes() === Number(minute)
    && seoulWallClock.getUTCSeconds() === Number(second)
    ? parsed
    : null;
}

function invalidResponse(operation: 'access-key' | UvisTelemetryKind, message: string): UvisClientError {
  return new UvisClientError({
    code: 'INVALID_RESPONSE',
    message,
    operation,
    transient: false,
  });
}
