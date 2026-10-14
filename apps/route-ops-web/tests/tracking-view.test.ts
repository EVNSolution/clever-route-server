import { describe, expect, test } from 'vitest';

import { formatEtaWindow, isFinalStage, reachedStep, trackingHeadline } from '../src/tracking/trackingView';

describe('customer tracking view', () => {
  test('formats the ETA window in the route timezone', () => {
    expect(formatEtaWindow({ end: '2026-10-14T06:00:00.000Z', start: '2026-10-14T05:00:00.000Z' }, 'Asia/Seoul'))
      .toBe('Wed, Oct 14, 2:00 PM – 3:00 PM');
    expect(formatEtaWindow({ end: '2026-10-15T00:30:00.000Z', start: '2026-10-14T23:30:00.000Z' }, 'UTC'))
      .toBe('Wed, Oct 14, 11:30 PM – Thu, Oct 15, 12:30 AM');
  });

  test('describes each stage and how far the driver is', () => {
    expect(trackingHeadline({ stage: 'ON_THE_WAY', stopsAway: 2, storeName: 'K-Food' }))
      .toEqual({ detail: 'Your driver is 2 stops away.', title: 'Your order is on the way' });
    expect(trackingHeadline({ stage: 'ON_THE_WAY', stopsAway: 0, storeName: 'K-Food' }).detail).toBe('Your driver is arriving now.');
    expect(trackingHeadline({ stage: 'MISSED', stopsAway: null, storeName: 'K-Food' }).detail).toBe('Please contact K-Food to reschedule.');
    expect([reachedStep('PREPARING'), reachedStep('ON_THE_WAY'), reachedStep('DELIVERED'), reachedStep('MISSED')]).toEqual([0, 1, 2, -1]);
    expect([isFinalStage('ON_THE_WAY'), isFinalStage('DELIVERED'), isFinalStage('CANCELLED')]).toEqual([false, true, true]);
  });
});
