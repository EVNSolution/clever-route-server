import type {
  DeleteExpiredProofMediaInput,
  DeleteExpiredProofMediaResult
} from './driver-proof-media.repository.js';
import type { DriverProofMediaRetentionPolicy } from './driver.dependencies.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
export const DRIVER_PROOF_MEDIA_PENDING_UPLOAD_RETENTION_HOURS = 24;

export type DriverProofMediaCleanupRepository = {
  deleteExpiredProofMedia(input: DeleteExpiredProofMediaInput): Promise<DeleteExpiredProofMediaResult>;
};

export type DriverProofMediaCleanupResult = DeleteExpiredProofMediaResult & {
  continuationRequired: boolean;
  deletedAt: Date;
  uploadedBefore: Date;
};

export type DriverProofMediaCleanupMonitorInput = DriverProofMediaCleanupResult & {
  limit: number | null;
  retentionDays: number;
};

export type DriverProofMediaCleanupMonitor = {
  recordProofMediaCleanup(input: DriverProofMediaCleanupMonitorInput): Promise<void>;
};

export function calculateProofMediaCleanupCutoff(input: {
  now: Date;
  retentionDays: number;
}): Date {
  return new Date(input.now.getTime() - input.retentionDays * DAY_MS);
}

export function calculatePendingProofMediaCleanupCutoff(now: Date): Date {
  return new Date(now.getTime() - DRIVER_PROOF_MEDIA_PENDING_UPLOAD_RETENTION_HOURS * HOUR_MS);
}

export async function runDriverProofMediaRetentionCleanup(input: {
  cleanupMonitor?: DriverProofMediaCleanupMonitor;
  deadlineAt?: number;
  limit?: number;
  maxRows?: number;
  now?: () => Date;
  proofMediaRepository: DriverProofMediaCleanupRepository;
  retentionPolicy: DriverProofMediaRetentionPolicy;
}): Promise<DriverProofMediaCleanupResult> {
  const deletedAt = input.now?.() ?? new Date();
  const uploadedBefore = calculateProofMediaCleanupCutoff({
    now: deletedAt,
    retentionDays: input.retentionPolicy.retentionDays
  });
  const batchSize = input.limit ?? 100;
  const maxRows = input.maxRows ?? 10_000;
  let deleted = 0;
  let missingFiles = 0;
  let scanned = 0;
  let continuationRequired = false;
  while (scanned < maxRows) {
    if (input.deadlineAt !== undefined && Date.now() >= input.deadlineAt) {
      continuationRequired = true;
      break;
    }
    const limit = Math.min(batchSize, maxRows - scanned);
    const result = await input.proofMediaRepository.deleteExpiredProofMedia({
      deletedAt,
      limit,
      uploadedBefore
    });
    deleted += result.deleted;
    missingFiles += result.missingFiles;
    scanned += result.scanned;
    if (result.scanned < limit) break;
    if (scanned >= maxRows) continuationRequired = true;
  }

  const cleanupResult = {
    continuationRequired,
    deleted,
    deletedAt,
    missingFiles,
    scanned,
    uploadedBefore
  };

  await input.cleanupMonitor?.recordProofMediaCleanup({
    ...cleanupResult,
    limit: batchSize,
    retentionDays: input.retentionPolicy.retentionDays
  });

  return cleanupResult;
}
