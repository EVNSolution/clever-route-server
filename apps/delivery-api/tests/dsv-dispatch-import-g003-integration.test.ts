import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import {
  DsvDispatchImportApplyError,
  type DsvDispatchImportInput,
  PrismaDsvDispatchImportService,
} from '../src/modules/dsv/dsv-dispatch-import.service.js';
import { sha256CanonicalJson } from '../src/modules/dsv/dsv-dispatch-preview-diff.js';

const safeTargetClass = 'safe-local-g003-temp-cluster';
const databaseUrl = process.env.DATABASE_URL ?? '';
const isSafeDisposableTarget = process.env.G003_DATABASE_TARGET_CLASS === safeTargetClass
  && /^postgresql:\/\/clever_g003:clever_g003@127\.0\.0\.1:55433\/clever_g003(?:\?|$)/u.test(databaseUrl);

const describeDisposable = isSafeDisposableTarget ? describe.sequential : describe.skip;

describeDisposable('G003 DSV dispatch import DB integration', () => {
  const prisma = new PrismaClient();
  const createdShopIds: string[] = [];

  beforeAll(async () => {
    expect(isSafeDisposableTarget).toBe(true);
    await prisma.$connect();
  });

  afterAll(async () => {
    for (const shopId of createdShopIds.reverse()) {
      await prisma.shop.deleteMany({ where: { id: shopId } });
    }
    await prisma.$disconnect();
  });

  test('stages an immutable import without canonical order, stop, or route writes', async () => {
    const fixture = await createFixture(prisma, createdShopIds, 'stage');
    const service = new PrismaDsvDispatchImportService(prisma);
    const countsBefore = await canonicalCounts(prisma, fixture.shopId);

    const staged = await service.commit({ ...fixture.input, actor: 'g003-test', shopDomain: fixture.shopDomain });

    expect(staged.status).toBe('READY');
    expect(staged.sourceHash).toBeTruthy();
    expect(staged.previewHash).toBeTruthy();
    expect(staged.rows).toHaveLength(1);
    expect(staged.rows[0]?.normalized).toMatchObject({ sellerOrderKey: fixture.sellerOrderKey });
    await expect(canonicalCounts(prisma, fixture.shopId)).resolves.toEqual(countsBefore);
  });

  test('allows the same seller order key in a later import history batch', async () => {
    const fixture = await createFixture(prisma, createdShopIds, 'history');
    const service = new PrismaDsvDispatchImportService(prisma);

    const first = await service.commit({ ...fixture.input, actor: 'g003-test', shopDomain: fixture.shopDomain });
    const second = await service.commit({ ...fixture.input, actor: 'g003-test', shopDomain: fixture.shopDomain });

    expect(second.id).not.toBe(first.id);
    await expect(prisma.dsvDispatchImportRow.count({
      where: { sellerOrderKey: fixture.sellerOrderKey, shopId: fixture.shopId },
    })).resolves.toBe(2);
  });

  test('links a staged condition candidate to its raw and normalized provenance', async () => {
    const fixture = await createFixture(prisma, createdShopIds, 'candidate-provenance');
    const service = new PrismaDsvDispatchImportService(prisma);
    const rawCondition = '  ts03  ';
    const staged = await service.commit({
      ...fixture.input,
      actor: 'g003-test',
      rows: fixture.input.rows.map((row) => ({ ...row, conditionCode: rawCondition })),
      shopDomain: fixture.shopDomain,
    });
    const row = await prisma.dsvDispatchImportRow.findUniqueOrThrow({
      where: { importId_rowNumber: { importId: staged.id, rowNumber: 2 } },
    });
    const candidate = await prisma.dsvTransportCondition.findUniqueOrThrow({
      where: { shopId_comparisonKey: { comparisonKey: 'TS03', shopId: fixture.shopId } },
    });

    expect(staged.status).toBe('NEEDS_REVIEW');
    expect(row).toMatchObject({
      conditionCode: rawCondition,
      conditionId: candidate.id,
      importId: staged.id,
      rowNumber: 2,
    });
    expect(row.normalized).toMatchObject({ conditionComparisonKey: 'TS03' });
    expect(candidate).toMatchObject({
      comparisonKey: 'TS03',
      rawValue: rawCondition,
      status: 'CANDIDATE',
    });
  });

  test('promotes a condition candidate transactionally with creator and source audit provenance', async () => {
    const fixture = await createFixture(prisma, createdShopIds, 'candidate-activation');
    const service = new PrismaDsvDispatchImportService(prisma);
    const rawCondition = '  ts04  ';
    const staged = await service.commit({
      ...fixture.input,
      actor: 'candidate-importer',
      rows: fixture.input.rows.map((row) => ({ ...row, conditionCode: rawCondition })),
      shopDomain: fixture.shopDomain,
    });
    const candidateBefore = await prisma.dsvTransportCondition.findUniqueOrThrow({
      where: { shopId_comparisonKey: { comparisonKey: 'TS04', shopId: fixture.shopId } },
    });

    const activated = await service.createCondition({
      actor: 'condition-admin',
      code: 'ts04',
      description: 'Activated standard',
      name: 'Condition TS04',
      principal: {
        actorId: 'condition-admin-id',
        actorType: 'DSV_ADMIN',
        principalType: 'DSV_ADMIN',
        requestId: 'req-condition-ts04',
      },
      shopDomain: fixture.shopDomain,
    });
    const candidateAfter = await prisma.dsvTransportCondition.findUniqueOrThrow({
      where: { id: candidateBefore.id },
    });
    const audits = await prisma.dsvAuditEvent.findMany({
      where: {
        entityId: candidateBefore.id,
        eventType: 'activateDsvTransportCondition',
        shopId: fixture.shopId,
      },
    });

    expect(activated).toMatchObject({ id: candidateBefore.id, status: 'ACTIVE' });
    expect(candidateAfter).toMatchObject({
      comparisonKey: 'TS04',
      createdBy: 'candidate-importer',
      description: 'Activated standard',
      name: 'Condition TS04',
      rawValue: rawCondition,
      status: 'ACTIVE',
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorId: 'condition-admin-id',
      actorType: 'DSV_ADMIN',
      entityId: candidateBefore.id,
      entityType: 'DsvTransportCondition',
      importId: staged.id,
      principalType: 'DSV_ADMIN',
      requestId: 'req-condition-ts04',
      redactedDiff: {
        comparisonKey: 'TS04',
        conditionId: candidateBefore.id,
        nextStatus: 'ACTIVE',
        previousStatus: 'CANDIDATE',
        sourceRows: [{ importId: staged.id, rowNumber: 2 }],
      },
    });
  });

  test('promotes a legacy seeded condition that has no comparison key', async () => {
    const fixture = await createFixture(prisma, createdShopIds, 'legacy-condition-activation');
    const service = new PrismaDsvDispatchImportService(prisma);
    const legacy = await prisma.dsvTransportCondition.create({
      data: {
        code: 'AMBIENT',
        createdBy: 'legacy-demo-seed',
        description: 'Legacy description',
        name: 'Legacy ambient',
        shopId: fixture.shopId,
      },
    });

    const activated = await service.createCondition({
      actor: 'condition-admin',
      code: 'Ambient',
      description: '상온 조건으로 운송합니다.',
      name: '상온 운송',
      shopDomain: fixture.shopDomain,
    });
    const stored = await prisma.dsvTransportCondition.findUniqueOrThrow({
      where: { id: legacy.id },
    });

    expect(activated).toMatchObject({ id: legacy.id, status: 'ACTIVE' });
    expect(stored).toMatchObject({
      code: 'AMBIENT',
      comparisonKey: 'AMBIENT',
      description: '상온 조건으로 운송합니다.',
      name: '상온 운송',
      rawValue: 'Ambient',
      status: 'ACTIVE',
    });
  });

  test('applies a staged import into one customer, destination, order, stop, and row link set', async () => {
    const fixture = await createFixture(prisma, createdShopIds, 'apply');
    const service = new PrismaDsvDispatchImportService(prisma);
    const staged = await service.commit({ ...fixture.input, actor: 'g003-test', shopDomain: fixture.shopDomain });

    const result = await service.apply(applyInput(fixture.shopDomain, staged.id, staged.sourceHash ?? '', 'cmd-apply'));
    const row = await prisma.dsvDispatchImportRow.findFirstOrThrow({ where: { importId: staged.id } });

    expect(result.summary).toEqual({ appliedRows: 1, newRows: 1, noOpRows: 0, updatedRows: 0 });
    await expect(canonicalCounts(prisma, fixture.shopId)).resolves.toMatchObject({
      customers: 1,
      deliveryStops: 1,
      destinations: 1,
      orders: 1,
      routeGroupingOrders: 1,
      routePlanStops: 0,
      routePlans: 0,
    });
    expect(row.status).toBe('APPLIED');
    expect(row.customerId).toBe(result.rows[0]?.customerId);
    expect(row.destinationId).toBe(result.rows[0]?.destinationId);
    expect(row.sellerOrderId).toBe(result.rows[0]?.sellerOrderId);
    expect(row.deliveryStopId).toBe(result.rows[0]?.deliveryStopId);
    expect(row.applyReceiptId).toBe(result.receiptId);
    await expect(prisma.order.findUniqueOrThrow({ where: { id_shopId: { id: result.rows[0]?.sellerOrderId ?? '', shopId: fixture.shopId } } }))
      .resolves.toMatchObject({
        sellerOrderKey: fixture.sellerOrderKey,
        serviceDate: new Date('2026-07-22T00:00:00.000Z'),
        shopifyOrderGid: `dsv:DSV_DISPATCH_IMPORT:2026-07-22:${fixture.sellerOrderKey}`,
        sourceOrderId: `2026-07-22:${fixture.sellerOrderKey}`,
        sourceOrderNumber: fixture.sellerOrderKey,
      });
  });

  test('assigns an imported order to the registered driver named in the file', async () => {
    const fixture = await createFixture(prisma, createdShopIds, 'driver-name-assignment');
    const service = new PrismaDsvDispatchImportService(prisma);
    const firstRow = fixture.input.rows[0];
    if (firstRow === undefined) throw new Error('Missing fixture row');
    const input = {
      ...fixture.input,
      rows: [{ ...firstRow, driverName: 'Driver One', vehiclePlate: '' }],
    };

    const staged = await service.commit({ ...input, actor: 'g003-test', shopDomain: fixture.shopDomain });
    const result = await service.apply(applyInput(
      fixture.shopDomain,
      staged.id,
      staged.sourceHash ?? '',
      'cmd-driver-name-assignment',
    ));
    const appliedRow = result.rows[0];
    if (appliedRow === undefined) throw new Error('Missing applied row');
    const order = await prisma.order.findUniqueOrThrow({
      include: { currentRouteVersion: { include: { routePlan: true } } },
      where: { id: appliedRow.sellerOrderId },
    });

    expect(staged.rows[0]).toMatchObject({ driverId: fixture.driverId, vehicleId: fixture.vehicleId });
    expect(order.currentRouteVersion).toMatchObject({ driverId: fixture.driverId });
    expect(order.currentRouteVersion?.routePlan).toMatchObject({
      driverId: fixture.driverId,
      vehicleId: fixture.vehicleId,
    });
    await expect(canonicalCounts(prisma, fixture.shopId)).resolves.toMatchObject({
      routeGroupingOrders: 1,
      routePlanStops: 1,
      routePlans: 1,
    });
  });

  test('applies geocoded rows after coordinates are normalized to database precision', async () => {
    const fixture = await createFixture(prisma, createdShopIds, 'apply-geocoded-precision');
    const service = new PrismaDsvDispatchImportService(prisma, {
      addressCanonicalizer: {
        resolve: ({ address }) => Promise.resolve({
          address: '서울특별시 강남구 테헤란로 152',
          detailAddress: null,
          jibunAddress: '서울특별시 강남구 역삼동 737',
          latitude: 37.500643012345,
          longitude: 127.036545098765,
          postalCode: '06236',
          rawAddress: address,
          status: 'RESOLVED',
        }),
      },
    });
    const input = {
      ...fixture.input,
      rows: fixture.input.rows.map((row) => ({ ...row, latitude: null, longitude: null })),
    };

    const staged = await service.commit({ ...input, actor: 'g003-test', shopDomain: fixture.shopDomain });
    const result = await service.apply(applyInput(
      fixture.shopDomain,
      staged.id,
      staged.sourceHash ?? '',
      'cmd-apply-geocoded-precision',
    ));

    expect(staged.rows[0]).toMatchObject({ latitude: 37.500643, longitude: 127.0365451 });
    expect(result.summary).toEqual({ appliedRows: 1, newRows: 1, noOpRows: 0, updatedRows: 0 });
  });

  test('applies a same-date update candidate and invalidates READY route projections in place', async () => {
    const fixture = await createFixture(prisma, createdShopIds, 'update-candidate');
    const service = new PrismaDsvDispatchImportService(prisma);
    const firstStage = await service.commit({ ...fixture.input, actor: 'g003-test', shopDomain: fixture.shopDomain });
    const firstApply = await service.apply(applyInput(
      fixture.shopDomain,
      firstStage.id,
      firstStage.sourceHash ?? '',
      'cmd-update-candidate-first',
    ));
    const firstCanonical = firstApply.rows[0];
    if (firstCanonical === undefined) throw new Error('Missing first canonical row');
    const readyRoute = await createReadyPredepartureRoutePlan(prisma, {
      deliveryStopId: firstCanonical.deliveryStopId,
      driverId: fixture.driverId,
      orderId: firstCanonical.sellerOrderId,
      shopId: fixture.shopId,
      vehicleId: fixture.vehicleId,
    });
    const firstRow = fixture.input.rows[0];
    if (firstRow === undefined) throw new Error('Missing fixture row');
    const updatedInput: DsvDispatchImportInput = {
      ...fixture.input,
      rows: [{
        ...firstRow,
        address: '456 Updated Integration Road',
        customerCode: 'CUST-G003-UPDATED',
        destinationName: 'Updated Integration Destination',
        latitude: 37.6001,
        longitude: 127.1002,
        notes: 'Updated dock note',
        shippedBoxes: 7,
      }],
    };

    const previewUpdate = await service.preview({ ...updatedInput, shopDomain: fixture.shopDomain });
    const stagedUpdate = await service.commit({ ...updatedInput, actor: 'g003-test', shopDomain: fixture.shopDomain });
    const result = await service.apply(applyInput(
      fixture.shopDomain,
      stagedUpdate.id,
      stagedUpdate.sourceHash ?? '',
      'cmd-update-candidate-second',
    ));
    const order = await prisma.order.findUniqueOrThrow({
      include: { customer: true, deliveryStops: true, destination: true },
      where: { id: firstCanonical.sellerOrderId },
    });
    const groupingRow = await prisma.routeGroupingOrder.findFirstOrThrow({
      include: { grouping: true },
      where: { orderId: order.id, shopId: fixture.shopId },
    });
    const routePlan = await prisma.routePlan.findUniqueOrThrow({ where: { id: readyRoute.routePlanId } });
    const routePlanStop = await prisma.routePlanStop.findUniqueOrThrow({
      where: {
        routePlanId_deliveryStopId: {
          deliveryStopId: firstCanonical.deliveryStopId,
          routePlanId: readyRoute.routePlanId,
        },
      },
    });

    expect(previewUpdate.rows[0]).toMatchObject({ diffKind: 'UPDATE_CANDIDATE', status: 'READY' });
    expect(stagedUpdate).toMatchObject({ status: 'READY' });
    expect(stagedUpdate.rows[0]).toMatchObject({ diffKind: 'UPDATE_CANDIDATE', status: 'READY' });
    expect(result.summary).toEqual({ appliedRows: 1, newRows: 0, noOpRows: 0, updatedRows: 1 });
    expect(result.rows[0]).toMatchObject({
      outcome: 'UPDATE_CANDIDATE',
      sellerOrderId: firstCanonical.sellerOrderId,
    });
    expect(order.customer?.externalCustomerCode).toBe('CUST-G003-UPDATED');
    expect(order.destination?.canonicalName).toBe('Updated Integration Destination');
    expect(order.deliveryStops[0]).toMatchObject({
      address1: '456 Updated Integration Road',
      instructions: 'Updated dock note',
      recipientName: 'Updated Integration Destination',
      status: 'PENDING',
    });
    expect(order.serviceDate?.toISOString().slice(0, 10)).toBe('2026-07-22');
    expect(order.deliveryStops[0]?.deliveryDate?.toISOString().slice(0, 10)).toBe('2026-07-22');
    expect(groupingRow.assignmentStatus).toBe('UNASSIGNED');
    expect(groupingRow.deliveryStopId).toBe(firstCanonical.deliveryStopId);
    expect(groupingRow.groupingId).toBe(readyRoute.groupingId);
    expect(groupingRow.grouping.planDate.toISOString().slice(0, 10)).toBe('2026-07-22');
    expect(routePlan.planDate.toISOString().slice(0, 10)).toBe('2026-07-22');
    expect(routePlanStop).toMatchObject({
      distanceFromPreviousMeters: null,
      durationFromPreviousSeconds: null,
      estimatedArrivalAt: null,
      etaCalculatedAt: null,
      etaFailureCode: null,
      etaFailureMessage: null,
      etaInputRouteVersionId: null,
      etaSource: null,
      etaStatus: 'NOT_REQUIRED',
    });
    await expect(prisma.routePlanGeometryCache.count({ where: { routePlanId: readyRoute.routePlanId } })).resolves.toBe(0);
    await expect(canonicalCounts(prisma, fixture.shopId)).resolves.toMatchObject({
      customers: 2,
      deliveryStops: 1,
      destinations: 2,
      orders: 1,
      routeGroupingOrders: 1,
      routePlanStops: 1,
      routePlans: 1,
    });
  });

  test('creates a separate canonical order for the same seller key on a different plan date', async () => {
    const fixture = await createFixture(prisma, createdShopIds, 'dated-identity');
    const service = new PrismaDsvDispatchImportService(prisma);
    const firstStage = await service.commit({ ...fixture.input, actor: 'g003-test', shopDomain: fixture.shopDomain });
    const firstApply = await service.apply(applyInput(
      fixture.shopDomain,
      firstStage.id,
      firstStage.sourceHash ?? '',
      'cmd-dated-identity-first',
    ));
    const firstRow = fixture.input.rows[0];
    if (firstRow === undefined) throw new Error('Missing fixture row');

    const nextDateInput: DsvDispatchImportInput = {
      ...fixture.input,
      planDate: '2026-07-23',
      rows: [{ ...firstRow, rowNumber: 2 }],
    };
    const preview = await service.preview({ ...nextDateInput, shopDomain: fixture.shopDomain });
    const staged = await service.commit({ ...nextDateInput, actor: 'g003-test', shopDomain: fixture.shopDomain });
    const result = await service.apply(applyInput(
      fixture.shopDomain,
      staged.id,
      staged.sourceHash ?? '',
      'cmd-dated-identity-second',
    ));

    expect(preview.rows[0]).toMatchObject({ diffKind: 'NEW', sellerOrderId: null, status: 'READY' });
    expect(staged.rows[0]).toMatchObject({ diffKind: 'NEW', sellerOrderId: null, status: 'READY' });
    expect(result.summary).toEqual({ appliedRows: 1, newRows: 1, noOpRows: 0, updatedRows: 0 });
    expect(result.rows[0]).toMatchObject({ outcome: 'NEW', sellerOrderKey: fixture.sellerOrderKey });
    expect(result.rows[0]?.sellerOrderId).not.toBe(firstApply.rows[0]?.sellerOrderId);
    const orders = await prisma.order.findMany({
      orderBy: { serviceDate: 'asc' },
      where: {
        sellerOrderKey: fixture.sellerOrderKey,
        sellerOrderSourceKind: 'DSV_DISPATCH_IMPORT',
        shopId: fixture.shopId,
      },
    });
    expect(orders.map((order) => order.serviceDate?.toISOString().slice(0, 10))).toEqual(['2026-07-22', '2026-07-23']);
    expect(orders.map((order) => order.sourceOrderId)).toEqual([
      `2026-07-22:${fixture.sellerOrderKey}`,
      `2026-07-23:${fixture.sellerOrderKey}`,
    ]);
    expect(orders.map((order) => order.sourceOrderNumber)).toEqual([fixture.sellerOrderKey, fixture.sellerOrderKey]);
  });

  test('keeps manual READY route ownership active for update candidates', async () => {
    const fixture = await createFixture(prisma, createdShopIds, 'manual-ready-owner');
    const service = new PrismaDsvDispatchImportService(prisma);
    const firstStage = await service.commit({ ...fixture.input, actor: 'g003-test', shopDomain: fixture.shopDomain });
    const firstApply = await service.apply(applyInput(
      fixture.shopDomain,
      firstStage.id,
      firstStage.sourceHash ?? '',
      'cmd-manual-ready-owner-first',
    ));
    const firstCanonical = firstApply.rows[0];
    const firstRow = fixture.input.rows[0];
    if (firstCanonical === undefined || firstRow === undefined) throw new Error('Missing fixture row');
    await createManualReadyRoutePlan(prisma, {
      deliveryStopId: firstCanonical.deliveryStopId,
      driverId: fixture.driverId,
      shopId: fixture.shopId,
      vehicleId: fixture.vehicleId,
    });

    const preview = await service.preview({
      ...fixture.input,
      rows: [{ ...firstRow, address: '789 Manual Ready Road' }],
      shopDomain: fixture.shopDomain,
    });

    expect(preview.canApply).toBe(false);
    expect(preview.rows[0]).toMatchObject({ diffKind: 'CONFLICT', status: 'NEEDS_REVIEW' });
    expect(preview.rows[0]?.issues).toContainEqual(expect.objectContaining({ code: 'CANONICAL_ORDER_ACTIVE_OWNERSHIP' }));
  });

  test('rejects an update candidate when the canonical stop leaves pending before apply', async () => {
    const fixture = await createFixture(prisma, createdShopIds, 'stop-status-race');
    const service = new PrismaDsvDispatchImportService(prisma);
    const firstStage = await service.commit({ ...fixture.input, actor: 'g003-test', shopDomain: fixture.shopDomain });
    const firstApply = await service.apply(applyInput(
      fixture.shopDomain,
      firstStage.id,
      firstStage.sourceHash ?? '',
      'cmd-stop-status-race-first',
    ));
    const firstCanonical = firstApply.rows[0];
    const firstRow = fixture.input.rows[0];
    if (firstCanonical === undefined || firstRow === undefined) throw new Error('Missing fixture row');
    const stagedUpdate = await service.commit({
      ...fixture.input,
      rows: [{ ...firstRow, address: '321 Arrived Stop Road' }],
      actor: 'g003-test',
      shopDomain: fixture.shopDomain,
    });
    await prisma.deliveryStop.update({
      data: { status: 'ARRIVED' },
      where: { id_shopId: { id: firstCanonical.deliveryStopId, shopId: fixture.shopId } },
    });

    await expect(service.apply(applyInput(
      fixture.shopDomain,
      stagedUpdate.id,
      stagedUpdate.sourceHash ?? '',
      'cmd-stop-status-race-second',
    ))).rejects.toMatchObject({ code: 'DISPATCH_IMPORT_PREVIEW_STALE' } satisfies Partial<DsvDispatchImportApplyError>);
  });

  test('applies and replays a valid 500-row max batch within the transaction budget', async () => {
    const fixture = await createFixture(prisma, createdShopIds, 'max-batch');
    const service = new PrismaDsvDispatchImportService(prisma);
    const firstRow = fixture.input.rows[0];
    if (firstRow === undefined) throw new Error('Missing fixture row');
    const rows = Array.from({ length: 500 }, (_, index) => ({
      ...firstRow,
      address: `${index + 1} Max Batch Road`,
      customerCode: `CUST-G003-MAX-${index + 1}`,
      destinationName: `Max Batch Destination ${index + 1}`,
      rowNumber: index + 2,
      sellerOrderKey: `${fixture.sellerOrderKey}-${index + 1}`,
    }));
    const staged = await service.commit({
      ...fixture.input,
      actor: 'g003-test',
      rows,
      shopDomain: fixture.shopDomain,
    });
    const input = applyInput(fixture.shopDomain, staged.id, staged.sourceHash ?? '', 'cmd-max-batch');

    const applyStartedAt = performance.now();
    const result = await service.apply(input);
    const applyElapsedMs = performance.now() - applyStartedAt;
    const replayStartedAt = performance.now();
    const replay = await service.apply(input);
    const replayElapsedMs = performance.now() - replayStartedAt;

    console.info(`[G003 max batch] apply=${applyElapsedMs.toFixed(1)}ms replay=${replayElapsedMs.toFixed(1)}ms`);
    expect(result.summary).toEqual({ appliedRows: 500, newRows: 500, noOpRows: 0, updatedRows: 0 });
    expect(result.rows).toHaveLength(500);
    expect(replay).toEqual(result);
    expect(applyElapsedMs).toBeLessThan(120_000);
    await expect(prisma.dsvCommandReceipt.count({
      where: { commandId: input.commandId, commandName: 'applyDispatchImport', shopId: fixture.shopId },
    })).resolves.toBe(1);
    await expect(prisma.dsvAuditEvent.count({
      where: { commandReceipt: { commandId: input.commandId }, eventType: 'applyDispatchImport', shopId: fixture.shopId },
    })).resolves.toBe(1);
    await expect(prisma.dsvDispatchImport.findUniqueOrThrow({ where: { id: staged.id } })).resolves.toMatchObject({
      failureCode: null,
      failureMessage: null,
      status: 'APPLIED',
    });
    await expect(canonicalCounts(prisma, fixture.shopId)).resolves.toEqual({
      customers: 500,
      deliveryStops: 500,
      destinations: 500,
      orders: 500,
      routeGroupingOrders: 500,
      routePlanStops: 0,
      routePlans: 0,
    });
  }, 150_000);

  test('maps transaction timeout to a stable failed receipt and replays without partial writes', async () => {
    const fixture = await createFixture(prisma, createdShopIds, 'transaction-timeout');
    const service = new PrismaDsvDispatchImportService(prisma, {
      applyTransactionTimeoutMs: 250,
      delayAfterCanonicalRowsMs: 500,
    });
    const staged = await service.commit({ ...fixture.input, actor: 'g003-test', shopDomain: fixture.shopDomain });
    const input = applyInput(fixture.shopDomain, staged.id, staged.sourceHash ?? '', 'cmd-transaction-timeout');

    const failureStartedAt = performance.now();
    await expect(service.apply(input)).rejects.toMatchObject({
      code: 'DISPATCH_IMPORT_CANONICAL_CONFLICT',
    } satisfies Partial<DsvDispatchImportApplyError>);
    const failureElapsedMs = performance.now() - failureStartedAt;
    const receiptBeforeReplay = await prisma.dsvCommandReceipt.findUniqueOrThrow({
      where: {
        shopId_commandName_commandId: {
          commandId: input.commandId,
          commandName: 'applyDispatchImport',
          shopId: fixture.shopId,
        },
      },
    });
    expect(receiptBeforeReplay).toMatchObject({ responseStatus: 422, status: 'FAILED' });
    expect(JSON.parse(receiptBeforeReplay.responseBodyRef ?? 'null')).toEqual({
      code: 'DISPATCH_IMPORT_CANONICAL_CONFLICT',
      status: 422,
    });
    await expect(prisma.dsvDispatchImport.findUniqueOrThrow({ where: { id: staged.id } })).resolves.toMatchObject({
      failureCode: 'DISPATCH_IMPORT_CANONICAL_CONFLICT',
      failureMessage: 'DISPATCH_IMPORT_CANONICAL_CONFLICT',
      status: 'FAILED',
    });
    await expect(canonicalCounts(prisma, fixture.shopId)).resolves.toMatchObject({
      customers: 0,
      deliveryStops: 0,
      destinations: 0,
      orders: 0,
      routeGroupingOrders: 0,
      routePlanStops: 0,
      routePlans: 0,
    });

    await expect(new PrismaDsvDispatchImportService(prisma).apply(input)).rejects.toMatchObject({
      code: 'DISPATCH_IMPORT_CANONICAL_CONFLICT',
    } satisfies Partial<DsvDispatchImportApplyError>);
    await expect(prisma.dsvCommandReceipt.findUniqueOrThrow({ where: { id: receiptBeforeReplay.id } }))
      .resolves.toEqual(receiptBeforeReplay);
    await expect(prisma.dsvAuditEvent.count({
      where: { commandReceiptId: receiptBeforeReplay.id, eventType: 'applyDispatchImportFailed' },
    })).resolves.toBe(1);
    await expect(canonicalCounts(prisma, fixture.shopId)).resolves.toMatchObject({
      customers: 0,
      deliveryStops: 0,
      destinations: 0,
      orders: 0,
    });
    console.info(`[G003 timeout] failure=${failureElapsedMs.toFixed(1)}ms`);
  });

  test('rejects an inactive customer without reactivation or canonical writes', async () => {
    const fixture = await createFixture(prisma, createdShopIds, 'inactive-customer');
    const service = new PrismaDsvDispatchImportService(prisma);
    const inactiveCustomer = await prisma.customer.create({
      data: {
        externalCustomerCode: 'CUST-G003',
        shopId: fixture.shopId,
        sourceKind: 'DSV_DISPATCH_IMPORT',
        status: 'INACTIVE',
      },
    });
    const staged = await service.commit({ ...fixture.input, actor: 'g003-test', shopDomain: fixture.shopDomain });
    const input = applyInput(fixture.shopDomain, staged.id, staged.sourceHash ?? '', 'cmd-inactive-customer');
    const countsBefore = await canonicalCounts(prisma, fixture.shopId);

    await expect(service.apply(input)).rejects.toMatchObject({
      code: 'DISPATCH_IMPORT_HAS_REVIEW_ROWS',
    } satisfies Partial<DsvDispatchImportApplyError>);

    await expect(canonicalCounts(prisma, fixture.shopId)).resolves.toEqual(countsBefore);
    await expect(prisma.customer.findUniqueOrThrow({ where: { id: inactiveCustomer.id } })).resolves.toMatchObject({
      status: 'INACTIVE',
    });
    const receipt = await prisma.dsvCommandReceipt.findUniqueOrThrow({
      where: {
        shopId_commandName_commandId: {
          commandId: input.commandId,
          commandName: 'applyDispatchImport',
          shopId: fixture.shopId,
        },
      },
    });
    expect(receipt).toMatchObject({ responseStatus: 422, status: 'FAILED' });
    expect(JSON.parse(receipt.responseBodyRef ?? 'null')).toEqual({
      code: 'DISPATCH_IMPORT_HAS_REVIEW_ROWS',
      status: 422,
    });
  });

  test('replays the same command and payload with an identical apply result', async () => {
    const fixture = await createFixture(prisma, createdShopIds, 'replay');
    const service = new PrismaDsvDispatchImportService(prisma);
    const staged = await service.commit({ ...fixture.input, actor: 'g003-test', shopDomain: fixture.shopDomain });
    const input = applyInput(fixture.shopDomain, staged.id, staged.sourceHash ?? '', 'cmd-replay');

    const first = await service.apply(input);
    const second = await service.apply(input);

    expect(second).toEqual(first);
    await expect(canonicalCounts(prisma, fixture.shopId)).resolves.toMatchObject({
      customers: 1,
      deliveryStops: 1,
      destinations: 1,
      orders: 1,
    });
  });

  test('finalizes a different command after apply without changing the winning result or batch', async () => {
    const fixture = await createFixture(prisma, createdShopIds, 'already-applied-loser');
    const service = new PrismaDsvDispatchImportService(prisma);
    const staged = await service.commit({ ...fixture.input, actor: 'g003-test', shopDomain: fixture.shopDomain });
    const winningInput = applyInput(fixture.shopDomain, staged.id, staged.sourceHash ?? '', 'cmd-already-applied-winner');
    const winningResult = await service.apply(winningInput);
    const winningReceipt = await prisma.dsvCommandReceipt.findUniqueOrThrow({
      where: {
        shopId_commandName_commandId: {
          commandId: winningInput.commandId,
          commandName: 'applyDispatchImport',
          shopId: fixture.shopId,
        },
      },
    });
    const appliedBatch = await prisma.dsvDispatchImport.findUniqueOrThrow({ where: { id: staged.id } });
    const countsAfterWinner = await canonicalCounts(prisma, fixture.shopId);
    const losingInput = applyInput(fixture.shopDomain, staged.id, staged.sourceHash ?? '', 'cmd-already-applied-loser');

    const losingFailure = await captureApplyFailure(service.apply(losingInput));
    expect(losingFailure.code).toBe('DISPATCH_IMPORT_ALREADY_APPLIED');
    const losingReceipt = await prisma.dsvCommandReceipt.findUniqueOrThrow({
      where: {
        shopId_commandName_commandId: {
          commandId: losingInput.commandId,
          commandName: 'applyDispatchImport',
          shopId: fixture.shopId,
        },
      },
    });
    expect(losingReceipt).toMatchObject({ responseStatus: 409, status: 'FAILED' });
    expect(JSON.parse(losingReceipt.responseBodyRef ?? 'null')).toEqual({
      code: 'DISPATCH_IMPORT_ALREADY_APPLIED',
      status: 409,
    });
    await expect(prisma.dsvAuditEvent.findFirstOrThrow({
      where: { commandReceiptId: losingReceipt.id, eventType: 'applyDispatchImportFailed' },
    })).resolves.toMatchObject({
      reason: 'DISPATCH_IMPORT_ALREADY_APPLIED',
      redactedDiff: {
        code: 'DISPATCH_IMPORT_ALREADY_APPLIED',
        preservedAppliedBatch: true,
      },
    });

    const replayFailure = await captureApplyFailure(service.apply(losingInput));
    expect({ code: replayFailure.code, status: applyErrorStatus(replayFailure.code) }).toEqual({
      code: 'DISPATCH_IMPORT_ALREADY_APPLIED',
      status: 409,
    });
    await expect(prisma.dsvCommandReceipt.findUniqueOrThrow({ where: { id: losingReceipt.id } }))
      .resolves.toEqual(losingReceipt);
    await expect(prisma.dsvCommandReceipt.findUniqueOrThrow({ where: { id: winningReceipt.id } }))
      .resolves.toEqual(winningReceipt);
    expect(JSON.parse(winningReceipt.responseBodyRef ?? 'null')).toEqual(winningResult);
    await expect(prisma.dsvDispatchImport.findUniqueOrThrow({ where: { id: staged.id } }))
      .resolves.toEqual(appliedBatch);
    await expect(canonicalCounts(prisma, fixture.shopId)).resolves.toEqual(countsAfterWinner);
    await expect(prisma.dsvCommandReceipt.count({
      where: { commandName: 'applyDispatchImport', importId: staged.id, shopId: fixture.shopId },
    })).resolves.toBe(2);
    await expect(prisma.dsvAuditEvent.count({
      where: { commandReceiptId: losingReceipt.id, eventType: 'applyDispatchImportFailed' },
    })).resolves.toBe(1);
  });

  test('serializes concurrent same-command success into one result or an in-progress response', async () => {
    const fixture = await createFixture(prisma, createdShopIds, 'same-command-concurrent');
    const service = new PrismaDsvDispatchImportService(prisma);
    const staged = await service.commit({ ...fixture.input, actor: 'g003-test', shopDomain: fixture.shopDomain });
    const input = applyInput(fixture.shopDomain, staged.id, staged.sourceHash ?? '', 'cmd-same-command-concurrent');

    const outcomes = await Promise.allSettled([service.apply(input), service.apply(input)]);
    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
    const receipt = await prisma.dsvCommandReceipt.findUniqueOrThrow({
      where: {
        shopId_commandName_commandId: {
          commandId: input.commandId,
          commandName: 'applyDispatchImport',
          shopId: fixture.shopId,
        },
      },
    });

    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    expect(fulfilled.every((outcome) => outcome.value.status === 'APPLIED')).toBe(true);
    expect(fulfilled.length + rejected.length).toBe(2);
    for (const outcome of rejected) {
      expect(outcome.reason).toMatchObject({ code: 'COMMAND_IN_PROGRESS' } satisfies Partial<DsvDispatchImportApplyError>);
    }
    expect(receipt).toMatchObject({
      importId: staged.id,
      responseStatus: 200,
      resultEntityId: staged.id,
      resultEntityType: 'DsvDispatchImport',
      status: 'SUCCEEDED',
    });
    expect(JSON.parse(receipt.responseBodyRef ?? 'null')).toEqual(fulfilled[0]?.value);
    await expect(prisma.dsvCommandReceipt.count({
      where: { commandId: input.commandId, commandName: 'applyDispatchImport', shopId: fixture.shopId },
    })).resolves.toBe(1);
    await expect(prisma.dsvAuditEvent.count({
      where: { commandReceiptId: receipt.id, eventType: 'applyDispatchImport', shopId: fixture.shopId },
    })).resolves.toBe(1);
    await expect(canonicalCounts(prisma, fixture.shopId)).resolves.toMatchObject({
      customers: 1,
      deliveryStops: 1,
      destinations: 1,
      orders: 1,
      routeGroupingOrders: 1,
      routePlanStops: 0,
      routePlans: 0,
    });
  });

  test('durably claims a concurrent same-command forced failure before terminal compensation', async () => {
    const fixture = await createFixture(prisma, createdShopIds, 'same-command-failure-race');
    const service = new PrismaDsvDispatchImportService(prisma, {
      delayAfterCanonicalRowsMs: 500,
      failAfterCanonicalRows: 1,
    });
    const staged = await service.commit({ ...fixture.input, actor: 'g003-test', shopDomain: fixture.shopDomain });
    const input = applyInput(fixture.shopDomain, staged.id, staged.sourceHash ?? '', 'cmd-same-command-failure-race');

    const firstAttempt = captureApplyFailure(service.apply(input));
    const startedReceipt = await waitForCommandReceipt(prisma, fixture.shopId, input.commandId, 'STARTED');
    const concurrentAttempt = captureApplyFailure(service.apply(input));
    const [firstFailure, concurrentFailure] = await Promise.all([firstAttempt, concurrentAttempt]);

    expect(firstFailure.code).toBe('DISPATCH_IMPORT_CANONICAL_CONFLICT');
    expect(concurrentFailure.code).toBe('COMMAND_IN_PROGRESS');
    const failedReceipt = await prisma.dsvCommandReceipt.findUniqueOrThrow({ where: { id: startedReceipt.id } });
    const firstResponse = { code: firstFailure.code, status: applyErrorStatus(firstFailure.code) };
    expect(failedReceipt).toMatchObject({
      id: startedReceipt.id,
      responseStatus: firstResponse.status,
      status: 'FAILED',
    });
    expect(JSON.parse(failedReceipt.responseBodyRef ?? 'null')).toEqual(firstResponse);
    await expect(prisma.dsvCommandReceipt.count({
      where: { commandId: input.commandId, commandName: 'applyDispatchImport', shopId: fixture.shopId },
    })).resolves.toBe(1);
    await expect(prisma.dsvDispatchImport.findUniqueOrThrow({ where: { id: staged.id } })).resolves.toMatchObject({
      failureCode: firstFailure.code,
      failureMessage: firstFailure.code,
      status: 'FAILED',
    });
    await expect(prisma.dsvAuditEvent.count({
      where: { commandReceiptId: failedReceipt.id, eventType: 'applyDispatchImportFailed' },
    })).resolves.toBe(1);
    await expect(canonicalCounts(prisma, fixture.shopId)).resolves.toMatchObject({
      customers: 0,
      deliveryStops: 0,
      destinations: 0,
      orders: 0,
      routeGroupingOrders: 0,
      routePlanStops: 0,
      routePlans: 0,
    });

    const replayFailure = await captureApplyFailure(new PrismaDsvDispatchImportService(prisma).apply(input));
    expect({ code: replayFailure.code, status: applyErrorStatus(replayFailure.code) }).toEqual(firstResponse);
    await expect(prisma.dsvCommandReceipt.findUniqueOrThrow({ where: { id: failedReceipt.id } }))
      .resolves.toEqual(failedReceipt);
    await expect(prisma.dsvAuditEvent.count({
      where: { commandReceiptId: failedReceipt.id, eventType: 'applyDispatchImportFailed' },
    })).resolves.toBe(1);

    const newCommandInput = { ...input, commandId: `${input.commandId}-new` };
    const newCommandFailure = await captureApplyFailure(new PrismaDsvDispatchImportService(prisma).apply(newCommandInput));
    expect(newCommandFailure.code).toBe('DISPATCH_IMPORT_NOT_READY');
    await expect(prisma.dsvCommandReceipt.findUniqueOrThrow({
      where: {
        shopId_commandName_commandId: {
          commandId: newCommandInput.commandId,
          commandName: 'applyDispatchImport',
          shopId: fixture.shopId,
        },
      },
    })).resolves.toMatchObject({ responseStatus: 422, status: 'FAILED' });
    await expect(canonicalCounts(prisma, fixture.shopId)).resolves.toMatchObject({
      customers: 0,
      deliveryStops: 0,
      destinations: 0,
      orders: 0,
    });
  });

  test('reports an existing same-command receipt as in progress without overwriting it', async () => {
    const fixture = await createFixture(prisma, createdShopIds, 'same-command-started');
    const service = new PrismaDsvDispatchImportService(prisma);
    const staged = await service.commit({ ...fixture.input, actor: 'g003-test', shopDomain: fixture.shopDomain });
    const input = applyInput(fixture.shopDomain, staged.id, staged.sourceHash ?? '', 'cmd-same-command-started');
    const receipt = await prisma.dsvCommandReceipt.create({
      data: {
        actorId: input.actor,
        actorType: 'DSV_ADMIN',
        commandId: input.commandId,
        commandName: 'applyDispatchImport',
        importId: staged.id,
        payloadHash: sha256CanonicalJson({
          commandId: input.commandId,
          commandName: 'applyDispatchImport',
          importId: staged.id,
          previewHash: staged.previewHash,
          sourceHash: input.expectedSourceHash,
        }),
        principalType: 'DSV_ADMIN',
        requestId: input.principal.requestId,
        shopId: fixture.shopId,
        status: 'STARTED',
      },
    });

    await expect(service.apply(input)).rejects.toMatchObject({
      code: 'COMMAND_IN_PROGRESS',
    } satisfies Partial<DsvDispatchImportApplyError>);
    await expect(prisma.dsvCommandReceipt.findUniqueOrThrow({ where: { id: receipt.id } })).resolves.toMatchObject({
      completedAt: null,
      responseBodyRef: null,
      responseStatus: null,
      status: 'STARTED',
    });
    await expect(canonicalCounts(prisma, fixture.shopId)).resolves.toMatchObject({
      customers: 0,
      deliveryStops: 0,
      destinations: 0,
      orders: 0,
    });
  });

  test('rejects the same command with a different payload without extra canonical writes', async () => {
    const fixture = await createFixture(prisma, createdShopIds, 'payload-conflict');
    const service = new PrismaDsvDispatchImportService(prisma);
    const staged = await service.commit({ ...fixture.input, actor: 'g003-test', shopDomain: fixture.shopDomain });

    await service.apply(applyInput(fixture.shopDomain, staged.id, staged.sourceHash ?? '', 'cmd-payload-conflict'));
    const countsAfterApply = await canonicalCounts(prisma, fixture.shopId);
    const receiptBeforeConflict = await prisma.dsvCommandReceipt.findUniqueOrThrow({
      where: {
        shopId_commandName_commandId: {
          commandId: 'cmd-payload-conflict',
          commandName: 'applyDispatchImport',
          shopId: fixture.shopId,
        },
      },
    });
    await expect(
      service.apply(applyInput(fixture.shopDomain, staged.id, `${staged.sourceHash ?? ''}-different`, 'cmd-payload-conflict')),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_PAYLOAD_MISMATCH' } satisfies Partial<DsvDispatchImportApplyError>);

    await expect(canonicalCounts(prisma, fixture.shopId)).resolves.toEqual(countsAfterApply);
    await expect(prisma.dsvCommandReceipt.findUniqueOrThrow({ where: { id: receiptBeforeConflict.id } }))
      .resolves.toEqual(receiptBeforeConflict);
    await expect(prisma.dsvAuditEvent.count({
      where: { commandReceiptId: receiptBeforeConflict.id, eventType: 'applyDispatchImportFailed' },
    })).resolves.toBe(0);
  });

  test('shares one physical destination across customer-scoped canonical orders', async () => {
    const fixture = await createFixture(prisma, createdShopIds, 'shared-destination');
    const service = new PrismaDsvDispatchImportService(prisma);
    const firstRow = fixture.input.rows[0];
    if (firstRow === undefined) throw new Error('Missing fixture row');
    const secondSellerOrderKey = `${fixture.sellerOrderKey}-SECOND`;
    const staged = await service.commit({
      ...fixture.input,
      actor: 'g003-test',
      rows: [
        firstRow,
        {
          ...firstRow,
          customerCode: 'CUST-G003-SECOND',
          rowNumber: 3,
          sellerOrderKey: secondSellerOrderKey,
        },
      ],
      shopDomain: fixture.shopDomain,
    });

    const result = await service.apply(applyInput(
      fixture.shopDomain,
      staged.id,
      staged.sourceHash ?? '',
      'cmd-shared-destination',
    ));
    const orders = await prisma.order.findMany({
      select: {
        customer: { select: { externalCustomerCode: true } },
        customerId: true,
        destinationId: true,
        sellerOrderKey: true,
      },
      where: {
        sellerOrderKey: { in: [fixture.sellerOrderKey, secondSellerOrderKey] },
        sellerOrderSourceKind: 'DSV_DISPATCH_IMPORT',
        shopId: fixture.shopId,
      },
    });
    const ordersByKey = new Map(orders.map((order) => [order.sellerOrderKey, order]));

    expect(result.rows).toHaveLength(2);
    expect(new Set(result.rows.map((row) => row.customerId)).size).toBe(2);
    expect(new Set(result.rows.map((row) => row.destinationId)).size).toBe(1);
    expect(ordersByKey.get(fixture.sellerOrderKey)?.customer?.externalCustomerCode).toBe('CUST-G003');
    expect(ordersByKey.get(secondSellerOrderKey)?.customer?.externalCustomerCode).toBe('CUST-G003-SECOND');
    expect(new Set(orders.map((order) => order.customerId)).size).toBe(2);
    expect(new Set(orders.map((order) => order.destinationId)).size).toBe(1);
    await expect(canonicalCounts(prisma, fixture.shopId)).resolves.toMatchObject({
      customers: 2,
      deliveryStops: 2,
      destinations: 1,
      orders: 2,
      routeGroupingOrders: 2,
      routePlanStops: 0,
      routePlans: 0,
    });
  });

  test('serializes eight cross-customer applies for one physical destination fingerprint', async () => {
    const fixture = await createFixture(prisma, createdShopIds, 'destination-race');
    const service = new PrismaDsvDispatchImportService(prisma);
    const firstRow = fixture.input.rows[0];
    if (firstRow === undefined) throw new Error('Missing fixture row');
    const stagedImports = [];
    for (let index = 0; index < 8; index += 1) {
      stagedImports.push(await service.commit({
        ...fixture.input,
        actor: 'g003-test',
        rows: [{
          ...firstRow,
          customerCode: `CUST-G003-RACE-${index}`,
          sellerOrderKey: `${fixture.sellerOrderKey}-${index}`,
        }],
        shopDomain: fixture.shopDomain,
      }));
    }

    const results = await Promise.all(stagedImports.map((staged, index) => service.apply(applyInput(
      fixture.shopDomain,
      staged.id,
      staged.sourceHash ?? '',
      `cmd-destination-race-${index}`,
    ))));

    expect(results).toHaveLength(8);
    expect(new Set(results.flatMap((result) => result.rows.map((row) => row.customerId))).size).toBe(8);
    expect(new Set(results.flatMap((result) => result.rows.map((row) => row.destinationId))).size).toBe(1);
    await expect(prisma.dsvCommandReceipt.count({
      where: { commandName: 'applyDispatchImport', shopId: fixture.shopId, status: 'SUCCEEDED' },
    })).resolves.toBe(8);
    await expect(canonicalCounts(prisma, fixture.shopId)).resolves.toMatchObject({
      customers: 8,
      deliveryStops: 8,
      destinations: 1,
      orders: 8,
      routeGroupingOrders: 8,
      routePlanStops: 0,
      routePlans: 0,
    });
  });

  test('keeps one canonical active delivery after concurrent apply attempts', async () => {
    const fixture = await createFixture(prisma, createdShopIds, 'concurrent');
    const service = new PrismaDsvDispatchImportService(prisma);
    const staged = await service.commit({ ...fixture.input, actor: 'g003-test', shopDomain: fixture.shopDomain });

    const outcomes = await Promise.allSettled([
      service.apply(applyInput(fixture.shopDomain, staged.id, staged.sourceHash ?? '', 'cmd-concurrent-a')),
      service.apply(applyInput(fixture.shopDomain, staged.id, staged.sourceHash ?? '', 'cmd-concurrent-b')),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    await expect(canonicalCounts(prisma, fixture.shopId)).resolves.toMatchObject({
      deliveryStops: 1,
      orders: 1,
      routeGroupingOrders: 1,
      routePlanStops: 0,
      routePlans: 0,
    });
  });

  test('accepts one active ownership represented by overlapping storage rows', async () => {
    const fixture = await createFixture(prisma, createdShopIds, 'single-active-owner');
    const service = new PrismaDsvDispatchImportService(prisma);
    const firstStage = await service.commit({ ...fixture.input, actor: 'g003-test', shopDomain: fixture.shopDomain });
    const firstApply = await service.apply(applyInput(
      fixture.shopDomain,
      firstStage.id,
      firstStage.sourceHash ?? '',
      'cmd-single-active-owner-first',
    ));
    const canonical = firstApply.rows[0];
    if (canonical === undefined) throw new Error('Missing canonical row');
    await createOverlappingActiveOwnership(prisma, {
      deliveryStopId: canonical.deliveryStopId,
      driverId: fixture.driverId,
      orderId: canonical.sellerOrderId,
      shopId: fixture.shopId,
      vehicleId: fixture.vehicleId,
    });

    const secondStage = await service.commit({ ...fixture.input, actor: 'g003-test', shopDomain: fixture.shopDomain });
    expect(secondStage).toMatchObject({ status: 'READY' });
    expect(secondStage.rows[0]).toMatchObject({ diffKind: 'NO_OP' });
    expect(secondStage.rows[0]?.issues).not.toContainEqual(expect.objectContaining({ code: 'DUPLICATE_ACTIVE_DELIVERY' }));

    const secondApply = await service.apply(applyInput(
      fixture.shopDomain,
      secondStage.id,
      secondStage.sourceHash ?? '',
      'cmd-single-active-owner-second',
    ));
    expect(secondApply.rows[0]).toMatchObject({
      deliveryStopId: canonical.deliveryStopId,
      outcome: 'NO_OP',
      sellerOrderId: canonical.sellerOrderId,
    });
  });

  test('rejects two genuinely distinct active ownership identities', async () => {
    const fixture = await createFixture(prisma, createdShopIds, 'duplicate-active-owner');
    const service = new PrismaDsvDispatchImportService(prisma);
    const firstStage = await service.commit({ ...fixture.input, actor: 'g003-test', shopDomain: fixture.shopDomain });
    const firstApply = await service.apply(applyInput(
      fixture.shopDomain,
      firstStage.id,
      firstStage.sourceHash ?? '',
      'cmd-duplicate-active-owner-first',
    ));
    const canonical = firstApply.rows[0];
    if (canonical === undefined) throw new Error('Missing canonical row');
    await createGroupingAssignment(prisma, {
      deliveryStopId: canonical.deliveryStopId,
      driverId: fixture.driverId,
      name: 'Active owner one',
      orderId: canonical.sellerOrderId,
      shopId: fixture.shopId,
    });
    await createGroupingAssignment(prisma, {
      deliveryStopId: canonical.deliveryStopId,
      driverId: fixture.driverId,
      name: 'Active owner two',
      orderId: canonical.sellerOrderId,
      shopId: fixture.shopId,
    });
    const countsBefore = await canonicalCounts(prisma, fixture.shopId);

    const secondStage = await service.commit({ ...fixture.input, actor: 'g003-test', shopDomain: fixture.shopDomain });
    expect(secondStage.status).toBe('NEEDS_REVIEW');
    expect(secondStage.rows[0]?.issues).toContainEqual(expect.objectContaining({ code: 'DUPLICATE_ACTIVE_DELIVERY' }));
    await expect(service.apply(applyInput(
      fixture.shopDomain,
      secondStage.id,
      secondStage.sourceHash ?? '',
      'cmd-duplicate-active-owner-second',
    ))).rejects.toMatchObject({ code: 'DUPLICATE_ACTIVE_DELIVERY' } satisfies Partial<DsvDispatchImportApplyError>);
    await expect(canonicalCounts(prisma, fixture.shopId)).resolves.toEqual(countsBefore);
  });

  test('rolls back canonical writes on forced transaction failure and records compensation evidence', async () => {
    const fixture = await createFixture(prisma, createdShopIds, 'rollback');
    const service = new PrismaDsvDispatchImportService(prisma, { failAfterCanonicalRows: 1 });
    const staged = await service.commit({ ...fixture.input, actor: 'g003-test', shopDomain: fixture.shopDomain });
    const input = applyInput(fixture.shopDomain, staged.id, staged.sourceHash ?? '', 'cmd-rollback');

    const firstFailure = await captureApplyFailure(service.apply(input));
    expect(firstFailure.code).toBe('DISPATCH_IMPORT_CANONICAL_CONFLICT');

    await expect(canonicalCounts(prisma, fixture.shopId)).resolves.toMatchObject({
      customers: 0,
      deliveryStops: 0,
      destinations: 0,
      orders: 0,
    });
    await expect(prisma.dsvAuditEvent.findFirst({
      where: { eventType: 'applyDispatchImportFailed', importId: staged.id, shopId: fixture.shopId },
    })).resolves.toMatchObject({
      reason: 'DISPATCH_IMPORT_CANONICAL_CONFLICT',
      redactedDiff: { code: 'DISPATCH_IMPORT_CANONICAL_CONFLICT', compensation: 'canonical mutation transaction rolled back' },
    });
    const receiptBeforeRetry = await prisma.dsvCommandReceipt.findUniqueOrThrow({
      where: {
        shopId_commandName_commandId: {
          commandId: input.commandId,
          commandName: 'applyDispatchImport',
          shopId: fixture.shopId,
        },
      },
    });
    expect(receiptBeforeRetry).toMatchObject({ responseStatus: 422, status: 'FAILED' });
    expect(JSON.parse(receiptBeforeRetry.responseBodyRef ?? 'null')).toEqual({
      code: 'DISPATCH_IMPORT_CANONICAL_CONFLICT',
      status: 422,
    });
    await expect(prisma.dsvDispatchImport.findUniqueOrThrow({ where: { id: staged.id } })).resolves.toMatchObject({
      failureCode: 'DISPATCH_IMPORT_CANONICAL_CONFLICT',
      failureMessage: 'DISPATCH_IMPORT_CANONICAL_CONFLICT',
      status: 'FAILED',
    });
    const failureAuditCount = await prisma.dsvAuditEvent.count({
      where: { commandReceiptId: receiptBeforeRetry.id, eventType: 'applyDispatchImportFailed' },
    });

    await expect(new PrismaDsvDispatchImportService(prisma).apply(input)).rejects.toMatchObject({
      code: 'DISPATCH_IMPORT_CANONICAL_CONFLICT',
    } satisfies Partial<DsvDispatchImportApplyError>);
    await expect(prisma.dsvCommandReceipt.findUniqueOrThrow({ where: { id: receiptBeforeRetry.id } }))
      .resolves.toEqual(receiptBeforeRetry);
    await expect(prisma.dsvAuditEvent.count({
      where: { commandReceiptId: receiptBeforeRetry.id, eventType: 'applyDispatchImportFailed' },
    })).resolves.toBe(failureAuditCount);
    await expect(canonicalCounts(prisma, fixture.shopId)).resolves.toMatchObject({
      customers: 0,
      deliveryStops: 0,
      destinations: 0,
      orders: 0,
    });
  });
});

async function captureApplyFailure(promise: Promise<unknown>): Promise<DsvDispatchImportApplyError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DsvDispatchImportApplyError) return error;
    throw error;
  }
  throw new Error('Expected dispatch import apply to fail');
}

