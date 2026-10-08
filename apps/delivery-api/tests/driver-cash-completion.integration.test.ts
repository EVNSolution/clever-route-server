import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';

import { PrismaClient, type Prisma } from '@prisma/client';
import { afterAll, describe, expect, test } from 'vitest';

import { buildApp } from '../src/app.js';
import { PrismaDriverAssignedRouteRepository } from '../src/modules/driver/driver-assigned-route.repository.js';
import { PrismaDriverEventReceiptRepository } from '../src/modules/driver/driver-event-receipt.repository.js';
import { PrismaDriverEventRepository } from '../src/modules/driver/driver-event.repository.js';
import { PrismaDriverTokenAccessRepository } from '../src/modules/driver/driver-token-access.repository.js';
import { signDriverAccountToken, signDriverRouteToken } from '../src/modules/driver/driver-token-verifier.js';
import { PrismaInventoryService } from '../src/modules/inventory/inventory.service.js';
import type { InventoryDto } from '../src/modules/inventory/inventory.types.js';
import type { DriverAssignedRoute } from '../src/modules/driver/driver-assigned-route.types.js';
import type { OrderPayment } from '../src/modules/payments/order-payment.js';
import { publishLiveRouteChange, saveLiveRouteChange } from '../src/modules/route-plans/live-route-change.js';
import { KFOOD_DELIVERY_APP_ID, KFOOD_DELIVERY_SHOP_DOMAIN } from '../src/modules/route-plans/kfood-delivery-completion.js';

const databaseUrl = process.env.CASH_COMPLETION_DATABASE_URL;
const enabled = process.env.CASH_COMPLETION_DATABASE_TARGET_CLASS === 'safe-local-disposable';
if (enabled) {
  let target: URL;
  try { target = new URL(databaseUrl ?? 'postgresql://disabled@127.0.0.1:1/disabled'); }
  catch { throw new Error('Invalid disposable cash completion database URL.'); }
  if (target.protocol !== 'postgresql:' || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)
    || target.pathname !== '/kfood_cash_completion' || target.port === '' || target.hash !== ''
    || [...target.searchParams].some(([key, value]) => key !== 'schema' || value !== 'public')) {
    throw new Error('Cash completion integration tests require the named loopback disposable database.');
  }
}

const secret = 'synthetic-cash-completion-http-secret';
type Completion = {
  id: string; eventId: string; deliveryStopId: string; routePlanId: string; driverId: string;
  assignmentGeneration: string; expectedRouteVersionId: string; method: OrderPayment['method'];
  expectedAmount: string | null; actualAmount: string | null; differenceAmount: string | null;
  currencyCode: string | null; occurredAt: string; recordedAt: string; payment: OrderPayment;
};
type EventResponse = {
  data: { duplicate: boolean; eventId: string; completion?: Completion; etaSnapshot?: unknown; etaUpdate?: unknown };
  error: { code: string } | null;
};
type EventBody = {
  clientEventId: string; deliveryStopId: string; eventType: string; occurredAt: string;
  driverContractVersion?: number; assignmentGeneration?: string; expectedRouteVersionId?: string;
  payload: { source: string }; completion?: { version: number; cashReceived?: { amount: unknown; currency: unknown } };
};

