import { describe, expect, test, vi } from 'vitest';

import { loadGeocodingService } from '../src/modules/geocoding/geocoding.dependencies.js';
import { GeocodingService, SerializedGeocodingRateLimiter } from '../src/modules/geocoding/geocoding.service.js';
import { NominatimGeocodingClient } from '../src/modules/geocoding/nominatim-geocoding.client.js';
import { GeocodingProviderError, type GeocodingQuery } from '../src/modules/geocoding/geocoding.types.js';

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

    const result = await client.geocodeAddress({
      cacheKey: 'structured:test',
      kind: 'structured',
      params: {
        city: 'Mississauga',
        country: 'Canada',
        countrycodes: 'ca',
        postalcode: 'L5B 3C1',
        state: 'ON',
        street: '300 City Centre Dr'
      },
      shape: 'structured_without_unit'
    });

    expect(result).toEqual(expect.objectContaining({ latitude: 43.589045, longitude: -79.644119, providerPlaceId: '42' }));
    const call = rawFetch.mock.calls[0];
    if (call === undefined) throw new Error('expected fetch call');
    const [url, init] = call as unknown as [URL, RequestInit];
    expect(url.toString()).toContain('format=jsonv2');
    expect(url.toString()).toContain('limit=1');
    expect(url.searchParams.get('q')).toBe(null);
    expect(url.searchParams.get('street')).toBe('300 City Centre Dr');
    expect(url.searchParams.get('city')).toBe('Mississauga');
    expect(url.searchParams.get('countrycodes')).toBe('ca');
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


  test('falls back without address line 2 when a unit value prevents a match', async () => {
    const provider = {
      geocodeAddress: vi.fn((query: GeocodingQuery) => {
        if (query.shape !== 'freeform_without_unit') return Promise.resolve(null);
        return Promise.resolve({
          addressLabel: query.shape,
          latitude: 42.9965699,
          longitude: -81.3216486,
          provider: 'mock',
          providerPlaceId: 'place-1020',
          rawLabel: '1020 Coronation Drive, London, Ontario, Canada'
        });
      }),
      providerName: 'mock'
    };
    const service = new GeocodingService({ minIntervalMs: 0, mode: 'nominatim_compatible', provider });

    const result = await service.geocode({
      address: {
        address1: '1020 Coronation Drive',
        address2: '302',
        city: 'London',
        countryCode: 'CA',
        postalCode: 'N6H 0B5',
        province: 'ON'
      },
      shopDomain: 'example.test'
    });

    expect(result).toEqual(expect.objectContaining({ ok: true }));
    expect(provider.geocodeAddress).toHaveBeenNthCalledWith(1, expect.objectContaining({ shape: 'structured_without_unit' }));
    expect(provider.geocodeAddress).toHaveBeenNthCalledWith(2, expect.objectContaining({ shape: 'structured' }));
    expect(provider.geocodeAddress).toHaveBeenNthCalledWith(3, expect.objectContaining({ shape: 'freeform_without_unit' }));
  });

  test('falls back without postal code when street and postal data conflict', async () => {
    const provider = {
      geocodeAddress: vi.fn((query: GeocodingQuery) => {
        if (query.shape !== 'structured_without_unit_no_postal') return Promise.resolve(null);
        return Promise.resolve({
          addressLabel: query.shape,
          latitude: 43.662,
          longitude: -79.3865,
          provider: 'mock',
          providerPlaceId: 'place-11985',
          rawLabel: '832 Bay Street, Toronto, Ontario, M5S 3M4, Canada'
        });
      }),
      providerName: 'mock'
    };
    const service = new GeocodingService({ minIntervalMs: 0, mode: 'nominatim_compatible', provider });

    const result = await service.geocode({
      address: {
        address1: '832 Bay Street',
        address2: '4902',
        city: 'Toronto',
        countryCode: 'CA',
        postalCode: 'M5S 1Z6',
        province: 'ON'
      },
      shopDomain: 'tomatonofood.com'
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      queryShapes: [
        'structured_without_unit',
        'structured',
        'freeform_without_unit',
        'freeform',
        'structured_without_unit_no_postal'
      ]
    }));
    const fifthCall = provider.geocodeAddress.mock.calls[4]?.[0];
    expect(fifthCall).toEqual(expect.objectContaining({ shape: 'structured_without_unit_no_postal' }));
    if (fifthCall === undefined || fifthCall.kind !== 'structured') {
      throw new Error('expected the fifth geocoding attempt to be structured');
    }
    expect(fifthCall.params.postalcode).toBeUndefined();
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
    expect(configured.status).toEqual(expect.objectContaining({
      mode: 'nominatim_compatible',
      persistentCacheEnabled: true
    }));
  });

  test('classifies public provider rate limits without retry burst', async () => {
    const provider = {
      geocodeAddress: vi.fn(() => Promise.reject(new GeocodingProviderError('RATE_LIMITED', 'rate limited', { status: 429 }))),
      providerName: 'mock'
    };
    const service = new GeocodingService({
      minIntervalMs: 0,
      mode: 'nominatim_compatible',
      provider,
      providerPolicy: 'public_nominatim'
    });

    const result = await service.geocode({ address, shopDomain: 'example.test' });

    expect(result).toEqual(expect.objectContaining({
      code: 'GEOCODER_PROVIDER_RATE_LIMITED',
      ok: false,
      transient: true
    }));
    expect(provider.geocodeAddress).toHaveBeenCalledTimes(1);
  });

  test('spaces public fallback query candidates at the provider request limiter', async () => {
    const calls: number[] = [];
    const provider = {
      geocodeAddress: vi.fn((query: GeocodingQuery) => {
        calls.push(Date.now());
        if (query.shape === 'structured_without_unit') return Promise.resolve(null);
        return Promise.resolve({
          addressLabel: query.shape,
          latitude: 43.589045,
          longitude: -79.644119,
          provider: 'mock',
          providerPlaceId: 'place-1',
          rawLabel: null
        });
      }),
      providerName: 'mock'
    };
    const service = new GeocodingService({
      minIntervalMs: 20,
      mode: 'nominatim_compatible',
      provider,
      providerPolicy: 'public_nominatim'
    });

    await service.geocode({ address, shopDomain: 'example.test' });

    expect(calls).toHaveLength(2);
    const [firstCall, secondCall] = calls;
    if (firstCall === undefined || secondCall === undefined) throw new Error('expected two provider calls');
    expect(secondCall - firstCall).toBeGreaterThanOrEqual(15);
  });

  test('can share the public provider limiter across service instances', async () => {
    const calls: number[] = [];
    const provider = {
      geocodeAddress: vi.fn(() => {
        calls.push(Date.now());
        return Promise.resolve({
          addressLabel: 'structured_without_unit',
          latitude: 43.589045,
          longitude: -79.644119,
          provider: 'mock',
          providerPlaceId: 'place-1',
          rawLabel: null
        });
      }),
      providerName: 'mock'
    };
    const rateLimiter = new SerializedGeocodingRateLimiter();
    const first = new GeocodingService({
      minIntervalMs: 20,
      mode: 'nominatim_compatible',
      provider,
      providerPolicy: 'public_nominatim',
      rateLimiter
    });
    const second = new GeocodingService({
      minIntervalMs: 20,
      mode: 'nominatim_compatible',
      provider,
      providerPolicy: 'public_nominatim',
      rateLimiter
    });

    await Promise.all([
      first.geocode({ address, shopDomain: 'one.example.test' }),
      second.geocode({ address: { ...address, postalCode: 'L5B 3C2' }, shopDomain: 'two.example.test' })
    ]);

    expect(calls).toHaveLength(2);
    const ordered = [...calls].sort((left, right) => left - right);
    const [firstCall, secondCall] = ordered;
    if (firstCall === undefined || secondCall === undefined) throw new Error('expected two provider calls');
    expect(secondCall - firstCall).toBeGreaterThanOrEqual(15);
  });

  test('classifies malformed Nominatim payloads as invalid provider results', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve({
      json: () => Promise.resolve({ code: 'not-an-array' }),
      ok: true,
      status: 200
    })) as unknown as typeof fetch;
    const client = new NominatimGeocodingClient({
      fetchImpl,
      searchUrl: 'https://geo.example.test/search',
      userAgent: 'CLEVER-Route-Test/1.0 ops@example.test'
    });
    const service = new GeocodingService({ minIntervalMs: 0, mode: 'nominatim_compatible', provider: client });

    const result = await service.geocode({ address, shopDomain: 'example.test' });

    expect(result).toEqual(expect.objectContaining({
      code: 'GEOCODER_INVALID_RESULT',
      ok: false
    }));
  });

  test('retries transient provider errors once and records query shapes only', async () => {
    const provider = {
      geocodeAddress: vi
        .fn()
        .mockRejectedValueOnce(new GeocodingProviderError('HTTP_ERROR', 'bad gateway', { status: 502 }))
        .mockResolvedValueOnce({
          addressLabel: 'structured_without_unit',
          latitude: 43.589045,
          longitude: -79.644119,
          provider: 'mock',
          providerPlaceId: 'place-1',
          rawLabel: null
        }),
      providerName: 'mock'
    };
    const service = new GeocodingService({ minIntervalMs: 0, mode: 'nominatim_compatible', provider });

    const result = await service.geocode({ address, shopDomain: 'example.test' });

    expect(result).toEqual(expect.objectContaining({
      attemptCount: 2,
      ok: true,
      queryShapes: ['structured_without_unit']
    }));
    expect(JSON.stringify(result)).not.toContain('300 City Centre Dr');
  });
});
