import { createHash, randomUUID } from 'node:crypto';

import { PrismaClient, type Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import {
  DsvAssignmentCommandService,
  type DsvAssignmentCommandError,
} from '../src/modules/dsv/dsv-assignment-command.service.js';
import type {
  RouteGroupingDetailDto,
  RouteGroupingDraftRouteInput,
  RouteGroupingService,
} from '../src/modules/route-grouping/route-grouping.types.js';
import type { DsvAssignmentTransactionClient } from '../src/modules/dsv/dsv-assignment-transaction-port.js';
import { FakeDriverPushProvider } from '../src/modules/route-grouping/driver-push.provider.js';
import { PrismaRouteGroupingService } from '../src/modules/route-grouping/route-grouping.service.js';

const legacySafeTargetClass = 'safe-local-g004-temp-cluster';
const legacyExactDatabaseUrl = 'postgresql://clever_g004:clever_g004@127.0.0.1:55444/clever_g004?schema=public';
const g010SafeTargetClass = 'safe-local-g010-disposable';
const g010ExactDatabaseUrl = 'postgresql://clever_g007:clever_g007@127.0.0.1:55477/clever_g007_g010_eta?schema=public';
const databaseUrl = process.env.DATABASE_URL ?? '';
const targetClass = process.env.G004_DATABASE_TARGET_CLASS ?? '';
const isAssignmentTargetClass = targetClass === legacySafeTargetClass || targetClass === g010SafeTargetClass;
const isSafeDisposableTarget = (targetClass === legacySafeTargetClass && databaseUrl === legacyExactDatabaseUrl)
  || (targetClass === g010SafeTargetClass && databaseUrl === g010ExactDatabaseUrl);
const describeG004Disposable = isAssignmentTargetClass ? describe.sequential : describe.skip;
const commandNames = {
  acquire: 'acquireSellerOrder',
  reassign: 'reassignSellerOrder',
  release: 'releaseSellerOrder',
  unassign: 'unassignSellerOrder',
} as const;
const anyDateMatcher: unknown = expect.any(Date);

describeG004Disposable('G004 DSV assignment command DB integration', () => {
  const prisma = new PrismaClient();
  const createdShopIds: string[] = [];

  beforeAll(async () => {
    if (!isSafeDisposableTarget) {
      throw new Error(
        `Refusing unsafe G004 integration target: G004_DATABASE_TARGET_CLASS=${targetClass || '<missing>'} DATABASE_URL=${databaseUrl}`,
      );
    }
    await prisma.$connect();
  });

  afterAll(async () => {
    for (const shopId of createdShopIds.reverse()) {
      await prisma.shop.deleteMany({ where: { id: shopId } });
    }
    await prisma.$disconnect();
  });

  test('replays the same admin command and payload without duplicating receipt or audit writes', async () => {
    const fixture = await createFixture(prisma, createdShopIds, 'replay');
    const command = adminCommand(fixture, 'cmd-replay');

    const first = await fixture.service.reassign({
      ...command,
      targetDriverId: fixture.driverBId,
      targetRoutePlanId: fixture.routeBId,
      targetSequence: 1,
      targetVehicleId: fixture.vehicleBId,
    });
    const second = await fixture.service.reassign({
      ...command,
      targetDriverId: fixture.driverBId,
      targetRoutePlanId: fixture.routeBId,
      targetSequence: 1,
      targetVehicleId: fixture.vehicleBId,
    });

    expect(second).toEqual(first);
    await expect(receiptCount(fixture, commandNames.reassign, 'cmd-replay')).resolves.toBe(1);
    await expect(auditCount(fixture, first.receiptId)).resolves.toBe(1);
    await expect(activeOperationalOwnerCount(fixture, fixture.orderAId)).resolves.toBe(1);
  });

  test('rejects the same admin command id with a different payload without changing the winning result', async () => {
    const fixture = await createFixture(prisma, createdShopIds, 'payload-mismatch');
    const command = adminCommand(fixture, 'cmd-payload-mismatch');
    const first = await fixture.service.reassign({
      ...command,
      targetDriverId: fixture.driverBId,
      targetRoutePlanId: fixture.routeBId,
      targetVehicleId: fixture.vehicleBId,
    });
    const countsAfterFirst = await canonicalCounts(prisma, fixture.shopId);
    const receiptBeforeConflict = await receiptFor(fixture, commandNames.reassign, 'cmd-payload-mismatch');

    await expect(fixture.service.reassign({
      ...command,
      targetDriverId: fixture.driverAId,
      targetRoutePlanId: fixture.routeAId,
      targetVehicleId: fixture.vehicleAId,
    })).rejects.toMatchObject({ code: 'IDEMPOTENCY_PAYLOAD_MISMATCH' } satisfies Partial<DsvAssignmentCommandError>);

    await expect(canonicalCounts(prisma, fixture.shopId)).resolves.toEqual(countsAfterFirst);
    await expect(prisma.dsvCommandReceipt.findUniqueOrThrow({ where: { id: receiptBeforeConflict.id } }))
      .resolves.toEqual(receiptBeforeConflict);
    expect(JSON.parse(receiptBeforeConflict.responseBodyRef ?? 'null')).toEqual(first);
    await expect(activeOperationalOwnerCount(fixture, fixture.orderAId)).resolves.toBe(1);
  });

  test('reports an existing STARTED admin receipt as in progress without assignment writes', async () => {
    const fixture = await createFixture(prisma, createdShopIds, 'started');
    const command = adminCommand(fixture, 'cmd-started');
    const payloadHash = await fixture.payloadHash(commandNames.reassign, {
      ...command,
      targetDriverId: fixture.driverBId,
      targetRoutePlanId: fixture.routeBId,
      targetVehicleId: fixture.vehicleBId,
    });
    const receipt = await prisma.dsvCommandReceipt.create({
      data: {
        actorId: command.actor.actorId,
        actorType: command.actor.actorType,
        commandId: command.commandId,
        commandName: commandNames.reassign,
        payloadHash,
        principalType: command.actor.principalType,
        requestId: command.actor.requestId ?? command.commandId,
        sellerOrderId: fixture.orderAId,
        shopId: fixture.shopId,
        status: 'STARTED',
      },
    });
    const countsBefore = await canonicalCounts(prisma, fixture.shopId);

    await expect(fixture.service.reassign({
      ...command,
      targetDriverId: fixture.driverBId,
      targetRoutePlanId: fixture.routeBId,
      targetVehicleId: fixture.vehicleBId,
    })).rejects.toMatchObject({ code: 'COMMAND_IN_PROGRESS' } satisfies Partial<DsvAssignmentCommandError>);

    await expect(prisma.dsvCommandReceipt.findUniqueOrThrow({ where: { id: receipt.id } })).resolves.toMatchObject({
      completedAt: null,
      responseBodyRef: null,
      responseStatus: null,
      status: 'STARTED',
    });
    await expect(canonicalCounts(prisma, fixture.shopId)).resolves.toEqual(countsBefore);
  });

  test('lets one driver acquire win while a concurrent admin reassign loses on current route version', async () => {
    const fixture = await createFixture(prisma, createdShopIds, 'admin-driver-race', { initiallyUnassigned: true });

    const outcomes = await Promise.allSettled([
      fixture.service.acquire(driverCommand(fixture, 'cmd-driver-acquire-race')),
      fixture.service.reassign({
        ...adminCommand(fixture, 'cmd-admin-reassign-race'),
        targetDriverId: fixture.driverBId,
        targetRoutePlanId: fixture.routeBId,
        targetVehicleId: fixture.vehicleBId,
      }),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') {
        expect(readErrorCode(outcome.reason as unknown)).toMatch(/SELLER_ORDER_(?:ALREADY_ACQUIRED|ASSIGNMENT_CHANGED)/u);
      }
    }
    await expect(activeOperationalOwnerCount(fixture, fixture.orderAId)).resolves.toBe(1);
  });

  test('assigns a G003 null-route order when expected version is UNASSIGNED', async () => {
    const fixture = await createFixture(prisma, createdShopIds, 'null-route', { initiallyUnassigned: true, nullRouteOrder: true });

    const result = await fixture.service.acquire(driverCommand(fixture, 'cmd-null-route-acquire'));

    expect(result).toMatchObject({
      assignmentStatus: 'ASSIGNED',
      etaStatus: 'PENDING',
      routePlanId: fixture.routeAId,
      sellerOrderId: fixture.orderAId,
    });
    await expect(currentOwnerVersionId(fixture, fixture.orderAId)).resolves.toBe(fixture.versionAId);
    await expect(receiptCount(fixture, commandNames.acquire, 'cmd-null-route-acquire')).resolves.toBe(1);
  });

  test('uses Order.currentRouteVersionId as the single active owner despite duplicate grouping history rows', async () => {
    const fixture = await createFixture(prisma, createdShopIds, 'one-active-owner');
    await fixture.forceDuplicateOwner();

    await expect(activeOperationalOwnerCount(fixture, fixture.orderAId)).resolves.toBe(1);
    await expect(currentOwnerVersionId(fixture, fixture.orderAId)).resolves.toBe(fixture.versionAId);
  });

  test('unassign preserves order, stop, import history, and previous route history while moving to unassigned', async () => {
    const fixture = await createFixture(prisma, createdShopIds, 'history');
    const countsBefore = await canonicalCounts(prisma, fixture.shopId);

    const result = await fixture.service.unassign(adminCommand(fixture, 'cmd-unassign-history'));

    expect(result.assignmentStatus).toBe('UNASSIGNED');
    await expect(routeMembershipsForOrder(fixture, fixture.orderAId)).resolves.toEqual([fixture.routeUnassignedId]);
    await expect(prisma.order.count({ where: { id: fixture.orderAId, shopId: fixture.shopId } })).resolves.toBe(1);
    await expect(prisma.deliveryStop.count({ where: { id: fixture.stopAId, shopId: fixture.shopId } })).resolves.toBe(1);
    await expect(prisma.dsvDispatchImportRow.count({ where: { sellerOrderId: fixture.orderAId, shopId: fixture.shopId } }))
      .resolves.toBe(1);
    await expect(canonicalCounts(prisma, fixture.shopId)).resolves.toMatchObject({
      ...countsBefore,
      audits: countsBefore.audits + 1,
      receipts: countsBefore.receipts + 1,
      routeGroupingOrders: countsBefore.routeGroupingOrders,
    });
  });

  test('route start closes admin and driver transfer commands without route membership changes', async () => {
    const fixture = await createFixture(prisma, createdShopIds, 'route-start');
    await prisma.driverEvent.create({
      data: {
        driverId: fixture.driverAId,
        eventType: 'ROUTE_STARTED',
        occurredAt: new Date('2026-07-22T10:00:00.000Z'),
        payload: { source: 'g004-test' },
        routePlanId: fixture.routeAId,
        shopId: fixture.shopId,
      },
    });
    fixture.closeRoute(fixture.routeAId);
    const membershipsBefore = await routeMembershipsForOrder(fixture, fixture.orderAId);

    await expect(fixture.service.unassign(adminCommand(fixture, 'cmd-started-route-unassign')))
      .rejects.toMatchObject({ code: 'SELLER_ORDER_TRANSFER_CLOSED' } satisfies Partial<DsvAssignmentCommandError>);
    await expect(fixture.service.release(driverCommand(fixture, 'cmd-started-route-release')))
      .rejects.toMatchObject({ code: 'SELLER_ORDER_TRANSFER_CLOSED' } satisfies Partial<DsvAssignmentCommandError>);

    await expect(routeMembershipsForOrder(fixture, fixture.orderAId)).resolves.toEqual(membershipsBefore);
  });

  test('commits assignment and clears prior ETA failure on affected rows', async () => {
    const fixture = await createFixture(prisma, createdShopIds, 'eta-failure', { failEtaAfterSave: true });

    const result = await fixture.service.reassign({
      ...adminCommand(fixture, 'cmd-eta-failure'),
      targetDriverId: fixture.driverBId,
      targetRoutePlanId: fixture.routeBId,
      targetVehicleId: fixture.vehicleBId,
    });

    expect(result).toMatchObject({
      assignmentStatus: 'ASSIGNED',
      etaStatus: 'PENDING',
      routePlanId: fixture.routeBId,
    });
    await expect(routeMembershipsForOrder(fixture, fixture.orderAId)).resolves.toEqual([fixture.routeBId]);
    await expect(currentOwnerVersionId(fixture, fixture.orderAId)).resolves.toBe(result.newRouteVersionId);
    await expect(etaStatusesForRoutes(fixture, [fixture.routeAId, fixture.routeBId])).resolves.toEqual(['PENDING']);
  });

  test('links receipt and audit rows to seller order and previous and next route versions', async () => {
    const fixture = await createFixture(prisma, createdShopIds, 'receipt-audit');

    const result = await fixture.service.reassign({
      ...adminCommand(fixture, 'cmd-links'),
      targetDriverId: fixture.driverBId,
      targetRoutePlanId: fixture.routeBId,
      targetVehicleId: fixture.vehicleBId,
    });
    const receipt = await receiptFor(fixture, commandNames.reassign, 'cmd-links');
    const audits = await auditEventsForReceipt(fixture, result.receiptId);

    expect(receipt).toMatchObject({
      commandId: 'cmd-links',
      commandName: commandNames.reassign,
      nextRoutePlanId: result.routePlanId,
      nextRouteVersionId: result.newRouteVersionId,
      previousRoutePlanId: fixture.routeAId,
      previousRouteVersionId: fixture.versionAId,
      resultEntityId: fixture.orderAId,
      sellerOrderId: fixture.orderAId,
      status: 'SUCCEEDED',
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      commandReceiptId: result.receiptId,
      entityType: 'SellerOrder',
      nextRouteVersionId: result.newRouteVersionId,
      previousRouteVersionId: fixture.versionAId,
      redactionClass: 'STANDARD',
      requestId: 'request-cmd-links',
      sellerOrderId: fixture.orderAId,
    });
    expect(JSON.stringify(audits[0]?.redactedDiff)).not.toMatch(/recipient|phone|email|cookie|bearer|secret/iu);
  });

  test('reassigning customer A at a shared destination leaves customer B ownership untouched', async () => {
    const fixture = await createFixture(prisma, createdShopIds, 'shared-destination');
    const customerBMembershipsBefore = await routeMembershipsForOrder(fixture, fixture.orderBId);

    await fixture.service.reassign({
      ...adminCommand(fixture, 'cmd-shared-destination'),
      targetDriverId: fixture.driverBId,
      targetRoutePlanId: fixture.routeBId,
      targetVehicleId: fixture.vehicleBId,
    });

    await expect(routeMembershipsForOrder(fixture, fixture.orderBId)).resolves.toEqual(customerBMembershipsBefore);
    await expect(prisma.order.findUniqueOrThrow({ where: { id: fixture.orderBId } })).resolves.toMatchObject({
      customerId: fixture.customerBId,
      destinationId: fixture.destinationId,
    });
  });

  test('stale ETA for an older route version does not update the newer owner version', async () => {
    const fixture = await createFixture(prisma, createdShopIds, 'stale-eta');
    await fixture.service.reassign({
      ...adminCommand(fixture, 'cmd-stale-eta'),
      targetDriverId: fixture.driverBId,
      targetRoutePlanId: fixture.routeBId,
      targetVehicleId: fixture.vehicleBId,
    });
    const newerStop = await prisma.routePlanStop.findUniqueOrThrow({
      where: { routePlanId_deliveryStopId: { deliveryStopId: fixture.stopAId, routePlanId: fixture.routeBId } },
    });

    await prisma.routePlanStop.updateMany({
      data: {
        estimatedArrivalAt: new Date('2026-07-22T11:00:00.000Z'),
        etaCalculatedAt: new Date('2026-07-22T10:30:00.000Z'),
        etaInputRouteVersionId: fixture.versionAId,
        etaStatus: 'READY',
      },
      where: {
        deliveryStopId: fixture.stopAId,
        etaInputRouteVersionId: fixture.versionAId,
        routePlanId: fixture.routeBId,
      },
    });

    await expect(prisma.routePlanStop.findUniqueOrThrow({
      where: { id: newerStop.id },
    })).resolves.toMatchObject({
      etaInputRouteVersionId: newerStop.etaInputRouteVersionId,
      etaStatus: newerStop.etaStatus,
    });
  });

  test('invalidates ETA on every stop in affected source and target routes', async () => {
    const fixture = await createFixture(prisma, createdShopIds, 'eta-invalidate', { extraTargetOrder: true });

    await fixture.service.reassign({
      ...adminCommand(fixture, 'cmd-eta-invalidate'),
      targetDriverId: fixture.driverBId,
      targetRoutePlanId: fixture.routeBId,
      targetVehicleId: fixture.vehicleBId,
    });

    await expect(etaStatusesForRoutes(fixture, [fixture.routeAId, fixture.routeBId])).resolves.toEqual(['PENDING']);
  });

  test('uses production route grouping draft save and preserves only unaffected child versions during reassign', async () => {
    const fixture = await createFixture(prisma, createdShopIds, 'production-reassign');
    const sibling = await createUnaffectedSiblingRoute(fixture);
    const productionGroupingService = new PrismaRouteGroupingService(prismaWithDomainCompat(prisma), new FakeDriverPushProvider());
    const productionService = new DsvAssignmentCommandService(prismaWithDomainCompat(prisma), productionGroupingService);
    const saveDraftInTransaction = vi.spyOn(productionGroupingService, 'saveDraftInTransaction');
    const before = await productionSnapshot(fixture);
    const siblingBefore = await routeProductionSnapshot(fixture, sibling.routePlanId);

    const result = await productionService.reassign({
      ...adminCommand(fixture, 'cmd-production-reassign'),
      targetDriverId: fixture.driverBId,
      targetRoutePlanId: fixture.routeBId,
      targetSequence: 1,
      targetVehicleId: fixture.vehicleBId,
    });
    const after = await productionSnapshot(fixture);
    const siblingAfter = await routeProductionSnapshot(fixture, sibling.routePlanId);

    expect(saveDraftInTransaction).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      assignmentStatus: 'ASSIGNED',
      commandId: 'cmd-production-reassign',
      etaStatus: 'PENDING',
      routePlanId: fixture.routeBId,
      sellerOrderId: fixture.orderAId,
    });
    expect(result.previousRouteVersionId).toBe(before.routeA.child.id);
    expect(result.newRouteVersionId).toBe(after.routeB.child.id);
    expect(after.orderA.currentRouteVersionId).toBe(after.routeB.child.id);

    expect(after.routeA.child.id).not.toBe(before.routeA.child.id);
    expect(after.routeB.child.id).not.toBe(before.routeB.child.id);
    expect(after.routeA.child).toMatchObject({ status: 'CURRENT', supersededAt: null });
    expect(after.routeB.child).toMatchObject({ status: 'CURRENT', supersededAt: null });
    expect(siblingAfter.child).toEqual(siblingBefore.child);
    expect(siblingAfter.stops).toEqual(siblingBefore.stops);
    expect(siblingAfter.child).toMatchObject({
      id: siblingBefore.child.id,
      routePlanId: siblingBefore.child.routePlanId,
      status: 'CURRENT',
      supersededAt: null,
    });
    expect(after.orderB.currentRouteVersionId).toBe(before.orderB.currentRouteVersionId);
    await expect(currentOwnerVersionId(fixture, sibling.orderId)).resolves.toBe(siblingBefore.child.id);

    const previousRouteAChild = after.routeA.previousChildren.find((child) => child.id === before.routeA.child.id);
    const previousRouteBChild = after.routeB.previousChildren.find((child) => child.id === before.routeB.child.id);
    expect(previousRouteAChild).toEqual({
      ...before.routeA.child,
      status: 'ARCHIVED',
      supersededAt: anyDateMatcher,
    });
    expect(previousRouteBChild).toEqual({
      ...before.routeB.child,
      status: 'ARCHIVED',
      supersededAt: anyDateMatcher,
    });
    expect(previousRouteAChild?.snapshot).toEqual(before.routeA.child.snapshot);
    expect(previousRouteBChild?.snapshot).toEqual(before.routeB.child.snapshot);
    expect(after.routeA.stops.map((stop) => stop.deliveryStopId)).toEqual([fixture.stopBId]);
    expect(after.routeB.stops.map((stop) => stop.deliveryStopId)).toEqual([fixture.stopAId]);
    expect(after.orderAStop).toMatchObject(before.orderAStop);
    expect(after.orderBStop).toMatchObject(before.orderBStop);

    expect(after.routeA.stops).toEqual([{
      deliveryStopId: fixture.stopBId,
      estimatedArrivalAt: null,
      etaFailureCode: null,
      etaFailureMessage: null,
      etaInputRouteVersionId: after.routeA.child.id,
      etaSource: null,
      etaStatus: 'PENDING',
      routePlanId: fixture.routeAId,
      sequence: 1,
    }]);
    expect(after.routeB.stops).toEqual([{
      deliveryStopId: fixture.stopAId,
      estimatedArrivalAt: null,
      etaFailureCode: null,
      etaFailureMessage: null,
      etaInputRouteVersionId: after.routeB.child.id,
      etaSource: null,
      etaStatus: 'PENDING',
      routePlanId: fixture.routeBId,
      sequence: 1,
    }]);
    await expect(receiptCount(fixture, commandNames.reassign, 'cmd-production-reassign')).resolves.toBe(1);
    await expect(auditCount(fixture, result.receiptId)).resolves.toBe(1);
    await expect(activeOperationalOwnerCount(fixture, fixture.orderAId)).resolves.toBe(1);
  });
});

