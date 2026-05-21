import { describe, expect, test, vi } from 'vitest';

import { PrismaDriverProofMediaCleanupMonitor } from '../src/modules/driver/driver-proof-media-retention-job.repository.js';

describe('PrismaDriverProofMediaCleanupMonitor', () => {
  test('persists sanitized proof-media cleanup run evidence', async () => {
    const create = vi.fn(() => Promise.resolve({ id: 'run-id' }));
    const monitor = new PrismaDriverProofMediaCleanupMonitor(
      { retentionJobRun: { create } } as never,
      { evidenceRef: 'private-evidence://driver-proof-media/cleanup/2026-05-13' }
    );
    const deletedAt = new Date('2026-05-13T00:00:00.000Z');
    const uploadedBefore = new Date('2025-11-14T00:00:00.000Z');

    await monitor.recordProofMediaCleanup({
      deleted: 2,
      deletedAt,
      limit: 50,
      missingFiles: 1,
      retentionDays: 180,
      scanned: 3,
      uploadedBefore
    });

    expect(create).toHaveBeenCalledWith({
      data: {
        batchLimit: 50,
        deletedCount: 2,
        evidenceRef: 'private-evidence://driver-proof-media/cleanup/2026-05-13',
        finishedAt: deletedAt,
        jobName: 'driver-proof-media-retention-cleanup',
        missingFilesCount: 1,
        retentionDays: 180,
        scannedCount: 3,
        startedAt: deletedAt,
        status: 'SUCCEEDED',
        uploadedBefore
      }
    });

    const persistedData = (create.mock.calls as unknown as [{ data: Record<string, unknown> }][])[0]?.[0].data;
    expect(persistedData).toBeDefined();
    expect(persistedData).not.toHaveProperty('mediaId');
    expect(persistedData).not.toHaveProperty('storageKey');
    expect(persistedData).not.toHaveProperty('fileBytes');
    expect(persistedData).not.toHaveProperty('proofImage');
  });

  test('omits empty private evidence references instead of storing blank strings', async () => {
    const create = vi.fn(() => Promise.resolve({ id: 'run-id' }));
    const monitor = new PrismaDriverProofMediaCleanupMonitor(
      { retentionJobRun: { create } } as never,
      { evidenceRef: '   ' }
    );
    const deletedAt = new Date('2026-05-13T00:00:00.000Z');

    await monitor.recordProofMediaCleanup({
      deleted: 0,
      deletedAt,
      limit: null,
      missingFiles: 0,
      retentionDays: 180,
      scanned: 0,
      uploadedBefore: new Date('2025-11-14T00:00:00.000Z')
    });

    const persistedData = (create.mock.calls as unknown as [{ data: Record<string, unknown> }][])[0]?.[0].data;
    expect(persistedData).toBeDefined();
    expect(persistedData).not.toHaveProperty('evidenceRef');
  });
});
