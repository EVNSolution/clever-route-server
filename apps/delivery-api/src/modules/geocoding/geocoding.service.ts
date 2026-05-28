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
    const query = normalizeAddress(input.address);
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
      try {
        const lookup = await provider.geocodeAddress(query);
        if (lookup === null) {
          return { ok: false, code: 'GEOCODER_NO_RESULT', message: 'No geocoding result was found.' } satisfies GeocodingResult;
        }
        if (!isValidCoordinate(lookup.latitude, 'latitude') || !isValidCoordinate(lookup.longitude, 'longitude')) {
          return { ok: false, code: 'GEOCODER_INVALID_RESULT', message: 'Geocoding provider returned invalid coordinates.' } satisfies GeocodingResult;
        }
        return { ok: true, cached: false, result: lookup } satisfies GeocodingResult;
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
  const parts = [address.address1, address.address2, address.city, address.province, address.postalCode, address.countryCode]
    .map((part) => (typeof part === 'string' ? part.trim() : ''))
    .filter((part) => part !== '');
  if (parts.length === 0) return null;
  return [...new Set(parts)].join(', ');
}

export function isValidCoordinate(value: number, kind: 'latitude' | 'longitude'): boolean {
  const min = kind === 'latitude' ? -90 : -180;
  const max = kind === 'latitude' ? 90 : 180;
  return Number.isFinite(value) && value >= min && value <= max;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
