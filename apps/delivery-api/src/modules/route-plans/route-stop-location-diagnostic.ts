export type RouteStopLocationIssue =
  | 'COORDINATES_MISSING'
  | 'COORDINATES_PARTIAL'
  | 'COORDINATES_ZERO'
  | 'COORDINATES_OUT_OF_RANGE'
  | 'COUNTRY_CODE_INVALID'
  | 'COORDINATES_OUTSIDE_COUNTRY'
  | 'COORDINATES_OUTSIDE_PROVINCE'
  | 'GEOCODE_STATUS_INCONSISTENT';

export type RouteStopLocationDiagnostic = {
  issues: RouteStopLocationIssue[];
  routeable: boolean;
  severity: 'NONE' | 'CRITICAL';
};

type RouteStopLocationInput = {
  countryCode?: string | null | undefined;
  geocodeStatus?: string | null | undefined;
  latitude?: unknown;
  longitude?: unknown;
  province?: string | null | undefined;
};

type Bounds = {
  maxLatitude: number;
  maxLongitude: number;
  minLatitude: number;
  minLongitude: number;
};

function hasToNumber(value: unknown): value is { toNumber: () => unknown } {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as { toNumber?: unknown };
  return typeof candidate.toNumber === 'function';
}

const COUNTRY_BOUNDS: Record<string, Bounds> = {
  CA: { maxLatitude: 83.2, maxLongitude: -52.5, minLatitude: 41.6, minLongitude: -141 },
  KR: { maxLatitude: 39.5, maxLongitude: 132, minLatitude: 33, minLongitude: 124 }
};

const PROVINCE_BOUNDS: Record<string, Bounds> = {
  ON: { maxLatitude: 56.9, maxLongitude: -74.3, minLatitude: 41.5, minLongitude: -95.2 }
};

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  if (hasToNumber(value)) {
    const number: unknown = value.toNumber();
    return typeof number === 'number' && Number.isFinite(number) ? number : null;
  }
  return null;
}

function normalizeCountryCode(value: string | null | undefined): string | null {
  const normalized = value?.trim().toUpperCase() ?? '';
  return normalized === '' ? null : normalized;
}

function normalizeProvince(value: string | null | undefined): string | null {
  const normalized = value?.trim().toUpperCase().replaceAll(/[^A-Z]/gu, '') ?? '';
  if (normalized === 'ONTARIO') return 'ON';
  return normalized === '' ? null : normalized;
}

function isInsideBounds(latitude: number, longitude: number, bounds: Bounds): boolean {
  return latitude >= bounds.minLatitude && latitude <= bounds.maxLatitude &&
    longitude >= bounds.minLongitude && longitude <= bounds.maxLongitude;
}

export function diagnoseRouteStopLocation(input: RouteStopLocationInput): RouteStopLocationDiagnostic {
  const issues: RouteStopLocationIssue[] = [];
  const countryCode = normalizeCountryCode(input.countryCode);
  const province = normalizeProvince(input.province);
  const latitude = numberOrNull(input.latitude);
  const longitude = numberOrNull(input.longitude);
  const hasLatitude = latitude !== null;
  const hasLongitude = longitude !== null;

  if (countryCode !== null && !/^[A-Z]{2}$/u.test(countryCode)) {
    issues.push('COUNTRY_CODE_INVALID');
  }

  if (!hasLatitude && !hasLongitude) {
    issues.push('COORDINATES_MISSING');
  } else if (!hasLatitude || !hasLongitude) {
    issues.push('COORDINATES_PARTIAL');
  } else if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    issues.push('COORDINATES_OUT_OF_RANGE');
  } else if (latitude === 0 && longitude === 0) {
    issues.push('COORDINATES_ZERO');
  } else {
    const countryBounds = countryCode === null ? undefined : COUNTRY_BOUNDS[countryCode];
    if (countryBounds && !isInsideBounds(latitude, longitude, countryBounds)) {
      issues.push('COORDINATES_OUTSIDE_COUNTRY');
    }

    const provinceBounds = province === null ? undefined : PROVINCE_BOUNDS[province];
    if (provinceBounds && !isInsideBounds(latitude, longitude, provinceBounds)) {
      issues.push('COORDINATES_OUTSIDE_PROVINCE');
    }
  }

  if (input.geocodeStatus?.trim().toUpperCase() === 'RESOLVED' && issues.length > 0) {
    issues.push('GEOCODE_STATUS_INCONSISTENT');
  }

  return issues.length === 0
    ? { issues, routeable: true, severity: 'NONE' }
    : { issues, routeable: false, severity: 'CRITICAL' };
}
