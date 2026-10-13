import { describe, expect, it } from 'vitest';
import { dsvDestinationIdentity, dsvRoadAddressBase, hasDsvRoadAddress } from '../src/modules/dsv/dsv-destination-identity.js';

describe('dsvDestinationIdentity', () => {
  const canonical = dsvDestinationIdentity({
    address: '경기 안양시 동안구 흥안대로439번길 30',
    detailAddress: '1층',
    destinationName: '지오영',
  });

  it('keys a road address by the building number and ignores how the detail is written', () => {
    for (const [address, detailAddress] of [
      ['경기 안양시 동안구 흥안대로439번길30, 1층', '1층'],
      ['경기 안양시 동안구 흥안대로439번길 30,1층', '1층'],
      ['경기안양시동안구흥안대로439번길30', null],
      ['경기 안양시 동안구 흥안대로439번길 30 (관양동, 지상1층)', '(관양동, 지상1층)'],
      ['경기 안양시 동안구 흥안대로439번길 30', '2층'],
    ] as const) {
      expect(dsvDestinationIdentity({ address, detailAddress, destinationName: '지오 영' })).toEqual(canonical);
    }
    expect(canonical).toEqual({ address: '경기안양시동안구흥안대로439번길30', name: '지오영' });
  });

  it('collapses the detail spellings seen in production dispatch files', () => {
    const same = (left: string, right: string, name = 'x') => expect(dsvDestinationIdentity({ address: left, destinationName: name }))
      .toEqual(dsvDestinationIdentity({ address: right, destinationName: name }));
    same('서울 마포구 모래내로7길 12, 5층(성산동, MEK빌딩)', '서울 마포구 모래내로7길 12, 5층 (성산동, MEK빌딩(멕빌딩))');
    same('경기 하남시 미사강변중앙로48번길 15, 7층(풍산동)', '경기 하남시 미사강변중앙로48번길 15, 1 2층 (풍산동)');
    same('경기 김포시 고촌읍 아라육로 57번길 108 2층', '경기 김포시 고촌읍 아라육로57번길 108 지상2층');
    same('경기 광주 회안대로 837(성정동) 지하2층', '경기 광주 회안대로 837 지하2층(성정동)');
    same('서울 동대문구 답십리동 753 MJ B/D', '서울 동대문구 답십리동 753번지 엠제이빌딩');
    same('서울 영등포구 양평동6가78', '서울 영등포구 양평동 6가 78 1층 은색문 정문 앞 입고실');
    same('경기 용인시 처인구 남사면 천덕산로 116-4', '경기 용인시 처인구 남사읍 천덕산로 116-4');
  });

  it('drops corporate markers from the name', () => {
    const address = '서울 마포구 희우정로5길 28';
    for (const name of ['주식회사서준약품', '(주)서준약품', '㈜ 서준약품', '서준약품(주)']) {
      expect(dsvDestinationIdentity({ address, destinationName: name })).toEqual(dsvDestinationIdentity({ address, destinationName: '서준약품' }));
    }
  });

  it('spells the leading province the short way', () => {
    expect(dsvDestinationIdentity({ address: '경기도 안양시 동안구 흥안대로439번길 30', detailAddress: '1층', destinationName: '지오영' }))
      .toEqual(canonical);
    expect(dsvDestinationIdentity({ address: '서울특별시 마포구 양화로 166', detailAddress: null, destinationName: 'x' }).address)
      .toBe('서울마포구양화로166');
    expect(dsvDestinationIdentity({ address: '충청북도 청주시 상당구 상당로 82', detailAddress: null, destinationName: 'x' }).address)
      .toBe('충북청주시상당구상당로82');
    expect(dsvDestinationIdentity({ address: '전북특별자치도 전주시 완산구 효자로 225', detailAddress: null, destinationName: 'x' }).address)
      .toBe('전북전주시완산구효자로225');
  });

  it('keeps different buildings and different customers in one building apart', () => {
    expect(dsvDestinationIdentity({ address: '경기 안양시 동안구 흥안대로439번길 30-1', detailAddress: '1층', destinationName: '지오영' }))
      .not.toEqual(canonical);
    expect(dsvDestinationIdentity({ address: '경기 안양시 동안구 흥안대로439번길 3', detailAddress: '1층', destinationName: '지오영' }))
      .not.toEqual(canonical);
    expect(dsvDestinationIdentity({ address: '경기 김포시 고촌읍 아라육로58번길 35-21', destinationName: '부림약품' }).address)
      .not.toBe(dsvDestinationIdentity({ address: '경기 김포시 고촌읍 아라육로58번길 35-19', destinationName: '부림약품' }).address);
    expect(dsvDestinationIdentity({ address: '서울 서초구 서초대로77길 54, 10층', destinationName: '히어피부과의원' }))
      .not.toEqual(dsvDestinationIdentity({ address: '서울 서초구 서초대로77길 54, 7 8층', destinationName: '기린성형외과의원' }));
  });

  it('does not read a district or dong name as a road', () => {
    expect(dsvDestinationIdentity({ address: '서울특별시 종로구 대학로 101', destinationName: 'x' }).address).toBe('서울종로구대학로101');
    expect(dsvRoadAddressBase('경기 김포시 고촌읍 아라육로58번길 35-21, 4층')).toBe('경기 김포시 고촌읍 아라육로58번길 35-21');
    expect(dsvRoadAddressBase('서울 광진구 자양로38길 10(구의동)')).toBe('서울 광진구 자양로38길 10');
    expect(hasDsvRoadAddress('경기 김포시 고촌읍 전호리 744번지')).toBe(false);
    expect(hasDsvRoadAddress('서울 영등포구 문래동 5가6')).toBe(false);
  });
});
