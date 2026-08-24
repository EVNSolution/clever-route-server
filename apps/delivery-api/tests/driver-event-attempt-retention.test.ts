import { describe, expect, test, vi } from 'vitest';

import { cleanupResolvedDriverEventAttempts, parseRetentionDeadline } from '../src/modules/driver/driver-event-attempt-retention.js';

describe('driver event attempt retention', () => {
  test('treats an already exhausted shared deadline as valid continuation input', () => {
    expect(parseRetentionDeadline('1')).toBe(1);
    expect(() => parseRetentionDeadline('not-a-deadline')).toThrow('RETENTION_DEADLINE_EPOCH_MS is invalid');
  });

  test('reports continuation without starting a delete batch after the shared deadline is exhausted', async () => {
    const query = vi.fn().mockResolvedValueOnce([{ exists: true }]);
    await expect(cleanupResolvedDriverEventAttempts(
      { $queryRaw: query } as never,
      new Date('2026-08-25T00:00:00.000Z'),
      { deadlineAt: 1 }
    )).resolves.toEqual({ continuationRequired: true, deletedCount: 0 });
    expect(query).toHaveBeenCalledOnce();
  });

  test('deletes in bounded skip-locked batches and reports executable continuation', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([{ id: 'attempt-1' }])
      .mockResolvedValueOnce([{ id: 'attempt-2' }])
      .mockResolvedValueOnce([{ exists: true }]);

    await expect(cleanupResolvedDriverEventAttempts(
      { $queryRaw: query } as never,
      new Date('2026-08-25T00:00:00.000Z'),
      { batchSize: 1, maxRows: 2 }
    )).resolves.toEqual({ continuationRequired: true, deletedCount: 2 });

    expect(query).toHaveBeenCalledTimes(3);
    const sql = query.mock.calls.map(([statement]) => {
      const typedStatement = statement as { strings: readonly string[] };
      return typedStatement.strings.join(' ');
    }).join('\n');
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).toContain('ORDER BY "retainedUntil" ASC, "id" ASC');
  });

  test('stops without a continuation query after a partial batch', async () => {
    const query = vi.fn().mockResolvedValueOnce([{ id: 'attempt-1' }]);

    await expect(cleanupResolvedDriverEventAttempts(
      { $queryRaw: query } as never,
      new Date('2026-08-25T00:00:00.000Z'),
      { batchSize: 2, maxRows: 10 }
    )).resolves.toEqual({ continuationRequired: false, deletedCount: 1 });
    expect(query).toHaveBeenCalledOnce();
  });
});
