import {
  GeocodingProviderError,
  type GeocodingLookupResult,
  type GeocodingProvider,
  type GeocodingQuery,
} from './geocoding.types.js';

export type NominatimGeocodingClientOptions = {
  fetchImpl?: typeof fetch;
  searchUrl: string;
  timeoutMs?: number;
  userAgent: string;
};

type NominatimSearchItem = {
  display_name?: unknown;
  lat?: unknown;
  lon?: unknown;
  osm_id?: unknown;
  place_id?: unknown;
};

export class NominatimGeocodingClient implements GeocodingProvider {
  readonly providerName = 'nominatim_compatible';
  private readonly fetchImpl: typeof fetch;
  private readonly searchUrl: string;
  private readonly timeoutMs: number;
  private readonly userAgent: string;

  constructor(options: NominatimGeocodingClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.searchUrl = options.searchUrl;
    this.timeoutMs =
      typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
        ? Math.max(1000, Math.floor(options.timeoutMs))
        : 10000;
    this.userAgent = options.userAgent;
  }

  async geocodeAddress(query: GeocodingQuery): Promise<GeocodingLookupResult | null> {
    const url = new URL(this.searchUrl);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('limit', '1');
    applyQueryParams(url, query);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent': this.userAgent
        },
        signal: controller.signal,
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw new GeocodingProviderError('TIMEOUT', 'Geocoding provider timed out.', { transient: true });
      }
      throw new GeocodingProviderError('NETWORK_ERROR', 'Geocoding provider network error.', { transient: true });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      if (response.status === 429) {
        throw new GeocodingProviderError('RATE_LIMITED', 'Geocoding provider rate limit reached.', {
          status: response.status,
          transient: true,
        });
      }
      throw new GeocodingProviderError('HTTP_ERROR', 'Geocoding provider HTTP error.', {
        status: response.status,
        transient: response.status >= 500,
      });
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new GeocodingProviderError('INVALID_RESPONSE', 'Geocoding provider returned invalid JSON.', {
        transient: false,
      });
    }
    if (!Array.isArray(payload)) {
      throw new GeocodingProviderError('INVALID_RESPONSE', 'Geocoding provider returned invalid JSON shape.', {
        transient: false,
      });
    }
    if (payload.length === 0) return null;
    const result = toResult(payload[0], query);
    if (result === null) {
      throw new GeocodingProviderError('INVALID_RESPONSE', 'Geocoding provider returned invalid result.', {
        transient: false,
      });
    }
    return result;
  }
}

function applyQueryParams(url: URL, query: GeocodingQuery): void {
  if (query.kind === 'freeform') {
    url.searchParams.set('q', query.q);
    return;
  }
  for (const [key, value] of Object.entries(query.params)) {
    if (typeof value === 'string' && value.trim() !== '') {
      url.searchParams.set(key, value.trim());
    }
  }
}

function toResult(value: unknown, query: GeocodingQuery): GeocodingLookupResult | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as NominatimSearchItem;
  const latitude = readCoordinate(item.lat, 'latitude');
  const longitude = readCoordinate(item.lon, 'longitude');
  if (latitude === null || longitude === null) return null;
  return {
    addressLabel: query.shape,
    latitude,
    longitude,
    provider: 'nominatim_compatible',
    providerPlaceId: readPlaceId(item),
    rawLabel: null
  };
}

function readCoordinate(value: unknown, kind: 'latitude' | 'longitude'): number | null {
  const parsed = typeof value === 'string' || typeof value === 'number' ? Number(value) : Number.NaN;
  const min = kind === 'latitude' ? -90 : -180;
  const max = kind === 'latitude' ? 90 : 180;
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function readPlaceId(item: NominatimSearchItem): string | null {
  const value = item.place_id ?? item.osm_id;
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}