function applyErrorStatus(code: DsvDispatchImportApplyError['code']): number {
  return code === 'COMMAND_IN_PROGRESS'
    || code === 'DISPATCH_IMPORT_ALREADY_APPLIED'
    || code === 'DISPATCH_IMPORT_PREVIEW_STALE'
    || code === 'DUPLICATE_ACTIVE_DELIVERY'
    || code === 'IDEMPOTENCY_PAYLOAD_MISMATCH'
    ? 409
    : 422;
}

async function waitForCommandReceipt(
  prisma: PrismaClient,
  shopId: string,
  commandId: string,
  status: 'STARTED',
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const receipt = await prisma.dsvCommandReceipt.findUnique({
      where: { shopId_commandName_commandId: { commandId, commandName: 'applyDispatchImport', shopId } },
    });
    if (receipt?.status === status) return receipt;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${commandId} receipt status ${status}`);
}

async function createFixture(prisma: PrismaClient, createdShopIds: string[], name: string) {
  const unique = `${name}-${randomUUID()}`;
  const shopDomain = `g003-${unique}.example.test`;
  const sellerOrderKey = `SO-${unique}`;
  const shop = await prisma.shop.create({
    data: {
      appId: 'clever',
      shopDomain,
      shopifyShopGid: `gid://shopify/Shop/${unique}`,
    },
  });
  createdShopIds.push(shop.id);
  const driver = await prisma.driver.create({
    data: {
      displayName: 'Driver One',
      shopId: shop.id,
      status: 'ACTIVE',
      dsvProfile: {
        create: {
          age: 41,
          career: '5y',
          gender: 'N/A',
          lookupName: 'Driver One',
          score: 'A',
          zone: 'SEOUL',
        },
      },
    },
  });
  const vehicle = await prisma.vehicle.create({
    data: {
      label: 'Truck One',
      licensePlate: '12A3456',
      shopId: shop.id,
      status: 'ACTIVE',
    },
  });
  await prisma.dsvVehicleDriverAssignment.create({
    data: {
      createdBy: 'g003-test',
      driverId: driver.id,
      shopId: shop.id,
      vehicleId: vehicle.id,
    },
  });
  await prisma.dsvTransportCondition.create({
    data: {
      activatedAt: new Date('2026-07-22T00:00:00.000Z'),
      code: 'TS01',
      comparisonKey: 'TS01',
      createdBy: 'g003-test',
      description: 'Standard',
      name: 'Standard',
      rawValue: 'TS01',
      shopId: shop.id,
      status: 'ACTIVE',
    },
  });

  return {
    driverId: driver.id,
    input: dispatchInput(sellerOrderKey),
    sellerOrderKey,
    shopDomain,
    shopId: shop.id,
    vehicleId: vehicle.id,
  };
}

