import { describe, expect, test, vi } from 'vitest';

import { loadGeocodingService } from '../src/modules/geocoding/geocoding.dependencies.js';
import { GeocodingService } from '../src/modules/geocoding/geocoding.service.js';
import { NominatimGeocodingClient } from '../src/modules/geocoding/nominatim-geocoding.client.js';

const address = {
  address1: '300 City Centre Dr',
  address2: null,
  city: 'Mississauga',
  countryCode: 'CA',
  postalCode: 'L5B 3C1',
  province: 'ON'
};

describe('Route Ops geocoding', () => {
  test('fails closed when disabled and does not call a provider', async () => {
    const provider = { geocodeAddress: vi.fn(), providerName: 'mock' };
    const service = new GeocodingService({ mode: 'disabled', provider });

    await expect(service.geocode({ address, shopDomain: 'example.test' })).resolves.toEqual({
      ok: false,
      code: 'GEOCODER_DISABLED',
      message: 'Geocoding is disabled for this runtime.'
    });
    expect(provider.geocodeAddress).not.toHaveBeenCalled();
  });

  test('uses Nominatim-compatible search parameters and identifying user agent', async () => {
    const rawFetch = vi.fn(() => Promise.resolve({
      json: () => Promise.resolve([{ display_name: 'City Centre', lat: '43.589045', lon: '-79.644119', place_id: 42 }]),
      ok: true,
      status: 200
    }));
    const fetchImpl = rawFetch as unknown as typeof fetch;
    const client = new NominatimGeocodingClient({
      fetchImpl,
      searchUrl: 'https://geo.example.test/search',
      userAgent: 'CLEVER-Route-Test/1.0 ops@example.test'
    });

    const result = await client.geocodeAddress('300 City Centre Dr, Mississauga, ON, L5B 3C1, CA');

    expect(result).toEqual(expect.objectContaining({ latitude: 43.589045, longitude: -79.644119, providerPlaceId: '42' }));
    const call = rawFetch.mock.calls[0];
    if (call === undefined) throw new Error('expected fetch call');
    const [url, init] = call as unknown as [URL, RequestInit];
    expect(url.toString()).toContain('format=jsonv2');
    expect(url.toString()).toContain('limit=1');
    expect(url.searchParams.get('q')).toBe('300 City Centre Dr, Mississauga, ON, L5B 3C1, CA');
    expect(init.headers).toMatchObject({ 'User-Agent': 'CLEVER-Route-Test/1.0 ops@example.test' });
  });

  test('caches identical normalized address lookups in-process', async () => {
    const provider = {
      geocodeAddress: vi.fn(() => Promise.resolve({
        addressLabel: '300 City Centre Dr, Mississauga, ON, L5B 3C1, CA',
        latitude: 43.589045,
        longitude: -79.644119,
        provider: 'mock',
        providerPlaceId: 'place-1',
        rawLabel: 'City Centre'
      })),
      providerName: 'mock'
    };
    const service = new GeocodingService({ minIntervalMs: 0, mode: 'nominatim_compatible', provider });

    const first = await service.geocode({ address, shopDomain: 'example.test' });
    const second = await service.geocode({ address: { ...address, address2: '' }, shopDomain: 'example.test' });

    expect(first.ok).toBe(true);
    expect(second).toEqual(expect.objectContaining({ cached: true, ok: true }));
    expect(provider.geocodeAddress).toHaveBeenCalledOnce();
  });

  test('public Nominatim mode requires user agent and durable cache signal', async () => {
    const missingUserAgent = loadGeocodingService({ env: { GEOCODING_PROVIDER_MODE: 'nominatim_compatible' } });
    await expect(missingUserAgent.geocode({ address, shopDomain: 'example.test' })).resolves.toEqual(expect.objectContaining({
      code: 'GEOCODER_NOT_CONFIGURED',
      ok: false
    }));

    const missingCache = loadGeocodingService({
      env: {
        GEOCODING_PROVIDER_MODE: 'nominatim_compatible',
        GEOCODING_USER_AGENT: 'CLEVER-Route-Test/1.0 ops@example.test'
      }
    });
    await expect(missingCache.geocode({ address, shopDomain: 'example.test' })).resolves.toEqual(expect.objectContaining({
      code: 'GEOCODER_NOT_CONFIGURED',
      ok: false
    }));

    const configured = loadGeocodingService({
      env: {
        GEOCODING_CACHE_TTL_DAYS: '30',
        GEOCODING_PROVIDER_MODE: 'nominatim_compatible',
        GEOCODING_SEARCH_URL: 'https://geo.example.test/search',
        GEOCODING_USER_AGENT: 'CLEVER-Route-Test/1.0 ops@example.test'
      }
    });
    expect(configured.status).toEqual({
      mode: 'nominatim_compatible',
      persistentCacheEnabled: true
    });
  });
});
