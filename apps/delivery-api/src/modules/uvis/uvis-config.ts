import { UvisClientError } from './uvis-contract.js';

export type UvisRuntimeEnv = Partial<Record<
  | 'UVIS_ACCESS_KEY_URL'
  | 'UVIS_APP_ID'
  | 'UVIS_COMPANY_SERIAL_KEY'
  | 'UVIS_LOCATION_DORMANT_GRACE_PERIOD_MS'
  | 'UVIS_LOCATION_DORMANT_HEARTBEAT_INTERVAL_MS'
  | 'UVIS_ENABLED'
  | 'UVIS_LOCATION_POLL_INTERVAL_MS'
  | 'UVIS_LOCATION_GUBUN'
  | 'UVIS_SHOP_DOMAIN'
  | 'UVIS_TELEMETRY_URL'
  | 'UVIS_TEMPERATURE_POLL_INTERVAL_MS'
  | 'UVIS_TEMPERATURE_GUBUN'
  | 'UVIS_TIMEOUT_MS'
  | 'UVIS_ALLOWED_OUTBOUND_URLS',
  string
>>;

export type UvisClientConfig = {
  accessKeyUrl: string;
  allowedOutboundUrls: Array<{
    host: string;
    pathname: string;
    protocol: string;
  }>;
  companySerialKey: string;
  locationGubun: string;
  telemetryUrl: string;
  temperatureGubun: string;
  timeoutMs: number;
};

export type UvisRuntimeConfig = {
  appId: string;
  client: UvisClientConfig;
  locationDormantGracePeriodMs: number;
  locationDormantHeartbeatIntervalMs: number;
  locationPollIntervalMs: number;
  shopDomain: string;
  temperaturePollIntervalMs: number;
};

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_LOCATION_DORMANT_GRACE_PERIOD_MS = 600_000;
const DEFAULT_LOCATION_DORMANT_HEARTBEAT_INTERVAL_MS = 300_000;
const DEFAULT_LOCATION_POLL_INTERVAL_MS = 60_000;
const DEFAULT_TEMPERATURE_POLL_INTERVAL_MS = 300_000;
const MAX_TIMEOUT_MS = 30_000;
const MIN_LOCATION_DORMANT_GRACE_PERIOD_MS = 60_000;
const MIN_LOCATION_DORMANT_HEARTBEAT_INTERVAL_MS = 60_000;
const MIN_TIMEOUT_MS = 1_000;
const MIN_LOCATION_POLL_INTERVAL_MS = 60_000;
const MIN_TEMPERATURE_POLL_INTERVAL_MS = 300_000;

export function loadUvisRuntimeConfig(env: UvisRuntimeEnv = process.env): UvisRuntimeConfig | null {
  if (!readBoolean(env.UVIS_ENABLED, false)) return null;
  const client = loadUvisClientConfig(env);
  if (client === null) {
    throw invalidConfig('UVIS client settings must be configured when UVIS_ENABLED is true.');
  }
  return {
    appId: readOptional(env.UVIS_APP_ID) ?? 'clever',
    client,
    locationDormantGracePeriodMs: readBoundedInteger(
      env.UVIS_LOCATION_DORMANT_GRACE_PERIOD_MS,
      'UVIS_LOCATION_DORMANT_GRACE_PERIOD_MS',
      MIN_LOCATION_DORMANT_GRACE_PERIOD_MS,
      Number.MAX_SAFE_INTEGER,
    ) ?? DEFAULT_LOCATION_DORMANT_GRACE_PERIOD_MS,
    locationDormantHeartbeatIntervalMs: readBoundedInteger(
      env.UVIS_LOCATION_DORMANT_HEARTBEAT_INTERVAL_MS,
      'UVIS_LOCATION_DORMANT_HEARTBEAT_INTERVAL_MS',
      MIN_LOCATION_DORMANT_HEARTBEAT_INTERVAL_MS,
      Number.MAX_SAFE_INTEGER,
    ) ?? DEFAULT_LOCATION_DORMANT_HEARTBEAT_INTERVAL_MS,
    locationPollIntervalMs: readBoundedInteger(
      env.UVIS_LOCATION_POLL_INTERVAL_MS,
      'UVIS_LOCATION_POLL_INTERVAL_MS',
      MIN_LOCATION_POLL_INTERVAL_MS,
      Number.MAX_SAFE_INTEGER,
    ) ?? DEFAULT_LOCATION_POLL_INTERVAL_MS,
    shopDomain: requireConfigured(readOptional(env.UVIS_SHOP_DOMAIN), 'UVIS_SHOP_DOMAIN'),
    temperaturePollIntervalMs: readBoundedInteger(
      env.UVIS_TEMPERATURE_POLL_INTERVAL_MS,
      'UVIS_TEMPERATURE_POLL_INTERVAL_MS',
      MIN_TEMPERATURE_POLL_INTERVAL_MS,
      Number.MAX_SAFE_INTEGER,
    ) ?? DEFAULT_TEMPERATURE_POLL_INTERVAL_MS,
  };
}

