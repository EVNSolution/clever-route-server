import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { PrismaOriginalObservationsService, type OriginalObservationsPage } from '../src/modules/route-tracking/original-observations.service.js';

const databaseUrl = process.env.ORIGINAL_OBSERVATIONS_DATABASE_URL ?? '';
const safe = process.env.ORIGINAL_OBSERVATIONS_DATABASE_TARGET_CLASS === 'safe-disposable-original-observations'
  && /^postgresql:\/\/gps_read_test:gps_read_test@127\.0\.0\.1:\d+\/gps_read_test$/u.test(databaseUrl);
const disposable = safe ? describe.sequential : describe.skip;
const query = { from: '2026-09-01T00:00:00Z', to: '2026-09-02T00:00:00Z', limit: '2' };

disposable('original observation PostgreSQL read contract', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const reader = new PrismaClient({ datasources: { db: { url: databaseUrl.replace('gps_read_test:gps_read_test@', 'gps_reader:gps_reader@') } } });
  const shopId = randomUUID(); const driverId = randomUUID(); const otherDriverId = randomUUID();
  const routePlanId = randomUUID(); const bigRouteId = randomUUID();
  const ids = [1, 2, 3, 4, 5].map((id) => `70000000-0000-4000-8000-${id.toString().padStart(12, '0')}`);
  const scope = { appId: 'clever', shopDomain: 'original-observations.invalid', routePlanId };
  const service = new PrismaOriginalObservationsService(reader, new Map([['clever', 'synthetic-secret'], ['clever-dev', 'synthetic-other']]));

  beforeAll(async () => {
    if (!safe) throw new Error('Refusing non-disposable database');
    await prisma.$executeRawUnsafe("CREATE ROLE gps_reader LOGIN PASSWORD 'gps_reader'");
    await prisma.$executeRawUnsafe('GRANT SELECT ON shops, route_plans, driver_events TO gps_reader');
    await prisma.$executeRawUnsafe('ALTER ROLE gps_reader SET default_transaction_read_only = on');
    await prisma.shop.create({ data: { id: shopId, appId: 'clever', shopDomain: scope.shopDomain } });
    for (const id of [driverId, otherDriverId]) {
      await prisma.driver.create({ data: { id, shopId, displayName: 'Synthetic driver' } });
    }
    for (const id of [routePlanId, bigRouteId]) {
      await prisma.routePlan.create({ data: { id, shopId, driverId, assignmentGeneration: 2n,
        constraints: {}, metrics: {}, name: 'Synthetic route', optimizerVersion: 'test', planDate: new Date('2026-09-01') } });
    }
    for (let index = 0; index < ids.length; index += 1) {
      await prisma.driverEvent.create({ data: { id: ids[index]!, shopId, routePlanId, driverId,
        assignmentGeneration: 2n, eventType: 'LOCATION_UPDATED', occurredAt: new Date('2026-09-01T01:00:00Z'),
        createdAt: new Date('2026-09-01T03:00:00Z'), latitude: '43.1234567', longitude: '-79.1234567',
        clientEventId: `synthetic-${index}`, payload: index === 1 ? { accuracyMeters: '3.5', privateEmail: 'private.invalid' }
          : index === 2 ? { location: { accuracyMeters: 1.23456789 } } : index === 3 ? { redacted: true } : {} } });
    }
    await prisma.$executeRaw`UPDATE driver_events SET "occurredAt" = '2026-09-01T01:00:00.000001Z'::timestamptz,
      "createdAt" = '2026-09-01T03:00:00.000001Z'::timestamptz WHERE id IN (${Prisma.join(ids.slice(0, 2).map((id) => Prisma.sql`${id}::uuid`))})`;
    await prisma.$executeRaw`UPDATE driver_events SET "occurredAt" = '2026-09-01T01:00:00.000002Z'::timestamptz WHERE id = ${ids[2]}::uuid`;
    await prisma.$executeRaw`UPDATE driver_events SET "occurredAt" = '2026-09-01T01:00:00.000003Z'::timestamptz WHERE id = ${ids[3]}::uuid`;
    await prisma.$executeRaw`UPDATE driver_events SET "occurredAt" = '2026-09-02T00:00:00Z'::timestamptz WHERE id = ${ids[4]}::uuid`;
    // Excluded cohorts: another driver, prior/unknown generation, wrong route and non-location event.
    for (const override of [{ driverId: otherDriverId }, { assignmentGeneration: 1n }, { assignmentGeneration: null },
      { routePlanId: null }, { eventType: 'ROUTE_STARTED' as const }]) {
      await prisma.driverEvent.create({ data: { shopId, routePlanId, driverId, assignmentGeneration: 2n,
        eventType: 'LOCATION_UPDATED', occurredAt: new Date('2026-09-01T00:00:00Z'), latitude: '50', longitude: '50', payload: {}, ...override } });
    }
    await prisma.$executeRaw`INSERT INTO driver_events
      (id, "shopId", "routePlanId", "driverId", "assignmentGeneration", "eventType", "occurredAt", "createdAt", latitude, longitude, payload)
      SELECT gen_random_uuid(), ${shopId}::uuid, ${bigRouteId}::uuid, ${driverId}::uuid, 2, 'LOCATION_UPDATED',
        '2026-09-01T02:00:00Z'::timestamptz + n * interval '1 microsecond', '2026-09-01T03:00:00Z'::timestamptz, 43, -79, '{}'::jsonb
      FROM generate_series(1, 5001) AS n`;
  }, 30000);

  afterAll(async () => { await reader.$disconnect(); await prisma.$disconnect(); });

  test('denies a foreign app/tenant and missing route before original data is returned', async () => {
    expect(await service.get({ ...scope, appId: 'clever-dev', query })).toBeNull();
    expect(await service.get({ ...scope, shopDomain: 'foreign.invalid', query })).toBeNull();
    expect(await service.get({ ...scope, routePlanId: randomUUID(), query })).toBeNull();
  });

  test('read-only DB role returns precisely ordered microseconds, separate equal fixes, and quality truth', async () => {
    const before = await prisma.driverEvent.count();
    const first = (await service.get({ ...scope, query }))!;
    expect(first.observations.map(({ eventId }) => eventId)).toEqual(ids.slice(0, 2));
    expect(first.observations[0]).toMatchObject({ observedAt: '2026-09-01T01:00:00.000001Z',
      storedAt: '2026-09-01T03:00:00.000001Z', latitude: 43.1234567, accuracyStatus: 'MISSING' });
    expect(first.observations[1]).toMatchObject({ accuracyStatus: 'INVALID', accuracyMeters: null });
    const nextQuery = { ...query, cursor: first.page.nextCursor! };
    const second = (await service.get({ ...scope, query: nextQuery }))!;
    expect(await service.get({ ...scope, query: nextQuery })).toEqual(second);
    expect(second.observations.map(({ eventId }) => eventId)).toEqual(ids.slice(2, 4));
    expect(second.observations[0]).toMatchObject({ accuracyMeters: 1.23456789, accuracyStatus: 'VALID' });
    expect(second.observations[1]).toMatchObject({ coordinateStatus: 'REDACTED', latitude: null, longitude: null });
    expect(second.page).toMatchObject({ hasMore: false, totalReturned: 4, nextCursor: null });
    expect(JSON.stringify([first, second])).not.toMatch(/privateEmail|private.invalid|synthetic-\d|driverId|payload/u);
    expect(await prisma.driverEvent.count()).toBe(before);
  });

  test('late stored arrivals do not enter an already-started traversal', async () => {
    const first = (await service.get({ ...scope, query }))!;
    await prisma.driverEvent.create({ data: { shopId, driverId, routePlanId, assignmentGeneration: 2n,
      eventType: 'LOCATION_UPDATED', occurredAt: new Date('2026-09-01T05:00:00Z'), payload: {} } });
    const second = (await service.get({ ...scope, query: { ...query, cursor: first.page.nextCursor! } }))!;
    expect(second.page.hasMore).toBe(false);
    expect(second.observations.map(({ eventId }) => eventId)).toEqual(ids.slice(2, 4));
  });

  test('5001 stored observations stop at the traversal cap with no implicit export', async () => {
    const seen = new Set<string>(); let cursor: string | null = null; let previous = '';
    for (let count = 1; count <= 10; count += 1) {
      const page: OriginalObservationsPage = (await service.get({ ...scope, routePlanId: bigRouteId,
        query: { ...query, limit: '500', ...(cursor === null ? {} : { cursor }) } }))!;
      for (const point of page.observations) {
        expect(point.observedAt > previous).toBe(true); previous = point.observedAt;
        expect(seen.has(point.eventId)).toBe(false); seen.add(point.eventId);
      }
      cursor = page.page.nextCursor;
      if (count === 10) expect(page.page).toMatchObject({ totalReturned: 5000, capReached: true, hasMore: false, nextCursor: null });
    }
    expect(seen.size).toBe(5000);
  });

  test('same-driver reassignment invalidates prior-generation cursors', async () => {
    const first = (await service.get({ ...scope, query }))!;
    await prisma.routePlan.update({ where: { id: routePlanId }, data: { assignmentGeneration: 3n } });
    await expect(service.get({ ...scope, query: { ...query, cursor: first.page.nextCursor! } })).rejects.toMatchObject({ code: 'ASSIGNMENT_CHANGED' });
    expect(await service.get({ ...scope, query })).toMatchObject({ observations: [], emptyReason: 'NO_OBSERVATIONS' });
  });
});
