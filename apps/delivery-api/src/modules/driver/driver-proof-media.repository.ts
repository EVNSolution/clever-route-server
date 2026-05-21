import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import type { PrismaClient } from '@prisma/client';

import {
  DriverProofMediaAccessUnavailableError,
  DriverProofMediaScanRejectedError,
  DriverProofMediaScopeError
} from './driver-proof-media.types.js';
import type {
  CreateDriverProofMediaReadAccessInput,
  CreateDriverProofMediaReadAccessResult,
  DriverProofMediaScanMonitor,
  DriverProofMediaScanResult,
  DriverProofMediaScanner,
  DriverProofMediaSource,
  StoreDriverProofMediaInput,
  StoreDriverProofMediaResult
} from './driver-proof-media.types.js';

type DriverProofMediaPrismaClient = Pick<
  PrismaClient,
  'driver' | 'driverProofMedia' | 'routePlan' | 'routePlanStop' | 'shop'
>;

type PrismaProofMediaSource = 'CAMERA' | 'LIBRARY';

export type DriverProofMediaStorageWriteInput = {
  fileBytes: Buffer;
  storageKey: string;
};

export type DriverProofMediaStorageReadAccessInput = {
  contentType: string;
  expiresAt: Date;
  storageKey: string;
};

export type DriverProofMediaStorageBackend = {
  createReadAccess?(input: DriverProofMediaStorageReadAccessInput): Promise<{ url: string }>;
  remove(storageKey: string): Promise<'missing' | 'removed'>;
  write(input: DriverProofMediaStorageWriteInput): Promise<void>;
};

type DriverProofMediaRepositoryOptions = {
  createMediaId?: () => string;
  now?: () => Date;
  readAccessTtlSeconds?: number;
  scanMonitor?: DriverProofMediaScanMonitor;
  scanner?: DriverProofMediaScanner;
  storage?: DriverProofMediaStorageBackend;
  storageRoot?: string;
};

const DEFAULT_READ_ACCESS_TTL_SECONDS = 5 * 60;

export type DeleteExpiredProofMediaInput = {
  deletedAt?: Date;
  limit?: number;
  uploadedBefore: Date;
};

export type DeleteExpiredProofMediaResult = {
  deleted: number;
  missingFiles: number;
  scanned: number;
};

export class PrismaDriverProofMediaRepository {
  private readonly createMediaId: () => string;
  private readonly now: () => Date;
  private readonly readAccessTtlSeconds: number;
  private readonly scanMonitor: DriverProofMediaScanMonitor | undefined;
  private readonly scanner: DriverProofMediaScanner | undefined;
  private readonly storage: DriverProofMediaStorageBackend;

  constructor(
    private readonly prisma: DriverProofMediaPrismaClient,
    options: DriverProofMediaRepositoryOptions
  ) {
    this.createMediaId = options.createMediaId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
    this.readAccessTtlSeconds = options.readAccessTtlSeconds ?? DEFAULT_READ_ACCESS_TTL_SECONDS;
    this.scanMonitor = options.scanMonitor;
    this.scanner = options.scanner;
    this.storage = options.storage ?? createLocalDriverProofMediaStorage(requireStorageRoot(options.storageRoot));
  }

  async createProofMediaReadAccess(
    input: CreateDriverProofMediaReadAccessInput
  ): Promise<CreateDriverProofMediaReadAccessResult> {
    const shopDomain = normalizeShopDomain(input.shopDomain);
    const shop = await this.prisma.shop.findUnique({ where: { shopDomain } });
    if (shop === null) {
      throw new DriverProofMediaScopeError(`Shop not installed: ${shopDomain}`);
    }

    const media = await this.prisma.driverProofMedia.findFirst({
      where: {
        deletedAt: null,
        driverId: input.driverId,
        id: input.mediaId,
        shopId: shop.id
      }
    });
    if (media === null) {
      throw new DriverProofMediaScopeError(`Proof media not found for driver: ${input.mediaId}`);
    }

    if (this.storage.createReadAccess === undefined) {
      throw new DriverProofMediaAccessUnavailableError();
    }

    const expiresAt = new Date(this.now().getTime() + this.readAccessTtlSeconds * 1000);
    const access = await this.storage.createReadAccess({
      contentType: media.contentType,
      expiresAt,
      storageKey: media.storageKey
    });

    return {
      contentType: media.contentType,
      expiresAt: expiresAt.toISOString(),
      kind: toProofMediaKind(media.kind),
      mediaId: media.id,
      url: access.url
    };
  }

