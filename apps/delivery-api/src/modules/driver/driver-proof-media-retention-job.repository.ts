import type { PrismaClient } from '@prisma/client';

import type { DriverProofMediaCleanupMonitor, DriverProofMediaCleanupMonitorInput } from './driver-proof-media.cleanup.js';

const DEFAULT_PROOF_MEDIA_CLEANUP_JOB_NAME = 'driver-proof-media-retention-cleanup';

type RetentionJobRunPrismaClient = Pick<PrismaClient, 'retentionJobRun'>;

type PrismaDriverProofMediaCleanupMonitorOptions = {
  evidenceRef?: string | undefined;
  jobName?: string | undefined;
};

export class PrismaDriverProofMediaCleanupMonitor implements DriverProofMediaCleanupMonitor {
  private readonly evidenceRef: string | undefined;
  private readonly jobName: string;

  constructor(
    private readonly prisma: RetentionJobRunPrismaClient,
    options: PrismaDriverProofMediaCleanupMonitorOptions = {}
  ) {
    this.evidenceRef = readOptional(options.evidenceRef);
    this.jobName = readOptional(options.jobName) ?? DEFAULT_PROOF_MEDIA_CLEANUP_JOB_NAME;
  }

  async recordProofMediaCleanup(input: DriverProofMediaCleanupMonitorInput): Promise<void> {
    await this.prisma.retentionJobRun.create({
      data: {
        batchLimit: input.limit,
        deletedCount: input.deleted,
        ...(this.evidenceRef === undefined ? {} : { evidenceRef: this.evidenceRef }),
        finishedAt: input.deletedAt,
        jobName: this.jobName,
        missingFilesCount: input.missingFiles,
        retentionDays: input.retentionDays,
        scannedCount: input.scanned,
        startedAt: input.deletedAt,
        status: 'SUCCEEDED',
        uploadedBefore: input.uploadedBefore
      }
    });
  }
}

function readOptional(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }

  return value.trim();
}
