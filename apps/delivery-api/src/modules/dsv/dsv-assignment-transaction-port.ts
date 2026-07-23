import type { Prisma, PrismaClient } from '@prisma/client';

export type DsvAssignmentTransactionClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

export type DsvAssignmentTransactionPort = Pick<PrismaClient, '$transaction'> & {
  $transaction<R>(
    fn: (tx: DsvAssignmentTransactionClient) => Promise<R>,
    options?: { isolationLevel?: Prisma.TransactionIsolationLevel; maxWait?: number; timeout?: number },
  ): Promise<R>;
};
