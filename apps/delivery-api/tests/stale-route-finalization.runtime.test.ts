import { afterEach, describe, expect, test, vi } from 'vitest';

import { StaleRouteFinalizationRuntime } from '../src/modules/route-plans/stale-route-finalization.runtime.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('StaleRouteFinalizationRuntime', () => {
  test('does not schedule or scan until the explicit activation flag is enabled', async () => {
    const processDue = vi.fn();
    const interval = vi.spyOn(globalThis, 'setInterval');
    const runtime = new StaleRouteFinalizationRuntime({ processDue }, false);

    runtime.start();
    await runtime.runOnce();
    await runtime.close();

    expect(processDue).not.toHaveBeenCalled();
    expect(interval).not.toHaveBeenCalled();
    interval.mockRestore();
  });

  test('waits for the first interval instead of mutating during process startup', async () => {
    vi.useFakeTimers();
    const processDue = vi.fn().mockResolvedValue({
      finalized: 0,
      inspected: 0,
      skippedConcurrent: 0,
      skippedNotDue: 0,
      skippedUnresolvableWindow: 0
    });
    const runtime = new StaleRouteFinalizationRuntime({ processDue }, true, undefined, 60_000);

    runtime.start();
    expect(processDue).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(processDue).toHaveBeenCalledTimes(1);
    await runtime.close();
  });

  test('prevents overlapping scans and waits for the active server scan on close', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const processDue = vi.fn(() => new Promise<{
      finalized: number;
      inspected: number;
      skippedConcurrent: number;
      skippedNotDue: number;
      skippedUnresolvableWindow: number;
    }>((resolve) => {
      finish = () => resolve({
        finalized: 1,
        inspected: 1,
        skippedConcurrent: 0,
        skippedNotDue: 0,
        skippedUnresolvableWindow: 0
      });
    }));
    const runtime = new StaleRouteFinalizationRuntime({ processDue }, true);

    runtime.start();
    await runtime.runOnce();
    const closing = runtime.close();
    let closed = false;
    void closing.then(() => { closed = true; });
    await Promise.resolve();

    expect(processDue).toHaveBeenCalledTimes(1);
    expect(closed).toBe(false);
    finish();
    await closing;
    expect(closed).toBe(true);
  });
});
