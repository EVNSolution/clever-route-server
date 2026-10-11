import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { assertProofDriverCompatible, assertProofRollout } from '../route-plans/delivery-options.js';
import { computeRouteShapeSignatureFromParts } from '../route-plans/route-plan-geometry-cache.js';
import { PrismaRoutePlanRepository } from '../route-plans/route-plan.repository.js';
import { PrismaRouteGroupingService } from '../route-grouping/route-grouping.service.js';
import type { DriverPushProvider } from '../route-grouping/driver-push.provider.js';
import { assertShopifyShopPrivacyWriteAllowed } from '../shopify/order-privacy-redaction.js';
import { findDriverAppAddressGaps } from './driver-app-address-contract.js';
import { PrismaDriverAssignedRouteRepository } from './driver-assigned-route.repository.js';
import { PrismaDriverRouteAccessRepository } from './driver-route-access.repository.js';
import { getPrivateDriverDemoConfig, KFOOD_PRIVATE_DEMO_APP_ID, KFOOD_PRIVATE_DEMO_SHOP_DOMAIN } from './private-driver-demo.js';
import {
  findTemplateAddressGaps,
  PRIVATE_DRIVER_DEMO_CITY,
  PRIVATE_DRIVER_DEMO_COUNTRY_CODE,
  PRIVATE_DRIVER_DEMO_PROVINCE,
  PRIVATE_DRIVER_DEMO_TEMPLATES,
  type PrivateDriverDemoTemplateName
} from './private-driver-demo-templates.js';

// Extra synthetic routes for the private KFood driver demo shop. The base shop and its driver come from the seed.
// A route is created unpublished (assigned, invisible to the app) and becomes visible only through Dispatch, which
// uses the same two service calls as the admin Dispatch and sends the route push.
const SCHEMA = 'kfood_private_driver_demo_dispatch_v1';
const TIMEZONE = 'America/Toronto';
const DEPOT = { latitude: 43.6534, longitude: -79.3841 };
const KEY_PATTERN = /^[a-z0-9]{3,16}$/u;
const PLAN_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

export type PrivateDriverDemoRouteInput = {
  key: string;
  name: string;
  planDate?: string | undefined;
  template: PrivateDriverDemoTemplateName;
};

export type PrivateDriverDemoRouteState = 'absent' | 'unpublished' | 'published';

type RouteIds = {
  childVersionId: string;
  geometryId: string;
  groupingId: string;
  groupingVersionId: string;
  routePlanId: string;
  stops: Array<{ deliveryStopId: string; groupingOrderId: string; orderId: string; routePlanStopId: string; sequence: number }>;
};

type DemoDb = Pick<PrismaClient, 'commerceConnection' | 'customer' | 'customerAccount' | 'customerDeliveryNotificationAttempt'
  | 'customerRouteNotificationFact' | 'deliveryCustomerProfile' | 'driver' | 'driverAccount' | 'driverRouteNotificationAttempt'
  | 'orderMessage' | 'routeGrouping' | 'routeGroupingChildVersion' | 'routePlan' | 'shop'>;

export function assertPrivateDriverDemoRouteInput(input: PrivateDriverDemoRouteInput): void {
  if (!KEY_PATTERN.test(input.key)) throw new Error('Demo route key must be 3 to 16 lowercase letters or digits.');
  if (input.name.trim() === '' || input.name.length > 80) throw new Error('Demo route name must have 1 to 80 characters.');
  if (input.planDate !== undefined && !PLAN_DATE_PATTERN.test(input.planDate)) throw new Error('Demo route plan date must be YYYY-MM-DD.');
  const gaps = findTemplateAddressGaps(PRIVATE_DRIVER_DEMO_TEMPLATES[input.template]);
  if (gaps.length > 0) throw new Error(`Demo route template is incomplete for the driver app: ${gaps.join(', ')}.`);
}

