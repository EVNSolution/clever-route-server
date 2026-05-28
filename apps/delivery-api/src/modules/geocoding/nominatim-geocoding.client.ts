import type { GeocodingLookupResult, GeocodingProvider } from './geocoding.types.js';

export type NominatimGeocodingClientOptions = {
  fetchImpl?: typeof fetch;
  searchUrl: string;
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
  private readonly userAgent: string;

  constructor(options: NominatimGeocodingClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.searchUrl = options.searchUrl;
    this.userAgent = options.userAgent;
  }

  async geocodeAddress(query: string): Promise<GeocodingLookupResult | null> {
    const url = new URL(this.searchUrl);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('limit', '1');
    url.searchParams.set('q', query);

    const response = await this.fetchImpl(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': this.userAgent
      }
    });
    if (!response.ok) {
      throw new Error(`Geocoding provider returned ${response.status}`);
    }

    const payload = await response.json();
    if (!Array.isArray(payload) || payload.length === 0) return null;
    return toResult(payload[0], query);
  }
}

function toResult(value: unknown, query: string): GeocodingLookupResult | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as NominatimSearchItem;
  const latitude = readCoordinate(item.lat, 'latitude');
  const longitude = readCoordinate(item.lon, 'longitude');
  if (latitude === null || longitude === null) return null;
  const label = typeof item.display_name === 'string' && item.display_name.trim() !== '' ? item.display_name.trim() : query;
  return {
    addressLabel: query,
    latitude,
    longitude,
    provider: 'nominatim_compatible',
    providerPlaceId: readPlaceId(item),
    rawLabel: label
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
