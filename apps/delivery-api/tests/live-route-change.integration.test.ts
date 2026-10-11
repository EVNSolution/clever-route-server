import { randomUUID } from 'node:crypto';

import { PrismaClient, type Prisma } from '@prisma/client';
import { afterAll, describe, expect, test, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import { PrismaDriverAssignedRouteRepository } from '../src/modules/driver/driver-assigned-route.repository.js';
import { PrismaDriverEventRepository } from '../src/modules/driver/driver-event.repository.js';
import { PrismaDriverTokenAccessRepository } from '../src/modules/driver/driver-token-access.repository.js';
import { PrismaDriverRouteAccessRepository } from '../src/modules/driver/driver-route-access.repository.js';
import { PrismaDriverRouteOrderService } from '../src/modules/driver/driver-route-order.service.js';
import { signDriverRouteToken } from '../src/modules/driver/driver-token-verifier.js';
import {
  acknowledgeLiveRouteChange,
  discardLiveRouteChange,
  getAdminLiveRouteChange,
  getLiveRouteChange,
  publishLiveRouteChange,
  saveLiveRouteChange
} from '../src/modules/route-plans/live-route-change.js';
import { PrismaLiveRouteChangeService } from '../src/modules/route-plans/live-route-change.service.js';
import { KFOOD_DELIVERY_APP_ID, KFOOD_DELIVERY_SHOP_DOMAIN } from '../src/modules/route-plans/kfood-delivery-completion.js';
import type { DriverPushProvider } from '../src/modules/route-grouping/driver-push.provider.js';
import { PrismaRouteGroupingService } from '../src/modules/route-grouping/route-grouping.service.js';
import { RoutePlanAdminService, type RouteGeometryProvider } from '../src/modules/route-plans/route-plan.service.js';
import { PrismaRoutePlanRepository } from '../src/modules/route-plans/route-plan.repository.js';
import type { RoutePlanDetail, RoutePlanRouteResult } from '../src/modules/route-plans/route-plan.types.js';
import { mapShopifyOrderNodeToDeliveryInputs } from '../src/modules/shopify/order-sync.mapper.js';
import { PrismaOrderSyncRepository } from '../src/modules/shopify/order-sync.repository.js';

const fixtureIdentities = new Map<string, { expectedAssignmentGeneration: string; expectedRouteVersionId: string }>();
const databaseUrl = process.env.LIVE_ROUTE_CHANGE_DATABASE_URL;
const enabled = process.env.LIVE_ROUTE_CHANGE_DATABASE_TARGET_CLASS === 'safe-local-disposable';
if (enabled) {
  let target: URL;
  try { target = new URL(databaseUrl ?? 'postgresql://disabled@127.0.0.1:1/disabled'); }
  catch { throw new Error('Invalid disposable live route change database URL.'); }
  if (target.protocol !== 'postgresql:' || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)
    || target.pathname !== '/kfood_live_change' || target.port === '' || target.hash !== ''
    || [...target.searchParams].some(([key, value]) => key !== 'schema' || value !== 'public')) {
    throw new Error('Live route change integration tests require the named loopback disposable database.');
  }
}

