import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { defaultCustomerEmailSettings } from '../customer-email/customer-email-settings.js';
import { assertProofDriverCompatible, assertProofRollout } from '../route-plans/delivery-options.js';
import { computeRouteShapeSignatureFromParts } from '../route-plans/route-plan-geometry-cache.js';
import { assertShopifyShopPrivacyWriteAllowed } from '../shopify/order-privacy-redaction.js';
import { getPrivateDriverDemoConfig, KFOOD_PRIVATE_DEMO_APP_ID, KFOOD_PRIVATE_DEMO_SHOP_DOMAIN } from './private-driver-demo.js';

const SCHEMA = 'kfood_private_driver_demo_seed_v1';
const TIMEZONE = 'America/Toronto';
const DEPOT = { latitude: 43.6534, longitude: -79.3841 };
const ROUTES = [
  { key: 'cash', name: 'PRIVATE DEMO A · Cash / eTransfer · Proof OFF', proof: false, stops: [
    { label: 'Nathan Phillips Square', address: '100 Queen Street West', postalCode: 'M5H 2N2', latitude: 43.6525, longitude: -79.3839, amount: '122.25', gateway: 'Cash' },
    { label: 'Osgoode Hall grounds', address: '130 Queen Street West', postalCode: 'M5H 2N6', latitude: 43.6515, longitude: -79.3855, amount: '40.00', gateway: 'Interac e-Transfer' },
    { label: 'Campbell House grounds', address: '160 Queen Street West', postalCode: 'M5H 3H3', latitude: 43.6508, longitude: -79.3873, amount: '20.00', gateway: 'Cash' }
  ] },
  { key: 'proof', name: 'PRIVATE DEMO B · Photo + Signature ON', proof: true, stops: [
    { label: 'Toronto City Hall grounds', address: '100 Queen Street West', postalCode: 'M5H 2N2', latitude: 43.6534, longitude: -79.3841, amount: '10.00', gateway: 'Prepaid' },
    { label: 'Trinity Square', address: '10 Trinity Square', postalCode: 'M5G 1B1', latitude: 43.6542, longitude: -79.3816, amount: '15.00', gateway: 'Prepaid' }
  ] }
] as const;

export type PrivateDriverDemoManifest = ReturnType<typeof buildManifest>;

/** Contains private IDs. The CLI writes it only to an explicitly requested private file. */
function buildManifest(config: { shopId: string; accountId: string }) {
  const id = (name: string) => deterministicId(config.shopId, name);
  return {
    schema: SCHEMA, shopId: config.shopId, accountId: config.accountId, driverId: id('driver'),
    routes: ROUTES.map(route => ({
      key: route.key, routePlanId: id(`${route.key}:route`), groupingId: id(`${route.key}:group`),
      groupingVersionId: id(`${route.key}:parent`), childVersionId: id(`${route.key}:child`),
      geometryId: id(`${route.key}:geometry`), stops: route.stops.map((_, index) => ({
        sequence: index + 1, orderId: id(`${route.key}:${index}:order`), deliveryStopId: id(`${route.key}:${index}:stop`),
        routePlanStopId: id(`${route.key}:${index}:route-stop`), groupingOrderId: id(`${route.key}:${index}:group-order`)
      }))
    }))
  };
}

