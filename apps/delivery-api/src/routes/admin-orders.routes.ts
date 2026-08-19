import { performance } from 'node:perf_hooks';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  logRejectedAdminSessionToken,
  type AdminSessionAuthLogContext,
  type AdminSessionTokenVerifier
} from './admin-session-auth.js';

import { DEFAULT_SHOPIFY_APP_ID } from '../modules/shopify/shopify-app-scope.js';
import {
  BULK_ORDER_PAYMENT_VALUES,
  BULK_ORDER_STATE_VALUES,
  OrderSyncRouteLockedError,
  type BulkOrderPaymentValue,
  type BulkOrderStateValue,
  type ListCanonicalOrdersFilters,
  type RouteOpsCanonicalMetadataPatch
} from '../modules/shopify/order-sync.repository.js';
import type { ShopifyOrderNode } from '../modules/shopify/order-sync.mapper.js';
import type { DeliveryCycleConfig } from '../modules/shopify/order-delivery-scope.js';
import type { SyncOrdersSnapshotInput, SyncOrdersSnapshotResult } from '../modules/shopify/order-sync.service.js';
import {
  InvalidOrdersCursorError,
  OrdersPlanningReferenceDateError,
  ORDERS_PAGE_SIZE,
  ORDERS_SORT,
  requireOrdersPlanningReferenceDate
} from '../modules/shopify/order-pagination.js';
import { OrderSelectionSnapshotError, OrdersPaginationNotReadyError, type OrdersPageResult } from '../modules/shopify/order-query.repository.js';
import type {
  ShopifyOrderReconciliationJobDto,
  ShopifyOrderReconciliationJobMode
} from '../modules/shopify/order-reconciliation.types.js';
import { hashTelemetryShop, redactTelemetry } from '../modules/security/safe-telemetry-redaction.js';

type SyncPayloadErrorDetail = {
  field: string;
  orderIndex: number;
  orderName: string;
  reason: string;
};

type SyncPayloadValidationError = Error & {
  code: 'INVALID_ORDER_SYNC_PAYLOAD';
  details: SyncPayloadErrorDetail[];
  message: string;
};

type ParsedOrderSyncPayload = {
  deliveryCycle?: DeliveryCycleConfig;
  orders: ShopifyOrderNode[];
  reason: SyncOrdersSnapshotInput['reason'];
  reasons: SyncPayloadErrorDetail[];
  received: number;
  source: 'clever-app-orders';
  skipped: number;
};

const ORDER_SYNC_TIMESTAMP_FIELDS = new Set(['cancelledAt', 'createdAt', 'processedAt', 'updatedAt']);

export type AdminOrdersDependencies = {
  ordersMapProjectionEnabled?: boolean;
  ordersPaginationEnabled?: boolean;
  ordersSelectionSnapshotsEnabled?: boolean;
  orderSyncService: {
    listCanonicalOrders(input: {
      filters?: ListCanonicalOrdersFilters;
      appId?: string | undefined;
      shopDomain: string;
    }): Promise<SyncOrdersSnapshotResult['orders']>;
    listCanonicalOrdersPage?(input: {
      after?: string;
      appId?: string;
      before?: string;
      filters?: ListCanonicalOrdersFilters;
      page?: number;
      readWatermark?: string;
      shopDomain: string;
    }): Promise<OrdersPageResult>;
    listCanonicalOrderFacets?(input: {
      appId?: string;
      filters?: ListCanonicalOrdersFilters;
      shopDomain: string;
    }): Promise<unknown>;
    listCanonicalOrderMapPoints?(input: {
      appId?: string;
      filters?: ListCanonicalOrdersFilters;
      limit: number;
      shopDomain: string;
    }): Promise<unknown>;
    createOrderSelectionSnapshot?(input: {
      actor: string;
      appId?: string;
      excludeOrderIds?: string[];
      filters?: ListCanonicalOrdersFilters;
      shopDomain: string;
    }): Promise<unknown>;
    replaceOrderSelectionExclusions?(input: {
      actor: string;
      appId?: string;
      excludeOrderIds: string[];
      selectionToken: string;
      shopDomain: string;
    }): Promise<unknown>;
    consumeOrderSelectionSnapshot?(input: {
      actor: string;
      appId?: string;
      selectionToken: string;
      shopDomain: string;
    }): Promise<string[]>;
    bulkPatchOrderSelectionSnapshot?(input: {
      actor: string;
      appId?: string;
      field: 'payment' | 'state';
      selectionToken: string;
      shopDomain: string;
      value: BulkOrderPaymentValue | BulkOrderStateValue;
    }): Promise<{
      noOp: number;
      resolved: number;
      selected: number;
      skipped: number;
      skippedByReason?: Record<string, number>;
      updated: number;
    }>;
    syncOrdersSnapshot(input: SyncOrdersSnapshotInput): Promise<SyncOrdersSnapshotResult>;
    bulkPatchCanonicalOrderStatus?(input: {
      actor: string;
      appId?: string | undefined;
      field: 'payment' | 'state';
      orderIds: string[];
      shopDomain: string;
      value: BulkOrderPaymentValue | BulkOrderStateValue;
    }): Promise<SyncOrdersSnapshotResult['orders']>;
    patchCanonicalOrder?(input: {
      actor: string;
      appId?: string | undefined;
      orderId: string;
      patch: RouteOpsCanonicalMetadataPatch;
      shopDomain: string;
    }): Promise<SyncOrdersSnapshotResult['orders'][number] | null>;
  };
  orderReconciliationService?: {
    enqueueIfIdle(input: {
      appId?: string | undefined;
      correlationId?: string | undefined;
      mode?: ShopifyOrderReconciliationJobMode | undefined;
      overlapWindowSeconds?: number | undefined;
      pageSize?: number | undefined;
      requestedBy?: string | undefined;
      shopDomain: string;
    }): Promise<{ enqueued: boolean; job: ShopifyOrderReconciliationJobDto | null }>;
    status(input: {
      appId?: string | undefined;
      jobId: string;
      shopDomain: string;
    }): Promise<ShopifyOrderReconciliationJobDto | null>;
  };
  sessionTokenVerifier: AdminSessionTokenVerifier;
};

