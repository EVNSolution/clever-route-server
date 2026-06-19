import type { Prisma, PrismaClient } from '@prisma/client';

import {
  RAW_INTAKE_MESSAGE_MAX_LENGTH,
  sanitizeRawIntakeMessage,
  sanitizeRawIntakeMetadata
} from './raw-order-intake-guard.js';

type OrderIngestAuditPrismaClient = Pick<
  PrismaClient,
  'commerceRawOrderIngest' | 'commerceRawOrderIngestEvent' | 'order' | 'shop'
>;

export type OrderIngestAuditEvent = {
  code: string;
  commerceConnectionId: string | null;
  createdAt: string;
  decision: string;
  id: string;
  message: string;
  metadata: Record<string, unknown> | null;
  rawPayloadSha256: string | null;
  severity: string;
  sourceLine: string;
  sourceOrderId: string | null;
  sourceOrderNumber: string | null;
  sourceSiteUrl: string | null;
  stage: string;
};

export type OrderIngestAuditCanonicalOrder = {
  id: string;
  name: string;
  sourceOrderId: string | null;
  sourceOrderNumber: string | null;
  sourcePlatform: string;
  sourceSiteUrl: string | null;
};

export type OrderIngestAuditRawIngest = {
  canonicalOrderId: string | null;
  commerceConnectionId: string;
  failureCode: string | null;
  failureMessage: string | null;
  id: string;
  platform: string;
  processedAt: string | null;
  rawPayloadSha256: string;
  receivedAt: string;
  sourceOrderId: string;
  sourceOrderNumber: string | null;
  sourceSiteUrl: string;
  status: string;
  syncRun: OrderIngestAuditSyncRun | null;
};

export type OrderIngestAuditSyncRun = {
  completedAt: string | null;
  id: string;
  status: string;
};

export type OrderIngestAuditResult = {
  canonicalOrder: OrderIngestAuditCanonicalOrder | null;
  evidenceKinds: OrderIngestAuditEvidenceKind[];
  events: OrderIngestAuditEvent[];
  found: boolean;
  latestDecision: OrderIngestAuditEvent | null;
  orderNumber: string;
  rawIngest: OrderIngestAuditRawIngest | null;
  shopDomain: string;
  status: 'canonical_only' | 'event_only' | 'not_found' | 'raw_ingest';
  syncRun: OrderIngestAuditSyncRun | null;
};

export type OrderIngestAuditEvidenceKind = 'canonical_order' | 'event' | 'raw_ingest';

export type OrderIngestAuditServiceContract = {
  lookup(input: { orderNumber: string; shopDomain: string }): Promise<OrderIngestAuditResult>;
};

const MAX_ORDER_NUMBER_LENGTH = 96;
const MAX_EVENTS = 20;

export class PrismaOrderIngestAuditService implements OrderIngestAuditServiceContract {
  constructor(private readonly prisma: OrderIngestAuditPrismaClient) {}

