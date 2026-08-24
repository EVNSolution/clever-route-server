import { PrismaClient } from '@prisma/client';
import { cleanupResolvedDriverEventAttempts, parseRetentionDeadline } from '../modules/driver/driver-event-attempt-retention.js';
import { cleanupRouteOperationalEvidence } from '../modules/operations/route-operational-evidence-retention.js';

const prisma = new PrismaClient();
try {
  const deadlineAt = parseRetentionDeadline(process.env.RETENTION_DEADLINE_EPOCH_MS);
  const result = await cleanupResolvedDriverEventAttempts(prisma, new Date(), {
    ...(deadlineAt === undefined ? {} : { deadlineAt })
  });
  process.stdout.write(`${JSON.stringify({ ...result, event: 'driver_event_attempt_retention_cleanup' })}\n`);
  const operational = await cleanupRouteOperationalEvidence(prisma, new Date(), {
    ...(deadlineAt === undefined ? {} : { deadlineAt })
  });
  process.stdout.write(`${JSON.stringify({ ...operational, event: 'route_operational_evidence_retention_cleanup' })}\n`);
  if (
    result.continuationRequired
    || operational.alertCyclesContinuationRequired
    || operational.locationContinuationRequired
    || operational.notificationAttemptReconciliationContinuationRequired
    || operational.notificationAttemptsContinuationRequired
    || operational.syncContinuationRequired
  ) process.exitCode = 75;
} finally {
  await prisma.$disconnect();
}
