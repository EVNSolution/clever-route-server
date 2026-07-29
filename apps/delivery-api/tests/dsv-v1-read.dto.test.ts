import { describe, expect, test } from 'vitest';

import {
  deriveDsvV1ProofStatus,
  mapDsvV1ConditionListItem,
  mapDsvV1ControlSummary,
  mapDsvV1CustomerDeliveryInquiryItem,
  mapDsvV1CustomerDeliveryInquiryPage,
  mapDsvV1CustomerListItem,
  mapDsvV1DestinationListItem,
  mapDsvV1DriverListItem,
  mapDsvV1EventSummary,
  mapDsvV1ManagementListPage,
  mapDsvV1Record,
  mapDsvV1SellerOrderSummary,
  mapDsvV1SellerOrderSummaryPage,
  mapDsvV1SessionPrincipal,
  mapDsvV1VehicleListItem,
  toDsvV1ErrorEnvelope,
  toDsvV1SuccessEnvelope,
  type DsvV1CustomerDeliveryInquiryRow,
  type DsvV1EventRowInput,
  type DsvV1ProofRowInput,
} from '../src/modules/dsv/dsv-v1-read.dto.js';

describe('G005 DSV v1 read DTO adapter', () => {
  test('builds frozen v1 success and error envelopes', () => {
    expect(toDsvV1SuccessEnvelope({ ok: true }, 'req-1')).toEqual({
      data: { ok: true },
      meta: { apiVersion: 'dsv.v1' },
      requestId: 'req-1',
    });

    expect(toDsvV1ErrorEnvelope({
      code: 'BAD_REQUEST',
      details: { field: 'serviceDate' },
      message: 'Invalid query.',
      requestId: 'req-2',
    })).toEqual({
      error: {
        code: 'BAD_REQUEST',
        details: { field: 'serviceDate' },
        message: 'Invalid query.',
        requestId: 'req-2',
      },
    });
  });

  test('maps session principal summary without mutating the principal scopes', () => {
    const scopes = ['dsv:session:read', 'dsv:customer-deliveries:read'] as const;
    const dto = mapDsvV1SessionPrincipal({
      customerId: 'customer-1',
      principalType: 'CUSTOMER_USER',
      scopes,
      shopId: 'shop-1',
    });

    expect(dto).toEqual({
      customerId: 'customer-1',
      principalType: 'CUSTOMER_USER',
      scopes: ['dsv:session:read', 'dsv:customer-deliveries:read'],
      shopId: 'shop-1',
    });
    expect(dto.scopes).not.toBe(scopes);
  });

  test('keeps the personal administrator identity in the session contract', () => {
    expect(mapDsvV1SessionPrincipal({
      actorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      displayName: '운영 관리자',
      principalType: 'DSV_ADMIN',
      scopes: ['dsv:session:read'],
      shopId: 'shop-1',
    })).toEqual({
      actorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      displayName: '운영 관리자',
      principalType: 'DSV_ADMIN',
      scopes: ['dsv:session:read'],
      shopId: 'shop-1',
    });
  });

  test('maps seller order summaries and page info from supplied route-stop ETA only', () => {
    const dto = mapDsvV1SellerOrderSummary({
      assignmentStatus: 'ASSIGNED',
      customerId: 'customer-1',
      destinationAddress: '1 Shared Way, Seoul',
      destinationDisplayName: 'Destination A',
      destinationId: 'destination-1',
      driverId: 'driver-1',
      estimatedArrivalAt: new Date('2026-07-23T01:02:03.000Z'),
      etaInputRouteVersionId: 'route-version-private',
      etaSource: 'ROUTE_STARTED',
      etaStatus: 'READY',
      latitude: 37.1234567,
      longitude: 127.1234567,
      routePlanId: 'route-plan-1',
      routeVersionId: 'route-version-1',
      sellerOrderId: 'order-1',
      sellerOrderKey: 'SO-001',
      vehicleId: 'vehicle-1',
    });

    expect(dto).toEqual({
      assignmentStatus: 'ASSIGNED',
      customerId: 'customer-1',
      destinationAddress: '1 Shared Way, Seoul',
      destinationDisplayName: 'Destination A',
      destinationId: 'destination-1',
      driverId: 'driver-1',
      estimatedArrivalAt: '2026-07-23T01:02:03.000Z',
      etaStatus: 'READY',
      latitude: 37.1234567,
      longitude: 127.1234567,
      routePlanId: 'route-plan-1',
      routeVersionId: 'route-version-1',
      sellerOrderId: 'order-1',
      sellerOrderKey: 'SO-001',
      vehicleId: 'vehicle-1',
    });
    expect(dto).not.toHaveProperty('etaInputRouteVersionId');
    expect(dto).not.toHaveProperty('etaSource');

    expect(mapDsvV1SellerOrderSummaryPage({
      items: [summaryRow('SO-001')],
      page: { hasMore: true, nextCursor: 'cursor-2' },
    })).toEqual({
      items: [expect.objectContaining({ sellerOrderKey: 'SO-001' })],
      page: { hasMore: true, nextCursor: 'cursor-2' },
    });
  });

  test('maps control, records, and management list items with deterministic shapes', () => {
    expect(mapDsvV1ControlSummary({
      assignedCount: 3,
      failedEtaCount: 1,
      pendingEtaCount: 2,
      readyEtaCount: 4,
      serviceDate: '2026-07-23',
      totalDispatchCount: 5,
      unassignedCount: 2,
    })).toEqual({
      assignedCount: 3,
      failedEtaCount: 1,
      pendingEtaCount: 2,
      readyEtaCount: 4,
      serviceDate: '2026-07-23',
      totalDispatchCount: 5,
      unassignedCount: 2,
    });

    expect(mapDsvV1Record({
      deliveryStatus: 'DELIVERED',
      destinationDisplayName: 'Front Dock',
      etaStatus: 'STALE',
      eventRows: [
        { eventType: 'STOP_DELIVERED', occurredAt: '2026-07-23T02:00:00.000Z' },
        { eventType: 'LOCATION_UPDATED', occurredAt: '2026-07-23T01:59:00.000Z' },
      ],
      proofRows: [{ deletedAt: null }],
      sellerOrderKey: 'SO-001',
    })).toEqual({
      deliveryStatus: 'DELIVERED',
      destinationDisplayName: 'Front Dock',
      etaStatus: 'STALE',
      eventSummary: [{ type: 'STOP_DELIVERED', occurredAt: '2026-07-23T02:00:00.000Z' }],
      proofStatus: 'AVAILABLE',
      sellerOrderKey: 'SO-001',
    });

    const list = mapDsvV1ManagementListPage({
      items: [
        mapDsvV1DriverListItem({ displayName: 'Driver A', driverId: 'driver-1', phone: null, status: 'ACTIVE' }),
        mapDsvV1VehicleListItem({
          displayName: 'Truck A',
          driverAssignments: [{ assignmentId: 'assignment-1', driverId: 'driver-1' }],
          telematicsCapabilities: ['LOCATION', 'TEMPERATURE', 'TACHOMETER'],
          telematicsSerialNumber: '012-5273-8978',
          vehicleId: 'vehicle-1',
          vehiclePlate: '11A1111',
          vehicleType: 'REFRIGERATED',
        }),
        mapDsvV1CustomerListItem({ customerId: 'customer-1', displayName: 'Customer A', externalCustomerCode: 'C-1' }),
        mapDsvV1DestinationListItem({ address: null, destinationId: 'destination-1', displayName: 'Dock A' }),
        mapDsvV1ConditionListItem({
          code: 'COLD',
          conditionId: 'condition-1',
          description: 'Keep refrigerated.',
          name: 'Cold',
          status: 'ACTIVE',
        }),
      ],
      page: { hasMore: false },
    });

    expect(list).toEqual({
      items: [
        { displayName: 'Driver A', driverId: 'driver-1', status: 'ACTIVE' },
        {
          displayName: 'Truck A',
          driverAssignments: [{ assignmentId: 'assignment-1', driverId: 'driver-1' }],
          telematicsCapabilities: ['LOCATION', 'TEMPERATURE', 'TACHOMETER'],
          telematicsSerialNumber: '012-5273-8978',
          vehicleId: 'vehicle-1',
          vehiclePlate: '11A1111',
          vehicleType: 'REFRIGERATED',
        },
        { customerId: 'customer-1', displayName: 'Customer A', externalCustomerCode: 'C-1' },
        { destinationId: 'destination-1', displayName: 'Dock A' },
        {
          code: 'COLD',
          conditionId: 'condition-1',
          description: 'Keep refrigerated.',
          name: 'Cold',
          status: 'ACTIVE',
        },
      ],
      page: { hasMore: false },
    });
  });

  test('derives G005 proof status exactly and never emits REDACTED', () => {
    const deletedAt = '2026-07-23T01:00:00.000Z';

    expect(deriveDsvV1ProofStatus([])).toBe('NONE');
    expect(deriveDsvV1ProofStatus([{ deletedAt }])).toBe('EXPIRED');
    expect(deriveDsvV1ProofStatus([{ deletedAt }, { deletedAt: null }])).toBe('AVAILABLE');
    expect([
      deriveDsvV1ProofStatus([]),
      deriveDsvV1ProofStatus([{ deletedAt }]),
      deriveDsvV1ProofStatus([{ deletedAt: null }]),
    ]).not.toContain('REDACTED');
  });

  test('allowlists event summaries to type and occurredAt only', () => {
    const eventRows = [
      eventRow({ eventType: 'STOP_ARRIVED', occurredAt: new Date('2026-07-23T01:00:00.000Z') }),
      eventRow({ eventType: 'PICKUP_COMPLETED', occurredAt: '2026-07-23T01:00:30.000Z' }),
      eventRow({ eventType: 'LOCATION_UPDATED', occurredAt: '2026-07-23T01:01:00.000Z' }),
      eventRow({ eventType: 'NOTE_ADDED', occurredAt: '2026-07-23T01:02:00.000Z' }),
    ];

    expect(mapDsvV1EventSummary(eventRows)).toEqual([
      { type: 'STOP_ARRIVED', occurredAt: '2026-07-23T01:00:00.000Z' },
    ]);
    expect(JSON.stringify(mapDsvV1EventSummary(eventRows))).not.toMatch(
      /latitude|longitude|payload|note|clientEventId|driverId|deliveryStopId/u
    );
  });

  test('redacts customer delivery DTOs to the frozen customer floor', () => {
    const noisyRow = customerDeliveryRow({
      eventRows: [
        eventRow({ eventType: 'STOP_DELIVERED', occurredAt: '2026-07-23T03:00:00.000Z' }),
        eventRow({ eventType: 'LOCATION_UPDATED', occurredAt: '2026-07-23T02:59:00.000Z' }),
      ],
      proofRows: [
        proofRow({ deletedAt: '2026-07-22T03:00:00.000Z' }),
        proofRow({ deletedAt: null }),
      ],
    });
    const dto = mapDsvV1CustomerDeliveryInquiryItem(noisyRow);

    expect(dto).toEqual({
      deliveryStatus: 'DELIVERED',
      destinationDisplayName: 'Shared Dock',
      estimatedArrivalAt: '2026-07-23T02:30:00.000Z',
      etaStatus: 'READY',
      eventSummary: [{ type: 'STOP_DELIVERED', occurredAt: '2026-07-23T03:00:00.000Z' }],
      proofStatus: 'AVAILABLE',
      sellerOrderKey: 'SO-REDIRECT',
    });
    expect(Object.keys(dto).sort()).toEqual([
      'deliveryStatus',
      'destinationDisplayName',
      'estimatedArrivalAt',
      'etaStatus',
      'eventSummary',
      'proofStatus',
      'sellerOrderKey',
    ]);
    expectNoForbiddenCustomerFields(dto);
  });

  test('maps customer delivery pages with stable empty reason and optional page info', () => {
    expect(mapDsvV1CustomerDeliveryInquiryPage({
      emptyReason: 'NO_DELIVERIES',
      items: [],
      page: { hasMore: false },
    })).toEqual({
      emptyReason: 'NO_DELIVERIES',
      items: [],
      page: { hasMore: false },
    });
  });
});

