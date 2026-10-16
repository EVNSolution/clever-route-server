import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import { type Prisma, PrismaClient } from '@prisma/client';

import { PrismaDriverAssignedRouteRepository } from '../modules/driver/driver-assigned-route.repository.js';
import { dsvDestinationIdentity } from '../modules/dsv/dsv-destination-identity.js';
import { PrismaDsvDispatchImportService, type DsvDispatchImportSourceRow } from '../modules/dsv/dsv-dispatch-import.service.js';

// Hidden demo route for one DSV driver: every spelling of a few already-merged destinations, imported as
// store-review data so no DSV admin view lists it (docs/deployment/dsv-store-review-isolation.md).
// The driver app numbers stops per destinationId, so each merged place must come back as one stop.
// Classifying the account hides the driver's ordinary routes from that login until the flags are restored
// from the snapshot. Default is dry-run. --apply needs the dry-run fingerprint and a new snapshot path.

export const DEMO_CUSTOMER_CODE = 'CLEVER-REVIEW-VARIANT-DEMO';
// Review rows may not share an identity with a real destination (addStoreReviewIsolationIssues), so every
// name carries this prefix. The spelling variants after it are kept as they are.
export const DEMO_NAME_PREFIX = '데모 ';

export type VariantProfile = {
  canonicalName: string | null;
  createdAt: Date;
  id: string;
  mergedIntoProfileId: string | null;
  normalizedAddress: Prisma.JsonValue;
};

export type VariantGroup = { rootId: string; spellings: VariantProfile[] };

/** Groups merged profiles under their final survivor (merge chains included), most distinct spellings first. */
export function planVariantGroups(profiles: VariantProfile[], limit: number): VariantGroup[] {
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  const rootOf = (profile: VariantProfile): VariantProfile => {
    let current = profile;
    for (let depth = 0; current.mergedIntoProfileId !== null && depth < 10; depth += 1) {
      const next = byId.get(current.mergedIntoProfileId);
      if (next === undefined) break;
      current = next;
    }
    return current;
  };
  const groups = new Map<string, VariantProfile[]>();
  for (const profile of profiles) {
    const root = rootOf(profile);
    if (root.mergedIntoProfileId !== null) continue;
    groups.set(root.id, [...(groups.get(root.id) ?? []), profile]);
  }
  return [...groups.entries()]
    .map(([rootId, members]) => ({ rootId, spellings: uniqueSpellings(members) }))
    .filter((group) => group.spellings.length > 1 && hasCoordinates(group, byId))
    .sort((left, right) => nameVariants(right) - nameVariants(left)
      || right.spellings.length - left.spellings.length || left.rootId.localeCompare(right.rootId))
    .slice(0, limit);

  function hasCoordinates(group: VariantGroup, lookup: Map<string, VariantProfile>): boolean {
    return coordinatesOf(lookup.get(group.rootId)!) !== null;
  }
}

export function buildVariantRows(input: {
  conditionCode: string;
  driverName: string;
  groups: VariantGroup[];
  planDate: string;
  profiles: VariantProfile[];
}): Array<DsvDispatchImportSourceRow & { groupIndex: number }> {
  const byId = new Map(input.profiles.map((profile) => [profile.id, profile]));
  return input.groups.flatMap((group, groupIndex) => {
    const rootCoordinates = coordinatesOf(byId.get(group.rootId)!)!;
    return group.spellings.map((profile) => {
      const address = readAddress(profile.normalizedAddress);
      const coordinates = coordinatesOf(profile) ?? rootCoordinates;
      return { groupIndex, ...address, ...coordinates, destinationName: `${DEMO_NAME_PREFIX}${displayName(profile)}` };
    });
  }).map((row, index) => ({
    address: row.address,
    conditionCode: input.conditionCode,
    customerCode: DEMO_CUSTOMER_CODE,
    detailAddress: row.detailAddress,
    destinationName: row.destinationName,
    driverName: input.driverName,
    groupIndex: row.groupIndex,
    jibunAddress: row.jibunAddress,
    latitude: row.latitude,
    longitude: row.longitude,
    notes: null,
    postalCode: row.postalCode,
    rowNumber: index + 2,
    sellerOrderKey: `REVIEW-VARIANT-${input.planDate}-${index + 1}`,
    shippedBoxes: 1,
    vehiclePlate: '',
  }));
}

/** Stops the import is expected to produce per group: distinct destination identities among its rows. */
export function predictStopsPerGroup(rows: Array<DsvDispatchImportSourceRow & { groupIndex: number }>): number[] {
  const keys = new Map<number, Set<string>>();
  for (const row of rows) {
    const identity = dsvDestinationIdentity(row);
    keys.set(row.groupIndex, (keys.get(row.groupIndex) ?? new Set()).add(`${identity.name}\u0000${identity.address}`));
  }
  return [...keys.entries()].sort(([left], [right]) => left - right).map(([, set]) => set.size);
}

