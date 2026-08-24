import { Prisma, type PrismaClient } from '@prisma/client';

export const ORDER_PRIVACY_REDACTED = 'ORDER_PRIVACY_REDACTED' as const;
export const SHOP_PRIVACY_REDACTED = 'SHOP_PRIVACY_REDACTED' as const;

export async function lockShopifyOrderPrivacyIdentity(
  tx: Pick<PrismaClient, '$queryRaw'>,
  input: { appId: string; orderLegacyId: bigint; shopId: string }
): Promise<void> {
  const key = `${input.appId}:${input.shopId}:${input.orderLegacyId.toString()}`;
  await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text AS "lock"`);
}

export async function lockShopifyShopPrivacyIdentity(
  tx: Pick<PrismaClient, '$queryRaw'>,
  input: { appId: string; shopDomain: string }
): Promise<void> {
  const key = `shop:${input.appId}:${input.shopDomain}`;
  await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text AS "lock"`);
}

export async function assertShopifyShopPrivacyWriteAllowed(
  tx: Pick<PrismaClient, '$queryRaw' | 'shopifyShopRedactionTombstone'>,
  input: { appId: string; shopDomain: string }
): Promise<void> {
  await lockShopifyShopPrivacyIdentity(tx, input);
  const tombstone = await tx.shopifyShopRedactionTombstone.findUnique({
    select: { reinstalledAt: true },
    where: { appId_shopDomain: input }
  });
  if (tombstone !== null && tombstone.reinstalledAt === null) {
    throw new ShopPrivacyRedactedError();
  }
}

export class ShopPrivacyRedactedError extends Error {
  readonly code = SHOP_PRIVACY_REDACTED;

  constructor() {
    super('Shop is blocked by an active privacy redaction');
    this.name = 'ShopPrivacyRedactedError';
  }
}