type Fixture = Awaited<ReturnType<typeof createFixture>>;

function readErrorCode(error: unknown): string {
  if (error === null || typeof error !== 'object' || !('code' in error)) return '';
  const { code } = error;
  return typeof code === 'string' ? code : '';
}

async function createFixture(
  prisma: PrismaClient,
  createdShopIds: string[],
  name: string,
  options: { extraTargetOrder?: boolean; failEtaAfterSave?: boolean; failNextSave?: boolean; initiallyUnassigned?: boolean; nullRouteOrder?: boolean } = {},
) {
  const unique = `${name}-${randomUUID()}`;
  const shopDomain = `g004-${unique}.example.test`;
  const shop = await prisma.shop.create({
    data: {
      appId: 'clever',
      shopDomain,
      shopifyShopGid: `gid://shopify/Shop/${unique}`,
    },
  });
  createdShopIds.push(shop.id);

  const [driverA, driverB, vehicleA, vehicleB, destination, customerA, customerB] = await Promise.all([
    prisma.driver.create({ data: { displayName: 'Driver A', shopId: shop.id, status: 'ACTIVE' } }),
    prisma.driver.create({ data: { displayName: 'Driver B', shopId: shop.id, status: 'ACTIVE' } }),
    prisma.vehicle.create({ data: { label: 'Vehicle A', licensePlate: `A-${unique}`, shopId: shop.id, status: 'ACTIVE' } }),
    prisma.vehicle.create({ data: { label: 'Vehicle B', licensePlate: `B-${unique}`, shopId: shop.id, status: 'ACTIVE' } }),
    prisma.deliveryCustomerProfile.create({
      data: {
        addressFingerprint: `fingerprint-${unique}`,
        normalizedAddress: { address1: '1 Shared Way', city: 'Seoul' },
        shopId: shop.id,
      },
    }),
    prisma.customer.create({
      data: {
        externalCustomerCode: `CUST-A-${unique}`,
        shopId: shop.id,
        sourceKind: 'DSV_DISPATCH_IMPORT',
        status: 'ACTIVE',
      },
    }),
    prisma.customer.create({
      data: {
        externalCustomerCode: `CUST-B-${unique}`,
        shopId: shop.id,
        sourceKind: 'DSV_DISPATCH_IMPORT',
        status: 'ACTIVE',
      },
    }),
  ]);

  const orderA = await createOrder(prisma, {
    customerId: customerA.id,
    destinationId: destination.id,
    name: '#A',
    sellerOrderKey: `SO-A-${unique}`,
    shopId: shop.id,
    shopifyOrderGid: `gid://shopify/Order/A-${unique}`,
  });
  const orderB = await createOrder(prisma, {
    customerId: customerB.id,
    destinationId: destination.id,
    name: '#B',
    sellerOrderKey: `SO-B-${unique}`,
    shopId: shop.id,
    shopifyOrderGid: `gid://shopify/Order/B-${unique}`,
  });
  const [stopA, stopB] = await Promise.all([
    createStop(prisma, shop.id, orderA.id, 'Recipient A'),
    createStop(prisma, shop.id, orderB.id, 'Recipient B'),
  ]);
  await prisma.dsvDispatchImport.create({
    data: {
      createdBy: 'g004-fixture',
      fileName: 'g004.csv',
      planDate: new Date('2026-07-22T00:00:00.000Z'),
      previewHash: `preview-${unique}`,
      rowCount: 1,
      shopId: shop.id,
      sourceHash: `source-${unique}`,
      sourceKind: 'CSV',
      status: 'APPLIED',
      rows: {
        create: {
          address: '1 Shared Way',
          conditionCode: '',
          customerId: customerA.id,
          customerCode: `CUST-A-${unique}`,
          deliveryStopId: stopA.id,
          destinationId: destination.id,
          destinationName: 'Shared Destination',
          diffKind: 'NEW',
          driverName: 'Driver A',
          issues: [],
          normalized: { sellerOrderKey: `SO-A-${unique}` },
          previewHash: `preview-${unique}`,
          rowNumber: 1,
          sellerOrderId: orderA.id,
          sellerOrderKey: `SO-A-${unique}`,
          shippedBoxes: 1,
          sourceHash: `row-${unique}`,
          status: 'APPLIED',
          vehiclePlate: `A-${unique}`,
        },
      },
    },
  });

  const grouping = await prisma.routeGrouping.create({
    data: {
      name: `G004 ${name}`,
      planDate: new Date('2026-07-22T00:00:00.000Z'),
      shopId: shop.id,
      status: 'READY',
    },
  });
  const groupingVersion = await prisma.routeGroupingVersion.create({
    data: {
      actor: 'g004-fixture',
      changeReason: 'fixture',
      groupingId: grouping.id,
      shopId: shop.id,
      status: 'CURRENT',
      version: 1,
    },
  });
  await Promise.all([
    prisma.routeGroupingOrder.create({
      data: {
        assignmentStatus: options.initiallyUnassigned === true ? 'UNASSIGNED' : 'ASSIGNED',
        assignedDriverId: options.initiallyUnassigned === true ? null : driverA.id,
        deliveryStopId: stopA.id,
        groupingId: grouping.id,
        orderId: orderA.id,
        shopId: shop.id,
        sourceSequence: 1,
      },
    }),
    prisma.routeGroupingOrder.create({
      data: {
        assignmentStatus: 'ASSIGNED',
        assignedDriverId: driverA.id,
        deliveryStopId: stopB.id,
        groupingId: grouping.id,
        orderId: orderB.id,
        shopId: shop.id,
        sourceSequence: 2,
      },
    }),
  ]);

  const routeA = await createRoute(prisma, shop.id, driverA.id, vehicleA.id, 'Route A');
  const routeB = await createRoute(prisma, shop.id, driverB.id, vehicleB.id, 'Route B');
  const routeUnassigned = await createRoute(prisma, shop.id, null, null, 'Unassigned');
  const state = {
    closedRouteIds: new Set<string>(),
    failEtaAfterSave: options.failEtaAfterSave === true,
    failNextSave: options.failNextSave === true,
    memberships: new Map<string, string[]>([
      [routeA.id, options.initiallyUnassigned === true ? [orderB.id] : [orderA.id, orderB.id]],
      [routeB.id, options.extraTargetOrder === true ? [orderB.id] : []],
      [routeUnassigned.id, options.initiallyUnassigned === true && options.nullRouteOrder !== true ? [orderA.id] : []],
    ]),
  };
  const versions = new Map<string, string>();
  for (const route of [routeA, routeB, routeUnassigned]) {
    const child = await createChildVersion(prisma, {
      driverId: route.driverId,
      groupingId: grouping.id,
      groupingVersionId: groupingVersion.id,
      orderIds: state.memberships.get(route.id) ?? [],
      routePlanId: route.id,
      shopId: shop.id,
      version: 1,
    });
    versions.set(route.id, child.id);
  }
  await rewriteRouteStorage(prisma, {
    groupingId: grouping.id,
    memberships: state.memberships,
    nullRouteOrderIds: options.nullRouteOrder === true ? new Set([orderA.id]) : new Set(),
    orderStops: new Map([[orderA.id, stopA.id], [orderB.id, stopB.id]]),
    shopId: shop.id,
    versions,
  });

  const harness = new DbRouteGroupingHarness({
    driverIds: new Map([[routeA.id, driverA.id], [routeB.id, driverB.id], [routeUnassigned.id, null]]),
    groupingId: grouping.id,
    orderStops: new Map([[orderA.id, stopA.id], [orderB.id, stopB.id]]),
    prisma,
    routeIds: [routeA.id, routeB.id, routeUnassigned.id],
    shopDomain,
    shopId: shop.id,
    state,
    vehicleIds: new Map([[routeA.id, vehicleA.id], [routeB.id, vehicleB.id], [routeUnassigned.id, null]]),
    versions,
  });
  const service = new DsvAssignmentCommandService(prismaWithDomainCompat(prisma), harness as unknown as RouteGroupingService);

  return {
    closeRoute: (routePlanId: string) => state.closedRouteIds.add(routePlanId),
    currentExpectedVersion: options.nullRouteOrder === true
      ? 'UNASSIGNED'
      : options.initiallyUnassigned === true
        ? versions.get(routeUnassigned.id) ?? ''
        : versions.get(routeA.id) ?? '',
    customerBId: customerB.id,
    destinationId: destination.id,
    driverAId: driverA.id,
    driverBId: driverB.id,
    forceDuplicateOwner: async () => {
      const duplicateVersion = await createChildVersion(prisma, {
        driverId: driverB.id,
        groupingId: grouping.id,
        groupingVersionId: groupingVersion.id,
        orderIds: [orderA.id],
        routePlanId: routeB.id,
        shopId: shop.id,
        version: 99,
      });
      versions.set(`${routeB.id}:duplicate`, duplicateVersion.id);
    },
    groupingId: grouping.id,
    groupingVersionId: groupingVersion.id,
    orderAId: orderA.id,
    orderBId: orderB.id,
    payloadHash: (commandName: string, input: unknown) => Promise.resolve(commandPayloadHash(commandName, input)),
    prisma,
    routeAId: routeA.id,
    routeBId: routeB.id,
    routeUnassignedId: routeUnassigned.id,
    service,
    shopDomain,
    shopId: shop.id,
    stopAId: stopA.id,
    stopBId: stopB.id,
    vehicleAId: vehicleA.id,
    vehicleBId: vehicleB.id,
    versionAId: versions.get(routeA.id) ?? '',
  };
}

