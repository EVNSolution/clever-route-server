ALTER TYPE "DriverProofMediaUploadStatus" ADD VALUE 'CLEANING' BEFORE 'READY';

ALTER TABLE "driver_proof_media"
  ADD COLUMN "cleanupToken" TEXT,
  ADD COLUMN "cleanupClaimedAt" TIMESTAMPTZ(6);

DROP INDEX "driver_proof_media_uploadStatus_createdAt_idx";
CREATE INDEX "driver_proof_media_uploadStatus_cleanupClaimedAt_createdAt_idx"
  ON "driver_proof_media"("uploadStatus", "cleanupClaimedAt", "createdAt");
