-- Keep the existing report as its single email job. Existing reports are not
-- automatically queued, and neither reports nor email evidence have a TTL.
ALTER TABLE "dsv_delivery_exceptions"
  ADD COLUMN "emailStatus" TEXT NOT NULL DEFAULT 'NOT_PREPARED',
  ADD COLUMN "emailSnapshot" JSONB,
  ADD COLUMN "emailRecipient" TEXT,
  ADD COLUMN "emailSender" TEXT,
  ADD COLUMN "emailSentAt" TIMESTAMPTZ(6),
  ADD COLUMN "emailMessageId" TEXT;