type RouteGroupingHarnessDbClient = PrismaClient | DsvAssignmentTransactionClient;

class DbRouteGroupingHarness implements Pick<RouteGroupingService, 'getGrouping' | 'saveDraft'> {
  constructor(private readonly input: {
    driverIds: Map<string, string | null>;
    groupingId: string;
    orderStops: Map<string, string>;
    prisma: PrismaClient;
    routeIds: string[];
    shopDomain: string;
    shopId: string;
    state: { closedRouteIds: Set<string>; failEtaAfterSave: boolean; failNextSave: boolean; memberships: Map<string, string[]> };
    vehicleIds: Map<string, string | null>;
    versions: Map<string, string>;
  }) {}

  async getGrouping(): Promise<RouteGroupingDetailDto> {
    const grouping = await this.input.prisma.routeGrouping.findUniqueOrThrow({ where: { id: this.input.groupingId } });
    const orders = await this.input.prisma.order.findMany({
      include: { deliveryStops: true },
      orderBy: { name: 'asc' },
      where: { id: { in: [...this.input.orderStops.keys()] }, shopId: this.input.shopId },
    });
    return {
      assignments: orders.map((order, index) => ({
        addressLabel: typeof order.shippingAddress === 'string' ? order.shippingAddress : '',
        assignedDriverId: null,
        assignedPolygonId: null,
        assignmentStatus: 'ASSIGNED',
        coordinates: { latitude: null, longitude: null },
        deliveryStopId: this.input.orderStops.get(order.id) ?? order.deliveryStops[0]?.id ?? '',
        email: order.email,
        itemCount: 0,
        orderId: order.id,
        orderName: order.name,
        phone: order.phone,
        recipientName: order.name,
        sourceOrderId: order.sellerOrderKey ?? order.id,
        sourceSequence: index + 1,
      })),
      branches: [],
      children: [
        ...this.input.routeIds.map((routePlanId, index): RouteGroupingDetailDto['children'][number] => {
        const routeOrders = this.input.state.memberships.get(routePlanId) ?? [];
        const driverId = this.input.driverIds.get(routePlanId) ?? null;
        return {
          childVersion: 1,
          color: null,
          displayStatus: this.input.state.closedRouteIds.has(routePlanId) ? 'IN_PROGRESS' : 'READY',
          driverId,
          driverName: null,
          notificationStatus: 'NOT_REQUIRED',
          orderIds: routeOrders,
          routeGeometry: null,
          routeIdx: index + 1,
          routeMetrics: null,
          routePlan: {
            createdAt: '2026-07-22T09:00:00.000Z',
            depot: { latitude: null, longitude: null },
            deliveryAreas: [],
            deliveryDays: [],
            driver: null,
            driverId,
            id: routePlanId,
            itemSummary: {
              changedSincePublish: false,
              fingerprint: 'empty',
              itemTypes: 0,
              items: [],
              totalQuantity: 0,
            },
            missingCoordinates: 0,
            name: `Route ${index + 1}`,
            planDate: '2026-07-22',
            routeEndMode: 'RETURN_TO_DEPOT',
            status: 'READY',
            stopsCount: routeOrders.length,
            updatedAt: grouping.updatedAt.toISOString(),
          },
          routePlanId,
          routeStopPoints: [],
          sortOrder: index + 1,
          stops: [],
          stopsCount: routeOrders.length,
          updatedAt: grouping.updatedAt.toISOString(),
        };
      }),
      ...this.nullRouteChildren(),
      ],
      currentVersion: grouping.currentVersion,
      dateRangeEnd: '2026-07-22',
      dateRangeStart: '2026-07-22',
      displayStatus: 'READY',
      id: grouping.id,
      linkedInventoryId: null,
      name: grouping.name,
      planDate: '2026-07-22',
      polygons: [],
      status: grouping.status,
      switchRoutes: [],
      totalOrders: orders.length,
      unresolvedOrders: 0,
      updatedAt: grouping.updatedAt.toISOString(),
      warningState: [],
    };
  }

