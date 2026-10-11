import { describe, expect, test } from 'vitest';

import { DEFAULT_SERVICE_MINUTES, resolveStopServiceTime } from '../src/modules/route-plans/stop-service-time.js';

const stop = (serviceMinutes: number, serviceMinutesSource: string | null) => ({ serviceMinutes, serviceMinutesSource });

describe('Stop time precedence', () => {
  test('keeps a time the office chose on the stop or gave the whole route, whatever the driver average is', () => {
    for (const source of ['STOP', 'ROUTE']) {
      for (const average of [null, 3, 5, 12]) {
        expect(resolveStopServiceTime(stop(9, source), average)).toEqual(stop(9, source));
        expect(resolveStopServiceTime(stop(5, source), average)).toEqual(stop(5, source));
        expect(resolveStopServiceTime(stop(0, source), average)).toEqual(stop(0, source));
      }
    }
  });

  test('keeps a time that is not the default and has no source, because it was imported or typed before sources were recorded', () => {
    for (const average of [null, 3, 12]) {
      expect(resolveStopServiceTime(stop(8, null), average)).toEqual(stop(8, null));
      expect(resolveStopServiceTime(stop(0, null), average)).toEqual(stop(0, null));
    }
  });

  test('gives a stop nobody chose the driver average, and marks where it came from', () => {
    expect(resolveStopServiceTime(stop(5, null), 7)).toEqual(stop(7, 'DRIVER'));
    expect(resolveStopServiceTime(stop(5, null), 0)).toEqual(stop(0, 'DRIVER'));
    expect(resolveStopServiceTime(stop(5, null), 5)).toEqual(stop(5, 'DRIVER'));
  });

  test('follows a changed, removed or missing driver average for stops that took one', () => {
    expect(resolveStopServiceTime(stop(7, 'DRIVER'), 9)).toEqual(stop(9, 'DRIVER'));
    expect(resolveStopServiceTime(stop(7, 'DRIVER'), 7)).toEqual(stop(7, 'DRIVER'));
    expect(resolveStopServiceTime(stop(7, 'DRIVER'), null)).toEqual(stop(DEFAULT_SERVICE_MINUTES, null));
  });

  test('leaves a default stop alone when there is no driver average', () => {
    expect(resolveStopServiceTime(stop(5, null), null)).toEqual(stop(5, null));
  });
});
