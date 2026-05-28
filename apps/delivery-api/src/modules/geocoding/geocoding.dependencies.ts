import { GeocodingService } from './geocoding.service.js';
import { NominatimGeocodingClient } from './nominatim-geocoding.client.js';

export type GeocodingRuntimeEnv = Partial<
  Record<
    | 'GEOCODING_PROVIDER_MODE'
    | 'GEOCODING_SEARCH_URL'
    | 'GEOCODING_USER_AGENT'
    | 'GEOCODING_RATE_LIMIT_PER_SECOND'
    | 'GEOCODING_CACHE_TTL_DAYS',
    string
  >
>;

const PUBLIC_NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';

export function loadGeocodingService(input: { env: GeocodingRuntimeEnv }): GeocodingService {
  const mode = readMode(input.env.GEOCODING_PROVIDER_MODE);
  if (mode === 'disabled') return new GeocodingService({ mode });

  const searchUrl = readOptional(input.env.GEOCODING_SEARCH_URL) ?? PUBLIC_NOMINATIM_URL;
  const userAgent = readOptional(input.env.GEOCODING_USER_AGENT);
  const rateLimit = readRateLimit(input.env.GEOCODING_RATE_LIMIT_PER_SECOND);
  const isPublicNominatim = normalizeUrl(searchUrl) === PUBLIC_NOMINATIM_URL;
  const persistentCacheEnabled = readPersistentCacheSignal(input.env.GEOCODING_CACHE_TTL_DAYS);

  if (isPublicNominatim) {
    return new GeocodingService({
      minIntervalMs: Math.ceil(1000 / rateLimit),
      mode: 'nominatim_compatible',
      persistentCacheEnabled,
      ...(userAgent === undefined ? {} : { provider: new NominatimGeocodingClient({ searchUrl, userAgent }) }),
      requirePersistentCache: true
    });
  }

  return new GeocodingService({
    minIntervalMs: Math.ceil(1000 / rateLimit),
    mode,
    persistentCacheEnabled,
    provider: new NominatimGeocodingClient({
      searchUrl,
      userAgent: userAgent ?? 'CLEVER-Route-Ops-Geocoder/disabled-contact-required'
    }),
    requirePersistentCache: isPublicNominatim
  });
}

function readMode(value: string | undefined): 'disabled' | 'nominatim_compatible' {
  const trimmed = value?.trim();
  return trimmed === 'nominatim_compatible' ? 'nominatim_compatible' : 'disabled';
}

function readRateLimit(value: string | undefined): number {
  const parsed = Number(value ?? '1');
  if (!Number.isFinite(parsed) || parsed <= 0) return 1;
  return Math.min(parsed, 1);
}

function readOptional(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  return value.trim();
}

function readPersistentCacheSignal(value: string | undefined): boolean {
  const parsed = Number(value ?? '');
  return Number.isFinite(parsed) && parsed > 0;
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
