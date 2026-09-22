import { randomUUID } from 'node:crypto';

import { Prisma, type PrismaClient } from '@prisma/client';

import { readRouteTrackingGeometryDocument, type RouteTrackingGeometryDocumentV1 } from './route-tracking.geometry.js';
import { buildRouteTrackingRoadMatchCacheWrite } from './route-tracking.road-match.js';
import type { RouteTrackingRoadMatchedPathV1 } from './route-tracking.types.js';

export type RouteTrackingRoadMatchJob = {
  attemptCount: number;
  id: string;
  leaseToken: string;
  routePlanId: string;
  targetLastInputOccurredAt: Date;
  targetSourcePointCount: number;
};

type RouteTrackingRoadMatchJobPrismaClient = Pick<
  PrismaClient,
  '$transaction' | 'routeTrackingGeometry' | 'routeTrackingRoadMatchJob'
>;

type RouteTrackingRoadMatchEnqueueClient = Pick<Prisma.TransactionClient, 'routeTrackingRoadMatchJob'>;

const claimableWhere = (now: Date): Prisma.RouteTrackingRoadMatchJobWhereInput => ({
  OR: [
    { nextAttemptAt: { lte: now }, status: 'QUEUED' },
    { leaseExpiresAt: { lte: now }, status: 'PROCESSING' },
  ],
});

export async function enqueueRouteTrackingRoadMatch(
  prisma: RouteTrackingRoadMatchEnqueueClient,
  input: {
    lastInputOccurredAt: Date;
    now?: Date;
    routePlanId: string;
    sourcePointCount: number;
  },
): Promise<void> {
  const now = input.now ?? new Date();
  const current = await prisma.routeTrackingRoadMatchJob.findUnique({
    select: { id: true, status: true },
    where: { routePlanId: input.routePlanId },
  });
  if (current === null) {
    await prisma.routeTrackingRoadMatchJob.create({ data: {
      nextAttemptAt: now,
      routePlanId: input.routePlanId,
      targetLastInputOccurredAt: input.lastInputOccurredAt,
      targetSourcePointCount: input.sourcePointCount,
    } });
    return;
  }
  if (current.status === 'PROCESSING') {
    await prisma.routeTrackingRoadMatchJob.update({
      data: {
        completedAt: null,
        errorCode: null,
        errorMessage: null,
        targetLastInputOccurredAt: input.lastInputOccurredAt,
        targetSourcePointCount: input.sourcePointCount,
      },
      where: { id: current.id },
    });
    return;
  }
  await prisma.routeTrackingRoadMatchJob.update({
    data: {
      attemptCount: 0,
      completedAt: null,
      errorCode: null,
      errorMessage: null,
      leaseExpiresAt: null,
      leaseToken: null,
      nextAttemptAt: now,
      processingStartedAt: null,
      status: 'QUEUED',
      targetLastInputOccurredAt: input.lastInputOccurredAt,
      targetSourcePointCount: input.sourcePointCount,
    },
    where: { id: current.id },
  });
}

export class PrismaRouteTrackingRoadMatchJobRepository {
  constructor(private readonly prisma: RouteTrackingRoadMatchJobPrismaClient) {}

  async claimNext(input: { leaseMs: number; now: Date }): Promise<RouteTrackingRoadMatchJob | null> {
    for (let contentionAttempt = 0; contentionAttempt < 5; contentionAttempt += 1) {
      const job = await this.prisma.routeTrackingRoadMatchJob.findFirst({
        orderBy: [{ nextAttemptAt: 'asc' }, { updatedAt: 'asc' }, { id: 'asc' }],
        select: {
          attemptCount: true,
          id: true,
          routePlanId: true,
          targetLastInputOccurredAt: true,
          targetSourcePointCount: true,
        },
        where: claimableWhere(input.now),
      });
      if (job === null) return null;

      const leaseToken = randomUUID();
      const claimed = await this.prisma.routeTrackingRoadMatchJob.updateMany({
        data: {
          attemptCount: { increment: 1 },
          completedAt: null,
          errorCode: null,
          errorMessage: null,
          leaseExpiresAt: new Date(input.now.getTime() + input.leaseMs),
          leaseToken,
          nextAttemptAt: null,
          processingStartedAt: input.now,
          status: 'PROCESSING',
        },
        where: {
          id: job.id,
          targetLastInputOccurredAt: job.targetLastInputOccurredAt,
          targetSourcePointCount: job.targetSourcePointCount,
          ...claimableWhere(input.now),
        },
      });
      if (claimed.count !== 1) continue;

      return {
        ...job,
        attemptCount: job.attemptCount + 1,
        leaseToken,
      };
    }
    return null;
  }

  async loadInput(job: RouteTrackingRoadMatchJob): Promise<RouteTrackingGeometryDocumentV1 | null> {
    const geometry = await this.prisma.routeTrackingGeometry.findFirst({
      where: {
        lastOccurredAt: job.targetLastInputOccurredAt,
        routePlanId: job.routePlanId,
        sourcePointCount: job.targetSourcePointCount,
      },
    });
    return geometry === null ? null : readRouteTrackingGeometryDocument(geometry);
  }