async function createGroupingAssignment(prisma: PrismaClient, input: {
  deliveryStopId: string;
  driverId: string;
  name: string;
  orderId: string;
  shopId: string;
}) {
  const grouping = await prisma.routeGrouping.create({
    data: {
      createdBy: 'g003-test',
      name: input.name,
      planDate: new Date('2026-07-22T00:00:00.000Z'),
      shopId: input.shopId,
      status: 'READY',
    },
  });
  const assignment = await prisma.routeGroupingOrder.create({
    data: {
      assignedDriverId: input.driverId,
      assignmentStatus: 'ASSIGNED',
      deliveryStopId: input.deliveryStopId,
      groupingId: grouping.id,
      orderId: input.orderId,
      shopId: input.shopId,
      sourceSequence: 1,
    },
  });
  return { assignment, grouping };
}

async function createOverlappingActiveOwnership(prisma: PrismaClient, input: {
  deliveryStopId: string;
  driverId: string;
  orderId: string;
  shopId: string;
  vehicleId: string;
}) {
  const { assignment, grouping } = await createGroupingAssignment(prisma, {
    ...input,
    name: 'One active ownership',
  });
  const routePlan = await prisma.routePlan.create({
    data: {
      constraints: {},
      createdBy: 'g003-test',
      driverId: input.driverId,
      metrics: {},
      name: 'One active ownership route',
      optimizerVersion: 'g003-test',
      planDate: new Date('2026-07-22T00:00:00.000Z'),
      shopId: input.shopId,
      status: 'IN_PROGRESS',
      vehicleId: input.vehicleId,
    },
  });
  const groupingVersion = await prisma.routeGroupingVersion.create({
    data: {
      actor: 'g003-test',
      groupingId: grouping.id,
      shopId: input.shopId,
      status: 'CURRENT',
      version: 1,
    },
  });
  const childVersion = await prisma.routeGroupingChildVersion.create({
    data: {
      driverId: input.driverId,
      groupingId: grouping.id,
      groupingVersionId: groupingVersion.id,
      publishedAt: new Date('2026-07-22T00:00:00.000Z'),
      routePlanId: routePlan.id,
      shopId: input.shopId,
      snapshot: { deliveryStopIds: [input.deliveryStopId] },
      status: 'CURRENT',
      version: 1,
    },
  });
  await prisma.order.update({
    data: { currentRouteVersionId: childVersion.id },
    where: { id_shopId: { id: input.orderId, shopId: input.shopId } },
  });
  const branch = await prisma.routeGroupingBranch.create({
    data: {
      createdBy: 'g003-test',
      driverId: input.driverId,
      groupingId: grouping.id,
      label: 'One owner branch',
      shopId: input.shopId,
    },
  });
  await Promise.all([
    prisma.routeGroupingBranchOrderLock.create({
      data: {
        branchId: branch.id,
        deliveryStopId: input.deliveryStopId,
        groupingId: grouping.id,
        orderId: input.orderId,
        routeGroupingOrderId: assignment.id,
        shopId: input.shopId,
      },
    }),
    prisma.routePlanStop.create({
      data: {
        deliveryStopId: input.deliveryStopId,
        routePlanId: routePlan.id,
        shopId: input.shopId,
        sequence: 1,
      },
    }),
  ]);

  const terminalGrouping = await prisma.routeGrouping.create({
    data: {
      createdBy: 'g003-test',
      name: 'Terminal grouping noise',
      planDate: new Date('2026-07-22T00:00:00.000Z'),
      shopId: input.shopId,
      status: 'CANCELLED',
    },
  });
  const terminalRoutePlan = await prisma.routePlan.create({
    data: {
      constraints: {},
      createdBy: 'g003-test',
      driverId: input.driverId,
      metrics: {},
      name: 'Terminal route noise',
      optimizerVersion: 'g003-test',
      planDate: new Date('2026-07-22T00:00:00.000Z'),
      shopId: input.shopId,
      status: 'COMPLETED',
      vehicleId: input.vehicleId,
    },
  });
  await Promise.all([
    prisma.routeGroupingOrder.create({
      data: {
        assignedDriverId: input.driverId,
        assignmentStatus: 'ASSIGNED',
        deliveryStopId: input.deliveryStopId,
        groupingId: terminalGrouping.id,
        orderId: input.orderId,
        shopId: input.shopId,
        sourceSequence: 1,
      },
    }),
    prisma.routePlanStop.create({
      data: {
        deliveryStopId: input.deliveryStopId,
        routePlanId: terminalRoutePlan.id,
        shopId: input.shopId,
        sequence: 1,
      },
    }),
  ]);
}

