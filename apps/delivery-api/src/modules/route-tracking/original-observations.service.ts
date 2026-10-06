import { createHmac, timingSafeEqual } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';

export const ORIGINAL_OBSERVATIONS_POINT_CAP = 5000;
const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;
const CURSOR_TTL_MS = 15 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export class OriginalObservationsError extends Error {
  constructor(readonly code: 'INVALID_QUERY' | 'INVALID_CURSOR' | 'ASSIGNMENT_CHANGED' | 'READ_TIMEOUT') {
    super(code);
  }
}

type Query = { from: string; to: string; limit: number; cursor: string | null };
type Scope = { appId: string; shopDomain: string; routePlanId: string };
type Position = { observedAt: string; storedAt: string; eventId: string };
type Cursor = {
  version: 1;
  binding: string;
  assignment: string;
  from: string;
  to: string;
  limit: number;
  snapshotAt: string;
  expiresAt: number;
  totalReturned: number;
  after: Position;
};
type Row = Position & {
  latitude: string | null;
  longitude: string | null;
  accuracy: unknown;
  redacted: boolean;
  clientEventId: string | null;
};
type FieldStatus = 'VALID' | 'MISSING' | 'INVALID' | 'REDACTED';
export type OriginalObservation = Position & {
  latitude: number | null;
  longitude: number | null;
  accuracyMeters: number | null;
  coordinateStatus: FieldStatus;
  accuracyStatus: FieldStatus;
  clientEventKey: string | null;
};
export type OriginalObservationsPage = {
  schemaVersion: 1;
  routePlanId: string;
  source: 'DRIVER_EVENT_LOCATION_UPDATED';
  scope: 'CURRENT_ASSIGNMENT';
  window: { from: string; to: string };
  observations: OriginalObservation[];
  page: {
    limit: number;
    returned: number;
    hasMore: boolean;
    nextCursor: string | null;
    totalReturned: number;
    pointCap: number;
    capReached: boolean;
    snapshotAt: string;
  };
  emptyReason: 'NO_ASSIGNED_DRIVER' | 'NO_OBSERVATIONS' | null;
};

export interface OriginalObservationsService {
  get(input: Scope & { query: unknown }): Promise<OriginalObservationsPage | null>;
}

/** Read only committed event facts; never consult geometry, matching or ingest. */
export class PrismaOriginalObservationsService implements OriginalObservationsService {
  constructor(
    private readonly prisma: Pick<PrismaClient, '$transaction'>,
    private readonly secrets: ReadonlyMap<string, string>,
    private readonly now: () => number = Date.now
  ) {}

