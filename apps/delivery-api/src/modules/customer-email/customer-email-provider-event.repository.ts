import type { PrismaClient } from '@prisma/client';

type ProviderEventClient = Pick<PrismaClient, '$transaction' | 'customerEmailManualDispatchRecipient' | 'customerRouteNotificationFact'>;

export type CustomerEmailProviderEvent = {
  occurredAt: Date;
  providerMessageId: string;
  status: string;
};

export class PrismaCustomerEmailProviderEventRepository {
  constructor(private readonly prisma: ProviderEventClient) {}

  async record(input: CustomerEmailProviderEvent): Promise<number> {
    const where = {
      providerMessageId: input.providerMessageId,
      OR: [
        { providerEventAt: null },
        { providerEventAt: { lte: input.occurredAt } }
      ]
    };
    const [automatic, manual] = await this.prisma.$transaction([
      this.prisma.customerRouteNotificationFact.updateMany({
        data: { providerEventAt: input.occurredAt, providerStatus: input.status },
        where
      }),
      this.prisma.customerEmailManualDispatchRecipient.updateMany({
        data: { providerEventAt: input.occurredAt, providerStatus: input.status },
        where
      })
    ]);
    return automatic.count + manual.count;
  }
}