export function registerAdminOrdersRoutes(
  app: FastifyInstance,
  dependencies: AdminOrdersDependencies
): void {
  app.patch<{ Body: unknown }>('/admin/orders/sync', {
    bodyLimit: 16 * 1024 * 1024
  }, async (request, reply) => {
    const authenticated = authenticate(request.headers.authorization, request.headers['x-clever-app-id'], dependencies, {
      log: request.log,
      surface: 'admin_orders'
    });
    if (authenticated.status === 'unauthorized') {
      return reply.code(401).send(errorResponse('UNAUTHORIZED', authenticated.message));
    }

    let payload: ParsedOrderSyncPayload;
    try {
      payload = readSyncPayload(request.body);
    } catch (error) {
      if (isSyncPayloadValidationError(error)) {
        return reply
          .code(400)
          .send(errorResponse('INVALID_ORDER_SYNC_PAYLOAD', error.message, error.details));
      }
      const message = error instanceof Error ? error.message : 'Invalid order sync payload';
      return reply
        .code(400)
        .send(errorResponse('INVALID_ORDER_SYNC_PAYLOAD', message));
    }

    let result: SyncOrdersSnapshotResult;
    try {
      result = payload.orders.length === 0
        ? { orders: [], sync: createEmptySyncSummary() }
        : await dependencies.orderSyncService.syncOrdersSnapshot({
            ...payload,
            appId: authenticated.appId,
            shopDomain: authenticated.shopDomain,
            subject: authenticated.subject,
            orders: payload.orders
          });
    } catch (error) {
      if (error instanceof OrderSyncRouteLockedError) {
        return reply.code(409).send(errorResponse(error.code, error.message));
      }
      throw error;
    }

    const syncSummary = {
      ...result.sync,
      received: payload.received,
      skipped: result.sync.skipped + payload.skipped
    };
    const warnings = payload.reasons.map((reason) => ({
      code: 'ORDER_SYNC_SNAPSHOT_SKIPPED' as const,
      field: reason.field,
      message: reason.reason,
      orderIndex: reason.orderIndex,
      orderName: reason.orderName
    }));

    return reply.code(200).send({
      data: {
        orders: result.orders.map(toAdminOrderResponse),
        sync: syncSummary,
        ...(warnings.length > 0 ? { warnings } : {})
      },
      error: null
    });
  });

  app.get<{ Querystring: Record<string, string | string[] | undefined> }>(
    '/admin/orders',
    async (request, reply) => {
      const authenticated = authenticate(request.headers.authorization, request.headers['x-clever-app-id'], dependencies, {
        log: request.log,
        surface: 'admin_orders'
      });
      if (authenticated.status === 'unauthorized') {
        return reply.code(401).send(errorResponse('UNAUTHORIZED', authenticated.message));
      }

      let filters: ListCanonicalOrdersFilters;
      try {
        filters = readFilters(request.query);
      } catch {
        return reply.code(400).send(errorResponse('BAD_REQUEST', 'Invalid order filters'));
      }

      const orders = await dependencies.orderSyncService.listCanonicalOrders({
        filters,
        appId: authenticated.appId,
        shopDomain: authenticated.shopDomain
      });

      return reply.code(200).send({ data: { orders: orders.map(toAdminOrderResponse) }, error: null });
    }
  );

  app.get<{ Querystring: Record<string, string | string[] | undefined> }>(
    '/admin/orders/page',
    async (request, reply) => {
      const startedAt = performance.now();
      const authenticated = authenticate(request.headers.authorization, request.headers['x-clever-app-id'], dependencies, { log: request.log, surface: 'admin_orders' });
      if (authenticated.status === 'unauthorized') return reply.code(401).send(errorResponse('UNAUTHORIZED', authenticated.message));
      if (dependencies.ordersPaginationEnabled === false || dependencies.orderSyncService.listCanonicalOrdersPage === undefined) return reply.code(404).send(errorResponse('NOT_FOUND', 'Orders pagination is not enabled'));
      try {
        if (readSingleQueryValue(request.query.pageSize) !== String(ORDERS_PAGE_SIZE) || readSingleQueryValue(request.query.sort) !== ORDERS_SORT) {
          return reply.code(400).send(errorResponse('BAD_REQUEST', 'pageSize=50 and sort=id_desc are required'));
        }
        const after = readSingleQueryValue(request.query.after);
        const before = readSingleQueryValue(request.query.before);
        if (after !== null && before !== null) return reply.code(400).send(errorResponse('BAD_REQUEST', 'after and before are mutually exclusive'));
        const page = readNumericPage(request.query.page);
        if (page !== undefined && (after !== null || before !== null)) return reply.code(400).send(errorResponse('BAD_REQUEST', 'page cannot be combined with cursors'));
        const readWatermark = readOptionalReadWatermark(request.query.readWatermark);
        const result = await dependencies.orderSyncService.listCanonicalOrdersPage({
          ...(after === null ? {} : { after }),
          appId: authenticated.appId,
          ...(before === null ? {} : { before }),
          ...(page === undefined ? {} : { page }),
          ...(readWatermark === undefined ? {} : { readWatermark }),
          filters: readFilters(withoutResourceQuery(request.query)),
          shopDomain: authenticated.shopDomain
        });
        logAdminOrdersMetric(request, authenticated, 'admin_orders.page.query', startedAt, {
          cursorVersion: 1,
          filterHash: result.filterHash,
          rowCount: result.rows.length,
          status: 'success'
        });
        return reply.code(200).send({
          data: {
            freshness: {
              resultGeneratedAt: new Date().toISOString(),
              syncStatus: 'query_complete'
            },
            pageInfo: {
              ...result.pageInfo,
              pageSize: ORDERS_PAGE_SIZE,
              sort: result.sort
            },
            result: {
              count: result.count,
              countPrecision: result.countPrecision,
              filterHash: result.filterHash,
              readWatermark: result.pageInfo.readWatermark
            },
            rows: result.rows.map(toAdminOrderResponse)
          },
          error: null
        });
      } catch (error) {
        logAdminOrdersMetric(request, authenticated, 'admin_orders.page.query', startedAt, {
          status: 'error'
        });
        if (error instanceof InvalidOrdersCursorError) return reply.code(400).send(errorResponse(error.code, error.message));
        if (error instanceof OrdersPlanningReferenceDateError) return reply.code(400).send(errorResponse(error.code, error.message));
        if (error instanceof OrdersPaginationNotReadyError) return reply.code(409).send(errorResponse(error.code, error.message));
        return reply.code(400).send(errorResponse('BAD_REQUEST', 'Invalid orders page request'));
      }
    }
  );

  app.get<{ Querystring: Record<string, string | string[] | undefined> }>('/admin/orders/facets', async (request, reply) => {
    const startedAt = performance.now();
    const authenticated = authenticate(request.headers.authorization, request.headers['x-clever-app-id'], dependencies, { log: request.log, surface: 'admin_orders' });
    if (authenticated.status === 'unauthorized') return reply.code(401).send(errorResponse('UNAUTHORIZED', authenticated.message));
    if (dependencies.ordersPaginationEnabled === false || dependencies.orderSyncService.listCanonicalOrderFacets === undefined) return reply.code(404).send(errorResponse('NOT_FOUND', 'Orders facets are not enabled'));
    try {
      const data = await dependencies.orderSyncService.listCanonicalOrderFacets({ appId: authenticated.appId, filters: readFilters(request.query), shopDomain: authenticated.shopDomain });
      const metricData = objectOrNull(data) ?? {};
      logAdminOrdersMetric(request, authenticated, 'admin_orders.facets.query', startedAt, {
        countPrecision: metricData.countPrecision,
        filterHash: metricData.filterHash,
        status: 'success',
        totalCount: metricData.totalCount
      });
      return reply.code(200).send({ data, error: null });
    } catch (error) {
      logAdminOrdersMetric(request, authenticated, 'admin_orders.facets.query', startedAt, { status: 'error' });
      return ordersFilterError(reply, error);
    }
  });

  app.get<{ Querystring: Record<string, string | string[] | undefined> }>('/admin/orders/map-points', async (request, reply) => {
    const startedAt = performance.now();
    const authenticated = authenticate(request.headers.authorization, request.headers['x-clever-app-id'], dependencies, { log: request.log, surface: 'admin_orders' });
    if (authenticated.status === 'unauthorized') return reply.code(401).send(errorResponse('UNAUTHORIZED', authenticated.message));
    if (dependencies.ordersMapProjectionEnabled === false || dependencies.orderSyncService.listCanonicalOrderMapPoints === undefined) return reply.code(404).send(errorResponse('NOT_FOUND', 'Orders map projection is not enabled'));
    try {
      if (request.query.after !== undefined || request.query.before !== undefined) return reply.code(400).send(errorResponse('BAD_REQUEST', 'Map points do not accept table cursors'));
      const limitValue = readSingleQueryValue(request.query.limit);
      const limit = limitValue === null ? 500 : Number(limitValue);
      if (!Number.isInteger(limit) || limit < 1 || limit > 2_000) return reply.code(400).send(errorResponse('BAD_REQUEST', 'Invalid map point limit'));
      const data = await dependencies.orderSyncService.listCanonicalOrderMapPoints({ appId: authenticated.appId, filters: readFilters(withoutResourceQuery(request.query)), limit, shopDomain: authenticated.shopDomain });
      const metricData = objectOrNull(data) ?? {};
      logAdminOrdersMetric(request, authenticated, 'admin_orders.map_points.query', startedAt, {
        filterHash: metricData.filterHash,
        pointCount: Array.isArray(metricData.points) ? metricData.points.length : 0,
        status: 'success'
      });
      return reply.code(200).send({ data, error: null });
    } catch (error) {
      logAdminOrdersMetric(request, authenticated, 'admin_orders.map_points.query', startedAt, { status: 'error' });
      return ordersFilterError(reply, error);
    }
  });

  app.post<{ Body: unknown }>('/admin/orders/selection-snapshots', async (request, reply) => {
    const startedAt = performance.now();
    const authenticated = authenticate(request.headers.authorization, request.headers['x-clever-app-id'], dependencies, { log: request.log, surface: 'admin_orders' });
    if (authenticated.status === 'unauthorized') return reply.code(401).send(errorResponse('UNAUTHORIZED', authenticated.message));
    if (dependencies.ordersSelectionSnapshotsEnabled === false || dependencies.orderSyncService.createOrderSelectionSnapshot === undefined) return reply.code(404).send(errorResponse('NOT_FOUND', 'Order selection snapshots are not enabled'));
    try {
      const body = readSelectionSnapshotCreatePayload(request.body);
      const data = await dependencies.orderSyncService.createOrderSelectionSnapshot({ actor: authenticated.subject, appId: authenticated.appId, ...body, shopDomain: authenticated.shopDomain });
      const metricData = objectOrNull(data) ?? {};
      logAdminOrdersMetric(request, authenticated, 'admin_orders.selection_snapshot.create', startedAt, {
        filterHash: metricData.filterHash,
        selectedCount: metricData.selectedCount,
        skippedCount: body.excludeOrderIds?.length ?? 0,
        status: 'success'
      });
      return reply.code(201).send({ data, error: null });
    } catch (error) {
      logAdminOrdersMetric(request, authenticated, 'admin_orders.selection_snapshot.create', startedAt, { status: 'error' });
      return selectionSnapshotError(reply, error);
    }
  });

  app.patch<{ Body: unknown }>('/admin/orders/selection-snapshots', async (request, reply) => {
    const authenticated = authenticate(request.headers.authorization, request.headers['x-clever-app-id'], dependencies, { log: request.log, surface: 'admin_orders' });
    if (authenticated.status === 'unauthorized') return reply.code(401).send(errorResponse('UNAUTHORIZED', authenticated.message));
    if (dependencies.ordersSelectionSnapshotsEnabled === false || dependencies.orderSyncService.replaceOrderSelectionExclusions === undefined) return reply.code(404).send(errorResponse('NOT_FOUND', 'Order selection snapshots are not enabled'));
    try {
      const body = readSelectionSnapshotPatchPayload(request.body);
      const data = await dependencies.orderSyncService.replaceOrderSelectionExclusions({ actor: authenticated.subject, appId: authenticated.appId, ...body, shopDomain: authenticated.shopDomain });
      return reply.code(200).send({ data, error: null });
    } catch (error) { return selectionSnapshotError(reply, error); }
  });

  app.post<{ Body: unknown }>('/admin/orders/reconciliations', async (request, reply) => {
    const authenticated = authenticate(request.headers.authorization, request.headers['x-clever-app-id'], dependencies, {
      log: request.log,
      surface: 'admin_orders'
    });
    if (authenticated.status === 'unauthorized') {
      return reply.code(401).send(errorResponse('UNAUTHORIZED', authenticated.message));
    }
    if (dependencies.orderReconciliationService === undefined) {
      return reply.code(400).send(errorResponse('BAD_REQUEST', 'Order reconciliation jobs are not enabled in this runtime.'));
    }

    let payload: {
      correlationId?: string | undefined;
      mode?: ShopifyOrderReconciliationJobMode | undefined;
      overlapWindowSeconds?: number | undefined;
      pageSize?: number | undefined;
    };
    try {
      payload = readReconciliationPayload(request.body);
    } catch {
      return reply.code(400).send(errorResponse('BAD_REQUEST', 'Invalid order reconciliation payload'));
    }

    const result = await dependencies.orderReconciliationService.enqueueIfIdle({
      ...payload,
      appId: authenticated.appId,
      requestedBy: authenticated.subject,
      shopDomain: authenticated.shopDomain
    });
    if (result.job === null) {
      return reply.code(409).send(errorResponse('CONFLICT', 'Order reconciliation is already being queued.'));
    }

    return reply.code(202).send({
      data: {
        job: toAdminReconciliationJobResponse(result.job),
        reused: !result.enqueued
      },
      error: null
    });
  });

  app.get<{ Params: { jobId: string } }>(
    '/admin/orders/reconciliations/:jobId',
    async (request, reply) => {
      const authenticated = authenticate(request.headers.authorization, request.headers['x-clever-app-id'], dependencies, {
        log: request.log,
        surface: 'admin_orders'
      });
      if (authenticated.status === 'unauthorized') {
        return reply.code(401).send(errorResponse('UNAUTHORIZED', authenticated.message));
      }
      if (dependencies.orderReconciliationService === undefined) {
        return reply.code(400).send(errorResponse('BAD_REQUEST', 'Order reconciliation jobs are not enabled in this runtime.'));
      }

      const job = await dependencies.orderReconciliationService.status({
        appId: authenticated.appId,
        jobId: request.params.jobId,
        shopDomain: authenticated.shopDomain
      });
      if (job === null) {
        return reply.code(404).send(errorResponse('NOT_FOUND', 'Order reconciliation job not found'));
      }

      return reply.code(200).send({ data: { job: toAdminReconciliationJobResponse(job) }, error: null });
    }
  );

  app.patch<{ Body: unknown; Params: { orderId: string } }>(
    '/admin/orders/:orderId/metadata',
    async (request, reply) => {
      const authenticated = authenticate(request.headers.authorization, request.headers['x-clever-app-id'], dependencies, {
        log: request.log,
        surface: 'admin_orders'
      });
      if (authenticated.status === 'unauthorized') {
        return reply.code(401).send(errorResponse('UNAUTHORIZED', authenticated.message));
      }
      if (dependencies.orderSyncService.patchCanonicalOrder === undefined) {
        return reply.code(400).send(errorResponse('BAD_REQUEST', 'Order metadata editing is not enabled in this runtime.'));
      }

      let patch: RouteOpsCanonicalMetadataPatch;
      try {
        patch = readMetadataPatchPayload(request.body);
      } catch {
        return reply.code(400).send(errorResponse('BAD_REQUEST', 'Invalid order metadata payload'));
      }

      const order = await dependencies.orderSyncService.patchCanonicalOrder({
        actor: authenticated.subject,
        appId: authenticated.appId,
        orderId: request.params.orderId,
        patch,
        shopDomain: authenticated.shopDomain
      });
      if (order === null) {
        return reply.code(404).send(errorResponse('NOT_FOUND', 'Order not found'));
      }

      return reply.code(200).send({ data: { order: toAdminOrderResponse(order) }, error: null });
    }
  );

  app.patch<{ Body: unknown }>('/admin/orders/bulk-update', async (request, reply) => {
    const startedAt = performance.now();
    const authenticated = authenticate(request.headers.authorization, request.headers['x-clever-app-id'], dependencies, {
      log: request.log,
      surface: 'admin_orders'
    });
    if (authenticated.status === 'unauthorized') {
      return reply.code(401).send(errorResponse('UNAUTHORIZED', authenticated.message));
    }
    let payload: {
      field: 'payment' | 'state';
      orderIds: string[];
      selectionToken?: string;
      value: BulkOrderPaymentValue | BulkOrderStateValue;
    };
    try {
      payload = readBulkUpdatePayload(request.body);
    } catch {
      return reply.code(400).send(errorResponse('BAD_REQUEST', 'Invalid order bulk update payload'));
    }

    if (payload.selectionToken !== undefined) {
      if (dependencies.ordersSelectionSnapshotsEnabled === false || dependencies.orderSyncService.bulkPatchOrderSelectionSnapshot === undefined) {
        return reply.code(400).send(errorResponse('BAD_REQUEST', 'Snapshot bulk update is not enabled in this runtime.'));
      }
      try {
        const data = await dependencies.orderSyncService.bulkPatchOrderSelectionSnapshot({
          actor: authenticated.subject,
          appId: authenticated.appId,
          field: payload.field,
          selectionToken: payload.selectionToken,
          shopDomain: authenticated.shopDomain,
          value: payload.value
        });
        logAdminOrdersMetric(request, authenticated, 'admin_orders.bulk.resolve', startedAt, {
          noOpCount: data.noOp,
          resolvedCount: data.resolved,
          selectedCount: data.selected,
          skippedCount: data.skipped,
          skippedByReason: data.skippedByReason,
          status: 'success',
          updatedCount: data.updated
        });
        return reply.code(200).send({ data: { ...data, orders: [] }, error: null });
      } catch (error) {
        logAdminOrdersMetric(request, authenticated, 'admin_orders.bulk.resolve', startedAt, { status: 'error' });
        return selectionSnapshotError(reply, error);
      }
    }
    if (dependencies.orderSyncService.bulkPatchCanonicalOrderStatus === undefined) {
      return reply.code(400).send(errorResponse('BAD_REQUEST', 'Order bulk update is not enabled in this runtime.'));
    }
    const orders = await dependencies.orderSyncService.bulkPatchCanonicalOrderStatus({
      actor: authenticated.subject,
      appId: authenticated.appId,
      field: payload.field,
      orderIds: payload.orderIds,
      shopDomain: authenticated.shopDomain,
      value: payload.value
    });

    return reply.code(200).send({
      data: { orders: orders.map(toAdminOrderResponse), updated: orders.length },
      error: null
    });
  });
}

