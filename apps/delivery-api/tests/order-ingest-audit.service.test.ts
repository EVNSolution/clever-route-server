import { describe, expect, test, vi } from 'vitest';

import { PrismaOrderIngestAuditService } from '../src/modules/wordpress-plugin/order-ingest-audit.service.js';

function createPrismaMock() {
  return {
    commerceRawOrderIngest: { findFirst: vi.fn() },
    commerceRawOrderIngestEvent: { findMany: vi.fn() },
    order: { findFirst: vi.fn() },
    shop: { findUnique: vi.fn() }
  };
}

function syncRun(overrides: Partial<{ completedAt: Date | null; id: string; status: string }> = {}) {
  return {
    completedAt: new Date('2026-06-19T03:00:00.000Z'),
    id: 'sync-run-1',
    status: 'COMPLETED',
    ...overrides
  };
}

function rawIngest(overrides: Record<string, unknown> = {}) {
  return {
    canonicalOrderId: null,
    commerceConnectionId: 'connection-id',
    failureCode: null,
    failureMessage: null,
    id: 'raw-1',
    platform: 'WOOCOMMERCE',
    processedAt: new Date('2026-06-19T03:00:01.000Z'),
    rawPayloadSha256: 'sha256:raw',
    receivedAt: new Date('2026-06-19T02:59:59.000Z'),
    sourceOrderId: '11815',
    sourceOrderNumber: '11815',
    sourceSiteUrl: 'https://woo.example.test',
    status: 'PROCESSED',
    syncRun: syncRun(),
    ...overrides
  };
}

function event(overrides: Record<string, unknown> = {}) {
  return {
    code: 'WOO_STATUS_CANCELLED',
    commerceConnection: { siteUrl: 'https://woo.example.test' },
    commerceConnectionId: 'connection-id',
    createdAt: new Date('2026-06-19T03:00:02.000Z'),
    decision: 'SKIP_RAW',
    id: 'event-1',
    message: 'WooCommerce order was skipped token=super-secret-token',
    metadata: { apiToken: 'super-secret-token', reason: 'cancelled' },
    rawPayloadSha256: 'sha256:raw',
    severity: 'info',
    sourceLine: 'WOOCOMMERCE',
    sourceOrderId: '11815',
    sourceOrderNumber: '11815',
    stage: 'woo_status',
    ...overrides
  };
}

