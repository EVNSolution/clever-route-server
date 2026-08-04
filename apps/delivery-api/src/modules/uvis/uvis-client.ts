import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

import type { UvisClientConfig } from './uvis-config.js';
import {
  parseUvisAccessKeyResponse,
  parseUvisLocationResponse,
  parseUvisTemperatureResponse,
  UvisClientError,
  type UvisLocationReading,
  type UvisTelemetryKind,
  type UvisTemperatureReading,
} from './uvis-contract.js';

type FetchLike = (url: URL, init: {
  headers: { Accept: string };
  method: 'GET';
  redirect: 'manual';
  signal?: AbortSignal;
}, addresses: string[]) => Promise<Response>;
type ResolveHostAddresses = (hostname: string) => Promise<string[]>;

export type UvisClientOptions = UvisClientConfig & {
  fetchImpl?: FetchLike | undefined;
  now?: (() => number) | undefined;
  random?: (() => number) | undefined;
  resolveHostAddresses?: ResolveHostAddresses | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
};

type AccessKeyCache = {
  expiresAtMs: number;
  value: string;
};

const ACCESS_KEY_TTL_MS = 5 * 60 * 1000;
const ACCESS_KEY_REFRESH_SKEW_MS = 30 * 1000;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 100;
const SERIAL_KEY_QUERY_PARAM = 'SerialKey';
const ACCESS_KEY_QUERY_PARAM = 'AccessKey';
const GUBUN_QUERY_PARAM = 'GUBUN';

