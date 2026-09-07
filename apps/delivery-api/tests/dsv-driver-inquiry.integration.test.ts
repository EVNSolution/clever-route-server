import { PrismaClient } from '@prisma/client';
import { describe, expect, test } from 'vitest';
import { buildApp } from '../src/app.js';
import { signDriverAccountToken } from '../src/modules/driver/driver-token-verifier.js';
import { PrismaDriverAccountDeletionService } from '../src/modules/driver/driver-account-deletion.service.js';
import { DsvInquiryError, PrismaDsvDriverInquiryRepository } from '../src/modules/dsv/dsv-driver-inquiry.repository.js';

const databaseUrl = process.env.DSV_DRIVER_INQUIRY_DATABASE_URL ?? process.env.DRIVER_ACCOUNT_DELETION_DATABASE_URL ?? '';
const live = databaseUrl === '' ? test.skip : test;
const accountA = 'a1100000-0000-4000-8000-000000000001';
const accountB = 'a1100000-0000-4000-8000-000000000002';
const shopA = 'a2100000-0000-4000-8000-000000000001';
const shopB = 'a2100000-0000-4000-8000-000000000002';
const requestKey = 'a3100000-0000-4000-8000-000000000001';
const scopeA = { accountId: accountA, tokenVersion: 0 };
const scopeB = { accountId: accountB, tokenVersion: 0 };
const input = { title: 'Synthetic support', body: 'No real customer data', clientRequestId: requestKey };

function client() {
  const url = new URL(databaseUrl);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !/^\/clever_(?:g007_(?:empty|restore|recovery)_inquiry_[a-z0-9_]+|g006)$/u.test(url.pathname) || ['5433', '55444', '55455'].includes(url.port)) {
    throw new Error('Inquiry integration tests require a dedicated local disposable database');
  }
  return new PrismaClient({ datasources: { db: { url: databaseUrl } } });
}

async function seed(prisma: PrismaClient) {
  await prisma.driverAccount.createMany({ data: [
    { id: accountA, name: 'Synthetic A', phone: '+10000909101', loginId: 'inquiry-fixture-a' },
    { id: accountB, name: 'Synthetic B', phone: '+10000909102', loginId: 'inquiry-fixture-b' },
  ] });
  await prisma.shop.createMany({ data: [{ id: shopA, shopDomain: 'inquiry-a.invalid' }, { id: shopB, shopDomain: 'inquiry-b.invalid' }] });
  await prisma.driver.createMany({ data: [
    { shopId: shopA, accountId: accountA, displayName: 'Synthetic A' },
    { shopId: shopB, accountId: accountB, displayName: 'Synthetic B' },
  ] });
}

async function cleanup(prisma: PrismaClient) {
  await prisma.driverAccountDeletionRequest.deleteMany({ where: { accountId: { in: [accountA, accountB] } } });
  await prisma.shop.deleteMany({ where: { id: { in: [shopA, shopB] } } });
  await prisma.driverAccount.deleteMany({ where: { id: { in: [accountA, accountB] } } });
  await prisma.$disconnect();
}