describe('PrismaOrderIngestAuditService', () => {
  test('returns skipped raw ingest audit without exposing raw payload or secrets', async () => {
    const prisma = createPrismaMock();
    prisma.shop.findUnique.mockResolvedValue({ id: 'shop-1', shopDomain: 'tenant-a.example.test' });
    prisma.commerceRawOrderIngest.findFirst.mockResolvedValue(rawIngest({ status: 'SKIPPED' }));
    prisma.commerceRawOrderIngestEvent.findMany.mockResolvedValue([event()]);
    prisma.order.findFirst.mockResolvedValue(null);

    const result = await new PrismaOrderIngestAuditService(prisma as never).lookup({
      orderNumber: '#11815',
      shopDomain: 'Tenant-A.Example.Test'
    });

    expect(result).toEqual(
      expect.objectContaining({
        found: true,
        orderNumber: '#11815',
        status: 'raw_ingest'
      })
    );
    expect(result.rawIngest).toEqual(
      expect.objectContaining({
        commerceConnectionId: 'connection-id',
        sourceSiteUrl: 'https://woo.example.test',
        status: 'SKIPPED'
      })
    );
    expect(result.events[0]).toEqual(
      expect.objectContaining({
        commerceConnectionId: 'connection-id',
        sourceSiteUrl: 'https://woo.example.test'
      })
    );
    expect(result.evidenceKinds).toEqual(['raw_ingest', 'event']);
    expect(result.rawIngest?.syncRun?.status).toBe('COMPLETED');
    expect(result.latestDecision).toEqual(expect.objectContaining({ code: 'WOO_STATUS_CANCELLED' }));
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('"rawPayload":');
    expect(serialized).not.toContain('super-secret-token');
  });

  test('links imported raw ingest to canonical order when canonical id is present', async () => {
    const prisma = createPrismaMock();
    prisma.shop.findUnique.mockResolvedValue({ id: 'shop-1', shopDomain: 'tenant-a.example.test' });
    prisma.commerceRawOrderIngest.findFirst.mockResolvedValue(
      rawIngest({ canonicalOrderId: 'order-1', status: 'PROCESSED' })
    );
    prisma.commerceRawOrderIngestEvent.findMany.mockResolvedValue([
      event({ code: 'CANONICAL_DECISION_PROCESS', decision: 'PROCESS_CANONICAL' })
    ]);
    prisma.order.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'order-1',
        name: '#11815',
        sourceOrderId: '11815',
        sourceOrderNumber: '11815',
        sourcePlatform: 'WOOCOMMERCE',
        sourceSiteUrl: 'https://woo.example.test'
      });

    const result = await new PrismaOrderIngestAuditService(prisma as never).lookup({
      orderNumber: '11815',
      shopDomain: 'tenant-a.example.test'
    });

    expect(result.canonicalOrder).toEqual(expect.objectContaining({ id: 'order-1' }));
    expect(result.rawIngest).toEqual(expect.objectContaining({ canonicalOrderId: 'order-1' }));
  });

  test('returns pre-ingest event-only audit when no raw ingest row exists', async () => {
    const prisma = createPrismaMock();
    prisma.shop.findUnique.mockResolvedValue({ id: 'shop-1', shopDomain: 'tenant-a.example.test' });
    prisma.commerceRawOrderIngest.findFirst.mockResolvedValue(null);
    prisma.commerceRawOrderIngestEvent.findMany.mockResolvedValue([
      event({
        code: 'RAW_SHAPE_MISSING_ORDER_ID',
        decision: 'REJECT_PRE_INGEST',
        rawPayloadSha256: null,
        sourceOrderId: null
      })
    ]);
    prisma.order.findFirst.mockResolvedValue(null);

    const result = await new PrismaOrderIngestAuditService(prisma as never).lookup({
      orderNumber: '11815',
      shopDomain: 'tenant-a.example.test'
    });

    expect(result).toEqual(
      expect.objectContaining({
        found: true,
        rawIngest: null,
        status: 'event_only'
      })
    );
    expect(result.latestDecision?.code).toBe('RAW_SHAPE_MISSING_ORDER_ID');
  });

  test('supports legacy Shopify canonical orders without raw ingest audit rows', async () => {
    const prisma = createPrismaMock();
    prisma.shop.findUnique.mockResolvedValue({ id: 'shop-1', shopDomain: 'tenant-a.example.test' });
    prisma.commerceRawOrderIngest.findFirst.mockResolvedValue(null);
    prisma.commerceRawOrderIngestEvent.findMany.mockResolvedValue([]);
    prisma.order.findFirst.mockResolvedValue({
      id: 'order-shopify',
      name: '#1001',
      sourceOrderId: null,
      sourceOrderNumber: null,
      sourcePlatform: 'SHOPIFY',
      sourceSiteUrl: null
    });

    const result = await new PrismaOrderIngestAuditService(prisma as never).lookup({
      orderNumber: '1001',
      shopDomain: 'tenant-a.example.test'
    });

    expect(result).toEqual(
      expect.objectContaining({
        found: true,
        rawIngest: null,
        status: 'canonical_only'
      })
    );
    expect(result.canonicalOrder).toEqual(expect.objectContaining({ sourcePlatform: 'SHOPIFY' }));
  });

  test('returns not_found when shop or order audit records are absent', async () => {
    const prisma = createPrismaMock();
    prisma.shop.findUnique.mockResolvedValue(null);

    const result = await new PrismaOrderIngestAuditService(prisma as never).lookup({
      orderNumber: '99999',
      shopDomain: 'missing.example.test'
    });

    expect(result).toEqual(
      expect.objectContaining({
        events: [],
        found: false,
        rawIngest: null,
        status: 'not_found'
      })
    );
  });
});