function summaryRow(sellerOrderKey: string) {
  return {
    assignmentStatus: 'UNASSIGNED' as const,
    customerId: 'customer-1',
    destinationId: 'destination-1',
    etaStatus: 'NOT_REQUIRED' as const,
    sellerOrderId: 'order-1',
    sellerOrderKey,
  };
}

function customerDeliveryRow(
  overrides: Partial<DsvV1CustomerDeliveryInquiryRow> = {}
): DsvV1CustomerDeliveryInquiryRow {
  return {
    auditDetails: { redactedDiff: 'do-not-emit' },
    customerId: 'other-customer-id',
    deliveryStatus: 'DELIVERED',
    destinationDisplayName: 'Shared Dock',
    driver: { privatePhone: '010-0000-0000' },
    driverId: 'driver-private-id',
    estimatedArrivalAt: '2026-07-23T02:30:00.000Z',
    etaInputRouteVersionId: 'route-version-private',
    etaSource: 'ROUTE_STARTED',
    etaStatus: 'READY',
    otherCustomerDeliveryCount: 99,
    proofRows: [],
    routePlanId: 'route-plan-private-id',
    sellerOrderId: 'seller-order-private-id',
    sellerOrderKey: 'SO-REDIRECT',
    ...overrides,
  } as DsvV1CustomerDeliveryInquiryRow;
}

