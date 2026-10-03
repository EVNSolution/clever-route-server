import { Prisma } from '@prisma/client';
import { describe, expect, test, vi } from 'vitest';
import { PrismaOriginalObservationsService, type OriginalObservationsPage } from '../src/modules/route-tracking/original-observations.service.js';

const routePlanId = '10000000-0000-4000-8000-000000000001';
const scope = { appId: 'clever', shopDomain: 'example.myshopify.com', routePlanId };
const query = { from: '2026-09-01T00:00:00Z', to: '2026-09-02T00:00:00Z', limit: '2' };
const snapshotAt = '2026-09-03T00:00:00.123456Z';
const row = (number: number, overrides: object = {}) => ({
  eventId: `20000000-0000-4000-8000-${number.toString().padStart(12, '0')}`,
  observedAt: '2026-09-01T01:00:00.000001Z', storedAt: '2026-09-01T02:00:00.000001Z',
  latitude: '43.1234567', longitude: '-79.7654321', accuracy: 0, redacted: false, clientEventId: 'unsafe-client-id', ...overrides
});

function harness(rows = [row(1), row(2), row(3)]) {
  let clock = Date.parse('2026-09-03T00:00:00Z');
  const findFirst = vi.fn().mockResolvedValue({ shopId: '30000000-0000-4000-8000-000000000001',
    driverId: '40000000-0000-4000-8000-000000000001', assignmentGeneration: 1n });
  const raw = vi.fn<(sql: Prisma.Sql | TemplateStringsArray) => Promise<unknown>>().mockImplementation((sql) =>
    Promise.resolve(('strings' in sql ? sql.strings : sql).join('').includes('clock_timestamp') ? [{ snapshotAt }] : rows));
  const execute = vi.fn().mockResolvedValue(0);
  const transaction = vi.fn().mockImplementation((callback: (tx: unknown) => Promise<unknown>) =>
    callback({ routePlan: { findFirst }, $queryRaw: raw, $executeRaw: execute }));
  const service = new PrismaOriginalObservationsService({ $transaction: transaction },
    new Map([['clever', 'synthetic-secret'], ['clever-dev', 'other-synthetic-secret']]), () => clock);
  return { service, findFirst, raw, execute, transaction, setClock: (value: number) => { clock = value; } };
}

