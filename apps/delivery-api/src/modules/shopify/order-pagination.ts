import { createHmac, timingSafeEqual } from 'node:crypto';

import type { ListCanonicalOrdersFilters } from './order-sync.repository.js';

export const ORDERS_PAGE_SIZE = 50;
export const ORDERS_SORT = 'id_desc' as const;
export const ORDERS_SORT_SCHEMA_VERSION = 1;

export type OrdersCursorBoundary = 'after' | 'before';

export type OrdersCursorContext = {
  appId: string;
  boundary: OrdersCursorBoundary;
  filterHash: string;
  readWatermark: string;
  sequence: string;
  shopId: string;
  orderId: string;
};

type CursorPayload = OrdersCursorContext & {
  expiresAt: number;
  issuedAt: number;
  pageSize: typeof ORDERS_PAGE_SIZE;
  sort: typeof ORDERS_SORT;
  sortSchemaVersion: typeof ORDERS_SORT_SCHEMA_VERSION;
  version: 1;
};

export class InvalidOrdersCursorError extends Error {
  readonly code = 'INVALID_ORDERS_CURSOR';

  constructor() {
    super('Invalid or expired orders cursor');
    this.name = 'InvalidOrdersCursorError';
  }
}

export class OrdersPlanningReferenceDateError extends Error {
  readonly code = 'ROUTE_OPS_TODAY_REQUIRED';

  constructor() {
    super('Planning scope requires an explicit routeOpsToday date');
    this.name = 'OrdersPlanningReferenceDateError';
  }
}

export function requireOrdersPlanningReferenceDate(filters: ListCanonicalOrdersFilters): void {
  const scope = filters.scope ?? filters.routeOpsScope;
  if (scope === 'planning' && !/^\d{4}-\d{2}-\d{2}$/u.test(filters.routeOpsToday ?? '')) {
    throw new OrdersPlanningReferenceDateError();
  }
}

export function createOrdersFilterHash(
  filters: ListCanonicalOrdersFilters,
  secret: string
): string {
  return `hmac-sha256:${hmac(secret, stableJson(filters))}`;
}

export function encodeOrdersCursor(
  context: OrdersCursorContext,
  secret: string,
  options: { now?: Date; ttlMs?: number } = {}
): string {
  assertDecimalBigInt(context.sequence);
  const now = options.now ?? new Date();
  const payload: CursorPayload = {
    ...context,
    expiresAt: now.getTime() + (options.ttlMs ?? 15 * 60_000),
    issuedAt: now.getTime(),
    pageSize: ORDERS_PAGE_SIZE,
    sort: ORDERS_SORT,
    sortSchemaVersion: ORDERS_SORT_SCHEMA_VERSION,
    version: 1
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${hmac(secret, body)}`;
}

export function decodeOrdersCursor(
  cursor: string,
  expected: Omit<OrdersCursorContext, 'readWatermark' | 'sequence' | 'orderId'>,
  secret: string,
  options: { now?: Date } = {}
): OrdersCursorContext {
  try {
    const [body, signature, extra] = cursor.split('.');
    if (body === undefined || signature === undefined || extra !== undefined) throw new Error('shape');
    if (!/^[0-9a-f]{64}$/u.test(signature)) throw new Error('signature-shape');
    const actual = Buffer.from(signature, 'hex');
    const wanted = Buffer.from(hmac(secret, body), 'hex');
    if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) throw new Error('signature');
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as CursorPayload;
    const now = (options.now ?? new Date()).getTime();
    if (
      payload.version !== 1 ||
      payload.sort !== ORDERS_SORT ||
      payload.pageSize !== ORDERS_PAGE_SIZE ||
      payload.sortSchemaVersion !== ORDERS_SORT_SCHEMA_VERSION ||
      typeof payload.expiresAt !== 'number' || !Number.isSafeInteger(payload.expiresAt) ||
      typeof payload.issuedAt !== 'number' || !Number.isSafeInteger(payload.issuedAt) ||
      payload.expiresAt <= now ||
      payload.issuedAt > now + 60_000 ||
      payload.boundary !== expected.boundary ||
      payload.filterHash !== expected.filterHash ||
      payload.shopId !== expected.shopId ||
      payload.appId !== expected.appId ||
      typeof payload.orderId !== 'string' || payload.orderId.length === 0 ||
      typeof payload.readWatermark !== 'string' || !Number.isFinite(Date.parse(payload.readWatermark))
    ) {
      throw new Error('binding');
    }
    assertDecimalBigInt(payload.sequence);
    return {
      appId: payload.appId,
      boundary: payload.boundary,
      filterHash: payload.filterHash,
      orderId: payload.orderId,
      readWatermark: payload.readWatermark,
      sequence: payload.sequence,
      shopId: payload.shopId
    };
  } catch {
    throw new InvalidOrdersCursorError();
  }
}

function assertDecimalBigInt(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(value)) {
    throw new InvalidOrdersCursorError();
  }
  const parsed = BigInt(value);
  if (parsed < 0n || parsed > 9_223_372_036_854_775_807n) {
    throw new InvalidOrdersCursorError();
  }
}

function hmac(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