  private nullRouteChildren(): RouteGroupingDetailDto['children'] {
    const routedOrderIds = new Set([...this.input.state.memberships.values()].flat());
    const nullRouteOrderIds = [...this.input.orderStops.keys()].filter((orderId) => !routedOrderIds.has(orderId));
    if (nullRouteOrderIds.length === 0) return [];
    return [{
      childVersion: 1,
      color: null,
      displayStatus: 'READY',
      driverId: null,
      driverName: null,
      notificationStatus: 'NOT_REQUIRED',
      orderIds: nullRouteOrderIds,
      routeGeometry: null,
      routeIdx: null,
      routeMetrics: null,
      routePlan: null,
      routePlanId: null,
      routeStopPoints: [],
      sortOrder: this.input.routeIds.length + 1,
      stops: [],
      stopsCount: nullRouteOrderIds.length,
      updatedAt: new Date('2026-07-22T09:00:00.000Z').toISOString(),
    }];
  }

  async saveDraft(input: { routes: RouteGroupingDraftRouteInput[] }): Promise<RouteGroupingDetailDto> {
    return this.saveDraftWithClient(this.input.prisma, input);
  }

  async saveDraftInTransaction(
    tx: DsvAssignmentTransactionClient,
    input: { routes: RouteGroupingDraftRouteInput[] },
  ): Promise<RouteGroupingDetailDto> {
    return this.saveDraftWithClient(tx, input);
  }