  async storeProofMedia(input: StoreDriverProofMediaInput): Promise<StoreDriverProofMediaResult> {
    const shopDomain = normalizeShopDomain(input.shopDomain);
    const shop = await this.prisma.shop.findUnique({ where: { shopDomain } });
    if (shop === null) {
      throw new DriverProofMediaScopeError(`Shop not installed: ${shopDomain}`);
    }

    const driver = await this.prisma.driver.findUnique({ where: { id: input.driverId } });
    if (driver === null || driver.shopId !== shop.id) {
      throw new DriverProofMediaScopeError(`Driver not found for shop: ${input.driverId}`);
    }

    const routePlan = await this.prisma.routePlan.findFirst({
      where: {
        driverId: input.driverId,
        id: input.routePlanId,
        shopId: shop.id,
        status: { in: ['ASSIGNED', 'IN_PROGRESS', 'OPTIMIZED'] }
      }
    });
    if (routePlan === null) {
      throw new DriverProofMediaScopeError(`Route plan not assigned to driver: ${input.routePlanId}`);
    }

    const routePlanStop = await this.prisma.routePlanStop.findUnique({
      where: {
        routePlanId_deliveryStopId: {
          deliveryStopId: input.deliveryStopId,
          routePlanId: input.routePlanId
        }
      }
    });
    if (routePlanStop === null) {
      throw new DriverProofMediaScopeError(`Delivery stop not found in route plan: ${input.deliveryStopId}`);
    }

    const mediaId = this.createMediaId();
    const uploadedAt = this.now();
    const storedFileBytes = sanitizeProofMediaBytes(input.contentType, input.fileBytes);
    const sha256 = createHash('sha256').update(storedFileBytes).digest('hex');
    const storageKey = buildStorageKey({
      deliveryStopId: input.deliveryStopId,
      extension: extensionFor(input.contentType, input.filename),
      mediaId,
      routePlanId: input.routePlanId,
      shopDomain
    });
    const scanResult = await this.scanner?.scanProofMedia({
      contentType: input.contentType,
      fileBytes: storedFileBytes,
      sha256,
      storageKey
    });
    if (scanResult !== undefined) {
      await this.recordScanResult({
        contentType: input.contentType,
        mediaId,
        scanResult,
        scannedAt: uploadedAt,
        sha256,
        storageKey
      });
    }
    if (scanResult?.status === 'rejected') {
      throw new DriverProofMediaScanRejectedError(scanResult.reason);
    }

    await this.storage.write({ fileBytes: storedFileBytes, storageKey });

    await this.prisma.driverProofMedia.create({
      data: {
        contentType: input.contentType,
        deliveryStopId: input.deliveryStopId,
        driverId: input.driverId,
        id: mediaId,
        kind: 'PHOTO',
        originalFilename: input.filename,
        routePlanId: input.routePlanId,
        sha256,
        shopId: shop.id,
        sizeBytes: storedFileBytes.byteLength,
        source: toPrismaSource(input.source),
        storageKey,
        uploadedAt
      }
    });

    return {
      contentType: input.contentType,
      kind: 'photo',
      mediaId,
      sha256,
      sizeBytes: storedFileBytes.byteLength,
      source: input.source,
      storageKey,
      uploadedAt: uploadedAt.toISOString()
    };
  }

  async deleteExpiredProofMedia(input: DeleteExpiredProofMediaInput): Promise<DeleteExpiredProofMediaResult> {
    const deletedAt = input.deletedAt ?? this.now();
    const expiredMedia = await this.prisma.driverProofMedia.findMany({
      orderBy: { uploadedAt: 'asc' },
      take: input.limit ?? 100,
      where: {
        deletedAt: null,
        uploadedAt: { lt: input.uploadedBefore }
      }
    });

    let deleted = 0;
    let missingFiles = 0;

    for (const media of expiredMedia) {
      const removeResult = await this.storage.remove(media.storageKey);
      if (removeResult === 'missing') {
        missingFiles += 1;
      }

      await this.prisma.driverProofMedia.update({
        data: { deletedAt },
        where: { id: media.id }
      });
      deleted += 1;
    }

    return {
      deleted,
      missingFiles,
      scanned: expiredMedia.length
    };
  }

  private async recordScanResult(input: {
    contentType: string;
    mediaId: string;
    scanResult: DriverProofMediaScanResult;
    scannedAt: Date;
    sha256: string;
    storageKey: string;
  }): Promise<void> {
    if (input.scanResult.status === 'rejected') {
      await this.scanMonitor?.recordProofMediaScan({
        contentType: input.contentType,
        mediaId: input.mediaId,
        reason: input.scanResult.reason,
        scannedAt: input.scannedAt,
        sha256: input.sha256,
        status: input.scanResult.status,
        storageKey: input.storageKey
      });
      return;
    }

    await this.scanMonitor?.recordProofMediaScan({
      contentType: input.contentType,
      mediaId: input.mediaId,
      scannedAt: input.scannedAt,
      sha256: input.sha256,
      status: input.scanResult.status,
      storageKey: input.storageKey
    });
  }
}

function createLocalDriverProofMediaStorage(storageRoot: string): DriverProofMediaStorageBackend {
  return {
    remove: async (storageKey) => removeStoredFile(storageRoot, storageKey),
    write: async ({ fileBytes, storageKey }) => writeStoredFile(storageRoot, storageKey, fileBytes)
  };
}

