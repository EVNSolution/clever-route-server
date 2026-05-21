import type {
  DeleteExpiredProofMediaInput,
  DeleteExpiredProofMediaResult
} from './driver-proof-media.repository.js';
import type { DriverProofMediaRetentionPolicy } from './driver.dependencies.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export type DriverProofMediaCleanupRepository = {
  deleteExpiredProofMedia(input: DeleteExpiredProofMediaInput): Promise<DeleteExpiredProofMediaResult>;
};

export type DriverProofMediaCleanupResult = DeleteExpiredProofMediaResult & {
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

export async function runDriverProofMediaRetentionCleanup(input: {
  cleanupMonitor?: DriverProofMediaCleanupMonitor;
  limit?: number;
  now?: () => Date;
  proofMediaRepository: DriverProofMediaCleanupRepository;
  retentionPolicy: DriverProofMediaRetentionPolicy;
}): Promise<DriverProofMediaCleanupResult> {
  const deletedAt = input.now?.() ?? new Date();
  const uploadedBefore = calculateProofMediaCleanupCutoff({
    now: deletedAt,
    retentionDays: input.retentionPolicy.retentionDays
  });
  const result = await input.proofMediaRepository.deleteExpiredProofMedia({
    deletedAt,
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    uploadedBefore
  });

  const cleanupResult = {
    ...result,
    deletedAt,
    uploadedBefore
  };

  await input.cleanupMonitor?.recordProofMediaCleanup({
    ...cleanupResult,
    limit: input.limit ?? null,
    retentionDays: input.retentionPolicy.retentionDays
  });

  return cleanupResult;
}