  async lookup(input: { orderNumber: string; shopDomain: string }): Promise<OrderIngestAuditResult> {
    const shopDomain = normalizeShopDomain(input.shopDomain);
    const orderNumber = normalizeOrderNumber(input.orderNumber);
    const shop = await this.prisma.shop.findUnique({
      select: { id: true, shopDomain: true },
      where: { shopDomain }
    });
    if (shop === null) return emptyResult({ orderNumber, shopDomain });

    const candidates = orderNumberCandidates(orderNumber);
    const [rawIngestRecord, eventRecords, canonicalOrderByNumber] = await Promise.all([
      this.prisma.commerceRawOrderIngest.findFirst({
        orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
        select: {
          canonicalOrderId: true,
          commerceConnectionId: true,
          failureCode: true,
          failureMessage: true,
          id: true,
          platform: true,
          processedAt: true,
          rawPayloadSha256: true,
          receivedAt: true,
          sourceOrderId: true,
          sourceOrderNumber: true,
          sourceSiteUrl: true,
          status: true,
          syncRun: {
            select: {
              completedAt: true,
              id: true,
              status: true
            }
          }
        },
        where: {
          shopId: shop.id,
          OR: [
            { sourceOrderNumber: { in: candidates } },
            { sourceOrderId: { in: candidates } }
          ]
        }
      }),
      this.prisma.commerceRawOrderIngestEvent.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: {
          code: true,
          commerceConnectionId: true,
          commerceConnection: { select: { siteUrl: true } },
          createdAt: true,
          decision: true,
          id: true,
          message: true,
          metadata: true,
          rawPayloadSha256: true,
          severity: true,
          sourceLine: true,
          sourceOrderId: true,
          sourceOrderNumber: true,
          stage: true
        },
        take: MAX_EVENTS,
        where: {
          shopId: shop.id,
          OR: [
            { sourceOrderNumber: { in: candidates } },
            { sourceOrderId: { in: candidates } }
          ]
        }
      }),
      this.prisma.order.findFirst({
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        select: {
          id: true,
          name: true,
          sourceOrderId: true,
          sourceOrderNumber: true,
          sourcePlatform: true,
          sourceSiteUrl: true
        },
        where: {
          shopId: shop.id,
          OR: [
            { sourceOrderNumber: { in: candidates } },
            { sourceOrderId: { in: candidates } },
            { name: { in: candidates } }
          ]
        }
      })
    ]);

    const canonicalOrder =
      canonicalOrderByNumber ??
      (rawIngestRecord?.canonicalOrderId === null || rawIngestRecord?.canonicalOrderId === undefined
        ? null
        : await this.prisma.order.findFirst({
            select: {
              id: true,
              name: true,
              sourceOrderId: true,
              sourceOrderNumber: true,
              sourcePlatform: true,
              sourceSiteUrl: true
            },
            where: {
              id: rawIngestRecord.canonicalOrderId,
              shopId: shop.id
            }
          }));

    const events = eventRecords.map(toAuditEvent);
    const rawIngest = rawIngestRecord === null ? null : toRawIngest(rawIngestRecord);
    const resultStatus = readAuditStatus({ canonicalOrder, events, rawIngest });
    return {
      canonicalOrder: canonicalOrder === null ? null : toCanonicalOrder(canonicalOrder),
      evidenceKinds: readEvidenceKinds({ canonicalOrder, events, rawIngest }),
      events,
      found: resultStatus !== 'not_found',
      latestDecision: events[0] ?? null,
      orderNumber,
      rawIngest,
      shopDomain: shop.shopDomain,
      status: resultStatus,
      syncRun: rawIngest?.syncRun ?? null
    };
  }
}

