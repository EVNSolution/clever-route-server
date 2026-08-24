import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { Prisma, type PrismaClient } from '@prisma/client';
import { normalizeDriverCommerceDomain } from './driver-commerce-domain.js';

import {
  DriverProofMediaAccessUnavailableError,
  DriverProofMediaIdempotencyConflictError,
  DriverProofMediaIdempotencyPendingError,
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
import { ROUTE_DRIVER_VISIBLE_STATUSES } from '../route-plans/route-plan-lifecycle.js';
import { safeErrorCode } from '../security/safe-telemetry-redaction.js';

type DriverProofMediaPrismaClient = Pick<
  PrismaClient,
  'driverProofMedia' | 'routePlan' | 'routePlanStop'
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
  remove(storageKey: string, signal: AbortSignal): Promise<'missing' | 'removed'>;
  write(input: DriverProofMediaStorageWriteInput, signal: AbortSignal): Promise<void>;
};

type DriverProofMediaRepositoryOptions = {
  cleanupLogger?: DriverProofMediaCleanupLogger;
  createMediaId?: () => string;
  now?: () => Date;
  readAccessTtlSeconds?: number;
  reservationWritesEnabled?: boolean;
  scanMonitor?: DriverProofMediaScanMonitor;
  scanner?: DriverProofMediaScanner;
  storage?: DriverProofMediaStorageBackend;
  storageRemoveTimeoutMs?: number;
  storageWriteTimeoutMs?: number;
  storageRoot?: string;
};

type DriverProofMediaCleanupLogger = {
  error(details: Record<string, unknown>, message: string): void;
};

const DEFAULT_READ_ACCESS_TTL_SECONDS = 5 * 60;
const PENDING_CLEANUP_LEASE_MS = 15 * 60 * 1000;
const DEFAULT_STORAGE_WRITE_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_STORAGE_REMOVE_TIMEOUT_MS = 5 * 1000;
const PENDING_UPLOAD_RETENTION_MS = 24 * 60 * 60 * 1000;
const IDEMPOTENCY_POLL_INTERVAL_MS = 25;
const LATE_UPLOAD_POSSIBLE_TOKEN_PREFIX = 'late-upload-possible:';
const LATE_UPLOAD_SETTLED_TOKEN_PREFIX = 'late-upload-settled:';

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

export type DeleteStalePendingProofMediaResult = {
  deletedReservations: number;
  missingFiles: number;
  scanned: number;
};

export class PrismaDriverProofMediaRepository {
  private readonly createMediaId: () => string;
  private readonly cleanupLogger: DriverProofMediaCleanupLogger;
  private readonly now: () => Date;
  private readonly readAccessTtlSeconds: number;
  private readonly reservationWritesEnabled: boolean;
  private readonly scanMonitor: DriverProofMediaScanMonitor | undefined;
  private readonly scanner: DriverProofMediaScanner | undefined;
  private readonly storage: DriverProofMediaStorageBackend;
  private readonly storageRemoveTimeoutMs: number;
  private readonly storageWriteTimeoutMs: number;

  constructor(
    private readonly prisma: DriverProofMediaPrismaClient,
    options: DriverProofMediaRepositoryOptions
  ) {
    this.cleanupLogger = options.cleanupLogger ?? STDERR_CLEANUP_LOGGER;
    this.createMediaId = options.createMediaId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
    this.readAccessTtlSeconds = options.readAccessTtlSeconds ?? DEFAULT_READ_ACCESS_TTL_SECONDS;
    this.reservationWritesEnabled = options.reservationWritesEnabled ?? true;
    this.scanMonitor = options.scanMonitor;
    this.scanner = options.scanner;
    this.storage = options.storage ?? createLocalDriverProofMediaStorage(requireStorageRoot(options.storageRoot));
    this.storageRemoveTimeoutMs = normalizeStorageRemoveTimeout(options.storageRemoveTimeoutMs);
    this.storageWriteTimeoutMs = normalizeStorageWriteTimeout(options.storageWriteTimeoutMs);
  }

