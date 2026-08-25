import { describe, expect, test, vi } from 'vitest';
import { cleanupReviewedRouteCompletionEvidence } from '../src/modules/driver/driver-route-completion-review-retention.js';

describe('driver route completion review retention', () => {
  test('deletes only expired reviewed evidence and leaves unreviewed cases open', async () => {
    const queryRaw = vi.fn()
      .mockResolvedValueOnce([{ id: 'review-id' }])
      .mockResolvedValueOnce([]);

    await expect(cleanupReviewedRouteCompletionEvidence({ $queryRaw: queryRaw } as never, new Date('2027-08-26T00:00:00.000Z')))
      .resolves.toEqual({ continuationRequired: false, deletedCount: 1 });

    const calls = queryRaw.mock.calls as unknown as Array<[{ strings: readonly string[] }]>;
    const sql = calls.map(([query]) => query.strings.join('?')).join('\n');
    expect(sql).toContain('"reviewedAt" IS NOT NULL AND "retainedUntil" <');
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).not.toContain('"reviewedAt" IS NULL');
  });
});