export class UvisClient {
  private accessKey: AccessKeyCache | null = null;
  private accessKeyFlight: Promise<string> | null = null;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly resolveHostAddresses: ResolveHostAddresses;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: UvisClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetchPinned;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.resolveHostAddresses = options.resolveHostAddresses ?? resolveHostAddresses;
    this.sleep = options.sleep ?? sleep;
    assertAllowedOutboundUrl(options.accessKeyUrl, 'UVIS_ACCESS_KEY_URL', options.allowedOutboundUrls);
    assertAllowedOutboundUrl(options.telemetryUrl, 'UVIS_TELEMETRY_URL', options.allowedOutboundUrls);
  }

  async getLatestLocations(): Promise<UvisLocationReading[]> {
    return this.requestTelemetry('location');
  }

  async getLatestTemperatures(): Promise<UvisTemperatureReading[]> {
    return this.requestTelemetry('temperature');
  }

  async getAccessKey(): Promise<string> {
    return this.readAccessKey(false);
  }

  private async readAccessKey(forceRefresh: boolean): Promise<string> {
    if (!forceRefresh && this.accessKey !== null && this.accessKey.expiresAtMs - ACCESS_KEY_REFRESH_SKEW_MS > this.now()) {
      return this.accessKey.value;
    }
    if (this.accessKeyFlight !== null) return this.accessKeyFlight;

    this.accessKeyFlight = this.issueAccessKey()
      .then((value) => {
        this.accessKey = {
          expiresAtMs: this.now() + ACCESS_KEY_TTL_MS,
          value,
        };
        return value;
      })
      .finally(() => {
        this.accessKeyFlight = null;
      });
    return this.accessKeyFlight;
  }

  private async issueAccessKey(): Promise<string> {
    const url = this.buildUrl(this.options.accessKeyUrl, [[SERIAL_KEY_QUERY_PARAM, this.options.companySerialKey]]);
    const payload = await this.requestJson(url, 'access-key');
    return parseUvisAccessKeyResponse(payload);
  }

  private async requestTelemetry(kind: 'location'): Promise<UvisLocationReading[]>;
  private async requestTelemetry(kind: 'temperature'): Promise<UvisTemperatureReading[]>;
  private async requestTelemetry(kind: UvisTelemetryKind): Promise<UvisLocationReading[] | UvisTemperatureReading[]> {
    const firstAccessKey = await this.readAccessKey(false);
    try {
      return await this.requestTelemetryWithAccessKey(kind, firstAccessKey);
    } catch (error) {
      if (!isAuthFailure(error)) throw error;
      const refreshedAccessKey = await this.readAccessKey(true);
      return this.requestTelemetryWithAccessKey(kind, refreshedAccessKey);
    }
  }

  private async requestTelemetryWithAccessKey(
    kind: UvisTelemetryKind,
    accessKey: string
  ): Promise<UvisLocationReading[] | UvisTemperatureReading[]> {
    const discriminator =
      kind === 'location'
        ? this.options.locationGubun
        : this.options.temperatureGubun;
    const url = this.buildUrl(this.options.telemetryUrl, [
      [ACCESS_KEY_QUERY_PARAM, accessKey],
      [GUBUN_QUERY_PARAM, discriminator],
    ]);
    const payload = await this.requestJson(url, kind);
    return kind === 'location'
      ? parseUvisLocationResponse(payload)
      : parseUvisTemperatureResponse(payload);
  }

  private buildUrl(value: string, params: Array<[string, string]>): URL {
    const url = new URL(value);
    for (const [key, value] of params) {
      url.searchParams.set(key, value);
    }
    return url;
  }

  private async requestJson(url: URL, operation: 'access-key' | UvisTelemetryKind): Promise<unknown> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      try {
        const response = await this.fetchWithTimeout(url, operation);
        if (response.status === 401 || response.status === 403) {
          throw new UvisClientError({
            code: 'AUTH_FAILED',
            message: `UVIS ${operation} request was not authorized.`,
            operation,
            status: response.status,
            transient: false,
          });
        }
        if (!response.ok) {
          const retryable = response.status === 429 || response.status >= 500;
          const error = new UvisClientError({
            code: response.status === 429 ? 'RATE_LIMITED' : 'HTTP_ERROR',
            message: `UVIS ${operation} request failed with HTTP ${response.status}.`,
            operation,
            status: response.status,
            transient: retryable,
          });
          if (retryable && attempt < MAX_ATTEMPTS - 1) {
            await this.sleep(retryDelayMs(attempt, this.random));
            continue;
          }
          throw error;
        }
        return await readJson(response, operation);
      } catch (error) {
        if (error instanceof UvisClientError) throw error;
        const mapped = mapFetchError(error, operation);
        if (mapped.transient && attempt < MAX_ATTEMPTS - 1) {
          await this.sleep(retryDelayMs(attempt, this.random));
          continue;
        }
        throw mapped;
      }
    }

    throw new UvisClientError({
      code: 'NETWORK_ERROR',
      message: `UVIS ${operation} request failed.`,
      operation,
      transient: true,
    });
  }

  private async fetchWithTimeout(url: URL, operation: 'access-key' | UvisTelemetryKind): Promise<Response> {
    const addresses = await resolveAllowedHostAddresses(url.hostname, operation, this.resolveHostAddresses);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      return await this.fetchImpl(url, {
        headers: { Accept: 'application/json' },
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
      }, addresses);
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function readJson(response: Response, operation: 'access-key' | UvisTelemetryKind): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new UvisClientError({
      code: 'INVALID_RESPONSE',
      message: `UVIS ${operation} response was not valid JSON.`,
      operation,
      transient: false,
    });
  }
}

function mapFetchError(error: unknown, operation: 'access-key' | UvisTelemetryKind): UvisClientError {
  if (isAbortError(error)) {
    return new UvisClientError({
      code: 'TIMEOUT',
      message: `UVIS ${operation} request timed out.`,
      operation,
      transient: true,
    });
  }
  return new UvisClientError({
    code: 'NETWORK_ERROR',
    message: `UVIS ${operation} request failed due to a network error.`,
    operation,
    transient: true,
  });
}

function retryDelayMs(attempt: number, random: () => number): number {
  const jitterMs = Math.floor(random() * 50);
  return RETRY_BASE_MS * (2 ** attempt) + jitterMs;
}

function isAuthFailure(error: unknown): boolean {
  return error instanceof UvisClientError && error.code === 'AUTH_FAILED';
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException && error.name === 'AbortError'
  ) || (
    error instanceof Error && error.name === 'AbortError'
  );
}