  async get(input: Scope & { query: unknown }): Promise<OriginalObservationsPage | null> {
    const query = readQuery(input.routePlanId, input.query);
    const secret = this.secrets.get(input.appId);
    if (secret === undefined) throw new OriginalObservationsError('INVALID_CURSOR');
    const binding = mac(secret, 'scope', JSON.stringify([input.appId, input.shopDomain, input.routePlanId]));
    const cursor = query.cursor === null ? null : readCursor(query.cursor, secret, binding, query, this.now());

    try {
      return await this.prisma.$transaction(async (transaction) => {
        // Database work is bounded even when the existing index has a large cohort.
        await transaction.$executeRaw`SET LOCAL statement_timeout = '3000ms'`;
        const route = await transaction.routePlan.findFirst({
          where: { id: input.routePlanId, shop: { appId: input.appId, shopDomain: input.shopDomain } },
          select: { shopId: true, driverId: true, assignmentGeneration: true }
        });
        if (route === null) return null;
        const assignment = mac(secret, 'assignment', JSON.stringify([route.driverId, route.assignmentGeneration.toString()]));
        if (cursor !== null && cursor.assignment !== assignment) throw new OriginalObservationsError('ASSIGNMENT_CHANGED');
        const snapshotAt = cursor?.snapshotAt ?? (await transaction.$queryRaw<{ snapshotAt: string }[]>`
          SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "snapshotAt"
        `)[0]!.snapshotAt;
        const previousCount = cursor?.totalReturned ?? 0;
        const take = Math.min(query.limit, ORIGINAL_OBSERVATIONS_POINT_CAP - previousCount);
        const after = cursor === null ? Prisma.empty : Prisma.sql`
          AND ("occurredAt", "createdAt", id) >
            (${cursor.after.observedAt}::timestamptz, ${cursor.after.storedAt}::timestamptz, ${cursor.after.eventId}::uuid)
        `;
        const rows = route.driverId === null ? [] : await transaction.$queryRaw<Row[]>(Prisma.sql`
          SELECT id AS "eventId",
            to_char("occurredAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "observedAt",
            to_char("createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "storedAt",
            latitude::text AS latitude, longitude::text AS longitude,
            COALESCE(NULLIF(payload -> 'accuracyMeters', 'null'::jsonb),
              NULLIF(payload -> 'accuracy', 'null'::jsonb), payload #> '{location,accuracyMeters}') AS accuracy,
            (payload -> 'redacted' = 'true'::jsonb OR payload ->> 'schema' = 'driver_location_service_window_tombstone_v1') IS TRUE AS redacted,
            "clientEventId"
          FROM driver_events
          WHERE "shopId" = ${route.shopId}::uuid AND "routePlanId" = ${input.routePlanId}::uuid
            AND "driverId" = ${route.driverId}::uuid AND "eventType" = 'LOCATION_UPDATED'
            AND ("assignmentGeneration" = ${route.assignmentGeneration}
              OR (${route.assignmentGeneration} = 1 AND "assignmentGeneration" IS NULL))
            AND "occurredAt" >= ${query.from}::timestamptz AND "occurredAt" < ${query.to}::timestamptz
            AND "createdAt" <= ${snapshotAt}::timestamptz
            ${after}
          ORDER BY "occurredAt" ASC, "createdAt" ASC, id ASC
          LIMIT ${take + 1}
        `);
        const observations = rows.slice(0, take).map((row) => observation(row, secret, binding));
        const totalReturned = previousCount + observations.length;
        const capReached = totalReturned === ORIGINAL_OBSERVATIONS_POINT_CAP && rows.length > take;
        const hasMore = rows.length > take && !capReached;
        const last = observations.at(-1);
        const nextCursor = !hasMore || last === undefined ? null : encodeCursor({
          version: 1, binding, assignment, from: query.from, to: query.to, limit: query.limit,
          snapshotAt, expiresAt: cursor?.expiresAt ?? this.now() + CURSOR_TTL_MS, totalReturned,
          after: { observedAt: last.observedAt, storedAt: last.storedAt, eventId: last.eventId }
        }, secret);
        return {
          schemaVersion: 1, routePlanId: input.routePlanId, source: 'DRIVER_EVENT_LOCATION_UPDATED',
          scope: 'CURRENT_ASSIGNMENT', window: { from: query.from, to: query.to }, observations,
          page: { limit: query.limit, returned: observations.length, hasMore, nextCursor, totalReturned,
            pointCap: ORIGINAL_OBSERVATIONS_POINT_CAP, capReached, snapshotAt },
          emptyReason: observations.length > 0 ? null : route.driverId === null ? 'NO_ASSIGNED_DRIVER' : 'NO_OBSERVATIONS'
        };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 3000, timeout: 5000 });
    } catch (error) {
      if (error instanceof OriginalObservationsError) throw error;
      if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === 'P2028' || error.code === 'P2024'
        || (error.code === 'P2010' && error.meta?.code === '57014'))) {
        throw new OriginalObservationsError('READ_TIMEOUT');
      }
      throw error;
    }
  }
}