(enabled ? describe.sequential : describe.skip)('single completion and Cash PostgreSQL + loopback HTTP contract', () => {
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl ?? 'postgresql://disabled@127.0.0.1:1/disabled' });
  afterAll(async () => { await prisma.$disconnect(); });

  test.each([
    ['122.00', '-0.25'], ['122.25', '0.00'], ['123.00', '0.75'], ['0.00', '-122.25']
  ])('records actual %s without an arrival and preserves expected amount', async (amount, difference) => {
    const f = await fixture(prisma);
    await withServer(prisma, async server => {
      const body = eventBody(f, amount);
      const response = await post(server, f, body);
      expect(response.status).toBe(202);
      expect(response.body.data.completion).toMatchObject({
        eventId: response.body.data.eventId, deliveryStopId: f.stops[0]!.id, routePlanId: f.route.id,
        driverId: f.driver.id, assignmentGeneration: '2', expectedRouteVersionId: f.version.id,
        method: 'CASH', expectedAmount: '122.25', actualAmount: amount, differenceAmount: difference,
        currencyCode: 'CAD', occurredAt: body.occurredAt
      });
      expect(response.body.data.completion?.recordedAt).toEqual(expect.any(String));
      expect(response.body.data.etaUpdate).toMatchObject({ actualArrivalAt: null, trigger: 'STOP_DELIVERED' });
      expect(await prisma.driverEvent.count({ where: { routePlanId: f.route.id, eventType: 'STOP_ARRIVED' } })).toBe(0);
      expect((await prisma.deliveryStop.findUniqueOrThrow({ where: { id: f.stops[0]!.id } })).status).toBe('DELIVERED');
      const source = await prisma.order.findUniqueOrThrow({ where: { id: f.stops[0]!.orderId } });
      expect(source.totalPriceAmount?.toFixed(2)).toBe('122.25');
      expect(source.rawPayload).toEqual(f.rawPayload);
      expect(await receiptCount(prisma, f)).toBe(1);
    });
  });

  test('rejects omitted Cash and malformed money, but preserves the legacy omission contract', async () => {
    const f = await fixture(prisma);
    await withServer(prisma, async server => {
      const missing = await post(server, f, eventBody(f));
      expect(missing.status).toBe(400);
      expect(missing.body.error?.code).toBe('CASH_RECEIVED_REQUIRED');
      for (const cashReceived of [
        { amount: 122.25, currency: 'CAD' }, { amount: '122.255', currency: 'CAD' },
        { amount: '-1.00', currency: 'CAD' }, { amount: '1e2', currency: 'CAD' },
        { amount: 'NaN', currency: 'CAD' }, { amount: '122.00', currency: 'USD' },
        { amount: '122.00', currency: 'C' }
      ]) {
        const invalid = await post(server, f, { ...eventBody(f), completion: { version: 1, cashReceived } });
        expect(invalid.status).toBe(400);
      }
      const untrustedExpected = { ...eventBody(f), completion: { version: 1, expectedAmount: '0.00',
        cashReceived: { amount: '122.00', currency: 'CAD' } } };
      expect((await post(server, f, untrustedExpected)).status).toBe(400);
      expect(await receiptCount(prisma, f)).toBe(0);
      const legacy = eventBody(f);
      delete legacy.completion;
      delete legacy.driverContractVersion;
      delete legacy.expectedRouteVersionId;
      delete legacy.assignmentGeneration;
      expect((await post(server, f, legacy)).status).toBe(202);
      expect(await receiptCount(prisma, f)).toBe(0);
      const late = await post(server, f, { ...eventBody(f, '122.00'), clientEventId: legacy.clientEventId });
      expect(late.status).toBe(409);
      expect(await receiptCount(prisma, f)).toBe(0);
    });
  });

  test('rejects opt-in Cash without a server currency while preserving a separate legacy submission', async () => {
    const f = await fixture(prisma, { rawPayload: { paymentGatewayNames: ['Cash'] } });
    const legacy = await fixture(prisma, { rawPayload: { paymentGatewayNames: ['Cash'] } });
    await prisma.order.updateMany({ where: { id: { in: [f.stops[0]!.orderId, legacy.stops[0]!.orderId] } }, data: { currencyCode: null } });
    await withServer(prisma, async server => {
      for (const body of [eventBody(f), eventBody(f, '122.00')]) {
        expect((await post(server, f, body)).status).toBe(400);
      }
      expect(await receiptCount(prisma, f)).toBe(0);
      expect(await prisma.driverEvent.count({ where: { routePlanId: f.route.id, eventType: 'STOP_DELIVERED' } })).toBe(0);
      const body = eventBody(legacy);
      delete body.completion;
      expect((await post(server, legacy, body)).status).toBe(202);
      expect(await receiptCount(prisma, legacy)).toBe(0);
    });
  });

  test('finalizes missing Cash and malformed completion attempts as rejected', async () => {
    const f = await fixture(prisma);
    await withServer(prisma, async server => {
      const missing = eventBody(f);
      const invalid = { ...eventBody(f), completion: { version: 2 } };
      for (const [body, errorCode] of [[missing, 'CASH_RECEIVED_REQUIRED'], [invalid, 'CASH_COMPLETION_INVALID']] as const) {
        const response = await post(server, f, body);
        expect(response.status).toBe(400);
        expect(response.body.error?.code).toBe(errorCode);
        const attempts = await prisma.driverEventAttempt.findMany({ where: { routePlanId: f.route.id, clientEventId: body.clientEventId } });
        expect(attempts).toHaveLength(1);
        expect(attempts[0]).toMatchObject({ status: 'REJECTED', errorCode, retryable: false, committedEventId: null });
      }
      expect(await receiptCount(prisma, f)).toBe(0);
      expect(await prisma.driverEvent.count({ where: { routePlanId: f.route.id, eventType: 'STOP_DELIVERED' } })).toBe(0);
    });
  });

  test.each([
    { label: 'eTransfer', raw: { paymentGatewayNames: ['Interac e-Transfer'] }, financialStatus: 'PENDING', method: 'ETRANSFER', expected: '122.25', amount: undefined },
    { label: 'paid Cash', raw: { paymentGatewayNames: ['Cash'] }, financialStatus: 'PAID', method: 'CASH', expected: '0.00', amount: undefined },
    { label: 'partial Cash with known outstanding', raw: { paymentGatewayNames: ['Cash'], totalOutstandingSet: { shopMoney: { amount: '22.25', currencyCode: 'CAD' } } }, financialStatus: 'PARTIALLY_PAID', method: 'CASH', expected: '22.25', amount: '22.00' },
    { label: 'partial Cash with unknown outstanding', raw: { paymentGatewayNames: ['Cash'] }, financialStatus: 'PARTIALLY_PAID', method: 'CASH', expected: null, amount: '22.00' },
    { label: 'unknown payment', raw: {}, financialStatus: null, method: 'UNKNOWN', expected: null, amount: undefined },
    { label: 'zero Cash', raw: { paymentGatewayNames: ['Cash'], totalOutstandingSet: { shopMoney: { amount: '0.00', currencyCode: 'CAD' } } }, financialStatus: 'PENDING', method: 'CASH', expected: '0.00', amount: undefined }
  ])('handles $label without substituting the order total for actual receipts', async ({ raw, financialStatus, method, expected, amount }) => {
    const f = await fixture(prisma, { rawPayload: raw, financialStatus });
    await withServer(prisma, async server => {
      if (expected === null && method === 'CASH') {
        expect((await post(server, f, eventBody(f))).body.error?.code).toBe('CASH_RECEIVED_REQUIRED');
      }
      const response = await post(server, f, eventBody(f, amount));
      expect(response.status).toBe(202);
      expect(response.body.data.completion).toMatchObject({ method, expectedAmount: expected, actualAmount: amount ?? null });
      if (expected === null) expect(response.body.data.completion?.differenceAmount).toBeNull();
    });
  });

  test('rolls back the stop, event, receipt, and ETA when receipt persistence fails', async () => {
    const f = await fixture(prisma);
    const before = await prisma.routePlanStop.findMany({ where: { routePlanId: f.route.id }, orderBy: { sequence: 'asc' } });
    // A real PostgreSQL exception after INSERT tests the same transaction as the event and stop writes.
    await prisma.$executeRawUnsafe(`CREATE FUNCTION fail_cash_receipt_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic cash receipt failure'; END $$`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER fail_cash_receipt_test AFTER INSERT ON driver_stop_completion_receipts FOR EACH ROW EXECUTE FUNCTION fail_cash_receipt_test()`);
    try {
      await withServer(prisma, async server => {
        expect((await post(server, f, eventBody(f, '122.00'))).status).toBe(500);
      });
      expect(await receiptCount(prisma, f)).toBe(0);
      expect(await prisma.driverEvent.count({ where: { routePlanId: f.route.id, eventType: 'STOP_DELIVERED' } })).toBe(0);
      expect((await prisma.deliveryStop.findUniqueOrThrow({ where: { id: f.stops[0]!.id } })).status).toBe('ASSIGNED');
      expect(await prisma.routePlanStop.findMany({ where: { routePlanId: f.route.id }, orderBy: { sequence: 'asc' } })).toEqual(before);
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER fail_cash_receipt_test ON driver_stop_completion_receipts');
      await prisma.$executeRawUnsafe('DROP FUNCTION fail_cash_receipt_test()');
    }
    await withServer(prisma, async server => { expect((await post(server, f, eventBody(f, '122.00'))).status).toBe(202); });
  });

  test('deduplicates concurrent HTTP requests and preserves the original result after service restart', async () => {
    const f = await fixture(prisma);
    const body = eventBody(f, '122.00');
    let original!: EventResponse['data'];
    await withServer(prisma, async server => {
      const concurrent = await Promise.all([post(server, f, body), post(server, f, body)]);
      expect(concurrent.map(result => result.status).sort()).toEqual([200, 202]);
      original = concurrent.find(result => result.status === 202)!.body.data;
      expect(concurrent.find(result => result.status === 200)!.body.data).toEqual({ ...original, duplicate: true });
      // Progress and source changes must not recalculate the response from mutable current state.
      await post(server, f, { ...eventBody(f, '123.00'), deliveryStopId: f.stops[1]!.id });
      await prisma.order.update({ where: { id: f.stops[0]!.orderId }, data: { financialStatus: 'PAID' } });
    });
    const restarted = new PrismaClient({ datasourceUrl: databaseUrl! });
    try {
      await withServer(restarted, async server => {
        const retry = await post(server, f, body);
        expect(retry.status).toBe(200);
        expect(retry.body.data).toEqual({ ...original, duplicate: true });
        const lookup = await fetch(`${server}/driver/event-receipts/${f.route.id}/${body.clientEventId}`, {
          headers: { authorization: `Bearer ${accountToken(f)}` }
        });
        expect(lookup.status).toBe(200);
        expect(lookup.headers.get('cache-control')).toBe('private, no-store');
        const receipt = await lookup.json() as { data: { completion: Completion; status: string } };
        expect(receipt.data.status).toBe('APPLIED');
        expect(receipt.data.completion).toEqual(original.completion);
      });
    } finally { await restarted.$disconnect(); }
    expect(await prisma.driverEvent.count({ where: { clientEventId: body.clientEventId, routePlanId: f.route.id } })).toBe(1);
    expect(await receiptCount(prisma, f)).toBe(2);
  });

  test('recovers an accepted completion after the client socket discards the entire response', async () => {
    const f = await fixture(prisma);
    const body = eventBody(f, '122.00');
    let committed!: EventResponse['data'];
    await withServer(prisma, async server => {
      const address = new URL(server);
      const socket = createConnection({ host: address.hostname, port: Number(address.port) });
      // Keep the client read side paused; it never parses a status, header, or response body.
      socket.pause();
      try {
        await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
        const json = JSON.stringify(body);
        socket.write(`POST /driver/events HTTP/1.1\r\nHost: ${address.host}\r\nAuthorization: Bearer ${routeToken(f)}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(json)}\r\nConnection: close\r\n\r\n${json}`);
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const rows = await prisma.$queryRaw<Array<{ result: EventResponse['data'] }>>`SELECT result FROM driver_stop_completion_receipts WHERE "clientEventId" = ${body.clientEventId}`;
          if (rows[0] !== undefined) { committed = rows[0].result; break; }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        expect(committed).toBeDefined();
      } finally { socket.destroy(); }
    });
    await withServer(prisma, async server => {
      const retry = await post(server, f, body);
      expect(retry.status).toBe(200);
      expect(retry.body.data).toEqual({ duplicate: true, eventId: committed.eventId, completion: committed.completion,
        ...(committed.etaSnapshot === undefined ? {} : { etaSnapshot: committed.etaSnapshot }),
        ...(committed.etaUpdate === undefined ? {} : { etaUpdate: committed.etaUpdate }) });
    });
    expect(await receiptCount(prisma, f)).toBe(1);
    expect(await prisma.driverEvent.count({ where: { routePlanId: f.route.id, eventType: 'STOP_DELIVERED' } })).toBe(1);
  });

  test('preserves the original account receipt after reassignment without exposing it to the replacement account', async () => {
    const f = await fixture(prisma);
    const replacement = await fixture(prisma);
    const body = eventBody(f, '122.00');
    await withServer(prisma, async server => {
      const original = await post(server, f, body);
      expect(original.status).toBe(202);
      await prisma.$transaction(async tx => {
        await tx.routePlan.update({ where: { id: f.route.id }, data: { driverId: replacement.driver.id, assignmentGeneration: { increment: 1 } } });
        const previous = await tx.routeGroupingChildVersion.update({ where: { id: f.version.id }, data: { status: 'ARCHIVED', supersededAt: new Date() } });
        await tx.routeGroupingChildVersion.create({ data: { shopId: f.shop.id, groupingId: previous.groupingId,
          groupingVersionId: previous.groupingVersionId, routePlanId: f.route.id, driverId: replacement.driver.id,
          version: 2, snapshot: previous.snapshot as Prisma.InputJsonObject, publishedAt: new Date() } });
      });
      const url = `${server}/driver/event-receipts/${f.route.id}/${body.clientEventId}`;
      const own = await fetch(url, { headers: { authorization: `Bearer ${accountToken(f)}` } });
      expect(own.status).toBe(200);
      const ownReceipt = await own.json() as { data: { status: string; completion: Completion } };
      expect(ownReceipt.data.status).toBe('APPLIED');
      expect(ownReceipt.data.completion).toEqual(original.body.data.completion);
      const other = await fetch(url, { headers: { authorization: `Bearer ${accountToken(replacement)}` } });
      expect(other.status).toBe(200);
      const otherReceipt = await other.json() as { data: { status: string; completion?: Completion } };
      expect(otherReceipt.data.status).toBe('UNKNOWN');
      expect(otherReceipt.data.completion).toBeUndefined();
      const staleEvent = { ...eventBody(f, '122.00'), deliveryStopId: f.stops[1]!.id };
      expect((await post(server, f, staleEvent)).status).toBe(401);
      expect(await receiptCount(prisma, f)).toBe(1);
    });
  });

  test('rejects changed amount, payload, delivery stop, generation, route, driver, or shop for a committed identifier', async () => {
    const f = await fixture(prisma);
    const anotherDriver = await fixture(prisma);
    const anotherShop = await fixture(prisma, { shopDomain: 'synthetic-cash-other.myshopify.com' });
    const body = eventBody(f, '122.00');
    await withServer(prisma, async server => {
      const first = await post(server, f, body);
      expect(first.status).toBe(202);
      const attempts: Array<[Fixture, EventBody]> = [
        [f, { ...body, completion: { version: 1, cashReceived: { amount: '123.00', currency: 'CAD' } } }],
        [f, { ...body, payload: { source: 'changed-payload' } }],
        [f, { ...body, deliveryStopId: f.stops[1]!.id }],
        [f, { ...body, assignmentGeneration: '1' }],
        [anotherDriver, { ...eventBody(anotherDriver, '122.00'), clientEventId: body.clientEventId }]
      ];
      for (const [identity, request] of attempts) {
        const response = await post(server, identity, request);
        expect(response.status).toBe(409);
        expect(response.body.error?.code).toBe('CASH_COMPLETION_CONFLICT');
      }
      const unsupportedShop = await post(server, anotherShop, { ...eventBody(anotherShop, '122.00'), clientEventId: body.clientEventId });
      expect(unsupportedShop.status).toBe(400);
      expect(unsupportedShop.body.error?.code).toBe('CASH_COMPLETION_INVALID');
      expect((await post(server, f, eventBody(f, '123.00'))).status).toBe(409);
      await expect(prisma.$executeRaw`UPDATE driver_stop_completion_receipts SET "actualAmount" = 123.00 WHERE id = ${first.body.data.completion!.id}::uuid`)
        .rejects.toThrow('immutable');
      expect((await post(server, f, body)).body.data.completion).toEqual(first.body.data.completion);
      expect(await receiptCount(prisma, f)).toBe(1);
    });
  });

  test('rejects unauthorized stops and prior assignments before first completion; preserves non-opt-in tenant events', async () => {
    const f = await fixture(prisma);
    const foreign = await fixture(prisma, { shopDomain: 'dsv.synthetic.test' });
    await withServer(prisma, async server => {
      expect((await post(server, f, { ...eventBody(f, '122.00'), deliveryStopId: foreign.stops[0]!.id })).status).toBeGreaterThanOrEqual(400);
      expect((await post(server, f, { ...eventBody(f, '122.00'), assignmentGeneration: '1' })).status).toBe(409);
      const wrongAccount = await fetch(`${server}/driver/events`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${routeToken(f, foreign.account.id)}` },
        body: JSON.stringify(eventBody(f, '122.00'))
      });
      expect(wrongAccount.status).toBe(401);
      expect(await receiptCount(prisma, f)).toBe(0);
      const legacyForeign = eventBody(foreign);
      delete legacyForeign.completion;
      expect((await post(server, foreign, legacyForeign)).status).toBe(202);
      expect(await receiptCount(prisma, foreign)).toBe(0);
    });
  });

  test('preserves authorized old-version Cash input after an unrelated publication and rejects changed future stops', async () => {
    const f = await fixture(prisma);
    const identity = { routePlanId: f.route.id, shopId: f.shop.id, expectedAssignmentGeneration: '2', expectedRouteVersionId: f.version.id };
    await saveLiveRouteChange(prisma, { ...identity, commandId: randomUUID(), expectedRevision: 0,
      stopOverrides: [{ deliveryStopId: f.stops[2]!.id, address1: '700 Published Cash Test Road', latitude: 43.57, longitude: -80.57 }] });
    await publishLiveRouteChange(prisma, { ...identity, commandId: randomUUID(), expectedRevision: 1 });
    await withServer(prisma, async server => {
      const accepted = await post(server, f, eventBody(f, '122.00'));
      expect(accepted.status).toBe(202);
      expect(accepted.body.data.completion?.expectedRouteVersionId).toBe(f.version.id);
      const rejected = await post(server, f, { ...eventBody(f, '122.00'), deliveryStopId: f.stops[2]!.id });
      expect(rejected.status).toBe(409);
      expect(await receiptCount(prisma, f)).toBe(1);
    });
  });

  test.each([
    { paymentGatewayNames: ['Cash'] },
    { paymentGatewayNames: ['manual'], cleverManualPaymentMethod: 'ETRANSFER' },
    { paymentMethodTitle: 'Cash' }
  ])('uses the same payment and receipt projection in driver and office HTTP reads: %j', async rawPayload => {
    const f = await fixture(prisma, { rawPayload });
    await withServer(prisma, async server => {
      const completion = await post(server, f, eventBody(f, rawPayload.cleverManualPaymentMethod === 'ETRANSFER' ? undefined : '122.00'));
      expect(completion.status).toBe(202);
      const assigned = await fetch(`${server}/driver/assigned-route`, { headers: { authorization: `Bearer ${routeToken(f)}` } });
      expect(assigned.status).toBe(200);
      const driver = await assigned.json() as { data: { route: DriverAssignedRoute } };
      const office = await fetch(`${server}/admin/inventories/${f.inventory.id}`, { headers: {
        authorization: 'Bearer synthetic-admin', 'x-clever-app-id': KFOOD_DELIVERY_APP_ID
      } });
      expect(office.status).toBe(200);
      const inventory = await office.json() as { data: { inventory: InventoryDto } };
      const driverStop = driver.data.route.stops.find(stop => stop.deliveryStopId === f.stops[0]!.id)!;
      const officeOrder = inventory.data.inventory.orders.find(order => order.id === f.stops[0]!.orderId)!;
      expect(driverStop.payment).toEqual(officeOrder.payment);
      expect(driverStop.completion).toEqual(completion.body.data.completion);
      expect(officeOrder.completion).toEqual(completion.body.data.completion);
    });
  });
});

