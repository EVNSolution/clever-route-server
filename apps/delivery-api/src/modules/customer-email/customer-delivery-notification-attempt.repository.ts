import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

export type NotificationAttemptHandle = { attemptId: string; correlationId: string };

export class PrismaCustomerDeliveryNotificationAttemptRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly now: () => Date = () => new Date()
  ) {}

  async startAutomatic(input: { attemptNumber: number; factId: string; provider: string; startedAt: Date }): Promise<NotificationAttemptHandle> {
    const fact = await this.prisma.customerRouteNotificationFact.findUnique({ select: { shopId: true }, where: { id: input.factId } });
    if (fact === null) throw new Error('Notification fact was not found');
    return this.create({ attemptNumber: input.attemptNumber, factId: input.factId, provider: input.provider, shopId: fact.shopId, startedAt: input.startedAt });
  }

  async startManual(input: { manualDispatchRecipientId: string; provider: string; shopId: string; startedAt: Date }): Promise<NotificationAttemptHandle> {
    const attemptNumber = await this.prisma.customerDeliveryNotificationAttempt.count({ where: { manualDispatchRecipientId: input.manualDispatchRecipientId } }) + 1;
    return this.create({ attemptNumber, manualDispatchRecipientId: input.manualDispatchRecipientId, provider: input.provider, shopId: input.shopId, startedAt: input.startedAt });
  }

  async settle(input: {
    attemptId: string;
    completedAt: Date;
    errorCode?: string | null;
    outcome: 'RETRYABLE_FAILURE' | 'SENT' | 'TERMINAL_FAILURE';
    providerMessageId?: string | null;
  }): Promise<void> {
    await this.prisma.customerDeliveryNotificationAttempt.update({
      data: {
        completedAt: input.completedAt,
        errorCode: input.errorCode ?? null,
        outcome: input.outcome,
        providerMessageId: sanitizeProviderMessageId(input.providerMessageId)
      },
      where: { id: input.attemptId }
    });
  }

  private async create(input: {
    attemptNumber: number;
    factId?: string;
    manualDispatchRecipientId?: string;
    provider: string;
    shopId: string;
    startedAt: Date;
  }): Promise<NotificationAttemptHandle> {
    const correlationId = randomUUID();
    const attempt = await this.prisma.customerDeliveryNotificationAttempt.create({
      data: {
        attemptNumber: input.attemptNumber,
        correlationId,
        ...(input.factId === undefined ? {} : { factId: input.factId }),
        ...(input.manualDispatchRecipientId === undefined ? {} : { manualDispatchRecipientId: input.manualDispatchRecipientId }),
        outcome: 'STARTED',
        provider: input.provider,
        retainedUntil: new Date(this.now().getTime() + 180 * 24 * 60 * 60 * 1000),
        shopId: input.shopId,
        startedAt: input.startedAt
      }
    });
    return { attemptId: attempt.id, correlationId };
  }
}

function sanitizeProviderMessageId(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 200 && /^[A-Za-z0-9._:@/-]+$/u.test(normalized) ? normalized : null;
}
