import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, test, vi } from 'vitest';

import {
  PrismaDriverProofMediaRepository,
  type DriverProofMediaStorageBackend
} from '../src/modules/driver/driver-proof-media.repository.js';

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
      shopDomain: 'Tomatono.myshopify.com',
      source: 'camera'
    });

    expect(prisma.shop.findUnique).toHaveBeenCalledWith({ where: { shopDomain: 'tomatono.myshopify.com' } });
    expect(prisma.driver.findUnique).toHaveBeenCalledWith({ where: { id: 'driver-id' } });
    expect(prisma.routePlan.findFirst).toHaveBeenCalledWith({
      where: {
        driverId: 'driver-id',
        id: 'route-plan-id',
        shopId: 'shop-id',
        status: { in: ['ASSIGNED', 'IN_PROGRESS', 'OPTIMIZED'] }
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
        storageKey: 'driver-proof/tomatono.myshopify.com/route-plan-id/stop-id/11111111-1111-4111-8111-111111111111.jpg',
        uploadedAt: now
      }
    });
    await expect(
      readFile(join(storageRoot, 'driver-proof/tomatono.myshopify.com/route-plan-id/stop-id/11111111-1111-4111-8111-111111111111.jpg'))
    ).resolves.toEqual(uploadBytes);
    expect(result).toEqual({
      contentType: 'image/jpeg',
      kind: 'photo',
      mediaId: '11111111-1111-4111-8111-111111111111',
      sha256: 'dad2f603ccde777ba84635fb7bea4cea8f2d1147e59fd02f74cbd720a9bd15c7',
      sizeBytes: uploadBytes.byteLength,
      source: 'camera',
      storageKey: 'driver-proof/tomatono.myshopify.com/route-plan-id/stop-id/11111111-1111-4111-8111-111111111111.jpg',
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
      source: 'camera'
    });

    expect(writes).toEqual([
      {
        fileBytes: sanitizedBytes,
        storageKey: 'driver-proof/tomatono.myshopify.com/route-plan-id/stop-id/11111111-1111-4111-8111-111111111111.jpg'
      }
    ]);
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
      shopDomain: 'Tomatono.myshopify.com'
    });

    expect(prisma.shop.findUnique).toHaveBeenCalledWith({ where: { shopDomain: 'tomatono.myshopify.com' } });
    expect(prisma.driverProofMedia.findFirst).toHaveBeenCalledWith({
      where: {
        deletedAt: null,
        driverId: 'driver-id',
        id: 'proof-media-id',
        shopId: 'shop-id'
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
        uploadedAt: { lt: uploadedBefore }
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
  expiredProofMedia?: { id: string; storageKey: string; uploadedAt: Date }[];
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
        create: vi.fn(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ ...data })),
        findFirst: vi.fn(() => Promise.resolve(input.proofMedia === undefined ? null : input.proofMedia)),
        findMany: vi.fn(() => Promise.resolve(input.expiredProofMedia ?? [])),
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