type Fixture = Awaited<ReturnType<typeof fixture>>;
function eventBody(f: Fixture, amount?: string): EventBody {
  return { clientEventId: randomUUID(), deliveryStopId: f.stops[0]!.id, eventType: 'STOP_DELIVERED',
    occurredAt: f.occurredAt.toISOString(), driverContractVersion: 2, assignmentGeneration: '2', expectedRouteVersionId: f.version.id,
    payload: { source: 'synthetic-cash-http' }, completion: { version: 1, ...(amount === undefined ? {} : { cashReceived: { amount, currency: 'CAD' } }) } };
}
function routeToken(f: Fixture, accountId = f.account.id) {
  return signDriverRouteToken({ accountId, routePlanId: f.route.id, tokenVersion: f.account.tokenVersion,
    subject: `driver-account:${accountId}`, expiresInSeconds: 600 }, { secret }).token;
}
function accountToken(f: Fixture) {
  return signDriverAccountToken({ accountId: f.account.id, tokenVersion: f.account.tokenVersion,
    subject: `driver-account:${f.account.id}`, expiresInSeconds: 600 }, { secret }).token;
}
async function post(server: string, f: Fixture, body: EventBody) {
  const response = await fetch(`${server}/driver/events`, { method: 'POST',
    headers: { authorization: `Bearer ${routeToken(f)}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as EventResponse };
}
async function receiptCount(prisma: PrismaClient, f: Fixture) {
  const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) FROM driver_stop_completion_receipts WHERE "routePlanId" = ${f.route.id}::uuid`;
  return Number(rows[0]!.count);
}
async function withServer(prisma: PrismaClient, run: (server: string) => Promise<void>) {
  const app = await buildApp({ driverApi: {
    driverEventService: new PrismaDriverEventRepository(prisma), driverEventReceiptService: new PrismaDriverEventReceiptRepository(prisma),
    driverAssignedRouteService: new PrismaDriverAssignedRouteRepository(prisma),
    driverTokenAccessRepository: new PrismaDriverTokenAccessRepository(prisma), jwtSecret: secret
  }, adminInventories: {
    inventoryService: new PrismaInventoryService(prisma), sessionTokenVerifier: { verify(token) {
      if (token !== 'synthetic-admin') throw new Error('Invalid synthetic admin token');
      return { appId: KFOOD_DELIVERY_APP_ID, shopDomain: KFOOD_DELIVERY_SHOP_DOMAIN, subject: 'synthetic-office' };
    } }
  } });
  try {
    const server = await app.listen({ host: '127.0.0.1', port: 0 });
    await run(server);
  } finally { await app.close(); }
}

async function fixture(prisma: PrismaClient, options: {
  rawPayload?: Prisma.InputJsonObject; financialStatus?: string | null; shopDomain?: string;
} = {}) {
  const suffix = randomUUID();
  const now = new Date();
  const occurredAt = new Date(now.getTime() - 10_000);
  const shopDomain = options.shopDomain ?? KFOOD_DELIVERY_SHOP_DOMAIN;
  const shop = await prisma.shop.upsert({ where: { appId_shopDomain: { appId: KFOOD_DELIVERY_APP_ID, shopDomain } },
    create: { appId: KFOOD_DELIVERY_APP_ID, shopDomain }, update: {} });
  const account = await prisma.driverAccount.create({ data: { phone: `cash-${suffix}` } });
  const driver = await prisma.driver.create({ data: { accountId: account.id, authSubject: `cash-${suffix}`, displayName: 'Synthetic Cash Driver', shopId: shop.id } });
  const route = await prisma.routePlan.create({ data: { shopId: shop.id, driverId: driver.id, name: `cash-${suffix}`, planDate: now,
    constraints: { timezone: 'America/Toronto' }, metrics: {}, optimizerVersion: 'synthetic-integration', status: 'IN_PROGRESS', assignmentGeneration: 2n } });
  const group = await prisma.routeGrouping.create({ data: { shopId: shop.id, name: `cash-${suffix}`, planDate: now } });
  const parent = await prisma.routeGroupingVersion.create({ data: { shopId: shop.id, groupingId: group.id, version: 1 } });
  const version = await prisma.routeGroupingChildVersion.create({ data: { shopId: shop.id, groupingId: group.id, groupingVersionId: parent.id,
    routePlanId: route.id, driverId: driver.id, version: 1, snapshot: {}, publishedAt: now } });
  const inventory = await prisma.inventory.create({ data: { shopId: shop.id, name: `cash-${suffix}` } });
  const rawPayload = options.rawPayload ?? { paymentGatewayNames: ['Cash'], totalOutstandingSet: { shopMoney: { amount: '122.25', currencyCode: 'CAD' } } };
  const stops = [];
  const members = [];
  for (let index = 0; index < 3; index += 1) {
    const sourceOrderId = `gid://shopify/Order/cash-${suffix}-${index}`;
    const order = await prisma.order.create({ data: { shopId: shop.id, name: `#synthetic-cash-${index}`, rawPayload,
      shopifyOrderGid: sourceOrderId, currentRouteVersionId: version.id, totalPriceAmount: '122.25', currencyCode: 'CAD',
      financialStatus: options.financialStatus === undefined ? 'PENDING' : options.financialStatus } });
    const stop = await prisma.deliveryStop.create({ data: { shopId: shop.id, orderId: order.id, address1: `${index + 1} Cash Test Road`,
      city: 'Synthetic City', countryCode: 'CA', latitude: 43.4 + index / 100, longitude: -80.4 - index / 100, status: 'ASSIGNED' } });
    await prisma.routePlanStop.create({ data: { shopId: shop.id, routePlanId: route.id, deliveryStopId: stop.id, sequence: index + 1,
      estimatedArrivalAt: new Date(now.getTime() + (index + 1) * 60_000), durationFromPreviousSeconds: 60, distanceFromPreviousMeters: 1000,
      etaInputRouteVersionId: version.id, etaStatus: 'READY', etaCalculatedAt: now, etaSource: 'SYNTHETIC' } });
    await prisma.inventoryOrder.create({ data: { shopId: shop.id, inventoryId: inventory.id, orderId: order.id } });
    stops.push(stop);
    members.push({ sequence: index + 1, deliveryStopId: stop.id, orderId: order.id, sourceOrderId,
      address1: stop.address1, latitude: stop.latitude?.toString(), longitude: stop.longitude?.toString() });
  }
  await prisma.routeGroupingChildVersion.update({ where: { id: version.id }, data: { snapshot: { membershipSchemaVersion: 1, stops: members } } });
  for (const eventType of ['ROUTE_STARTED', 'PICKUP_COMPLETED'] as const) {
    await prisma.driverEvent.create({ data: { shopId: shop.id, driverId: driver.id, routePlanId: route.id, routeVersionId: version.id,
      assignmentGeneration: 2n, expectedRouteVersionId: version.id, driverContractVersion: 2, clientEventId: randomUUID(), eventType,
      occurredAt: new Date(now.getTime() - 60_000), payload: { source: 'synthetic-cash-seed' } } });
  }
  return { shop, account, driver, route, version, stops, inventory, rawPayload, occurredAt };
}
