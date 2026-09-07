import type { Prisma, PrismaClient } from '@prisma/client';

const inquirySelect = { id: true, title: true, body: true, authorName: true, createdAt: true } as const;
export type DsvInquiryScope = { accountId: string; tokenVersion: number };
export type DsvInquiryCursor = { createdAt: Date; id: string };
export class DsvInquiryError extends Error {
  constructor(readonly code: 'UNAUTHORIZED' | 'NOT_FOUND' | 'IDEMPOTENCY_CONFLICT') { super(code); }
}

export class PrismaDsvDriverInquiryRepository {
  constructor(private readonly prisma: Pick<PrismaClient, '$transaction' | 'driverAccount' | 'dsvDriverInquiry'>) {}

  private async account(scope: DsvInquiryScope) {
    const account = await this.prisma.driverAccount.findFirst({
      where: { id: scope.accountId, tokenVersion: scope.tokenVersion, status: 'ACTIVE' },
      select: { name: true }
    });
    if (account === null) throw new DsvInquiryError('UNAUTHORIZED');
    return account;
  }

  async create(scope: DsvInquiryScope, input: { title: string; body: string; clientRequestId: string }) {
    return this.prisma.$transaction(async (tx) => {
      // Serialize same-account retries and fence the account-deletion transaction.
      const [account] = await tx.$queryRaw<Array<{ name: string | null }>>`
        SELECT "name" FROM "driver_accounts"
        WHERE "id" = ${scope.accountId}::uuid AND "tokenVersion" = ${scope.tokenVersion} AND "status" = 'ACTIVE'
        FOR UPDATE
      `;
      if (account === undefined) throw new DsvInquiryError('UNAUTHORIZED');
      const existing = await tx.dsvDriverInquiry.findUnique({
        where: { accountId_clientRequestId: { accountId: scope.accountId, clientRequestId: input.clientRequestId } },
        select: inquirySelect
      });
      if (existing !== null) return this.replay(existing, input);
      const inquiry = await tx.dsvDriverInquiry.create({
        data: { ...input, accountId: scope.accountId, authorName: account.name ?? '배송원' }, select: inquirySelect
      });
      return { inquiry, duplicate: false };
    });
  }

  async list(scope: DsvInquiryScope, before: DsvInquiryCursor | null, limit: number) {
    await this.account(scope);
    return this.page({ accountId: scope.accountId }, before, limit);
  }

  listForShop(shopId: string, before: DsvInquiryCursor | null, limit: number) {
    return this.page({ account: { drivers: { some: { shopId } } } }, before, limit);
  }

  async detailForShop(shopId: string, id: string) {
    return this.prisma.dsvDriverInquiry.findFirst({
      where: { id, account: { drivers: { some: { shopId } } } }, select: inquirySelect
    });
  }

  private async page(where: Prisma.DsvDriverInquiryWhereInput, before: DsvInquiryCursor | null, limit: number) {
    const rows = await this.prisma.dsvDriverInquiry.findMany({
      where: { ...where, ...(before === null ? {} : {
        OR: [{ createdAt: { lt: before.createdAt } }, { createdAt: before.createdAt, id: { lt: before.id } }]
      }) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1, select: inquirySelect
    });
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    const nextCursor = rows.length > limit && last !== undefined
      ? Buffer.from(JSON.stringify({ createdAt: last.createdAt.toISOString(), id: last.id })).toString('base64url') : null;
    return { items, nextCursor };
  }

  async detail(scope: DsvInquiryScope, id: string) {
    await this.account(scope);
    const inquiry = await this.prisma.dsvDriverInquiry.findFirst({ where: { id, accountId: scope.accountId }, select: inquirySelect });
    if (inquiry === null) throw new DsvInquiryError('NOT_FOUND');
    return { inquiry };
  }

  private replay<T extends { title: string; body: string }>(inquiry: T, input: { title: string; body: string }) {
    if (inquiry.title !== input.title || inquiry.body !== input.body) throw new DsvInquiryError('IDEMPOTENCY_CONFLICT');
    return { inquiry, duplicate: true };
  }
}

export type DsvDriverInquiryRepository = Pick<PrismaDsvDriverInquiryRepository, 'create' | 'list' | 'detail'>;
export type DsvAdminInquiryRepository = Pick<PrismaDsvDriverInquiryRepository, 'listForShop' | 'detailForShop'>;
