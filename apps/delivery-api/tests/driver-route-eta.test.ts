import { describe, expect, test } from 'vitest';

import {
  calculateArrivalEtaUpdate,
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
});