describe('DSV inquiry PostgreSQL isolation and lifecycle', () => {
  live('isolates two accounts/shops, serializes retries, and paginates tied timestamps without loss', async () => {
    const prisma = client();
    const repository = new PrismaDsvDriverInquiryRepository(prisma);
    const secret = 'disposable-inquiry-secret-not-for-production';
    const app = await buildApp({ dsvDriverAuth: { jwtSecret: secret, repository: {} as never, inquiryRepository: repository } });
    try {
      await seed(prisma);
      const race = await Promise.all(Array.from({ length: 8 }, () => repository.create(scopeA, input)));
      expect(race.filter(result => !result.duplicate)).toHaveLength(1);
      expect(new Set(race.map(result => result.inquiry.id)).size).toBe(1);
      const own = race[0]!.inquiry;
      const foreign = (await repository.create(scopeB, input)).inquiry;
      await expect(repository.create(scopeA, { ...input, title: 'Different payload' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
      const tokenA = signDriverAccountToken({ ...scopeA, subject: accountA, expiresInSeconds: 900 }, { secret }).token;
      const tokenB = signDriverAccountToken({ ...scopeB, subject: accountB, expiresInSeconds: 900 }, { secret }).token;
      for (const [token, ownId, otherId] of [[tokenA, own.id, foreign.id], [tokenB, foreign.id, own.id]]) {
        const headers = { authorization: `Bearer ${token}` };
        const list = await app.inject({ method: 'GET', url: '/api/dsv/driver/inquiries', headers });
        expect(list.statusCode).toBe(200);
        expect(list.json<{ data: { items: Array<{ id: string }> } }>().data.items.map(row => row.id)).toEqual([ownId]);
        expect((await app.inject({ method: 'GET', url: `/api/dsv/driver/inquiries/${otherId}`, headers })).statusCode).toBe(404);
      }
      expect((await repository.listForShop(shopA, null, 20)).items.map(row => row.id)).toEqual([own.id]);
      expect(await repository.detailForShop(shopA, foreign.id)).toBeNull();
      expect(await repository.detailForShop(shopB, own.id)).toBeNull();
      await prisma.driver.deleteMany({ where: { accountId: accountB } });
      expect((await repository.listForShop(shopB, null, 20)).items).toEqual([]);
      expect((await repository.detail(scopeB, foreign.id)).inquiry.id).toBe(foreign.id);
      const tied = new Date('2026-09-07T00:00:00.123Z');
      for (let i = 2; i < 6; i++) await prisma.dsvDriverInquiry.create({ data: { ...input, accountId: accountA, authorName: 'Synthetic A', clientRequestId: `a3100000-0000-4000-8000-00000000000${i}`, createdAt: tied } });
      const expected = await prisma.dsvDriverInquiry.findMany({ where: { accountId: accountA }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
      const seen: string[] = [];
      let before: { id: string; createdAt: Date } | null = null;
      for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
        const page = await repository.list(scopeA, before, 1);
        seen.push(...page.items.map(row => row.id));
        if (page.nextCursor === null) break;
        const next = JSON.parse(Buffer.from(page.nextCursor, 'base64url').toString('utf8')) as { id: string; createdAt: string };
        before = { id: next.id, createdAt: new Date(next.createdAt) };
      }
      expect(seen).toEqual(expected.map(row => row.id));
      await expect(repository.detail({ ...scopeA, tokenVersion: 99 }, own.id)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      await prisma.driverAccount.update({ where: { id: accountA }, data: { status: 'INACTIVE' } });
      await Promise.all([repository.create(scopeA, input), repository.list(scopeA, null, 20), repository.detail(scopeA, own.id)]
        .map(operation => expect(operation).rejects.toBeInstanceOf(DsvInquiryError)));
    } finally { await app.close(); await cleanup(prisma); }
  });

  live('deletes inquiry PII on account fulfillment and fences concurrent creation', async () => {
    const prisma = client();
    const repository = new PrismaDsvDriverInquiryRepository(prisma);
    const service = new PrismaDriverAccountDeletionService(prisma);
    try {
      await seed(prisma);
      await repository.create(scopeA, input);
      const retained = await repository.create(scopeB, input);
      const request = await service.requestVerifiedExternal({ accountId: accountA, processedBy: 'inquiry-fixture', verificationMethod: 'OPERATOR_VERIFIED_CONTACT' });
      const [creation, deletion] = await Promise.allSettled([
        repository.create(scopeA, { ...input, clientRequestId: 'a3100000-0000-4000-8000-000000000099' }),
        service.fulfill({ requestId: request.requestId, processedBy: 'inquiry-fixture' }),
      ]);
      expect(deletion.status).toBe('fulfilled');
      if (deletion.status === 'fulfilled') expect(deletion.value.status).toBe('COMPLETED');
      if (creation.status === 'rejected') expect(creation.reason).toBeInstanceOf(DsvInquiryError);
      expect(await prisma.dsvDriverInquiry.count({ where: { accountId: accountA } })).toBe(0);
      expect((await repository.detail(scopeB, retained.inquiry.id)).inquiry.authorName).toBe('Synthetic B');
      await expect(repository.create(scopeA, input)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      await expect(repository.list(scopeA, null, 20)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    } finally { await cleanup(prisma); }
  });
});