  async createProofMediaReadAccess(
    input: CreateDriverProofMediaReadAccessInput
  ): Promise<CreateDriverProofMediaReadAccessResult> {
    const media = await this.prisma.driverProofMedia.findFirst({
      where: {
        deletedAt: null,
        driverId: input.driverId,
        id: input.mediaId,
        routePlanId: input.routePlanId,
        shopId: input.shopId,
        uploadStatus: 'READY'
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
    if (!this.reservationWritesEnabled) {
      throw new DriverProofMediaAccessUnavailableError('Proof media uploads are paused during storage rollout.');
    }
    const shopDomain = normalizeDriverCommerceDomain(input.shopDomain);

    const routePlan = await this.prisma.routePlan.findFirst({
      where: {
        driverId: input.driverId,
        id: input.routePlanId,
        shopId: input.shopId,
        status: { in: [...ROUTE_DRIVER_VISIBLE_STATUSES] }
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

    if (input.idempotencyKey !== undefined) {
      const existing = await this.findIdempotentProofMedia(input);
      if (existing !== null) {
        assertIdempotentProofMediaIdentity(existing, input, sha256, storedFileBytes.byteLength);
        return this.awaitIdempotentProofMedia(existing.id, input, sha256, storedFileBytes.byteLength);
      }
    }
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

    try {
      await this.prisma.driverProofMedia.create({
        data: {
        contentType: input.contentType,
        deliveryStopId: input.deliveryStopId,
        driverId: input.driverId,
        id: mediaId,
        ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
        kind: 'PHOTO',
        originalFilename: input.filename,
        routePlanId: input.routePlanId,
        sha256,
        shopId: input.shopId,
        sizeBytes: storedFileBytes.byteLength,
        source: toPrismaSource(input.source),
        storageKey,
        uploadStatus: 'PENDING_UPLOAD',
        uploadedAt
        }
      });
    } catch (error) {
      if (input.idempotencyKey === undefined || !isUniqueConstraintError(error)) throw error;
      const existing = await this.findIdempotentProofMedia(input);
      if (existing === null) throw error;
      assertIdempotentProofMediaIdentity(existing, input, sha256, storedFileBytes.byteLength);
      return this.awaitIdempotentProofMedia(existing.id, input, sha256, storedFileBytes.byteLength);
    }

    const writeAbortController = new AbortController();
    let writeTimeout: ReturnType<typeof setTimeout> | undefined;
    const writeDeadline = new Promise<never>((_resolve, reject) => {
      writeTimeout = setTimeout(() => {
        writeAbortController.abort();
        reject(new DriverProofMediaStorageWriteTimeoutError());
      }, this.storageWriteTimeoutMs);
    });
    const storageWrite = this.storage.write(
      { fileBytes: storedFileBytes, storageKey },
      writeAbortController.signal
    );
    try {
      await Promise.race([
        storageWrite,
        writeDeadline
      ]);
    } catch (storageError) {
      if (storageError instanceof DriverProofMediaStorageWriteTimeoutError) {
        const lateUploadCleanupNotBefore = new Date(uploadedAt.getTime() + PENDING_UPLOAD_RETENTION_MS);
        await this.prisma.driverProofMedia.updateMany({
          data: {
            cleanupClaimedAt: lateUploadCleanupNotBefore,
            cleanupToken: `${LATE_UPLOAD_POSSIBLE_TOKEN_PREFIX}${randomUUID()}`,
            uploadStatus: 'CLEANING'
          },
          where: { id: mediaId, uploadStatus: 'PENDING_UPLOAD' }
        });
        void storageWrite.then(
          () => this.removeLateTimedOutUpload(mediaId, storageKey),
          () => this.removeLateTimedOutUpload(mediaId, storageKey)
        );
        throw storageError;
      }
      let cleanupSucceeded = false;
      try {
        await this.removeStorageObject(storageKey);
        cleanupSucceeded = true;
      } catch (cleanupError) {
        this.cleanupLogger.error({
          cleanupErrorCode: errorNameCode(cleanupError),
          storageErrorCode: errorNameCode(storageError),
          event: 'driver_proof_media_orphan_cleanup_failed',
          mediaId
        }, 'Failed to remove unfinalized proof media after storage failure');
      }
      if (cleanupSucceeded) {
        await this.prisma.driverProofMedia.deleteMany({
          where: { id: mediaId, uploadStatus: 'PENDING_UPLOAD' }
        });
      }
      throw storageError;
    } finally {
      if (writeTimeout !== undefined) clearTimeout(writeTimeout);
    }

    const finalized = await this.prisma.driverProofMedia.updateMany({
      data: { cleanupClaimedAt: null, cleanupToken: null, uploadStatus: 'READY' },
      where: { id: mediaId, uploadStatus: 'PENDING_UPLOAD' }
    });
    if (finalized.count !== 1) {
      try {
        await this.removeStorageObject(storageKey);
        await this.prisma.driverProofMedia.deleteMany({
          where: { id: mediaId, uploadStatus: { in: ['PENDING_UPLOAD', 'CLEANING'] } }
        });
      } catch (cleanupError) {
        this.cleanupLogger.error({
          cleanupErrorCode: errorNameCode(cleanupError),
          event: 'driver_proof_media_lost_finalize_cleanup_failed',
          mediaId
        }, 'Failed to remove proof media after upload finalization lost its reservation');
      }
      throw new Error('Proof media upload reservation could not be finalized');
    }

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

  private async removeLateTimedOutUpload(mediaId: string, storageKey: string): Promise<void> {
    const cleanupToken = `${LATE_UPLOAD_SETTLED_TOKEN_PREFIX}${randomUUID()}`;
    try {
      const settled = await this.prisma.driverProofMedia.updateMany({
        data: { cleanupClaimedAt: this.now(), cleanupToken },
        where: {
          cleanupToken: { startsWith: LATE_UPLOAD_POSSIBLE_TOKEN_PREFIX },
          id: mediaId,
          uploadStatus: 'CLEANING'
        }
      });
      if (settled.count !== 1) return;
      await this.removeStorageObject(storageKey);
      await this.prisma.driverProofMedia.deleteMany({
        where: { cleanupToken, id: mediaId, uploadStatus: 'CLEANING' }
      });
    } catch (cleanupError) {
      this.cleanupLogger.error({
        cleanupErrorCode: errorNameCode(cleanupError),
        event: 'driver_proof_media_late_upload_cleanup_failed',
        mediaId
      }, 'Failed to remove proof media after a timed-out upload completed late');
    }
  }

  private findIdempotentProofMedia(input: StoreDriverProofMediaInput) {
    if (input.idempotencyKey === undefined) return Promise.resolve(null);
    return this.prisma.driverProofMedia.findFirst({
      where: {
        deliveryStopId: input.deliveryStopId,
        driverId: input.driverId,
        idempotencyKey: input.idempotencyKey,
        routePlanId: input.routePlanId,
        shopId: input.shopId
      }
    });
  }

  private async awaitIdempotentProofMedia(
    mediaId: string,
    input: StoreDriverProofMediaInput,
    sha256: string,
    sizeBytes: number
  ): Promise<StoreDriverProofMediaResult> {
    const deadline = Date.now() + this.storageWriteTimeoutMs + 1_000;
    for (;;) {
      const media = await this.prisma.driverProofMedia.findFirst({ where: { id: mediaId } });
      if (media === null) throw new DriverProofMediaIdempotencyPendingError();
      assertIdempotentProofMediaIdentity(media, input, sha256, sizeBytes);
      if (media.uploadStatus === 'READY') return toStoreProofMediaResult(media);
      if (media.uploadStatus === 'CLEANING' || Date.now() >= deadline) {
        throw new DriverProofMediaIdempotencyPendingError();
      }
      await delay(IDEMPOTENCY_POLL_INTERVAL_MS);
    }
  }

  async deleteExpiredProofMedia(input: DeleteExpiredProofMediaInput): Promise<DeleteExpiredProofMediaResult> {
    const deletedAt = input.deletedAt ?? this.now();
    const expiredMedia = await this.prisma.driverProofMedia.findMany({
      orderBy: { uploadedAt: 'asc' },
      take: input.limit ?? 100,
      where: {
        deletedAt: null,
        uploadedAt: { lt: input.uploadedBefore },
        uploadStatus: 'READY'
      }
    });

    let deleted = 0;
    let missingFiles = 0;

    for (const media of expiredMedia) {
      const removeResult = await this.removeStorageObject(media.storageKey);
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

  async deleteStalePendingProofMedia(input: {
    createdBefore: Date;
    limit?: number | undefined;
    now?: Date | undefined;
  }): Promise<DeleteStalePendingProofMediaResult> {
    const now = input.now ?? this.now();
    const staleCleanupClaimedBefore = new Date(now.getTime() - PENDING_CLEANUP_LEASE_MS);
    const pending = await this.prisma.driverProofMedia.findMany({
      orderBy: { createdAt: 'asc' },
      take: input.limit ?? 100,
      where: {
        createdAt: { lt: input.createdBefore },
        OR: [
          { uploadStatus: 'PENDING_UPLOAD' },
          { cleanupClaimedAt: { lt: staleCleanupClaimedBefore }, uploadStatus: 'CLEANING' }
        ]
      }
    });
    let deletedReservations = 0;
    let missingFiles = 0;
    for (const media of pending) {
      const priorCleanupToken = media.cleanupToken;
      const lateUploadPossible = priorCleanupToken?.startsWith(LATE_UPLOAD_POSSIBLE_TOKEN_PREFIX) === true;
      const lateUploadSettled = priorCleanupToken?.startsWith(LATE_UPLOAD_SETTLED_TOKEN_PREFIX) === true;
      const cleanupToken = lateUploadPossible || lateUploadSettled ? priorCleanupToken : randomUUID();
      const claimed = await this.prisma.driverProofMedia.updateMany({
        data: { cleanupClaimedAt: now, cleanupToken, uploadStatus: 'CLEANING' },
        where: {
          id: media.id,
          OR: [
            { createdAt: { lt: input.createdBefore }, uploadStatus: 'PENDING_UPLOAD' },
            { cleanupClaimedAt: { lt: staleCleanupClaimedBefore }, uploadStatus: 'CLEANING' }
          ]
        }
      });
      if (claimed.count !== 1) continue;
      const removed = await this.removeStorageObject(media.storageKey);
      if (removed === 'missing') missingFiles += 1;
      if (media.uploadStatus === 'CLEANING' && !lateUploadPossible) {
        const deleted = await this.prisma.driverProofMedia.deleteMany({
          where: { cleanupToken, id: media.id, uploadStatus: 'CLEANING' }
        });
        deletedReservations += deleted.count;
      }
    }
    return { deletedReservations, missingFiles, scanned: pending.length };
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

  private async removeStorageObject(storageKey: string): Promise<'missing' | 'removed'> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutFailure = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error('Proof media storage delete timed out'));
      }, this.storageRemoveTimeoutMs);
    });
    try {
      return await Promise.race([this.storage.remove(storageKey, controller.signal), timeoutFailure]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }
}

class DriverProofMediaStorageWriteTimeoutError extends Error {
  constructor() {
    super('Proof media storage write timed out');
    this.name = 'DriverProofMediaStorageWriteTimeoutError';
  }
}

const STDERR_CLEANUP_LOGGER: DriverProofMediaCleanupLogger = {
  error(details, message) {
    process.stderr.write(`${JSON.stringify({ ...details, message })}\n`);
  }
};

function errorNameCode(error: unknown): string {
  return safeErrorCode(error instanceof Error ? error.name : 'UNKNOWN');
}

function createLocalDriverProofMediaStorage(storageRoot: string): DriverProofMediaStorageBackend {
  return {
    remove: async (storageKey) => removeStoredFile(storageRoot, storageKey),
    write: async ({ fileBytes, storageKey }, signal) => writeStoredFile(storageRoot, storageKey, fileBytes, signal)
  };
}

function normalizeStorageRemoveTimeout(timeoutMs: number | undefined): number {
  const value = timeoutMs ?? DEFAULT_STORAGE_REMOVE_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value < 1_000 || value >= PENDING_UPLOAD_RETENTION_MS) {
    throw new Error('Proof media storage delete timeout must be between 1000ms and the pending upload retention window');
  }
  return value;
}

async function writeStoredFile(
  storageRoot: string,
  storageKey: string,
  fileBytes: Buffer,
  signal: AbortSignal
): Promise<void> {
  const target = resolveStoredFilePath(storageRoot, storageKey);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, fileBytes, { flag: 'wx', signal });
}

function normalizeStorageWriteTimeout(timeoutMs: number | undefined): number {
  const normalized = timeoutMs ?? DEFAULT_STORAGE_WRITE_TIMEOUT_MS;
  if (!Number.isSafeInteger(normalized) || normalized < 1 || normalized >= PENDING_CLEANUP_LEASE_MS) {
    throw new Error('Driver proof media storage write timeout must be between 1ms and the cleanup lease');
  }
  return normalized;
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

function toStoreProofMediaResult(media: {
  contentType: string;
  id: string;
  kind: string;
  sha256: string;
  sizeBytes: number;
  source: string;
  storageKey: string;
  uploadedAt: Date;
}): StoreDriverProofMediaResult {
  return {
    contentType: media.contentType,
    kind: toProofMediaKind(media.kind),
    mediaId: media.id,
    sha256: media.sha256,
    sizeBytes: media.sizeBytes,
    source: media.source === 'CAMERA' ? 'camera' : 'library',
    storageKey: media.storageKey,
    uploadedAt: media.uploadedAt.toISOString()
  };
}

function assertIdempotentProofMediaIdentity(
  media: {
    contentType: string;
    originalFilename: string | null;
    sha256: string;
    sizeBytes: number;
    source: string;
  },
  input: StoreDriverProofMediaInput,
  sha256: string,
  sizeBytes: number
): void {
  if (
    media.contentType !== input.contentType
    || media.originalFilename !== input.filename
    || media.sha256 !== sha256
    || media.sizeBytes !== sizeBytes
    || media.source !== toPrismaSource(input.source)
  ) {
    throw new DriverProofMediaIdempotencyConflictError();
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function safePathSegment(value: string): string {
  if (!/^[a-zA-Z0-9._-]+$/u.test(value)) {
    throw new Error('Storage path segment contains unsupported characters');
  }

  return value;
}


function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}