type DemoConfig = { accountId: string; driverId: string; groups: number; planDate: string; shopId: string };

export async function runReviewVariantDemo(prisma: PrismaClient, config: DemoConfig, apply: boolean) {
  const shop = await prisma.shop.findUniqueOrThrow({ where: { id: config.shopId }, select: { id: true, shopDomain: true } });
  const account = await prisma.driverAccount.findUnique({
    where: { id: config.accountId }, select: { id: true, isStoreReviewAccount: true, drivers: { select: { id: true }, orderBy: { id: 'asc' } } },
  });
  const driver = await prisma.driver.findFirst({
    where: { id: config.driverId, accountId: config.accountId, shopId: shop.id },
    select: { id: true, isStoreReviewData: true, dsvProfile: { select: { lookupName: true } } },
  });
  if (account === null || driver === null || account.drivers.length !== 1 || account.drivers[0]?.id !== driver.id) {
    throw new Error('The selected account must own exactly the selected driver');
  }
  const lookupName = driver.dsvProfile?.lookupName;
  if (lookupName === undefined) throw new Error('The selected driver has no DSV driver profile');
  if (await prisma.driver.count({ where: { shopId: shop.id, dsvProfile: { is: { lookupName } } } }) !== 1) {
    throw new Error('The driver lookup name is not unique in this shop');
  }
  if (await prisma.dsvVehicleDriverAssignment.count({ where: { shopId: shop.id, driverId: driver.id } }) !== 0) {
    throw new Error('The driver has a vehicle; review classification must not cover vehicle telemetry');
  }
  const condition = await prisma.dsvTransportCondition.findFirst({
    where: { shopId: shop.id, status: 'ACTIVE' }, orderBy: { code: 'asc' }, select: { name: true, rawValue: true },
  });
  if (condition === null) throw new Error('No active transport condition');

  const profiles = await prisma.deliveryCustomerProfile.findMany({
    where: { shopId: shop.id, isStoreReviewData: false },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { canonicalName: true, createdAt: true, id: true, mergedIntoProfileId: true, normalizedAddress: true },
  });
  const groups = planVariantGroups(profiles, config.groups);
  const rows = buildVariantRows({ conditionCode: condition.rawValue ?? condition.name, driverName: lookupName, groups, planDate: config.planDate, profiles });
  const predicted = predictStopsPerGroup(rows);
  const existingOrders = await prisma.order.count({
    where: { shopId: shop.id, sellerOrderKey: { in: rows.map((row) => row.sellerOrderKey) }, serviceDate: new Date(`${config.planDate}T00:00:00.000Z`) },
  });
  const operationalRoutes = await prisma.routePlan.count({ where: { shopId: shop.id, driverId: driver.id, isStoreReviewData: false } });
  const sourceRows: DsvDispatchImportSourceRow[] = rows.map((row) => {
    const { groupIndex, ...source } = row;
    void groupIndex;
    return source;
  });
  const fingerprint = createHash('sha256').update(JSON.stringify({ account, driver, planDate: config.planDate, rows: sourceRows, shop })).digest('hex');
  const summary = {
    fingerprint, planDate: config.planDate, rows: rows.length, groups: groups.length,
    predictedStopsPerGroup: predicted, operationalRoutesHiddenFromThisLogin: operationalRoutes,
    alreadyCreated: existingOrders > 0, accountAlreadyReview: account.isStoreReviewAccount,
  };
  if (!apply) return { mode: 'dry-run' as const, ...summary, spellings: groups.map((group) => group.spellings.map(displayName)) };

  if (process.env.DSV_REVIEW_DEMO_EXPECTED_FINGERPRINT !== fingerprint) throw new Error('Dry-run fingerprint changed or missing');
  if (existingOrders > 0) throw new Error('Demo orders for this date already exist');
  if (groups.length === 0 || predicted.some((count) => count !== 1)) throw new Error('A selected group would not collapse to one stop');
  const snapshotPath = process.env.DSV_REVIEW_DEMO_SNAPSHOT_PATH;
  if (!snapshotPath || !isAbsolute(snapshotPath)) throw new Error('An absolute rollback snapshot path is required');
  await writeFile(snapshotPath, JSON.stringify({ account, driver, planDate: config.planDate, shopId: shop.id }, null, 2), { flag: 'wx', mode: 0o600 });

  await prisma.$transaction([
    prisma.driverAccount.update({ where: { id: account.id }, data: { isStoreReviewAccount: true } }),
    prisma.driver.update({ where: { id: driver.id }, data: { isStoreReviewData: true } }),
  ]);
  const service = new PrismaDsvDispatchImportService(prisma);
  const actor = 'dsv-review-variant-demo';
  const staged = await service.commit(
    { actor, fileName: `review-variant-demo-${config.planDate}.xlsx`, planDate: config.planDate, rows: sourceRows, shopDomain: shop.shopDomain },
    { isStoreReviewData: true },
  );
  if (staged.status !== 'READY' && staged.status !== 'STAGED') {
    const issues = staged.rows.flatMap((row) => row.issues.map((issue) => `${row.rowNumber}:${issue.code}`));
    throw new Error(`Staged import ${staged.id} is ${staged.status}: ${issues.join(', ')}`);
  }
  const commandId = `review-variant-demo-${config.planDate}`;
  const applied = await service.apply({
    actor, commandId, expectedSourceHash: staged.sourceHash ?? '', importId: staged.id, shopDomain: shop.shopDomain,
    principal: { actorId: actor, actorType: 'SYSTEM', principalType: 'SYSTEM_WORKER', requestId: commandId },
  });

  // Read the route back the way the driver app does and count destinations per merged group.
  const routePlan = await prisma.routePlan.findFirstOrThrow({
    where: { shopId: shop.id, driverId: driver.id, isStoreReviewData: true, routeStops: { some: { deliveryStopId: applied.rows[0]?.deliveryStopId ?? '' } } },
    select: { id: true },
  });
  const assigned = await new PrismaDriverAssignedRouteRepository(prisma).getAssignedRoute({
    driverId: driver.id, routeContext: routePlan.id, shopDomain: shop.shopDomain, shopId: shop.id,
  });
  if (assigned.status !== 'ASSIGNED_ROUTE') throw new Error(`Driver read-back failed: ${assigned.status}`);
  const groupByStop = new Map(applied.rows.map((row) => [row.deliveryStopId, rows.find((source) => source.rowNumber === row.rowNumber)!.groupIndex]));
  const destinations = new Map<number, Set<string>>();
  for (const stop of assigned.route.stops) {
    const group = groupByStop.get(stop.deliveryStopId);
    if (group !== undefined) destinations.set(group, (destinations.get(group) ?? new Set()).add(stop.destinationId ?? stop.deliveryStopId));
  }
  return {
    mode: 'apply' as const, ...summary, importId: staged.id, routePlanId: routePlan.id, snapshotWritten: true,
    driverStops: assigned.route.stops.length,
    driverDestinationsPerGroup: [...destinations.entries()].sort(([left], [right]) => left - right).map(([, set]) => set.size),
  };
}