  private async saveDraftWithClient(
    db: RouteGroupingHarnessDbClient,
    input: { routes: RouteGroupingDraftRouteInput[] },
  ): Promise<RouteGroupingDetailDto> {
    if (this.input.state.failNextSave) {
      this.input.state.failNextSave = false;
      throw new Error('forced route recalculation failure');
    }
    const affectedRouteIds = affectedRoutes(this.input.state.memberships, input.routes);
    this.input.state.memberships = new Map(input.routes.map((route) => [route.routePlanId ?? `temp-${randomUUID()}`, route.orderIds]));
    await rewriteRouteStorage(db, {
      groupingId: this.input.groupingId,
      memberships: this.input.state.memberships,
      orderStops: this.input.orderStops,
      shopId: this.input.shopId,
      updateCurrentRoutes: false,
      versions: this.input.versions,
    });
    await db.routeGrouping.update({
      data: { currentVersion: { increment: 1 } },
      where: { id: this.input.groupingId },
    });
    await db.routePlanStop.updateMany({
      data: this.input.state.failEtaAfterSave
        ? { etaFailureCode: 'ROUTE_RECALCULATION_FAILED', etaFailureMessage: 'forced ETA failure', etaStatus: 'FAILED' }
        : { estimatedArrivalAt: null, etaCalculatedAt: null, etaFailureCode: null, etaFailureMessage: null, etaStatus: 'PENDING' },
      where: { routePlanId: { in: [...affectedRouteIds] } },
    });
    return this.getGrouping();
  }
}