export function privateDriverDemoRouteIds(shopId: string, key: string, stopCount: number): RouteIds {
  const id = (name: string) => deterministicId(shopId, name);
  return {
    routePlanId: id(`${key}:route`),
    groupingId: id(`${key}:group`),
    groupingVersionId: id(`${key}:parent`),
    childVersionId: id(`${key}:child`),
    geometryId: id(`${key}:geometry`),
    stops: Array.from({ length: stopCount }, (_, index) => ({
      sequence: index + 1,
      orderId: id(`${key}:${index}:order`),
      deliveryStopId: id(`${key}:${index}:stop`),
      routePlanStopId: id(`${key}:${index}:route-stop`),
      groupingOrderId: id(`${key}:${index}:group-order`)
    }))
  };
}

async function readDemoBase(db: DemoDb, config: { accountId: string; shopId: string }) {
  const shop = await db.shop.findUnique({ where: { id: config.shopId } });
  if (shop === null || shop.appId !== KFOOD_PRIVATE_DEMO_APP_ID || shop.shopDomain !== KFOOD_PRIVATE_DEMO_SHOP_DOMAIN) {
    throw new Error('Private demo shop is missing or does not match its reserved scope.');
  }
  if (shop.adminAccessTokenCiphertext !== null || shop.adminRefreshTokenCiphertext !== null || shop.shopifyShopGid !== null
    || shop.tokenScopes.length > 0) throw new Error('Private demo shop must not hold admin credentials.');
  const email = asObject(shop.customerEmailSettings);
  if (asObject(email?.automatic)?.enabled !== false
    || Object.values(asObject(email?.templates) ?? {}).some((template) => asObject(template)?.enabled !== false)) {
    throw new Error('Private demo shop must keep customer email disabled.');
  }
  const account = await db.driverAccount.findUnique({ where: { id: config.accountId }, select: { status: true } });
  if (account?.status !== 'ACTIVE') throw new Error('Private demo account is not active.');
  const drivers = await db.driver.findMany({ where: { shopId: config.shopId } });
  const driver = drivers[0];
  if (drivers.length !== 1 || driver === undefined || driver.accountId !== config.accountId || driver.status !== 'ACTIVE'
    || driver.phone !== null || driver.inviteCode !== null) throw new Error('Private demo requires its one exact driver.');
  const where = { shopId: config.shopId };
  const forbidden = await Promise.all([db.commerceConnection.count({ where }), db.customer.count({ where }),
    db.customerAccount.count({ where }), db.deliveryCustomerProfile.count({ where }), db.customerRouteNotificationFact.count({ where }),
    db.customerDeliveryNotificationAttempt.count({ where }), db.orderMessage.count({ where })]);
  if (forbidden.some((count) => count !== 0)) throw new Error('Private demo shop holds customer data or messages.');
  return { driver, shop };
}

export async function readPrivateDriverDemoRouteState(
  prisma: PrismaClient,
  input: Pick<PrivateDriverDemoRouteInput, 'key'>
): Promise<PrivateDriverDemoRouteState> {
  const config = requireConfig();
  const ids = privateDriverDemoRouteIds(config.shopId, input.key, 0);
  const route = await prisma.routePlan.findFirst({ where: { id: ids.routePlanId, shopId: config.shopId }, select: { id: true } });
  if (route === null) return 'absent';
  const child = await prisma.routeGroupingChildVersion.findFirst({ where: { id: ids.childVersionId, shopId: config.shopId }, select: { publishedAt: true } });
  return child?.publishedAt == null ? 'unpublished' : 'published';
}

