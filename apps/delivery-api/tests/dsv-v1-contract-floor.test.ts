import { describe, expect, test } from 'vitest';

import {
  dsvV1ApiVersion,
  dsvV1CustomerDeliveryRequiredFields,
  dsvV1EmittedProofStatuses,
  dsvV1ErrorCodes,
  dsvV1EtaStatuses,
  dsvV1ProofStatuses,
  dsvV1SellerOrderSummaryRequiredFields,
  dsvV1SessionRequiredFields,
  mapDsvV1CustomerDeliveryInquiryItem,
  mapDsvV1SellerOrderSummary,
  mapDsvV1SessionPrincipal,
  toDsvV1ErrorEnvelope,
  toDsvV1SuccessEnvelope,
} from '../src/modules/dsv/dsv-v1-read.dto.js';

describe('G005 DSV v1 OpenAPI contract floor', () => {
  test('freezes success and error envelope structural floors', () => {
    expect(dsvV1ApiVersion).toBe('dsv.v1');
    expect(Object.keys(toDsvV1SuccessEnvelope({ items: [] }, 'req-floor')).sort()).toEqual([
      'data',
      'meta',
      'requestId',
    ]);
    expect(toDsvV1SuccessEnvelope({ items: [] }, 'req-floor').meta).toEqual({ apiVersion: 'dsv.v1' });

    const error = toDsvV1ErrorEnvelope({
      code: 'UNAUTHENTICATED',
      message: 'Authentication required.',
      requestId: 'req-error',
    });

    expect(Object.keys(error)).toEqual(['error']);
    expect(Object.keys(error.error).sort()).toEqual(['code', 'message', 'requestId']);
    expect(dsvV1ErrorCodes).toEqual([
      'BAD_REQUEST',
      'UNAUTHENTICATED',
      'FORBIDDEN',
      'NOT_FOUND',
      'SELLER_ORDER_ASSIGNMENT_CHANGED',
      'VERSION_CONFLICT',
      'SELLER_ORDER_ALREADY_ACQUIRED',
      'COMMAND_IN_PROGRESS',
      'IDEMPOTENCY_PAYLOAD_MISMATCH',
      'VALIDATION_FAILED',
      'DEPENDENCY_UNAVAILABLE',
    ]);
  });

  test('freezes session, ETA, proof, and emitted proof enum floors', () => {
    expect(dsvV1SessionRequiredFields).toEqual(['csrfToken', 'principalType', 'shopId', 'scopes']);
    expect(dsvV1EtaStatuses).toEqual(['NOT_REQUIRED', 'PENDING', 'READY', 'FAILED', 'STALE']);
    expect(dsvV1ProofStatuses).toEqual(['NONE', 'AVAILABLE', 'REDACTED', 'EXPIRED']);
    expect(dsvV1EmittedProofStatuses).toEqual(['NONE', 'AVAILABLE', 'EXPIRED']);

    const dto = mapDsvV1SessionPrincipal({
      principalType: 'DSV_ADMIN',
      scopes: ['dsv:session:read'],
      shopId: 'shop-1',
    }, 'csrf-1');

    for (const key of dsvV1SessionRequiredFields) {
      expect(dto).toHaveProperty(key);
    }
  });

  test('freezes seller order summary required shape and ETA serialization floor', () => {
    const dto = mapDsvV1SellerOrderSummary({
      assignmentStatus: 'ASSIGNED',
      customerId: 'customer-1',
      deliveryStopId: 'delivery-stop-1',
      destinationId: 'destination-1',
      estimatedArrivalAt: '2026-07-23T02:30:00.000Z',
      etaStatus: 'READY',
      routePlanId: 'route-plan-1',
      routeVersionId: 'route-version-1',
      sellerOrderId: 'seller-order-1',
      sellerOrderKey: 'SO-001',
    });

    expect(dsvV1SellerOrderSummaryRequiredFields).toEqual([
      'sellerOrderId',
      'sellerOrderKey',
      'deliveryStopId',
      'customerId',
      'destinationId',
      'assignmentStatus',
      'etaStatus',
      'eventSummary',
    ]);
    for (const key of dsvV1SellerOrderSummaryRequiredFields) {
      expect(dto).toHaveProperty(key);
    }
    expect(dto).toEqual({
      assignmentStatus: 'ASSIGNED',
      customerId: 'customer-1',
      deliveryStopId: 'delivery-stop-1',
      destinationId: 'destination-1',
      estimatedArrivalAt: '2026-07-23T02:30:00.000Z',
      etaStatus: 'READY',
      eventSummary: [],
      routePlanId: 'route-plan-1',
      routeVersionId: 'route-version-1',
      sellerOrderId: 'seller-order-1',
      sellerOrderKey: 'SO-001',
    });
  });

  test('freezes customer delivery inquiry required shape and redacted public event floor', () => {
    const dto = mapDsvV1CustomerDeliveryInquiryItem({
      deliveryStatus: 'DELIVERED',
      destinationDisplayName: 'Dock A',
      destinationId: 'destination-1',
      estimatedArrivalAt: new Date('2026-07-23T02:30:00.000Z'),
      etaInputRouteVersionId: 'private-route-version',
      etaSource: 'ROUTE_STARTED',
      etaStatus: 'READY',
      eventRows: [
        { eventType: 'STOP_DELIVERED', occurredAt: '2026-07-23T03:00:00.000Z' },
        { eventType: 'LOCATION_UPDATED', occurredAt: '2026-07-23T02:59:00.000Z' },
      ],
      proofRows: [{ deletedAt: '2026-07-22T00:00:00.000Z' }],
      sellerOrderId: 'seller-order-1',
      sellerOrderKey: 'SO-001',
      shippedBoxes: 3,
    });

    expect(dsvV1CustomerDeliveryRequiredFields).toEqual([
      'sellerOrderId',
      'sellerOrderKey',
      'destinationId',
      'destinationDisplayName',
      'shippedBoxes',
      'deliveryStatus',
      'etaStatus',
      'eventSummary',
      'proofStatus',
    ]);
    for (const key of dsvV1CustomerDeliveryRequiredFields) {
      expect(dto).toHaveProperty(key);
    }
    expect(dto).toEqual({
      deliveryStatus: 'DELIVERED',
      destinationDisplayName: 'Dock A',
      destinationId: 'destination-1',
      estimatedArrivalAt: '2026-07-23T02:30:00.000Z',
      etaStatus: 'READY',
      eventSummary: [{ type: 'STOP_DELIVERED', occurredAt: '2026-07-23T03:00:00.000Z' }],
      proofStatus: 'EXPIRED',
      sellerOrderId: 'seller-order-1',
      sellerOrderKey: 'SO-001',
      shippedBoxes: 3,
    });
    expect(Object.keys(dto.eventSummary[0] ?? {}).sort()).toEqual(['occurredAt', 'type']);
    expect(JSON.stringify(dto)).not.toMatch(/REDACTED|LOCATION_UPDATED|etaInputRouteVersionId|etaSource/u);
  });
});
