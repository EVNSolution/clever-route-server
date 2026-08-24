import { describe, expect, test, vi } from 'vitest';
import {
  DriverRouteCompletionReviewNotFoundError,
  PrismaDriverRouteCompletionReviewRepository
} from '../src/modules/driver/driver-route-completion-review.repository.js';

describe('PrismaDriverRouteCompletionReviewRepository', () => {
  test('scopes the review to the shop and appends actor/source/note history', async () => {
    const reviewedAt = new Date('2026-08-25T01:00:00.000Z');
    const transaction = {
      driverRouteCompletionReview: {
        findFirst: vi.fn(() => Promise.resolve({ id: 'review-id', reviewOutcome: null })),
        update: vi.fn(() => Promise.resolve({ id: 'review-id' }))
      },
      driverRouteCompletionReviewHistory: { create: vi.fn(() => Promise.resolve({ id: 'history-id' })) }
    };
    const repository = new PrismaDriverRouteCompletionReviewRepository({
      $transaction: vi.fn((callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction))
    } as never, () => reviewedAt);

    await expect(repository.review({
      actor: ' operator@example.com ', note: 'Observed stop was already terminal.', outcome: 'FALSE_POSITIVE',
      reviewId: 'review-id', shopDomain: 'HTTPS://K-FOOD.MYSHOPIFY.COM/admin', source: 'ROUTE_OPS_UI'
    })).resolves.toEqual({ outcome: 'FALSE_POSITIVE', reviewedAt: reviewedAt.toISOString() });

    expect(transaction.driverRouteCompletionReview.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'review-id', shop: { shopDomain: 'k-food.myshopify.com' }, wouldReject: true }
    }));
    expect(transaction.driverRouteCompletionReviewHistory.create).toHaveBeenCalledWith({ data: {
      actor: 'operator@example.com', createdAt: reviewedAt, note: 'Observed stop was already terminal.',
      outcome: 'FALSE_POSITIVE', priorOutcome: null, reviewId: 'review-id', source: 'ROUTE_OPS_UI'
    } });
  });

  test('does not create history for an unknown or cross-shop review', async () => {
    const transaction = {
      driverRouteCompletionReview: { findFirst: vi.fn(() => Promise.resolve(null)), update: vi.fn() },
      driverRouteCompletionReviewHistory: { create: vi.fn() }
    };
    const repository = new PrismaDriverRouteCompletionReviewRepository({
      $transaction: vi.fn((callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction))
    } as never);
    await expect(repository.review({
      actor: 'operator', note: 'Reviewed.', outcome: 'CONFIRMED_CORRECT', reviewId: 'missing',
      shopDomain: 'k-food.myshopify.com', source: 'REPORT_RECONCILIATION'
    })).rejects.toBeInstanceOf(DriverRouteCompletionReviewNotFoundError);
    expect(transaction.driverRouteCompletionReviewHistory.create).not.toHaveBeenCalled();
  });
});
