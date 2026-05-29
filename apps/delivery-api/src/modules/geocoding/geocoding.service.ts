import type { GeocodingAddress, GeocodingProvider, GeocodingResult } from './geocoding.types.js';

export type GeocodingServiceOptions = {
  minIntervalMs?: number;
  mode: 'disabled' | 'nominatim_compatible';
  persistentCacheEnabled?: boolean;
  provider?: GeocodingProvider;
  requirePersistentCache?: boolean;
};

type CachedGeocode = {
  cachedAt: number;
  result: GeocodingResult;
};

export class GeocodingService {
  private readonly cache = new Map<string, CachedGeocode>();
  private readonly minIntervalMs: number;
  private readonly mode: GeocodingServiceOptions['mode'];
  private readonly persistentCacheEnabled: boolean;
  private readonly provider: GeocodingProvider | undefined;
  private readonly requirePersistentCache: boolean;
  private queue: Promise<void> = Promise.resolve();
  private lastRequestAt = 0;

  constructor(options: GeocodingServiceOptions) {
    this.minIntervalMs = options.minIntervalMs ?? 1000;
    this.mode = options.mode;
    this.persistentCacheEnabled = options.persistentCacheEnabled === true;
    this.provider = options.provider;
    this.requirePersistentCache = options.requirePersistentCache === true;
  }

  get status(): { mode: GeocodingServiceOptions['mode']; persistentCacheEnabled: boolean } {
    return { mode: this.mode, persistentCacheEnabled: this.persistentCacheEnabled };
  }

  async geocode(input: { address: GeocodingAddress; shopDomain: string }): Promise<GeocodingResult> {
    const queries = normalizeAddressQueries(input.address);
    const query = queries[0] ?? null;
    if (query === null) {
      return { ok: false, code: 'BLANK_ADDRESS', message: 'Address is blank.' };
    }
    if (this.mode === 'disabled') {
      return { ok: false, code: 'GEOCODER_DISABLED', message: 'Geocoding is disabled for this runtime.' };
    }
    if (this.provider === undefined) {
      return { ok: false, code: 'GEOCODER_NOT_CONFIGURED', message: 'Geocoding provider is not configured.' };
    }
    if (this.requirePersistentCache && !this.persistentCacheEnabled) {
      return {
        ok: false,
        code: 'GEOCODER_NOT_CONFIGURED',
        message: 'Public geocoding requires durable per-order metadata or persistent cache.'
      };
    }

    const key = `${input.shopDomain.trim().toLowerCase()}|${query.toLowerCase()}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached.result.ok ? { ...cached.result, cached: true } : cached.result;

    const provider = this.provider;
    const result = await this.runSerialized(async () => {
      let sawInvalidResult = false;
      try {
        for (const lookupQuery of queries) {
          const lookup = await provider.geocodeAddress(lookupQuery);
          if (lookup === null) continue;
          if (!isValidCoordinate(lookup.latitude, 'latitude') || !isValidCoordinate(lookup.longitude, 'longitude')) {
            sawInvalidResult = true;
            continue;
          }
          return { ok: true, cached: false, result: lookup } satisfies GeocodingResult;
        }
        if (sawInvalidResult) {
          return { ok: false, code: 'GEOCODER_INVALID_RESULT', message: 'Geocoding provider returned invalid coordinates.' } satisfies GeocodingResult;
        }
        return { ok: false, code: 'GEOCODER_NO_RESULT', message: 'No geocoding result was found.' } satisfies GeocodingResult;
      } catch {
        return { ok: false, code: 'GEOCODER_PROVIDER_ERROR', message: 'Geocoding provider failed.' } satisfies GeocodingResult;
      }
    });
    this.cache.set(key, { cachedAt: Date.now(), result });
    return result;
  }

  private async runSerialized<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const now = Date.now();
      const waitMs = Math.max(0, this.minIntervalMs - (now - this.lastRequestAt));
      if (waitMs > 0) await sleep(waitMs);
      this.lastRequestAt = Date.now();
      return task();
    });
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }
}

export function normalizeAddress(address: GeocodingAddress): string | null {
  return normalizeAddressParts(addressParts(address));
}

export function normalizeAddressQueries(address: GeocodingAddress): string[] {
  const full = normalizeAddress(address);
  if (full === null) return [];

  const withoutAddress2 = normalizeAddressParts(
    addressParts({
      ...address,
      address2: null
    })
  );
  return uniqueQueries([
    full,
    address.address2 === null || address.address2.trim() === '' ? null : withoutAddress2
  ]);
}

function addressParts(address: GeocodingAddress): Array<string | null> {
  return [address.address1, address.address2, address.city, address.province, address.postalCode, address.countryCode];
}

function normalizeAddressParts(parts: Array<string | null>): string | null {
  const normalized = parts
    .map((part) => (typeof part === 'string' ? part.trim() : ''))
    .filter((part) => part !== '');
  if (normalized.length === 0) return null;
  return [...new Set(normalized)].join(', ');
}

function uniqueQueries(queries: Array<string | null>): string[] {
  return [...new Set(queries.filter((query): query is string => query !== null && query.trim() !== ''))];
}

export function isValidCoordinate(value: number, kind: 'latitude' | 'longitude'): boolean {
  const min = kind === 'latitude' ? -90 : -180;
  const max = kind === 'latitude' ? 90 : 180;
  return Number.isFinite(value) && value >= min && value <= max;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