/** No provider, notification, account mutation, real-shop mutation, or cleanup side effect. */
export async function seedPrivateDriverDemo(prisma: PrismaClient, input: { apply?: boolean; now?: Date } = {}) {
  const config = getPrivateDriverDemoConfig();
  if (config === null) throw new Error('Private demo requires both configured exact UUIDs.');
  const manifest = buildManifest(config);
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid private demo seed time.');
  assertProofRollout({ photoRequired: true, signatureRequired: true });

  return prisma.$transaction(async tx => {
    // Serialize this seed and keep the existing account active for the entire transaction.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${SCHEMA + config.shopId}, 0))`;
    await assertShopifyShopPrivacyWriteAllowed(tx, { appId: KFOOD_PRIVATE_DEMO_APP_ID, shopDomain: KFOOD_PRIVATE_DEMO_SHOP_DOMAIN });
    await tx.$queryRaw`SELECT id FROM driver_accounts WHERE id = ${config.accountId}::uuid FOR SHARE`;
    const account = await tx.driverAccount.findUnique({ where: { id: config.accountId }, select: {
      status: true, tokenVersion: true, isStoreReviewAccount: true,
      sessions: { where: { revokedAt: null, expiresAt: { gt: now } }, select: {
        deliveryProofCapability: true, capabilityPackageId: true, capabilityVersionCode: true, capabilityTokenVersion: true
      } }
    } });
    if (account === null || account.status !== 'ACTIVE' || account.isStoreReviewAccount) {
      throw new Error('Private demo requires the configured active ordinary driver account.');
    }
    if (!account.sessions.some(session => session.deliveryProofCapability === 'delivery-proof-v1'
      && session.capabilityPackageId === 'com.evnsolution.clever.routes' && (session.capabilityVersionCode ?? 0) >= 43
      && session.capabilityTokenVersion === account.tokenVersion)) {
      throw new Error('Private demo requires a current production driver session with delivery-proof-v1, versionCode 43 or newer.');
    }
    const shops = await tx.shop.findMany({ where: { OR: [{ id: config.shopId }, { appId: KFOOD_PRIVATE_DEMO_APP_ID }] } });
    if (shops.length > 0) {
      if (shops.length !== 1 || shops[0]!.id !== config.shopId || shops[0]!.appId !== KFOOD_PRIVATE_DEMO_APP_ID
        || shops[0]!.shopDomain !== KFOOD_PRIVATE_DEMO_SHOP_DOMAIN) throw mismatch();
      await assertUnchangedSeed(tx, manifest, shops[0]!);
      return { status: 'UNCHANGED' as const, applied: false, routeCount: 2, stopCount: 5, manifest };
    }
    if (input.apply !== true) return { status: 'WOULD_CREATE' as const, applied: false, routeCount: 2, stopCount: 5, manifest };

    const email = defaultCustomerEmailSettings();
    for (const template of Object.values(email.templates)) template.enabled = false;
    const planDate = new Date(`${new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)}T00:00:00.000Z`);
    await tx.shop.create({ data: {
      id: config.shopId, appId: KFOOD_PRIVATE_DEMO_APP_ID, shopDomain: KFOOD_PRIVATE_DEMO_SHOP_DOMAIN,
      locale: 'en-CA', defaultDepotAddress: 'Synthetic demo · Toronto City Hall grounds',
      defaultDepotLatitude: DEPOT.latitude, defaultDepotLongitude: DEPOT.longitude,
      customerEmailSettings: email,
      routeOpsUiSettings: { privateDriverDemoSeed: manifest, seededAt: now.toISOString() }
    } });
    await tx.driver.create({ data: {
      id: manifest.driverId, shopId: config.shopId, accountId: config.accountId,
      displayName: 'Private demo driver', authSubject: `${SCHEMA}:${config.shopId}`, status: 'ACTIVE'
    } });

    for (const [index, definition] of ROUTES.entries()) {
      const route = manifest.routes[index]!;
      const deliveryProof = { photoRequired: definition.proof, signatureRequired: definition.proof };
      const constraints = { timezone: TIMEZONE, routeEndMode: 'END_AT_LAST_STOP', tollPolicy: 'ALLOW_TOLLS', deliveryProof, privateDriverDemoSeed: SCHEMA };
      await tx.routeGrouping.create({ data: { id: route.groupingId, shopId: config.shopId, name: definition.name, planDate, createdBy: SCHEMA } });
      await tx.routeGroupingVersion.create({ data: { id: route.groupingVersionId, shopId: config.shopId, groupingId: route.groupingId, version: 1, status: 'CURRENT', actor: SCHEMA } });
      // Persist all options while the route is unassigned and unpublished.
      await tx.routePlan.create({ data: {
        id: route.routePlanId, shopId: config.shopId, name: definition.name, planDate, status: 'READY',
        optimizerVersion: 'synthetic-demo-v1', constraints, metrics: {}, createdBy: SCHEMA,
        depotLatitude: DEPOT.latitude, depotLongitude: DEPOT.longitude
      } });
      for (const [stopIndex, stopDefinition] of definition.stops.entries()) {
        const stop = route.stops[stopIndex]!;
        await tx.order.create({ data: {
          id: stop.orderId, shopId: config.shopId, name: `DEMO-${definition.key.toUpperCase()}-${stop.sequence}`,
          shopifyOrderGid: `custom:private-demo:${stop.orderId}`, sourcePlatform: 'CUSTOM', sourceOrderId: stop.orderId,
          ownedRouteGroupingId: route.groupingId, rawPayload: orderPayload(stopDefinition.gateway),
          financialStatus: definition.proof ? 'PAID' : 'PENDING', totalPriceAmount: stopDefinition.amount,
          currencyCode: 'CAD', deliveryStatus: 'ASSIGNED', serviceDate: planDate
        } });
        await tx.deliveryStop.create({ data: {
          id: stop.deliveryStopId, shopId: config.shopId, orderId: stop.orderId,
          recipientName: `DEMO ONLY · ${stopDefinition.label}`, address1: stopDefinition.address,
          city: 'Toronto', province: 'Ontario', countryCode: 'CA', postalCode: stopDefinition.postalCode, latitude: stopDefinition.latitude,
          longitude: stopDefinition.longitude, geocodeStatus: 'RESOLVED', deliveryDate: planDate, status: 'ASSIGNED',
          instructions: 'Synthetic test only. No customer, no contact, no delivery or payment is owed.'
        } });
        await tx.routeGroupingOrder.create({ data: {
          id: stop.groupingOrderId, shopId: config.shopId, groupingId: route.groupingId, orderId: stop.orderId,
          deliveryStopId: stop.deliveryStopId, sourceSequence: stop.sequence, assignmentStatus: 'ASSIGNED', assignedDriverId: manifest.driverId
        } });
      }
      await tx.routePlan.update({ where: { id: route.routePlanId }, data: { driverId: manifest.driverId, assignmentGeneration: 2n } });
      await assertProofDriverCompatible(tx, { constraints, driverId: manifest.driverId }, config.shopId);
      await tx.routeGroupingChildVersion.create({ data: {
        id: route.childVersionId, shopId: config.shopId, groupingId: route.groupingId,
        groupingVersionId: route.groupingVersionId, routePlanId: route.routePlanId, driverId: manifest.driverId,
        version: 1, status: 'CURRENT', notificationStatus: 'SKIPPED', publishedAt: now,
        snapshot: { name: definition.name, membershipSchemaVersion: 1, stops: route.stops.map(stop => ({
          orderId: stop.orderId, deliveryStopId: stop.deliveryStopId, sequence: stop.sequence
        })) }
      } });
      await tx.order.updateMany({ where: { id: { in: route.stops.map(stop => stop.orderId) }, shopId: config.shopId }, data: { currentRouteVersionId: route.childVersionId } });
      await tx.routePlanStop.createMany({ data: route.stops.map(stop => ({
        id: stop.routePlanStopId, shopId: config.shopId, routePlanId: route.routePlanId, deliveryStopId: stop.deliveryStopId,
        sequence: stop.sequence, etaInputRouteVersionId: route.childVersionId, etaStatus: 'PENDING'
      })) });
      await tx.routePlan.update({ where: { id: route.routePlanId }, data: { constraints: { ...constraints, publishedAt: now.toISOString() } } });
      const geometryStops = route.stops.map((stop, stopIndex) => ({ ...stop, coordinates: {
        latitude: definition.stops[stopIndex]!.latitude, longitude: definition.stops[stopIndex]!.longitude
      } }));
      // Clearly synthetic straight lines. No route engine, network request, or road-accuracy claim.
      await tx.routePlanGeometryCache.create({ data: {
        id: route.geometryId, routePlanId: route.routePlanId, provider: 'synthetic-demo-straight-lines', source: 'SNAPSHOT', overview: 'full',
        shapeSignature: computeRouteShapeSignatureFromParts({ depot: DEPOT, routeEndMode: 'END_AT_LAST_STOP', stops: geometryStops }),
        geometry: { type: 'LineString', coordinates: [[DEPOT.longitude, DEPOT.latitude], ...geometryStops.map(stop => [stop.coordinates.longitude, stop.coordinates.latitude])] },
        metrics: { distanceMeters: null, durationSeconds: null }, stopPoints: geometryStops.map(stop => ({
          deliveryStopId: stop.deliveryStopId, sequence: stop.sequence, name: 'Synthetic demo', shopifyOrderGid: `custom:private-demo:${stop.orderId}`,
          inputCoordinates: [stop.coordinates.longitude, stop.coordinates.latitude], snappedCoordinates: null, snapDistanceMeters: null
        }))
      } });
    }
    await assertUnchangedSeed(tx, manifest, await tx.shop.findUniqueOrThrow({ where: { id: config.shopId } }));
    return { status: 'CREATED' as const, applied: true, routeCount: 2, stopCount: 5, manifest };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 });
}

