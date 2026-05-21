import type { FastifyInstance, FastifyRequest } from 'fastify';

import { verifyShopifyWebhookHmac } from '../modules/shopify/webhook-hmac.js';
import { getRawBody } from './json-body-parser.js';

export type ShopifyWebhookDependencies = {
  clientSecret: string;
  webhookService: {
    recordWebhook(input: {
      apiVersion: string | null;
      eventId: string | null;
      payload: unknown;
      rawBody: string;
      shopDomain: string;
      topic: string;
      triggeredAt: Date | null;
      webhookId: string;
    }): Promise<{ duplicate: boolean; webhookId: string }>;
  };
};

type ShopifyWebhookHeaders = {
  apiVersion: string | null;
  eventId: string | null;
  hmac: string;
  shopDomain: string;
  topic: string;
  triggeredAt: Date | null;
  webhookId: string;
};

export function registerShopifyWebhookRoutes(
  app: FastifyInstance,
  dependencies: ShopifyWebhookDependencies
): void {
  app.post('/shopify/webhooks', async (request, reply) => {
    const rawBody = getRawBody(request);
    if (rawBody === null) {
      return reply.code(400).send(errorResponse('BAD_REQUEST', 'Raw request body is required'));
    }

    let headers: ShopifyWebhookHeaders | null;
    try {
      headers = readShopifyWebhookHeaders(request);
    } catch {
      return reply.code(400).send(errorResponse('BAD_REQUEST', 'Invalid Shopify webhook headers'));
    }

    if (headers === null) {
      return reply.code(400).send(errorResponse('BAD_REQUEST', 'Missing Shopify webhook headers'));
    }

    const hmacValid = verifyShopifyWebhookHmac({
      clientSecret: dependencies.clientSecret,
      hmac: headers.hmac,
      rawBody
    });
    if (!hmacValid) {
      return reply.code(401).send(errorResponse('UNAUTHORIZED', 'Invalid Shopify webhook HMAC'));
    }

    const result = await dependencies.webhookService.recordWebhook({
      apiVersion: headers.apiVersion,
      eventId: headers.eventId,
      payload: request.body,
      rawBody,
      shopDomain: headers.shopDomain,
      topic: headers.topic,
      triggeredAt: headers.triggeredAt,
      webhookId: headers.webhookId
    });

    return reply.code(result.duplicate ? 200 : 202).send({
      data: {
        duplicate: result.duplicate,
        webhookId: result.webhookId
      },
      error: null
    });
  });
}

function readShopifyWebhookHeaders(request: FastifyRequest): ShopifyWebhookHeaders | null {
  const hmac = readRequiredHeader(request, 'x-shopify-hmac-sha256');
  const shopDomain = readRequiredHeader(request, 'x-shopify-shop-domain');
  const topic = readRequiredHeader(request, 'x-shopify-topic');
  const webhookId = readRequiredHeader(request, 'x-shopify-webhook-id');

  if (hmac === null || shopDomain === null || topic === null || webhookId === null) {
    return null;
  }

  return {
    apiVersion: readOptionalHeader(request, 'x-shopify-api-version'),
    eventId: readOptionalHeader(request, 'x-shopify-event-id'),
    hmac,
    shopDomain: normalizeShopDomain(shopDomain),
    topic,
    triggeredAt: parseOptionalDate(readOptionalHeader(request, 'x-shopify-triggered-at')),
    webhookId
  };
}

function readRequiredHeader(request: FastifyRequest, name: string): string | null {
  const value = readOptionalHeader(request, name);
  if (value === null || value.trim() === '') {
    return null;
  }

  return value;
}

function readOptionalHeader(request: FastifyRequest, name: string): string | null {
  const value = request.headers[name];
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value ?? null;
}

function parseOptionalDate(value: string | null): Date | null {
  if (value === null) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error('Invalid Shopify webhook timestamp');
  }

  return date;
}

function normalizeShopDomain(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const withoutProtocol = trimmed.replace(/^https?:\/\//u, '').replace(/\/$/u, '');

  if (!withoutProtocol.endsWith('.myshopify.com')) {
    throw new Error('Shop domain must end with .myshopify.com');
  }

  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/u.test(withoutProtocol)) {
    throw new Error('Shop domain is not a valid myshopify.com domain');
  }

  return withoutProtocol;
}

function errorResponse(code: string, message: string): { data: null; error: { code: string; message: string } } {
  return {
    data: null,
    error: { code, message }
  };
}
