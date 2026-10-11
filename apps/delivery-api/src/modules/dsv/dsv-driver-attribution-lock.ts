import { Prisma } from '@prisma/client';

const MAX_TOPOLOGY_ATTEMPTS = 3;

type TransactionRunner = {
  $transaction<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>;
};

export type DsvDriverAttributionLockProof = {
  lockedDriverIds: readonly string[];
  routePlanIds: readonly string[];
  status: 'LEGACY_UNAVAILABLE' | 'LOCKED';
};

export class DsvDriverAttributionTopologyChangedError extends Error {
  constructor() {
    super('DSV driver attribution topology changed');
    this.name = 'DsvDriverAttributionTopologyChangedError';
  }
}

export class DsvDriverAttributionConflictError extends Error {
  readonly code = 'ATTRIBUTION_CHANGED';

  constructor() {
    super('Driver attribution changed. Retry the request.');
    this.name = 'DsvDriverAttributionConflictError';
  }
}

export async function runWithDsvDriverAttributionRetry<T>(
  prisma: TransactionRunner,
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; attempt <= MAX_TOPOLOGY_ATTEMPTS; attempt += 1) {
    try {
      return await prisma.$transaction(operation);
    } catch (error) {
      if (!(error instanceof DsvDriverAttributionTopologyChangedError)) throw error;
      if (attempt === MAX_TOPOLOGY_ATTEMPTS) throw new DsvDriverAttributionConflictError();
    }
  }
  throw new DsvDriverAttributionConflictError();
}

export async function lockDsvDriverAttributionAccounts(
  value: unknown,
  accountIds: readonly string[],
): Promise<readonly string[]> {
  const tx = operationalTransaction(value);
  if (tx === null) return [];
  const ids = uniqueSorted(accountIds);
  if (ids.length === 0) return [];
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT account."id"
    FROM driver_accounts account
    WHERE account."id" IN (${uuidList(ids)})
    ORDER BY account."id"
    FOR UPDATE
  `);
  return uniqueSorted(rows.map((row) => row.id));
}

export function isDsvDriverAttributionOperationalTransaction(value: unknown): boolean {
  return operationalTransaction(value) !== null;
}

export async function lockDsvDriverAttributionTopology(
  value: unknown,
  driverIds: readonly string[],
): Promise<DsvDriverAttributionLockProof> {
  const tx = operationalTransaction(value);
  if (tx === null) return { lockedDriverIds: [], routePlanIds: [], status: 'LEGACY_UNAVAILABLE' };
  const ids = uniqueSorted(driverIds);
  if (ids.length === 0) return { lockedDriverIds: [], routePlanIds: [], status: 'LOCKED' };

  const initialRouteIds = await readAttributionRouteIds(tx, ids);
  let lockedRouteIds: string[] = [];
  if (initialRouteIds.length > 0) {
    const lockedRoutes = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT route_plan."id"
      FROM route_plans route_plan
      WHERE route_plan."id" IN (${uuidList(initialRouteIds)})
      ORDER BY route_plan."id"
      FOR UPDATE
    `);
    lockedRouteIds = uniqueSorted(lockedRoutes.map((row) => row.id));
  }
  const lockedDrivers = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT driver."id"
    FROM drivers driver
    WHERE driver."id" IN (${uuidList(ids)})
    ORDER BY driver."id"
    FOR UPDATE
  `);
  const freshRouteIds = await readAttributionRouteIds(tx, ids);
  const lockedRouteIdSet = new Set(lockedRouteIds);
  if (freshRouteIds.some((routePlanId) => !lockedRouteIdSet.has(routePlanId))) {
    throw new DsvDriverAttributionTopologyChangedError();
  }
  return {
    lockedDriverIds: uniqueSorted(lockedDrivers.map((row) => row.id)),
    routePlanIds: lockedRouteIds,
    status: 'LOCKED',
  };
}

export function assertDsvAttributionRoutesPrelocked(
  proof: DsvDriverAttributionLockProof,
  routePlanIds: readonly string[],
): void {
  if (proof.status === 'LEGACY_UNAVAILABLE') return;
  const locked = new Set(proof.routePlanIds);
  if (routePlanIds.some((routePlanId) => !locked.has(routePlanId))) {
    throw new DsvDriverAttributionTopologyChangedError();
  }
}

export function assertDsvAttributionDriversPrelocked(
  proof: DsvDriverAttributionLockProof,
  driverIds: readonly string[],
): void {
  if (proof.status === 'LEGACY_UNAVAILABLE') return;
  const locked = new Set(proof.lockedDriverIds);
  if (driverIds.some((driverId) => !locked.has(driverId))) {
    throw new DsvDriverAttributionTopologyChangedError();
  }
}

export function assertDsvAttributionAccountsPrelocked(
  lockedAccountIds: readonly string[],
  accountIds: readonly string[],
): void {
  const locked = new Set(lockedAccountIds);
  if (accountIds.some((accountId) => !locked.has(accountId))) {
    throw new DsvDriverAttributionTopologyChangedError();
  }
}

async function readAttributionRouteIds(
  tx: Prisma.TransactionClient,
  driverIds: readonly string[],
): Promise<string[]> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT DISTINCT attribution_route."id"
    FROM (
      SELECT route_plan."id"
      FROM route_plans route_plan
      WHERE route_plan."driverId" IN (${uuidList(driverIds)})
      UNION
      SELECT execution_context."routePlanId" AS "id"
      FROM dsv_execution_contexts execution_context
      WHERE execution_context."driverId" IN (${uuidList(driverIds)})
        AND execution_context."status" = 'ACTIVE'
    ) attribution_route
    ORDER BY attribution_route."id"
  `);
  return uniqueSorted(rows.map((row) => row.id));
}

function operationalTransaction(value: unknown): Prisma.TransactionClient | null {
  if (value === null || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (!('dsvExecutionContext' in candidate)) return null;
  if (typeof candidate.$queryRaw !== 'function' || !('driver' in candidate) || !('routePlan' in candidate)) {
    throw new Error('DSV driver attribution lock requires complete operational transaction delegates');
  }
  return value as Prisma.TransactionClient;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function uuidList(values: readonly string[]): Prisma.Sql {
  return Prisma.join(values.map((value) => Prisma.sql`${value}::uuid`));
}