describe('original observation read service', () => {
  test('scopes route authorization before GPS reads and bounds parameterized SQL', async () => {
    const h = harness();
    const page = await h.service.get({ ...scope, query });
    expect(h.findFirst).toHaveBeenCalledWith({
      where: { id: routePlanId, shop: { appId: 'clever', shopDomain: 'example.myshopify.com' } },
      select: { shopId: true, driverId: true, assignmentGeneration: true }
    });
    expect(h.transaction.mock.calls[0]?.[1]).toEqual({ isolationLevel: 'RepeatableRead', maxWait: 3000, timeout: 5000 });
    expect(h.execute.mock.calls[0]?.[0]).toEqual(['SET LOCAL statement_timeout = \'3000ms\'']);
    const sql = h.raw.mock.calls[1]![0] as Prisma.Sql;
    expect(sql.sql).toContain('ORDER BY "occurredAt" ASC, "createdAt" ASC, id ASC');
    expect(sql.sql).not.toMatch(/OFFSET|COUNT\(|SELECT \*|RouteTrackingGeometry/iu);
    expect(sql.values).toEqual(['30000000-0000-4000-8000-000000000001', routePlanId,
      '40000000-0000-4000-8000-000000000001', 1n, 1n,
      '2026-09-01T00:00:00.000000Z', '2026-09-02T00:00:00.000000Z', snapshotAt, 3]);
    expect(page).toMatchObject({ source: 'DRIVER_EVENT_LOCATION_UPDATED', scope: 'CURRENT_ASSIGNMENT',
      page: { returned: 2, totalReturned: 2, hasMore: true, pointCap: 5000, capReached: false } });
  });

  test('missing/foreign route cannot query event records', async () => {
    const h = harness(); h.findFirst.mockResolvedValue(null);
    expect(await h.service.get({ ...scope, query })).toBeNull();
    expect(h.raw).not.toHaveBeenCalled();
  });

  test('unassigned route is empty without querying GPS or unknown driver events', async () => {
    const h = harness(); h.findFirst.mockResolvedValue({ shopId: 'shop', driverId: null, assignmentGeneration: 1n });
    expect(await h.service.get({ ...scope, query })).toMatchObject({ observations: [], emptyReason: 'NO_ASSIGNED_DRIVER',
      page: { hasMore: false, nextCursor: null, returned: 0 } });
    expect(h.raw).toHaveBeenCalledTimes(1);
  });

  test('no retained observations is explicit', async () => {
    expect(await harness([]).service.get({ ...scope, query })).toMatchObject({ emptyReason: 'NO_OBSERVATIONS', observations: [] });
  });

  test.each([
    { from: '2026-02-30T00:00:00Z' }, { to: query.from }, { to: '2026-09-02T00:00:00.000001Z' },
    { from: '2026-09-01' }, { from: '2026-09-01T00:00:00+00:00' }, { from: [query.from] },
    { limit: '501' }, { limit: '0' }, { limit: '-1' }, { limit: '2.5' }, { limit: '2e2' }, { limit: ['2'] }, { shopId: 'foreign' }
  ])('rejects invalid query %j before DB access', async (override) => {
    const h = harness();
    await expect(h.service.get({ ...scope, query: { ...query, ...override } })).rejects.toMatchObject({ code: 'INVALID_QUERY' });
    expect(h.transaction).not.toHaveBeenCalled();
  });

  test('invalid route UUID and repeated/oversized cursor fail validation', async () => {
    const h = harness();
    await expect(h.service.get({ ...scope, routePlanId: 'bad', query })).rejects.toMatchObject({ code: 'INVALID_QUERY' });
    for (const cursor of ['', ['cursor'], 'x'.repeat(2049), 'bogus.signature']) {
      await expect(h.service.get({ ...scope, query: { ...query, cursor } })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    }
    expect(h.transaction).not.toHaveBeenCalled();
  });

  test('cursor binds app, tenant, route, time window, page size, signature and expiry', async () => {
    const h = harness(); const page = (await h.service.get({ ...scope, query }))!;
    const cursor = page.page.nextCursor!;
    for (const input of [
      { ...scope, query: { ...query, cursor, limit: '3' } },
      { ...scope, query: { ...query, cursor, from: '2026-09-01T00:01:00Z' } },
      { ...scope, appId: 'clever-dev', query: { ...query, cursor } },
      { ...scope, shopDomain: 'other.myshopify.com', query: { ...query, cursor } },
      { ...scope, routePlanId: '10000000-0000-4000-8000-000000000002', query: { ...query, cursor } },
      { ...scope, query: { ...query, cursor: `${cursor.slice(0, -1)}${cursor.endsWith('A') ? 'B' : 'A'}` } }
    ]) {
      await expect(h.service.get(input)).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    }
    h.setClock(Date.parse('2026-09-03T00:16:00Z'));
    await expect(h.service.get({ ...scope, query: { ...query, cursor } })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    expect(h.transaction).toHaveBeenCalledTimes(1);
  });

  test('reassignment invalidates paging even if the same driver is assigned again', async () => {
    const h = harness(); const cursor = (await h.service.get({ ...scope, query }))!.page.nextCursor!;
    h.findFirst.mockResolvedValue({ shopId: 'shop', driverId: '40000000-0000-4000-8000-000000000001', assignmentGeneration: 3n });
    await expect(h.service.get({ ...scope, query: { ...query, cursor } })).rejects.toMatchObject({ code: 'ASSIGNMENT_CHANGED' });
    expect(h.raw).toHaveBeenCalledTimes(2);
  });

  test('replays the same cursor with precise timestamp/id seek and fixed storage cutoff', async () => {
    const h = harness(); const cursor = (await h.service.get({ ...scope, query }))!.page.nextCursor!;
    h.raw.mockResolvedValue([row(3)]);
    const next = await h.service.get({ ...scope, query: { ...query, cursor } });
    expect(await h.service.get({ ...scope, query: { ...query, cursor } })).toEqual(next);
    const sql = h.raw.mock.calls[2]![0] as Prisma.Sql;
    expect(sql.sql).toContain('AND ("occurredAt", "createdAt", id) >');
    expect(sql.values).toContain('2026-09-01T01:00:00.000001Z');
    expect(sql.values).toContain('2026-09-01T02:00:00.000001Z');
    expect(sql.values).toContain(row(2).eventId);
    expect(next).toMatchObject({ page: { returned: 1, totalReturned: 3, nextCursor: null, hasMore: false, snapshotAt } });
  });

  test('preserves quality truth, full stored precision, duplicates and minimum provenance', async () => {
    const h = harness([
      row(1), row(2, { accuracy: '0' }), row(3, { accuracy: null, latitude: null }),
      row(4, { accuracy: false, longitude: '181' }), row(5, { accuracy: -1 }),
      row(6, { accuracy: { phone: 'private' }, redacted: true })
    ]);
    const page = (await h.service.get({ ...scope, query: { ...query, limit: '10' } }))!;
    expect(page.observations.map(({ coordinateStatus, accuracyStatus }) => [coordinateStatus, accuracyStatus])).toEqual([
      ['VALID', 'VALID'], ['VALID', 'INVALID'], ['MISSING', 'MISSING'], ['INVALID', 'INVALID'], ['VALID', 'INVALID'], ['REDACTED', 'REDACTED']
    ]);
    expect(page.observations[0]).toMatchObject({ accuracyMeters: 0, latitude: 43.1234567,
      observedAt: '2026-09-01T01:00:00.000001Z', storedAt: '2026-09-01T02:00:00.000001Z' });
    expect(page.observations[0]?.clientEventKey).toEqual(page.observations[1]?.clientEventKey);
    expect(page.observations[0]?.eventId).not.toEqual(page.observations[1]?.eventId);
    expect(page.observations[5]).toMatchObject({ latitude: null, longitude: null, accuracyMeters: null, clientEventKey: null });
    expect(JSON.stringify(page)).not.toMatch(/unsafe-client-id|phone|payload|driverId|shopId/u);
  });

  test('enforces a 5000 record traversal cap with one bounded lookahead', async () => {
    const h = harness(Array.from({ length: 501 }, (_, index) => row(index + 1)));
    let cursor: string | null = null;
    for (let pageNumber = 1; pageNumber <= 10; pageNumber += 1) {
      const page: OriginalObservationsPage = (await h.service.get({ ...scope, query: { ...query, limit: '500', ...(cursor === null ? {} : { cursor }) } }))!;
      expect(page.page.totalReturned).toBe(pageNumber * 500);
      cursor = page.page.nextCursor;
      if (pageNumber === 10) expect(page.page).toMatchObject({ capReached: true, nextCursor: null, hasMore: false });
    }
  });

  test.each([['P2028', undefined], ['P2024', undefined], ['P2010', { code: '57014' }]] as const)(
    'classifies %s timeout without leaking DB error text', async (code, meta) => {
      const h = harness();
      h.transaction.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('private database text',
        { code, clientVersion: 'synthetic', ...(meta === undefined ? {} : { meta }) }));
      await expect(h.service.get({ ...scope, query })).rejects.toMatchObject({ code: 'READ_TIMEOUT', message: 'READ_TIMEOUT' });
    }
  );
});