(enabled ? describe.sequential : describe.skip)('live route change PostgreSQL contract', () => {
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl ?? 'postgresql://disabled@127.0.0.1:1/disabled' });
  afterAll(async () => { await prisma.$disconnect(); });

  test('keeps saved address and future order private, preserves current stop, and publishes immutable content once', async () => {
    const f = await fixture(prisma);
    const initial = await getAdminLiveRouteChange(prisma, adminIdentity(f));
    expect(initial.revision).toBe(0);
    const before = await readAssigned(prisma, f);
    const futureOrder = f.stops.slice(2).map(stop => stop.id).reverse();
    const saved = await saveDraft(prisma, {
      ...adminIdentity(f), expectedRevision: 0,
      stopOverrides: [{ deliveryStopId: f.stops[6]!.id, address1: '700 Corrected Integration Road', latitude: 43.57, longitude: -80.57 }],
      futureStopOrder: futureOrder
    });
    expect(saved.revision).toBe(1);
    expect(saved.hasUnpublishedChanges).toBe(true);
    expect(await readAssigned(prisma, f)).toEqual(before);
    expect((await prisma.deliveryStop.findUniqueOrThrow({ where: { id: f.stops[6]!.id } })).address1).toBe('7 Integration Road');

    const dispatchCommandId = randomUUID();
    const [first, retry] = await Promise.all([
      dispatch(prisma, { ...adminIdentity(f), expectedRevision: 1, commandId: dispatchCommandId }),
      dispatch(prisma, { ...adminIdentity(f), expectedRevision: 1, commandId: dispatchCommandId })
    ]);
    expect(first.publicationVersionId).toBe(retry.publicationVersionId);
    expect(first.sequence).toBe(1);
    expect(await publicationCount(prisma, f)).toBe(1);
    await expect(prisma.routeLiveChangePublication.update({ where: { id: first.publicationVersionId }, data: { snapshot: { schemaVersion: 1, stops: [] } } }))
      .rejects.toThrow('immutable');
    const assigned = await readAssigned(prisma, f);
    expect(assigned.stops.map(stop => stop.deliveryStopId)).toEqual([f.stops[0]!.id, f.stops[1]!.id, ...futureOrder]);
    expect(assigned.stops.find(stop => stop.deliveryStopId === f.stops[6]!.id)?.address.address1).toBe('700 Corrected Integration Road');
    expect(assigned.stops.find(stop => stop.deliveryStopId === f.stops[1]!.id)).toMatchObject({
      status: 'ARRIVED', sequence: 2, estimatedArrivalAt: f.currentEta.toISOString(), address: { address1: '2 Integration Road' }
    });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: f.stops[6]!.orderId } })).rawPayload).toEqual(f.upstreamPayloads[6]);
    expect((await prisma.driverEvent.findUniqueOrThrow({ where: { id: f.arrival.id } })).occurredAt).toEqual(f.arrivedAt);
    expect((await prisma.routePlan.findUniqueOrThrow({ where: { id: f.route.id } })).assignmentGeneration).toBe(2n);
    expect((await getAdminLiveRouteChange(prisma, adminIdentity(f))).hasUnpublishedChanges).toBe(false);
    expect((await readPublication(prisma, f)).pending).toBe(true);

    const unchanged = await saveDraft(prisma, {
      ...adminIdentity(f), expectedRevision: 1,
      stopOverrides: [{ deliveryStopId: f.stops[6]!.id, address1: '700 Corrected Integration Road', latitude: 43.57, longitude: -80.57 }],
      futureStopOrder: futureOrder
    });
    expect(unchanged.revision).toBe(1);
    expect((await dispatch(prisma, { ...adminIdentity(f), expectedRevision: 1 })).publicationVersionId).toBe(first.publicationVersionId);
    expect(await publicationCount(prisma, f)).toBe(1);
  });

  test('serializes a future edit against valid offline completion and rejects changed-stop old-version writes', async () => {
    const f = await fixture(prisma);
    const events = new PrismaDriverEventRepository(prisma);
    const completed = eventInput(f, f.stops[1]!.id);
    const outcome = await withRouteLock(prisma, f, () => Promise.all([
      saveDraft(prisma, {
        ...adminIdentity(f), expectedRevision: 0,
        stopOverrides: [{ deliveryStopId: f.stops[6]!.id, address1: '700 Concurrent Integration Road', latitude: 43.57, longitude: -80.57 }]
      }),
      events.recordDriverEvent(completed)
    ]), 2);
    expect(outcome[1].duplicate).toBe(false);
    const published = await dispatch(prisma, { ...adminIdentity(f), expectedRevision: 1 });
    const receipts = await Promise.all([events.recordDriverEvent(completed), events.recordDriverEvent(completed)]);
    expect(receipts.every(receipt => receipt.duplicate && receipt.eventId === outcome[1].eventId)).toBe(true);
    expect(await prisma.driverEvent.count({ where: { routePlanId: f.route.id, eventType: 'STOP_DELIVERED', deliveryStopId: f.stops[1]!.id } })).toBe(1);
    expect((await prisma.deliveryStop.findUniqueOrThrow({ where: { id: f.stops[1]!.id } })).status).toBe('DELIVERED');
    await expect(events.recordDriverEvent(eventInput(f, f.stops[6]!.id))).rejects.toThrow();
    expect(await prisma.driverEvent.count({ where: { routePlanId: f.route.id, eventType: 'STOP_DELIVERED', deliveryStopId: f.stops[6]!.id } })).toBe(0);
    // A delayed arrival cannot turn the completed current stop back into ARRIVED.
    await expect(events.recordDriverEvent({ ...eventInput(f, f.stops[1]!.id), eventType: 'STOP_ARRIVED' }))
      .resolves.toMatchObject({ duplicate: true, eventId: f.arrival.id });
    expect((await prisma.deliveryStop.findUniqueOrThrow({ where: { id: f.stops[1]!.id } })).status).toBe('DELIVERED');
    expect((await readPublication(prisma, f)).publicationVersionId).toBe(published.publicationVersionId);
  });

  test('accepts an unchanged stop first submitted offline after a new address and future-order publication', async () => {
    const f = await fixture(prisma);
    await saveDraft(prisma, {
      ...adminIdentity(f), expectedRevision: 0,
      stopOverrides: [{ deliveryStopId: f.stops[6]!.id, address1: '700 Offline Integration Road', latitude: 43.57, longitude: -80.57 }],
      futureStopOrder: f.stops.slice(2).map(stop => stop.id).reverse()
    });
    await dispatch(prisma, { ...adminIdentity(f), expectedRevision: 1 });
    const events = new PrismaDriverEventRepository(prisma);
    const oldEvent = eventInput(f, f.stops[1]!.id);
    const [applied, duplicate] = await Promise.all([events.recordDriverEvent(oldEvent), events.recordDriverEvent(oldEvent)]);
    expect([applied.duplicate, duplicate.duplicate].sort()).toEqual([false, true]);
    expect(applied.eventId).toBe(duplicate.eventId);
    expect(await prisma.driverEvent.findUniqueOrThrow({ where: { id: applied.eventId } })).toMatchObject({
      expectedRouteVersionId: f.version.id, assignmentGeneration: 2n, occurredAt: oldEvent.occurredAt
    });
    expect((await prisma.driverEvent.findUniqueOrThrow({ where: { id: f.arrival.id } })).occurredAt).toEqual(f.arrivedAt);
    await expect(events.recordDriverEvent(eventInput(f, f.stops[6]!.id))).rejects.toThrow();
    await expect(events.recordDriverEvent({ ...eventInput(f, f.stops[1]!.id), deliveryStopId: null, eventType: 'ROUTE_COMPLETED' }))
      .rejects.toMatchObject({ code: 'ROUTE_VERSION_MISMATCH' });
    expect(await prisma.driverEvent.count({ where: { routePlanId: f.route.id, eventType: 'ROUTE_COMPLETED' } })).toBe(0);
  });

  test('refuses to publish a drafted stop that became the current stop after offline completion', async () => {
    const f = await fixture(prisma);
    await saveDraft(prisma, {
      ...adminIdentity(f), expectedRevision: 0,
      stopOverrides: [{ deliveryStopId: f.stops[2]!.id, address1: '300 Drafted Future Road', latitude: 43.57, longitude: -80.57 }]
    });
    await new PrismaDriverEventRepository(prisma).recordDriverEvent(eventInput(f, f.stops[1]!.id));
    await expect(dispatch(prisma, { ...adminIdentity(f), expectedRevision: 1 }))
      .rejects.toMatchObject({ code: 'STOP_NOT_FUTURE', statusCode: 409 });
    expect((await prisma.deliveryStop.findUniqueOrThrow({ where: { id: f.stops[2]!.id } })).address1).toBe('3 Integration Road');
    expect(await publicationCount(prisma, f)).toBe(0);
    expect((await prisma.deliveryStop.findUniqueOrThrow({ where: { id: f.stops[1]!.id } })).status).toBe('DELIVERED');
  });

  test('explicitly discards a stranded private draft and recovers future Save and Dispatch with guarded retries', async () => {
    const f = await fixture(prisma);
    await saveDraft(prisma, { ...adminIdentity(f), expectedRevision: 0,
      stopOverrides: [{ deliveryStopId: f.stops[6]!.id, address1: '700 Previously Published Correction', latitude: 43.57, longitude: -80.57 }] });
    const first = await dispatch(prisma, { ...adminIdentity(f), expectedRevision: 1 });
    await saveDraft(prisma, { ...adminIdentity(f), expectedRevision: 1,
      stopOverrides: [{ deliveryStopId: f.stops[2]!.id, address1: '300 Stranded Private Correction', latitude: 43.53, longitude: -80.53 }] });
    const completed = await new PrismaDriverEventRepository(prisma).recordDriverEvent(eventInput(f, f.stops[1]!.id));
    await expect(dispatch(prisma, { ...adminIdentity(f), expectedRevision: 2 })).rejects.toMatchObject({ code: 'STOP_NOT_FUTURE' });
    await saveDraft(prisma, { ...adminIdentity(f), expectedRevision: 2,
      stopOverrides: [{ deliveryStopId: f.stops[6]!.id, address1: '700 Blocked Recovery Correction', latitude: 43.58, longitude: -80.58 }] });
    await expect(dispatch(prisma, { ...adminIdentity(f), expectedRevision: 3 })).rejects.toMatchObject({ code: 'STOP_NOT_FUTURE' });
    await expect(saveDraft(prisma, { ...adminIdentity(f), expectedRevision: 3,
      stopOverrides: [{ deliveryStopId: f.stops[2]!.id, address1: f.stops[2]!.address1, latitude: 43.42, longitude: -80.42 }] }))
      .rejects.toMatchObject({ code: 'STOP_NOT_FUTURE' });
    const stateBeforeGet = await prisma.routeLiveChangeState.findUniqueOrThrow({ where: { routePlanId: f.route.id } });
    expect((await getAdminLiveRouteChange(prisma, adminIdentity(f))).revision).toBe(3);
    expect((await getAdminLiveRouteChange(prisma, adminIdentity(f))).revision).toBe(3);
    expect(await prisma.routeLiveChangeState.findUniqueOrThrow({ where: { routePlanId: f.route.id } })).toEqual(stateBeforeGet);
    const publicationsBefore = await prisma.routeLiveChangePublication.findMany({ where: { routePlanId: f.route.id }, orderBy: { sequence: 'asc' } });
    const receiptsBefore = await prisma.routeLiveChangeCommandReceipt.findMany({ where: { routePlanId: f.route.id }, orderBy: { id: 'asc' } });
    const command = { ...adminIdentity(f), expectedRevision: 3, commandId: randomUUID() };
    await expect(discardDraft(prisma, { ...command, expectedAssignmentGeneration: '3' })).rejects.toMatchObject({ code: 'ASSIGNMENT_CHANGED' });
    await expect(discardDraft(prisma, { ...command, expectedRouteVersionId: randomUUID() })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await expect(discardDraft(prisma, { ...command, expectedRevision: 2 })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    const foreignShop = await prisma.shop.create({ data: { shopDomain: `discard-foreign-${randomUUID()}.example.invalid` } });
    await expect(discardDraft(prisma, { ...command, shopId: foreignShop.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const [discarded, retry] = await withRouteLock(prisma, f, () => Promise.all([
      discardDraft(prisma, command), discardDraft(prisma, command)
    ]), 2);
    expect(discarded).toEqual(retry);
    expect(discarded).toMatchObject({ revision: 4, hasUnpublishedChanges: false, publishedVersionId: first.publicationVersionId });
    expect((await discardDraft(prisma, { ...adminIdentity(f), expectedRevision: 4 })).revision).toBe(4);
    expect(await prisma.routeLiveChangeCommandReceipt.count({ where: { routePlanId: f.route.id, kind: 'DISCARD', commandId: command.commandId } })).toBe(1);
    expect((await prisma.deliveryStop.findUniqueOrThrow({ where: { id: f.stops[2]!.id } })).address1).toBe(f.stops[2]!.address1);
    await saveDraft(prisma, { ...adminIdentity(f), expectedRevision: 4,
      stopOverrides: [{ deliveryStopId: f.stops[6]!.id, address1: '700 Recovered Future Correction', latitude: 43.59, longitude: -80.59 }] });
    expect(await discardDraft(prisma, command)).toEqual(discarded);
    await expect(discardDraft(prisma, { ...command, expectedRevision: 5 })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const recovered = await dispatch(prisma, { ...adminIdentity(f), expectedRevision: 5 });
    expect(recovered.sequence).toBe(2);
    expect((await readAssigned(prisma, f)).stops.find(stop => stop.deliveryStopId === f.stops[6]!.id)?.address.address1).toBe('700 Recovered Future Correction');
    expect(await prisma.routeLiveChangePublication.findMany({ where: { id: { in: publicationsBefore.map(row => row.id) } }, orderBy: { sequence: 'asc' } })).toEqual(publicationsBefore);
    expect(await prisma.routeLiveChangeCommandReceipt.findMany({ where: { id: { in: receiptsBefore.map(row => row.id) } }, orderBy: { id: 'asc' } })).toEqual(receiptsBefore);
    expect((await prisma.driverEvent.findUniqueOrThrow({ where: { id: completed.eventId } })).eventType).toBe('STOP_DELIVERED');
    expect((await prisma.driverEvent.findUniqueOrThrow({ where: { id: f.arrival.id } })).occurredAt).toEqual(f.arrivedAt);
    expect((await prisma.deliveryStop.findUniqueOrThrow({ where: { id: f.stops[1]!.id } })).status).toBe('DELIVERED');
  });

  test('retains every publication boundary when an address is changed and later restored', async () => {
    const f = await fixture(prisma);
    const target = f.stops[6]!;
    await saveDraft(prisma, { ...adminIdentity(f), expectedRevision: 0, stopOverrides: [{ deliveryStopId: target.id, address1: '700 Temporary Address', latitude: 43.57, longitude: -80.57 }] });
    await dispatch(prisma, { ...adminIdentity(f), expectedRevision: 1 });
    await saveDraft(prisma, { ...adminIdentity(f), expectedRevision: 1, stopOverrides: [{ deliveryStopId: target.id, address1: target.address1,
      latitude: target.latitude!.toNumber(), longitude: target.longitude!.toNumber() }] });
    await dispatch(prisma, { ...adminIdentity(f), expectedRevision: 2 });
    await expect(new PrismaDriverEventRepository(prisma).recordDriverEvent(eventInput(f, target.id)))
      .rejects.toMatchObject({ code: 'ROUTE_VERSION_MISMATCH' });
    await expect(new PrismaDriverEventRepository(prisma).recordDriverEvent(eventInput(f, f.stops[1]!.id)))
      .resolves.toMatchObject({ duplicate: false });
    expect(await publicationCount(prisma, f)).toBe(2);
  });

  test('rejects latest-publication writes after an outside operational correction changes its snapshot', async () => {
    const f = await fixture(prisma);
    await saveDraft(prisma, { ...adminIdentity(f), expectedRevision: 0, stopOverrides: [{ deliveryStopId: f.stops[6]!.id, address1: '700 Published Address', latitude: 43.57, longitude: -80.57 }] });
    const published = await dispatch(prisma, { ...adminIdentity(f), expectedRevision: 1 });
    // A legacy correction can write operational data; it must not silently redefine this publication.
    await prisma.deliveryStop.update({ where: { id: f.stops[6]!.id }, data: { address1: '700 Outside Correction' } });
    await expect(new PrismaDriverEventRepository(prisma).recordDriverEvent({ ...eventInput(f, f.stops[6]!.id), expectedRouteVersionId: published.publicationVersionId }))
      .rejects.toMatchObject({ code: 'ROUTE_VERSION_MISMATCH' });
    expect(await prisma.driverEvent.count({ where: { deliveryStopId: f.stops[6]!.id, eventType: 'STOP_DELIVERED' } })).toBe(0);
  });

  test('preserves the published operational correction when Shopify re-syncs its unchanged source address', async () => {
    const f = await fixture(prisma);
    const original = await prisma.order.findUniqueOrThrow({ where: { id: f.stops[6]!.orderId } });
    const legacyId = (BigInt(`0x${randomUUID().replaceAll('-', '')}`) % 1_000_000_000_000_000n + 8_000_000_000_000_000n).toString();
    const synced = mapShopifyOrderNodeToDeliveryInputs({
      currentTotalPriceSet: { shopMoney: { amount: '10.00', currencyCode: 'CAD' } }, displayFinancialStatus: 'PAID',
      displayFulfillmentStatus: 'UNFULFILLED', email: null, id: original.shopifyOrderGid, legacyResourceId: legacyId,
      name: original.name, phone: null, processedAt: null, updatedAt: new Date().toISOString(),
      shippingAddress: { address1: f.stops[6]!.address1, address2: null, city: 'Synthetic City', countryCodeV2: 'CA',
        latitude: Number(f.stops[6]!.latitude), longitude: Number(f.stops[6]!.longitude), name: null,
        phone: null, province: null, zip: null }
    });
    const orders = new PrismaOrderSyncRepository(prisma, { allowAnyShopDomain: true });
    const syncInput = { appId: KFOOD_DELIVERY_APP_ID, shopDomain: KFOOD_DELIVERY_SHOP_DOMAIN, shopId: f.shop.id, synced };
    await orders.upsertOrderWithDeliveryStop(syncInput);
    const sourceBefore = await prisma.order.findUniqueOrThrow({ where: { id: original.id } });
    await saveDraft(prisma, { ...adminIdentity(f), expectedRevision: 0,
      stopOverrides: [{ deliveryStopId: f.stops[6]!.id, address1: '700 Persistent Operational Correction', latitude: 43.57, longitude: -80.57 }] });
    const [published] = await withRouteLock(prisma, f, () => Promise.all([
      dispatch(prisma, { ...adminIdentity(f), expectedRevision: 1 }), orders.upsertOrderWithDeliveryStop(syncInput)
    ]), 2);
    const before = await readAssigned(prisma, f);
    await orders.upsertOrderWithDeliveryStop(syncInput);
    expect(await readAssigned(prisma, f)).toEqual(before);
    expect(await readPublication(prisma, f)).toMatchObject({ publicationVersionId: published.publicationVersionId, pending: true });
    const operational = await prisma.deliveryStop.findUniqueOrThrow({ where: { id: f.stops[6]!.id } });
    expect(operational.address1).toBe('700 Persistent Operational Correction');
    expect(Number(operational.latitude)).toBe(43.57);
    expect(Number(operational.longitude)).toBe(-80.57);
    const sourceAfter = await prisma.order.findUniqueOrThrow({ where: { id: original.id } });
    expect(sourceAfter.shippingAddress).toEqual(sourceBefore.shippingAddress);
    expect(sourceAfter.rawPayload).toEqual(sourceBefore.rawPayload);
    expect(await publicationCount(prisma, f)).toBe(1);
  });

  test('uses publication sequence when a later publication has an earlier timestamp', async () => {
    const f = await fixture(prisma);
    await saveDraft(prisma, { ...adminIdentity(f), expectedRevision: 0,
      stopOverrides: [{ deliveryStopId: f.stops[6]!.id, address1: '700 Sequence One', latitude: 43.57, longitude: -80.57 }] });
    const first = await dispatch(prisma, { ...adminIdentity(f), expectedRevision: 1 });
    const source = await prisma.routeLiveChangePublication.findUniqueOrThrow({ where: { id: first.publicationVersionId } });
    // Insert a valid immutable fixture at an earlier time to prove clocks cannot select the route version.
    const second = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM route_plans WHERE id = ${f.route.id}::uuid FOR UPDATE`;
      const publication = await tx.routeLiveChangePublication.create({ data: {
        ...adminIdentity(f), driverId: f.driver.id, assignmentGeneration: 2n, sequence: 2,
        contentHash: source.contentHash, snapshot: source.snapshot as Prisma.InputJsonObject,
        publishedAt: new Date(source.publishedAt.getTime() - 60_000), notificationStatus: 'SKIPPED'
      } });
      await tx.routeLiveChangeState.update({ where: { routePlanId: f.route.id }, data: { latestPublicationId: publication.id, latestSequence: 2 } });
      return publication;
    });
    expect(second.publishedAt.getTime()).toBeLessThan(source.publishedAt.getTime());
    expect((await readAssigned(prisma, f)).routeVersionId).toBe(second.id);
    expect((await readPublication(prisma, f)).publicationVersionId).toBe(second.id);
    const events = new PrismaDriverEventRepository(prisma);
    for (const stop of f.stops.slice(1)) {
      await events.recordDriverEvent({ ...eventInput(f, stop.id), expectedRouteVersionId: second.id });
    }
    expect((await prisma.routePlan.findUniqueOrThrow({ where: { id: f.route.id } })).deliveryWorkCompletedAt).not.toBeNull();
  });

  test('finishes a published future reorder and retains the existing two-hour return-navigation grace', async () => {
    const f = await fixture(prisma);
    const futureOrder = f.stops.slice(2).map(stop => stop.id).reverse();
    await saveDraft(prisma, { ...adminIdentity(f), expectedRevision: 0, futureStopOrder: futureOrder,
      stopOverrides: [{ deliveryStopId: f.stops[6]!.id, address1: '700 Final Delivery Road', latitude: 43.57, longitude: -80.57 }] });
    const published = await dispatch(prisma, { ...adminIdentity(f), expectedRevision: 1 });
    let now = new Date();
    const events = new PrismaDriverEventRepository(prisma, { now: () => now });
    for (const deliveryStopId of [f.stops[1]!.id, ...futureOrder]) {
      await events.recordDriverEvent({ ...eventInput(f, deliveryStopId), expectedRouteVersionId: published.publicationVersionId });
    }
    const completed = await prisma.routePlan.findUniqueOrThrow({ where: { id: f.route.id } });
    expect(completed).toMatchObject({ status: 'IN_PROGRESS', deliveryWorkCompletedGeneration: 2n, deliveryWorkCompletedVersionId: f.version.id });
    expect(completed.deliveryWorkCompletedAt).not.toBeNull();
    expect(completed.driverNavigationUntil!.getTime() - completed.deliveryWorkCompletedAt!.getTime()).toBe(7_200_000);
    const tokens = new PrismaDriverTokenAccessRepository(prisma, () => now);
    const identity = { accountId: f.account.id, routePlanId: f.route.id, tokenVersion: f.account.tokenVersion };
    now = new Date(completed.driverNavigationUntil!.getTime() - 1);
    expect(await tokens.resolveDriverRouteAccess(identity)).not.toBeNull();
    const liveChanges = new PrismaLiveRouteChangeService(prisma, undefined, { now: () => now });
    const driverScope = { ...driverIdentity(f), accountId: f.account.id, tokenVersion: f.account.tokenVersion };
    expect(await liveChanges.getDriverPublication(driverScope)).toMatchObject({ publicationVersionId: published.publicationVersionId, pending: true });
    expect(await liveChanges.acknowledgeDriverPublication({ ...driverScope, publicationVersionId: published.publicationVersionId }))
      .toMatchObject({ publicationVersionId: published.publicationVersionId, pending: false });
    await expect(events.recordDriverEvent({ ...eventInput(f, f.stops[6]!.id), expectedRouteVersionId: published.publicationVersionId }))
      .rejects.toThrow('Delivery work is complete');
    const returnAck = await events.recordDriverEvent({ ...eventInput(f, f.stops[1]!.id), deliveryStopId: null,
      expectedRouteVersionId: published.publicationVersionId, eventType: 'ROUTE_COMPLETED' });
    expect(await prisma.driverEvent.findUniqueOrThrow({ where: { id: returnAck.eventId } })).toMatchObject({
      eventType: 'NOTE_ADDED', payload: { schema: 'kfood_return_navigation_completion_ack_v1' }
    });
    expect((await prisma.routePlan.findUniqueOrThrow({ where: { id: f.route.id } })).driverNavigationUntil).toEqual(completed.driverNavigationUntil);
    now = completed.driverNavigationUntil!;
    expect(await tokens.resolveDriverRouteAccess(identity)).toBeNull();
    await expect(liveChanges.getDriverPublication(driverScope)).rejects.toMatchObject({ code: 'ROUTE_NOT_IN_PROGRESS' });
    await expect(liveChanges.acknowledgeDriverPublication({ ...driverScope, publicationVersionId: published.publicationVersionId }))
      .rejects.toMatchObject({ code: 'ROUTE_NOT_IN_PROGRESS' });
    expect(await prisma.driverEvent.count({ where: { routePlanId: f.route.id, eventType: 'ROUTE_COMPLETED' } })).toBe(0);
  });

  test('keeps legacy non-versioned requests working for an unchanged current stop', async () => {
    const f = await fixture(prisma);
    await saveDraft(prisma, { ...adminIdentity(f), expectedRevision: 0,
      stopOverrides: [{ deliveryStopId: f.stops[6]!.id, address1: '700 Legacy Compatibility Road', latitude: 43.57, longitude: -80.57 }] });
    await dispatch(prisma, { ...adminIdentity(f), expectedRevision: 1 });
    const legacy = { routePlanId: f.route.id, shopId: f.shop.id, shopDomain: KFOOD_DELIVERY_SHOP_DOMAIN,
      driverId: f.driver.id, clientEventId: randomUUID(), deliveryStopId: f.stops[1]!.id,
      eventType: 'STOP_DELIVERED', occurredAt: new Date(), latitude: null, longitude: null, payload: { source: 'synthetic-legacy' } };
    const events = new PrismaDriverEventRepository(prisma);
    const first = await events.recordDriverEvent(legacy);
    await expect(events.recordDriverEvent(legacy)).resolves.toMatchObject({ duplicate: true, eventId: first.eventId });
    expect((await prisma.deliveryStop.findUniqueOrThrow({ where: { id: f.stops[1]!.id } })).status).toBe('DELIVERED');
  });

  test('rejects a stale revision after concurrent administrators edit the same draft', async () => {
    const f = await fixture(prisma);
    const changes = ['700 Revision A Road', '700 Revision B Road'].map(address1 => () => saveDraft(prisma, {
      ...adminIdentity(f), expectedRevision: 0, stopOverrides: [{ deliveryStopId: f.stops[6]!.id, address1, latitude: 43.57, longitude: -80.57 }]
    }));
    const result = await withRouteLock(prisma, f, () => Promise.allSettled(changes.map(change => change())), 2);
    expect(result.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    const rejected = result.find(item => item.status === 'rejected');
    expect(rejected?.status === 'rejected' ? rejected.reason : undefined).toMatchObject({ statusCode: 409 });
    expect((await getAdminLiveRouteChange(prisma, adminIdentity(f))).revision).toBe(1);
    await expect(dispatch(prisma, { ...adminIdentity(f), expectedRevision: 0 })).rejects.toMatchObject({ code: 'REVISION_CONFLICT', statusCode: 409 });
    expect(await publicationCount(prisma, f)).toBe(0);
  });

  test('replays an exact Save response after a newer draft and rejects command ID payload reuse', async () => {
    const f = await fixture(prisma);
    const input = { ...adminIdentity(f), commandId: randomUUID(), expectedRevision: 0,
      stopOverrides: [{ deliveryStopId: f.stops[6]!.id, address1: '700 Saved Command A', latitude: 43.57, longitude: -80.57 }] };
    const saved = await saveDraft(prisma, input);
    await saveDraft(prisma, { ...adminIdentity(f), expectedRevision: 1,
      stopOverrides: [{ deliveryStopId: f.stops[6]!.id, address1: '700 Saved Command B', latitude: 43.58, longitude: -80.58 }] });
    expect(await saveDraft(prisma, input)).toEqual(saved);
    const receipt = await prisma.routeLiveChangeCommandReceipt.findFirstOrThrow({ where: { routePlanId: f.route.id, commandId: input.commandId, kind: 'SAVE' } });
    await expect(prisma.routeLiveChangeCommandReceipt.update({ where: { id: receipt.id }, data: { response: {} } })).rejects.toThrow('immutable');
    expect((await getAdminLiveRouteChange(prisma, adminIdentity(f))).revision).toBe(2);
    await expect(saveDraft(prisma, { ...input, stopOverrides: [{ ...input.stopOverrides[0]!, address1: '700 Changed Payload' }] }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', statusCode: 409 });
  });

  test('keeps address-only drafts private until valid coordinates make Dispatch routeable', async () => {
    const f = await fixture(prisma);
    const saved = await saveDraft(prisma, { ...adminIdentity(f), expectedRevision: 0,
      stopOverrides: [{ deliveryStopId: f.stops[6]!.id, address1: '700 Ungeocoded Draft' }] });
    expect(saved.draft.stops.find(stop => stop.deliveryStopId === f.stops[6]!.id)).toMatchObject({ latitude: null, longitude: null });
    await expect(dispatch(prisma, { ...adminIdentity(f), expectedRevision: 1 }))
      .rejects.toMatchObject({ code: 'STOP_LOCATION_NOT_ROUTEABLE', statusCode: 409 });
    expect(await publicationCount(prisma, f)).toBe(0);
    expect((await prisma.deliveryStop.findUniqueOrThrow({ where: { id: f.stops[6]!.id } })).address1).toBe('7 Integration Road');
    await saveDraft(prisma, { ...adminIdentity(f), expectedRevision: 1,
      stopOverrides: [{ deliveryStopId: f.stops[6]!.id, latitude: 43.57, longitude: -80.57 }] });
    expect((await dispatch(prisma, { ...adminIdentity(f), expectedRevision: 2 })).sequence).toBe(1);
  });

  test('rejects old events for a stop whose future sequence changed without changing its address', async () => {
    const f = await fixture(prisma);
    await saveDraft(prisma, { ...adminIdentity(f), expectedRevision: 0, stopOverrides: [],
      futureStopOrder: f.stops.slice(2).map(stop => stop.id).reverse() });
    await dispatch(prisma, { ...adminIdentity(f), expectedRevision: 1 });
    await expect(new PrismaDriverEventRepository(prisma).recordDriverEvent(eventInput(f, f.stops[6]!.id)))
      .rejects.toMatchObject({ code: 'ROUTE_VERSION_MISMATCH' });
    await expect(new PrismaDriverEventRepository(prisma).recordDriverEvent(eventInput(f, f.stops[1]!.id)))
      .resolves.toMatchObject({ duplicate: false });
  });

  test('ACK N racing with publish N+1 cannot acknowledge N+1 or revert a newer ACK', async () => {
    const f = await fixture(prisma);
    await saveDraft(prisma, { ...adminIdentity(f), expectedRevision: 0, stopOverrides: [{ deliveryStopId: f.stops[6]!.id, address1: '700 Publication N Road', latitude: 43.57, longitude: -80.57 }] });
    const first = await dispatch(prisma, { ...adminIdentity(f), expectedRevision: 1 });
    await saveDraft(prisma, { ...adminIdentity(f), expectedRevision: 1, stopOverrides: [{ deliveryStopId: f.stops[6]!.id, address1: '700 Publication N+1 Road', latitude: 43.57, longitude: -80.57 }] });
    const [, second] = await withRouteLock(prisma, f, () => Promise.all([
      acknowledgeLiveRouteChange(prisma, { ...driverIdentity(f), publicationVersionId: first.publicationVersionId }),
      dispatch(prisma, { ...adminIdentity(f), expectedRevision: 2 })
    ]), 2);
    const latest = await readPublication(prisma, f);
    expect(latest).toMatchObject({ publicationVersionId: second.publicationVersionId, appliedVersionId: first.publicationVersionId, pending: true, sequence: 2 });
    await acknowledgeLiveRouteChange(prisma, { ...driverIdentity(f), publicationVersionId: second.publicationVersionId });
    await acknowledgeLiveRouteChange(prisma, { ...driverIdentity(f), publicationVersionId: first.publicationVersionId });
    expect(await readPublication(prisma, f)).toMatchObject({ publicationVersionId: second.publicationVersionId, appliedVersionId: second.publicationVersionId, pending: false });
  });

  test('denies foreign tenant, reassignment, cancellation, and revoked account writes', async () => {
    const f = await fixture(prisma);
    await saveDraft(prisma, { ...adminIdentity(f), expectedRevision: 0, stopOverrides: [{ deliveryStopId: f.stops[6]!.id, address1: '700 Scoped Integration Road', latitude: 43.57, longitude: -80.57 }] });
    const published = await dispatch(prisma, { ...adminIdentity(f), expectedRevision: 1 });
    const foreignShop = await prisma.shop.create({ data: { shopDomain: `foreign-${randomUUID()}.example.invalid` } });
    await expect(getLiveRouteChange(prisma, { ...driverIdentity(f), shopId: foreignShop.id })).rejects.toThrow();
    await expect(acknowledgeLiveRouteChange(prisma, { ...driverIdentity(f), shopId: foreignShop.id, publicationVersionId: published.publicationVersionId })).rejects.toThrow();
    await expect(saveDraft(prisma, { ...adminIdentity(f), shopId: foreignShop.id, expectedRevision: 1, stopOverrides: [] })).rejects.toThrow();
    const nextDriver = await prisma.driver.create({ data: { displayName: 'New Integration Driver', shopId: f.shop.id, authSubject: `next-${randomUUID()}` } });
    await prisma.routePlan.update({ where: { id: f.route.id }, data: { driverId: nextDriver.id, assignmentGeneration: { increment: 1 } } });
    await expect(acknowledgeLiveRouteChange(prisma, { ...driverIdentity(f), publicationVersionId: published.publicationVersionId })).rejects.toThrow();
    await expect(new PrismaDriverEventRepository(prisma).recordDriverEvent(eventInput(f, f.stops[1]!.id))).rejects.toThrow();
    await prisma.routePlan.update({ where: { id: f.route.id }, data: { driverId: f.driver.id, assignmentGeneration: 2n, status: 'CANCELLED' } });
    await expect(acknowledgeLiveRouteChange(prisma, { ...driverIdentity(f), publicationVersionId: published.publicationVersionId })).rejects.toThrow();
    await expect(new PrismaDriverEventRepository(prisma).recordDriverEvent(eventInput(f, f.stops[1]!.id))).rejects.toThrow();
    await prisma.routePlan.update({ where: { id: f.route.id }, data: { status: 'IN_PROGRESS' } });
    await prisma.driverAccount.update({ where: { id: f.account.id }, data: { status: 'SUSPENDED' } });
    const service = new PrismaLiveRouteChangeService(prisma);
    await expect(service.acknowledgeDriverPublication({ ...driverIdentity(f), accountId: f.account.id, publicationVersionId: published.publicationVersionId })).rejects.toThrow();
  });

  test.each(['draft-only', 'published'] as const)('accepts the new assignment before an admin Save after %s live-change use', async mode => {
    const f = await fixture(prisma);
    await saveDraft(prisma, { ...adminIdentity(f), expectedRevision: 0,
      stopOverrides: [{ deliveryStopId: f.stops[6]!.id, address1: '700 Previous Assignment Correction', latitude: 43.57, longitude: -80.57 }] });
    const previousPublication = mode === 'published' ? await dispatch(prisma, { ...adminIdentity(f), expectedRevision: 1 }) : null;
    const previousState = await prisma.routeLiveChangeState.findUniqueOrThrow({ where: { routePlanId: f.route.id } });
    const account = await prisma.driverAccount.create({ data: { phone: `new-active-assignment-${randomUUID()}` } });
    const driver = await prisma.driver.create({ data: { accountId: account.id, authSubject: `new-active-assignment-${randomUUID()}`,
      displayName: 'Reassigned Synthetic Driver', shopId: f.shop.id } });
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM route_plans WHERE id = ${f.route.id}::uuid FOR UPDATE`;
      await tx.routePlan.update({ where: { id: f.route.id }, data: { driverId: driver.id, assignmentGeneration: 3n } });
      await tx.routeGroupingChildVersion.update({ where: { id: f.version.id }, data: { driverId: driver.id } });
    });
    const access = await new PrismaDriverRouteAccessRepository(prisma).lookupRouteAccess({ accountId: account.id, routeContext: f.route.id });
    expect(access.status).toBe('INVITED');
    if (access.status !== 'INVITED') throw new Error('Synthetic reassigned route access was not issued');
    expect(access.routeAccess).toMatchObject({ expectedRouteVersionId: f.version.id, assignmentGeneration: '3' });
    const assigned = await new PrismaDriverAssignedRouteRepository(prisma).getAssignedRoute({ ...adminIdentity(f), driverId: driver.id,
      routeContext: f.route.id, shopDomain: KFOOD_DELIVERY_SHOP_DOMAIN });
    expect(assigned.status).toBe('ASSIGNED_ROUTE');
    if (assigned.status !== 'ASSIGNED_ROUTE') throw new Error('Synthetic reassigned route was not issued');
    expect(assigned.route.routeVersionId).toBe(access.routeAccess.expectedRouteVersionId);
    const events = new PrismaDriverEventRepository(prisma);
    const currentIdentity = { ...eventInput(f, f.stops[1]!.id), driverId: driver.id,
      assignmentGeneration: access.routeAccess.assignmentGeneration, expectedRouteVersionId: access.routeAccess.expectedRouteVersionId };
    for (const eventType of ['ROUTE_STARTED', 'PICKUP_COMPLETED']) {
      await expect(events.recordDriverEvent({ ...currentIdentity, clientEventId: randomUUID(), deliveryStopId: null, eventType }))
        .resolves.toMatchObject({ duplicate: false });
    }
    await expect(events.recordDriverEvent({ ...currentIdentity, clientEventId: randomUUID() })).resolves.toMatchObject({ duplicate: false });
    expect(await prisma.routeLiveChangeState.findUniqueOrThrow({ where: { routePlanId: f.route.id } })).toEqual(previousState);
    await expect(events.recordDriverEvent(eventInput(f, f.stops[2]!.id))).rejects.toMatchObject({ code: 'ROUTE_ASSIGNMENT_CHANGED' });
    await expect(events.recordDriverEvent({ ...currentIdentity, clientEventId: randomUUID(), deliveryStopId: f.stops[2]!.id, assignmentGeneration: '2' }))
      .rejects.toMatchObject({ code: 'ROUTE_ASSIGNMENT_CHANGED' });
    await expect(events.recordDriverEvent({ ...currentIdentity, clientEventId: randomUUID(), deliveryStopId: f.stops[2]!.id, expectedRouteVersionId: randomUUID() }))
      .rejects.toMatchObject({ code: 'ROUTE_VERSION_MISMATCH' });
    if (previousPublication !== null) {
      await expect(events.recordDriverEvent({ ...currentIdentity, clientEventId: randomUUID(), deliveryStopId: f.stops[2]!.id,
        expectedRouteVersionId: previousPublication.publicationVersionId })).rejects.toMatchObject({ code: 'ROUTE_VERSION_MISMATCH' });
    }
    for (const stop of f.stops.slice(2)) {
      await events.recordDriverEvent({ ...currentIdentity, clientEventId: randomUUID(), deliveryStopId: stop.id });
    }
    const complete = await prisma.routePlan.findUniqueOrThrow({ where: { id: f.route.id } });
    expect(complete.deliveryWorkCompletedGeneration).toBe(3n);
    expect(complete.deliveryWorkCompletedAt).not.toBeNull();
    expect(complete.driverNavigationUntil!.getTime() - complete.deliveryWorkCompletedAt!.getTime()).toBe(7_200_000);
    const duringGrace = new Date(complete.driverNavigationUntil!.getTime() - 1);
    expect(await new PrismaDriverTokenAccessRepository(prisma, () => duringGrace).resolveDriverRouteAccess({
      accountId: account.id, routePlanId: f.route.id, tokenVersion: account.tokenVersion
    })).not.toBeNull();
    expect((await new PrismaDriverRouteAccessRepository(prisma, undefined, () => duringGrace)
      .lookupRouteAccess({ accountId: account.id, routeContext: f.route.id })).status).toBe('INVITED');
    expect(await new PrismaDriverTokenAccessRepository(prisma, () => complete.driverNavigationUntil!).resolveDriverRouteAccess({
      accountId: account.id, routePlanId: f.route.id, tokenVersion: account.tokenVersion
    })).toBeNull();
  });

  test('rejects a driver swap that keeps the generation and stale live-state owner', async () => {
    const f = await fixture(prisma);
    await saveDraft(prisma, { ...adminIdentity(f), expectedRevision: 0,
      stopOverrides: [{ deliveryStopId: f.stops[6]!.id, address1: '700 Same Generation Owner Swap', latitude: 43.57, longitude: -80.57 }] });
    const published = await dispatch(prisma, { ...adminIdentity(f), expectedRevision: 1 });
    const state = await prisma.routeLiveChangeState.findUniqueOrThrow({ where: { routePlanId: f.route.id } });
    const eventRows = await prisma.driverEvent.count({ where: { routePlanId: f.route.id } });
    const account = await prisma.driverAccount.create({ data: { phone: `same-generation-swap-${randomUUID()}` } });
    const driver = await prisma.driver.create({ data: { accountId: account.id, authSubject: `same-generation-swap-${randomUUID()}`,
      displayName: 'Invalid Same Generation Synthetic Driver', shopId: f.shop.id } });
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM route_plans WHERE id = ${f.route.id}::uuid FOR UPDATE`;
      await tx.routePlan.update({ where: { id: f.route.id }, data: { driverId: driver.id } });
      await tx.routeGroupingChildVersion.update({ where: { id: f.version.id }, data: { driverId: driver.id } });
    });
    expect((await prisma.routePlan.findUniqueOrThrow({ where: { id: f.route.id } })).assignmentGeneration).toBe(2n);
    expect((await new PrismaDriverRouteAccessRepository(prisma).lookupRouteAccess({ accountId: account.id, routeContext: f.route.id })).status).toBe('NOT_FOUND');
    await expect(new PrismaDriverAssignedRouteRepository(prisma).getAssignedRoute({ ...adminIdentity(f), driverId: driver.id,
      routeContext: f.route.id, shopDomain: KFOOD_DELIVERY_SHOP_DOMAIN })).rejects.toThrow();
    const identity = { ...adminIdentity(f), driverId: driver.id, accountId: account.id, tokenVersion: account.tokenVersion, assignmentGeneration: '2' };
    const service = new PrismaLiveRouteChangeService(prisma);
    await expect(service.getDriverPublication(identity)).rejects.toMatchObject({ code: 'ASSIGNMENT_CHANGED' });
    await expect(service.acknowledgeDriverPublication({ ...identity, publicationVersionId: published.publicationVersionId }))
      .rejects.toMatchObject({ code: 'ASSIGNMENT_CHANGED' });
    const events = new PrismaDriverEventRepository(prisma);
    await expect(events.recordDriverEvent({ ...eventInput(f, f.stops[1]!.id), driverId: driver.id }))
      .rejects.toMatchObject({ code: 'ROUTE_ASSIGNMENT_CHANGED' });
    await expect(events.recordDriverEvent({ ...eventInput(f, f.stops[1]!.id), driverId: driver.id, eventType: 'ROUTE_STARTED', deliveryStopId: null }))
      .rejects.toMatchObject({ code: 'ROUTE_ASSIGNMENT_CHANGED' });
    await expect(getAdminLiveRouteChange(prisma, adminIdentity(f))).rejects.toMatchObject({ code: 'ASSIGNMENT_CHANGED' });
    await expect(saveDraft(prisma, { ...adminIdentity(f), expectedRevision: 1,
      stopOverrides: [{ deliveryStopId: f.stops[6]!.id, address1: '700 Invalid Owner Enrollment', latitude: 43.58, longitude: -80.58 }] }))
      .rejects.toMatchObject({ code: 'ASSIGNMENT_CHANGED' });
    expect(await prisma.routeLiveChangeState.findUniqueOrThrow({ where: { routePlanId: f.route.id } })).toEqual(state);
    expect(await prisma.driverEvent.count({ where: { routePlanId: f.route.id } })).toBe(eventRows);
    expect(await prisma.driverEvent.count({ where: { routePlanId: f.route.id, driverId: driver.id } })).toBe(0);
  });

  test('starts a fresh draft and ACK cursor for a new assignment generation', async () => {
    const f = await fixture(prisma);
    const oldSave = { ...adminIdentity(f), commandId: randomUUID(), expectedRevision: 0,
      stopOverrides: [{ deliveryStopId: f.stops[6]!.id, address1: '700 Old Assignment', latitude: 43.57, longitude: -80.57 }] };
    await saveDraft(prisma, oldSave);
    const oldPublication = await dispatch(prisma, { ...adminIdentity(f), expectedRevision: 1 });
    await acknowledgeLiveRouteChange(prisma, { ...driverIdentity(f), publicationVersionId: oldPublication.publicationVersionId });
    const account = await prisma.driverAccount.create({ data: { phone: `next-live-change-${randomUUID()}` } });
    const driver = await prisma.driver.create({ data: { accountId: account.id, displayName: 'Next Synthetic Driver', shopId: f.shop.id, authSubject: `next-live-change-${randomUUID()}` } });
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM route_plans WHERE id = ${f.route.id}::uuid FOR UPDATE`;
      await tx.routePlan.update({ where: { id: f.route.id }, data: { driverId: driver.id, assignmentGeneration: 3n } });
      await tx.routeGroupingChildVersion.update({ where: { id: f.version.id }, data: { driverId: driver.id } });
    });
    expect((await getAdminLiveRouteChange(prisma, adminIdentity(f))).revision).toBe(0);
    await expect(saveDraft(prisma, oldSave)).rejects.toMatchObject({ code: 'ASSIGNMENT_CHANGED' });
    await saveDraft(prisma, { ...adminIdentity(f), expectedRevision: 0, expectedAssignmentGeneration: '3',
      stopOverrides: [{ deliveryStopId: f.stops[6]!.id, address1: '700 New Assignment', latitude: 43.58, longitude: -80.58 }] });
    const identity = { ...adminIdentity(f), driverId: driver.id, assignmentGeneration: '3' };
    expect(await getLiveRouteChange(prisma, identity)).toMatchObject({ assignmentGeneration: '3', sequence: 0, pending: false });
    const nextPublication = await dispatch(prisma, { ...adminIdentity(f), expectedRevision: 1, expectedAssignmentGeneration: '3' });
    expect(await getLiveRouteChange(prisma, identity)).toMatchObject({ publicationVersionId: nextPublication.publicationVersionId, assignmentGeneration: '3', sequence: 1, pending: true });
    await expect(acknowledgeLiveRouteChange(prisma, { ...driverIdentity(f), publicationVersionId: oldPublication.publicationVersionId })).rejects.toMatchObject({ code: 'ASSIGNMENT_CHANGED' });
    await expect(acknowledgeLiveRouteChange(prisma, { ...identity, publicationVersionId: oldPublication.publicationVersionId })).rejects.toMatchObject({ code: 'PUBLICATION_NOT_FOUND' });
  });

  test('rejects a first Save from stale Admin GET identity after reassignment or membership replacement', async () => {
    const f = await fixture(prisma);
    const captured = await getAdminLiveRouteChange(prisma, adminIdentity(f));
    const driver = await prisma.driver.create({ data: { accountId: f.account.id, displayName: 'Reassigned Synthetic Driver', shopId: f.shop.id, authSubject: `reassigned-${randomUUID()}` } });
    await prisma.$transaction(async tx => {
      await tx.routePlan.update({ where: { id: f.route.id }, data: { driverId: driver.id, assignmentGeneration: 3n } });
      await tx.routeGroupingChildVersion.update({ where: { id: f.version.id }, data: { driverId: driver.id } });
    });
    await expect(saveDraft(prisma, { ...adminIdentity(f), expectedRevision: 0,
      expectedAssignmentGeneration: captured.assignmentGeneration, expectedRouteVersionId: captured.expectedRouteVersionId,
      stopOverrides: [{ deliveryStopId: f.stops[6]!.id, address1: '700 Stale First Save', latitude: 43.57, longitude: -80.57 }] }))
      .rejects.toMatchObject({ code: 'ASSIGNMENT_CHANGED', statusCode: 409 });
    expect(await prisma.routeLiveChangeState.findUnique({ where: { routePlanId: f.route.id } })).toBeNull();

    const g = await fixture(prisma);
    const snapshot = (await prisma.routeGroupingChildVersion.findUniqueOrThrow({ where: { id: g.version.id } })).snapshot;
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM route_plans WHERE id = ${g.route.id}::uuid FOR UPDATE`;
      await tx.routeGroupingChildVersion.update({ where: { id: g.version.id }, data: { status: 'ARCHIVED', supersededAt: new Date() } });
      const next = await tx.routeGroupingChildVersion.create({ data: { shopId: g.shop.id, groupingId: g.group.id,
        groupingVersionId: g.parent.id, routePlanId: g.route.id, driverId: g.driver.id, version: 2, snapshot: snapshot as Prisma.InputJsonObject, publishedAt: new Date() } });
      await tx.order.updateMany({ where: { id: { in: g.stops.map(stop => stop.orderId) } }, data: { currentRouteVersionId: next.id } });
    });
    await expect(saveDraft(prisma, { ...adminIdentity(g), expectedRevision: 0,
      stopOverrides: [{ deliveryStopId: g.stops[6]!.id, address1: '700 Stale Membership Save', latitude: 43.57, longitude: -80.57 }] }))
      .rejects.toMatchObject({ code: 'VERSION_CONFLICT', statusCode: 409 });
    expect(await prisma.routeLiveChangeState.findUnique({ where: { routePlanId: g.route.id } })).toBeNull();
  });

  test('continues delivery through the real same-assignment grouping reorder after live Dispatch', async () => {
    const f = await fixture(prisma);
    await prepareGroupingFixture(prisma, f);
    const originalSaveCommand = { ...adminIdentity(f), commandId: randomUUID(), expectedRevision: 0,
      stopOverrides: [{ deliveryStopId: f.stops[6]!.id, address1: '700 Grouping Reorder Correction', latitude: 43.57, longitude: -80.57 }] };
    const originalSave = await saveDraft(prisma, originalSaveCommand);
    const originalDispatchCommand = { ...adminIdentity(f), commandId: randomUUID(), expectedRevision: 1 };
    const published = await dispatch(prisma, originalDispatchCommand);
    const send = vi.fn<DriverPushProvider['sendRouteNotification']>().mockResolvedValue({ status: 'SKIPPED' });
    const grouping = new PrismaRouteGroupingService(prisma, { providerName: 'synthetic-grouping-only', sendRouteNotification: send },
      undefined, undefined, { buildRoute: detail => Promise.resolve(syntheticGeometry(detail)) });
    const orderIds = [f.stops[0]!.orderId, f.stops[1]!.orderId, ...f.stops.slice(2).reverse().map(stop => stop.orderId)];
    const saved = await grouping.saveDraft({ appId: KFOOD_DELIVERY_APP_ID, shopDomain: KFOOD_DELIVERY_SHOP_DOMAIN,
      groupingId: f.group.id, mode: 'MANUAL_ORDER', routes: [{ branchId: null, routeKey: `existing:${f.route.id}`,
        routePlanId: f.route.id, driverId: f.driver.id, label: f.route.name, orderIds }] });
    expect(saved).not.toBeNull();
    const child = await prisma.routeGroupingChildVersion.findFirstOrThrow({ where: { routePlanId: f.route.id, status: 'CURRENT', supersededAt: null } });
    expect(child.id).not.toBe(f.version.id);
    expect((await prisma.routePlan.findUniqueOrThrow({ where: { id: f.route.id } })).assignmentGeneration).toBe(2n);
    expect((await prisma.routeGroupingChildVersion.findUniqueOrThrow({ where: { id: f.version.id } })).status).toBe('ARCHIVED');
    const assigned = await readAssigned(prisma, f);
    const access = await new PrismaDriverRouteAccessRepository(prisma).lookupRouteAccess({ accountId: f.account.id, routeContext: f.route.id });
    expect(access.status).toBe('INVITED');
    if (access.status !== 'INVITED') throw new Error('Synthetic reordered route access was not issued');
    expect(assigned.routeVersionId).toBe(access.routeAccess.expectedRouteVersionId);
    expect(assigned.routeVersionId).toBe(child.id);
    expect(await readPublication(prisma, f)).toMatchObject({ publicationVersionId: child.id, sequence: 2, pending: true });
    const publicationRows = await publicationCount(prisma, f);
    const receiptRows = await prisma.routeLiveChangeCommandReceipt.count({ where: { routePlanId: f.route.id } });
    expect(await saveDraft(prisma, originalSaveCommand)).toEqual(originalSave);
    expect(await dispatch(prisma, originalDispatchCommand)).toEqual(published);
    expect(await publicationCount(prisma, f)).toBe(publicationRows);
    expect(await prisma.routeLiveChangeCommandReceipt.count({ where: { routePlanId: f.route.id } })).toBe(receiptRows);
    expect(assigned.stops.map(stop => stop.deliveryStopId)).toEqual([f.stops[0]!.id, f.stops[1]!.id, ...f.stops.slice(2).reverse().map(stop => stop.id)]);
    expect(assigned.stops.find(stop => stop.deliveryStopId === f.stops[6]!.id)?.address.address1).toBe('700 Grouping Reorder Correction');
    const events = new PrismaDriverEventRepository(prisma);
    const delayed = { ...eventInput(f, f.stops[1]!.id), expectedRouteVersionId: published.publicationVersionId };
    await expect(events.recordDriverEvent(delayed)).resolves.toMatchObject({ duplicate: false });
    await expect(events.recordDriverEvent(eventInput(f, f.stops[1]!.id))).resolves.toHaveProperty('eventId');
    const currentIdentity = { ...eventInput(f, f.stops[6]!.id), expectedRouteVersionId: access.routeAccess.expectedRouteVersionId };
    await expect(events.recordDriverEvent({ ...currentIdentity, eventType: 'STOP_ARRIVED' })).resolves.toMatchObject({ duplicate: false });
    await expect(events.recordDriverEvent({ ...eventInput(f, f.stops[6]!.id), expectedRouteVersionId: published.publicationVersionId }))
      .rejects.toMatchObject({ code: 'ROUTE_VERSION_MISMATCH' });
    await expect(events.recordDriverEvent(eventInput(f, f.stops[6]!.id))).rejects.toMatchObject({ code: 'ROUTE_VERSION_MISMATCH' });
    await expect(events.recordDriverEvent({ ...currentIdentity, clientEventId: randomUUID() })).resolves.toMatchObject({ duplicate: false });
    expect((await prisma.driverEvent.findUniqueOrThrow({ where: { id: f.arrival.id } })).occurredAt).toEqual(f.arrivedAt);
    expect(send).not.toHaveBeenCalled();
  });

  test.each(['current-assignment', 'previous-assignment-state'] as const)('blocks a real grouping reorder during completed-work grace with %s', async mode => {
    const f = await fixture(prisma);
    await prepareGroupingFixture(prisma, f);
    await saveDraft(prisma, { ...adminIdentity(f), expectedRevision: 0,
      stopOverrides: [{ deliveryStopId: f.stops[6]!.id, address1: '700 Completed Navigation Grace', latitude: 43.57, longitude: -80.57 }] });
    const published = await dispatch(prisma, { ...adminIdentity(f), expectedRevision: 1 });
    const events = new PrismaDriverEventRepository(prisma);
    let driver = f.driver;
    let account = f.account;
    let generation = '2';
    let expectedRouteVersionId = published.publicationVersionId;
    if (mode === 'previous-assignment-state') {
      account = await prisma.driverAccount.create({ data: { phone: `completed-grace-reassignment-${randomUUID()}` } });
      driver = await prisma.driver.create({ data: { accountId: account.id, authSubject: `completed-grace-reassignment-${randomUUID()}`,
        displayName: 'Completed Grace Reassigned Driver', shopId: f.shop.id } });
      const original = await prisma.routeGroupingChildVersion.findUniqueOrThrow({ where: { id: f.version.id } });
      await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM route_plans WHERE id = ${f.route.id}::uuid FOR UPDATE`;
        await tx.routePlan.update({ where: { id: f.route.id }, data: { driverId: driver.id, assignmentGeneration: 3n } });
        await tx.routeGroupingChildVersion.update({ where: { id: f.version.id }, data: { driverId: driver.id,
          snapshot: { ...(original.snapshot as Prisma.InputJsonObject), driverId: driver.id } } });
      });
      generation = '3';
      expectedRouteVersionId = f.version.id;
      for (const eventType of ['ROUTE_STARTED', 'PICKUP_COMPLETED']) {
        await events.recordDriverEvent({ ...eventInput(f, f.stops[1]!.id), driverId: driver.id, assignmentGeneration: generation,
          expectedRouteVersionId, deliveryStopId: null, eventType });
      }
    }
    for (const stop of f.stops.slice(1)) {
      await events.recordDriverEvent({ ...eventInput(f, stop.id), driverId: driver.id, assignmentGeneration: generation, expectedRouteVersionId });
    }
    const completed = await prisma.routePlan.findUniqueOrThrow({ where: { id: f.route.id } });
    expect(completed.deliveryWorkCompletedAt).not.toBeNull();
    expect(completed.deliveryWorkCompletedGeneration).toBe(BigInt(generation));
    expect(completed.driverNavigationUntil!.getTime() - completed.deliveryWorkCompletedAt!.getTime()).toBe(7_200_000);
    const state = await prisma.routeLiveChangeState.findUniqueOrThrow({ where: { routePlanId: f.route.id } });
    expect(state.assignmentGeneration).toBe(2n);
    const children = await prisma.routeGroupingChildVersion.findMany({ where: { routePlanId: f.route.id }, orderBy: { id: 'asc' } });
    const history = await prisma.driverEvent.findMany({ where: { routePlanId: f.route.id }, orderBy: { id: 'asc' } });
    const routeStops = await prisma.routePlanStop.findMany({ where: { routePlanId: f.route.id }, orderBy: { sequence: 'asc' } });
    const grouping = new PrismaRouteGroupingService(prisma, { providerName: 'synthetic-grouping-only',
      sendRouteNotification: () => Promise.resolve({ status: 'SKIPPED' }) }, undefined, undefined,
    { buildRoute: detail => Promise.resolve(syntheticGeometry(detail)) });
    await expect(grouping.saveDraft({ appId: KFOOD_DELIVERY_APP_ID, shopDomain: KFOOD_DELIVERY_SHOP_DOMAIN,
      groupingId: f.group.id, mode: 'MANUAL_ORDER', routes: [{ branchId: null, routeKey: `existing:${f.route.id}`,
        routePlanId: f.route.id, driverId: driver.id, label: f.route.name,
        orderIds: [f.stops[0]!.orderId, f.stops[1]!.orderId, ...f.stops.slice(2).reverse().map(stop => stop.orderId)] }] }))
      .rejects.toMatchObject({ code: 'ROUTE_NOT_IN_PROGRESS' });
    expect(await prisma.routePlan.findUniqueOrThrow({ where: { id: f.route.id } })).toEqual(completed);
    expect(await prisma.routeLiveChangeState.findUniqueOrThrow({ where: { routePlanId: f.route.id } })).toEqual(state);
    expect(await prisma.routeGroupingChildVersion.findMany({ where: { routePlanId: f.route.id }, orderBy: { id: 'asc' } })).toEqual(children);
    expect(await prisma.driverEvent.findMany({ where: { routePlanId: f.route.id }, orderBy: { id: 'asc' } })).toEqual(history);
    expect(await prisma.routePlanStop.findMany({ where: { routePlanId: f.route.id }, orderBy: { sequence: 'asc' } })).toEqual(routeStops);
    const identity = { accountId: account.id, routePlanId: f.route.id, tokenVersion: account.tokenVersion };
    const duringGrace = new Date(completed.driverNavigationUntil!.getTime() - 1);
    expect(await new PrismaDriverTokenAccessRepository(prisma, () => duringGrace).resolveDriverRouteAccess(identity)).not.toBeNull();
    expect((await new PrismaDriverRouteAccessRepository(prisma, undefined, () => duringGrace)
      .lookupRouteAccess({ accountId: account.id, routeContext: f.route.id })).status).toBe('INVITED');
    expect(await new PrismaDriverTokenAccessRepository(prisma, () => completed.driverNavigationUntil!).resolveDriverRouteAccess(identity)).toBeNull();
    expect((await new PrismaDriverRouteAccessRepository(prisma, undefined, () => completed.driverNavigationUntil!)
      .lookupRouteAccess({ accountId: account.id, routeContext: f.route.id })).status).toBe('NOT_FOUND');
  });

  test('requires explicit private-draft discard before the existing grouping service replaces its child', async () => {
    const f = await fixture(prisma);
    await prepareGroupingFixture(prisma, f);
    await saveDraft(prisma, { ...adminIdentity(f), expectedRevision: 0,
      stopOverrides: [{ deliveryStopId: f.stops[6]!.id, address1: '700 Pending Private Child Correction', latitude: 43.57, longitude: -80.57 }] });
    const grouping = new PrismaRouteGroupingService(prisma, { providerName: 'synthetic-grouping-only',
      sendRouteNotification: () => Promise.resolve({ status: 'SKIPPED' }) }, undefined, undefined,
    { buildRoute: detail => Promise.resolve(syntheticGeometry(detail)) });
    const input = { appId: KFOOD_DELIVERY_APP_ID, shopDomain: KFOOD_DELIVERY_SHOP_DOMAIN,
      groupingId: f.group.id, mode: 'MANUAL_ORDER' as const, routes: [{ branchId: null, routeKey: `existing:${f.route.id}`,
        routePlanId: f.route.id, driverId: f.driver.id, label: f.route.name,
        orderIds: [f.stops[0]!.orderId, f.stops[1]!.orderId, ...f.stops.slice(2).reverse().map(stop => stop.orderId)] }] };
    await expect(grouping.saveDraft(input)).rejects.toMatchObject({ code: 'DRAFT_CONFLICT' });
    expect(await prisma.routeGroupingChildVersion.count({ where: { routePlanId: f.route.id, status: 'CURRENT', supersededAt: null } })).toBe(1);
    expect((await prisma.routeGroupingChildVersion.findUniqueOrThrow({ where: { id: f.version.id } })).status).toBe('CURRENT');
    expect((await getAdminLiveRouteChange(prisma, adminIdentity(f))).hasUnpublishedChanges).toBe(true);
    await discardDraft(prisma, { ...adminIdentity(f), expectedRevision: 1 });
    expect(await grouping.saveDraft(input)).not.toBeNull();
    const access = await new PrismaDriverRouteAccessRepository(prisma).lookupRouteAccess({ accountId: f.account.id, routeContext: f.route.id });
    expect(access.status).toBe('INVITED');
    if (access.status !== 'INVITED') throw new Error('Synthetic recovered child access was not issued');
    await expect(new PrismaDriverEventRepository(prisma).recordDriverEvent({ ...eventInput(f, f.stops[1]!.id),
      expectedRouteVersionId: access.routeAccess.expectedRouteVersionId })).resolves.toMatchObject({ duplicate: false });
  });

  test('enforces the database defense against duplicate current children and preserves the valid identity', async () => {
    const f = await fixture(prisma);
    await saveDraft(prisma, { ...adminIdentity(f), expectedRevision: 0,
      stopOverrides: [{ deliveryStopId: f.stops[6]!.id, address1: '700 Ambiguous Child Correction', latitude: 43.57, longitude: -80.57 }] });
    const published = await dispatch(prisma, { ...adminIdentity(f), expectedRevision: 1 });
    const snapshot = (await prisma.routeGroupingChildVersion.findUniqueOrThrow({ where: { id: f.version.id } })).snapshot;
    await expect(prisma.routeGroupingChildVersion.create({ data: { shopId: f.shop.id, groupingId: f.group.id, groupingVersionId: f.parent.id,
      routePlanId: f.route.id, driverId: f.driver.id, version: 2, snapshot: snapshot as Prisma.InputJsonObject, publishedAt: new Date() } }))
      .rejects.toMatchObject({ code: 'P2002' });
    expect(await prisma.routeGroupingChildVersion.count({ where: { routePlanId: f.route.id, status: 'CURRENT', supersededAt: null } })).toBe(1);
    expect((await getAdminLiveRouteChange(prisma, adminIdentity(f))).publishedVersionId).toBe(published.publicationVersionId);
    expect((await readAssigned(prisma, f)).routeVersionId).toBe(published.publicationVersionId);
    const access = await new PrismaDriverRouteAccessRepository(prisma).lookupRouteAccess({ accountId: f.account.id, routeContext: f.route.id });
    expect(access.status).toBe('INVITED');
    if (access.status !== 'INVITED') throw new Error('Synthetic valid child access was not retained');
    expect(access.routeAccess.expectedRouteVersionId).toBe(published.publicationVersionId);
    await expect(new PrismaDriverEventRepository(prisma).recordDriverEvent({ ...eventInput(f, f.stops[1]!.id),
      expectedRouteVersionId: access.routeAccess.expectedRouteVersionId })).resolves.toMatchObject({ duplicate: false });
  });

  test('rejects same-assignment child drift that did not use the coordinated service transition', async () => {
    const f = await fixture(prisma);
    await saveDraft(prisma, { ...adminIdentity(f), expectedRevision: 0,
      stopOverrides: [{ deliveryStopId: f.stops[6]!.id, address1: '700 Uncoordinated Child Drift', latitude: 43.57, longitude: -80.57 }] });
    await dispatch(prisma, { ...adminIdentity(f), expectedRevision: 1 });
    const snapshot = (await prisma.routeGroupingChildVersion.findUniqueOrThrow({ where: { id: f.version.id } })).snapshot;
    const child = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM route_plans WHERE id = ${f.route.id}::uuid FOR UPDATE`;
      await tx.routeGroupingChildVersion.update({ where: { id: f.version.id }, data: { status: 'ARCHIVED', supersededAt: new Date() } });
      const next = await tx.routeGroupingChildVersion.create({ data: { shopId: f.shop.id, groupingId: f.group.id, groupingVersionId: f.parent.id,
        routePlanId: f.route.id, driverId: f.driver.id, version: 2, snapshot: snapshot as Prisma.InputJsonObject, publishedAt: new Date() } });
      await tx.order.updateMany({ where: { id: { in: f.stops.map(stop => stop.orderId) } }, data: { currentRouteVersionId: next.id } });
      return next;
    });
    expect((await prisma.routePlan.findUniqueOrThrow({ where: { id: f.route.id } })).assignmentGeneration).toBe(2n);
    await expect(getAdminLiveRouteChange(prisma, adminIdentity(f))).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await expect(readAssigned(prisma, f)).rejects.toThrow();
    expect((await new PrismaDriverRouteAccessRepository(prisma).lookupRouteAccess({ accountId: f.account.id, routeContext: f.route.id })).status).toBe('NOT_FOUND');
    await expect(new PrismaDriverEventRepository(prisma).recordDriverEvent({ ...eventInput(f, f.stops[1]!.id), expectedRouteVersionId: child.id }))
      .rejects.toMatchObject({ code: 'ROUTE_VERSION_MISMATCH' });
  });

  test('coordinates the real driver reorder with explicit draft discard, immutable publication lineage, and issued events', async () => {
    const f = await fixture(prisma);
    await saveDraft(prisma, { ...adminIdentity(f), expectedRevision: 0,
      stopOverrides: [{ deliveryStopId: f.stops[6]!.id, address1: '700 Driver Reorder Correction', latitude: 43.57, longitude: -80.57 }] });
    const orders = new PrismaDriverRouteOrderService(prisma);
    const command = { ...adminIdentity(f), driverId: f.driver.id, commandId: randomUUID(), expectedVersion: f.version.id,
      orderedStopIds: [f.stops[0]!.id, f.stops[1]!.id, ...f.stops.slice(2).reverse().map(stop => stop.id)] };
    const beforeState = await prisma.routeLiveChangeState.findUniqueOrThrow({ where: { routePlanId: f.route.id } });
    await expect(orders.reorder(command)).rejects.toMatchObject({ code: 'DRAFT_CONFLICT' });
    expect(await prisma.dsvCommandReceipt.count({ where: { shopId: f.shop.id, commandId: command.commandId } })).toBe(0);
    expect(await prisma.routeLiveChangeState.findUniqueOrThrow({ where: { routePlanId: f.route.id } })).toEqual(beforeState);
    expect((await readAssigned(prisma, f)).stops.map(stop => stop.deliveryStopId)).toEqual(f.stops.map(stop => stop.id));
    await discardDraft(prisma, { ...adminIdentity(f), expectedRevision: 1 });
    await saveDraft(prisma, { ...adminIdentity(f), expectedRevision: 2,
      stopOverrides: [{ deliveryStopId: f.stops[6]!.id, address1: '700 Driver Reorder Correction', latitude: 43.57, longitude: -80.57 }] });
    const previous = await dispatch(prisma, { ...adminIdentity(f), expectedRevision: 3 });
    const immutable = await prisma.routeLiveChangePublication.findUniqueOrThrow({ where: { id: previous.publicationVersionId } });
    const reordered = await orders.reorder(command);
    expect(reordered.routeVersionId).not.toBe(f.version.id);
    expect(await orders.reorder(command)).toEqual(reordered);
    expect(await readPublication(prisma, f)).toMatchObject({ publicationVersionId: reordered.routeVersionId, sequence: 2, pending: true });
    expect((await readAssigned(prisma, f)).routeVersionId).toBe(reordered.routeVersionId);
    const access = await new PrismaDriverRouteAccessRepository(prisma).lookupRouteAccess({ accountId: f.account.id, routeContext: f.route.id });
    expect(access.status).toBe('INVITED');
    if (access.status !== 'INVITED') throw new Error('Synthetic driver-reordered route access was not issued');
    expect(access.routeAccess.expectedRouteVersionId).toBe(reordered.routeVersionId);
    const events = new PrismaDriverEventRepository(prisma);
    await expect(events.recordDriverEvent({ ...eventInput(f, f.stops[1]!.id), expectedRouteVersionId: previous.publicationVersionId }))
      .resolves.toMatchObject({ duplicate: false });
    await expect(events.recordDriverEvent({ ...eventInput(f, f.stops[6]!.id), expectedRouteVersionId: reordered.routeVersionId }))
      .resolves.toMatchObject({ duplicate: false });
    await expect(events.recordDriverEvent({ ...eventInput(f, f.stops[2]!.id), expectedRouteVersionId: previous.publicationVersionId }))
      .rejects.toMatchObject({ code: 'ROUTE_VERSION_MISMATCH' });
    expect(await prisma.routeLiveChangePublication.findUniqueOrThrow({ where: { id: previous.publicationVersionId } })).toEqual(immutable);
    expect(await publicationCount(prisma, f)).toBe(2);
  });

  test('retries a failed mock push for the same publication without duplicate Dispatch delivery', async () => {
    const f = await fixture(prisma);
    const validToken = `synthetic-token-${randomUUID()}`;
    const foreignToken = `synthetic-foreign-token-${randomUUID()}`;
    await prisma.driverPushToken.createMany({ data: [
      { accountId: f.account.id, devicePushToken: validToken, tokenHash: randomUUID(), platform: 'android', appId: KFOOD_DELIVERY_APP_ID },
      { accountId: f.account.id, devicePushToken: foreignToken, tokenHash: randomUUID(), platform: 'android', appId: 'synthetic-other-app' }
    ] });
    const send = vi.fn<DriverPushProvider['sendRouteNotification']>()
      .mockResolvedValueOnce({ status: 'FAILED', errorCode: 'SYNTHETIC_PROVIDER_FAILURE' })
      .mockResolvedValue({ status: 'SENT', providerMessageId: 'synthetic-success' });
    const service = new PrismaLiveRouteChangeService(prisma, { providerName: 'synthetic-only', sendRouteNotification: send });
    const admin = { appId: KFOOD_DELIVERY_APP_ID, shopDomain: KFOOD_DELIVERY_SHOP_DOMAIN, routePlanId: f.route.id,
      expectedAssignmentGeneration: '2', expectedRouteVersionId: f.version.id };
    await service.saveAdminDraft({ ...admin, commandId: randomUUID(), expectedRevision: 0, stopOverrides: [{ deliveryStopId: f.stops[6]!.id, address1: '700 Notification Integration Road', latitude: 43.57, longitude: -80.57 }] });
    await service.dispatchAdminDraft({ ...admin, commandId: randomUUID(), expectedRevision: 1 });
    expect(send).toHaveBeenCalledTimes(1);
    expect((await readPublication(prisma, f)).pending).toBe(true);
    await Promise.all([service.dispatchAdminDraft({ ...admin, commandId: randomUUID(), expectedRevision: 1 }), service.dispatchAdminDraft({ ...admin, commandId: randomUUID(), expectedRevision: 1 })]);
    expect(send).toHaveBeenCalledTimes(2);
    expect(await publicationCount(prisma, f)).toBe(1);
    await service.dispatchAdminDraft({ ...admin, commandId: randomUUID(), expectedRevision: 1 });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]![0].publicationVersion).toBe(send.mock.calls[1]![0].publicationVersion);
    expect(send.mock.calls.every(([payload]) => payload.devicePushToken === validToken)).toBe(true);
    expect((await readPublication(prisma, f)).pending).toBe(true);
  });

  test('sends a live change push to the token the driver app registers under its package id, and to no other app', async () => {
    const f = await fixture(prisma);
    const driverAppToken = `synthetic-driver-app-token-${randomUUID()}`;
    const legacyToken = `synthetic-tenant-token-${randomUUID()}`;
    const otherAppToken = `synthetic-other-app-token-${randomUUID()}`;
    await prisma.driverPushToken.createMany({ data: [
      { accountId: f.account.id, devicePushToken: driverAppToken, tokenHash: randomUUID(), platform: 'android', appId: 'com.evnsolution.clever.routes' },
      { accountId: f.account.id, devicePushToken: legacyToken, tokenHash: randomUUID(), platform: 'android', appId: KFOOD_DELIVERY_APP_ID },
      { accountId: f.account.id, devicePushToken: otherAppToken, tokenHash: randomUUID(), platform: 'android', appId: 'com.evns.cleverdriverapp' }
    ] });
    const send = vi.fn<DriverPushProvider['sendRouteNotification']>().mockResolvedValue({ status: 'SENT', providerMessageId: 'synthetic-sent' });
    const service = new PrismaLiveRouteChangeService(prisma, { providerName: 'synthetic-only', sendRouteNotification: send });
    const admin = serviceAdminIdentity(f);
    await service.saveAdminDraft({ ...admin, commandId: randomUUID(), expectedRevision: 0,
      stopOverrides: [{ deliveryStopId: f.stops[6]!.id, address1: '700 Driver App Token Road', latitude: 43.57, longitude: -80.57 }] });

    const dispatched = await service.dispatchAdminDraft({ ...admin, commandId: randomUUID(), expectedRevision: 1 });

    expect(dispatched.notification?.status).toBe('SENT');
    expect(send.mock.calls.map(([payload]) => payload.devicePushToken).sort()).toEqual([driverAppToken, legacyToken].sort());
    expect(send.mock.calls.every(([payload]) => payload.action === 'changed' && payload.publicationVersion === dispatched.publicationVersionId)).toBe(true);
  });

  test('skips a failed notification retry and geometry refresh after delivery work completes', async () => {
    const f = await fixture(prisma);
    await prisma.driverPushToken.create({ data: { accountId: f.account.id, devicePushToken: `synthetic-token-${randomUUID()}`, tokenHash: randomUUID(), platform: 'android', appId: KFOOD_DELIVERY_APP_ID } });
    const send = vi.fn<DriverPushProvider['sendRouteNotification']>().mockResolvedValue({ status: 'FAILED', errorCode: 'SYNTHETIC_RETRY_AFTER_COMPLETION' });
    const buildRoute = vi.fn<RouteGeometryProvider['buildRoute']>(detail => Promise.resolve(syntheticGeometry(detail)));
    const service = new PrismaLiveRouteChangeService(prisma, { providerName: 'synthetic-only', sendRouteNotification: send }, { geometryProvider: { buildRoute } });
    const admin = serviceAdminIdentity(f);
    await service.saveAdminDraft({ ...admin, commandId: randomUUID(), expectedRevision: 0,
      stopOverrides: [{ deliveryStopId: f.stops[6]!.id, address1: '700 Complete Before Retry', latitude: 43.57, longitude: -80.57 }] });
    const command = { ...admin, commandId: randomUUID(), expectedRevision: 1 };
    const first = await service.dispatchAdminDraft(command);
    expect(first.notification?.status).toBe('FAILED');
    expect(first.geometry.status).toBe('fresh');
    const events = new PrismaDriverEventRepository(prisma);
    for (const stop of f.stops.slice(1)) {
      await events.recordDriverEvent({ ...eventInput(f, stop.id), expectedRouteVersionId: first.publicationVersionId });
    }
    const completed = await prisma.routePlan.findUniqueOrThrow({ where: { id: f.route.id } });
    expect(completed.deliveryWorkCompletedAt).not.toBeNull();
    const beforeRows = await prisma.routePlanStop.findMany({ where: { routePlanId: f.route.id }, orderBy: { sequence: 'asc' } });
    const beforeCache = await prisma.routePlanGeometryCache.findMany({ where: { routePlanId: f.route.id } });
    const retry = await service.dispatchAdminDraft(command);
    expect(retry.publicationVersionId).toBe(first.publicationVersionId);
    expect(retry.notification).toMatchObject({ status: 'SKIPPED', attemptCount: 1 });
    expect(retry.geometry.status).toBe('superseded');
    expect(send).toHaveBeenCalledTimes(1);
    expect(buildRoute).toHaveBeenCalledTimes(1);
    expect(await prisma.routePlanStop.findMany({ where: { routePlanId: f.route.id }, orderBy: { sequence: 'asc' } })).toEqual(beforeRows);
    expect(await prisma.routePlanGeometryCache.findMany({ where: { routePlanId: f.route.id } })).toEqual(beforeCache);
    expect((await prisma.routePlan.findUniqueOrThrow({ where: { id: f.route.id } })).driverNavigationUntil).toEqual(completed.driverNavigationUntil);
    expect(await publicationCount(prisma, f)).toBe(1);
  });

  test('replays lost Dispatch N after N+1 without retrying superseded failed notifications', async () => {
    const f = await fixture(prisma);
    await prisma.driverPushToken.create({ data: { accountId: f.account.id, devicePushToken: `synthetic-token-${randomUUID()}`, tokenHash: randomUUID(), platform: 'android', appId: KFOOD_DELIVERY_APP_ID } });
    const send = vi.fn<DriverPushProvider['sendRouteNotification']>()
      .mockResolvedValueOnce({ status: 'FAILED', errorCode: 'SYNTHETIC_LOST_RESPONSE' })
      .mockResolvedValue({ status: 'SENT', providerMessageId: 'synthetic-new-publication' });
    const service = new PrismaLiveRouteChangeService(prisma, { providerName: 'synthetic-only', sendRouteNotification: send });
    const admin = { appId: KFOOD_DELIVERY_APP_ID, shopDomain: KFOOD_DELIVERY_SHOP_DOMAIN, routePlanId: f.route.id,
      expectedAssignmentGeneration: '2', expectedRouteVersionId: f.version.id };
    await service.saveAdminDraft({ ...admin, commandId: randomUUID(), expectedRevision: 0,
      stopOverrides: [{ deliveryStopId: f.stops[6]!.id, address1: '700 Dispatch N', latitude: 43.57, longitude: -80.57 }] });
    const firstCommand = { ...admin, commandId: randomUUID(), expectedRevision: 1 };
    const first = await service.dispatchAdminDraft(firstCommand);
    await service.saveAdminDraft({ ...admin, commandId: randomUUID(), expectedRevision: 1,
      stopOverrides: [{ deliveryStopId: f.stops[6]!.id, address1: '700 Dispatch N+1', latitude: 43.58, longitude: -80.58 }] });
    const second = await service.dispatchAdminDraft({ ...admin, commandId: randomUUID(), expectedRevision: 2 });
    const replay = await service.dispatchAdminDraft(firstCommand);
    expect(replay.publicationVersionId).toBe(first.publicationVersionId);
    expect(replay.sequence).toBe(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect((await readPublication(prisma, f)).publicationVersionId).toBe(second.publicationVersionId);
    expect(await publicationCount(prisma, f)).toBe(2);
  });

  test('preserves a READY avoiding route address, cache, ETA and history when its address geometry fails', async () => {
    const f = await readyAvoidingFixture(prisma);
    const buildRoute = vi.fn<RouteGeometryProvider['buildRoute']>().mockRejectedValue(new Error('synthetic avoidance failure'));
    const service = new RoutePlanAdminService(new PrismaRoutePlanRepository(prisma), { buildRoute });
    await prisma.routePlanGeometryCache.create({ data: { routePlanId: f.route.id, shapeSignature: 'ready-previous-cache',
      geometry: { type: 'LineString', coordinates: [[-80.4, 43.4], [-80.58, 43.58]] }, metrics: { distanceMeters: 900, durationSeconds: 90 },
      stopPoints: [], provider: 'osrm', source: 'SYNTHETIC', overview: 'full' } });
    const before = {
      stop: await prisma.deliveryStop.findUniqueOrThrow({ where: { id: f.stops[6]!.id } }),
      eta: await prisma.routePlanStop.findMany({ where: { routePlanId: f.route.id }, orderBy: { sequence: 'asc' } }),
      cache: await prisma.routePlanGeometryCache.findMany({ where: { routePlanId: f.route.id } }),
      snapshot: await prisma.routeGroupingChildVersion.findUniqueOrThrow({ where: { id: f.version.id } }),
      order: await prisma.order.findUniqueOrThrow({ where: { id: f.stops[6]!.orderId } })
    };
    await expect(service.updateAdminRouteStopOverride({ ...serviceAdminIdentity(f), actor: 'synthetic-admin',
      deliveryStopId: f.stops[6]!.id, payload: { address1: '700 READY Failed Edit', latitude: 43.57, longitude: -80.57 } }))
      .rejects.toMatchObject({ code: 'ROUTE_REFRESH_GEOMETRY_FAILED' });
    expect(await prisma.deliveryStop.findUniqueOrThrow({ where: { id: f.stops[6]!.id } })).toEqual(before.stop);
    expect(await prisma.routePlanStop.findMany({ where: { routePlanId: f.route.id }, orderBy: { sequence: 'asc' } })).toEqual(before.eta);
    expect(await prisma.routePlanGeometryCache.findMany({ where: { routePlanId: f.route.id } })).toEqual(before.cache);
    expect(await prisma.routeGroupingChildVersion.findUniqueOrThrow({ where: { id: f.version.id } })).toEqual(before.snapshot);
    expect(await prisma.order.findUniqueOrThrow({ where: { id: f.stops[6]!.orderId } })).toEqual(before.order);
    expect(await prisma.driverEvent.count({ where: { routePlanId: f.route.id } })).toBe(0);
  });

  test('commits a READY avoiding route address and compliant geometry once in the same transaction', async () => {
    const f = await readyAvoidingFixture(prisma);
    const buildRoute = vi.fn<RouteGeometryProvider['buildRoute']>(detail => Promise.resolve(syntheticGeometry(detail)));
    const service = new RoutePlanAdminService(new PrismaRoutePlanRepository(prisma), { buildRoute });
    const result = await service.updateAdminRouteStopOverride({ ...serviceAdminIdentity(f), actor: 'synthetic-admin',
      deliveryStopId: f.stops[6]!.id, payload: { address1: '700 READY Successful Edit', latitude: 43.57, longitude: -80.57 } });
    expect(result?.geometry.status).toBe('fresh');
    expect(result?.routePlan.routeGeometryStatus).toBe('fresh');
    expect(result?.routePlan.stops.find(stop => stop.deliveryStopId === f.stops[6]!.id)?.address.address1).toBe('700 READY Successful Edit');
    expect(await prisma.routePlanGeometryCache.count({ where: { routePlanId: f.route.id } })).toBe(1);
    expect(buildRoute).toHaveBeenCalledTimes(1);
    expect(buildRoute.mock.calls[0]?.[0].routePlan.tollPolicy).toBe('AVOID_TOLLS');
  });

  test('records a changed Stop time of a READY route as the office choice and clears the choice on reset', async () => {
    const f = await readyAvoidingFixture(prisma);
    const buildRoute = vi.fn<RouteGeometryProvider['buildRoute']>(detail => Promise.resolve(syntheticGeometry(detail)));
    const service = new RoutePlanAdminService(new PrismaRoutePlanRepository(prisma), { buildRoute });
    const deliveryStopId = f.stops[6]!.id;
    const edit = (serviceMinutes: number | null) => service.updateAdminRouteStopOverride({ ...serviceAdminIdentity(f), actor: 'synthetic-admin', deliveryStopId, payload: { serviceMinutes } });
    const read = () => prisma.deliveryStop.findUniqueOrThrow({ select: { serviceMinutes: true, serviceMinutesSource: true }, where: { id: deliveryStopId } });

    await edit(11);
    expect(await read()).toEqual({ serviceMinutes: 11, serviceMinutesSource: 'STOP' });
    // The same time again changes nothing: no new geometry, and the stop keeps its source.
    const geometryCalls = buildRoute.mock.calls.length;
    await edit(11);
    expect(buildRoute.mock.calls.length).toBe(geometryCalls);
    expect(await read()).toEqual({ serviceMinutes: 11, serviceMinutesSource: 'STOP' });
    await edit(null);
    expect(await read()).toEqual({ serviceMinutes: 5, serviceMinutesSource: null });
  });

  test('rolls back an avoid-tolls Dispatch and preserves stops, publication, receipts, and cache on provider failure', async () => {
    const f = await fixture(prisma);
    await prisma.routePlan.update({ where: { id: f.route.id }, data: { constraints: { timezone: 'America/Toronto', tollPolicy: 'AVOID_TOLLS' } } });
    const buildRoute = vi.fn<RouteGeometryProvider['buildRoute']>().mockRejectedValue(new Error('synthetic excluded route unavailable'));
    const send = vi.fn<DriverPushProvider['sendRouteNotification']>();
    const service = new PrismaLiveRouteChangeService(prisma, { providerName: 'synthetic-only', sendRouteNotification: send }, { geometryProvider: { buildRoute } });
    const admin = serviceAdminIdentity(f);
    await service.saveAdminDraft({ ...admin, commandId: randomUUID(), expectedRevision: 0,
      futureStopOrder: f.stops.slice(2).map(stop => stop.id).reverse(),
      stopOverrides: [{ deliveryStopId: f.stops[6]!.id, address1: '700 Avoidance Failure', latitude: 43.57, longitude: -80.57 }] });
    await prisma.routePlanGeometryCache.create({ data: { routePlanId: f.route.id, shapeSignature: 'previous-avoidance-cache',
      geometry: { type: 'LineString', coordinates: [[-80.4, 43.4], [-80.58, 43.58]] }, metrics: { distanceMeters: 900, durationSeconds: 90 },
      stopPoints: [], provider: 'osrm', source: 'SYNTHETIC', overview: 'full' } });
    const before = {
      route: await prisma.routePlan.findUniqueOrThrow({ where: { id: f.route.id } }),
      stops: await prisma.deliveryStop.findMany({ where: { id: { in: f.stops.map(stop => stop.id) } }, orderBy: { id: 'asc' } }),
      ordered: await prisma.routePlanStop.findMany({ where: { routePlanId: f.route.id }, orderBy: { sequence: 'asc' } }),
      state: await prisma.routeLiveChangeState.findUniqueOrThrow({ where: { routePlanId: f.route.id } }),
      cache: await prisma.routePlanGeometryCache.findMany({ where: { routePlanId: f.route.id } })
    };
    const command = { ...admin, commandId: randomUUID(), expectedRevision: 1 };
    await expect(service.dispatchAdminDraft(command)).rejects.toMatchObject({ code: 'TOLL_POLICY_ROUTE_UNAVAILABLE', statusCode: 503 });
    expect(await prisma.routePlan.findUniqueOrThrow({ where: { id: f.route.id } })).toEqual(before.route);
    expect(await prisma.deliveryStop.findMany({ where: { id: { in: f.stops.map(stop => stop.id) } }, orderBy: { id: 'asc' } })).toEqual(before.stops);
    expect(await prisma.routePlanStop.findMany({ where: { routePlanId: f.route.id }, orderBy: { sequence: 'asc' } })).toEqual(before.ordered);
    expect(await prisma.routeLiveChangeState.findUniqueOrThrow({ where: { routePlanId: f.route.id } })).toEqual(before.state);
    expect(await prisma.routePlanGeometryCache.findMany({ where: { routePlanId: f.route.id } })).toEqual(before.cache);
    expect(await publicationCount(prisma, f)).toBe(0);
    expect(await prisma.routeLiveChangeCommandReceipt.count({ where: { routePlanId: f.route.id, kind: 'DISPATCH' } })).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(buildRoute.mock.calls[0]?.[0].routePlan.tollPolicy).toBe('AVOID_TOLLS');
  });

  test('atomically publishes an avoid-tolls Dispatch with geometry and future ETA and replays it once', async () => {
    const f = await fixture(prisma);
    await prisma.routePlan.update({ where: { id: f.route.id }, data: { constraints: { timezone: 'America/Toronto', tollPolicy: 'AVOID_TOLLS' } } });
    const buildRoute = vi.fn<RouteGeometryProvider['buildRoute']>(detail => Promise.resolve(syntheticGeometry(detail)));
    const service = new PrismaLiveRouteChangeService(prisma, undefined, { geometryProvider: { buildRoute } });
    const admin = serviceAdminIdentity(f);
    await service.saveAdminDraft({ ...admin, commandId: randomUUID(), expectedRevision: 0,
      futureStopOrder: f.stops.slice(2).map(stop => stop.id).reverse(),
      stopOverrides: [{ deliveryStopId: f.stops[6]!.id, address1: '700 Avoidance Success', latitude: 43.57, longitude: -80.57 }] });
    const command = { ...admin, commandId: randomUUID(), expectedRevision: 1 };
    const result = await service.dispatchAdminDraft(command);
    expect(result.geometry.status).toBe('fresh');
    const retry = await service.dispatchAdminDraft(command);
    expect(retry.publicationVersionId).toBe(result.publicationVersionId);
    expect(retry.geometry.status).toBe('fresh');
    expect(buildRoute).toHaveBeenCalledTimes(1);
    expect(await publicationCount(prisma, f)).toBe(1);
    expect(await prisma.routeLiveChangeCommandReceipt.count({ where: { routePlanId: f.route.id, kind: 'DISPATCH' } })).toBe(1);
    const rows = await prisma.routePlanStop.findMany({ where: { routePlanId: f.route.id }, orderBy: { sequence: 'asc' } });
    expect(rows[1]).toMatchObject({ deliveryStopId: f.stops[1]!.id, estimatedArrivalAt: f.currentEta, durationFromPreviousSeconds: 60 });
    expect(rows[2]).toMatchObject({ deliveryStopId: f.stops[6]!.id, etaStatus: 'READY', durationFromPreviousSeconds: 90 });
    expect(await prisma.routePlanGeometryCache.count({ where: { routePlanId: f.route.id } })).toBe(1);
  });

  test('rejects stale avoid-tolls Dispatch revisions before invoking the engine or changing the publication', async () => {
    const f = await fixture(prisma);
    await prisma.routePlan.update({ where: { id: f.route.id }, data: { constraints: { timezone: 'America/Toronto', tollPolicy: 'AVOID_TOLLS' } } });
    const buildRoute = vi.fn<RouteGeometryProvider['buildRoute']>(detail => Promise.resolve(syntheticGeometry(detail)));
    const service = new PrismaLiveRouteChangeService(prisma, undefined, { geometryProvider: { buildRoute } });
    const admin = serviceAdminIdentity(f);
    await service.saveAdminDraft({ ...admin, commandId: randomUUID(), expectedRevision: 0,
      stopOverrides: [{ deliveryStopId: f.stops[6]!.id, address1: '700 First Draft', latitude: 43.57, longitude: -80.57 }] });
    await service.saveAdminDraft({ ...admin, commandId: randomUUID(), expectedRevision: 1,
      stopOverrides: [{ deliveryStopId: f.stops[6]!.id, address1: '700 Newer Draft', latitude: 43.58, longitude: -80.58 }] });
    await expect(service.dispatchAdminDraft({ ...admin, commandId: randomUUID(), expectedRevision: 1 }))
      .rejects.toMatchObject({ code: 'REVISION_CONFLICT', statusCode: 409 });
    expect(buildRoute).not.toHaveBeenCalled();
    expect(await publicationCount(prisma, f)).toBe(0);
    expect((await prisma.deliveryStop.findUniqueOrThrow({ where: { id: f.stops[6]!.id } })).address1).toBe('7 Integration Road');
    expect((await prisma.routeLiveChangeState.findUniqueOrThrow({ where: { routePlanId: f.route.id } })).revision).toBe(2);
  });

  test('rebuilds future geometry and ETA while preserving the current arrival and ETA', async () => {
    const f = await fixture(prisma);
    const buildRoute = vi.fn<RouteGeometryProvider['buildRoute']>(detail => Promise.resolve(syntheticGeometry(detail)));
    const service = new PrismaLiveRouteChangeService(prisma, undefined, { geometryProvider: { buildRoute } });
    const admin = serviceAdminIdentity(f);
    await service.saveAdminDraft({ ...admin, commandId: randomUUID(), expectedRevision: 0,
      futureStopOrder: f.stops.slice(2).map(stop => stop.id).reverse(),
      stopOverrides: [{ deliveryStopId: f.stops[6]!.id, address1: '700 Geometry Updated', latitude: 43.57, longitude: -80.57 }] });
    const command = { ...admin, commandId: randomUUID(), expectedRevision: 1 };
    expect((await service.dispatchAdminDraft(command)).geometry.status).toBe('fresh');
    const rows = await prisma.routePlanStop.findMany({ where: { routePlanId: f.route.id }, orderBy: { sequence: 'asc' } });
    expect(rows[1]).toMatchObject({ deliveryStopId: f.stops[1]!.id, estimatedArrivalAt: f.currentEta, durationFromPreviousSeconds: 60 });
    expect(rows[2]).toMatchObject({ deliveryStopId: f.stops[6]!.id, etaStatus: 'READY', durationFromPreviousSeconds: 90, distanceFromPreviousMeters: 900 });
    expect(rows[2]!.estimatedArrivalAt).toEqual(new Date(f.currentEta.getTime() + f.stops[1]!.serviceMinutes * 60_000 + 90_000));
    expect((await prisma.driverEvent.findUniqueOrThrow({ where: { id: f.arrival.id } })).occurredAt).toEqual(f.arrivedAt);
    expect(await prisma.routePlanGeometryCache.count({ where: { routePlanId: f.route.id } })).toBe(1);
    await service.dispatchAdminDraft(command);
    expect(buildRoute).toHaveBeenCalledTimes(1);
    expect(await publicationCount(prisma, f)).toBe(1);
  });

  test('records failed future geometry and retries the same publication without changing current ETA', async () => {
    const f = await fixture(prisma);
    const buildRoute = vi.fn<RouteGeometryProvider['buildRoute']>()
      .mockRejectedValueOnce(new Error('synthetic engine unavailable'))
      .mockImplementation(detail => Promise.resolve(syntheticGeometry(detail)));
    const service = new PrismaLiveRouteChangeService(prisma, undefined, { geometryProvider: { buildRoute } });
    const admin = serviceAdminIdentity(f);
    await service.saveAdminDraft({ ...admin, commandId: randomUUID(), expectedRevision: 0,
      stopOverrides: [{ deliveryStopId: f.stops[6]!.id, address1: '700 Geometry Retry', latitude: 43.57, longitude: -80.57 }] });
    const command = { ...admin, commandId: randomUUID(), expectedRevision: 1 };
    expect((await service.dispatchAdminDraft(command)).geometry.status).toBe('failed');
    const future = await prisma.routePlanStop.findFirstOrThrow({ where: { routePlanId: f.route.id, deliveryStopId: f.stops[6]!.id } });
    expect(future).toMatchObject({ estimatedArrivalAt: null, etaStatus: 'FAILED', etaFailureCode: 'ROUTE_GEOMETRY_BUILD_FAILED' });
    expect((await service.dispatchAdminDraft(command)).geometry.status).toBe('fresh');
    expect(buildRoute).toHaveBeenCalledTimes(2);
    expect(await publicationCount(prisma, f)).toBe(1);
    expect((await prisma.routePlanStop.findFirstOrThrow({ where: { routePlanId: f.route.id, deliveryStopId: f.stops[1]!.id } })).estimatedArrivalAt).toEqual(f.currentEta);
  });

  test('rejects stale geometry from N when N+1 publishes while the engine is running', async () => {
    const f = await fixture(prisma);
    let engineStarted!: () => void;
    let releaseEngine!: () => void;
    const started = new Promise<void>(resolve => { engineStarted = resolve; });
    const release = new Promise<void>(resolve => { releaseEngine = resolve; });
    let calls = 0;
    const buildRoute = vi.fn<RouteGeometryProvider['buildRoute']>(async detail => {
      if (calls++ === 0) { engineStarted(); await release; }
      return syntheticGeometry(detail);
    });
    const service = new PrismaLiveRouteChangeService(prisma, undefined, { geometryProvider: { buildRoute } });
    const admin = serviceAdminIdentity(f);
    await service.saveAdminDraft({ ...admin, commandId: randomUUID(), expectedRevision: 0,
      stopOverrides: [{ deliveryStopId: f.stops[6]!.id, address1: '700 Engine N', latitude: 43.57, longitude: -80.57 }] });
    const first = service.dispatchAdminDraft({ ...admin, commandId: randomUUID(), expectedRevision: 1 });
    await started;
    try {
      await service.saveAdminDraft({ ...admin, commandId: randomUUID(), expectedRevision: 1,
        stopOverrides: [{ deliveryStopId: f.stops[6]!.id, address1: '700 Engine N+1', latitude: 43.58, longitude: -80.58 }] });
      const second = await service.dispatchAdminDraft({ ...admin, commandId: randomUUID(), expectedRevision: 2 });
      expect(second.geometry.status).toBe('fresh');
      releaseEngine();
      expect((await first).geometry.status).toBe('superseded');
      expect((await readPublication(prisma, f)).publicationVersionId).toBe(second.publicationVersionId);
      expect(await prisma.routePlanGeometryCache.count({ where: { routePlanId: f.route.id } })).toBe(1);
      expect((await readAssigned(prisma, f)).stops.find(stop => stop.deliveryStopId === f.stops[6]!.id)?.coordinates.latitude).toBe(43.58);
    } finally { releaseEngine(); await first; }
  });

  test('retains successful duplicate geometry and ETA when an earlier duplicate fails late', async () => {
    const f = await fixture(prisma);
    let engineStarted!: () => void;
    let releaseEngine!: () => void;
    const started = new Promise<void>(resolve => { engineStarted = resolve; });
    const release = new Promise<void>(resolve => { releaseEngine = resolve; });
    let calls = 0;
    const buildRoute = vi.fn<RouteGeometryProvider['buildRoute']>(async detail => {
      if (calls++ === 0) {
        engineStarted();
        await release;
        throw new Error('synthetic late engine failure');
      }
      return syntheticGeometry(detail);
    });
    const service = new PrismaLiveRouteChangeService(prisma, undefined, { geometryProvider: { buildRoute } });
    const admin = serviceAdminIdentity(f);
    await service.saveAdminDraft({ ...admin, commandId: randomUUID(), expectedRevision: 0,
      stopOverrides: [{ deliveryStopId: f.stops[6]!.id, address1: '700 Duplicate Geometry', latitude: 43.57, longitude: -80.57 }] });
    const command = { ...admin, commandId: randomUUID(), expectedRevision: 1 };
    const first = service.dispatchAdminDraft(command);
    await started;
    try {
      const second = await service.dispatchAdminDraft(command);
      expect(second.geometry.status).toBe('fresh');
      const beforeRows = await prisma.routePlanStop.findMany({ where: { routePlanId: f.route.id }, orderBy: { sequence: 'asc' } });
      const beforeCache = await prisma.routePlanGeometryCache.findMany({ where: { routePlanId: f.route.id } });
      releaseEngine();
      expect((await first).geometry.status).toBe('fresh');
      expect(await prisma.routePlanStop.findMany({ where: { routePlanId: f.route.id }, orderBy: { sequence: 'asc' } })).toEqual(beforeRows);
      expect(await prisma.routePlanGeometryCache.findMany({ where: { routePlanId: f.route.id } })).toEqual(beforeCache);
      expect(beforeCache).toHaveLength(1);
      expect(buildRoute).toHaveBeenCalledTimes(2);
      expect(await publicationCount(prisma, f)).toBe(1);
    } finally { releaseEngine(); await first; }
  });

  test('requires admin authentication and the matching tenant for Save and Dispatch HTTP commands', async () => {
    const f = await fixture(prisma);
    const app = await buildApp({ adminRoutePlans: {
      liveRouteChangeService: new PrismaLiveRouteChangeService(prisma),
      sessionTokenVerifier: { verify(token) {
        if (!['synthetic-admin', 'foreign-admin'].includes(token)) throw new Error('Invalid synthetic admin token');
        return { appId: KFOOD_DELIVERY_APP_ID, shopDomain: token === 'synthetic-admin' ? KFOOD_DELIVERY_SHOP_DOMAIN : 'foreign.myshopify.com', subject: 'synthetic-office' };
      } },
      routePlanService: { assignRoutePlanDriver: () => Promise.resolve(null), createRoutePlan: () => Promise.reject(new Error('Unexpected legacy route creation')),
        deleteRoutePlan: () => Promise.reject(new Error('Unexpected legacy route deletion')), getRoutePlanDetail: () => Promise.resolve(null),
        listRoutePlans: () => Promise.resolve([]), publishRoutePlan: () => Promise.resolve(null), updateRoutePlanOptions: () => Promise.resolve(null), updateRoutePlanStops: () => Promise.resolve(null) }
    } });
    try {
      const url = `/admin/route-plans/${f.route.id}/live-change`;
      const headers = { authorization: 'Bearer synthetic-admin', 'x-clever-app-id': KFOOD_DELIVERY_APP_ID };
      const payload = { commandId: randomUUID(), expectedRevision: 0, expectedAssignmentGeneration: '2', expectedRouteVersionId: f.version.id,
        stopOverrides: [{ deliveryStopId: f.stops[6]!.id, address1: '700 Admin HTTP Address', latitude: 43.57, longitude: -80.57 }] };
      expect((await app.inject({ method: 'PATCH', url, payload })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url: `${url}/dispatch`, payload: {} })).statusCode).toBe(401);
      expect((await app.inject({ method: 'PATCH', url, headers: { ...headers, authorization: 'Bearer foreign-admin' }, payload })).statusCode).toBe(404);
      expect((await app.inject({ method: 'PATCH', url, headers, payload: { ...payload, commandId: undefined } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'PATCH', url, headers, payload: { ...payload, stopOverrides: [{ ...payload.stopOverrides[0], status: 'DELIVERED' }] } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'PATCH', url, headers, payload: { ...payload, stopOverrides: [{ ...payload.stopOverrides[0], instructions: 'Out of scope operational edit' }] } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'PATCH', url, headers, payload })).statusCode).toBe(200);
      expect((await prisma.deliveryStop.findUniqueOrThrow({ where: { id: f.stops[6]!.id } })).address1).toBe('7 Integration Road');
      const dispatchPayload = { commandId: randomUUID(), expectedRevision: 1, expectedAssignmentGeneration: '2', expectedRouteVersionId: f.version.id };
      const published = await app.inject({ method: 'POST', url: `${url}/dispatch`, headers, payload: dispatchPayload });
      expect(published.statusCode).toBe(200);
      expect(published.headers['cache-control']).toBe('private, no-store');
      expect(await publicationCount(prisma, f)).toBe(1);
      expect((await app.inject({ method: 'PATCH', url, headers, payload: { ...payload, commandId: randomUUID(), expectedRevision: 1,
        stopOverrides: [{ deliveryStopId: f.stops[2]!.id, address1: '300 Private HTTP Discard', latitude: 43.53, longitude: -80.53 }] } })).statusCode).toBe(200);
      const discardPayload = { ...dispatchPayload, commandId: randomUUID(), expectedRevision: 2 };
      expect((await app.inject({ method: 'POST', url: `${url}/discard`, payload: discardPayload })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url: `${url}/discard`, headers, payload: { ...discardPayload, commandId: undefined } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'POST', url: `${url}/discard`, headers: { ...headers, authorization: 'Bearer foreign-admin' }, payload: discardPayload })).statusCode).toBe(404);
      expect((await app.inject({ method: 'POST', url: `${url}/discard`, headers, payload: { ...discardPayload, expectedRevision: 1 } })).statusCode).toBe(409);
      const discarded = await app.inject({ method: 'POST', url: `${url}/discard`, headers, payload: discardPayload });
      expect(discarded.statusCode).toBe(200);
      expect(discarded.headers['cache-control']).toBe('private, no-store');
      expect(discarded.json<{ data: { revision: number; hasUnpublishedChanges: boolean } }>().data)
        .toMatchObject({ revision: 3, hasUnpublishedChanges: false });
      const retry = await app.inject({ method: 'POST', url: `${url}/discard`, headers, payload: discardPayload });
      expect(retry.statusCode).toBe(200);
      expect(retry.json()).toEqual(discarded.json());
      expect(await publicationCount(prisma, f)).toBe(1);
    } finally { await app.close(); }
  });

  test('uses route token scope and active account authorization for driver HTTP query and ACK', async () => {
    const f = await fixture(prisma);
    await saveDraft(prisma, { ...adminIdentity(f), expectedRevision: 0, stopOverrides: [{ deliveryStopId: f.stops[6]!.id, address1: '700 HTTP Integration Road', latitude: 43.57, longitude: -80.57 }] });
    const published = await dispatch(prisma, { ...adminIdentity(f), expectedRevision: 1 });
    const secret = 'synthetic-live-route-change-http-secret';
    const app = await buildApp({ driverApi: {
      driverEventService: new PrismaDriverEventRepository(prisma),
      driverTokenAccessRepository: new PrismaDriverTokenAccessRepository(prisma),
      liveRouteChangeService: new PrismaLiveRouteChangeService(prisma), jwtSecret: secret
    } });
    try {
      const token = signDriverRouteToken({ accountId: f.account.id, routePlanId: f.route.id, tokenVersion: f.account.tokenVersion, subject: `driver-account:${f.account.id}`, expiresInSeconds: 60 }, { secret }).token;
      const headers = { authorization: `Bearer ${token}` };
      const url = `/driver/routes/${f.route.id}/live-change`;
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
      const read = await app.inject({ method: 'GET', url, headers });
      expect(read.statusCode).toBe(200);
      expect(read.headers['cache-control']).toBe('private, no-store');
      expect((await app.inject({ method: 'GET', headers, url: `/driver/routes/${randomUUID()}/live-change` })).statusCode).toBe(403);
      const ack = await app.inject({ method: 'POST', headers, url: `${url}/applied`, payload: { publicationVersionId: published.publicationVersionId, assignmentGeneration: '2' } });
      expect(ack.statusCode).toBe(200);
      await prisma.driverAccount.update({ where: { id: f.account.id }, data: { tokenVersion: { increment: 1 } } });
      // Model revocation between HTTP authentication and the service transaction.
      const revokedIdentity = { ...driverIdentity(f), accountId: f.account.id, tokenVersion: f.account.tokenVersion };
      const service = new PrismaLiveRouteChangeService(prisma);
      await expect(service.getDriverPublication(revokedIdentity)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(service.acknowledgeDriverPublication({ ...revokedIdentity, publicationVersionId: published.publicationVersionId }))
        .rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect((await app.inject({ method: 'GET', url, headers })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', headers, url: `${url}/applied`, payload: { publicationVersionId: published.publicationVersionId, assignmentGeneration: '2' } })).statusCode).toBe(401);
    } finally { await app.close(); }
  });
});

type Fixture = Awaited<ReturnType<typeof fixture>>;
function adminIdentity(f: Fixture) { return { routePlanId: f.route.id, shopId: f.shop.id }; }
function driverIdentity(f: Fixture) { return { ...adminIdentity(f), driverId: f.driver.id, assignmentGeneration: '2' }; }
function serviceAdminIdentity(f: Fixture) {
  return { appId: KFOOD_DELIVERY_APP_ID, shopDomain: KFOOD_DELIVERY_SHOP_DOMAIN, routePlanId: f.route.id,
    expectedAssignmentGeneration: '2', expectedRouteVersionId: f.version.id };
}
function syntheticGeometry(detail: RoutePlanDetail): RoutePlanRouteResult {
  return { routeGeometry: { type: 'LineString', coordinates: [[-80.4, 43.4], [-80.58, 43.58]] },
    routeMetrics: { distanceMeters: detail.stops.length * 900, durationSeconds: detail.stops.length * 90 },
    routeStopPoints: detail.stops.map(stop => ({ deliveryStopId: stop.deliveryStopId, sequence: stop.sequence,
      name: null, shopifyOrderGid: stop.shopifyOrderGid, inputCoordinates: [-80.4, 43.4], snappedCoordinates: [-80.4, 43.4],
      snapDistanceMeters: 0, distanceFromPreviousMeters: 900, durationFromPreviousSeconds: 90 })) };
}
function eventInput(f: Fixture, deliveryStopId: string) {
  return { ...driverIdentity(f), shopDomain: KFOOD_DELIVERY_SHOP_DOMAIN, deliveryStopId,
    expectedRouteVersionId: f.version.id, driverContractVersion: 2, clientEventId: randomUUID(),
    eventType: 'STOP_DELIVERED', occurredAt: new Date(f.arrivedAt.getTime() + 30_000),
    latitude: null, longitude: null, payload: { source: 'synthetic-integration' } };
}
type DraftCommand = Omit<Parameters<typeof saveLiveRouteChange>[1], 'commandId' | 'expectedAssignmentGeneration' | 'expectedRouteVersionId'> & { commandId?: string; expectedAssignmentGeneration?: string; expectedRouteVersionId?: string };
async function saveDraft(prisma: PrismaClient, input: DraftCommand) {
  const identity = fixtureIdentities.get(input.routePlanId);
  if (identity === undefined) throw new Error('Synthetic draft identity is missing');
  return saveLiveRouteChange(prisma, { ...identity, ...input, commandId: input.commandId ?? randomUUID() });
}
type DispatchCommand = Omit<Parameters<typeof publishLiveRouteChange>[1], 'commandId' | 'expectedAssignmentGeneration' | 'expectedRouteVersionId'> & { commandId?: string; expectedAssignmentGeneration?: string; expectedRouteVersionId?: string };
async function dispatch(prisma: PrismaClient, input: DispatchCommand) {
  const identity = fixtureIdentities.get(input.routePlanId);
  if (identity === undefined) throw new Error('Synthetic Dispatch identity is missing');
  return publishLiveRouteChange(prisma, { ...identity, ...input, commandId: input.commandId ?? randomUUID() });
}
async function discardDraft(prisma: PrismaClient, input: DispatchCommand) {
  const identity = fixtureIdentities.get(input.routePlanId);
  if (identity === undefined) throw new Error('Synthetic discard identity is missing');
  return discardLiveRouteChange(prisma, { ...identity, ...input, commandId: input.commandId ?? randomUUID() });
}
async function readAssigned(prisma: PrismaClient, f: Fixture) {
  const result = await new PrismaDriverAssignedRouteRepository(prisma).getAssignedRoute({
    ...driverIdentity(f), routeContext: f.route.id, shopDomain: KFOOD_DELIVERY_SHOP_DOMAIN
  });
  if (result.status !== 'ASSIGNED_ROUTE') throw new Error('Synthetic assigned route is missing');
  return result.route;
}
async function readPublication(prisma: PrismaClient, f: Fixture) {
  const publication = await getLiveRouteChange(prisma, driverIdentity(f));
  if (publication === null) throw new Error('Synthetic route publication is missing');
  return publication;
}
async function publicationCount(prisma: PrismaClient, f: Fixture) {
  const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) FROM route_live_change_publications WHERE "routePlanId" = ${f.route.id}::uuid AND sequence > 0`;
  return Number(rows[0]!.count);
}

async function withRouteLock<T>(prisma: PrismaClient, f: Fixture, start: () => Promise<T>, waitingCount: number): Promise<T> {
  let unlock!: () => void;
  let locked!: () => void;
  const acquired = new Promise<void>(resolve => { locked = resolve; });
  const release = new Promise<void>(resolve => { unlock = resolve; });
  const blocker = prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM route_plans WHERE id = ${f.route.id}::uuid FOR UPDATE`;
    locked();
    await release;
  }, { timeout: 10_000 });
  await acquired;
  const mutations = start();
  try {
    let observed = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      // Attempt admission can wait on its route FK before ordered-event row locking.
      const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND (query LIKE '%route_plans%' OR query LIKE '%driver_event_attempts%')`;
      observed = Number(rows[0]!.count);
      if (observed >= waitingCount) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(observed).toBeGreaterThanOrEqual(waitingCount);
  } finally { unlock(); await blocker; }
  return mutations;
}

