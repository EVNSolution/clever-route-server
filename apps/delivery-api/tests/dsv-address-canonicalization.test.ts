import { describe, expect, test, vi } from 'vitest';

import {
  GeocodingDsvAddressCanonicalizer,
  loadDsvAddressCanonicalizer,
  parseKoreanDeliveryAddress,
} from '../src/modules/dsv/dsv-address-canonicalization.js';

describe('DSV Korean address canonicalization', () => {
  test('fails closed when a geocoding service is not configured', async () => {
    const service = loadDsvAddressCanonicalizer({});

    await expect(service.resolve({
      address: '서울특별시 중구 세종대로 110',
      shopDomain: 'dsv-demo.local',
    })).resolves.toMatchObject({
      postalCode: null,
      status: 'UNAVAILABLE',
    });
  });

  test.each([
    [
      '경기 구리시 아차산로 489, 402호(교문동)',
      {
        detailAddress: '402호(교문동)',
        postalCode: null,
        rawAddress: '경기 구리시 아차산로 489, 402호(교문동)',
        searchAddress: '경기 구리시 아차산로 489',
      },
    ],
    [
      '경기 광주시 초월읍 경충대로 1284번길 51 1~2층',
      {
        detailAddress: '1~2층',
        postalCode: null,
        rawAddress: '경기 광주시 초월읍 경충대로 1284번길 51 1~2층',
        searchAddress: '경기 광주시 초월읍 경충대로 1284번길 51',
      },
    ],
    [
      '(11931) 경기 구리시 아차산로 489',
      {
        detailAddress: null,
        postalCode: '11931',
        rawAddress: '(11931) 경기 구리시 아차산로 489',
        searchAddress: '경기 구리시 아차산로 489',
      },
    ],
    [
      '경기 부천시 원미구 길주로 195 (중동, 금영프라자2차 602,604)',
      {
        detailAddress: '(중동, 금영프라자2차 602, 604)',
        postalCode: null,
        rawAddress: '경기 부천시 원미구 길주로 195 (중동, 금영프라자2차 602, 604)',
        searchAddress: '경기 부천시 원미구 길주로 195',
      },
    ],
    [
      '서울 동대문구 답십리동 753 MJ B/D',
      {
        detailAddress: 'MJ B/D',
        postalCode: null,
        rawAddress: '서울 동대문구 답십리동 753 MJ B/D',
        searchAddress: '서울 동대문구 답십리동 753',
      },
    ],
    [
      '서울 동대문구 천호대로83길 31(장안동 423-4)기영약품물류센터',
      {
        detailAddress: '(장안동 423-4)기영약품물류센터',
        postalCode: null,
        rawAddress: '서울 동대문구 천호대로83길 31(장안동 423-4)기영약품물류센터',
        searchAddress: '서울 동대문구 천호대로83길 31',
      },
    ],
  ])('parses %s into a searchable road address', (source, expected) => {
    expect(parseKoreanDeliveryAddress(source)).toEqual(expected);
  });

  test('resolves coordinates and postal code through the shared geocoding service', async () => {
    const geocode = vi.fn().mockResolvedValue({
      cached: false,
      ok: true,
      result: {
        addressLabel: 'structured_without_unit',
        latitude: 37.4923433,
        longitude: 127.04661,
        postalCode: '06273',
        provider: 'nominatim_compatible',
        providerPlaceId: '222421430',
        rawLabel: null,
      },
    });
    const service = new GeocodingDsvAddressCanonicalizer({ geocode });

    await expect(service.resolve({
      address: '서울특별시 강남구 언주로 211, 본관 지하 1층',
      shopDomain: 'dsv-demo.local',
    })).resolves.toEqual({
      address: '서울특별시 강남구 언주로 211',
      detailAddress: '본관 지하 1층',
      jibunAddress: null,
      latitude: 37.4923433,
      longitude: 127.04661,
      postalCode: '06273',
      rawAddress: '서울특별시 강남구 언주로 211, 본관 지하 1층',
      status: 'RESOLVED',
    });
    expect(geocode).toHaveBeenCalledWith({
      address: {
        address1: '서울특별시 강남구 언주로 211',
        address2: null,
        city: null,
        countryCode: 'KR',
        postalCode: null,
        province: null,
      },
      shopDomain: 'dsv-demo.local',
    });
  });

  test('uses a source postal code when the provider does not return one', async () => {
    const geocode = vi.fn().mockResolvedValue({
      cached: false,
      ok: true,
      result: {
        addressLabel: 'structured_postal_only',
        latitude: 37.594,
        longitude: 127.129,
        provider: 'test',
        providerPlaceId: null,
        rawLabel: null,
      },
    });
    const service = new GeocodingDsvAddressCanonicalizer({ geocode });

    await expect(service.resolve({
      address: '(11931) 경기 구리시 아차산로 489',
      shopDomain: 'dsv-demo.local',
    })).resolves.toMatchObject({
      postalCode: '11931',
      status: 'RESOLVED',
    });
  });

  test('does not mark an address resolved when no postal code is available', async () => {
    const geocode = vi.fn().mockResolvedValue({
      cached: false,
      ok: true,
      result: {
        addressLabel: 'structured_without_unit',
        latitude: 37.5663,
        longitude: 126.9779,
        provider: 'test',
        providerPlaceId: null,
        rawLabel: null,
      },
    });
    const service = new GeocodingDsvAddressCanonicalizer({ geocode });

    await expect(service.resolve({
      address: '서울특별시 중구 세종대로 110',
      shopDomain: 'dsv-demo.local',
    })).resolves.toMatchObject({
      latitude: null,
      longitude: null,
      postalCode: null,
      status: 'NOT_FOUND',
    });
  });

  test('distinguishes no-result failures from unavailable providers', async () => {
    const noResult = new GeocodingDsvAddressCanonicalizer({
      geocode: vi.fn().mockResolvedValue({
        code: 'GEOCODER_NO_RESULT',
        message: 'No geocoding result was found.',
        ok: false,
      }),
    });
    const unavailable = new GeocodingDsvAddressCanonicalizer({
      geocode: vi.fn().mockResolvedValue({
        code: 'GEOCODER_PROVIDER_TIMEOUT',
        message: 'Geocoding provider timed out.',
        ok: false,
        transient: true,
      }),
    });

    await expect(noResult.resolve({
      address: '존재하지 않는 주소 123',
      shopDomain: 'dsv-demo.local',
    })).resolves.toMatchObject({ status: 'NOT_FOUND' });
    await expect(unavailable.resolve({
      address: '서울특별시 중구 세종대로 110',
      shopDomain: 'dsv-demo.local',
    })).resolves.toMatchObject({ status: 'UNAVAILABLE' });
  });
});
