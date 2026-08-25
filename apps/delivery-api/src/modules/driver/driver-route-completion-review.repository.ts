import type { PrismaClient } from '@prisma/client';
import { normalizeShopDomain } from '../commerce/commerce-connection.repository.js';

export const DRIVER_ROUTE_COMPLETION_REVIEW_OUTCOMES = ['CONFIRMED_CORRECT', 'FALSE_POSITIVE'] as const;
export type DriverRouteCompletionReviewOutcome = typeof DRIVER_ROUTE_COMPLETION_REVIEW_OUTCOMES[number];
export const DRIVER_ROUTE_COMPLETION_REVIEW_SOURCES = ['ROUTE_OPS_UI', 'REPORT_RECONCILIATION'] as const;
export type DriverRouteCompletionReviewSource = typeof DRIVER_ROUTE_COMPLETION_REVIEW_SOURCES[number];

export class DriverRouteCompletionReviewNotFoundError extends Error {
  constructor() {
    super('Completion review was not found');
    this.name = 'DriverRouteCompletionReviewNotFoundError';
  }
}

export class DriverRouteCompletionReviewConflictError extends Error {
  constructor() {
    super('Completion review changed while it was being assessed');
    this.name = 'DriverRouteCompletionReviewConflictError';
  }
}

export class PrismaDriverRouteCompletionReviewRepository {
  constructor(
    private readonly prisma: Pick<PrismaClient, '$transaction'>,
    private readonly now: () => Date = () => new Date(),
    private readonly retentionDays = 365
  ) {}

  async listUnreviewed(input: { limit?: number; shopDomain: string }): Promise<Array<{
    createdAt: string; id: string; mode: string; routePlanId: string; totalStopCount: number; unresolvedStopCount: number;
  }>> {
    const limit = Number.isSafeInteger(input.limit) && (input.limit ?? 0) > 0 && (input.limit ?? 0) <= 100 ? input.limit! : 50;
    return this.prisma.$transaction(async (transaction) => {
      const rows = await transaction.driverRouteCompletionReview.findMany({
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { createdAt: true, id: true, mode: true, routePlanId: true, totalStopCount: true, unresolvedStopCount: true },
        take: limit,
        where: { reviewOutcome: null, shop: { shopDomain: normalizeShopDomain(input.shopDomain) }, wouldReject: true }
      });
      return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
    });
  }

  async review(input: {
    actor: string;
    outcome: DriverRouteCompletionReviewOutcome;
    note: string;
    reviewId: string;
    shopDomain: string;
    source: DriverRouteCompletionReviewSource;
  }): Promise<{ outcome: DriverRouteCompletionReviewOutcome; reviewedAt: string }> {
    const actor = input.actor.trim();
    if (actor === '' || actor.length > 200) throw new Error('Review actor is invalid');
    if (!DRIVER_ROUTE_COMPLETION_REVIEW_OUTCOMES.includes(input.outcome)) throw new Error('Review outcome is invalid');
    const note = input.note.trim();
    if (note === '' || note.length > 500) throw new Error('Review note is invalid');
    if (!DRIVER_ROUTE_COMPLETION_REVIEW_SOURCES.includes(input.source)) throw new Error('Review source is invalid');
    const reviewedAt = this.now();
    const retainedUntil = new Date(reviewedAt.getTime() + this.retentionDays * 24 * 60 * 60 * 1000);
    return this.prisma.$transaction(async (transaction) => {
      const current = await transaction.driverRouteCompletionReview.findFirst({
        select: { id: true, reviewOutcome: true, reviewedAt: true },
        where: {
          id: input.reviewId,
          shop: { shopDomain: normalizeShopDomain(input.shopDomain) },
          wouldReject: true
        }
      });
      if (current === null) throw new DriverRouteCompletionReviewNotFoundError();
      const updated = await transaction.driverRouteCompletionReview.updateMany({
        data: {
          reviewOutcome: input.outcome,
          reviewedAt,
          reviewedByActor: actor,
          reviewNote: note,
          reviewSource: input.source,
          retainedUntil
        },
        where: { id: current.id, reviewedAt: current.reviewedAt, reviewOutcome: current.reviewOutcome }
      });
      if (updated.count !== 1) throw new DriverRouteCompletionReviewConflictError();
      await transaction.driverRouteCompletionReviewHistory.create({
        data: {
          actor,
          outcome: input.outcome,
          note,
          priorOutcome: current.reviewOutcome,
          reviewId: current.id,
          retainedUntil,
          source: input.source,
          createdAt: reviewedAt
        }
      });
      await transaction.driverRouteCompletionGateHistory.create({
        data: {
          createdAt: reviewedAt,
          outcome: input.outcome,
          retainedUntil,
          source: input.source
        }
      });
      return { outcome: input.outcome, reviewedAt: reviewedAt.toISOString() };
    });
  }
}
