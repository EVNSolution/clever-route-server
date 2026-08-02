import { describe, expect, test } from 'vitest';

import {
  buildDriverRouteEtaSnapshot,
  calculateArrivalEtaUpdate,
  calculateCompletionEtaUpdate,
  calculatePickupEtaUpdate,
  calculateRouteStartEtaUpdate
} from '../src/modules/driver/driver-route-eta.js';

const stops = [
  {
    deliveryStopId: 'stop-1',
    durationFromPreviousSeconds: 600,
    estimatedArrivalAt: null,
    sequence: 1,
    serviceMinutes: 5
  },
  {
    deliveryStopId: 'stop-2',
    durationFromPreviousSeconds: 900,
    estimatedArrivalAt: null,
    sequence: 2,
    serviceMinutes: 5
  },
  {
    deliveryStopId: 'stop-3',
    durationFromPreviousSeconds: 300,
    estimatedArrivalAt: null,
    sequence: 3,
    serviceMinutes: 5
  }
];

describe('driver route ETA', () => {
  test('builds the initial ETA chain from the authoritative server route-start time', () => {
    const update = calculateRouteStartEtaUpdate({
      serverReceivedAt: new Date('2026-07-20T10:00:00.000Z'),
      stops
    });

    expect(update).toEqual({
      actualArrivalAt: null,
      deliveryStopId: null,
      delaySeconds: null,
      etaCalculatedAt: '2026-07-20T10:00:00.000Z',
      etaFailureCode: null,
      etaFailureMessage: null,
      etaSource: 'ROUTE_STARTED',
      etaStatus: 'READY',
      inputRouteVersionId: null,
      previousEstimatedArrivalAt: null,
      serverReceivedAt: '2026-07-20T10:00:00.000Z',
      trigger: 'ROUTE_STARTED',
      updatedStops: [
        { deliveryStopId: 'stop-1', estimatedArrivalAt: '2026-07-20T10:10:00.000Z', sequence: 1 },
        { deliveryStopId: 'stop-2', estimatedArrivalAt: '2026-07-20T10:30:00.000Z', sequence: 2 },
        { deliveryStopId: 'stop-3', estimatedArrivalAt: '2026-07-20T10:40:00.000Z', sequence: 3 }
      ]
    });
  });

  test('shifts only future stop ETAs from the actual server arrival time', () => {
    const update = calculateArrivalEtaUpdate({
      arrivedDeliveryStopId: 'stop-1',
      serverReceivedAt: new Date('2026-07-20T10:17:00.000Z'),
      stops: [
        { ...stops[0]!, estimatedArrivalAt: new Date('2026-07-20T10:10:00.000Z') },
        { ...stops[1]!, estimatedArrivalAt: new Date('2026-07-20T10:30:00.000Z') },
        { ...stops[2]!, estimatedArrivalAt: new Date('2026-07-20T10:40:00.000Z') }
      ]
    });

    expect(update).toEqual({
      actualArrivalAt: '2026-07-20T10:17:00.000Z',
      deliveryStopId: 'stop-1',
      delaySeconds: 420,
      etaCalculatedAt: '2026-07-20T10:17:00.000Z',
      etaFailureCode: null,
      etaFailureMessage: null,
      etaSource: 'STOP_ARRIVED',
      etaStatus: 'READY',
      inputRouteVersionId: null,
      previousEstimatedArrivalAt: '2026-07-20T10:10:00.000Z',
      serverReceivedAt: '2026-07-20T10:17:00.000Z',
      trigger: 'STOP_ARRIVED',
      updatedStops: [
        { deliveryStopId: 'stop-2', estimatedArrivalAt: '2026-07-20T10:37:00.000Z', sequence: 2 },
        { deliveryStopId: 'stop-3', estimatedArrivalAt: '2026-07-20T10:47:00.000Z', sequence: 3 }
      ]
    });
  });

  test('supports an early arrival and nulls downstream ETAs when a leg duration is unavailable', () => {
    const update = calculateArrivalEtaUpdate({
      arrivedDeliveryStopId: 'stop-2',
      serverReceivedAt: new Date('2026-07-20T10:34:00.000Z'),
      stops: [
        { ...stops[0]!, estimatedArrivalAt: new Date('2026-07-20T10:10:00.000Z') },
        { ...stops[1]!, estimatedArrivalAt: new Date('2026-07-20T10:37:00.000Z') },
        { ...stops[2]!, durationFromPreviousSeconds: null, estimatedArrivalAt: new Date('2026-07-20T10:47:00.000Z') }
      ]
    });

    expect(update.delaySeconds).toBe(-180);
    expect(update.updatedStops).toEqual([
      { deliveryStopId: 'stop-3', estimatedArrivalAt: null, sequence: 3 }
    ]);
  });

  test('shifts only future stop ETAs from the server-confirmed completion time', () => {
    const update = calculateCompletionEtaUpdate({
      completedDeliveryStopId: 'stop-1',
      serverReceivedAt: new Date('2026-07-20T10:25:00.000Z'),
      stops: [
        { ...stops[0]!, estimatedArrivalAt: new Date('2026-07-20T10:10:00.000Z') },
        { ...stops[1]!, estimatedArrivalAt: new Date('2026-07-20T10:30:00.000Z') },
        { ...stops[2]!, estimatedArrivalAt: new Date('2026-07-20T10:40:00.000Z') }
      ]
    });

    expect(update).toEqual({
      actualArrivalAt: null,
      deliveryStopId: 'stop-1',
      delaySeconds: 600,
      etaCalculatedAt: '2026-07-20T10:25:00.000Z',
      etaFailureCode: null,
      etaFailureMessage: null,
      etaSource: 'STOP_DELIVERED',
      etaStatus: 'READY',
      inputRouteVersionId: null,
      previousEstimatedArrivalAt: '2026-07-20T10:10:00.000Z',
      serverReceivedAt: '2026-07-20T10:25:00.000Z',
      trigger: 'STOP_DELIVERED',
      updatedStops: [
        { deliveryStopId: 'stop-2', estimatedArrivalAt: '2026-07-20T10:40:00.000Z', sequence: 2 },
        { deliveryStopId: 'stop-3', estimatedArrivalAt: '2026-07-20T10:50:00.000Z', sequence: 3 }
      ]
    });
  });

  test('builds pickup ETA from the authoritative server receipt time and sorts stops', () => {
    const update = calculatePickupEtaUpdate({
      serverReceivedAt: new Date('2026-07-20T11:00:00.000Z'),
      stops: [stops[1]!, stops[0]!]
    });

    expect(update.trigger).toBe('PICKUP_COMPLETED');
    expect(update.etaSource).toBe('PICKUP_COMPLETED');
    expect(update.serverReceivedAt).toBe('2026-07-20T11:00:00.000Z');
    expect(update.updatedStops).toEqual([
      { deliveryStopId: 'stop-1', estimatedArrivalAt: '2026-07-20T11:10:00.000Z', sequence: 1 },
      { deliveryStopId: 'stop-2', estimatedArrivalAt: '2026-07-20T11:30:00.000Z', sequence: 2 }
    ]);
  });

  test('derives a READY pickup snapshot with distance and final service time completion', () => {
    const snapshot = buildDriverRouteEtaSnapshot({
      pickupCompletedAt: new Date('2026-07-20T11:00:00.000Z'),
      stops: [
        {
          ...stops[0]!,
          distanceFromPreviousMeters: 1000,
          etaCalculatedAt: new Date('2026-07-20T11:00:00.000Z'),
          estimatedArrivalAt: new Date('2026-07-20T11:10:00.000Z')
        },
        {
          ...stops[1]!,
          distanceFromPreviousMeters: 2000,
          etaCalculatedAt: new Date('2026-07-20T11:00:00.000Z'),
          estimatedArrivalAt: new Date('2026-07-20T11:30:00.000Z')
        }
      ]
    });

    expect(snapshot).toEqual({
      calculatedAt: '2026-07-20T11:00:00.000Z',
      failureCode: null,
      failureMessage: null,
      nextStopEta: {
        deliveryStopId: 'stop-1',
        distanceFromPreviousMeters: 1000,
        estimatedArrivalAt: '2026-07-20T11:10:00.000Z',
        sequence: 1
      },
      pickupCompletedAt: '2026-07-20T11:00:00.000Z',
      remainingRouteEta: {
        distanceMeters: 3000,
        estimatedCompletionAt: '2026-07-20T11:35:00.000Z'
      },
      status: 'READY'
    });
  });

  test('keeps READY when only distance is missing and returns null distance labels', () => {
    const snapshot = buildDriverRouteEtaSnapshot({
      pickupCompletedAt: new Date('2026-07-20T11:00:00.000Z'),
      stops: [
        {
          ...stops[0]!,
          distanceFromPreviousMeters: null,
          etaCalculatedAt: new Date('2026-07-20T11:00:00.000Z'),
          estimatedArrivalAt: new Date('2026-07-20T11:10:00.000Z')
        }
      ]
    });

    expect(snapshot.status).toBe('READY');
    expect(snapshot.nextStopEta?.distanceFromPreviousMeters).toBeNull();
    expect(snapshot.remainingRouteEta?.distanceMeters).toBeNull();
  });

  test('derives exact pre-pickup and failed snapshot null semantics', () => {
    expect(buildDriverRouteEtaSnapshot({ pickupCompletedAt: null, stops })).toEqual({
      calculatedAt: null,
      failureCode: null,
      failureMessage: null,
      nextStopEta: null,
      pickupCompletedAt: null,
      remainingRouteEta: null,
      status: 'PRE_PICKUP'
    });

    expect(buildDriverRouteEtaSnapshot({
      pickupCompletedAt: new Date('2026-07-20T11:00:00.000Z'),
      stops: [{
        ...stops[0]!,
        distanceFromPreviousMeters: 1000,
        etaCalculatedAt: new Date('2026-07-20T11:00:00.000Z'),
        estimatedArrivalAt: null
      }]
    })).toEqual({
      calculatedAt: '2026-07-20T11:00:00.000Z',
      failureCode: 'ETA_INPUT_DURATION_UNAVAILABLE',
      failureMessage: 'ETA could not be calculated because route leg durations are unavailable.',
      nextStopEta: {
        deliveryStopId: 'stop-1',
        distanceFromPreviousMeters: 1000,
        estimatedArrivalAt: null,
        sequence: 1
      },
      pickupCompletedAt: '2026-07-20T11:00:00.000Z',
      remainingRouteEta: {
        distanceMeters: 1000,
        estimatedCompletionAt: null
      },
      status: 'FAILED'
    });
  });
});