function assertAllowedOutboundUrl(
  value: string,
  name: string,
  allowlist: UvisClientConfig['allowedOutboundUrls'],
): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UvisClientError({
      code: 'INVALID_CONFIG',
      message: `${name} must be a valid URL.`,
      operation: 'access-key',
      transient: false,
    });
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== '') {
    throw invalidOutboundUrl(name);
  }
  if (isForbiddenHost(url.hostname)) throw invalidOutboundUrl(name);
  if (!allowlist.some((allowed) => (
    allowed.protocol === url.protocol &&
    allowed.host === url.host &&
    allowed.pathname === url.pathname
  ))) {
    throw invalidOutboundUrl(name);
  }
}

function invalidOutboundUrl(name: string): UvisClientError {
  return new UvisClientError({
    code: 'INVALID_CONFIG',
    message: `${name} is not an allowed UVIS outbound endpoint.`,
    operation: 'access-key',
    transient: false,
  });
}

function isForbiddenHost(hostname: string): boolean {
  const normalized = normalizeHost(hostname);
  if (normalized === 'localhost' || normalized.endsWith('.localhost') || normalized.endsWith('.local')) return true;
  const ipVersion = isIP(normalized);
  if (ipVersion === 4) return isForbiddenIpv4(normalized);
  if (ipVersion === 6) return isForbiddenIpv6(normalized);
  return false;
}

function isForbiddenIpv4(value: string): boolean {
  const octets = value.split('.').map((octet) => Number.parseInt(octet, 10));
  const [a = 0, b = 0] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 100 && b >= 64 && b <= 127 ||
    a === 127 ||
    a === 169 && b === 254 ||
    a === 172 && b >= 16 && b <= 31 ||
    a === 192 && b === 0 ||
    a === 192 && b === 168 ||
    a === 198 && (b === 18 || b === 19) ||
    a === 198 && b === 51 ||
    a === 203 && b === 0 ||
    a >= 224
  );
}

function isForbiddenIpv6(value: string): boolean {
  // The contracted provider currently resolves to IPv4 only. IPv6 stays fail-closed
  // until a reviewed provider CIDR allowlist can be enforced at the network boundary.
  void value;
  return true;
}

async function resolveAllowedHostAddresses(
  hostname: string,
  operation: 'access-key' | UvisTelemetryKind,
  resolveHostAddresses: ResolveHostAddresses,
): Promise<string[]> {
  let addresses: string[];
  try {
    addresses = await resolveHostAddresses(hostname);
  } catch {
    throw new UvisClientError({
      code: 'NETWORK_ERROR',
      message: `UVIS ${operation} request failed due to a network error.`,
      operation,
      transient: true,
    });
  }
  if (addresses.length === 0 || addresses.some((address) => (
    isIP(normalizeHost(address)) !== 4 || isForbiddenHost(address)
  ))) {
    throw new UvisClientError({
      code: 'INVALID_CONFIG',
      message: `UVIS ${operation} request target is not allowed.`,
      operation,
      transient: false,
    });
  }
  return addresses;
}

async function resolveHostAddresses(hostname: string): Promise<string[]> {
  const records = await lookup(normalizeHost(hostname), { all: true });
  return records.map((record) => record.address);
}

async function fetchPinned(url: URL, init: Parameters<FetchLike>[1], addresses: string[]): Promise<Response> {
  const address = addresses[0];
  if (address === undefined) throw new Error('UVIS pinned request requires a resolved address.');

  return new Promise<Response>((resolve, reject) => {
    const request = httpsRequest(url, {
      headers: init.headers,
      lookup: (_hostname, _options, callback) => callback(null, address, 4),
      method: init.method,
      signal: init.signal,
    }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      incoming.on('end', () => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) {
            for (const item of value) headers.append(name, item);
          } else if (value !== undefined) {
            headers.set(name, value);
          }
        }
        resolve(new Response(Buffer.concat(chunks), {
          headers,
          status: incoming.statusCode ?? 500,
          statusText: incoming.statusMessage ?? '',
        }));
      });
      incoming.on('error', reject);
    });
    request.on('error', reject);
    request.end();
  });
}

function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[/u, '').replace(/\]$/u, '');
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