function toAdminOrderResponse(
  order: SyncOrdersSnapshotResult['orders'][number]
): Record<string, unknown> {
  const responseOrder: Record<string, unknown> = { ...order };
  delete responseOrder.rawWooGeocodeAddress;
  return responseOrder;
}

function toAdminReconciliationJobResponse(
  job: ShopifyOrderReconciliationJobDto
): ShopifyOrderReconciliationJobDto {
  const responseJob: Record<string, unknown> = { ...job };
  delete responseJob.leaseToken;
  return responseJob as ShopifyOrderReconciliationJobDto;
}

function readReconciliationPayload(value: unknown): {
  correlationId?: string | undefined;
  mode?: ShopifyOrderReconciliationJobMode | undefined;
  overlapWindowSeconds?: number | undefined;
  pageSize?: number | undefined;
} {
  const object = objectOrNull(value) ?? {};
  const mode = readReconciliationMode(object.mode);
  const correlationId = typeof object.correlationId === 'string' && /^[A-Za-z0-9._:-]{1,120}$/u.test(object.correlationId)
    ? object.correlationId
    : undefined;
  return {
    ...(correlationId === undefined ? {} : { correlationId }),
    ...(mode === undefined ? {} : { mode }),
    ...readOptionalIntegerField(object, 'overlapWindowSeconds', 60, 86_400),
    ...readOptionalIntegerField(object, 'pageSize', 1, 100)
  };
}

