import { PrismaClient } from '@prisma/client';

import {
  calculatePendingProofMediaCleanupCutoff,
  runDriverProofMediaRetentionCleanup
} from '../modules/driver/driver-proof-media.cleanup.js';
import { PrismaDriverProofMediaRepository } from '../modules/driver/driver-proof-media.repository.js';
import { PrismaDriverProofMediaCleanupMonitor } from '../modules/driver/driver-proof-media-retention-job.repository.js';
import {
  loadDriverProofMediaRetentionPolicy,
  loadDriverProofMediaRepositoryStorageOptions
} from '../modules/driver/driver.dependencies.js';
import { redactTelemetryMessage, safeErrorCode } from '../modules/security/safe-telemetry-redaction.js';

const prisma = new PrismaClient();

try {
  const retentionPolicy = loadDriverProofMediaRetentionPolicy(process.env);
  const repository = new PrismaDriverProofMediaRepository(prisma, {
    ...loadDriverProofMediaRepositoryStorageOptions(process.env)
  });
  const cleanupMonitor = new PrismaDriverProofMediaCleanupMonitor(prisma, {
    evidenceRef: process.env.DRIVER_PROOF_MEDIA_CLEANUP_EVIDENCE_REF
  });
  const cleanupStartedAt = new Date();
  const deadlineAt = Math.min(
    readRetentionDeadline(process.env.RETENTION_DEADLINE_EPOCH_MS) ?? Number.POSITIVE_INFINITY,
    Date.now() + 2 * 60 * 1000
  );
  const pendingCutoff = calculatePendingProofMediaCleanupCutoff(cleanupStartedAt);
  let pendingDeletedReservations = 0;
  let pendingMissingFiles = 0;
  let pendingScanned = 0;
  let pendingContinuationRequired = false;
  const pendingMaxRows = 1_000;
  while (pendingScanned < pendingMaxRows) {
    if (Date.now() >= deadlineAt) {
      pendingContinuationRequired = true;
      break;
    }
    const limit = Math.min(10, pendingMaxRows - pendingScanned);
    const pending = await repository.deleteStalePendingProofMedia({ createdBefore: pendingCutoff, limit });
    pendingDeletedReservations += pending.deletedReservations;
    pendingMissingFiles += pending.missingFiles;
    pendingScanned += pending.scanned;
    if (pending.scanned < limit) break;
    if (pendingScanned >= pendingMaxRows) pendingContinuationRequired = true;
  }
  const result = await runDriverProofMediaRetentionCleanup({
    cleanupMonitor,
    deadlineAt,
    limit: 10,
    maxRows: 1_000,
    proofMediaRepository: repository,
    retentionPolicy
  });

  console.log(JSON.stringify({
    deleted: result.deleted,
    deletedAt: result.deletedAt.toISOString(),
    evidenceRecorded: true,
    continuationRequired: result.continuationRequired,
    missingFiles: result.missingFiles,
    pendingContinuationRequired,
    pendingDeletedReservations,
    pendingMissingFiles,
    pendingScanned,
    scanned: result.scanned,
    uploadedBefore: result.uploadedBefore.toISOString()
  }));
  if (result.continuationRequired || pendingContinuationRequired) process.exitCode = 75;
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    code: safeErrorCode(error instanceof Error ? error.name : 'UNKNOWN'),
    event: 'driver_proof_media_retention_cleanup_failed',
    message: redactTelemetryMessage(error)
  })}\n`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}

function readRetentionDeadline(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= Date.now()) throw new Error('RETENTION_DEADLINE_EPOCH_MS is invalid or expired');
  return parsed;
}
