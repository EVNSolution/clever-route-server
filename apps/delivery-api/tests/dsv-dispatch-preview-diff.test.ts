import { describe, expect, test } from 'vitest';

import {
  buildDsvDispatchPreviewDiff,
  conditionComparisonKey,
  dsvDispatchImportSourceKind,
  type DsvDispatchCanonicalOrderSnapshot,
  type DsvDispatchPreviewInput,
  type DsvDispatchPreviewSnapshots,
  type DsvDispatchSourceRow,
} from '../src/modules/dsv/dsv-dispatch-preview-diff.js';

describe('G003 DSV dispatch preview diff', () => {
  test('normalizes Cold, COLD, and padded cold to the same condition comparison key', () => {
    expect(['Cold', 'COLD', ' cold '].map(conditionComparisonKey)).toEqual(['COLD', 'COLD', 'COLD']);

    const preview = buildDsvDispatchPreviewDiff(input({
      rows: [
        sourceRow({ conditionCode: 'Cold', rowNumber: 2, sellerOrderKey: 'SO-001' }),
        sourceRow({ conditionCode: 'COLD', rowNumber: 3, sellerOrderKey: 'SO-002' }),
        sourceRow({ conditionCode: ' cold ', rowNumber: 4, sellerOrderKey: 'SO-003' }),
      ],
    }));

    expect(preview.conditionCandidates).toEqual([]);
    expect(preview.rows.map((row) => row.conditionId)).toEqual(['condition-cold', 'condition-cold', 'condition-cold']);
    expect(preview.rows.map((row) => row.normalized.conditionComparisonKey)).toEqual(['COLD', 'COLD', 'COLD']);
    expect(preview.rows.map((row) => row.diffKind)).toEqual(['NEW', 'NEW', 'NEW']);
  });

  test('returns deterministic hashes and row ordering when input rows are shuffled', () => {
    const rows = [
      sourceRow({ rowNumber: 4, sellerOrderKey: 'SO-003' }),
      sourceRow({ rowNumber: 2, sellerOrderKey: 'SO-001' }),
      sourceRow({ rowNumber: 3, sellerOrderKey: 'SO-002' }),
    ];
    const first = buildDsvDispatchPreviewDiff(input({ rows }));
    const replay = buildDsvDispatchPreviewDiff(input({ rows: [...rows].reverse() }));

    expect(replay.sourceHash).toBe(first.sourceHash);
    expect(replay.previewHash).toBe(first.previewHash);
    expect(first.rows.map((row) => row.sellerOrderKey)).toEqual(['SO-001', 'SO-002', 'SO-003']);
    expect(replay.rows).toEqual(first.rows);
  });

  test('keeps candidate raw provenance deterministic across shuffled and reversed raw variants', () => {
    const rows = [
      sourceRow({ conditionCode: ' ts03 ', rowNumber: 4, sellerOrderKey: 'SO-CANDIDATE-003' }),
      sourceRow({ conditionCode: 'Ts03', rowNumber: 2, sellerOrderKey: 'SO-CANDIDATE-001' }),
      sourceRow({ conditionCode: 'TS03', rowNumber: 3, sellerOrderKey: 'SO-CANDIDATE-002' }),
    ];
    const first = buildDsvDispatchPreviewDiff(input({ rows }));
    const shuffled = buildDsvDispatchPreviewDiff(input({ rows: [rows[2]!, rows[0]!, rows[1]!] }));
    const reversed = buildDsvDispatchPreviewDiff(input({ rows: [...rows].reverse() }));

    expect(shuffled.sourceHash).toBe(first.sourceHash);
    expect(reversed.sourceHash).toBe(first.sourceHash);
    expect(shuffled.previewHash).toBe(first.previewHash);
    expect(reversed.previewHash).toBe(first.previewHash);
    expect(first.conditionCandidates).toEqual([{
      comparisonKey: 'TS03',
      rawValue: 'Ts03',
      rowNumbers: [2, 3, 4],
    }]);
    expect(shuffled.conditionCandidates).toEqual(first.conditionCandidates);
    expect(reversed.conditionCandidates).toEqual(first.conditionCandidates);
  });

  test('sorts issues by code and classifies duplicate rows as ERROR', () => {
    const preview = buildDsvDispatchPreviewDiff(input({
      rows: [
        sourceRow({
          customerCode: 'UNKNOWN-CUSTOMER',
          destinationName: 'Unknown Destination',
          driverName: 'Unknown Driver',
          rowNumber: 2,
          sellerOrderKey: 'SO-DUP',
          vehiclePlate: 'Unknown Vehicle',
        }),
        sourceRow({
          customerCode: 'UNKNOWN-CUSTOMER',
          destinationName: 'Unknown Destination',
          driverName: 'Unknown Driver',
          rowNumber: 3,
          sellerOrderKey: 'SO-DUP',
          vehiclePlate: 'Unknown Vehicle',
        }),
      ],
    }));

    expect(preview.rows).toHaveLength(2);
    expect(preview.rows[0]?.diffKind).toBe('ERROR');
    expect(preview.rows[0]?.issues.map((issue) => issue.code)).toEqual([
      'DRIVER_MISSING',
      'SELLER_ORDER_DUPLICATED',
      'VEHICLE_MISSING',
    ]);
    expect(preview.canApply).toBe(false);
  });

  test('treats blank driver or vehicle fields as explicit unassigned rows', () => {
    const preview = buildDsvDispatchPreviewDiff(input({
      rows: [
        sourceRow({
          driverName: '',
          rowNumber: 2,
          sellerOrderKey: 'SO-UNASSIGNED-DRIVER',
          vehiclePlate: 'Unknown Vehicle',
        }),
        sourceRow({
          driverName: 'Unknown Driver',
          rowNumber: 3,
          sellerOrderKey: 'SO-UNASSIGNED-VEHICLE',
          vehiclePlate: '   ',
        }),
      ],
    }));

    expect(preview.canApply).toBe(true);
    expect(preview.summary).toMatchObject({ errorRows: 0, newRows: 2, readyRows: 2 });
    expect(preview.rows.map((row) => ({
      diffKind: row.diffKind,
      driverId: row.driverId,
      issueCodes: row.issues.map((issue) => issue.code),
      vehicleId: row.vehicleId,
    }))).toEqual([
      { diffKind: 'NEW', driverId: null, issueCodes: [], vehicleId: null },
      { diffKind: 'NEW', driverId: null, issueCodes: [], vehicleId: null },
    ]);
    expect(preview.rows.map((row) => row.normalized)).toMatchObject([
      { driverName: '', vehiclePlate: 'Unknown Vehicle' },
      { driverName: 'Unknown Driver', vehiclePlate: '' },
    ]);
  });

  test('keeps unknown nonblank driver and vehicle values as deterministic errors', () => {
    const preview = buildDsvDispatchPreviewDiff(input({
      rows: [
        sourceRow({
          driverName: 'Unknown Driver',
          rowNumber: 2,
          sellerOrderKey: 'SO-UNKNOWN-RESOURCE',
          vehiclePlate: 'Unknown Vehicle',
        }),
      ],
    }));

    expect(preview.canApply).toBe(false);
    expect(preview.rows[0]).toMatchObject({ diffKind: 'ERROR', driverId: null, vehicleId: null });
    expect(preview.rows[0]?.issues.map((issue) => issue.code)).toEqual(['DRIVER_MISSING', 'VEHICLE_MISSING']);
  });

  test('blocks apply when a road address or postal code cannot be canonically resolved', () => {
    const preview = buildDsvDispatchPreviewDiff(input({
      rows: [sourceRow({
        addressResolutionStatus: 'NOT_FOUND',
        latitude: null,
        longitude: null,
        postalCode: null,
      })],
    }));

    expect(preview.canApply).toBe(false);
    expect(preview.summary.reviewRows).toBe(1);
    expect(preview.rows[0]?.issues).toContainEqual({
      code: 'ADDRESS_NOT_FOUND',
      field: 'address',
      message: '도로명주소와 우편번호를 확인하지 못했습니다.',
      severity: 'review',
    });
  });

  test('blocks an exact inactive customer without coupling physical destination resolution to customer code', () => {
    const preview = buildDsvDispatchPreviewDiff(input({
      rows: [sourceRow({ customerCode: 'CUSTOMER-INACTIVE', sellerOrderKey: 'SO-INACTIVE-CUSTOMER' })],
      snapshots: {
        customers: [{ externalCustomerCode: 'CUSTOMER-INACTIVE', id: 'customer-inactive', status: 'INACTIVE' }],
        destinations: [{
          address: '123 Route Street',
          customerCode: 'DIFFERENT-CUSTOMER',
          id: 'destination-shared',
          name: 'Main Dock',
        }],
      },
    }));

    expect(preview.canApply).toBe(false);
    expect(preview.rows[0]).toMatchObject({
      customerId: null,
      destinationId: 'destination-shared',
      diffKind: 'ERROR',
    });
    expect(preview.rows[0]?.issues.map((issue) => issue.code)).toEqual(['CUSTOMER_INACTIVE']);
  });

  test('resolves one active exact customer and blocks multiple active exact matches', () => {
    const active = buildDsvDispatchPreviewDiff(input({
      rows: [sourceRow({ sellerOrderKey: 'SO-ACTIVE-CUSTOMER' })],
      snapshots: {
        customers: [
          { externalCustomerCode: 'CUSTOMER-1', id: 'customer-inactive', status: 'INACTIVE' },
          { externalCustomerCode: 'CUSTOMER-1', id: 'customer-active', status: 'ACTIVE' },
        ],
      },
    }));
    const ambiguous = buildDsvDispatchPreviewDiff(input({
      rows: [sourceRow({ sellerOrderKey: 'SO-AMBIGUOUS-CUSTOMER' })],
      snapshots: {
        customers: [
          { externalCustomerCode: 'CUSTOMER-1', id: 'customer-active-1', status: 'ACTIVE' },
          { externalCustomerCode: 'CUSTOMER-1', id: 'customer-inactive', status: 'INACTIVE' },
          { externalCustomerCode: 'CUSTOMER-1', id: 'customer-active-2', status: 'ACTIVE' },
        ],
      },
    }));

    expect(active.canApply).toBe(true);
    expect(active.rows[0]).toMatchObject({ customerId: 'customer-active', diffKind: 'NEW', issues: [] });
    expect(ambiguous.canApply).toBe(false);
    expect(ambiguous.rows[0]).toMatchObject({ customerId: null, diffKind: 'ERROR' });
    expect(ambiguous.rows[0]?.issues.map((issue) => issue.code)).toEqual(['CUSTOMER_AMBIGUOUS']);
  });

  test('classifies identical existing canonical order from a prior batch as NO_OP', () => {
    const row = sourceRow({ rowNumber: 2, sellerOrderKey: 'SO-PRIOR' });
    const preview = buildDsvDispatchPreviewDiff(input({
      rows: [row],
      snapshots: {
        canonicalOrders: [canonicalOrder(row, { id: 'order-prior', stopId: 'stop-prior' })],
        priorImportRows: [{
          canonicalLink: {
            customerId: 'customer-1',
            deliveryStopId: 'stop-prior',
            destinationId: 'destination-1',
            sellerOrderId: 'order-prior',
          },
          normalized: {
            address: row.address,
            conditionComparisonKey: 'COLD',
            customerCode: row.customerCode,
            destinationName: row.destinationName,
            driverName: row.driverName,
            latitude: row.latitude,
            longitude: row.longitude,
            notes: row.notes,
            planDate: '2026-07-23',
            sellerOrderKey: row.sellerOrderKey,
            shippedBoxes: row.shippedBoxes,
            sourceKind: dsvDispatchImportSourceKind,
            vehiclePlate: row.vehiclePlate,
          },
          sellerOrderKey: row.sellerOrderKey,
          sourceKind: dsvDispatchImportSourceKind,
        }],
      },
    }));

    expect(preview.summary).toMatchObject({ noOpRows: 1, readyRows: 1 });
    expect(preview.rows[0]).toMatchObject({
      deliveryStopId: 'stop-prior',
      diffKind: 'NO_OP',
      sellerOrderId: 'order-prior',
    });
    expect(preview.canApply).toBe(true);
  });

  test('classifies changed existing order fields as UPDATE_CANDIDATE', () => {
    const previous = sourceRow({ address: '100 Old Road', rowNumber: 2, sellerOrderKey: 'SO-CHANGE' });
    const incoming = sourceRow({ address: '200 New Road', rowNumber: 2, sellerOrderKey: 'SO-CHANGE' });
    const preview = buildDsvDispatchPreviewDiff(input({
      rows: [incoming],
      snapshots: {
        canonicalOrders: [canonicalOrder(previous, { id: 'order-change', stopId: 'stop-change' })],
        destinations: [{
          address: incoming.address,
          customerCode: incoming.customerCode,
          id: 'destination-1',
          name: incoming.destinationName,
        }],
      },
    }));

    expect(preview.summary.updateCandidateRows).toBe(1);
    expect(preview.rows[0]?.diffKind).toBe('UPDATE_CANDIDATE');
    expect(preview.rows[0]?.candidateDiff).toEqual([
      { existing: '100 Old Road', field: 'address', incoming: '200 New Road' },
    ]);
    expect(preview.canApply).toBe(true);
  });

  test('treats the same seller order key on a different plan date as a new canonical order', () => {
    const previous = sourceRow({ rowNumber: 2, sellerOrderKey: 'SO-DATED' });
    const incoming = sourceRow({ rowNumber: 2, sellerOrderKey: 'SO-DATED' });
    const preview = buildDsvDispatchPreviewDiff(input({
      rows: [incoming],
      snapshots: {
        canonicalOrders: [canonicalOrder(previous, {
          deliveryDate: '2026-07-22',
          id: 'order-dated-previous',
          serviceDate: '2026-07-22',
          stopId: 'stop-dated-previous',
        })],
      },
    }));

    expect(preview.canApply).toBe(true);
    expect(preview.summary).toMatchObject({ newRows: 1, updateCandidateRows: 0 });
    expect(preview.rows[0]).toMatchObject({
      candidateDiff: [],
      deliveryStopId: null,
      diffKind: 'NEW',
      sellerOrderId: null,
    });
  });

  test('keeps an existing destination id when legacy fingerprint lookup misses but name and address are unchanged', () => {
    const row = sourceRow({ rowNumber: 2, sellerOrderKey: 'SO-LEGACY-FINGERPRINT' });
    const preview = buildDsvDispatchPreviewDiff(input({
      rows: [row],
      snapshots: {
        canonicalOrders: [canonicalOrder(row, { id: 'order-legacy-fingerprint', stopId: 'stop-legacy-fingerprint' })],
        destinations: [],
      },
    }));

    expect(preview.canApply).toBe(true);
    expect(preview.rows[0]).toMatchObject({
      destinationId: 'destination-1',
      diffKind: 'NO_OP',
    });
    expect(preview.rows[0]?.candidateDiff).toEqual([]);
  });

  test('classifies changed existing orders with active ownership as CONFLICT', () => {
    const previous = sourceRow({ address: '100 Old Road', rowNumber: 2, sellerOrderKey: 'SO-ACTIVE-CHANGE' });
    const incoming = sourceRow({ address: '200 New Road', rowNumber: 2, sellerOrderKey: 'SO-ACTIVE-CHANGE' });
    const preview = buildDsvDispatchPreviewDiff(input({
      rows: [incoming],
      snapshots: {
        canonicalOrders: [
          canonicalOrder(previous, { activeDeliveryOwnershipCount: 1, id: 'order-active-change', stopId: 'stop-active-change' }),
        ],
        destinations: [{
          address: incoming.address,
          customerCode: incoming.customerCode,
          id: 'destination-new',
          name: incoming.destinationName,
        }],
      },
    }));

    expect(preview.canApply).toBe(false);
    expect(preview.rows[0]).toMatchObject({ diffKind: 'CONFLICT' });
    expect(preview.rows[0]?.issues.map((issue) => issue.code)).toEqual(['CANONICAL_ORDER_ACTIVE_OWNERSHIP']);
  });

  test('classifies changed existing stops that are no longer pending as CONFLICT', () => {
    const previous = sourceRow({ address: '100 Old Road', rowNumber: 2, sellerOrderKey: 'SO-STOP-STATUS' });
    const incoming = sourceRow({ address: '200 New Road', rowNumber: 2, sellerOrderKey: 'SO-STOP-STATUS' });

    for (const stopStatus of ['ARRIVED', 'DELIVERED'] as const) {
      const preview = buildDsvDispatchPreviewDiff(input({
        rows: [incoming],
        snapshots: {
          canonicalOrders: [canonicalOrder(previous, { id: `order-${stopStatus}`, stopId: `stop-${stopStatus}`, stopStatus })],
          destinations: [{
            address: incoming.address,
            customerCode: incoming.customerCode,
            id: 'destination-new',
            name: incoming.destinationName,
          }],
        },
      }));

      expect(preview.canApply).toBe(false);
      expect(preview.rows[0]).toMatchObject({ diffKind: 'CONFLICT' });
      expect(preview.rows[0]?.issues.map((issue) => issue.code)).toEqual(['CANONICAL_STOP_NOT_PENDING']);
    }
  });

  test('gates candidate and inactive conditions without creating active condition links', () => {
    const candidate = buildDsvDispatchPreviewDiff(input({
      rows: [sourceRow({ conditionCode: 'TS03', rowNumber: 2, sellerOrderKey: 'SO-CANDIDATE' })],
    }));
    const inactive = buildDsvDispatchPreviewDiff(input({
      rows: [sourceRow({ conditionCode: 'Frozen', rowNumber: 2, sellerOrderKey: 'SO-INACTIVE' })],
      snapshots: {
        conditions: [{
          code: 'Frozen',
          comparisonKey: 'FROZEN',
          id: 'condition-frozen',
          rawValue: 'Frozen',
          status: 'INACTIVE',
        }],
      },
    }));

    expect(candidate.conditionCandidates).toEqual([{ comparisonKey: 'TS03', rawValue: 'TS03', rowNumbers: [2] }]);
    expect(candidate.rows[0]).toMatchObject({ conditionId: null, diffKind: 'ERROR' });
    expect(candidate.rows[0]?.issues.map((issue) => issue.code)).toEqual(['CONDITION_CANDIDATE']);
    expect(inactive.rows[0]).toMatchObject({ conditionId: null, diffKind: 'ERROR' });
    expect(inactive.rows[0]?.issues.map((issue) => issue.code)).toEqual(['CONDITION_INACTIVE']);
  });

  test('detects ambiguous resources and duplicate active delivery conflicts distinctly', () => {
    const ambiguousResources = buildDsvDispatchPreviewDiff(input({
      rows: [sourceRow({ rowNumber: 2, sellerOrderKey: 'SO-AMBIGUOUS' })],
      snapshots: {
        drivers: [
          { displayName: 'Driver One', id: 'driver-1', status: 'ACTIVE' },
          { displayName: 'Driver One', id: 'driver-duplicate', status: 'ACTIVE' },
        ],
      },
    }));
    const conflictRow = sourceRow({ rowNumber: 2, sellerOrderKey: 'SO-CONFLICT' });
    const duplicateActiveDelivery = buildDsvDispatchPreviewDiff(input({
      rows: [conflictRow],
      snapshots: {
        canonicalOrders: [
          canonicalOrder(conflictRow, { activeDeliveryOwnershipCount: 2, id: 'order-conflict', stopId: 'stop-conflict' }),
        ],
      },
    }));

    expect(ambiguousResources.rows[0]).toMatchObject({ diffKind: 'ERROR', driverId: null });
    expect(ambiguousResources.rows[0]?.issues.map((issue) => issue.code)).toContain('DRIVER_AMBIGUOUS');
    expect(duplicateActiveDelivery.rows[0]?.diffKind).toBe('CONFLICT');
    expect(duplicateActiveDelivery.rows[0]?.issues.map((issue) => issue.code)).toEqual(['DUPLICATE_ACTIVE_DELIVERY']);
    expect(duplicateActiveDelivery.summary).toMatchObject({ conflictRows: 1, errorRows: 0 });
  });
});