function readReconciliationMode(value: unknown): ShopifyOrderReconciliationJobMode | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === 'INCREMENTAL' || value === 'FULL') return value;
  throw new Error('Invalid reconciliation mode');
}

function readOptionalIntegerField(
  object: Record<string, unknown>,
  field: 'overlapWindowSeconds' | 'pageSize',
  min: number,
  max: number
): { [key in typeof field]?: number } {
  const value = object[field];
  if (value === undefined) return {};
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Invalid ${field}`);
  }
  return { [field]: value };
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function logAdminOrdersMetric(
  request: FastifyRequest,
  authenticated: { appId: string; shopDomain: string; status: 'authenticated'; subject: string },
  event: string,
  startedAt: number,
  metric: Record<string, unknown>
): void {
  const payload = redactTelemetry({
    ...metric,
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    event,
    requestId: request.id,
    shopHash: hashTelemetryShop(`${authenticated.appId}:${authenticated.shopDomain}`)
  }) as Record<string, unknown>;
  request.log.info(payload, 'Admin Orders performance metric');
}

function authenticate(
  authorization: string | undefined,
  appIdHeader: string | string[] | undefined,
  dependencies: AdminOrdersDependencies,
  options: AdminSessionAuthLogContext
):
  | { appId: string; shopDomain: string; status: 'authenticated'; subject: string }
  | { message: string; status: 'unauthorized' } {
  const sessionToken = extractBearerToken(authorization);
  if (sessionToken === null) {
    return { message: 'Missing bearer session token', status: 'unauthorized' };
  }

  try {
    const expectedAppId = readHeaderValue(appIdHeader);
    const verified = dependencies.sessionTokenVerifier.verify(
      sessionToken,
      expectedAppId === null ? {} : { expectedAppId }
    );
    return {
      appId: verified.appId ?? DEFAULT_SHOPIFY_APP_ID,
      shopDomain: verified.shopDomain,
      status: 'authenticated',
      subject: verified.subject
    };
  } catch (error) {
    logRejectedAdminSessionToken({ ...options, error });
    return { message: 'Invalid Shopify session token', status: 'unauthorized' };
  }
}

function readHeaderValue(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || raw.trim() === '') return null;
  return raw.trim();
}

function readSyncPayload(value: unknown): {
  deliveryCycle?: DeliveryCycleConfig;
  orders: ShopifyOrderNode[];
  reason: SyncOrdersSnapshotInput['reason'];
  reasons: SyncPayloadErrorDetail[];
  received: number;
  source: 'clever-app-orders';
  skipped: number;
} {
  const object = requireObject(value);
  const deliveryCycle = readDeliveryCycle(object.deliveryCycle);
  const source = readStringFromAllowedValues(object.source, {
    allowedValues: ['clever-app-orders'] as const
  });
  if (source === null) {
    throw createSyncPayloadValidationError('Invalid order sync payload', [
      { field: 'source', orderIndex: -1, orderName: '#request', reason: 'Expected clever-app-orders' }
    ]);
  }
  const reason = readStringFromAllowedValues(object.reason, {
    allowedValues: ['orders_page_open', 'manual_refresh', 'route_create_preflight'] as const
  });
  if (reason === null) {
    throw createSyncPayloadValidationError('Invalid order sync payload', [
      {
        field: 'reason',
        orderIndex: -1,
        orderName: '#request',
        reason: 'Must be orders_page_open, manual_refresh, or route_create_preflight'
      }
    ]);
  }
  if (!Array.isArray(object.orders)) {
    throw createSyncPayloadValidationError('Invalid order sync payload', [
      { field: 'orders', orderIndex: -1, orderName: '#request', reason: 'Must be an array' }
    ]);
  }
  if (reason === 'manual_refresh' && object.orders.length > 2000) {
    throw createSyncPayloadValidationError('Manual route refresh is limited to 2000 orders per operation', [
      {
        field: 'orders',
        orderIndex: -1,
        orderName: '#request',
        reason: `Received ${object.orders.length} orders`
      }
    ]);
  }

  const results = object.orders.map((order, orderIndex) => readShopifyOrderSnapshot(order, orderIndex));
  const valid = results.filter(
    (result): result is { issues: SyncPayloadErrorDetail[]; order: ShopifyOrderNode } =>
      result.order !== null
  );
  const reasons = results.flatMap((result) => result.issues);
  const seenOrderIds = new Set<string>();
  for (const [orderIndex, result] of results.entries()) {
    const orderId = result.order?.id;
    if (orderId === undefined) continue;
    if (seenOrderIds.has(orderId)) {
      reasons.push(readSyncOrderFieldIssue(
        orderIndex,
        result.order?.name ?? orderId,
        'id',
        'Duplicate Shopify order id'
      ));
    }
    seenOrderIds.add(orderId);
  }
  const timestampIssues = reasons.filter((reason) => ORDER_SYNC_TIMESTAMP_FIELDS.has(reason.field));
  if (timestampIssues.length > 0) {
    throw createSyncPayloadValidationError('Invalid order sync timestamp', timestampIssues);
  }
  if (reason === 'manual_refresh' && reasons.length > 0) {
    throw createSyncPayloadValidationError('Manual route refresh requires complete order snapshots', reasons);
  }

  return {
    ...(deliveryCycle === undefined ? {} : { deliveryCycle }),
    orders: valid.map((result) => result.order),
    reason,
    reasons,
    received: object.orders.length,
    source,
    skipped: results.length - valid.length
  };
}

function readDeliveryCycle(value: unknown): DeliveryCycleConfig | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw createSyncPayloadValidationError('Invalid order sync delivery cycle', [
      { field: 'deliveryCycle', orderIndex: -1, orderName: '#request', reason: 'Must be an object' }
    ]);
  }

  const object = value as Record<string, unknown>;
  const cutoffTime = readNullableString(object.cutoffTime);
  const cutoffWeekday = readStringFromAllowedValues(object.cutoffWeekday, {
    allowedValues: ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'] as const
  });
  const timeZone = readNullableString(object.timeZone);
  const validTimeZone = timeZone !== null && isValidTimeZone(timeZone);

  if (cutoffTime === null || !/^([01]\d|2[0-3]):[0-5]\d$/u.test(cutoffTime) || cutoffWeekday === null || !validTimeZone) {
    throw createSyncPayloadValidationError('Invalid order sync delivery cycle', [
      {
        field: 'deliveryCycle',
        orderIndex: -1,
        orderName: '#request',
        reason: 'Requires a valid cutoffWeekday, HH:mm cutoffTime, and IANA timeZone'
      }
    ]);
  }

  return { cutoffTime, cutoffWeekday, timeZone };
}

function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function readBulkUpdatePayload(value: unknown): {
  field: 'payment' | 'state';
  orderIds: string[];
  selectionToken?: string;
  value: BulkOrderPaymentValue | BulkOrderStateValue;
} {
  const object = requireObject(value);
  const selectionToken = readNullableString(object.selectionToken);
  const orderIds = Array.isArray(object.orderIds)
    ? object.orderIds.flatMap((orderId) => {
        const text = readNullableString(orderId);
        return text === null ? [] : [text];
      })
    : [];
  const field = readStringFromAllowedValues(object.field, {
    allowedValues: ['payment', 'state'] as const
  });
  if ((orderIds.length === 0 && selectionToken === null) || (orderIds.length > 0 && selectionToken !== null) || field === null) {
    throw new Error('invalid bulk update payload');
  }

  const parsedValue =
    field === 'state'
      ? readStringFromAllowedValues(object.value, { allowedValues: BULK_ORDER_STATE_VALUES })
      : readStringFromAllowedValues(object.value, { allowedValues: BULK_ORDER_PAYMENT_VALUES });
  if (parsedValue === null) {
    throw new Error('invalid bulk update value');
  }

  return { field, orderIds: [...new Set(orderIds)], ...(selectionToken === null ? {} : { selectionToken }), value: parsedValue };
}

function readSelectionSnapshotCreatePayload(value: unknown): {
  excludeOrderIds?: string[];
  filters?: ListCanonicalOrdersFilters;
} {
  const object = requireObject(value);
  const allowed = new Set(['excludeOrderIds', 'filters', 'sort']);
  if (Object.keys(object).some((key) => !allowed.has(key)) || (object.sort !== undefined && object.sort !== ORDERS_SORT)) {
    throw new Error('invalid selection snapshot payload');
  }
  const excludeOrderIds = readStringArrayValue(object.excludeOrderIds);
  const rawFilters = object.filters === undefined ? {} : requireObject(object.filters);
  const query = Object.fromEntries(Object.entries(rawFilters).map(([key, item]) => {
    if (typeof item === 'boolean') return [key, String(item)];
    if (typeof item !== 'string') throw new Error('invalid selection filter');
    return [key, item];
  }));
  return {
    ...(excludeOrderIds.length === 0 ? {} : { excludeOrderIds }),
    filters: readFilters(query)
  };
}

function readSelectionSnapshotPatchPayload(value: unknown): {
  excludeOrderIds: string[];
  selectionToken: string;
} {
  const object = requireObject(value);
  if (Object.keys(object).some((key) => key !== 'excludeOrderIds' && key !== 'selectionToken')) throw new Error('invalid snapshot patch payload');
  const selectionToken = readNullableString(object.selectionToken);
  if (selectionToken === null) throw new Error('selection token required');
  return { excludeOrderIds: readStringArrayValue(object.excludeOrderIds), selectionToken };
}

function readStringArrayValue(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('expected string array');
  const result = value.map(readNullableString);
  if (result.some((item) => item === null)) throw new Error('expected non-empty strings');
  return [...new Set(result as string[])];
}

function readMetadataPatchPayload(value: unknown): RouteOpsCanonicalMetadataPatch {
  const object = requireObject(value);
  const patch: RouteOpsCanonicalMetadataPatch = {};

  if (Object.hasOwn(object, 'deliveryDate')) {
    const deliveryDate = readNullableString(object.deliveryDate);
    if (deliveryDate !== null) requireDateOnly(deliveryDate);
    patch.deliveryDate = deliveryDate;
  }
  if (Object.hasOwn(object, 'deliveryArea')) {
    patch.deliveryArea = readNullableString(object.deliveryArea);
  }

  if (Object.keys(patch).length === 0) {
    throw new Error('metadata patch required');
  }

  return patch;
}

function readSyncOrderFieldIssue(
  orderIndex: number,
  orderName: string,
  field: string,
  reason: string
): SyncPayloadErrorDetail {
  return {
    field,
    orderIndex,
    orderName,
    reason
  };
}

function readShopifyOrderSnapshot(
  value: unknown,
  orderIndex: number
): {
  order: ShopifyOrderNode | null;
  issues: SyncPayloadErrorDetail[];
} {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) {
    return {
      issues: [readSyncOrderFieldIssue(orderIndex, `#${orderIndex + 1}`, 'order', 'Order snapshot must be an object')],
      order: null
    };
  }

  const object = value as Record<string, unknown>;
  const fallbackOrderName = readNullableString(object.name) ?? readNullableString(object.id) ?? `#${orderIndex + 1}`;
  const issues: SyncPayloadErrorDetail[] = [];

  const id = readRequiredStringOrIssue(object.id, (reason) =>
    issues.push(readSyncOrderFieldIssue(orderIndex, fallbackOrderName, 'id', reason))
  );
  const legacyResourceId = readRequiredStringOrIssue(object.legacyResourceId, (reason) =>
    issues.push(readSyncOrderFieldIssue(orderIndex, fallbackOrderName, 'legacyResourceId', reason))
  );
  const name = readRequiredStringOrIssue(object.name, (reason) =>
    issues.push(readSyncOrderFieldIssue(orderIndex, fallbackOrderName, 'name', reason))
  );
  const updatedAt = readDateOrIssue(
    object.updatedAt,
    (reason) =>
      issues.push(readSyncOrderFieldIssue(orderIndex, fallbackOrderName, 'updatedAt', reason)),
    true
  );

  if (id === null || legacyResourceId === null || name === null || updatedAt === null) {
    return { order: null, issues };
  }

  const orderName = name;

  const currentTotalPriceSet = readMoneySet(
    object.currentTotalPriceSet,
    (reason) =>
      issues.push(
        readSyncOrderFieldIssue(orderIndex, orderName, 'currentTotalPriceSet', reason)
      )
  );
  const shippingAddress = readShippingAddress(
    object.shippingAddress,
    (reason, field) =>
      issues.push(readSyncOrderFieldIssue(orderIndex, orderName, field, reason))
  );
  const lineItems = readLineItems(
    object.lineItems,
    (reason, field) => issues.push(readSyncOrderFieldIssue(orderIndex, orderName, field, reason))
  );
  const customAttributes = readAttributes(
    object.customAttributes,
    (reason, field) => issues.push(readSyncOrderFieldIssue(orderIndex, orderName, field, reason))
  );

  const order: ShopifyOrderNode = {
    cancelledAt: readDateOrIssue(
      object.cancelledAt,
      (reason) => issues.push(readSyncOrderFieldIssue(orderIndex, orderName, 'cancelledAt', reason))
    ),
    createdAt: readDateOrIssue(
      object.createdAt,
      (reason) => issues.push(readSyncOrderFieldIssue(orderIndex, orderName, 'createdAt', reason))
    ),
    currentTotalPriceSet,
    customAttributes,
    displayFinancialStatus: readNullableString(object.displayFinancialStatus),
    displayFulfillmentStatus: readNullableString(object.displayFulfillmentStatus),
    email: readNullableString(object.email),
    id,
    legacyResourceId,
    lineItems,
    name,
    note: readNullableString(object.note),
    paymentGatewayNames: readStringArray(object.paymentGatewayNames),
    phone: readNullableString(object.phone),
    processedAt: readDateOrIssue(
      object.processedAt,
      (reason) => issues.push(readSyncOrderFieldIssue(orderIndex, orderName, 'processedAt', reason))
    ),
    shippingAddress,
    tags: readStringArray(object.tags),
    updatedAt
  };

  return { order, issues };
}