async function prepareGroupingFixture(prisma: PrismaClient, f: Fixture) {
  await prisma.shop.update({ where: { id: f.shop.id }, data: { defaultDepotAddress: '1 Synthetic Grouping Depot',
    defaultDepotLatitude: 43.4, defaultDepotLongitude: -80.4 } });
  await prisma.routeGroupingOrder.createMany({ data: f.stops.map((stop, index) => ({
    shopId: f.shop.id, groupingId: f.group.id, orderId: stop.orderId, deliveryStopId: stop.id,
    assignedDriverId: f.driver.id, assignmentStatus: 'ASSIGNED', sourceSequence: index + 1
  })) });
  const version = await prisma.routeGroupingChildVersion.findUniqueOrThrow({ where: { id: f.version.id } });
  await prisma.routeGroupingChildVersion.update({ where: { id: f.version.id }, data: { snapshot: {
    ...(version.snapshot as Prisma.InputJsonObject), driverId: f.driver.id, groupingId: f.group.id,
    groupingVersion: 1, name: f.route.name, planDate: f.group.planDate.toISOString(), routeIdx: 1, sortOrder: 1
  } } });
}

async function readyAvoidingFixture(prisma: PrismaClient) {
  const f = await fixture(prisma);
  await prisma.driverEvent.deleteMany({ where: { routePlanId: f.route.id } });
  await prisma.deliveryStop.updateMany({ where: { id: { in: f.stops.map(stop => stop.id) } }, data: { status: 'PENDING' } });
  await prisma.routePlan.update({ where: { id: f.route.id }, data: { status: 'DRAFT', driverId: null,
    depotLatitude: 43.4, depotLongitude: -80.4, constraints: { timezone: 'America/Toronto', tollPolicy: 'AVOID_TOLLS', scheduledStartAt: new Date().toISOString() } } });
  await prisma.routeGroupingChildVersion.update({ where: { id: f.version.id }, data: { driverId: null, publishedAt: null } });
  return f;
}

