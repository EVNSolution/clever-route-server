import { Prisma } from '@prisma/client';

export async function lockDsvDriverAccount(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  accountId: string,
): Promise<void> {
  await tx.$queryRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`dsv-driver-account:${accountId}`}, 0))::text AS "lock"`,
  );
}