function readMoneySet(
  value: unknown,
  onIssue: (reason: string) => void
): ShopifyOrderNode['currentTotalPriceSet'] {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    onIssue('currentTotalPriceSet must be an object');
    return null;
  }

  const object = value as Record<string, unknown>;
  const shopMoneyValue = object.shopMoney;
  if (shopMoneyValue === null || shopMoneyValue === undefined || typeof shopMoneyValue !== 'object' || Array.isArray(shopMoneyValue)) {
    onIssue('currentTotalPriceSet.shopMoney must be an object');
    return null;
  }

  const shopMoney = shopMoneyValue as Record<string, unknown>;
  const amount = readMoneyAmount(shopMoney.amount);
  const currencyCode = readNullableString(shopMoney.currencyCode);

  if (amount === null || currencyCode === null) {
    onIssue('currentTotalPriceSet.shopMoney.amount is invalid or missing');
    return null;
  }

  return { shopMoney: { amount, currencyCode } };
}

function readMoneyAmount(value: unknown): string | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : null;
  }
  if (typeof value !== 'string') {
    return null;
  }
  const text = value.trim();
  if (text === '') {
    return null;
  }
  if (!/^[-+]?(\d+(\.\d+)?|\.\d+)$/u.test(text)) {
    return null;
  }
  return text;
}

