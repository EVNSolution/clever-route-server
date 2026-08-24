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

export class PrismaDriverRouteCompletionReviewRepository {
  constructor(
    private readonly prisma: Pick<PrismaClient, '$transaction'>,
    private readonly now: () => Date = () => new Date()
  ) {}

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
    return this.prisma.$transaction(async (transaction) => {
      const current = await transaction.driverRouteCompletionReview.findFirst({
        select: { id: true, reviewOutcome: true },
        where: {
          id: input.reviewId,
          shop: { shopDomain: normalizeShopDomain(input.shopDomain) },
          wouldReject: true
        }
      });
      if (current === null) throw new DriverRouteCompletionReviewNotFoundError();
      await transaction.driverRouteCompletionReview.update({
        data: {
          reviewOutcome: input.outcome,
          reviewedAt,
          reviewedByActor: actor,
          reviewNote: note,
          reviewSource: input.source
        },
        where: { id: current.id }
      });
      await transaction.driverRouteCompletionReviewHistory.create({
        data: {
          actor,
          outcome: input.outcome,
          note,
          priorOutcome: current.reviewOutcome,
          reviewId: current.id,
          source: input.source,
          createdAt: reviewedAt
        }
      });
      return { outcome: input.outcome, reviewedAt: reviewedAt.toISOString() };
    });
  }
}