function normalizeShopDomain(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeOrderNumber(value: string): string {
  const normalized = value.trim();
  if (normalized === '') throw new Error('orderNumber is required.');
  return normalized.length > MAX_ORDER_NUMBER_LENGTH
    ? normalized.slice(0, MAX_ORDER_NUMBER_LENGTH)
    : normalized;
}

function orderNumberCandidates(value: string): string[] {
  const candidates = new Set([value]);
  const withoutHash = value.startsWith('#') ? value.slice(1) : value;
  if (withoutHash !== '') {
    candidates.add(withoutHash);
    candidates.add(`#${withoutHash}`);
  }
  return [...candidates];
}

function emptyResult(input: { orderNumber: string; shopDomain: string }): OrderIngestAuditResult {
  return {
    canonicalOrder: null,
    evidenceKinds: [],
    events: [],
    found: false,
    latestDecision: null,
    orderNumber: input.orderNumber,
    rawIngest: null,
    shopDomain: input.shopDomain,
    status: 'not_found',
    syncRun: null
  };
}

function toCanonicalOrder(record: {
  id: string;
  name: string;
  sourceOrderId: string | null;
  sourceOrderNumber: string | null;
  sourcePlatform: unknown;
  sourceSiteUrl: string | null;
}): OrderIngestAuditCanonicalOrder {
  return {
    id: record.id,
    name: record.name,
    sourceOrderId: record.sourceOrderId,
    sourceOrderNumber: record.sourceOrderNumber,
    sourcePlatform: String(record.sourcePlatform),
    sourceSiteUrl: record.sourceSiteUrl
  };
}

function toRawIngest(record: {
  canonicalOrderId: string | null;
  commerceConnectionId: string;
  failureCode: string | null;
  failureMessage: string | null;
  id: string;
  platform: unknown;
  processedAt: Date | null;
  rawPayloadSha256: string;
  receivedAt: Date;
  sourceOrderId: string;
  sourceOrderNumber: string | null;
  sourceSiteUrl: string;
  status: unknown;
  syncRun: { completedAt: Date | null; id: string; status: unknown };
}): OrderIngestAuditRawIngest {
  return {
    canonicalOrderId: record.canonicalOrderId,
    commerceConnectionId: record.commerceConnectionId,
    failureCode: record.failureCode,
    failureMessage: sanitizeNullableMessage(record.failureMessage),
    id: record.id,
    platform: String(record.platform),
    processedAt: record.processedAt?.toISOString() ?? null,
    rawPayloadSha256: record.rawPayloadSha256,
    receivedAt: record.receivedAt.toISOString(),
    sourceOrderId: record.sourceOrderId,
    sourceOrderNumber: record.sourceOrderNumber,
    sourceSiteUrl: record.sourceSiteUrl,
    status: String(record.status),
    syncRun: toSyncRun(record.syncRun)
  };
}

function toSyncRun(record: { completedAt: Date | null; id: string; status: unknown } | null): OrderIngestAuditSyncRun | null {
  if (record === null) return null;
  return {
    completedAt: record.completedAt?.toISOString() ?? null,
    id: record.id,
    status: String(record.status)
  };
}

function toAuditEvent(record: {
  code: string;
  commerceConnection: { siteUrl: string } | null;
  commerceConnectionId: string | null;
  createdAt: Date;
  decision: string;
  id: string;
  message: string;
  metadata: Prisma.JsonValue | null;
  rawPayloadSha256: string | null;
  severity: string;
  sourceLine: string;
  sourceOrderId: string | null;
  sourceOrderNumber: string | null;
  stage: string;
}): OrderIngestAuditEvent {
  return {
    code: record.code,
    commerceConnectionId: record.commerceConnectionId,
    createdAt: record.createdAt.toISOString(),
    decision: record.decision,
    id: record.id,
    message: sanitizeRawIntakeMessage(record.message),
    metadata: record.metadata === null ? null : sanitizeRawIntakeMetadata(record.metadata),
    rawPayloadSha256: record.rawPayloadSha256,
    severity: record.severity,
    sourceLine: record.sourceLine,
    sourceOrderId: record.sourceOrderId,
    sourceOrderNumber: record.sourceOrderNumber,
    sourceSiteUrl: record.commerceConnection?.siteUrl ?? null,
    stage: record.stage
  };
}

function sanitizeNullableMessage(value: string | null): string | null {
  if (value === null) return null;
  const sanitized = sanitizeRawIntakeMessage(value);
  return sanitized.length > RAW_INTAKE_MESSAGE_MAX_LENGTH
    ? sanitized.slice(0, RAW_INTAKE_MESSAGE_MAX_LENGTH)
    : sanitized;
}

function readAuditStatus(input: {
  canonicalOrder: object | null;
  events: OrderIngestAuditEvent[];
  rawIngest: OrderIngestAuditRawIngest | null;
}): OrderIngestAuditResult['status'] {
  if (input.rawIngest !== null) return 'raw_ingest';
  if (input.canonicalOrder !== null) return 'canonical_only';
  if (input.events.length > 0) return 'event_only';
  return 'not_found';
}

function readEvidenceKinds(input: {
  canonicalOrder: object | null;
  events: OrderIngestAuditEvent[];
  rawIngest: OrderIngestAuditRawIngest | null;
}): OrderIngestAuditEvidenceKind[] {
  const kinds: OrderIngestAuditEvidenceKind[] = [];
  if (input.rawIngest !== null) kinds.push('raw_ingest');
  if (input.events.length > 0) kinds.push('event');
  if (input.canonicalOrder !== null) kinds.push('canonical_order');
  return kinds;
}
