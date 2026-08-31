import type { PrismaClient } from '@prisma/client';

import { PrismaGeocodingCacheRepository } from './geocoding-cache.repository.js';
import { GeocodingService, SerializedGeocodingRateLimiter } from './geocoding.service.js';
import { NominatimGeocodingClient } from './nominatim-geocoding.client.js';
import type { GeocodingProviderMode } from './geocoding.types.js';
import { VWorldGeocodingClient } from './vworld-geocoding.client.js';

export type GeocodingRuntimeEnv = Partial<
  Record<
    | 'GEOCODING_PROVIDER_MODE'
    | 'GEOCODING_SEARCH_URL'
    | 'GEOCODING_USER_AGENT'
    | 'GEOCODING_RATE_LIMIT_PER_SECOND'
    | 'GEOCODING_CACHE_TTL_DAYS'
    | 'GEOCODING_TIMEOUT_MS'
    | 'VWORLD_API_KEY',
    string
  >
>;

const PUBLIC_NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const publicProviderLimiters = new Map<string, SerializedGeocodingRateLimiter>();

export function loadGeocodingService(input: {
  env: GeocodingRuntimeEnv;
  prisma?: PrismaClient | undefined;
}): GeocodingService {
  const mode = readMode(input.env.GEOCODING_PROVIDER_MODE);
  if (mode === 'disabled') return new GeocodingService({ mode });
  const persistentCache = readPersistentCache(input);
  if (mode === 'vworld') {
    const apiKey = readOptional(input.env.VWORLD_API_KEY);
    const koreanService = new GeocodingService({
      ...persistentCache.options,
      minIntervalMs: Math.ceil(1000 / readVWorldRateLimit(input.env.GEOCODING_RATE_LIMIT_PER_SECOND)),
      mode,
      ...(apiKey === undefined
        ? {}
        : {
            provider: new VWorldGeocodingClient({
              apiKey,
              ...optionalTimeout(input.env.GEOCODING_TIMEOUT_MS),
            }),
          }),
      providerPolicy: 'vworld',
    });
    return new CountryRoutingGeocodingService(
      koreanService,
      loadNominatimCompatibleService(input, persistentCache),
    );
  }

  return loadNominatimCompatibleService(input, persistentCache);
}

function loadNominatimCompatibleService(
  input: Parameters<typeof loadGeocodingService>[0],
  persistentCache: ReturnType<typeof readPersistentCache>,
): GeocodingService {
  const searchUrl = readOptional(input.env.GEOCODING_SEARCH_URL) ?? PUBLIC_NOMINATIM_URL;
  const userAgent = readOptional(input.env.GEOCODING_USER_AGENT);
  const rateLimit = readRateLimit(input.env.GEOCODING_RATE_LIMIT_PER_SECOND);
  const isPublicNominatim = normalizeUrl(searchUrl) === PUBLIC_NOMINATIM_URL;

  if (isPublicNominatim) {
    return new GeocodingService({
      ...persistentCache.options,
      minIntervalMs: Math.ceil(1000 / rateLimit),
      mode: 'nominatim_compatible',
      providerPolicy: 'public_nominatim',
      rateLimiter: readSharedPublicProviderLimiter(searchUrl),
      ...(userAgent === undefined
        ? {}
        : {
            provider: new NominatimGeocodingClient({
              searchUrl,
              ...optionalTimeout(input.env.GEOCODING_TIMEOUT_MS),
              userAgent,
            }),
          }),
      requirePersistentCache: true
    });
  }

  return new GeocodingService({
    ...persistentCache.options,
    minIntervalMs: Math.ceil(1000 / rateLimit),
    mode: 'nominatim_compatible',
    provider: new NominatimGeocodingClient({
      searchUrl,
      ...optionalTimeout(input.env.GEOCODING_TIMEOUT_MS),
      userAgent: userAgent ?? 'CLEVER-Route-Ops-Geocoder/disabled-contact-required'
    }),
    providerPolicy: 'private_nominatim_compatible',
    requirePersistentCache: isPublicNominatim
  });
}

class CountryRoutingGeocodingService extends GeocodingService {
  constructor(
    private readonly koreanService: GeocodingService,
    private readonly internationalService: GeocodingService,
  ) {
    super({ mode: 'disabled' });
  }

  override get status(): GeocodingService['status'] {
    return this.koreanService.status;
  }

  override geocode(
    input: Parameters<GeocodingService['geocode']>[0],
  ): ReturnType<GeocodingService['geocode']> {
    return isExplicitNonKoreanCountry(input.address.countryCode)
      ? this.internationalService.geocode(input)
      : this.koreanService.geocode(input);
  }

  override searchPlaces(
    input: Parameters<GeocodingService['searchPlaces']>[0],
  ): ReturnType<GeocodingService['searchPlaces']> {
    return this.koreanService.searchPlaces(input);
  }
}

function isExplicitNonKoreanCountry(countryCode: string | null): boolean {
  const normalized = countryCode?.trim().toUpperCase() ?? '';
  return /^[A-Z]{2}$/u.test(normalized) && normalized !== 'KR';
}

function readSharedPublicProviderLimiter(searchUrl: string): SerializedGeocodingRateLimiter {
  const key = normalizeUrl(searchUrl);
  const current = publicProviderLimiters.get(key);
  if (current !== undefined) return current;
  const next = new SerializedGeocodingRateLimiter();
  publicProviderLimiters.set(key, next);
  return next;
}

function readMode(value: string | undefined): GeocodingProviderMode {
  const trimmed = value?.trim();
  if (trimmed === 'vworld') return 'vworld';
  return trimmed === 'nominatim_compatible' ? 'nominatim_compatible' : 'disabled';
}

function readRateLimit(value: string | undefined): number {
  const parsed = Number(value ?? '1');
  if (!Number.isFinite(parsed) || parsed <= 0) return 1;
  return Math.min(parsed, 1);
}

function readVWorldRateLimit(value: string | undefined): number {
  const parsed = Number(value ?? '5');
  if (!Number.isFinite(parsed) || parsed <= 0) return 5;
  return Math.min(parsed, 10);
}

function readOptional(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  return value.trim();
}

function readPersistentCache(input: {
  env: GeocodingRuntimeEnv;
  prisma?: PrismaClient | undefined;
}): {
  options: Pick<ConstructorParameters<typeof GeocodingService>[0], 'cacheRepository' | 'cacheTtlDays' | 'persistentCacheEnabled'>;
} {
  const cacheTtlDays = readCacheTtlDays(input.env.GEOCODING_CACHE_TTL_DAYS);
  if (cacheTtlDays === undefined) return { options: {} };
  if (input.prisma === undefined) {
    return { options: { cacheTtlDays, persistentCacheEnabled: false } };
  }
  return {
    options: {
      cacheRepository: new PrismaGeocodingCacheRepository(input.prisma),
      cacheTtlDays,
      persistentCacheEnabled: true,
    },
  };
}

function readCacheTtlDays(value: string | undefined): number | undefined {
  const parsed = Number(value ?? '');
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}

function readTimeoutMs(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

function optionalTimeout(value: string | undefined): { timeoutMs?: number } {
  const timeoutMs = readTimeoutMs(value);
  return timeoutMs === undefined ? {} : { timeoutMs };
}

function normalizeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/u, '');
  } catch {
    return value.trim();
  }
}