export function loadUvisClientConfig(env: UvisRuntimeEnv = process.env): UvisClientConfig | null {
  const accessKeyUrl = readOptional(env.UVIS_ACCESS_KEY_URL);
  const companySerialKey = readOptional(env.UVIS_COMPANY_SERIAL_KEY);
  const locationGubun = readOptional(env.UVIS_LOCATION_GUBUN);
  const telemetryUrl = readOptional(env.UVIS_TELEMETRY_URL);
  const temperatureGubun = readOptional(env.UVIS_TEMPERATURE_GUBUN);
  const allowedOutboundUrls = readOptional(env.UVIS_ALLOWED_OUTBOUND_URLS);

  if (
    accessKeyUrl === null &&
    allowedOutboundUrls === null &&
    companySerialKey === null &&
    locationGubun === null &&
    telemetryUrl === null &&
    temperatureGubun === null
  ) {
    return null;
  }

  return {
    accessKeyUrl: requireConfigured(accessKeyUrl, 'UVIS_ACCESS_KEY_URL'),
    allowedOutboundUrls: parseAllowedOutboundUrls(requireConfigured(allowedOutboundUrls, 'UVIS_ALLOWED_OUTBOUND_URLS')),
    companySerialKey: requireConfigured(companySerialKey, 'UVIS_COMPANY_SERIAL_KEY'),
    locationGubun: requireConfigured(locationGubun, 'UVIS_LOCATION_GUBUN'),
    telemetryUrl: requireConfigured(telemetryUrl, 'UVIS_TELEMETRY_URL'),
    temperatureGubun: requireConfigured(temperatureGubun, 'UVIS_TEMPERATURE_GUBUN'),
    timeoutMs: readBoundedInteger(env.UVIS_TIMEOUT_MS, 'UVIS_TIMEOUT_MS', MIN_TIMEOUT_MS, MAX_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS,
  };
}

function readOptional(value: string | undefined): string | null {
  return value === undefined || value.trim() === '' ? null : value.trim();
}

function requireConfigured(value: string | null, name: string): string {
  if (value === null) {
    throw new UvisClientError({
      code: 'INVALID_CONFIG',
      message: `${name} must be configured for UVIS integration.`,
      operation: 'access-key',
      transient: false,
    });
  }
  return value;
}

function readBoundedInteger(value: string | undefined, name: string, minimum: number, maximum: number): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  if (!/^\d+$/u.test(value.trim())) {
    throw invalidConfig(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw invalidConfig(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function parseAllowedOutboundUrls(value: string): UvisClientConfig['allowedOutboundUrls'] {
  const entries = value.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '');
  if (entries.length === 0) throw invalidConfig('UVIS_ALLOWED_OUTBOUND_URLS must list allowed UVIS endpoint URLs.');
  return entries.map((entry) => {
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      throw invalidConfig('UVIS_ALLOWED_OUTBOUND_URLS must contain valid URLs.');
    }
    return {
      host: url.host,
      pathname: url.pathname,
      protocol: url.protocol,
    };
  });
}

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw invalidConfig('UVIS_ENABLED must be true or false.');
}

function invalidConfig(message: string): UvisClientError {
  return new UvisClientError({
    code: 'INVALID_CONFIG',
    message,
    operation: 'access-key',
    transient: false,
  });
}
