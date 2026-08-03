import { describe, expect, test, vi } from 'vitest';

import { loadGeocodingService } from '../src/modules/geocoding/geocoding.dependencies.js';
import { GeocodingService } from '../src/modules/geocoding/geocoding.service.js';
import type { GeocodingProviderError } from '../src/modules/geocoding/geocoding.types.js';
import { VWorldGeocodingClient } from '../src/modules/geocoding/vworld-geocoding.client.js';

const koreanQuery = {
  cacheKey: 'structured:street=서울특별시 강남구 언주로 211&country=south korea&countrycodes=kr',
  kind: 'structured' as const,
  params: {
    country: 'South Korea',
    countrycodes: 'kr',
    street: '서울특별시 강남구 언주로 211',
  },
  shape: 'structured_without_unit' as const,
};

describe('VWorld geocoding provider', () => {
  test('requests a Korean road address and parses refined coordinates', async () => {
    const rawFetch = vi.fn(() => Promise.resolve(response({
      response: {
        result: {
          items: [{
            address: {
              parcel: '서울특별시 강남구 도곡동 146-92',
              road: '서울특별시 강남구 언주로 211 (도곡동)',
              zipcode: '06273',
            },
            id: '1168011800101460092',
            point: { x: '127.0466100', y: '37.4923433' },
          }],
        },
        status: 'OK',
      },
    })));
    const client = new VWorldGeocodingClient({
      apiKey: 'test-key',
      fetchImpl: rawFetch,
    });

    await expect(client.geocodeAddress(koreanQuery)).resolves.toEqual({
      addressLabel: 'structured_without_unit',
      jibunAddress: '서울특별시 강남구 도곡동 146-92',
      latitude: 37.4923433,
      longitude: 127.04661,
      postalCode: '06273',
      provider: 'vworld',
      providerPlaceId: '1168011800101460092',
      rawLabel: '서울특별시 강남구 언주로 211 (도곡동)',
      roadAddress: '서울특별시 강남구 언주로 211 (도곡동)',
    });

    const call = rawFetch.mock.calls[0];
    if (call === undefined) throw new Error('expected VWorld request');
    const [url] = call as unknown as [URL, RequestInit];
    expect(url.origin + url.pathname).toBe('https://api.vworld.kr/req/search');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      category: 'ROAD',
      crs: 'EPSG:4326',
      errorformat: 'json',
      format: 'json',
      key: 'test-key',
      page: '1',
      query: '서울특별시 강남구 언주로 211',
      request: 'search',
      service: 'search',
      size: '1',
      type: 'address',
      version: '2.0',
    });
  });

  test('falls back from road to parcel lookup when the first shape is not found', async () => {
    const rawFetch = vi
      .fn()
      .mockResolvedValueOnce(response({ response: { status: 'NOT_FOUND' } }))
      .mockResolvedValueOnce(response({
        response: {
          result: {
            items: [{
              address: {
                parcel: '서울특별시 동대문구 답십리동 753',
                zipcode: '02600',
              },
              point: { x: '127.055', y: '37.568' },
            }],
          },
          status: 'OK',
        },
      }));
    const client = new VWorldGeocodingClient({
      apiKey: 'test-key',
      fetchImpl: rawFetch,
    });

    const result = await client.geocodeAddress({
      cacheKey: 'freeform:서울 동대문구 답십리동 753|countrycodes=kr',
      countrycodes: 'kr',
      kind: 'freeform',
      q: '서울 동대문구 답십리동 753',
      shape: 'freeform',
    });

    expect(result).toMatchObject({ provider: 'vworld', rawLabel: '서울특별시 동대문구 답십리동 753' });
    expect(rawFetch).toHaveBeenCalledTimes(2);
    const firstUrl = rawFetch.mock.calls[0]?.[0] as unknown as URL;
    const secondUrl = rawFetch.mock.calls[1]?.[0] as unknown as URL;
    expect(firstUrl.searchParams.get('category')).toBe('PARCEL');
    expect(secondUrl.searchParams.get('category')).toBe('ROAD');
  });

  test('rejects a result from a different Korean province', async () => {
    const rawFetch = vi.fn(() => Promise.resolve(response({
      response: {
        result: {
          items: [{
            address: {
              parcel: '경상남도 창원시 진해구 태평동 11-10',
              road: '경상남도 창원시 진해구 충무로 2 (태평동)',
              zipcode: '51677',
            },
            point: { x: '128.6590215', y: '35.1466127' },
          }],
        },
        status: 'OK',
      },
    })));
    const client = new VWorldGeocodingClient({
      apiKey: 'test-key',
      fetchImpl: rawFetch,
    });

    await expect(client.geocodeAddress({
      ...koreanQuery,
      cacheKey: 'structured:street=서울특별시 중구 퇴계로 131&countrycodes=kr',
      params: {
        country: 'South Korea',
        countrycodes: 'kr',
        street: '서울특별시 중구 퇴계로 131',
      },
    })).resolves.toBeNull();
    expect(rawFetch).toHaveBeenCalledTimes(2);
  });

  test('searches delivery destination names and parses place candidates', async () => {
    const rawFetch = vi.fn(() => Promise.resolve(response({
      response: {
        record: { current: '2', total: '2' },
        result: {
          items: [
            {
              address: {
                parcel: '서울특별시 강남구 역삼동 814-6',
                road: '서울특별시 강남구 강남대로 438',
              },
              id: 'POI-GANGNAM',
              point: { x: '127.0263360', y: '37.5016428' },
              title: '<b>제이필의원</b>',
            },
            {
              address: {
                parcel: '서울특별시 마포구 동교동 165-1',
                road: '서울특별시 마포구 양화로 166',
              },
              id: 'POI-HONGDAE',
              point: { x: '126.9241410', y: '37.5567296' },
              title: '제이필의원',
            },
          ],
        },
        status: 'OK',
      },
    })));
    const client = new VWorldGeocodingClient({
      apiKey: 'test-key',
      fetchImpl: rawFetch,
    });

    await expect(client.searchPlaces({ limit: 10, text: '제이필의원' })).resolves.toEqual([
      {
        jibunAddress: '서울특별시 강남구 역삼동 814-6',
        latitude: 37.5016428,
        longitude: 127.026336,
        providerPlaceId: 'POI-GANGNAM',
        roadAddress: '서울특별시 강남구 강남대로 438',
        title: '제이필의원',
      },
      {
        jibunAddress: '서울특별시 마포구 동교동 165-1',
        latitude: 37.5567296,
        longitude: 126.924141,
        providerPlaceId: 'POI-HONGDAE',
        roadAddress: '서울특별시 마포구 양화로 166',
        title: '제이필의원',
      },
    ]);

    const call = rawFetch.mock.calls[0];
    if (call === undefined) throw new Error('expected VWorld place request');
    const [url] = call as unknown as [URL, RequestInit];
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      query: '제이필의원',
      size: '10',
      type: 'place',
    });
    expect(url.searchParams.has('category')).toBe(false);
  });

  test('does not call VWorld for postal-only or explicitly non-Korean queries', async () => {
    const rawFetch = vi.fn();
    const client = new VWorldGeocodingClient({
      apiKey: 'test-key',
      fetchImpl: rawFetch,
    });

    await expect(client.geocodeAddress({
      cacheKey: 'structured:postalcode=06273&countrycodes=kr',
      kind: 'structured',
      params: { countrycodes: 'kr', postalcode: '06273' },
      shape: 'structured_postal_only',
    })).resolves.toBeNull();
    await expect(client.geocodeAddress({
      cacheKey: 'freeform:300 city centre dr|countrycodes=ca',
      countrycodes: 'ca',
      kind: 'freeform',
      q: '300 City Centre Dr',
      shape: 'freeform',
    })).resolves.toBeNull();
    expect(rawFetch).not.toHaveBeenCalled();
  });

  test('collapses equivalent structured and freeform VWorld lookups', async () => {
    const rawFetch = vi.fn(() => Promise.resolve(response({
      response: { status: 'NOT_FOUND' },
    })));
    const client = new VWorldGeocodingClient({
      apiKey: 'test-key',
      fetchImpl: rawFetch,
    });
    const service = new GeocodingService({
      maxRetries: 0,
      minIntervalMs: 0,
      mode: 'vworld',
      provider: client,
      providerPolicy: 'vworld',
    });

    await expect(service.geocode({
      address: {
        address1: '서울 영등포구 버드나루로6길 10',
        address2: null,
        city: null,
        countryCode: 'KR',
        postalCode: null,
        province: null,
      },
      shopDomain: 'dsv-demo.local',
    })).resolves.toMatchObject({
      attemptCount: 1,
      code: 'GEOCODER_NO_RESULT',
      ok: false,
      queryShapes: ['structured_without_unit'],
    });
    expect(rawFetch).toHaveBeenCalledTimes(2);
  });

  test('classifies VWorld body errors even when HTTP status is 200', async () => {
    const client = new VWorldGeocodingClient({
      apiKey: 'invalid-key',
      fetchImpl: vi.fn(() => Promise.resolve(response({
        response: {
          error: { code: 'INVALID_KEY', text: '등록되지 않은 인증키입니다.' },
          status: 'ERROR',
        },
      }))),
    });

    await expect(client.geocodeAddress(koreanQuery)).rejects.toMatchObject({
      kind: 'HTTP_ERROR',
      message: 'Geocoding provider rejected the request (INVALID_KEY).',
      transient: false,
    } satisfies Partial<GeocodingProviderError>);
  });

  test('loads only when VWorld mode has an API key', async () => {
    const missingKey = loadGeocodingService({
      env: { GEOCODING_PROVIDER_MODE: 'vworld' },
    });
    await expect(missingKey.geocode({
      address: {
        address1: '서울특별시 강남구 언주로 211',
        address2: null,
        city: null,
        countryCode: 'KR',
        postalCode: null,
        province: null,
      },
      shopDomain: 'dsv-demo.local',
    })).resolves.toMatchObject({
      code: 'GEOCODER_NOT_CONFIGURED',
      ok: false,
    });

    const configured = loadGeocodingService({
      env: {
        GEOCODING_PROVIDER_MODE: 'vworld',
        VWORLD_API_KEY: 'test-key',
      },
    });
    expect(configured.status).toMatchObject({
      mode: 'vworld',
      providerPolicy: 'vworld',
    });
  });
});

function response(payload: unknown): Response {
  return {
    json: () => Promise.resolve(payload),
    ok: true,
    status: 200,
  } as Response;
}
