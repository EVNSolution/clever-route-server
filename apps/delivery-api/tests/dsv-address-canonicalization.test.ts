import { describe, expect, test, vi } from 'vitest';

import {
  addressSuggestionScore,
  GeocodingDsvAddressCanonicalizer,
  loadDsvAddressCanonicalizer,
  parseKoreanDeliveryAddress,
  rankDsvAddressSuggestions,
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
        searchAddress: '경기 광주시 초월읍 경충대로1284번길 51',
      },
    ],
    [
      '경기 김포시 고촌읍 아라육로 57번길108 2층 어스에이',
      {
        detailAddress: '2층 어스에이',
        postalCode: null,
        rawAddress: '경기 김포시 고촌읍 아라육로 57번길108 2층 어스에이',
        searchAddress: '경기 김포시 고촌읍 아라육로57번길 108',
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
    [
      '서울특별시 중구 퇴계로 131 (충무로2가)',
      {
        detailAddress: '(충무로2가)',
        postalCode: null,
        rawAddress: '서울특별시 중구 퇴계로 131 (충무로2가)',
        searchAddress: '서울특별시 중구 퇴계로 131',
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

  test('uses provider-normalized Korean road and parcel addresses', async () => {
    const geocode = vi.fn().mockResolvedValue({
      cached: false,
      ok: true,
      result: {
        addressLabel: 'structured_without_unit',
        jibunAddress: '서울특별시 강남구 도곡동 146-92',
        latitude: 37.49282338175886,
        longitude: 127.04627696597555,
        postalCode: '06273',
        provider: 'vworld',
        providerPlaceId: '1168011800101460092',
        rawLabel: '서울특별시 강남구 언주로 211 (도곡동)',
        roadAddress: '서울특별시 강남구 언주로 211 (도곡동)',
      },
    });
    const service = new GeocodingDsvAddressCanonicalizer({ geocode });

    await expect(service.resolve({
      address: '서울 강남구 언주로 211, 본관 지하 1층',
      shopDomain: 'dsv-demo.local',
    })).resolves.toMatchObject({
      address: '서울특별시 강남구 언주로 211 (도곡동)',
      detailAddress: '본관 지하 1층',
      jibunAddress: '서울특별시 강남구 도곡동 146-92',
      postalCode: '06273',
      status: 'RESOLVED',
    });
  });

  test('rejects coordinates when the provider result points to a different Korean address', async () => {
    const searchPlaces = vi.fn().mockResolvedValue([{
      jibunAddress: '서울특별시 중구 충무로2가 65-9',
      latitude: 37.561338,
      longitude: 126.988292,
      providerPlaceId: 'place-myeongdong',
      roadAddress: '서울특별시 중구 퇴계로 131',
      title: '닥터에버스의원 명동점',
    }]);
    const service = new GeocodingDsvAddressCanonicalizer({
      geocode: vi.fn().mockResolvedValue({
        cached: false,
        ok: true,
        result: {
          addressLabel: 'structured_without_unit',
          jibunAddress: '서울특별시 강남구 역삼동 735-3',
          latitude: 37.497942,
          longitude: 127.027621,
          postalCode: '06236',
          provider: 'vworld',
          providerPlaceId: 'wrong-place',
          rawLabel: '서울특별시 강남구 테헤란로 131',
          roadAddress: '서울특별시 강남구 테헤란로 131',
        },
      }),
      searchPlaces,
    });

    await expect(service.resolve({
      address: '서울 중구 퇴계로 131, 5,6층',
      destinationName: '닥터에버스의원 명동점',
      shopDomain: 'dsv-demo.local',
    })).resolves.toMatchObject({
      address: '서울 중구 퇴계로 131',
      detailAddress: '5, 6층',
      latitude: null,
      longitude: null,
      status: 'NOT_FOUND',
      suggestions: [{
        address: '서울특별시 중구 퇴계로 131',
        recommended: true,
        title: '닥터에버스의원 명동점',
      }],
    });
    expect(searchPlaces).toHaveBeenCalledWith({ limit: 10, text: '닥터에버스의원 명동점' });
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

  test('ranks a same-name place on the same road and rejects a different district', () => {
    expect(addressSuggestionScore({
      candidateAddress: '서울특별시 마포구 양화로 166',
      candidateTitle: '제이필의원',
      destinationName: '제이필의원',
      sourceAddress: '서울 마포구 양화로 155',
    })).toBe(98);
    expect(addressSuggestionScore({
      candidateAddress: '서울특별시 강남구 강남대로 438',
      candidateTitle: '제이필의원',
      destinationName: '제이필의원',
      sourceAddress: '서울 마포구 양화로 155',
    })).toBe(0);
  });

  test('accepts a same-location place when the road name has one typo and the place title is expanded', () => {
    expect(addressSuggestionScore({
      candidateAddress: '경기도 김포시 고촌읍 아라육로58번길 35-21',
      candidateTitle: '부림약품물류센터',
      destinationName: '부림약품',
      sourceAddress: '경기 김포시 고촌읍 아리육로58번길 35-21',
    })).toBe(87);
    expect(rankDsvAddressSuggestions({
      candidates: [{
        jibunAddress: '경기도 김포시 고촌읍 전호리 719',
        latitude: 37.5913517,
        longitude: 126.7892205,
        providerPlaceId: 'place-burim',
        roadAddress: '경기도 김포시 고촌읍 아라육로58번길 35-21',
        title: '부림약품물류센터',
      }, {
        jibunAddress: '경기도 김포시 고촌읍 전호리 755',
        latitude: 37.5907885,
        longitude: 126.7892662,
        providerPlaceId: 'place-bus-stop',
        roadAddress: null,
        title: '부림약품.동원아이팜(버스정류장)',
      }],
      detailAddress: '4층',
      destinationName: '부림약품',
      sourceAddress: '경기 김포시 고촌읍 아리육로58번길 35-21',
    })).toEqual([
      expect.objectContaining({
        address: '경기도 김포시 고촌읍 아라육로58번길 35-21',
        detailAddress: '4층',
        recommended: true,
        score: 87,
        title: '부림약품물류센터',
      }),
    ]);
  });

  test('deduplicates place results and marks only a clear top address as recommended', () => {
    expect(rankDsvAddressSuggestions({
      candidates: [
        {
          jibunAddress: '서울특별시 마포구 동교동 165-1',
          latitude: 37.5567296,
          longitude: 126.924141,
          providerPlaceId: 'place-1',
          roadAddress: '서울특별시 마포구 양화로 166',
          title: '제이필의원',
        },
        {
          jibunAddress: '서울특별시 마포구 동교동 165-1',
          latitude: 37.5567326,
          longitude: 126.9241712,
          providerPlaceId: 'place-2',
          roadAddress: '서울특별시 마포구 양화로 166',
          title: '제이필의원',
        },
        {
          jibunAddress: '서울특별시 강남구 역삼동 814-6',
          latitude: 37.5016428,
          longitude: 127.026336,
          providerPlaceId: 'place-3',
          roadAddress: '서울특별시 강남구 강남대로 438',
          title: '제이필의원',
        },
      ],
      detailAddress: '5층, 7층',
      destinationName: '제이필의원',
      sourceAddress: '서울 마포구 양화로 155',
    })).toEqual([
      {
        address: '서울특별시 마포구 양화로 166',
        detailAddress: '5층, 7층',
        jibunAddress: '서울특별시 마포구 동교동 165-1',
        latitude: 37.5567296,
        longitude: 126.924141,
        providerPlaceId: 'place-1',
        recommended: true,
        score: 98,
        title: '제이필의원',
      },
    ]);
  });

  test('suggests a place candidate only after address lookup returns no result', async () => {
    const searchPlaces = vi.fn().mockResolvedValue([{
      jibunAddress: '서울특별시 마포구 동교동 165-1',
      latitude: 37.5567296,
      longitude: 126.924141,
      providerPlaceId: 'place-1',
      roadAddress: '서울특별시 마포구 양화로 166',
      title: '제이필의원',
    }]);
    const service = new GeocodingDsvAddressCanonicalizer({
      geocode: vi.fn().mockResolvedValue({
        code: 'GEOCODER_NO_RESULT',
        message: 'No geocoding result was found.',
        ok: false,
      }),
      searchPlaces,
    });

    await expect(service.resolve({
      address: '서울 마포구 양화로 155 5층, 7층',
      destinationName: '제이필의원',
      shopDomain: 'dsv-demo.local',
    })).resolves.toMatchObject({
      status: 'NOT_FOUND',
      suggestions: [{
        address: '서울특별시 마포구 양화로 166',
        detailAddress: '5층, 7층',
        recommended: true,
        score: 98,
      }],
    });
    expect(searchPlaces).toHaveBeenCalledWith({ limit: 10, text: '제이필의원' });
  });
});