async function createReadyPredepartureRoutePlan(prisma: PrismaClient, input: {
  deliveryStopId: string;
  driverId: string;
  orderId: string;
  shopId: string;
  vehicleId: string;
}) {
  const groupingOrder = await prisma.routeGroupingOrder.findFirstOrThrow({
    include: { grouping: true },
    where: {
      assignmentStatus: 'UNASSIGNED',
      orderId: input.orderId,
      shopId: input.shopId,
    },
  });
  const groupingVersion = await prisma.routeGroupingVersion.findFirstOrThrow({
    where: { groupingId: groupingOrder.groupingId, shopId: input.shopId, status: 'CURRENT' },
  });
  const routePlan = await prisma.routePlan.create({
    data: {
      constraints: {},
      createdBy: 'g003-test',
      driverId: input.driverId,
      metrics: { stale: false },
      name: 'Ready pre-departure route',
      optimizerVersion: 'g003-test',
      planDate: new Date('2026-07-22T00:00:00.000Z'),
      shopId: input.shopId,
      status: 'READY',
      vehicleId: input.vehicleId,
    },
  });
  const childVersion = await prisma.routeGroupingChildVersion.create({
    data: {
      driverId: input.driverId,
      groupingId: groupingOrder.groupingId,
      groupingVersionId: groupingVersion.id,
      publishedAt: new Date('2026-07-22T00:00:00.000Z'),
      routePlanId: routePlan.id,
      shopId: input.shopId,
      snapshot: { deliveryStopIds: [input.deliveryStopId] },
      status: 'CURRENT',
      version: 1,
    },
  });
  await Promise.all([
    prisma.order.update({
      data: { currentRouteVersionId: childVersion.id },
      where: { id_shopId: { id: input.orderId, shopId: input.shopId } },
    }),
    prisma.routePlanStop.create({
      data: {
        deliveryStopId: input.deliveryStopId,
        distanceFromPreviousMeters: 1200,
        durationFromPreviousSeconds: 600,
        estimatedArrivalAt: new Date('2026-07-22T01:00:00.000Z'),
        etaCalculatedAt: new Date('2026-07-22T00:30:00.000Z'),
        etaInputRouteVersionId: childVersion.id,
        etaSource: 'TEST_READY_ROUTE',
        etaStatus: 'READY',
        routePlanId: routePlan.id,
        sequence: 1,
        shopId: input.shopId,
      },
    }),
    prisma.routePlanGeometryCache.create({
      data: {
        geometry: { coordinates: [[126.978, 37.5665], [127.1, 37.6]], type: 'LineString' },
        metrics: { distanceMeters: 1200, durationSeconds: 600 },
        overview: 'simplified',
        provider: 'g003-test',
        providerVersion: 'test',
        routePlanId: routePlan.id,
        shapeSignature: `ready-predeparture-${routePlan.id}`,
        source: 'test',
        stopPoints: [{ deliveryStopId: input.deliveryStopId }],
      },
    }),
  ]);
  return { childVersionId: childVersion.id, groupingId: groupingOrder.groupingId, routePlanId: routePlan.id };
}

