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

  test('expires every LOCATION_UPDATED attempt status without limiting the driver contract version', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([{ id: 'expired-location-attempt' }])
      .mockResolvedValueOnce([{ exists: true }]);
    const cutoff = new Date('2026-08-25T00:00:00.000Z');

    await cleanupResolvedDriverEventAttempts(
      { $queryRaw: query } as never,
      cutoff,
      { batchSize: 1, maxRows: 1 }
    );

    const deleteSql = sqlText(query.mock.calls[0]?.[0]);
    expect(deleteSql).toMatch(/"retainedUntil" < .*AND \(\s*"eventType" = 'LOCATION_UPDATED'\s*OR "status" IN \('APPLIED', 'DUPLICATE'\)/su);
    expect(deleteSql).not.toContain('driverContractVersion');
    expect(sqlValues(query.mock.calls[0]?.[0])).toContain(cutoff);
  });

  test('keeps the business-event evidence safeguards and reuses the same expiry rule for continuation', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([{ id: 'expired-attempt' }])
      .mockResolvedValueOnce([{ exists: true }]);

    await cleanupResolvedDriverEventAttempts(
      { $queryRaw: query } as never,
      new Date('2026-08-25T00:00:00.000Z'),
      { batchSize: 1, maxRows: 1 }
    );

    const deletePredicate = cleanupPredicate(sqlText(query.mock.calls[0]?.[0]));
    const continuationPredicate = cleanupPredicate(sqlText(query.mock.calls[1]?.[0]));
    expect(continuationPredicate).toBe(deletePredicate);
    expect(deletePredicate).toContain('"status" IN (\'APPLIED\', \'DUPLICATE\')');
    expect(deletePredicate).toContain('("status" = \'REJECTED\' AND "reconciledAt" IS NOT NULL)');
    expect(deletePredicate).not.toMatch(/"status"\s+IN\s+\([^)]*'ACCEPTED'|"status"\s+IN\s+\([^)]*'FAILED'/u);
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

function sqlText(statement: unknown): string {
  return (statement as { strings: readonly string[] }).strings.join(' ').replace(/\s+/gu, ' ').trim();
}

function sqlValues(statement: unknown): readonly unknown[] {
  return (statement as { values: readonly unknown[] }).values;
}

function cleanupPredicate(sql: string): string {
  const match = sql.match(/"retainedUntil" < .*?AND \(.*?\) (?=ORDER BY|\) AS "exists")/u);
  if (match === null) throw new Error(`Cleanup predicate not found in SQL: ${sql}`);
  return match[0].replace(/\$\d+/gu, '$cutoff');
}