/** Creates one unpublished synthetic route. Re-running with the same key verifies and returns UNCHANGED. */
export async function createPrivateDriverDemoRoute(prisma: PrismaClient, input: PrivateDriverDemoRouteInput, now = new Date()) {
  assertPrivateDriverDemoRouteInput(input);
  const config = requireConfig();
  const template = PRIVATE_DRIVER_DEMO_TEMPLATES[input.template];
  const ids = privateDriverDemoRouteIds(config.shopId, input.key, template.stops.length);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${SCHEMA + config.shopId}, 0))`;
    await assertShopifyShopPrivacyWriteAllowed(tx, { appId: KFOOD_PRIVATE_DEMO_APP_ID, shopDomain: KFOOD_PRIVATE_DEMO_SHOP_DOMAIN });
    await tx.$queryRaw`SELECT id FROM driver_accounts WHERE id = ${config.accountId}::uuid FOR SHARE`;
    const { driver } = await readDemoBase(tx, config);
    const existing = await tx.routePlan.findFirst({
      where: { id: ids.routePlanId, shopId: config.shopId },
      select: { assignmentGeneration: true, constraints: true, driverId: true, name: true, status: true, routeStops: { select: { id: true } } }
    });
    if (existing !== null) {
      const constraints = asObject(existing.constraints);
      if (existing.name !== input.name || existing.driverId !== driver.id || existing.status !== 'READY' || existing.assignmentGeneration !== 2n
        || existing.routeStops.length !== template.stops.length || constraints?.privateDriverDemoSeed !== SCHEMA) {
        throw new Error('Private demo route exists with different content. Refusing repair, overwrite or reset.');
      }
      return { status: 'UNCHANGED' as const, routePlanId: ids.routePlanId, stops: template.stops.length };
    }
    if (template.proof) assertProofRollout({ photoRequired: true, signatureRequired: true });
    const planDate = new Date(`${input.planDate ?? new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)}T00:00:00.000Z`);
    const deliveryProof = { photoRequired: template.proof, signatureRequired: template.proof };
    const constraints = { timezone: TIMEZONE, routeEndMode: 'END_AT_LAST_STOP', tollPolicy: 'ALLOW_TOLLS', deliveryProof, privateDriverDemoSeed: SCHEMA };
    await tx.routeGrouping.create({ data: { id: ids.groupingId, shopId: config.shopId, name: input.name, planDate, createdBy: SCHEMA } });
    await tx.routeGroupingVersion.create({ data: { id: ids.groupingVersionId, shopId: config.shopId, groupingId: ids.groupingId, version: 1, status: 'CURRENT', actor: SCHEMA } });
    await tx.routePlan.create({ data: {
      id: ids.routePlanId, shopId: config.shopId, name: input.name, planDate, status: 'READY', optimizerVersion: 'synthetic-demo-v1',
      constraints, metrics: {}, createdBy: SCHEMA, depotLatitude: DEPOT.latitude, depotLongitude: DEPOT.longitude
    } });
    for (const [index, definition] of template.stops.entries()) {
      const stop = ids.stops[index]!;
      await tx.order.create({ data: {
        id: stop.orderId, shopId: config.shopId, name: `DEMO-${input.key.toUpperCase()}-${stop.sequence}`,
        shopifyOrderGid: `custom:private-demo:${stop.orderId}`, sourcePlatform: 'CUSTOM', sourceOrderId: stop.orderId,
        ownedRouteGroupingId: ids.groupingId, rawPayload: orderPayload(definition.gateway),
        financialStatus: template.proof ? 'PAID' : 'PENDING', totalPriceAmount: definition.amount,
        currencyCode: 'CAD', deliveryStatus: 'ASSIGNED', serviceDate: planDate
      } });
      await tx.deliveryStop.create({ data: {
        id: stop.deliveryStopId, shopId: config.shopId, orderId: stop.orderId,
        recipientName: `DEMO ONLY · ${definition.label}`, address1: definition.address,
        city: PRIVATE_DRIVER_DEMO_CITY, province: PRIVATE_DRIVER_DEMO_PROVINCE, countryCode: PRIVATE_DRIVER_DEMO_COUNTRY_CODE,
        postalCode: definition.postalCode, latitude: definition.latitude, longitude: definition.longitude,
        geocodeStatus: 'RESOLVED', deliveryDate: planDate, status: 'ASSIGNED',
        instructions: 'Synthetic test only. No customer, no contact, no delivery or payment is owed.'
      } });
      await tx.routeGroupingOrder.create({ data: {
        id: stop.groupingOrderId, shopId: config.shopId, groupingId: ids.groupingId, orderId: stop.orderId,
        deliveryStopId: stop.deliveryStopId, sourceSequence: stop.sequence, assignmentStatus: 'ASSIGNED', assignedDriverId: driver.id
      } });
    }
    await tx.routePlan.update({ where: { id: ids.routePlanId }, data: { driverId: driver.id, assignmentGeneration: 2n } });
    await assertProofDriverCompatible(tx, { constraints, driverId: driver.id }, config.shopId);
    // Assigned but NOT published: publishedAt stays null until Dispatch, so the driver app cannot see it yet.
    await tx.routeGroupingChildVersion.create({ data: {
      id: ids.childVersionId, shopId: config.shopId, groupingId: ids.groupingId, groupingVersionId: ids.groupingVersionId,
      routePlanId: ids.routePlanId, driverId: driver.id, version: 1, status: 'CURRENT', notificationStatus: 'SKIPPED', publishedAt: null,
      snapshot: { name: input.name, membershipSchemaVersion: 1, stops: ids.stops.map((stop) => ({
        orderId: stop.orderId, deliveryStopId: stop.deliveryStopId, sequence: stop.sequence
      })) }
    } });
    await tx.order.updateMany({ where: { id: { in: ids.stops.map((stop) => stop.orderId) }, shopId: config.shopId }, data: { currentRouteVersionId: ids.childVersionId } });
    await tx.routePlanStop.createMany({ data: ids.stops.map((stop) => ({
      id: stop.routePlanStopId, shopId: config.shopId, routePlanId: ids.routePlanId, deliveryStopId: stop.deliveryStopId,
      sequence: stop.sequence, etaInputRouteVersionId: ids.childVersionId, etaStatus: 'PENDING' as const
    })) });
    const geometryStops = ids.stops.map((stop, index) => ({ ...stop, coordinates: {
      latitude: template.stops[index]!.latitude, longitude: template.stops[index]!.longitude
    } }));
    // Clearly synthetic straight lines. No route engine, network request, or road-accuracy claim.
    await tx.routePlanGeometryCache.create({ data: {
      id: ids.geometryId, routePlanId: ids.routePlanId, provider: 'synthetic-demo-straight-lines', source: 'SNAPSHOT', overview: 'full',
      shapeSignature: computeRouteShapeSignatureFromParts({ depot: DEPOT, routeEndMode: 'END_AT_LAST_STOP', stops: geometryStops }),
      geometry: { type: 'LineString', coordinates: [[DEPOT.longitude, DEPOT.latitude], ...geometryStops.map((stop) => [stop.coordinates.longitude, stop.coordinates.latitude])] },
      metrics: { distanceMeters: null, durationSeconds: null }, stopPoints: geometryStops.map((stop) => ({
        deliveryStopId: stop.deliveryStopId, sequence: stop.sequence, name: 'Synthetic demo', shopifyOrderGid: `custom:private-demo:${stop.orderId}`,
        inputCoordinates: [stop.coordinates.longitude, stop.coordinates.latitude], snappedCoordinates: null, snapDistanceMeters: null
      }))
    } });
    return { status: 'CREATED' as const, routePlanId: ids.routePlanId, stops: template.stops.length };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 });
}

export type PrivateDriverDemoDispatchSummary = {
  appAddressContractOk: boolean;
  attempts: Array<{ action: string; errorCode: string | null; provider: string; status: string }>;
  dispatchReserved: boolean;
  exposedInRouteList: boolean;
  groupingStatus: string | null;
  notificationErrorCode: string | null;
  notificationStatus: string;
  publishedAt: string | null;
  pushProvider: string;
  routeState: PrivateDriverDemoRouteState;
};

/** Publishes a created route through the admin Dispatch services, sends the route push, then reads it back like the app. */
export async function dispatchPrivateDriverDemoRoute(
  prisma: PrismaClient,
  pushProvider: DriverPushProvider,
  input: PrivateDriverDemoRouteInput,
  options: { allowDisabledProvider?: boolean } = {}
): Promise<PrivateDriverDemoDispatchSummary> {
  assertPrivateDriverDemoRouteInput(input);
  const config = requireConfig();
  const template = PRIVATE_DRIVER_DEMO_TEMPLATES[input.template];
  const ids = privateDriverDemoRouteIds(config.shopId, input.key, template.stops.length);
  const { driver } = await readDemoBase(prisma, config);
  const state = await readPrivateDriverDemoRouteState(prisma, input);
  if (state === 'absent') throw new Error('Private demo route does not exist.');
  if (state === 'published') throw new Error('Private demo route is already published.');
  const route = await prisma.routePlan.findFirst({
    where: { id: ids.routePlanId, shopId: config.shopId },
    select: { assignmentGeneration: true, constraints: true, driverId: true, name: true, status: true, routeStops: { select: { id: true } } }
  });
  if (route === null || route.name !== input.name || route.driverId !== driver.id || route.status !== 'READY' || route.assignmentGeneration !== 2n
    || route.routeStops.length !== template.stops.length || asObject(route.constraints)?.privateDriverDemoSeed !== SCHEMA) {
    throw new Error('Private demo route is not in its created state.');
  }
  const priorAttempts = await prisma.driverRouteNotificationAttempt.count({ where: { routePlanId: ids.routePlanId } });
  if (priorAttempts !== 0) throw new Error('Private demo route already has notification attempts.');
  const storedStops = await prisma.deliveryStop.findMany({
    where: { shopId: config.shopId, routePlanStops: { some: { routePlanId: ids.routePlanId } } },
    select: { address1: true, city: true, countryCode: true, postalCode: true, province: true }
  });
  if (storedStops.length !== template.stops.length || storedStops.some((stop) => findDriverAppAddressGaps(stop).length > 0)) {
    throw new Error('Private demo stop address is incomplete for the driver app.');
  }
  if (pushProvider.providerName === 'disabled' && options.allowDisabledProvider !== true) throw new Error('Driver push provider is not configured.');
  const tokens = await prisma.driverPushToken.count({ where: { accountId: config.accountId, status: 'ACTIVE' } });
  if (tokens === 0 && options.allowDisabledProvider !== true) throw new Error('The demo account has no active push token.');

  const routePlans = new PrismaRoutePlanRepository(prisma);
  const grouping = new PrismaRouteGroupingService(prisma, pushProvider);
  const published = await routePlans.publishRoutePlan({
    appId: KFOOD_PRIVATE_DEMO_APP_ID, routePlanId: ids.routePlanId, shopDomain: KFOOD_PRIVATE_DEMO_SHOP_DOMAIN
  });
  if (published === null) throw new Error('Publishing the demo route plan returned nothing.');
  const notification = await grouping.recordChildRoutePublished({ routePlanId: ids.routePlanId, shopDomain: KFOOD_PRIVATE_DEMO_SHOP_DOMAIN });

  // Exposure self-check: the route list and the assigned route, read the way the driver app reads them.
  const list = await new PrismaDriverRouteAccessRepository(prisma).lookupRouteAccess({ accountId: config.accountId, routeContext: null });
  const exposedInRouteList = list.status === 'ROUTES_FOUND'
    && list.routes.some((candidate) => candidate.routeAccess.routePlanId === ids.routePlanId && candidate.status === 'INVITED');
  const assigned = await new PrismaDriverAssignedRouteRepository(prisma).getAssignedRoute({
    driverId: driver.id, routeContext: ids.routePlanId, shopDomain: KFOOD_PRIVATE_DEMO_SHOP_DOMAIN, shopId: config.shopId
  });
  const appAddressContractOk = assigned.status === 'ASSIGNED_ROUTE' && assigned.route.stops.length === template.stops.length
    && assigned.route.stops.every((stop) => findDriverAppAddressGaps(stop.address).length === 0);
  const after = await prisma.routePlan.findFirst({ where: { id: ids.routePlanId, shopId: config.shopId }, select: { constraints: true } });
  const attempts = await prisma.driverRouteNotificationAttempt.findMany({
    where: { routePlanId: ids.routePlanId }, select: { action: true, errorCode: true, provider: true, status: true }
  });
  const groupingRow = await prisma.routeGrouping.findUnique({ where: { id: ids.groupingId }, select: { status: true } });
  return {
    appAddressContractOk,
    attempts: attempts.map((attempt) => ({ ...attempt, action: String(attempt.action), status: String(attempt.status) })),
    dispatchReserved: typeof asObject(after?.constraints)?.cleverDispatchReservedAt === 'string',
    exposedInRouteList,
    groupingStatus: groupingRow === null ? null : String(groupingRow.status),
    notificationErrorCode: notification.errorCode ?? null,
    notificationStatus: notification.status,
    publishedAt: notification.publishedAt ?? null,
    pushProvider: pushProvider.providerName,
    routeState: await readPrivateDriverDemoRouteState(prisma, input)
  };
}

type ForeignKeyRow = {
  child: string;
  child_cols: string[];
  del: string;
  name: string;
  parent: string;
  parent_cols: string[];
};

export type PrivateDriverDemoTeardownResult = {
  deleted: Record<string, number>;
  dryRun: boolean;
  remaining: Record<string, number>;
  snapshotRowCounts: Record<string, number>;
};

const TEARDOWN_KEEP = new Set(['shops', 'drivers']);
const SNAPSHOT_TABLES = ['route_plans', 'orders', 'delivery_stops', 'route_grouping_child_versions', 'driver_stop_completion_receipts',
  'driver_route_notification_attempts', 'driver_consent_records', 'driver_completion_runs', 'driver_route_session_leases', 'driver_sync_sessions'];

/**
 * Removes every synthetic route row of the private demo shop and keeps the shop row, the demo driver row and all
 * accounts and sessions. A dry run performs the deletes and rolls them back. `writeEvidence` receives a private
 * snapshot before any delete.
 */
export async function teardownPrivateDriverDemo(
  prisma: PrismaClient,
  options: { dryRun: boolean; writeEvidence: (snapshot: Record<string, unknown>) => Promise<void> }
): Promise<PrivateDriverDemoTeardownResult> {
  const config = requireConfig();
  await readDemoBaseWithoutCustomerCheck(prisma, config);
  const routes = await prisma.routePlan.findMany({ where: { shopId: config.shopId }, select: { constraints: true } });
  if (routes.some((route) => {
    const marker = asObject(route.constraints)?.privateDriverDemoSeed;
    return typeof marker !== 'string' || !marker.startsWith('kfood_private_driver_demo_');
  })) throw new Error('The private demo shop holds a route that is not a synthetic demo route.');

  const scopedTables = (await prisma.$queryRaw<Array<{ t: string }>>`
    SELECT DISTINCT table_name AS t FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'shopId' ORDER BY 1`).map((row) => row.t);
  const roots = scopedTables.filter((table) => !TEARDOWN_KEEP.has(table));
  const foreignKeys = await prisma.$queryRaw<ForeignKeyRow[]>`
    SELECT c.conname AS name, cl.relname AS child, pl.relname AS parent, c.confdeltype::text AS del,
      (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS child_cols,
      (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.confkey) WITH ORDINALITY k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum) AS parent_cols
    FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid JOIN pg_class pl ON pl.oid = c.confrelid
    WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace`;
  const blockingByParent = new Map<string, ForeignKeyRow[]>();
  for (const key of foreignKeys) {
    if (key.del !== 'a' && key.del !== 'r') continue; // cascade and set null are handled by the database
    blockingByParent.set(key.parent, [...(blockingByParent.get(key.parent) ?? []), key]);
  }
  const quote = (name: string) => `"${name.replace(/"/gu, '""')}"`;
  const countRows = async (db: Pick<PrismaClient, '$queryRawUnsafe'>): Promise<Record<string, number>> => {
    const result: Record<string, number> = {};
    for (const table of scopedTables) {
      const rows = await db.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM ${quote(table)} WHERE "shopId" = $1::uuid`, config.shopId);
      if ((rows[0]?.n ?? 0) > 0) result[table] = rows[0]!.n;
    }
    return result;
  };
  const before = await countRows(prisma);
  const snapshot: Record<string, unknown> = { takenAt: new Date().toISOString(), shopId: config.shopId, counts: before, tables: {} };
  for (const table of SNAPSHOT_TABLES) {
    if ((before[table] ?? 0) === 0 || before[table]! > 500) continue;
    const rows = await prisma.$queryRawUnsafe<unknown[]>(`SELECT * FROM ${quote(table)} WHERE "shopId" = $1::uuid`, config.shopId);
    (snapshot.tables as Record<string, unknown>)[table] = JSON.parse(JSON.stringify(rows, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value));
  }
  await options.writeEvidence(snapshot);

  const deleted: Record<string, number> = {};
  // Manual cascade for NO ACTION / RESTRICT foreign keys: delete blocking child rows first, depth first.
  const purge = async (tx: Prisma.TransactionClient, table: string, predicate: string, path: string[]): Promise<void> => {
    if (path.length > 10) throw new Error('Foreign key depth exceeded while removing demo rows.');
    for (const key of blockingByParent.get(table) ?? []) {
      if (path.includes(key.child) || key.child === table) continue;
      const childCols = key.child_cols.map(quote).join(', ');
      const parentCols = key.parent_cols.map(quote).join(', ');
      await purge(tx, key.child, `(${childCols}) IN (SELECT ${parentCols} FROM ${quote(table)} WHERE ${predicate})`, [...path, table]);
    }
    const count = await tx.$executeRawUnsafe(`DELETE FROM ${quote(table)} WHERE ${predicate}`, config.shopId);
    if (count > 0) deleted[table] = (deleted[table] ?? 0) + count;
  };
  const rollback = new Error('dry run rollback');
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'private-demo-teardown' + config.shopId}, 0))`;
      for (const table of roots) await purge(tx, table, '"shopId" = $1::uuid', []);
      const left = await countRows(tx);
      if (Object.keys(left).some((table) => !TEARDOWN_KEEP.has(table))) throw new Error('Demo rows remain after the removal.');
      if (options.dryRun) throw rollback;
    }, { timeout: 120_000, maxWait: 10_000 });
  } catch (error) {
    if (error !== rollback) throw error;
  }
  return { deleted, dryRun: options.dryRun, remaining: await countRows(prisma), snapshotRowCounts: before };
}