function uniqueSpellings(members: VariantProfile[]): VariantProfile[] {
  const seen = new Set<string>();
  return members.filter((profile) => {
    const address = readAddress(profile.normalizedAddress);
    const key = `${displayName(profile)}\u0000${address.address}\u0000${address.detailAddress ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function nameVariants(group: VariantGroup): number {
  return new Set(group.spellings.map(displayName)).size;
}

function displayName(profile: VariantProfile): string {
  return (profile.canonicalName ?? readAddress(profile.normalizedAddress).name).trim();
}

function readAddress(value: Prisma.JsonValue) {
  const record = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const text = (key: string) => typeof record[key] === 'string' && record[key].trim() !== '' ? record[key] : null;
  return {
    address: text('address') ?? text('address1') ?? '',
    detailAddress: text('detailAddress') ?? text('address2'),
    jibunAddress: text('jibunAddress'),
    name: text('name') ?? '',
    postalCode: text('postalCode'),
  };
}

function coordinatesOf(profile: VariantProfile): { latitude: number; longitude: number } | null {
  const record = profile.normalizedAddress !== null && typeof profile.normalizedAddress === 'object' && !Array.isArray(profile.normalizedAddress)
    ? profile.normalizedAddress as Record<string, unknown> : {};
  const latitude = Number(record.latitude);
  const longitude = Number(record.longitude);
  return record.latitude != null && record.longitude != null && Number.isFinite(latitude) && Number.isFinite(longitude)
    ? { latitude, longitude } : null;
}

function requiredUuid(name: string): string {
  const value = process.env[name] ?? '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) throw new Error(`${name} must be a UUID`);
  return value;
}

if (process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], 'file:').href) {
  const planDate = process.env.DSV_REVIEW_DEMO_PLAN_DATE ?? '';
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(planDate)) throw new Error('DSV_REVIEW_DEMO_PLAN_DATE must be YYYY-MM-DD');
  const prisma = new PrismaClient();
  try {
    const result = await runReviewVariantDemo(prisma, {
      accountId: requiredUuid('DSV_REVIEW_DEMO_ACCOUNT_ID'),
      driverId: requiredUuid('DSV_REVIEW_DEMO_DRIVER_ID'),
      groups: Number(process.env.DSV_REVIEW_DEMO_GROUPS ?? '6'),
      planDate,
      shopId: requiredUuid('DSV_REVIEW_DEMO_SHOP_ID'),
    }, process.argv.includes('--apply'));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await prisma.$disconnect();
  }
}