  async publishMatchedPath(input: {
    job: RouteTrackingRoadMatchJob;
    now: Date;
    path: RouteTrackingRoadMatchedPathV1;
  }): Promise<boolean> {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw(
        Prisma.sql`SELECT TRUE AS "locked" FROM pg_advisory_xact_lock(hashtextextended(${input.job.routePlanId}, 0))`,
      );
      const job = await transaction.routeTrackingRoadMatchJob.findUnique({
        where: { id: input.job.id },
      });
      if (
        job?.status !== 'PROCESSING'
        || job.leaseToken !== input.job.leaseToken
        || job.targetSourcePointCount !== input.job.targetSourcePointCount
        || job.targetLastInputOccurredAt.getTime() !== input.job.targetLastInputOccurredAt.getTime()
      ) {
        return false;
      }

      const geometry = await transaction.routeTrackingGeometry.updateMany({
        data: buildRouteTrackingRoadMatchCacheWrite(input.path),
        where: {
          lastOccurredAt: input.job.targetLastInputOccurredAt,
          routePlanId: input.job.routePlanId,
          sourcePointCount: input.job.targetSourcePointCount,
        },
      });
      if (geometry.count !== 1) return false;

      const completed = await transaction.routeTrackingRoadMatchJob.updateMany({
        data: {
          completedAt: input.now,
          errorCode: null,
          errorMessage: null,
          leaseExpiresAt: null,
          leaseToken: null,
          nextAttemptAt: null,
          processingStartedAt: null,
          status: 'SUCCEEDED',
        },
        where: {
          id: input.job.id,
          leaseToken: input.job.leaseToken,
          status: 'PROCESSING',
        },
      });
      return completed.count === 1;
    });
  }

  async markSucceededWithoutPath(input: { job: RouteTrackingRoadMatchJob; now: Date }): Promise<boolean> {
    const updated = await this.prisma.routeTrackingRoadMatchJob.updateMany({
      data: {
        completedAt: input.now,
        errorCode: null,
        errorMessage: null,
        leaseExpiresAt: null,
        leaseToken: null,
        nextAttemptAt: null,
        processingStartedAt: null,
        status: 'SUCCEEDED',
      },
      where: this.leasedJobWhere(input.job),
    });
    return updated.count === 1;
  }

  async renewLease(input: { job: RouteTrackingRoadMatchJob; leaseMs: number; now: Date }): Promise<boolean> {
    const updated = await this.prisma.routeTrackingRoadMatchJob.updateMany({
      data: { leaseExpiresAt: new Date(input.now.getTime() + input.leaseMs) },
      where: {
        id: input.job.id,
        leaseToken: input.job.leaseToken,
        status: 'PROCESSING',
      },
    });
    return updated.count === 1;
  }

  async requeueIfSuperseded(input: { job: RouteTrackingRoadMatchJob; now: Date }): Promise<boolean> {
    const updated = await this.prisma.routeTrackingRoadMatchJob.updateMany({
      data: {
        attemptCount: 0,
        completedAt: null,
        errorCode: null,
        errorMessage: null,
        leaseExpiresAt: null,
        leaseToken: null,
        nextAttemptAt: input.now,
        processingStartedAt: null,
        status: 'QUEUED',
      },
      where: {
        id: input.job.id,
        leaseToken: input.job.leaseToken,
        OR: [
          { targetLastInputOccurredAt: { not: input.job.targetLastInputOccurredAt } },
          { targetSourcePointCount: { not: input.job.targetSourcePointCount } },
        ],
        status: 'PROCESSING',
      },
    });
    return updated.count === 1;
  }

  async releaseForRetry(input: {
    errorCode: string;
    errorMessage: string;
    job: RouteTrackingRoadMatchJob;
    nextAttemptAt: Date;
  }): Promise<boolean> {
    const updated = await this.prisma.routeTrackingRoadMatchJob.updateMany({
      data: {
        errorCode: input.errorCode,
        errorMessage: input.errorMessage,
        leaseExpiresAt: null,
        leaseToken: null,
        nextAttemptAt: input.nextAttemptAt,
        processingStartedAt: null,
        status: 'QUEUED',
      },
      where: this.leasedJobWhere(input.job),
    });
    return updated.count === 1;
  }

  async markDead(input: {
    errorCode: string;
    errorMessage: string;
    job: RouteTrackingRoadMatchJob;
    now: Date;
  }): Promise<boolean> {
    const updated = await this.prisma.routeTrackingRoadMatchJob.updateMany({
      data: {
        completedAt: input.now,
        errorCode: input.errorCode,
        errorMessage: input.errorMessage,
        leaseExpiresAt: null,
        leaseToken: null,
        nextAttemptAt: null,
        processingStartedAt: null,
        status: 'DEAD',
      },
      where: this.leasedJobWhere(input.job),
    });
    return updated.count === 1;
  }

  private leasedJobWhere(job: RouteTrackingRoadMatchJob): Prisma.RouteTrackingRoadMatchJobWhereInput {
    return {
      id: job.id,
      leaseToken: job.leaseToken,
      status: 'PROCESSING',
      targetLastInputOccurredAt: job.targetLastInputOccurredAt,
      targetSourcePointCount: job.targetSourcePointCount,
    };
  }
}