async function writeStoredFile(storageRoot: string, storageKey: string, fileBytes: Buffer): Promise<void> {
  const target = resolveStoredFilePath(storageRoot, storageKey);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, fileBytes, { flag: 'wx' });
}

async function removeStoredFile(storageRoot: string, storageKey: string): Promise<'missing' | 'removed'> {
  const target = resolveStoredFilePath(storageRoot, storageKey);
  try {
    await rm(target);
    return 'removed';
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return 'missing';
    }

    throw error;
  }
}

function resolveStoredFilePath(storageRoot: string, storageKey: string): string {
  const root = resolve(storageRoot);
  const target = resolve(root, ...storageKey.split('/'));

  if (target !== root && target.startsWith(`${root}${sep}`)) {
    return target;
  }

  throw new Error('Proof media storage key escapes storage root');
}

function requireStorageRoot(storageRoot: string | undefined): string {
  if (storageRoot === undefined || storageRoot.trim() === '') {
    throw new Error('Driver proof media storage requires storageRoot or storage backend');
  }

  return storageRoot;
}

function buildStorageKey(input: {
  deliveryStopId: string;
  extension: string;
  mediaId: string;
  routePlanId: string;
  shopDomain: string;
}): string {
  return [
    'driver-proof',
    input.shopDomain,
    safePathSegment(input.routePlanId),
    safePathSegment(input.deliveryStopId),
    `${safePathSegment(input.mediaId)}${input.extension}`
  ].join('/');
}

function extensionFor(contentType: string, filename: string): string {
  const normalized = contentType.trim().toLowerCase();
  if (normalized === 'image/jpeg') {
    return '.jpg';
  }
  if (normalized === 'image/png') {
    return '.png';
  }
  if (normalized === 'image/heic' || normalized === 'image/heif') {
    return '.heic';
  }

  const match = /\.([a-z0-9]{1,8})$/iu.exec(filename.trim());
  return match?.[1] === undefined ? '.bin' : `.${match[1].toLowerCase()}`;
}

function sanitizeProofMediaBytes(contentType: string, fileBytes: Buffer): Buffer {
  if (contentType.trim().toLowerCase() !== 'image/jpeg') {
    return fileBytes;
  }

  return stripJpegExifApp1Segments(fileBytes);
}

function stripJpegExifApp1Segments(fileBytes: Buffer): Buffer {
  if (fileBytes.length < 4 || fileBytes[0] !== 0xff || fileBytes[1] !== 0xd8) {
    return fileBytes;
  }

  const chunks: Buffer[] = [fileBytes.subarray(0, 2)];
  let offset = 2;
  let stripped = false;

  while (offset < fileBytes.length) {
    if (fileBytes[offset] !== 0xff) {
      chunks.push(fileBytes.subarray(offset));
      break;
    }

    const markerStart = offset;
    while (offset < fileBytes.length && fileBytes[offset] === 0xff) {
      offset += 1;
    }

    const marker = fileBytes[offset];
    if (marker === undefined) {
      chunks.push(fileBytes.subarray(markerStart));
      break;
    }
    offset += 1;

    if (marker === 0xda || marker === 0xd9) {
      chunks.push(fileBytes.subarray(markerStart));
      break;
    }

    if (offset + 2 > fileBytes.length) {
      return fileBytes;
    }

    const segmentLength = fileBytes.readUInt16BE(offset);
    if (segmentLength < 2) {
      return fileBytes;
    }

    const segmentEnd = offset + segmentLength;
    if (segmentEnd > fileBytes.length) {
      return fileBytes;
    }

    const payloadStart = offset + 2;
    const isExifApp1 = marker === 0xe1 && fileBytes.subarray(payloadStart, payloadStart + 6).equals(Buffer.from('Exif\0\0'));
    if (isExifApp1) {
      stripped = true;
    } else {
      chunks.push(fileBytes.subarray(markerStart, segmentEnd));
    }
    offset = segmentEnd;
  }

  return stripped ? Buffer.concat(chunks) : fileBytes;
}

function toPrismaSource(source: DriverProofMediaSource): PrismaProofMediaSource {
  return source === 'camera' ? 'CAMERA' : 'LIBRARY';
}

function toProofMediaKind(kind: string): 'photo' {
  if (kind === 'PHOTO') {
    return 'photo';
  }

  throw new Error(`Unsupported driver proof media kind: ${kind}`);
}

function safePathSegment(value: string): string {
  if (!/^[a-zA-Z0-9._-]+$/u.test(value)) {
    throw new Error('Storage path segment contains unsupported characters');
  }

  return value;
}

function normalizeShopDomain(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const withoutProtocol = trimmed.replace(/^https?:\/\//u, '').replace(/\/$/u, '');

  if (!withoutProtocol.endsWith('.myshopify.com')) {
    throw new Error('Shop domain must end with .myshopify.com');
  }

  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/u.test(withoutProtocol)) {
    throw new Error('Shop domain is not a valid myshopify.com domain');
  }

  return withoutProtocol;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}
