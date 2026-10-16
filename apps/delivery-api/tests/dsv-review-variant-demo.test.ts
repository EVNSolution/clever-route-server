import { describe, expect, test } from 'vitest';

import { buildVariantRows, planVariantGroups, predictStopsPerGroup, type VariantProfile } from '../src/scripts/dsv-review-variant-demo.js';

const at = (day: number) => new Date(`2026-09-${String(day).padStart(2, '0')}T00:00:00.000Z`);
const profile = (id: string, name: string, address: string, extra: Partial<VariantProfile> & { latitude?: number } = {}): VariantProfile => ({
  canonicalName: name, createdAt: at(1), id, mergedIntoProfileId: null,
  normalizedAddress: { address, name, ...(extra.latitude === undefined ? {} : { latitude: extra.latitude, longitude: 126.9 }) },
  ...extra,
});

// Spellings like the 2026-10-13 production merges: spacing, commas, (주), floor note.
const survivor = profile('a', '지오영', '경기 안양시 동안구 흥안대로439번길30, 1층', { latitude: 37.4 });
const spacing = profile('b', '지오영', '경기 안양시 동안구 흥안대로439번길 30,1층', { mergedIntoProfileId: 'a' });
const corporate = profile('c', '(주)지오영', '경기도 안양시 동안구 흥안대로439번길 30 2층', { mergedIntoProfileId: 'b' });
const lone = profile('d', '다른곳', '서울 강남구 테헤란로 1', { latitude: 37.5 });
const noCoordinates = profile('e', '좌표없음', '서울 중구 세종대로 110');
const noCoordinatesDup = profile('f', '좌표없음', '서울 중구 세종대로 110 1층', { mergedIntoProfileId: 'e' });

describe('review variant demo plan', () => {
  test('follows merge chains to the survivor and skips unmerged or coordinate-less places', () => {
    const groups = planVariantGroups([survivor, spacing, corporate, lone, noCoordinates, noCoordinatesDup], 5);
    expect(groups).toEqual([{ rootId: 'a', spellings: [survivor, spacing, corporate] }]);
  });

  test('every spelling of one merged place is predicted to land on one stop', () => {
    const profiles = [survivor, spacing, corporate, lone];
    const rows = buildVariantRows({
      conditionCode: '상온', driverName: '임지인', groups: planVariantGroups(profiles, 5), planDate: '2026-10-16', profiles,
    });
    expect(rows.map((row) => row.destinationName)).toEqual(['데모 지오영', '데모 지오영', '데모 (주)지오영']);
    expect(rows.every((row) => row.latitude === 37.4 && row.vehiclePlate === '')).toBe(true);
    expect(rows.map((row) => row.rowNumber)).toEqual([2, 3, 4]);
    expect(predictStopsPerGroup(rows)).toEqual([1]);
  });

  test('a different name at the same address stays a separate stop', () => {
    const renamed = profile('g', '지오영서부', '경기 안양시 동안구 흥안대로439번길 30', { mergedIntoProfileId: 'a' });
    const profiles = [survivor, renamed];
    const rows = buildVariantRows({
      conditionCode: '상온', driverName: '임지인', groups: planVariantGroups(profiles, 5), planDate: '2026-10-16', profiles,
    });
    expect(predictStopsPerGroup(rows)).toEqual([2]);
  });
});
