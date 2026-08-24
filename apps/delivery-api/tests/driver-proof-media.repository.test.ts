import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, test, vi } from 'vitest';

import {
  PrismaDriverProofMediaRepository,
  type DriverProofMediaStorageBackend
} from '../src/modules/driver/driver-proof-media.repository.js';
import { ROUTE_DRIVER_VISIBLE_STATUSES } from '../src/modules/route-plans/route-plan-lifecycle.js';

const uploadBytes = Buffer.from('synthetic-proof-photo');
const now = new Date('2026-05-12T10:00:00.000Z');

describe('PrismaDriverProofMediaRepository', () => {
  test('stores scoped proof media bytes and metadata for the token driver route stop', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'clever-proof-media-'));
    const { prisma } = createPrismaHarness();
    const repository = new PrismaDriverProofMediaRepository(prisma as never, {
      createMediaId: () => '11111111-1111-4111-8111-111111111111',
      now: () => now,
      storageRoot
    });

    const result = await repository.storeProofMedia({
      contentType: 'image/jpeg',
      deliveryStopId: 'stop-id',
      driverId: 'driver-id',
      fileBytes: uploadBytes,
      filename: 'proof.jpg',
      routePlanId: 'route-plan-id',
      shopDomain: 'Dev1.TomatonoFood.com',
      shopId: 'shop-id',
      source: 'camera'
    });

    expect(prisma.routePlan.findFirst).toHaveBeenCalledWith({
      where: {
        driverId: 'driver-id',
        id: 'route-plan-id',
        shopId: 'shop-id',
        status: { in: [...ROUTE_DRIVER_VISIBLE_STATUSES] }
      }
    });
    expect(prisma.routePlanStop.findUnique).toHaveBeenCalledWith({
      where: {
        routePlanId_deliveryStopId: {
          deliveryStopId: 'stop-id',
          routePlanId: 'route-plan-id'
        }
      }
    });
    expect(prisma.driverProofMedia.create).toHaveBeenCalledWith({
      data: {
        contentType: 'image/jpeg',
        deliveryStopId: 'stop-id',
        driverId: 'driver-id',
        id: '11111111-1111-4111-8111-111111111111',
        kind: 'PHOTO',
        originalFilename: 'proof.jpg',
        routePlanId: 'route-plan-id',
        sha256: 'dad2f603ccde777ba84635fb7bea4cea8f2d1147e59fd02f74cbd720a9bd15c7',
        shopId: 'shop-id',
        sizeBytes: uploadBytes.byteLength,
        source: 'CAMERA',
        storageKey: 'driver-proof/dev1.tomatonofood.com/route-plan-id/stop-id/11111111-1111-4111-8111-111111111111.jpg',
        uploadStatus: 'PENDING_UPLOAD',
        uploadedAt: now
      }
    });
    await expect(
      readFile(join(storageRoot, 'driver-proof/dev1.tomatonofood.com/route-plan-id/stop-id/11111111-1111-4111-8111-111111111111.jpg'))
    ).resolves.toEqual(uploadBytes);
    expect(result).toEqual({
      contentType: 'image/jpeg',
      kind: 'photo',
      mediaId: '11111111-1111-4111-8111-111111111111',
      sha256: 'dad2f603ccde777ba84635fb7bea4cea8f2d1147e59fd02f74cbd720a9bd15c7',
      sizeBytes: uploadBytes.byteLength,
      source: 'camera',
      storageKey: 'driver-proof/dev1.tomatonofood.com/route-plan-id/stop-id/11111111-1111-4111-8111-111111111111.jpg',
      uploadedAt: '2026-05-12T10:00:00.000Z'
    });
  });

  test('strips JPEG EXIF metadata before writing proof media bytes and metadata', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'clever-proof-media-'));
    const { prisma } = createPrismaHarness();
    const repository = new PrismaDriverProofMediaRepository(prisma as never, {
      createMediaId: () => '11111111-1111-4111-8111-111111111111',
      now: () => now,
      storageRoot
    });
    const fileBytes = jpegWithExifBytes();
    const sanitizedBytes = jpegWithoutExifBytes();

    const result = await repository.storeProofMedia({
      contentType: 'image/jpeg',
      deliveryStopId: 'stop-id',
      driverId: 'driver-id',
      fileBytes,
      filename: 'proof-with-exif.jpg',
      routePlanId: 'route-plan-id',
      shopDomain: 'tomatono.myshopify.com',
      shopId: 'shop-id',
      source: 'library'
    });

    const storageKey = 'driver-proof/tomatono.myshopify.com/route-plan-id/stop-id/11111111-1111-4111-8111-111111111111.jpg';
    const sanitizedSha256 = sha256Hex(sanitizedBytes);
    expect(prisma.driverProofMedia.create).toHaveBeenCalledWith({
      data: {
        contentType: 'image/jpeg',
        deliveryStopId: 'stop-id',
        driverId: 'driver-id',
        id: '11111111-1111-4111-8111-111111111111',
        kind: 'PHOTO',
        originalFilename: 'proof-with-exif.jpg',
        routePlanId: 'route-plan-id',
        sha256: sanitizedSha256,
        shopId: 'shop-id',
        sizeBytes: sanitizedBytes.byteLength,
        source: 'LIBRARY',
        storageKey,
        uploadStatus: 'PENDING_UPLOAD',
        uploadedAt: now
      }
    });
    await expect(readFile(join(storageRoot, ...storageKey.split('/')))).resolves.toEqual(sanitizedBytes);
    expect(result).toEqual(expect.objectContaining({
      sha256: sanitizedSha256,
      sizeBytes: sanitizedBytes.byteLength,
      source: 'library',
      storageKey
    }));
    expect(sanitizedBytes.includes(Buffer.from('Exif'))).toBe(false);
    expect(fileBytes.includes(Buffer.from('Exif'))).toBe(true);
  });

  test('writes sanitized proof media through an injected storage backend', async () => {
    const writes: { fileBytes: Buffer; storageKey: string }[] = [];
    const storage: DriverProofMediaStorageBackend = {
      remove: () => Promise.resolve('removed'),
      write: (input) => {
        writes.push(input);
        return Promise.resolve();
      }
    };
    const { prisma } = createPrismaHarness();
    const repository = new PrismaDriverProofMediaRepository(prisma as never, {
      createMediaId: () => '11111111-1111-4111-8111-111111111111',
      now: () => now,
      storage
    });
    const sanitizedBytes = jpegWithoutExifBytes();

    await repository.storeProofMedia({
      contentType: 'image/jpeg',
      deliveryStopId: 'stop-id',
      driverId: 'driver-id',
      fileBytes: jpegWithExifBytes(),
      filename: 'proof-with-exif.jpg',
      routePlanId: 'route-plan-id',
      shopDomain: 'tomatono.myshopify.com',
      shopId: 'shop-id',
      source: 'camera'
    });

    expect(writes).toEqual([
      {
        fileBytes: sanitizedBytes,
        storageKey: 'driver-proof/tomatono.myshopify.com/route-plan-id/stop-id/11111111-1111-4111-8111-111111111111.jpg'
      }
    ]);
  });

  test('does not write proof bytes when the durable upload reservation fails', async () => {
    const remove = vi.fn(() => Promise.resolve('removed' as const));
    const write = vi.fn(() => Promise.resolve());
    const storage: DriverProofMediaStorageBackend = {
      remove,
      write
    };
    const { prisma } = createPrismaHarness({ createProofMediaError: new Error('database unavailable') });
    const repository = new PrismaDriverProofMediaRepository(prisma as never, {
      createMediaId: () => '11111111-1111-4111-8111-111111111111',
      now: () => now,
      storage
    });

    await expect(repository.storeProofMedia(proofMediaInput())).rejects.toThrow('database unavailable');
    expect(write).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  test('logs sanitized evidence and retains the reservation when storage cleanup fails', async () => {
    const errorLogs: Array<{ details: Record<string, unknown>; message: string }> = [];
    const storage: DriverProofMediaStorageBackend = {
      remove: vi.fn(() => Promise.reject(new Error('DELETE https://private-bucket.invalid/proof?token=secret-value'))),
      write: vi.fn(() => Promise.reject(new Error('upload failed for private-customer@example.invalid')))
    };
    const { prisma } = createPrismaHarness();
    const repository = new PrismaDriverProofMediaRepository(prisma as never, {
      cleanupLogger: {
        error: (details: Record<string, unknown>, message: string) => errorLogs.push({ details, message })
      },
      createMediaId: () => '11111111-1111-4111-8111-111111111111',
      now: () => now,
      storage
    });

    await expect(repository.storeProofMedia(proofMediaInput())).rejects.toThrow('upload failed');
    expect(errorLogs).toEqual([{
      details: {
        cleanupErrorCode: 'ERROR',
        event: 'driver_proof_media_orphan_cleanup_failed',
        mediaId: '11111111-1111-4111-8111-111111111111',
        storageErrorCode: 'ERROR'
      },
      message: 'Failed to remove unfinalized proof media after storage failure'
    }]);
    expect(prisma.driverProofMedia.deleteMany).not.toHaveBeenCalled();
    const serializedLogs = JSON.stringify(errorLogs);
    expect(serializedLogs).not.toContain('private-bucket.invalid');
    expect(serializedLogs).not.toContain('secret-value');
    expect(serializedLogs).not.toContain('private-customer@example.invalid');
    expect(serializedLogs).not.toContain('storageKey');
  });

  test('aborts storage writes before the cleanup lease and removes the pending reservation', async () => {
    const remove = vi.fn(() => Promise.resolve('missing' as const));
    const storage: DriverProofMediaStorageBackend = {
      remove,
      write: (_input, signal) => new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(
          signal.reason instanceof Error ? signal.reason : new Error('proof media storage write aborted')
        ), { once: true });
      })
    };
    const { prisma } = createPrismaHarness();
    const repository = new PrismaDriverProofMediaRepository(prisma as never, {
      now: () => now,
      storage,
      storageWriteTimeoutMs: 5
    });

    await expect(repository.storeProofMedia(proofMediaInput())).rejects.toMatchObject({ name: 'AbortError' });
    expect(remove).toHaveBeenCalledOnce();
    expect(prisma.driverProofMedia.deleteMany).toHaveBeenCalledWith({
      where: { id: expect.any(String) as unknown, uploadStatus: 'PENDING_UPLOAD' }
    });
  });

  test('bounds an abort-ignoring PUT and retains a CLEANING fence for late-object recovery', async () => {
    vi.useFakeTimers();
    try {
      let resolveLateWrite!: () => void;
      const mediaId = '11111111-1111-4111-8111-111111111111';
      const storageKey = `driver-proof/tomatono.myshopify.com/route-plan-id/stop-id/${mediaId}.jpg`;
      const remove = vi.fn(() => Promise.resolve('removed' as const));
      const storage: DriverProofMediaStorageBackend = {
        remove,
        write: () => new Promise<void>((resolve) => { resolveLateWrite = resolve; })
      };
      const { prisma } = createPrismaHarness({
        expiredProofMedia: [{ id: mediaId, storageKey, uploadedAt: now, uploadStatus: 'CLEANING' }]
      });
      const repository = new PrismaDriverProofMediaRepository(prisma as never, {
        createMediaId: () => mediaId,
        now: () => now,
        storage,
        storageWriteTimeoutMs: 5
      });
      const upload = repository.storeProofMedia(proofMediaInput());
      const rejected = expect(upload).rejects.toMatchObject({ name: 'DriverProofMediaStorageWriteTimeoutError' });
      await vi.advanceTimersByTimeAsync(6);
      await rejected;
      expect(remove).not.toHaveBeenCalled();
      expect(prisma.driverProofMedia.updateMany).toHaveBeenCalledWith({
        data: {
          cleanupClaimedAt: new Date('2026-05-13T10:00:00.000Z'),
          cleanupToken: expect.any(String) as unknown,
          uploadStatus: 'CLEANING'
        },
        where: { id: mediaId, uploadStatus: 'PENDING_UPLOAD' }
      });

      resolveLateWrite();
      await vi.advanceTimersByTimeAsync(0);
      expect(remove).toHaveBeenCalledWith(storageKey, expect.any(AbortSignal));
      const settledToken = (prisma.driverProofMedia.updateMany.mock.calls[1]?.[0] as {
        data: { cleanupToken: string };
      }).data.cleanupToken;
      expect(settledToken).toMatch(/^late-upload-settled:/u);
      expect(prisma.driverProofMedia.deleteMany).toHaveBeenCalledWith({
        where: { cleanupToken: settledToken, id: mediaId, uploadStatus: 'CLEANING' }
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test('removes an object again when cleanup wins before an abort-ignoring PUT settles', async () => {
    vi.useFakeTimers();
    try {
      let resolveLateWrite!: () => void;
      const mediaId = '11111111-1111-4111-8111-111111111111';
      const storageKey = `driver-proof/tomatono.myshopify.com/route-plan-id/stop-id/${mediaId}.jpg`;
      const remove = vi.fn(() => Promise.resolve('removed' as const));
      const storage: DriverProofMediaStorageBackend = {
        remove,
        write: () => new Promise<void>((resolve) => { resolveLateWrite = resolve; })
      };
      const expiredProofMedia = [{
        cleanupToken: '', id: mediaId, storageKey, uploadedAt: now, uploadStatus: 'CLEANING' as const
      }];
      const { prisma } = createPrismaHarness({ expiredProofMedia });
      const repository = new PrismaDriverProofMediaRepository(prisma as never, {
        createMediaId: () => mediaId,
        now: () => now,
        storage,
        storageWriteTimeoutMs: 5
      });
      const upload = repository.storeProofMedia(proofMediaInput());
      const rejected = expect(upload).rejects.toMatchObject({ name: 'DriverProofMediaStorageWriteTimeoutError' });
      await vi.advanceTimersByTimeAsync(6);
      await rejected;
      expiredProofMedia[0]!.cleanupToken = (prisma.driverProofMedia.updateMany.mock.calls[0]?.[0] as {
        data: { cleanupToken: string };
      }).data.cleanupToken;
      expect(expiredProofMedia[0]!.cleanupToken).toMatch(/^late-upload-possible:/u);

      await repository.deleteStalePendingProofMedia({
        createdBefore: new Date('2026-05-14T10:00:00.000Z'),
        now: new Date('2026-05-14T10:00:00.000Z')
      });
      expect(remove).toHaveBeenCalledTimes(1);
      expect(prisma.driverProofMedia.deleteMany).not.toHaveBeenCalled();
      resolveLateWrite();
      await vi.advanceTimersByTimeAsync(0);
      expect(remove).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test('keeps a settled late-upload marker when the second delete fails and a later cleanup removes it', async () => {
    vi.useFakeTimers();
    try {
      let resolveLateWrite!: () => void;
      const mediaId = '11111111-1111-4111-8111-111111111111';
      const storageKey = `driver-proof/tomatono.myshopify.com/route-plan-id/stop-id/${mediaId}.jpg`;
      const remove = vi.fn()
        .mockResolvedValueOnce('removed')
        .mockRejectedValueOnce(new Error('temporary second DELETE failure'))
        .mockResolvedValueOnce('removed');
      const expiredProofMedia = [{
        cleanupToken: '', id: mediaId, storageKey, uploadedAt: now, uploadStatus: 'CLEANING' as const
      }];
      const { prisma } = createPrismaHarness({ expiredProofMedia });
      const repository = new PrismaDriverProofMediaRepository(prisma as never, {
        createMediaId: () => mediaId,
        now: () => now,
        storage: {
          remove,
          write: () => new Promise<void>((resolve) => { resolveLateWrite = resolve; })
        },
        storageWriteTimeoutMs: 5
      });
      const upload = repository.storeProofMedia(proofMediaInput());
      const rejected = expect(upload).rejects.toMatchObject({ name: 'DriverProofMediaStorageWriteTimeoutError' });
      await vi.advanceTimersByTimeAsync(6);
      await rejected;
      expiredProofMedia[0]!.cleanupToken = (prisma.driverProofMedia.updateMany.mock.calls[0]?.[0] as {
        data: { cleanupToken: string };
      }).data.cleanupToken;

      await repository.deleteStalePendingProofMedia({
        createdBefore: new Date('2026-05-14T10:00:00.000Z'),
        now: new Date('2026-05-14T10:00:00.000Z')
      });
      resolveLateWrite();
      await vi.advanceTimersByTimeAsync(0);
      const settledToken = (prisma.driverProofMedia.updateMany.mock.calls[2]?.[0] as {
        data: { cleanupToken: string };
      }).data.cleanupToken;
      expiredProofMedia[0]!.cleanupToken = settledToken;
      expect(settledToken).toMatch(/^late-upload-settled:/u);
      expect(prisma.driverProofMedia.deleteMany).not.toHaveBeenCalled();

      await repository.deleteStalePendingProofMedia({
        createdBefore: new Date('2026-05-14T10:00:00.000Z'),
        now: new Date('2026-05-14T10:16:00.000Z')
      });
      expect(remove).toHaveBeenCalledTimes(3);
      expect(prisma.driverProofMedia.deleteMany).toHaveBeenCalledWith({
        where: { cleanupToken: settledToken, id: mediaId, uploadStatus: 'CLEANING' }
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test('settles a late rejected PUT and lets a later cleanup delete its durable reservation', async () => {
    vi.useFakeTimers();
    try {
      let rejectLateWrite!: (error: Error) => void;
      const mediaId = '11111111-1111-4111-8111-111111111111';
      const storageKey = `driver-proof/tomatono.myshopify.com/route-plan-id/stop-id/${mediaId}.jpg`;
      const remove = vi.fn()
        .mockRejectedValueOnce(new Error('ambiguous object DELETE unavailable'))
        .mockResolvedValueOnce('missing');
      const expiredProofMedia = [{
        cleanupToken: '', id: mediaId, storageKey, uploadedAt: now, uploadStatus: 'CLEANING' as const
      }];
      const { prisma } = createPrismaHarness({ expiredProofMedia });
      const repository = new PrismaDriverProofMediaRepository(prisma as never, {
        createMediaId: () => mediaId,
        now: () => now,
        storage: {
          remove,
          write: () => new Promise<void>((_resolve, reject) => { rejectLateWrite = reject; })
        },
        storageWriteTimeoutMs: 5
      });
      const upload = repository.storeProofMedia(proofMediaInput());
      const rejected = expect(upload).rejects.toMatchObject({ name: 'DriverProofMediaStorageWriteTimeoutError' });
      await vi.advanceTimersByTimeAsync(6);
      await rejected;
      expiredProofMedia[0]!.cleanupToken = (prisma.driverProofMedia.updateMany.mock.calls[0]?.[0] as {
        data: { cleanupToken: string };
      }).data.cleanupToken;

      rejectLateWrite(new Error('late PUT rejected after timeout'));
      await vi.advanceTimersByTimeAsync(0);
      const settledToken = (prisma.driverProofMedia.updateMany.mock.calls[1]?.[0] as {
        data: { cleanupToken: string };
      }).data.cleanupToken;
      expiredProofMedia[0]!.cleanupToken = settledToken;
      expect(settledToken).toMatch(/^late-upload-settled:/u);
      expect(prisma.driverProofMedia.deleteMany).not.toHaveBeenCalled();

      await repository.deleteStalePendingProofMedia({
        createdBefore: new Date('2026-05-14T10:00:00.000Z'),
        now: new Date('2026-05-12T10:16:00.000Z')
      });
      expect(remove).toHaveBeenCalledTimes(2);
      expect(prisma.driverProofMedia.deleteMany).toHaveBeenCalledWith({
        where: { cleanupToken: settledToken, id: mediaId, uploadStatus: 'CLEANING' }
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test('retains fenced cleanup evidence when upload succeeds after cleanup claimed the reservation', async () => {
    const errorLogs: Array<{ details: Record<string, unknown>; message: string }> = [];
    const remove = vi.fn(() => Promise.reject(new Error('DELETE token=private-secret failed')));
    const storage: DriverProofMediaStorageBackend = { remove, write: vi.fn(() => Promise.resolve()) };
    const { prisma } = createPrismaHarness();
    prisma.driverProofMedia.updateMany.mockResolvedValueOnce({ count: 0 });
    const repository = new PrismaDriverProofMediaRepository(prisma as never, {
      cleanupLogger: {
        error: (details: Record<string, unknown>, message: string) => errorLogs.push({ details, message })
      },
      now: () => now,
      storage
    });

    await expect(repository.storeProofMedia(proofMediaInput())).rejects.toThrow(
      'Proof media upload reservation could not be finalized'
    );
    expect(remove).toHaveBeenCalledOnce();
    expect(prisma.driverProofMedia.deleteMany).not.toHaveBeenCalled();
    expect(errorLogs).toEqual([{
      details: {
        cleanupErrorCode: 'ERROR',
        event: 'driver_proof_media_lost_finalize_cleanup_failed',
        mediaId: expect.any(String) as unknown
      },
      message: 'Failed to remove proof media after upload finalization lost its reservation'
    }]);
    expect(JSON.stringify(errorLogs)).not.toContain('private-secret');
  });

  test('bounds an abort-ignoring finalize-loss delete and retains its durable cleanup reservation', async () => {
    vi.useFakeTimers();
    try {
      const remove = vi.fn((...args: [string, AbortSignal]) => {
        void args[0];
        return new Promise<'removed'>(() => undefined);
      });
      const storage: DriverProofMediaStorageBackend = { remove, write: vi.fn(() => Promise.resolve()) };
      const { prisma } = createPrismaHarness();
      prisma.driverProofMedia.updateMany.mockResolvedValueOnce({ count: 0 });
      const repository = new PrismaDriverProofMediaRepository(prisma as never, {
        now: () => now,
        storage,
        storageRemoveTimeoutMs: 1_000
      });

      const upload = repository.storeProofMedia(proofMediaInput());
      const rejected = expect(upload).rejects.toThrow('Proof media upload reservation could not be finalized');
      await vi.advanceTimersByTimeAsync(1_001);
      await rejected;
      expect(remove.mock.calls[0]?.[1].aborted).toBe(true);
      expect(prisma.driverProofMedia.deleteMany).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test('fences stale pending uploads for one cleanup lease before deleting their reservation', async () => {
    const storageKey = 'driver-proof/tomatono.myshopify.com/route-plan-id/stop-id/pending-media-id.jpg';
    const storage: DriverProofMediaStorageBackend = {
      remove: vi.fn(() => Promise.resolve('removed' as const)),
      write: vi.fn(() => Promise.resolve())
    };
    const { prisma } = createPrismaHarness({
      expiredProofMedia: [{ id: 'pending-media-id', storageKey, uploadedAt: now, uploadStatus: 'PENDING_UPLOAD' }]
    });
    const repository = new PrismaDriverProofMediaRepository(prisma as never, { now: () => now, storage });
    const createdBefore = new Date('2026-05-13T10:00:00.000Z');

    await expect(repository.deleteStalePendingProofMedia({ createdBefore, limit: 10 })).resolves.toEqual({
      deletedReservations: 0,
      missingFiles: 0,
      scanned: 1
    });
    expect(prisma.driverProofMedia.findMany).toHaveBeenCalledWith({
      orderBy: { createdAt: 'asc' },
      take: 10,
      where: {
        createdAt: { lt: createdBefore },
        OR: [
          { uploadStatus: 'PENDING_UPLOAD' },
          { cleanupClaimedAt: { lt: new Date('2026-05-12T09:45:00.000Z') }, uploadStatus: 'CLEANING' }
        ]
      }
    });
    expect(prisma.driverProofMedia.updateMany).toHaveBeenCalledWith({
      data: {
        cleanupClaimedAt: now,
        cleanupToken: expect.any(String) as unknown,
        uploadStatus: 'CLEANING'
      },
      where: {
        id: 'pending-media-id',
        OR: [
          { createdAt: { lt: createdBefore }, uploadStatus: 'PENDING_UPLOAD' },
          { cleanupClaimedAt: { lt: new Date('2026-05-12T09:45:00.000Z') }, uploadStatus: 'CLEANING' }
        ]
      }
    });
    expect(prisma.driverProofMedia.deleteMany).not.toHaveBeenCalled();
  });

  test('deletes a stale CLEANING reservation after the upload timeout fence elapsed', async () => {
    const storageKey = 'driver-proof/tomatono.myshopify.com/route-plan-id/stop-id/cleaning-media-id.jpg';
    const storage: DriverProofMediaStorageBackend = {
      remove: vi.fn(() => Promise.resolve('missing' as const)),
      write: vi.fn(() => Promise.resolve())
    };
    const { prisma } = createPrismaHarness({
      expiredProofMedia: [{ id: 'cleaning-media-id', storageKey, uploadedAt: now, uploadStatus: 'CLEANING' }]
    });
    const repository = new PrismaDriverProofMediaRepository(prisma as never, { now: () => now, storage });

    await expect(repository.deleteStalePendingProofMedia({
      createdBefore: new Date('2026-05-13T10:00:00.000Z')
    })).resolves.toEqual({ deletedReservations: 1, missingFiles: 1, scanned: 1 });
    const cleanupToken = (prisma.driverProofMedia.updateMany.mock.calls[0]?.[0] as {
      data: { cleanupToken: string };
    }).data.cleanupToken;
    expect(prisma.driverProofMedia.deleteMany).toHaveBeenCalledWith({
      where: { cleanupToken, id: 'cleaning-media-id', uploadStatus: 'CLEANING' }
    });
  });

  test('retains a fenced CLEANING reservation when stale object removal fails', async () => {
    const storageKey = 'driver-proof/tomatono.myshopify.com/route-plan-id/stop-id/retry-cleanup.jpg';
    const storage: DriverProofMediaStorageBackend = {
      remove: vi.fn(() => Promise.reject(new Error('temporary object store failure'))),
      write: vi.fn(() => Promise.resolve())
    };
    const { prisma } = createPrismaHarness({
      expiredProofMedia: [{ id: 'retry-cleanup', storageKey, uploadedAt: now }]
    });
    const repository = new PrismaDriverProofMediaRepository(prisma as never, { now: () => now, storage });

    await expect(repository.deleteStalePendingProofMedia({
      createdBefore: new Date('2026-05-13T10:00:00.000Z')
    })).rejects.toThrow('temporary object store failure');
    const cleanupClaim = prisma.driverProofMedia.updateMany.mock.calls[0]?.[0] as {
      data: { cleanupClaimedAt: Date; cleanupToken: unknown; uploadStatus: string };
    };
    expect(cleanupClaim.data).toMatchObject({ cleanupClaimedAt: now, uploadStatus: 'CLEANING' });
    expect(typeof cleanupClaim.data.cleanupToken).toBe('string');
    expect(prisma.driverProofMedia.deleteMany).not.toHaveBeenCalled();
  });

  test('times out a stuck CLEANING delete without losing evidence and deletes it on the next retry', async () => {
    vi.useFakeTimers();
    try {
      const storageKey = 'driver-proof/tomatono.myshopify.com/route-plan-id/stop-id/stuck-cleanup.jpg';
      const remove = vi.fn()
        .mockImplementationOnce(() => new Promise<'removed'>(() => undefined))
        .mockResolvedValueOnce('removed');
      const storage: DriverProofMediaStorageBackend = { remove, write: vi.fn(() => Promise.resolve()) };
      const { prisma } = createPrismaHarness({
        expiredProofMedia: [{ id: 'stuck-cleanup', storageKey, uploadedAt: now, uploadStatus: 'CLEANING' }]
      });
      const repository = new PrismaDriverProofMediaRepository(prisma as never, {
        now: () => now,
        storage,
        storageRemoveTimeoutMs: 1_000
      });
      const first = repository.deleteStalePendingProofMedia({
        createdBefore: new Date('2026-05-13T10:00:00.000Z')
      });
      const rejected = expect(first).rejects.toThrow('Proof media storage delete timed out');
      await vi.advanceTimersByTimeAsync(1_001);
      await rejected;
      expect(prisma.driverProofMedia.deleteMany).not.toHaveBeenCalled();

      await expect(repository.deleteStalePendingProofMedia({
        createdBefore: new Date('2026-05-13T10:00:00.000Z'),
        now: new Date('2026-05-12T10:16:00.000Z')
      })).resolves.toMatchObject({ deletedReservations: 1 });
      expect(prisma.driverProofMedia.deleteMany).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  test('records clean scanner outcomes without proof bytes before writing accepted media', async () => {
    const writes: { fileBytes: Buffer; storageKey: string }[] = [];
    const scannerObservations: Record<string, unknown>[] = [];
    const storage: DriverProofMediaStorageBackend = {
      remove: () => Promise.resolve('removed'),
      write: (input) => {
        writes.push(input);
        return Promise.resolve();
      }
    };
    const { prisma } = createPrismaHarness();
    const repository = new PrismaDriverProofMediaRepository(prisma as never, {
      createMediaId: () => '11111111-1111-4111-8111-111111111111',
      now: () => now,
      scanMonitor: {
        recordProofMediaScan: (input: Record<string, unknown>) => {
          scannerObservations.push(input);
          return Promise.resolve();
        }
      },
      scanner: {
        scanProofMedia: () => Promise.resolve({ status: 'clean' })
      },
      storage
    } as never);
    const sanitizedBytes = jpegWithoutExifBytes();
    const sanitizedSha256 = sha256Hex(sanitizedBytes);
    const storageKey = 'driver-proof/tomatono.myshopify.com/route-plan-id/stop-id/11111111-1111-4111-8111-111111111111.jpg';

    await repository.storeProofMedia({
      contentType: 'image/jpeg',
      deliveryStopId: 'stop-id',
      driverId: 'driver-id',
      fileBytes: jpegWithExifBytes(),
      filename: 'proof-with-exif.jpg',
      routePlanId: 'route-plan-id',
      shopDomain: 'tomatono.myshopify.com',
      shopId: 'shop-id',
      source: 'camera'
    });

    expect(scannerObservations).toEqual([
      {
        contentType: 'image/jpeg',
        mediaId: '11111111-1111-4111-8111-111111111111',
        scannedAt: now,
        sha256: sanitizedSha256,
        status: 'clean',
        storageKey
      }
    ]);
    expect(scannerObservations[0]).not.toHaveProperty('fileBytes');
    expect(writes).toEqual([{ fileBytes: sanitizedBytes, storageKey }]);
  });

  test('creates scoped short-lived proof media read access through the storage backend', async () => {
    const storageKey = 'driver-proof/tomatono.myshopify.com/route-plan-id/stop-id/proof-media-id.jpg';
    const readAccessRequests: {
      contentType: string;
      expiresAt: Date;
      storageKey: string;
    }[] = [];
    const storage: DriverProofMediaStorageBackend & {
      createReadAccess(input: { contentType: string; expiresAt: Date; storageKey: string }): Promise<{ url: string }>;
    } = {
      createReadAccess: (input) => {
        readAccessRequests.push(input);
        return Promise.resolve({ url: 'https://proof-media.example.test/signed/proof-media-id' });
      },
      remove: () => Promise.resolve('removed'),
      write: () => Promise.resolve()
    };
    const { prisma } = createPrismaHarness({
      proofMedia: {
        contentType: 'image/jpeg',
        id: 'proof-media-id',
        kind: 'PHOTO',
        storageKey,
        uploadedAt: now
      }
    });
    const repository = new PrismaDriverProofMediaRepository(prisma as never, {
      now: () => now,
      readAccessTtlSeconds: 300,
      storage
    });

    const result = await repository.createProofMediaReadAccess({
      driverId: 'driver-id',
      mediaId: 'proof-media-id',
      routePlanId: 'route-plan-id',
      shopDomain: 'Tomatono.myshopify.com',
      shopId: 'shop-id'
    });

    expect(prisma.driverProofMedia.findFirst).toHaveBeenCalledWith({
      where: {
        deletedAt: null,
        driverId: 'driver-id',
        id: 'proof-media-id',
        routePlanId: 'route-plan-id',
        shopId: 'shop-id',
        uploadStatus: 'READY'
      }
    });
    expect(readAccessRequests).toEqual([
      {
        contentType: 'image/jpeg',
        expiresAt: new Date('2026-05-12T10:05:00.000Z'),
        storageKey
      }
    ]);
    expect(result).toEqual({
      contentType: 'image/jpeg',
      expiresAt: '2026-05-12T10:05:00.000Z',
      kind: 'photo',
      mediaId: 'proof-media-id',
      url: 'https://proof-media.example.test/signed/proof-media-id'
    });
  });

  test('rejects scanner-blocked proof media before writing bytes or metadata', async () => {
    const writes: { fileBytes: Buffer; storageKey: string }[] = [];
    const scannerCalls: { contentType: string; fileBytes: Buffer; sha256: string; storageKey: string }[] = [];
    const scannerObservations: Record<string, unknown>[] = [];
    const storage: DriverProofMediaStorageBackend = {
      remove: () => Promise.resolve('removed'),
      write: (input) => {
        writes.push(input);
        return Promise.resolve();
      }
    };
    const { prisma } = createPrismaHarness();
    const repository = new PrismaDriverProofMediaRepository(prisma as never, {
      createMediaId: () => '11111111-1111-4111-8111-111111111111',
      now: () => now,
      scanMonitor: {
        recordProofMediaScan: (input: Record<string, unknown>) => {
          scannerObservations.push(input);
          return Promise.resolve();
        }
      },
      scanner: {
        scanProofMedia: (input: { contentType: string; fileBytes: Buffer; sha256: string; storageKey: string }) => {
          scannerCalls.push(input);
          return Promise.resolve({ reason: 'malware signature fixture', status: 'rejected' });
        }
      },
      storage
    } as never);
    const sanitizedBytes = jpegWithoutExifBytes();
    const sanitizedSha256 = sha256Hex(sanitizedBytes);
    const storageKey = 'driver-proof/tomatono.myshopify.com/route-plan-id/stop-id/11111111-1111-4111-8111-111111111111.jpg';

    await expect(
      repository.storeProofMedia({
        contentType: 'image/jpeg',
        deliveryStopId: 'stop-id',
        driverId: 'driver-id',
        fileBytes: jpegWithExifBytes(),
        filename: 'proof-with-exif.jpg',
        routePlanId: 'route-plan-id',
        shopDomain: 'tomatono.myshopify.com',
        shopId: 'shop-id',
        source: 'camera'
      })
    ).rejects.toThrow('Proof media rejected by malware scan');

    expect(scannerCalls).toEqual([
      {
        contentType: 'image/jpeg',
        fileBytes: sanitizedBytes,
        sha256: sanitizedSha256,
        storageKey
      }
    ]);
    expect(scannerObservations).toEqual([
      {
        contentType: 'image/jpeg',
        mediaId: '11111111-1111-4111-8111-111111111111',
        reason: 'malware signature fixture',
        scannedAt: now,
        sha256: sanitizedSha256,
        status: 'rejected',
        storageKey
      }
    ]);
    expect(scannerObservations[0]).not.toHaveProperty('fileBytes');
    expect(writes).toEqual([]);
    expect(prisma.driverProofMedia.create).not.toHaveBeenCalled();
  });

  test('keeps JPEG proof media without EXIF metadata unchanged', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'clever-proof-media-'));
    const { prisma } = createPrismaHarness();
    const repository = new PrismaDriverProofMediaRepository(prisma as never, {
      createMediaId: () => '11111111-1111-4111-8111-111111111111',
      now: () => now,
      storageRoot
    });
    const fileBytes = jpegWithoutExifBytes();

    const result = await repository.storeProofMedia({
      contentType: 'image/jpeg',
      deliveryStopId: 'stop-id',
      driverId: 'driver-id',
      fileBytes,
      filename: 'proof-without-exif.jpg',
      routePlanId: 'route-plan-id',
      shopDomain: 'tomatono.myshopify.com',
      shopId: 'shop-id',
      source: 'camera'
    });

    const storageKey = 'driver-proof/tomatono.myshopify.com/route-plan-id/stop-id/11111111-1111-4111-8111-111111111111.jpg';
    const expectedSha256 = sha256Hex(fileBytes);
    expect(prisma.driverProofMedia.create).toHaveBeenCalledWith({
      data: {
        contentType: 'image/jpeg',
        deliveryStopId: 'stop-id',
        driverId: 'driver-id',
        id: '11111111-1111-4111-8111-111111111111',
        kind: 'PHOTO',
        originalFilename: 'proof-without-exif.jpg',
        routePlanId: 'route-plan-id',
        sha256: expectedSha256,
        shopId: 'shop-id',
        sizeBytes: fileBytes.byteLength,
        source: 'CAMERA',
        storageKey,
        uploadStatus: 'PENDING_UPLOAD',
        uploadedAt: now
      }
    });
    await expect(readFile(join(storageRoot, ...storageKey.split('/')))).resolves.toEqual(fileBytes);
    expect(result).toEqual(expect.objectContaining({
      sha256: expectedSha256,
      sizeBytes: fileBytes.byteLength,
      storageKey
    }));
  });

  test('rejects proof media outside the token driver route scope before writing metadata', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'clever-proof-media-'));
    const { prisma } = createPrismaHarness({ routePlan: null });
    const repository = new PrismaDriverProofMediaRepository(prisma as never, {
      createMediaId: () => '11111111-1111-4111-8111-111111111111',
      now: () => now,
      storageRoot
    });

    await expect(
      repository.storeProofMedia({
        contentType: 'image/jpeg',
        deliveryStopId: 'stop-id',
        driverId: 'driver-id',
        fileBytes: uploadBytes,
        filename: 'proof.jpg',
        routePlanId: 'route-plan-id',
        shopDomain: 'tomatono.myshopify.com',
        shopId: 'shop-id',
        source: 'camera'
      })
    ).rejects.toThrow('Route plan not assigned to driver');
    expect(prisma.routePlanStop.findUnique).not.toHaveBeenCalled();
    expect(prisma.driverProofMedia.create).not.toHaveBeenCalled();
  });

  test('deletes expired proof media bytes and marks metadata deleted', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'clever-proof-media-'));
    const storageKey = 'driver-proof/tomatono.myshopify.com/route-plan-id/stop-id/media-id.jpg';
    const storedPath = join(storageRoot, ...storageKey.split('/'));
    await mkdir(join(storageRoot, 'driver-proof/tomatono.myshopify.com/route-plan-id/stop-id'), { recursive: true });
    await writeFile(storedPath, uploadBytes);
    const deletedAt = new Date('2026-06-12T00:00:00.000Z');
    const uploadedBefore = new Date('2026-06-01T00:00:00.000Z');
    const { prisma } = createPrismaHarness({
      expiredProofMedia: [
        {
          id: 'media-id',
          storageKey,
          uploadedAt: new Date('2026-05-12T10:00:00.000Z')
        }
      ]
    });
    const repository = new PrismaDriverProofMediaRepository(prisma as never, { storageRoot });

    const result = await repository.deleteExpiredProofMedia({ deletedAt, uploadedBefore });

    expect(prisma.driverProofMedia.findMany).toHaveBeenCalledWith({
      orderBy: { uploadedAt: 'asc' },
      take: 100,
      where: {
        deletedAt: null,
        uploadedAt: { lt: uploadedBefore },
        uploadStatus: 'READY'
      }
    });
    expect(prisma.driverProofMedia.update).toHaveBeenCalledWith({
      data: { deletedAt },
      where: { id: 'media-id' }
    });
    await expect(readFile(storedPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(result).toEqual({
      deleted: 1,
      missingFiles: 0,
      scanned: 1
    });
  });

  test('marks missing expired proof media as deleted idempotently', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'clever-proof-media-'));
    const deletedAt = new Date('2026-06-12T00:00:00.000Z');
    const { prisma } = createPrismaHarness({
      expiredProofMedia: [
        {
          id: 'missing-media-id',
          storageKey: 'driver-proof/tomatono.myshopify.com/route-plan-id/stop-id/missing-media-id.jpg',
          uploadedAt: new Date('2026-05-12T10:00:00.000Z')
        }
      ]
    });
    const repository = new PrismaDriverProofMediaRepository(prisma as never, { storageRoot });

    const result = await repository.deleteExpiredProofMedia({
      deletedAt,
      uploadedBefore: new Date('2026-06-01T00:00:00.000Z')
    });

    expect(prisma.driverProofMedia.update).toHaveBeenCalledWith({
      data: { deletedAt },
      where: { id: 'missing-media-id' }
    });
    expect(result).toEqual({
      deleted: 1,
      missingFiles: 1,
      scanned: 1
    });
  });

  test('removes expired proof media through an injected storage backend', async () => {
    const storageKey = 'driver-proof/tomatono.myshopify.com/route-plan-id/stop-id/missing-media-id.jpg';
    const removedKeys: string[] = [];
    const storage: DriverProofMediaStorageBackend = {
      remove: (key) => {
        removedKeys.push(key);
        return Promise.resolve('missing');
      },
      write: () => Promise.resolve()
    };
    const deletedAt = new Date('2026-06-12T00:00:00.000Z');
    const { prisma } = createPrismaHarness({
      expiredProofMedia: [
        {
          id: 'missing-media-id',
          storageKey,
          uploadedAt: new Date('2026-05-12T10:00:00.000Z')
        }
      ]
    });
    const repository = new PrismaDriverProofMediaRepository(prisma as never, { storage });

    const result = await repository.deleteExpiredProofMedia({
      deletedAt,
      uploadedBefore: new Date('2026-06-01T00:00:00.000Z')
    });

    expect(removedKeys).toEqual([storageKey]);
    expect(prisma.driverProofMedia.update).toHaveBeenCalledWith({
      data: { deletedAt },
      where: { id: 'missing-media-id' }
    });
    expect(result).toEqual({
      deleted: 1,
      missingFiles: 1,
      scanned: 1
    });
  });

  test('rejects expired proof media storage keys outside the configured storage root', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'clever-proof-media-'));
    const { prisma } = createPrismaHarness({
      expiredProofMedia: [
        {
          id: 'unsafe-media-id',
          storageKey: '../outside-root.jpg',
          uploadedAt: new Date('2026-05-12T10:00:00.000Z')
        }
      ]
    });
    const repository = new PrismaDriverProofMediaRepository(prisma as never, { storageRoot });

    await expect(
      repository.deleteExpiredProofMedia({ uploadedBefore: new Date('2026-06-01T00:00:00.000Z') })
    ).rejects.toThrow('Proof media storage key escapes storage root');
    expect(prisma.driverProofMedia.update).not.toHaveBeenCalled();
  });
});

function createPrismaHarness(input: {
  createProofMediaError?: Error;
  expiredProofMedia?: {
    cleanupToken?: string | null;
    id: string;
    storageKey: string;
    uploadedAt: Date;
    uploadStatus?: 'CLEANING' | 'PENDING_UPLOAD' | 'READY';
  }[];
  proofMedia?: {
    contentType: string;
    id: string;
    kind: 'PHOTO';
    storageKey: string;
    uploadedAt: Date;
  } | null;
  routePlan?: { id: string } | null;
  routePlanStop?: { id: string } | null;
} = {}) {
  return {
    prisma: {
      driver: {
        findUnique: vi.fn(() => Promise.resolve({ id: 'driver-id', shopId: 'shop-id' }))
      },
      driverProofMedia: {
        create: vi.fn(({ data }: { data: Record<string, unknown> }) => input.createProofMediaError === undefined
          ? Promise.resolve({ ...data })
          : Promise.reject(input.createProofMediaError)),
        findFirst: vi.fn(() => Promise.resolve(input.proofMedia === undefined ? null : input.proofMedia)),
        findMany: vi.fn(() => Promise.resolve(input.expiredProofMedia ?? [])),
        deleteMany: vi.fn(() => Promise.resolve({ count: 1 })),
        updateMany: vi.fn((updateInput: unknown) => {
          void updateInput;
          return Promise.resolve({ count: 1 });
        }),
        update: vi.fn(({ data, where }: { data: Record<string, unknown>; where: Record<string, unknown> }) =>
          Promise.resolve({ ...where, ...data })
        )
      },
      routePlan: {
        findFirst: vi.fn(() => Promise.resolve(input.routePlan === undefined ? { id: 'route-plan-id' } : input.routePlan))
      },
      routePlanStop: {
        findUnique: vi.fn(() =>
          Promise.resolve(input.routePlanStop === undefined ? { id: 'route-plan-stop-id' } : input.routePlanStop)
        )
      },
      shop: {
        findUnique: vi.fn(() => Promise.resolve({ id: 'shop-id' }))
      }
    }
  };
}

function proofMediaInput() {
  return {
    contentType: 'image/jpeg',
    deliveryStopId: 'stop-id',
    driverId: 'driver-id',
    fileBytes: uploadBytes,
    filename: 'proof.jpg',
    routePlanId: 'route-plan-id',
    shopDomain: 'tomatono.myshopify.com',
    shopId: 'shop-id',
    source: 'camera' as const
  };
}

function jpegWithExifBytes(): Buffer {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x08, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
    0xff, 0xe1, 0x00, 0x0a, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x01, 0x02,
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
    0x11, 0x22, 0xff, 0xd9
  ]);
}

function jpegWithoutExifBytes(): Buffer {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x08, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
    0x11, 0x22, 0xff, 0xd9
  ]);
}

function sha256Hex(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