async function readDemoBaseWithoutCustomerCheck(prisma: PrismaClient, config: { accountId: string; shopId: string }): Promise<void> {
  const shop = await prisma.shop.findUnique({ where: { id: config.shopId } });
  if (shop === null || shop.appId !== KFOOD_PRIVATE_DEMO_APP_ID || shop.shopDomain !== KFOOD_PRIVATE_DEMO_SHOP_DOMAIN) {
    throw new Error('Private demo shop is missing or does not match its reserved scope.');
  }
  if (shop.adminAccessTokenCiphertext !== null || shop.adminRefreshTokenCiphertext !== null || shop.shopifyShopGid !== null) {
    throw new Error('Private demo shop must not hold admin credentials.');
  }
  const drivers = await prisma.driver.findMany({ where: { shopId: config.shopId } });
  if (drivers.length !== 1 || drivers[0]!.accountId !== config.accountId) throw new Error('Private demo requires its one exact driver.');
}

function requireConfig(): { accountId: string; shopId: string } {
  const config = getPrivateDriverDemoConfig();
  if (config === null) throw new Error('Private demo requires both configured exact UUIDs.');
  return config;
}

function orderPayload(gateway: string): Prisma.InputJsonObject {
  return { schema: SCHEMA, synthetic: true, kind: 'CLEVER_CUSTOM_ROUTE_STOP', paymentGatewayNames: [gateway] };
}

function deterministicId(shopId: string, name: string): string {
  const bytes = createHash('sha1').update(`${SCHEMA}:${shopId}:${name}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
