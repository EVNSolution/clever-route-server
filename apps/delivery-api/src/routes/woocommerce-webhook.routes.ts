import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { WooCommerceOrder } from '../modules/woocommerce/woocommerce-order.types.js';
import { verifyWooCommerceWebhookSignature } from '../modules/woocommerce/woocommerce-webhook-signature.js';
import { getRawBody } from './json-body-parser.js';

export type WooCommerceWebhookDependencies = {
  orderSyncService: {
    syncOrders(input: {
      orders: WooCommerceOrder[];
      reason: 'manual_backfill' | 'scheduled_incremental' | 'webhook';
    }): Promise<{ sync: { created: number; received: number; updated: number; unchanged: number } }>;
  };
  siteUrl: string;
  webhookSecret: string;
};

type WooCommerceWebhookHeaders = {
  deliveryId: string | null;
  event: string | null;
  resource: string | null;
  signature: string;
  topic: string | null;
};

export function registerWooCommerceWebhookRoutes(
  app: FastifyInstance,
  dependencies: WooCommerceWebhookDependencies
): void {
  app.post('/woocommerce/webhooks/orders', async (request, reply) => {
    const rawBody = getRawBody(request);
    if (rawBody === null) {
      return reply.code(400).send(errorResponse('BAD_REQUEST', 'Raw request body is required'));
    }

    const headers = readWooCommerceWebhookHeaders(request);
    if (headers === null) {
      return reply.code(400).send(errorResponse('BAD_REQUEST', 'Missing WooCommerce webhook signature'));
    }

    const signatureValid = verifyWooCommerceWebhookSignature({
      rawBody,
      secret: dependencies.webhookSecret,
      signature: headers.signature
    });
    if (!signatureValid) {
      return reply.code(401).send(errorResponse('UNAUTHORIZED', 'Invalid WooCommerce webhook signature'));
    }

    const order = readWebhookOrder(request.body);
    if (order === null) {
      return reply.code(400).send(errorResponse('BAD_REQUEST', 'WooCommerce order webhook payload is required'));
    }

    const result = await dependencies.orderSyncService.syncOrders({ orders: [order], reason: 'webhook' });

    request.log.info(
      {
        created: result.sync.created,
        event: headers.event,
        received: result.sync.received,
        resource: headers.resource,
        topic: headers.topic,
        unchanged: result.sync.unchanged,
        updated: result.sync.updated,
        webhookDeliveryIdPresent: headers.deliveryId !== null
      },
      'woocommerce webhook processed'
    );

    return reply.code(202).send({
      data: {
        received: result.sync.received,
        sync: result.sync
      },
      error: null
    });
  });
}

function readWooCommerceWebhookHeaders(request: FastifyRequest): WooCommerceWebhookHeaders | null {
  const signature = readRequiredHeader(request, 'x-wc-webhook-signature');
  if (signature === null) return null;
  return {
    deliveryId: readOptionalHeader(request, 'x-wc-webhook-delivery-id'),
    event: readOptionalHeader(request, 'x-wc-webhook-event'),
    resource: readOptionalHeader(request, 'x-wc-webhook-resource'),
    signature,
    topic: readOptionalHeader(request, 'x-wc-webhook-topic')
  };
}

function readWebhookOrder(value: unknown): WooCommerceOrder | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const candidate = value as Partial<WooCommerceOrder>;
  return typeof candidate.id === 'number' && Number.isFinite(candidate.id) ? (candidate as WooCommerceOrder) : null;
}

function readRequiredHeader(request: FastifyRequest, name: string): string | null {
  const value = readOptionalHeader(request, name);
  if (value === null || value.trim() === '') return null;
  return value;
}

function readOptionalHeader(request: FastifyRequest, name: string): string | null {
  const value = request.headers[name];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function errorResponse(code: string, message: string): { data: null; error: { code: string; message: string } } {
  return { data: null, error: { code, message } };
}
