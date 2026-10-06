import { afterEach, describe, expect, test, vi } from 'vitest';

import { CompletionAssistanceRuntime } from '../src/modules/driver/completion-assistance.runtime.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('CompletionAssistanceRuntime', () => {
  test('does not schedule or process unless explicitly enabled', async () => {
    const processDue = vi.fn().mockResolvedValue(0);
    const interval = vi.spyOn(globalThis, 'setInterval');
    const runtime = new CompletionAssistanceRuntime({ processDue }, false);

    runtime.start();
    await runtime.runOnce();
    await runtime.close();

    expect(processDue).not.toHaveBeenCalled();
    expect(interval).not.toHaveBeenCalled();
    interval.mockRestore();
  });

  test('prevents overlapping scans and waits for an in-flight scan on close', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const processDue = vi.fn(() => new Promise<number>((resolve) => {
      finish = () => resolve(1);
    }));
    const runtime = new CompletionAssistanceRuntime({ processDue }, true);

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