function readLineItems(
  value: unknown,
  onIssue: (reason: string, field: string) => void
): ShopifyOrderNode['lineItems'] {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'object' || Array.isArray(value) || value === null) {
    onIssue('lineItems must be an object', 'lineItems');
    return null;
  }

  const object = value as Record<string, unknown>;

  const nodes =
    object.nodes === undefined ? null : parseLineItemArray(object.nodes, onIssue, 'lineItems.nodes');
  const edges =
    object.edges === undefined ? null : parseLineItemEdges(object.edges, onIssue, 'lineItems.edges');

  return { edges, nodes };
}

function parseLineItemArray(
  value: unknown,
  onIssue: (reason: string, field: string) => void,
  field: string
): NonNullable<NonNullable<ShopifyOrderNode['lineItems']>['nodes']> {
  if (!Array.isArray(value)) {
    onIssue(`${field} must be an array`, field);
    return [];
  }
  return value
    .map((item, itemIndex) => parseLineItem(item, (reason) => onIssue(`lineItems.nodes[${itemIndex}] ${reason}`, field)))
    .filter((lineItem): lineItem is NonNullable<NonNullable<ShopifyOrderNode['lineItems']>['nodes']>[number] => lineItem !== null);
}

function parseLineItemEdges(
  value: unknown,
  onIssue: (reason: string, field: string) => void,
  field: string
): NonNullable<NonNullable<ShopifyOrderNode['lineItems']>['edges']> {
  if (!Array.isArray(value)) {
    onIssue(`${field} must be an array`, field);
    return [];
  }

  const edges = value
    .flatMap((item, itemIndex) => {
      const nodeObject = parseEdgeItem(item);
      if (nodeObject === null) {
        onIssue(`lineItems.edges[${itemIndex}] invalid item`, field);
        return [];
      }
      const parsedItem = parseLineItem(nodeObject.node, (reason) =>
        onIssue(`lineItems.edges[${itemIndex}].node ${reason}`, field)
      );
      return parsedItem === null ? [] : [{ node: parsedItem }];
    })
    .filter((edge): edge is NonNullable<NonNullable<ShopifyOrderNode['lineItems']>['edges']>[number] => edge !== null);

  return edges;

  function parseEdgeItem(value: unknown): { node: unknown } | null {
    if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    return value as { node: unknown };
  }
}

function parseLineItem(
  value: unknown,
  onIssue: (reason: string) => void
): NonNullable<NonNullable<ShopifyOrderNode['lineItems']>['nodes']>[number] | null {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) {
    onIssue('must be an object');
    return null;
  }
  const object = value as Record<string, unknown>;
  const quantity = readNullableNumber(object.quantity);
  if (quantity === null && object.quantity !== undefined && object.quantity !== null && object.quantity !== '') {
    onIssue('quantity invalid');
  }

  return {
    name: readNullableString(object.name),
    quantity,
    sku: readNullableString(object.sku),
    title: readNullableString(object.title),
    variantTitle: readNullableString(object.variantTitle)
  };
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => (typeof item === 'string' ? [item] : []));
}