function input(overrides: {
  rows: DsvDispatchSourceRow[];
  snapshots?: Partial<DsvDispatchPreviewSnapshots>;
}): DsvDispatchPreviewInput {
  return {
    fileName: 'dispatch.csv',
    planDate: '2026-07-23',
    rows: overrides.rows,
    shopId: 'shop-1',
    snapshots: {
      canonicalOrders: [],
      conditions: [{ code: 'Cold', comparisonKey: 'COLD', id: 'condition-cold', rawValue: 'Cold', status: 'ACTIVE' }],
      customers: [{ externalCustomerCode: 'CUSTOMER-1', id: 'customer-1', status: 'ACTIVE' }],
      destinations: [{ address: '123 Route Street', customerCode: 'CUSTOMER-1', id: 'destination-1', name: 'Main Dock' }],
      drivers: [{ displayName: 'Driver One', id: 'driver-1', status: 'ACTIVE' }],
      priorImportRows: [],
      vehicles: [{ id: 'vehicle-1', licensePlate: '12AB1234', status: 'ACTIVE' }],
      ...overrides.snapshots,
    },
  };
}

function sourceRow(overrides: Partial<DsvDispatchSourceRow>): DsvDispatchSourceRow {
  return {
    address: '123 Route Street',
    conditionCode: 'Cold',
    customerCode: 'CUSTOMER-1',
    destinationName: 'Main Dock',
    driverName: 'Driver One',
    latitude: 37.5,
    longitude: 127,
    notes: null,
    rowNumber: 2,
    sellerOrderKey: 'SO-001',
    shippedBoxes: 3,
    vehiclePlate: '12AB1234',
    ...overrides,
  };
}