async function createOrder(prisma: PrismaClient, input: {
  customerId: string;
  destinationId: string;
  name: string;
  sellerOrderKey: string;
  shopId: string;
  shopifyOrderGid: string;
}) {
  return prisma.order.create({
    data: {
      customerId: input.customerId,
      destinationId: input.destinationId,
      name: input.name,
      rawPayload: {},
      sellerOrderKey: input.sellerOrderKey,
      sellerOrderSourceKind: 'DSV_DISPATCH_IMPORT',
      shopId: input.shopId,
      shopifyOrderGid: input.shopifyOrderGid,
      sourceOrderId: input.sellerOrderKey,
      sourcePlatform: 'SHOPIFY',
    },
  });
}

async function createStop(prisma: PrismaClient, shopId: string, orderId: string, recipientName: string) {
  return prisma.deliveryStop.create({
    data: {
      address1: '1 Shared Way',
      countryCode: 'KR',
      orderId,
      recipientName,
      shopId,
      status: 'PENDING',
    },
  });
}

async function createRoute(prisma: PrismaClient, shopId: string, driverId: string | null, vehicleId: string | null, name: string) {
  return prisma.routePlan.create({
    data: {
      constraints: {},
      driverId,
      metrics: {},
      name,
      optimizerVersion: 'g004-test',
      planDate: new Date('2026-07-22T00:00:00.000Z'),
      shopId,
      status: 'READY',
      vehicleId,
    },
  });
}

async function createChildVersion(prisma: PrismaClient, input: {
  driverId: string | null;
  groupingId: string;
  groupingVersionId: string;
  orderIds: string[];
  routePlanId: string;
  shopId: string;
  version: number;
}) {
  return prisma.routeGroupingChildVersion.create({
    data: {
      driverId: input.driverId,
      groupingId: input.groupingId,
      groupingVersionId: input.groupingVersionId,
      routePlanId: input.routePlanId,
      shopId: input.shopId,
      snapshot: { stops: input.orderIds.map((orderId, index) => ({ orderId, sequence: index + 1 })) },
      status: 'CURRENT',
      version: input.version,
    },
  });
}