function readAttributes(
  value: unknown,
  onIssue: (reason: string, field: string) => void
): NonNullable<ShopifyOrderNode['customAttributes']> {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    onIssue('customAttributes must be an array', 'customAttributes');
    return [];
  }
  return value.flatMap((item, itemIndex) => {
    if (item === null || item === undefined || typeof item !== 'object' || Array.isArray(item)) {
      onIssue(`customAttributes[${itemIndex}] invalid item`, 'customAttributes');
      return [];
    }
    const object = item as Record<string, unknown>;
    const key = readNullableString(object.key);
    const attributeValue = readNullableString(object.value);
    if (key === null || attributeValue === null) {
      onIssue(`customAttributes[${itemIndex}] missing key/value`, `customAttributes[${itemIndex}]`);
      return [];
    }
    return [{ key, value: attributeValue }];
  });
}

function readShippingAddress(
  value: unknown,
  onIssue: (reason: string, field: string) => void
): ShopifyOrderNode['shippingAddress'] {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'object' || Array.isArray(value) || value === null) {
    onIssue('shippingAddress must be an object', 'shippingAddress');
    return null;
  }
  const object = value as Record<string, unknown>;
  const parsedLatitude = readNullableNumber(object.latitude);
  const parsedLongitude = readNullableNumber(object.longitude);
  if (parsedLatitude === null && object.latitude !== undefined && object.latitude !== null && object.latitude !== '') {
    onIssue('shippingAddress.latitude invalid', 'shippingAddress.latitude');
  }
  if (parsedLongitude === null && object.longitude !== undefined && object.longitude !== null && object.longitude !== '') {
    onIssue('shippingAddress.longitude invalid', 'shippingAddress.longitude');
  }
  return {
    address1: readNullableString(object.address1),
    address2: readNullableString(object.address2),
    city: readNullableString(object.city),
    countryCodeV2: readNullableString(object.countryCodeV2),
    latitude: parsedLatitude,
    longitude: parsedLongitude,
    name: readNullableString(object.name),
    phone: readNullableString(object.phone),
    province: readNullableString(object.province),
    provinceCode: readNullableString(object.provinceCode),
    zip: readNullableString(object.zip)
  };
}

function readRequiredStringOrIssue(
  value: unknown,
  onIssue: (reason: string) => void
): string | null {
  const next = readNullableString(value);
  if (next === null) {
    onIssue('Expected non-empty string');
    return null;
  }
  return next;
}

function readDateOrIssue(
  value: unknown,
  onIssue: (reason: string) => void,
  required = false
): string | null {
  if (value === undefined || value === null || value === '') {
    return required ? (onIssue('Expected ISO date string'), null) : null;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    onIssue('Expected ISO date string');
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    onIssue('Expected ISO date string');
    return null;
  }
  return value;
}

function readFilters(query: Record<string, string | string[] | undefined>): ListCanonicalOrdersFilters {
  const knownKeys = new Set([
    'deliveryArea', 'deliveryBatchEndDate', 'deliveryBatchStartDate', 'deliveryDate', 'deliveryDateFrom',
    'deliverySession', 'deliveryState', 'deliveryWeekday', 'geocodeStatus', 'operateDeliveryStatus',
    'orderHealth', 'orderedDate', 'orderedDateFrom', 'orderedDateTo', 'planned', 'planningGroupKey', 'q',
    'readiness', 'routeOpsScope', 'routeOpsTab', 'routeOpsToday', 'routeScopeKey', 'scope', 'search',
    'serviceType', 'tab'
  ]);
  if (Object.keys(query).some((key) => !knownKeys.has(key))) throw new Error('unknown order filter');
  const filters: ListCanonicalOrdersFilters = {};
  const readiness = readSingleQuery(query.readiness);
  if (readiness !== null) {
    if (readiness !== 'READY_TO_PLAN' && readiness !== 'NEEDS_REVIEW' && readiness !== 'SKIPPED') {
      throw new Error('invalid readiness');
    }
    filters.readiness = readiness;
  }
  const planned = readSingleQuery(query.planned);
  if (planned !== null) {
    if (planned !== 'true' && planned !== 'false') throw new Error('invalid planned');
    filters.planned = planned === 'true';
  }
  const deliveryWeekday = readSingleQuery(query.deliveryWeekday);
  if (deliveryWeekday !== null) {
    if (
      deliveryWeekday !== 'SUNDAY' &&
      deliveryWeekday !== 'MONDAY' &&
      deliveryWeekday !== 'TUESDAY' &&
      deliveryWeekday !== 'WEDNESDAY' &&
      deliveryWeekday !== 'THURSDAY' &&
      deliveryWeekday !== 'FRIDAY' &&
      deliveryWeekday !== 'SATURDAY'
    ) {
      throw new Error('invalid deliveryWeekday');
    }
    filters.deliveryWeekday = deliveryWeekday;
  }
  const serviceType = readSingleQuery(query.serviceType);
  if (serviceType !== null) {
    if (serviceType !== 'DELIVERY' && serviceType !== 'EVENING_DELIVERY' && serviceType !== 'PICKUP') {
      throw new Error('invalid serviceType');
    }
    filters.serviceType = serviceType;
  }
  const geocodeStatus = readSingleQuery(query.geocodeStatus);
  if (geocodeStatus !== null) {
    if (
      geocodeStatus !== 'PENDING' &&
      geocodeStatus !== 'RESOLVED' &&
      geocodeStatus !== 'FAILED' &&
      geocodeStatus !== 'NOT_REQUIRED'
    ) {
      throw new Error('invalid geocodeStatus');
    }
    filters.geocodeStatus = geocodeStatus;
  }
  const deliveryDate = readSingleQuery(query.deliveryDate);
  if (deliveryDate !== null) {
    if (deliveryDate !== 'pending') requireDateOnly(deliveryDate);
    filters.deliveryDate = deliveryDate;
  }
  const deliveryDateFrom = readSingleQuery(query.deliveryDateFrom);
  if (deliveryDateFrom !== null) {
    requireDateOnly(deliveryDateFrom);
    filters.deliveryDateFrom = deliveryDateFrom;
  }
  const deliveryArea = readSingleQuery(query.deliveryArea);
  if (deliveryArea !== null) filters.deliveryArea = deliveryArea;
  const deliveryBatchStartDate = readSingleQuery(query.deliveryBatchStartDate);
  if (deliveryBatchStartDate !== null) {
    requireDateOnly(deliveryBatchStartDate);
    filters.deliveryBatchStartDate = deliveryBatchStartDate;
  }
  const deliveryBatchEndDate = readSingleQuery(query.deliveryBatchEndDate);
  if (deliveryBatchEndDate !== null) {
    requireDateOnly(deliveryBatchEndDate);
    filters.deliveryBatchEndDate = deliveryBatchEndDate;
  }
  const deliverySession = readSingleQuery(query.deliverySession);
  if (deliverySession !== null) {
    if (deliverySession !== 'DAY' && deliverySession !== 'EVENING' && deliverySession !== 'PICKUP') {
      throw new Error('invalid deliverySession');
    }
    filters.deliverySession = deliverySession;
  }
  const routeScopeKey = readSingleQuery(query.routeScopeKey);
  if (routeScopeKey !== null) filters.routeScopeKey = routeScopeKey;
  const planningGroupKey = readSingleQuery(query.planningGroupKey);
  if (planningGroupKey !== null) filters.planningGroupKey = planningGroupKey;
  const search = readSingleQuery(query.search);
  const legacySearch = readSingleQuery(query.q);
  if (search !== null || legacySearch !== null) filters.search = (search ?? legacySearch) as string;
  const deliveryState = readSingleQuery(query.deliveryState);
  if (deliveryState !== null) {
    if (!['unplanned', 'planned', 'assigned_undelivered', 'past_due', 'delivered', 'fulfilled', 'unfulfilled'].includes(deliveryState)) throw new Error('invalid deliveryState');
    filters.deliveryState = deliveryState as NonNullable<ListCanonicalOrdersFilters['deliveryState']>;
  }
  const legacyOrderedDate = readSingleQuery(query.orderedDate);
  const orderedDateFrom = readSingleQuery(query.orderedDateFrom) ?? legacyOrderedDate;
  const orderedDateTo = readSingleQuery(query.orderedDateTo) ?? legacyOrderedDate;
  if (orderedDateFrom !== null) { requireDateOnly(orderedDateFrom); filters.orderedDateFrom = orderedDateFrom; }
  if (orderedDateTo !== null) { requireDateOnly(orderedDateTo); filters.orderedDateTo = orderedDateTo; }
  if (filters.orderedDateFrom !== undefined && filters.orderedDateTo !== undefined && filters.orderedDateFrom > filters.orderedDateTo) {
    [filters.orderedDateFrom, filters.orderedDateTo] = [filters.orderedDateTo, filters.orderedDateFrom];
  }
  const scope = readSingleQuery(query.scope);
  if (scope !== null) {
    if (scope !== 'history' && scope !== 'planning') throw new Error('invalid scope');
    filters.scope = scope;
  }
  const tab = readSingleQuery(query.tab);
  if (tab !== null) {
    if (!['all', 'needs_review', 'planned', 'unplanned'].includes(tab)) throw new Error('invalid tab');
    filters.tab = tab as NonNullable<ListCanonicalOrdersFilters['tab']>;
  }
  const routeOpsScope = readSingleQuery(query.routeOpsScope);
  if (routeOpsScope !== null) {
    if (routeOpsScope !== 'history' && routeOpsScope !== 'planning') throw new Error('invalid routeOpsScope');
    filters.routeOpsScope = routeOpsScope;
  }
  const routeOpsTab = readSingleQuery(query.routeOpsTab);
  if (routeOpsTab !== null) {
    if (!['all', 'needs_review', 'planned', 'unplanned'].includes(routeOpsTab)) throw new Error('invalid routeOpsTab');
    filters.routeOpsTab = routeOpsTab as NonNullable<ListCanonicalOrdersFilters['routeOpsTab']>;
  }
  const routeOpsToday = readSingleQuery(query.routeOpsToday);
  if (routeOpsToday !== null) { requireDateOnly(routeOpsToday); filters.routeOpsToday = routeOpsToday; }
  const operateDeliveryStatus = readSingleQuery(query.operateDeliveryStatus);
  if (operateDeliveryStatus !== null) {
    if (!['preparing', 'ready', 'in_progress', 'completed'].includes(operateDeliveryStatus)) throw new Error('invalid operateDeliveryStatus');
    filters.operateDeliveryStatus = operateDeliveryStatus as NonNullable<ListCanonicalOrdersFilters['operateDeliveryStatus']>;
  }
  const orderHealth = readSingleQuery(query.orderHealth);
  if (orderHealth !== null) {
    if (orderHealth !== 'normal' && orderHealth !== 'needs_review') throw new Error('invalid orderHealth');
    filters.orderHealth = orderHealth;
  }
  requireOrdersPlanningReferenceDate(filters);
  return filters;
}