function canonicalOrder(
  row: DsvDispatchSourceRow,
  overrides: {
    activeDeliveryOwnershipCount?: number;
    deliveryDate?: string;
    id: string;
    serviceDate?: string;
    stopId: string;
    stopStatus?: string;
  },
): DsvDispatchCanonicalOrderSnapshot {
  return {
    activeDeliveryOwnershipCount: overrides.activeDeliveryOwnershipCount ?? 0,
    cancelledAt: null,
    customerId: 'customer-1',
    deliveryStatus: 'PENDING',
    deliveryStop: {
      address: row.address,
      conditionComparisonKey: conditionComparisonKey(row.conditionCode),
      deliveryDate: overrides.deliveryDate ?? '2026-07-23',
      destinationName: row.destinationName,
      id: overrides.stopId,
      latitude: row.latitude,
      longitude: row.longitude,
      notes: row.notes,
      shippedBoxes: row.shippedBoxes,
      status: overrides.stopStatus ?? 'PENDING',
    },
    destinationId: 'destination-1',
    id: overrides.id,
    sellerOrderKey: row.sellerOrderKey,
    serviceDate: overrides.serviceDate ?? overrides.deliveryDate ?? '2026-07-23',
    sourceKind: dsvDispatchImportSourceKind,
  };
}
