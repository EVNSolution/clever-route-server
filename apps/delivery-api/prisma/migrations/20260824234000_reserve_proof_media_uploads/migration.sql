CREATE TYPE "DriverProofMediaUploadStatus" AS ENUM ('PENDING_UPLOAD', 'READY');

ALTER TABLE "driver_proof_media"
  ADD COLUMN "uploadStatus" "DriverProofMediaUploadStatus" NOT NULL DEFAULT 'READY';

CREATE INDEX "driver_proof_media_uploadStatus_createdAt_idx"
  ON "driver_proof_media"("uploadStatus", "createdAt");