async function rewriteRouteStorage(prisma: RouteGroupingHarnessDbClient, input: {
  groupingId: string;
  memberships: Map<string, string[]>;
  nullRouteOrderIds?: Set<string>;
  orderStops: Map<string, string>;
  shopId: string;
  updateCurrentRoutes?: boolean;
  versions: Map<string, string>;
}) {
  const routePlanIds = [...input.memberships.keys()].filter((routePlanId) => input.versions.has(routePlanId));
  await prisma.routePlanStop.deleteMany({ where: { routePlanId: { in: routePlanIds } } });
  for (const orderId of input.nullRouteOrderIds ?? []) {
    await prisma.order.update({
      data: { currentRouteVersionId: null },
      where: { id: orderId },
    });
  }
  for (const [routePlanId, orderIds] of input.memberships.entries()) {
    const versionId = input.versions.get(routePlanId);
    if (versionId === undefined) continue;
    if (versionId !== undefined) {
      await prisma.routeGroupingChildVersion.update({
        data: { snapshot: { stops: orderIds.map((orderId, index) => ({ orderId, sequence: index + 1 })) } },
        where: { id: versionId },
      });
    }
    for (const [index, orderId] of orderIds.entries()) {
      const deliveryStopId = input.orderStops.get(orderId);
      if (deliveryStopId === undefined) continue;
      await prisma.routePlanStop.create({
        data: {
          deliveryStopId,
          etaInputRouteVersionId: versionId ?? null,
          etaStatus: 'PENDING',
          routePlanId,
          shopId: input.shopId,
          sequence: index + 1,
        },
      });
      if (input.updateCurrentRoutes !== false) {
        await prisma.order.update({
          data: { currentRouteVersionId: versionId },
          where: { id: orderId },
        });
      }
    }
  }
}

function adminCommand(fixture: Fixture, commandId: string) {
  return {
    actor: {
      actorId: 'admin-g004',
      actorType: 'DSV_ADMIN' as const,
      principalType: 'DSV_ADMIN' as const,
      requestId: `request-${commandId}`,
    },
    commandId,
    expectedVersion: fixture.currentExpectedVersion,
    reason: 'g004 integration',
    sellerOrderId: fixture.orderAId,
    shopDomain: fixture.shopDomain,
  };
}

function driverCommand(fixture: Fixture, commandId: string) {
  return {
    accountId: 'account-g004',
    commandId,
    driverId: fixture.driverAId,
    expectedVersion: fixture.currentExpectedVersion,
    reason: 'g004 integration',
    routePlanId: fixture.routeAId,
    sellerOrderId: fixture.orderAId,
    shopDomain: fixture.shopDomain,
    shopId: fixture.shopId,
  };
}

async function activeOperationalOwnerCount(fixture: Fixture, orderId: string): Promise<number> {
  return (await currentOwnerVersionId(fixture, orderId)) === null ? 0 : 1;
}

async function currentOwnerVersionId(fixture: Fixture, orderId: string): Promise<string | null> {
  const order = await fixture.prisma.order.findUniqueOrThrow({
    select: { currentRouteVersionId: true },
    where: { id: orderId },
  });
  return order.currentRouteVersionId;
}

async function routeMembershipsForOrder(fixture: Fixture, orderId: string): Promise<string[]> {
  const rows = await fixture.prisma.routePlanStop.findMany({
    orderBy: { routePlanId: 'asc' },
    select: { routePlanId: true },
    where: { deliveryStop: { orderId }, routePlan: { shopId: fixture.shopId } },
  });
  return rows.map((row) => row.routePlanId);
}

function receiptCount(fixture: Fixture, commandName: string, commandId: string) {
  return fixture.prisma.dsvCommandReceipt.count({
    where: { commandId, commandName, shopId: fixture.shopId },
  });
}

function auditCount(fixture: Fixture, receiptId: string) {
  return fixture.prisma.dsvAuditEvent.count({
    where: { commandReceiptId: receiptId, shopId: fixture.shopId },
  });
}

function receiptFor(fixture: Fixture, commandName: string, commandId: string) {
  return fixture.prisma.dsvCommandReceipt.findUniqueOrThrow({
    where: { shopId_commandName_commandId: { commandId, commandName, shopId: fixture.shopId } },
  });
}

function auditEventsForReceipt(fixture: Fixture, receiptId: string) {
  return fixture.prisma.dsvAuditEvent.findMany({
    orderBy: { occurredAt: 'asc' },
    where: { commandReceiptId: receiptId, shopId: fixture.shopId },
  });
}

async function etaStatusesForRoutes(fixture: Fixture, routePlanIds: string[]): Promise<string[]> {
  const rows = await fixture.prisma.routePlanStop.findMany({
    distinct: ['etaStatus'],
    orderBy: { etaStatus: 'asc' },
    select: { etaStatus: true },
    where: { routePlanId: { in: routePlanIds } },
  });
  return rows.map((row) => row.etaStatus);
}

async function createUnaffectedSiblingRoute(fixture: Fixture) {
  const unique = randomUUID();
  const [driver, vehicle, customer, destination] = await Promise.all([
    fixture.prisma.driver.create({ data: { displayName: 'Driver C', shopId: fixture.shopId, status: 'ACTIVE' } }),
    fixture.prisma.vehicle.create({ data: { label: 'Vehicle C', licensePlate: `C-${unique}`, shopId: fixture.shopId, status: 'ACTIVE' } }),
    fixture.prisma.customer.create({
      data: {
        externalCustomerCode: `CUST-C-${unique}`,
        shopId: fixture.shopId,
        sourceKind: 'DSV_DISPATCH_IMPORT',
        status: 'ACTIVE',
      },
    }),
    fixture.prisma.deliveryCustomerProfile.create({
      data: {
        addressFingerprint: `fingerprint-c-${unique}`,
        normalizedAddress: { address1: '3 Sibling Way', city: 'Seoul' },
        shopId: fixture.shopId,
      },
    }),
  ]);
  const order = await createOrder(fixture.prisma, {
    customerId: customer.id,
    destinationId: destination.id,
    name: '#C',
    sellerOrderKey: `SO-C-${unique}`,
    shopId: fixture.shopId,
    shopifyOrderGid: `gid://shopify/Order/C-${unique}`,
  });
  const stop = await createStop(fixture.prisma, fixture.shopId, order.id, 'Recipient C');
  await fixture.prisma.routeGroupingOrder.create({
    data: {
      assignmentStatus: 'ASSIGNED',
      assignedDriverId: driver.id,
      deliveryStopId: stop.id,
      groupingId: fixture.groupingId,
      orderId: order.id,
      shopId: fixture.shopId,
      sourceSequence: 3,
    },
  });
  const route = await createRoute(fixture.prisma, fixture.shopId, driver.id, vehicle.id, 'Route C');
  const child = await createChildVersion(fixture.prisma, {
    driverId: driver.id,
    groupingId: fixture.groupingId,
    groupingVersionId: fixture.groupingVersionId,
    orderIds: [order.id],
    routePlanId: route.id,
    shopId: fixture.shopId,
    version: 1,
  });
  await fixture.prisma.routePlanStop.create({
    data: {
      deliveryStopId: stop.id,
      etaInputRouteVersionId: child.id,
      etaSource: 'ROUTE_CALCULATION',
      etaStatus: 'PENDING',
      routePlanId: route.id,
      shopId: fixture.shopId,
      sequence: 1,
    },
  });
  await fixture.prisma.order.update({
    data: { currentRouteVersionId: child.id },
    where: { id: order.id },
  });
  return { childId: child.id, orderId: order.id, routePlanId: route.id, stopId: stop.id };
}