async function fixture(prisma: PrismaClient) {
  const suffix = randomUUID();
  const now = new Date();
  const arrivedAt = new Date(now.getTime() - 60_000);
  const currentEta = new Date(now.getTime() + 60_000);
  const shop = await prisma.shop.upsert({
    where: { appId_shopDomain: { appId: KFOOD_DELIVERY_APP_ID, shopDomain: KFOOD_DELIVERY_SHOP_DOMAIN } },
    create: { appId: KFOOD_DELIVERY_APP_ID, shopDomain: KFOOD_DELIVERY_SHOP_DOMAIN }, update: {}
  });
  const account = await prisma.driverAccount.create({ data: { phone: `live-change-${suffix}` } });
  const driver = await prisma.driver.create({ data: { accountId: account.id, authSubject: `live-change-${suffix}`, displayName: 'Synthetic Live Change Driver', shopId: shop.id } });
  const route = await prisma.routePlan.create({ data: { shopId: shop.id, driverId: driver.id, name: `live-change-${suffix}`, planDate: now,
    constraints: { timezone: 'America/Toronto' }, metrics: {}, optimizerVersion: 'synthetic-integration', status: 'IN_PROGRESS', assignmentGeneration: 2n } });
  const group = await prisma.routeGrouping.create({ data: { shopId: shop.id, name: `live-change-${suffix}`, planDate: now } });
  const parent = await prisma.routeGroupingVersion.create({ data: { shopId: shop.id, groupingId: group.id, version: 1 } });
  const version = await prisma.routeGroupingChildVersion.create({ data: { shopId: shop.id, groupingId: group.id, groupingVersionId: parent.id,
    routePlanId: route.id, driverId: driver.id, version: 1, snapshot: {}, publishedAt: now } });
  const stops = [];
  const upstreamPayloads = [];
  const members = [];
  for (let index = 0; index < 7; index += 1) {
    const sourceOrderId = `gid://shopify/Order/live-change-${suffix}-${index}`;
    const upstream = { shippingAddress: { address1: `${index + 1} Integration Road`, city: 'Synthetic City' }, source: 'immutable-test-source' };
    const order = await prisma.order.create({ data: { shopId: shop.id, name: `#synthetic-${index + 1}`, rawPayload: upstream, shopifyOrderGid: sourceOrderId, currentRouteVersionId: version.id } });
    const stop = await prisma.deliveryStop.create({ data: { shopId: shop.id, orderId: order.id, address1: `${index + 1} Integration Road`, city: 'Synthetic City', countryCode: 'CA', latitude: 43.4 + index / 100, longitude: -80.4 - index / 100,
      status: index === 0 ? 'DELIVERED' : index === 1 ? 'ARRIVED' : 'ASSIGNED' } });
    await prisma.routePlanStop.create({ data: { shopId: shop.id, routePlanId: route.id, deliveryStopId: stop.id, sequence: index + 1,
      estimatedArrivalAt: index === 1 ? currentEta : new Date(currentEta.getTime() + index * 60_000), durationFromPreviousSeconds: 60, distanceFromPreviousMeters: 1000,
      etaInputRouteVersionId: version.id, etaStatus: 'READY', etaCalculatedAt: now, etaSource: 'SYNTHETIC' } });
    stops.push(stop); upstreamPayloads.push(upstream);
    members.push({ sequence: index + 1, deliveryStopId: stop.id, orderId: order.id, sourceOrderId, address1: stop.address1, latitude: stop.latitude?.toString(), longitude: stop.longitude?.toString() });
  }
  await prisma.routeGroupingChildVersion.update({ where: { id: version.id }, data: { snapshot: { membershipSchemaVersion: 1, stops: members } } });
  for (const eventType of ['ROUTE_STARTED', 'PICKUP_COMPLETED'] as const) {
    await prisma.driverEvent.create({ data: { shopId: shop.id, driverId: driver.id, routePlanId: route.id, routeVersionId: version.id, assignmentGeneration: 2n,
      expectedRouteVersionId: version.id, driverContractVersion: 2, clientEventId: randomUUID(), eventType, occurredAt: new Date(arrivedAt.getTime() - 60_000), payload: { source: 'synthetic-seed' } } });
  }
  await prisma.driverEvent.create({ data: { shopId: shop.id, driverId: driver.id, routePlanId: route.id, routeVersionId: version.id, assignmentGeneration: 2n,
    expectedRouteVersionId: version.id, driverContractVersion: 2, clientEventId: randomUUID(), deliveryStopId: stops[0]!.id, eventType: 'STOP_DELIVERED', occurredAt: new Date(arrivedAt.getTime() - 30_000), payload: { source: 'synthetic-seed' } } });
  const arrival = await prisma.driverEvent.create({ data: { shopId: shop.id, driverId: driver.id, routePlanId: route.id, routeVersionId: version.id, assignmentGeneration: 2n,
    expectedRouteVersionId: version.id, driverContractVersion: 2, clientEventId: randomUUID(), deliveryStopId: stops[1]!.id, eventType: 'STOP_ARRIVED', occurredAt: arrivedAt, payload: { source: 'synthetic-seed' } } });
  fixtureIdentities.set(route.id, { expectedAssignmentGeneration: '2', expectedRouteVersionId: version.id });
  return { shop, account, driver, route, version, stops, group, parent, upstreamPayloads, arrival, arrivedAt, currentEta };
}