async function assertUnchangedSeed(tx: Prisma.TransactionClient, manifest: PrivateDriverDemoManifest, shop: {
  routeOpsUiSettings: Prisma.JsonValue; customerEmailSettings: Prisma.JsonValue; adminAccessTokenCiphertext: string | null;
  adminRefreshTokenCiphertext: string | null; shopifyShopGid: string | null; tokenScopes: string[];
}) {
  const settings = object(shop.routeOpsUiSettings);
  const email = object(shop.customerEmailSettings);
  if (!same(settings?.privateDriverDemoSeed, manifest) || shop.adminAccessTokenCiphertext !== null
    || shop.adminRefreshTokenCiphertext !== null || shop.shopifyShopGid !== null || shop.tokenScopes.length > 0
    || object(email?.automatic)?.enabled !== false || Object.values(object(email?.templates) ?? {}).some(template => object(template)?.enabled !== false)) throw mismatch();
  const where = { shopId: manifest.shopId };
  const [drivers, routes, orders, stops, groups, parents, children, memberships, routeStops, geometry, forbidden] = await Promise.all([
    tx.driver.findMany({ where }), tx.routePlan.findMany({ where }), tx.order.findMany({ where }), tx.deliveryStop.findMany({ where }),
    tx.routeGrouping.findMany({ where }), tx.routeGroupingVersion.findMany({ where }), tx.routeGroupingChildVersion.findMany({ where }),
    tx.routeGroupingOrder.findMany({ where }), tx.routePlanStop.findMany({ where }),
    tx.routePlanGeometryCache.findMany({ where: { routePlanId: { in: manifest.routes.map(route => route.routePlanId) } }, select: { id: true, routePlanId: true } }),
    Promise.all([tx.commerceConnection.count({ where }), tx.customer.count({ where }), tx.customerAccount.count({ where }),
      tx.deliveryCustomerProfile.count({ where }), tx.driverEvent.count({ where }), tx.driverRouteNotificationAttempt.count({ where }),
      tx.customerRouteNotificationFact.count({ where }), tx.customerDeliveryNotificationAttempt.count({ where }), tx.orderMessage.count({ where })])
  ]);
  if (forbidden.some(count => count !== 0) || drivers.length !== 1 || drivers[0]!.id !== manifest.driverId
    || drivers[0]!.accountId !== manifest.accountId || drivers[0]!.status !== 'ACTIVE' || drivers[0]!.phone !== null
    || drivers[0]!.authSubject !== `${SCHEMA}:${manifest.shopId}` || drivers[0]!.inviteCode !== null
    || routes.length !== 2 || orders.length !== 5 || stops.length !== 5 || groups.length !== 2 || parents.length !== 2
    || children.length !== 2 || memberships.length !== 5 || routeStops.length !== 5 || geometry.length !== 2) throw mismatch();
  for (const [index, expected] of manifest.routes.entries()) {
    const definition = ROUTES[index]!;
    const route = routes.find(item => item.id === expected.routePlanId);
    const constraints = object(route?.constraints);
    const child = children.find(item => item.id === expected.childVersionId);
    if (route === undefined || route.driverId !== manifest.driverId || route.status !== 'READY' || route.assignmentGeneration !== 2n
      || constraints?.privateDriverDemoSeed !== SCHEMA || constraints.tollPolicy !== 'ALLOW_TOLLS'
      || route.name !== definition.name || constraints.timezone !== TIMEZONE || constraints.routeEndMode !== 'END_AT_LAST_STOP'
      || !same(constraints.deliveryProof, { photoRequired: definition.proof, signatureRequired: definition.proof })
      || child?.driverId !== manifest.driverId || child.routePlanId !== route.id || child.status !== 'CURRENT'
      || child.supersededAt !== null || child.publishedAt === null || child.notificationStatus !== 'SKIPPED'
      || child.groupingId !== expected.groupingId || child.groupingVersionId !== expected.groupingVersionId
      || !same(object(child.snapshot)?.stops, expected.stops.map(stop => ({ orderId: stop.orderId, deliveryStopId: stop.deliveryStopId, sequence: stop.sequence })))
      || !geometry.some(cache => cache.id === expected.geometryId && cache.routePlanId === route.id)
      || !groups.some(group => group.id === expected.groupingId) || !parents.some(parent => parent.id === expected.groupingVersionId && parent.groupingId === expected.groupingId)) throw mismatch();
    for (const [stopIndex, expectedStop] of expected.stops.entries()) {
      const definitionStop = definition.stops[stopIndex]!;
      const order = orders.find(item => item.id === expectedStop.orderId);
      const stop = stops.find(item => item.id === expectedStop.deliveryStopId);
      const membership = memberships.find(item => item.id === expectedStop.groupingOrderId);
      const routeStop = routeStops.find(item => item.id === expectedStop.routePlanStopId);
      if (order === undefined || order.email !== null || order.phone !== null || order.customerId !== null || order.destinationId !== null
        || order.shippingAddress !== null || order.sourceSiteUrl !== null
        || order.sourcePlatform !== 'CUSTOM' || order.currentRouteVersionId !== child.id || order.ownedRouteGroupingId !== expected.groupingId
        || order.deliveryStatus !== 'ASSIGNED' || order.currencyCode !== 'CAD' || order.totalPriceAmount?.toFixed(2) !== definitionStop.amount
        || order.financialStatus !== (definition.proof ? 'PAID' : 'PENDING') || !same(order.rawPayload, orderPayload(definitionStop.gateway))
        || stop === undefined || stop.orderId !== order.id || stop.phone !== null || stop.status !== 'ASSIGNED'
        || stop.address1 !== definitionStop.address || stop.postalCode !== definitionStop.postalCode
        || stop.latitude?.toNumber() !== definitionStop.latitude || stop.longitude?.toNumber() !== definitionStop.longitude
        || membership?.orderId !== order.id || membership.deliveryStopId !== stop.id || membership.groupingId !== expected.groupingId
        || membership.assignedDriverId !== manifest.driverId || membership.assignmentStatus !== 'ASSIGNED'
        || routeStop?.routePlanId !== route.id || routeStop.deliveryStopId !== stop.id || routeStop.sequence !== expectedStop.sequence) throw mismatch();
    }
  }
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
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function same(left: unknown, right: unknown): boolean {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : object(value) !== null ? Object.fromEntries(Object.entries(object(value)!).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}
function mismatch(): Error {
  return new Error('Private demo seed differs from its untouched manifest. Refusing repair, overwrite, reset, or deletion.');
}
