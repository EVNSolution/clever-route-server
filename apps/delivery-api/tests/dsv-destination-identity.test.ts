import { describe, expect, it } from 'vitest';
import { dsvDestinationIdentity } from '../src/modules/dsv/dsv-destination-identity.js';

describe('dsvDestinationIdentity', () => {
  const canonical = dsvDestinationIdentity({
    address: '경기 안양시 동안구 흥안대로439번길 30',
    detailAddress: '1층',
    destinationName: '지오영',
  });

  it('matches legacy rows whose base address still carries the detail, regardless of spacing', () => {
    for (const address of [
      '경기 안양시 동안구 흥안대로439번길30, 1층',
      '경기 안양시 동안구 흥안대로439번길 30,1층',
      '경기 안양시 동안구 흥안대로439번길 30, 1층',
    ]) {
      expect(dsvDestinationIdentity({ address, detailAddress: '1층', destinationName: '지오영' })).toEqual(canonical);
    }
    expect(dsvDestinationIdentity({ address: '경기안양시동안구흥안대로439번길30', detailAddress: null, destinationName: '지오 영' }))
      .toEqual({ ...canonical, address: canonical.address.slice(0, -'1층'.length) });
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

  it('keeps different units at one building apart', () => {
    expect(dsvDestinationIdentity({ address: '경기 안양시 동안구 흥안대로439번길 30', detailAddress: '2층', destinationName: '지오영' }))
      .not.toEqual(canonical);
    expect(dsvDestinationIdentity({ address: '경기 안양시 동안구 흥안대로439번길 30-1', detailAddress: '1층', destinationName: '지오영' }))
      .not.toEqual(canonical);
  });
});