async function createManualReadyRoutePlan(prisma: PrismaClient, input: {
  deliveryStopId: string;
  driverId: string;
  shopId: string;
  vehicleId: string;
}) {
  const routePlan = await prisma.routePlan.create({
    data: {
      constraints: {},
      createdBy: 'manual-test',
      driverId: input.driverId,
      metrics: {},
      name: 'Manual ready route',
      optimizerVersion: 'manual-test',
      planDate: new Date('2026-07-22T00:00:00.000Z'),
      shopId: input.shopId,
      status: 'READY',
      vehicleId: input.vehicleId,
    },
  });
  await prisma.routePlanStop.create({
    data: {
      deliveryStopId: input.deliveryStopId,
      routePlanId: routePlan.id,
      sequence: 1,
      shopId: input.shopId,
    },
  });
  return { routePlanId: routePlan.id };
}

function dispatchInput(sellerOrderKey: string): DsvDispatchImportInput {
  return {
    fileName: 'g003-dispatch.csv',
    planDate: '2026-07-22',
    rows: [{
      address: '123 Integration Test Road',
      conditionCode: 'TS01',
      customerCode: 'CUST-G003',
      destinationName: 'Integration Destination',
      driverName: '',
      latitude: 37.5665,
      longitude: 126.978,
      notes: 'Leave at dock',
      rowNumber: 2,
      sellerOrderKey,
      shippedBoxes: 3,
      vehiclePlate: '',
    }],
  };
}

