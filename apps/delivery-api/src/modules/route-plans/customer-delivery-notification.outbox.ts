import { randomUUID } from 'node:crypto';

import type { Prisma, PrismaClient } from '@prisma/client';

export type CustomerDeliveryNotificationJob = {
  appId: string;
  attemptCount: number;
  deliveryStopId: string | null;
  factId: string;
  idempotencyKey: string | null;
  metadata: Prisma.JsonValue | null;
  leaseToken: string;
  occurredAt: Date;
  orderId: string;
  recipientEmail: string | null;
  requestedUiStatus: string | null;
  routePlanId: string | null;
  shopDomain: string;
};

type CustomerDeliveryNotificationOutboxPrismaClient = Pick<
  PrismaClient,
  'customerRouteNotificationFact'
>;

const claimableWhere = (now: Date, allowCustomerMessages: boolean): Prisma.CustomerRouteNotificationFactWhereInput => ({
  reconciliationTombstones: { none: { disposition: 'DO_NOT_SEND' } },
  AND: [{
    OR: [
      ...(allowCustomerMessages ? [{ source: 'DSV_CUSTOMER_MESSAGE' }] : []),
      {
        shop: {
          customerEmailSettings: {
            equals: true,
            path: ['automatic', 'enabled']
          }
        }
      }
    ]
  }],
  OR: [
    {
      nextAttemptAt: { lte: now },
      status: 'QUEUED'
    },
    {
      leaseExpiresAt: { lte: now },
      status: 'PROCESSING'
    }
  ]
});

export class PrismaCustomerDeliveryNotificationOutbox {
  constructor(
    private readonly prisma: CustomerDeliveryNotificationOutboxPrismaClient,
    private readonly options: { allowCustomerMessages?: boolean } = {}
  ) {}

  async claimNext(input: {
    leaseMs: number;
    now: Date;
  }): Promise<CustomerDeliveryNotificationJob | null> {
    for (let contentionAttempt = 0; contentionAttempt < maxClaimContentionAttempts; contentionAttempt += 1) {
      const fact = await this.prisma.customerRouteNotificationFact.findFirst({
        orderBy: [
          { nextAttemptAt: 'asc' },
          { occurredAt: 'asc' },
          { id: 'asc' }
        ],
        select: {
          attemptCount: true,
          deliveryStopId: true,
          id: true,
          idempotencyKey: true,
          metadata: true,
          occurredAt: true,
          orderId: true,
          recipientEmailSnapshot: true,
          requestedUiStatus: true,
          routePlanId: true,
          shop: { select: { appId: true, shopDomain: true } }
        },
        where: claimableWhere(input.now, this.options.allowCustomerMessages !== false)
      });
      if (fact === null) return null;

      const leaseToken = randomUUID();
      const claimed = await this.prisma.customerRouteNotificationFact.updateMany({
        data: {
          attemptCount: { increment: 1 },
          deadAt: null,
          errorCode: null,
          errorMessage: null,
          leaseExpiresAt: new Date(input.now.getTime() + input.leaseMs),
          leaseToken,
          processingStartedAt: input.now,
          status: 'PROCESSING'
        },
        where: {
          id: fact.id,
          ...claimableWhere(input.now, this.options.allowCustomerMessages !== false)
        }
      });
      if (claimed.count !== 1) continue;

      return {
        appId: fact.shop.appId,
        attemptCount: fact.attemptCount + 1,
        deliveryStopId: fact.deliveryStopId,
        factId: fact.id,
        idempotencyKey: fact.idempotencyKey,
        metadata: fact.metadata,
        leaseToken,
        occurredAt: fact.occurredAt,
        orderId: fact.orderId,
        recipientEmail: fact.recipientEmailSnapshot,
        requestedUiStatus: fact.requestedUiStatus,
        routePlanId: fact.routePlanId,
        shopDomain: fact.shop.shopDomain
      };
    }
    return null;
  }

  async markSent(input: {
    factId: string;
    leaseToken: string;
    now: Date;
    provider: string;
    providerMessageId?: string | null | undefined;
  }): Promise<boolean> {
    const updated = await this.prisma.customerRouteNotificationFact.updateMany({
      data: {
        errorCode: null,
        errorMessage: null,
        leaseExpiresAt: null,
        leaseToken: null,
        nextAttemptAt: null,
        provider: input.provider,
        providerEventAt: input.now,
        providerMessageId: input.providerMessageId ?? null,
        providerStatus: 'ACCEPTED',
        recipientEmailSnapshot: null,
        sentAt: input.now,
        status: 'SENT'
      },
      where: {
        id: input.factId,
        leaseToken: input.leaseToken,
        status: 'PROCESSING'
      }
    });
    return updated.count === 1;
  }

  async releaseForRetry(input: {
    errorCode: string;
    errorMessage: string;
    factId: string;
    leaseToken: string;
    nextAttemptAt: Date;
    provider: string;
  }): Promise<boolean> {
    const updated = await this.prisma.customerRouteNotificationFact.updateMany({
      data: {
        errorCode: input.errorCode,
        errorMessage: input.errorMessage,
        leaseExpiresAt: null,
        leaseToken: null,
        nextAttemptAt: input.nextAttemptAt,
        provider: input.provider,
        processingStartedAt: null,
        status: 'QUEUED'
      },
      where: {
        id: input.factId,
        leaseToken: input.leaseToken,
        status: 'PROCESSING'
      }
    });
    return updated.count === 1;
  }

  async markDead(input: {
    errorCode: string;
    errorMessage: string;
    factId: string;
    leaseToken: string;
    now: Date;
    provider: string;
  }): Promise<boolean> {
    const updated = await this.prisma.customerRouteNotificationFact.updateMany({
      data: {
        deadAt: input.now,
        errorCode: input.errorCode,
        errorMessage: input.errorMessage,
        leaseExpiresAt: null,
        leaseToken: null,
        nextAttemptAt: null,
        provider: input.provider,
        recipientEmailSnapshot: null,
        status: 'DEAD'
      },
      where: {
        id: input.factId,
        leaseToken: input.leaseToken,
        status: 'PROCESSING'
      }
    });
    return updated.count === 1;
  }
}

const maxClaimContentionAttempts = 5;
