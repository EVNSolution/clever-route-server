import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, test } from 'vitest';

import { PrismaOperationalAlertRepository } from '../src/modules/notifications/operational-alert.repository.js';

const databaseUrl = process.env.OPERATIONAL_ALERT_REPOSITORY_DATABASE_URL ?? '';
const enabled = process.env.OPERATIONAL_ALERT_REPOSITORY_TARGET_CLASS === 'safe-local-disposable'
  && databaseUrl.includes('127.0.0.1:55493/clever_alert_repository');
const live = enabled ? test : test.skip;
const clients: PrismaClient[] = [];

describe('operational alert repository PostgreSQL concurrency', () => {
  afterAll(async () => {
    await Promise.all(clients.map((client) => client.$disconnect()));
  });

  live('does not resolve a fault observed after the recovery timestamp', async () => {
    const setup = client();
    const shop = await setup.shop.create({ data: { shopDomain: `alert-race-${randomUUID()}.invalid` } });
    const base = new PrismaOperationalAlertRepository(setup);
    const input = {
      dedupeKey: 'EMAIL_RUNTIME_DEGRADED',
      observedAt: new Date('2026-08-24T08:00:00.000Z'),
      severity: 'CRITICAL' as const,
      shopId: shop.id,
      title: 'Email runtime degraded',
      type: 'EMAIL_RUNTIME_DEGRADED'
    };
    const opened = await base.openOrObserve(input);
    let releaseObservation!: () => void;
    let observationLocked!: () => void;
    const observationReached = new Promise<void>((resolve) => { observationLocked = resolve; });
    const observationRelease = new Promise<void>((resolve) => { releaseObservation = resolve; });
    const observing = new PrismaOperationalAlertRepository(client(), {
      beforeLegacyProjection: async () => {
        observationLocked();
        await observationRelease;
      }
    });
    const resolving = new PrismaOperationalAlertRepository(client());

    try {
      const observe = observing.openOrObserve({ ...input, observedAt: new Date('2026-08-24T08:02:00.000Z') });
      await observationReached;
      const resolve = resolving.resolveByDedupeKey({
        dedupeKey: input.dedupeKey,
        resolutionCode: 'EMAIL_RUNTIME_RECOVERED',
        resolvedAt: new Date('2026-08-24T08:01:00.000Z'),
        shopId: shop.id
      });
      releaseObservation();

      await expect(observe).resolves.toMatchObject({ id: opened.id, resolvedAt: null });
      await expect(resolve).resolves.toBe(false);
      expect(await setup.alertCycle.count({
        where: { condition: { dedupeKey: input.dedupeKey, shopId: shop.id }, resolvedAt: null }
      })).toBe(1);
    } finally {
      releaseObservation();
      await setup.shop.delete({ where: { id: shop.id } });
    }
  });
});

function client(): PrismaClient {
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  clients.push(prisma);
  return prisma;
}