function applyInput(shopDomain: string, importId: string, expectedSourceHash: string, commandId: string) {
  return {
    actor: 'g003-test',
    commandId,
    expectedSourceHash,
    importId,
    principal: {
      actorId: 'g003-test',
      actorType: 'DSV_ADMIN',
      principalType: 'DSV_ADMIN' as const,
      requestId: `req-${commandId}`,
    },
    shopDomain,
  };
}

async function canonicalCounts(prisma: PrismaClient, shopId: string) {
  const [
    customers,
    destinations,
    orders,
    deliveryStops,
    routePlans,
    routePlanStops,
    routeGroupingOrders,
  ] = await Promise.all([
    prisma.customer.count({ where: { shopId } }),
    prisma.deliveryCustomerProfile.count({ where: { shopId } }),
    prisma.order.count({ where: { shopId } }),
    prisma.deliveryStop.count({ where: { shopId } }),
    prisma.routePlan.count({ where: { shopId } }),
    prisma.routePlanStop.count({ where: { deliveryStop: { shopId } } }),
    prisma.routeGroupingOrder.count({ where: { shopId } }),
  ]);
  return {
    customers,
    deliveryStops,
    destinations,
    orders,
    routeGroupingOrders,
    routePlanStops,
    routePlans,
  };
}
