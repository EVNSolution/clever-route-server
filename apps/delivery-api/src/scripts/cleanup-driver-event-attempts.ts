import { PrismaClient } from '@prisma/client';
import { cleanupResolvedDriverEventAttempts, parseRetentionDeadline } from '../modules/driver/driver-event-attempt-retention.js';
import { cleanupReviewedRouteCompletionEvidence } from '../modules/driver/driver-route-completion-review-retention.js';
import { cleanupRouteOperationalEvidence } from '../modules/operations/route-operational-evidence-retention.js';
import { redactTelemetryMessage, safeErrorCode } from '../modules/security/safe-telemetry-redaction.js';

const prisma = new PrismaClient();
try {
  const deadlineAt = parseRetentionDeadline(process.env.RETENTION_DEADLINE_EPOCH_MS);
  const result = await cleanupResolvedDriverEventAttempts(prisma, new Date(), {
    ...(deadlineAt === undefined ? {} : { deadlineAt })
  });
  process.stdout.write(`${JSON.stringify({ ...result, event: 'driver_event_attempt_retention_cleanup' })}\n`);
  const completionReviews = await cleanupReviewedRouteCompletionEvidence(prisma, new Date());
  process.stdout.write(`${JSON.stringify({ ...completionReviews, event: 'driver_route_completion_review_retention_cleanup' })}\n`);
  const operational = await cleanupRouteOperationalEvidence(prisma, new Date(), {
    ...(deadlineAt === undefined ? {} : { deadlineAt })
  });
  process.stdout.write(`${JSON.stringify({ ...operational, event: 'route_operational_evidence_retention_cleanup' })}\n`);
  if (
    result.continuationRequired
    || completionReviews.continuationRequired
    || operational.alertCyclesContinuationRequired
    || operational.locationContinuationRequired
    || operational.notificationAttemptReconciliationContinuationRequired
    || operational.notificationAttemptsContinuationRequired
    || operational.syncContinuationRequired
  ) process.exitCode = 75;
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    code: safeErrorCode(error instanceof Error ? error.name : 'UNKNOWN'),
    event: 'driver_event_attempt_retention_cleanup_failed',
    message: redactTelemetryMessage('Driver event attempt retention cleanup failed')
  })}\n`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