async function productionSnapshot(fixture: Fixture) {
  const [routeA, routeB, unassigned, orderA, orderB, orderAStop, orderBStop] = await Promise.all([
    routeProductionSnapshot(fixture, fixture.routeAId),
    routeProductionSnapshot(fixture, fixture.routeBId),
    routeProductionSnapshot(fixture, fixture.routeUnassignedId),
    fixture.prisma.order.findUniqueOrThrow({
      select: { currentRouteVersionId: true },
      where: { id: fixture.orderAId },
    }),
    fixture.prisma.order.findUniqueOrThrow({
      select: { currentRouteVersionId: true },
      where: { id: fixture.orderBId },
    }),
    deliveryStopSnapshot(fixture, fixture.stopAId),
    deliveryStopSnapshot(fixture, fixture.stopBId),
  ]);
  return { orderA, orderAStop, orderB, orderBStop, routeA, routeB, unassigned };
}

async function routeProductionSnapshot(fixture: Fixture, routePlanId: string) {
  const children = await fixture.prisma.routeGroupingChildVersion.findMany({
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: {
      driverId: true,
      id: true,
      routePlanId: true,
      snapshot: true,
      status: true,
      supersededAt: true,
      version: true,
    },
    where: { routePlanId, shopId: fixture.shopId },
  });
  const current = children.find((child) => child.status === 'CURRENT' && child.supersededAt === null);
  if (current === undefined) throw new Error(`Missing current child version for route ${routePlanId}`);
  const stops = await fixture.prisma.routePlanStop.findMany({
    orderBy: { sequence: 'asc' },
    select: {
      deliveryStopId: true,
      estimatedArrivalAt: true,
      etaFailureCode: true,
      etaFailureMessage: true,
      etaInputRouteVersionId: true,
      etaSource: true,
      etaStatus: true,
      routePlanId: true,
      sequence: true,
    },
    where: { routePlanId },
  });
  return {
    child: current,
    previousChildren: children.filter((child) => child.id !== current.id),
    stops,
  };
}

function deliveryStopSnapshot(fixture: Fixture, deliveryStopId: string) {
  return fixture.prisma.deliveryStop.findUniqueOrThrow({
    select: {
      address1: true,
      countryCode: true,
      id: true,
      orderId: true,
      recipientName: true,
      shopId: true,
      status: true,
    },
    where: { id: deliveryStopId },
  });
}

function affectedRoutes(
  previous: Map<string, string[]>,
  nextRoutes: RouteGroupingDraftRouteInput[],
): Set<string> {
  const affected = new Set<string>();
  const next = new Map(nextRoutes.map((route) => [route.routePlanId ?? '', route.orderIds]));
  for (const [routePlanId, previousOrderIds] of previous.entries()) {
    const nextOrderIds = next.get(routePlanId) ?? [];
    if (previousOrderIds.join('\0') !== nextOrderIds.join('\0')) affected.add(routePlanId);
  }
  for (const [routePlanId, nextOrderIds] of next.entries()) {
    const previousOrderIds = previous.get(routePlanId) ?? [];
    if (previousOrderIds.join('\0') !== nextOrderIds.join('\0')) affected.add(routePlanId);
  }
  affected.delete('');
  return affected;
}

async function canonicalCounts(prisma: PrismaClient, shopId: string) {
  const [
    audits,
    deliveryStops,
    orders,
    receipts,
    routeGroupingOrders,
    routePlanStops,
    routePlans,
    routeVersions,
  ] = await Promise.all([
    prisma.dsvAuditEvent.count({ where: { shopId } }),
    prisma.deliveryStop.count({ where: { shopId } }),
    prisma.order.count({ where: { shopId } }),
    prisma.dsvCommandReceipt.count({ where: { shopId } }),
    prisma.routeGroupingOrder.count({ where: { shopId } }),
    prisma.routePlanStop.count({ where: { routePlan: { shopId } } }),
    prisma.routePlan.count({ where: { shopId } }),
    prisma.routeGroupingChildVersion.count({ where: { shopId } }),
  ]);
  return { audits, deliveryStops, orders, receipts, routeGroupingOrders, routePlanStops, routePlans, routeVersions };
}

function prismaWithDomainCompat(prisma: PrismaClient): PrismaClient {
  return new Proxy(prisma, {
    get(target, property, receiver): unknown {
      if (property !== 'shop') return Reflect.get(target, property, receiver) as unknown;
      const shopDelegate = target.shop;
      return {
        ...shopDelegate,
        findUnique(input: Prisma.ShopFindUniqueArgs) {
          const maybeDomain = (input.where as { domain?: string }).domain;
          if (maybeDomain === undefined) return shopDelegate.findUnique(input);
          return shopDelegate.findUnique({
            ...input,
            where: { appId_shopDomain: { appId: 'clever', shopDomain: maybeDomain } },
          });
        },
      };
    },
  });
}

function commandPayloadHash(commandName: string, input: unknown): string {
  return createHash('sha256').update(canonicalJson({ commandName, input: stableAssignmentInput(input) })).digest('hex');
}

function stableAssignmentInput(input: unknown): unknown {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return input;
  const record = input as Record<string, unknown>;
  const actor = record.actor;
  return {
    ...record,
    actor: actor !== null && typeof actor === 'object' && !Array.isArray(actor)
      ? Object.fromEntries(Object.entries(actor as Record<string, unknown>).filter(([key]) => key !== 'requestId'))
      : actor,
  };
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortJson);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJson(entry)]),
  );
}
