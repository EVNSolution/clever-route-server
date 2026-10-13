import { describe, expect, test, vi } from 'vitest';

import {
  buildDispatchImportPreview,
  canonicalizeDispatchRows,
  type DsvDispatchImportSourceRow,
} from '../src/modules/dsv/dsv-dispatch-import.service.js';

const drivers = [
  { displayName: '김도윤', id: 'driver-1' },
  { displayName: '이서연', id: 'driver-2' },
  { displayName: '박민재', id: 'driver-3' },
];
const vehicles = [
  { id: 'vehicle-1', licensePlate: '21사 6101' },
  { id: 'vehicle-2', licensePlate: '12바 2302' },
  { id: 'vehicle-3', licensePlate: '13사 3403' },
];

describe('DSV dispatch import validation', () => {
  test('resolves driver and vehicle independently for ten SellerOrder rows', () => {
    const preview = buildDispatchImportPreview({
      conditions: ['Ambient', 'Cold', 'TS03'],
      drivers,
      fileName: 'dsv-fixed-dispatch-10.csv',
      planDate: '2026-07-23',
      priorSellerOrderKeys: [],
      rows: Array.from({ length: 10 }, (_, index) => sourceRow(index)),
      vehicles,
    });

    expect(preview.canCommit).toBe(true);
    expect(preview.summary).toEqual({ errorRows: 0, readyRows: 10, reviewRows: 0, totalRows: 10 });
    expect(preview.rows[0]).toMatchObject({ driverId: 'driver-1', vehicleId: 'vehicle-1' });
    expect(preview.rows[9]).toMatchObject({ driverId: 'driver-1', vehicleId: 'vehicle-1' });
  });

  test('blocks duplicate orders, resource conflicts, and unregistered condition casing', () => {
    const first = sourceRow(0);
    const preview = buildDispatchImportPreview({
      conditions: ['Cold'],
      drivers,
      fileName: 'invalid.csv',
      planDate: '2026-07-23',
      priorSellerOrderKeys: [first.sellerOrderKey],
      rows: [
        first,
        { ...sourceRow(1), conditionCode: 'COLD', driverName: first.driverName, sellerOrderKey: first.sellerOrderKey },
      ],
      vehicles,
    });

    expect(preview.canCommit).toBe(false);
    expect(preview.conditionCandidates).toEqual(['COLD']);
    expect(new Set(preview.rows.flatMap((row) => row.issues.map((issue) => issue.code)))).toEqual(new Set([
      'CONDITION_UNREGISTERED',
      'DRIVER_VEHICLE_CONFLICT',
      'SELLER_ORDER_ALREADY_IMPORTED',
      'SELLER_ORDER_DUPLICATED',
    ]));
  });

  test('allows staging without coordinates but marks the row for later geocoding review', () => {
    const preview = buildDispatchImportPreview({
      conditions: ['Cold'],
      drivers,
      fileName: 'no-coordinates.csv',
      planDate: '2026-07-23',
      priorSellerOrderKeys: [],
      rows: [{ ...sourceRow(0), latitude: null, longitude: null }],
      vehicles,
    });

    expect(preview.canCommit).toBe(true);
    expect(preview.summary).toEqual({ errorRows: 0, readyRows: 0, reviewRows: 1, totalRows: 1 });
    expect(preview.rows[0]?.issues).toEqual([
      expect.objectContaining({ code: 'LOCATION_NOT_RESOLVED', severity: 'review' }),
    ]);
  });

  test('resolves a known driver without requiring a vehicle value', () => {
    const preview = buildDispatchImportPreview({
      conditions: ['Cold'],
      drivers,
      fileName: 'driver-only.csv',
      planDate: '2026-07-23',
      priorSellerOrderKeys: [],
      rows: [{ ...sourceRow(0), vehiclePlate: '' }],
      vehicles,
    });

    expect(preview.canCommit).toBe(true);
    expect(preview.rows[0]).toMatchObject({ driverId: 'driver-1', issues: [], vehicleId: null });
  });

  test('keeps a blank driver and vehicle as an unassigned row', () => {
    const preview = buildDispatchImportPreview({
      conditions: ['Cold'],
      drivers,
      fileName: 'unassigned.csv',
      planDate: '2026-07-23',
      priorSellerOrderKeys: [],
      rows: [{ ...sourceRow(0), driverName: '', vehiclePlate: '' }],
      vehicles,
    });

    expect(preview.canCommit).toBe(true);
    expect(preview.rows[0]).toMatchObject({ driverId: null, issues: [], vehicleId: null });
  });
});

describe('DSV dispatch address canonicalization', () => {
  const clientResolved = (address: string): DsvDispatchImportSourceRow => ({
    ...sourceRow(0),
    address,
    addressResolutionStatus: 'RESOLVED',
    destinationName: '뉴신팜',
    postalCode: '10137',
    rawAddress: address,
  });
  const resolved = (address: string, status: 'RESOLVED' | 'NOT_FOUND' = 'RESOLVED') => ({
    address,
    detailAddress: null,
    jibunAddress: '경기도 김포시 고촌읍 전호리 744',
    latitude: 37.6,
    longitude: 126.7,
    postalCode: '10137',
    rawAddress: '경기 김포시 고촌읍 전호리 744번지',
    status,
  });

  test('re-resolves a client-resolved jibun address so the stored address is the road address', async () => {
    const resolve = vi.fn(() => Promise.resolve(resolved('경기도 김포시 고촌읍 아라육로57번길 46')));
    const [row] = await canonicalizeDispatchRows([clientResolved('경기 김포시 고촌읍 전호리 744번지')], 'dsv.test', { resolve });

    expect(resolve).toHaveBeenCalledOnce();
    expect(row).toMatchObject({ address: '경기도 김포시 고촌읍 아라육로57번길 46', addressResolutionStatus: 'RESOLVED' });
  });

  test('keeps the client resolution when the geocoder has no road address, and skips client-resolved road addresses', async () => {
    const resolve = vi.fn(() => Promise.resolve(resolved('경기 김포시 고촌읍 전호리 744', 'NOT_FOUND')));
    const [jibun, road] = await canonicalizeDispatchRows([
      clientResolved('경기 김포시 고촌읍 전호리 744번지'),
      clientResolved('경기 김포시 고촌읍 아라육로57번길 46'),
    ], 'dsv.test', { resolve });

    expect(resolve).toHaveBeenCalledOnce();
    expect(jibun).toMatchObject({ address: '경기 김포시 고촌읍 전호리 744번지', addressResolutionStatus: 'RESOLVED' });
    expect(road).toMatchObject({ address: '경기 김포시 고촌읍 아라육로57번길 46', addressResolutionStatus: 'RESOLVED' });
  });
});

function sourceRow(index: number): DsvDispatchImportSourceRow {
  const driver = drivers[index % drivers.length]!;
  const vehicle = vehicles[index % vehicles.length]!;
  return {
    address: `서울특별시 배송로 ${index + 1}`,
    conditionCode: index % 3 === 0 ? 'Cold' : index % 3 === 1 ? 'Ambient' : 'TS03',
    customerCode: `CUSTOMER-${(index % 2) + 1}`,
    destinationName: `배송처 ${index + 1}`,
    driverName: driver.displayName,
    latitude: 37.5 + index / 1_000,
    longitude: 127 + index / 1_000,
    notes: null,
    rowNumber: index + 2,
    sellerOrderKey: `DSV-DEMO-${String(index + 1).padStart(3, '0')}`,
    shippedBoxes: index + 1,
    vehiclePlate: vehicle.licensePlate,
  };
}