function readQuery(routePlanId: string, value: unknown): Query {
  const record = object(value);
  if (!UUID.test(routePlanId) || record === null || Object.keys(record).some((key) => !['from', 'to', 'limit', 'cursor'].includes(key))) {
    throw new OriginalObservationsError('INVALID_QUERY');
  }
  const from = instant(record.from);
  const to = instant(record.to);
  const rawLimit = record.limit ?? '200';
  const limit = typeof rawLimit === 'string' && /^[1-9]\d{0,2}$/u.test(rawLimit) ? Number(rawLimit) : Number.NaN;
  if (from === null || to === null || from >= to || microseconds(to) - microseconds(from) > BigInt(MAX_WINDOW_MS) * 1000n
    || !Number.isInteger(limit) || limit > 500) throw new OriginalObservationsError('INVALID_QUERY');
  if (record.cursor !== undefined && (typeof record.cursor !== 'string' || record.cursor.length === 0 || record.cursor.length > 2048)) {
    throw new OriginalObservationsError('INVALID_CURSOR');
  }
  return { from, to, limit, cursor: typeof record.cursor === 'string' ? record.cursor : null };
}

function instant(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/u.test(value)) return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().slice(0, 19) !== value.slice(0, 19)) return null;
  return `${value.slice(0, 19)}.${(value.split('.')[1]?.slice(0, -1) ?? '').padEnd(6, '0')}Z`;
}

function microseconds(value: string): bigint {
  return BigInt(Date.parse(value)) * 1000n + BigInt(value.slice(23, 26));
}

function readCursor(token: string, secret: string, binding: string, query: Query, now: number): Cursor {
  try {
    const parts = token.split('.');
    if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/u.test(parts[0]!) || !/^[A-Za-z0-9_-]{43}$/u.test(parts[1]!)) throw new Error();
    const expected = mac(secret, 'cursor', parts[0]!);
    if (!timingSafeEqual(Buffer.from(expected), Buffer.from(parts[1]!))) throw new Error();
    const value = object(JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')));
    const after = object(value?.after);
    if (value === null || after === null || value.version !== 1 || value.binding !== binding
      || value.from !== query.from || value.to !== query.to || value.limit !== query.limit
      || typeof value.assignment !== 'string' || typeof value.expiresAt !== 'number' || value.expiresAt <= now
      || typeof value.totalReturned !== 'number' || !Number.isInteger(value.totalReturned)
      || value.totalReturned < 1 || value.totalReturned >= ORIGINAL_OBSERVATIONS_POINT_CAP
      || instant(value.snapshotAt) === null || instant(after.observedAt) === null || instant(after.storedAt) === null
      || typeof after.eventId !== 'string' || !UUID.test(after.eventId)) throw new Error();
    return value as Cursor;
  } catch {
    throw new OriginalObservationsError('INVALID_CURSOR');
  }
}

function encodeCursor(cursor: Cursor, secret: string): string {
  const body = Buffer.from(JSON.stringify(cursor)).toString('base64url');
  return `${body}.${mac(secret, 'cursor', body)}`;
}

function mac(secret: string, purpose: string, value: string): string {
  return createHmac('sha256', secret).update(`original-observations:v1:${purpose}:`).update(value).digest('base64url');
}

function observation(row: Row, secret: string, binding: string): OriginalObservation {
  const latitude = coordinate(row.latitude, 90);
  const longitude = coordinate(row.longitude, 180);
  const coordinateStatus = row.redacted ? 'REDACTED' : row.latitude === null || row.longitude === null
    ? 'MISSING' : latitude === null || longitude === null ? 'INVALID' : 'VALID';
  const accuracyMeters = typeof row.accuracy === 'number' && Number.isFinite(row.accuracy) && row.accuracy >= 0 ? row.accuracy : null;
  const accuracyStatus = row.redacted ? 'REDACTED' : row.accuracy === null || row.accuracy === undefined
    ? 'MISSING' : accuracyMeters === null ? 'INVALID' : 'VALID';
  return {
    eventId: row.eventId, observedAt: row.observedAt, storedAt: row.storedAt,
    latitude: row.redacted ? null : latitude, longitude: row.redacted ? null : longitude,
    accuracyMeters: row.redacted ? null : accuracyMeters, coordinateStatus, accuracyStatus,
    clientEventKey: row.redacted || row.clientEventId === null ? null : mac(secret, 'client-event', `${binding}:${row.clientEventId}`)
  };
}

function coordinate(value: string | null, bound: number): number | null {
  if (value === null || value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && Math.abs(number) <= bound ? number : null;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