function withoutResourceQuery(query: Record<string, string | string[] | undefined>) {
  const filters = { ...query };
  delete filters.after;
  delete filters.before;
  delete filters.limit;
  delete filters.page;
  delete filters.pageSize;
  delete filters.readWatermark;
  delete filters.sort;
  return filters;
}

function readSingleQueryValue(value: string | string[] | undefined): string | null {
  return readSingleQuery(value);
}

function readNumericPage(value: string | string[] | undefined): number | undefined {
  const raw = readSingleQuery(value);
  if (raw === null) return undefined;
  if (!/^[1-9]\d*$/u.test(raw)) throw new Error('invalid page');
  const page = Number(raw);
  if (!Number.isSafeInteger(page)) throw new Error('invalid page');
  return page;
}

function readOptionalReadWatermark(value: string | string[] | undefined): string | undefined {
  const raw = readSingleQuery(value);
  if (raw === null) return undefined;
  if (!Number.isFinite(Date.parse(raw))) throw new Error('invalid readWatermark');
  return raw;
}

function selectionSnapshotError(reply: FastifyReply, error: unknown) {
  if (error instanceof OrdersPlanningReferenceDateError) return reply.code(400).send(errorResponse(error.code, error.message));
  if (error instanceof OrderSelectionSnapshotError) return reply.code(400).send(errorResponse(error.code, error.message));
  return reply.code(400).send(errorResponse('BAD_REQUEST', 'Invalid selection snapshot request'));
}

function ordersFilterError(reply: FastifyReply, error: unknown) {
  if (error instanceof OrdersPlanningReferenceDateError) return reply.code(400).send(errorResponse(error.code, error.message));
  return reply.code(400).send(errorResponse('BAD_REQUEST', 'Invalid order filters'));
}


function requireDateOnly(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new Error('date must be YYYY-MM-DD');
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error('date must be valid');
  }
}

function extractBearerToken(authorization: string | undefined): string | null {
  if (authorization === undefined) {
    return null;
  }

  const match = /^Bearer\s+(.+)$/iu.exec(authorization.trim());
  if (match?.[1] === undefined || match[1].trim() === '') {
    return null;
  }

  return match[1].trim();
}

function requireObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('object required');
  }
  return value as Record<string, unknown>;
}

function readStringFromAllowedValues<T extends string>(
  value: unknown,
  options: { allowedValues: readonly T[] }
): T | null {
  const normalized = readNullableString(value);
  if (normalized === null || !options.allowedValues.includes(normalized as T)) {
    return null;
  }
  return normalized as T;
}

function readNullableString(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    return null;
  }
  const text = value.trim();
  return text === '' ? null : text;
}

function readNullableNumber(value: unknown): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') {
      return null;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readSingleQuery(value: string | string[] | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  if (Array.isArray(value)) {
    throw new Error('single query value expected');
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function createEmptySyncSummary(): {
  created: number;
  needsReview: number;
  readyToPlan: number;
  received: number;
  skipped: number;
  unchanged: number;
  updated: number;
} {
  return {
    created: 0,
    needsReview: 0,
    readyToPlan: 0,
    received: 0,
    skipped: 0,
    unchanged: 0,
    updated: 0
  };
}

function createSyncPayloadValidationError(
  message: string,
  details: SyncPayloadErrorDetail[]
): SyncPayloadValidationError {
  const error = new Error(message) as SyncPayloadValidationError;
  error.code = 'INVALID_ORDER_SYNC_PAYLOAD';
  error.details = details;
  error.message = message;
  return error;
}

function isSyncPayloadValidationError(
  error: unknown
): error is SyncPayloadValidationError {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code: string }).code === 'INVALID_ORDER_SYNC_PAYLOAD' &&
    Array.isArray((error as { details: unknown }).details)
  );
}

function errorResponse(
  code: string,
  message: string,
  details: SyncPayloadErrorDetail[] = []
): {
  data: null;
  error: { code: string; details?: SyncPayloadErrorDetail[]; message: string };
} {
  return {
    data: null,
    error: {
      code,
      ...(details.length > 0 ? { details } : {}),
      message
    }
  };
}
