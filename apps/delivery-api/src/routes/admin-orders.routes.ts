import type { FastifyInstance } from 'fastify';

import {
  logRejectedAdminSessionToken,
  type AdminSessionAuthLogContext,
  type AdminSessionTokenVerifier
} from './admin-session-auth.js';

import { DEFAULT_SHOPIFY_APP_ID } from '../modules/shopify/shopify-app-scope.js';
import type { ListCanonicalOrdersFilters } from '../modules/shopify/order-sync.repository.js';
import type { ShopifyOrderNode } from '../modules/shopify/order-sync.mapper.js';
import type { SyncOrdersSnapshotInput, SyncOrdersSnapshotResult } from '../modules/shopify/order-sync.service.js';

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
  orders: ShopifyOrderNode[];
  reason: SyncOrdersSnapshotInput['reason'];
  reasons: SyncPayloadErrorDetail[];
  received: number;
  source: 'clever-app-orders';
  skipped: number;
};

const ORDER_SYNC_TIMESTAMP_FIELDS = new Set(['cancelledAt', 'createdAt', 'processedAt', 'updatedAt']);

export type AdminOrdersDependencies = {
  orderSyncService: {
    listCanonicalOrders(input: {
      filters?: ListCanonicalOrdersFilters;
      appId?: string | undefined;
      shopDomain: string;
    }): Promise<SyncOrdersSnapshotResult['orders']>;
    syncOrdersSnapshot(input: SyncOrdersSnapshotInput): Promise<SyncOrdersSnapshotResult>;
  };
  sessionTokenVerifier: AdminSessionTokenVerifier;
};

export function registerAdminOrdersRoutes(
  app: FastifyInstance,
  dependencies: AdminOrdersDependencies
): void {
  app.patch<{ Body: unknown }>('/admin/orders/sync', async (request, reply) => {
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

    const result: SyncOrdersSnapshotResult =
      payload.orders.length === 0
        ? { orders: [], sync: createEmptySyncSummary() }
        : await dependencies.orderSyncService.syncOrdersSnapshot({
            ...payload,
            appId: authenticated.appId,
            shopDomain: authenticated.shopDomain,
            subject: authenticated.subject,
            orders: payload.orders
          });

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
}

function toAdminOrderResponse(
  order: SyncOrdersSnapshotResult['orders'][number]
): Record<string, unknown> {
  const responseOrder: Record<string, unknown> = { ...order };
  delete responseOrder.rawWooGeocodeAddress;
  return responseOrder;
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
  orders: ShopifyOrderNode[];
  reason: SyncOrdersSnapshotInput['reason'];
  reasons: SyncPayloadErrorDetail[];
  received: number;
  source: 'clever-app-orders';
  skipped: number;
} {
  const object = requireObject(value);
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

  const results = object.orders.map((order, orderIndex) => readShopifyOrderSnapshot(order, orderIndex));
  const valid = results.filter(
    (result): result is { issues: SyncPayloadErrorDetail[]; order: ShopifyOrderNode } =>
      result.order !== null
  );
  const reasons = results.flatMap((result) => result.issues);
  const timestampIssues = reasons.filter((reason) => ORDER_SYNC_TIMESTAMP_FIELDS.has(reason.field));
  if (timestampIssues.length > 0) {
    throw createSyncPayloadValidationError('Invalid order sync timestamp', timestampIssues);
  }

  return {
    orders: valid.map((result) => result.order),
    reason,
    reasons,
    received: object.orders.length,
    source,
    skipped: results.length - valid.length
  };
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
    phone: readNullableString(object.phone),
    processedAt: readDateOrIssue(
      object.processedAt,
      (reason) => issues.push(readSyncOrderFieldIssue(orderIndex, orderName, 'processedAt', reason))
    ),
    shippingAddress,
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
    requireDateOnly(deliveryDate);
    filters.deliveryDate = deliveryDate;
  }
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
  if (search !== null) filters.search = search;
  return filters;
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