function eventRow(input: { eventType: string; occurredAt: Date | string }) {
  return {
    clientEventId: 'client-event-forbidden',
    deliveryStopId: 'delivery-stop-forbidden',
    driverId: 'driver-forbidden',
    eventType: input.eventType,
    id: 'event-id-forbidden',
    latitude: '37.0000000',
    longitude: '127.0000000',
    note: 'private note',
    occurredAt: input.occurredAt,
    payload: { raw: true, storageKey: 'payload-storage-key' },
  } as unknown as DsvV1EventRowInput;
}

function proofRow(input: { deletedAt: Date | string | null }) {
  return {
    contentType: 'image/jpeg',
    deletedAt: input.deletedAt,
    hash: 'hash-forbidden',
    metadata: { raw: true },
    originalFilename: 'proof.jpg',
    sha256: 'sha-forbidden',
    signedUrl: 'https://example.invalid/proof',
    sizeBytes: 1234,
    storageKey: 'proof/storage/key',
    url: 'https://example.invalid/proof',
  } as unknown as DsvV1ProofRowInput;
}

function expectNoForbiddenCustomerFields(value: unknown): void {
  expect(JSON.stringify(value)).not.toMatch(
    /storageKey|signedUrl|url|originalFilename|contentType|sizeBytes|sha256|hash|metadata|payload|latitude|longitude|note|clientEventId|event-id|driverId|privatePhone|sellerOrderId|routePlanId|etaInputRouteVersionId|etaSource|auditDetails|redactedDiff|otherCustomer/u
  );
}
