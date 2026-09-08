import type { Prisma, PrismaClient } from '@prisma/client';

type ProviderEventClient = Pick<PrismaClient, '$transaction' | 'customerEmailManualDispatchRecipient' | 'customerRouteNotificationFact'>;

export type CustomerEmailProviderEvent = {
  correlationId?: string | undefined;
  occurredAt: Date;
  providerMessageId: string;
  status: string;
};

export class PrismaCustomerEmailProviderEventRepository {
  constructor(private readonly prisma: ProviderEventClient) {}

  async record(input: CustomerEmailProviderEvent): Promise<number> {
    const identity = providerEventIdentity(input);
    const eventOrder = providerEventOrder(input);
    const automaticWhere: Prisma.CustomerRouteNotificationFactWhereInput = {
      ...identity,
      ...eventOrder,
    };
    const manualWhere: Prisma.CustomerEmailManualDispatchRecipientWhereInput = {
      ...identity,
      ...eventOrder,
      status: { in: ['PENDING', 'SENT', 'UNKNOWN'] },
    };
    const [automatic, manual] = await this.prisma.$transaction([
      this.prisma.customerRouteNotificationFact.updateMany({
        data: { providerEventAt: input.occurredAt, providerMessageId: input.providerMessageId, providerStatus: input.status },
        where: automaticWhere
      }),
      this.prisma.customerEmailManualDispatchRecipient.updateMany({
        data: {
          providerEventAt: input.occurredAt,
          providerMessageId: input.providerMessageId,
          providerStatus: input.status,
          status: 'SENT',
        },
        where: manualWhere
      })
    ]);
    return automatic.count + manual.count;
  }
}

function providerEventIdentity(input: CustomerEmailProviderEvent): {
  OR: Array<
    | { attempts: { some: { correlationId: string } } }
    | { providerMessageId: string }
  >;
} {
  return {
    OR: [
      { providerMessageId: input.providerMessageId },
      ...(input.correlationId === undefined ? [] : [{ attempts: { some: { correlationId: input.correlationId } } }]),
    ],
  };
}

function providerEventOrder(input: CustomerEmailProviderEvent): {
  AND: Array<{ OR: Array<Record<string, unknown>> }>;
} {
  const lowerStatuses = providerStatusesBelow(input.status);
  return {
    AND: [{
      OR: [
        { providerEventAt: null },
        { providerStatus: null },
        ...(lowerStatuses.length === 0 ? [] : [{
          providerEventAt: { lte: input.occurredAt },
          providerStatus: { in: lowerStatuses },
        }]),
        { providerEventAt: { lt: input.occurredAt }, providerStatus: input.status },
      ],
    }],
  };
}

function providerStatusesBelow(status: string): string[] {
  const precedence: Record<string, number> = {
    ACCEPTED: 10,
    BLOCKED: 40,
    CLICKED: 60,
    DEFERRED: 20,
    DELIVERED: 40,
    HARD_BOUNCE: 40,
    INVALID: 40,
    OPENED: 50,
    SOFT_BOUNCE: 30,
    SPAM: 70,
    UNKNOWN: 0,
    UNSUBSCRIBED: 70,
    ERROR: 40,
  };
  const incoming = precedence[status] ?? 0;
  return Object.entries(precedence)
    .filter(([, rank]) => rank < incoming)
    .map(([providerStatus]) => providerStatus);
}
