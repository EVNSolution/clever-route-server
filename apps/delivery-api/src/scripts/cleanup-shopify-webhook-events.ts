import { PrismaClient } from '@prisma/client';

import {
  cleanupTerminalShopifyWebhookEvents,
  loadShopifyWebhookTerminalRetentionDays
} from '../modules/shopify/webhook-event-retention.js';
import { PrismaShopifyWebhookEventRepository } from '../modules/shopify/webhook-event.repository.js';
import { redactTelemetryMessage, safeErrorCode } from '../modules/security/safe-telemetry-redaction.js';

const prisma = new PrismaClient();
const startedAt = new Date();
const deadlineAt = Math.min(
  readRetentionDeadline(process.env.RETENTION_DEADLINE_EPOCH_MS) ?? Number.POSITIVE_INFINITY,
  Date.now() + 2 * 60 * 1000
);

try {
  const retentionDays = loadShopifyWebhookTerminalRetentionDays(process.env);
  const result = await cleanupTerminalShopifyWebhookEvents({
    deadlineAt,
    repository: new PrismaShopifyWebhookEventRepository(prisma),
    retentionDays
  });
  const finishedAt = new Date();
  await prisma.retentionJobRun.create({
    data: {
      deletedCount: result.deleted,
      finishedAt,
      jobName: 'shopify-webhook-terminal-retention',
      retentionDays,
      scannedCount: result.scanned,
      startedAt,
      status: 'SUCCEEDED',
      uploadedBefore: result.completedBefore
    }
  });
  process.stdout.write(`${JSON.stringify({
    completedBefore: result.completedBefore.toISOString(),
    continuationRequired: result.continuationRequired,
    deleted: result.deleted,
    event: 'shopify_webhook_terminal_retention_cleanup',
    scanned: result.scanned
  })}\n`);
  if (result.continuationRequired) process.exitCode = 75;
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    code: safeErrorCode(error instanceof Error ? error.name : 'UNKNOWN'),
    event: 'shopify_webhook_terminal_retention_cleanup_failed',
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
