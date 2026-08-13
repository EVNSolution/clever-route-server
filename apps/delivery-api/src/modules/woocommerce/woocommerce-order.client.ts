import type { IncomingMessage } from 'node:http';
import { request as requestHttps, type RequestOptions } from 'node:https';

import {
  assertHttpsWooSiteUrl,
  createPinnedPublicLookup,
  resolvePublicWooSiteAddresses,
  type PinnedLookup,
  type ResolveHostAddresses
} from '../commerce/woocommerce-connection-verifier.js';
import type { DecryptedWooCommerceConnection } from '../commerce/commerce-connection.service.js';
import type { WooCommerceOrder } from './woocommerce-order.types.js';

export type WooCommerceOrdersPageInput = {
  modifiedAfter?: Date | null;
  page: number;
  perPage: number;
  status?: string | null;
};

export type WooCommerceOrdersPage = {
  orders: WooCommerceOrder[];
  page: number;
  perPage: number;
  total: number | null;
  totalPages: number | null;
};

export type WooCommerceOrderInput = {
  orderId: number | string;
};

const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const RESPONSE_SIZE_LIMIT_MESSAGE = 'WooCommerce order response exceeded the maximum allowed size';

export type WooCommerceOrderRequestInput = {
  headers: Record<string, string>;
  lookup: PinnedLookup;
  maxResponseBytes: number;
  method: 'GET';
  servername: string;
  timeoutMs: number;
  url: URL;
};

type SendWooCommerceOrderRequest = (input: WooCommerceOrderRequestInput) => Promise<Response>;

export class WooCommerceOrderClient {
  private readonly baseUrl: string;
  private readonly maxResponseBytes: number;
  private readonly resolveHostAddresses: ResolveHostAddresses;
  private readonly sendHttpsRequest: SendWooCommerceOrderRequest;
  private readonly timeoutMs: number;

  constructor(
    private readonly options: {
      consumerKey: string;
      consumerSecret: string;
      maxResponseBytes?: number;
      resolveHostAddresses?: ResolveHostAddresses;
      sendHttpsRequest?: SendWooCommerceOrderRequest;
      siteUrl: string;
      timeoutMs?: number;
    }
  ) {
    this.baseUrl = normalizeSiteUrl(options.siteUrl);
    this.maxResponseBytes = assertPositiveInteger(options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES, 'maxResponseBytes');
    this.resolveHostAddresses = options.resolveHostAddresses ?? resolveHostAddressesWithPolicy;
    this.sendHttpsRequest = options.sendHttpsRequest ?? sendHttpsRequestWithPinnedLookup;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (options.consumerKey.trim() === '' || options.consumerSecret.trim() === '') {
      throw new Error('WooCommerce REST credentials are required');
    }
  }

  async listOrdersPage(input: WooCommerceOrdersPageInput): Promise<WooCommerceOrdersPage> {
    const url = new URL('/wp-json/wc/v3/orders', this.baseUrl);
    url.searchParams.set('page', String(assertPositiveInteger(input.page, 'page')));
    url.searchParams.set('per_page', String(assertPerPage(input.perPage)));
    url.searchParams.set('orderby', 'modified');
    url.searchParams.set('order', 'asc');
    url.searchParams.set('dates_are_gmt', 'true');
    if (input.modifiedAfter !== undefined && input.modifiedAfter !== null) {
      url.searchParams.set('modified_after', input.modifiedAfter.toISOString());
    }
    if (input.status !== undefined && input.status !== null && input.status.trim() !== '') {
      url.searchParams.set('status', input.status.trim());
    }

    let response: Response;
    try {
      response = await this.sendRuntimeRequest(url);
    } catch (error) {
      if (isWooCommerceSafetyValidationError(error)) throw error;
      if (isWooCommerceOrderResponseSizeError(error)) throw error;
      throw new Error('WooCommerce order request failed before receiving a response', { cause: error });
    }

    if (response.status >= 300 && response.status < 400) {
      throw new Error('WooCommerce order redirects are not allowed');
    }
    if (!response.ok) {
      throw new Error(`WooCommerce order request failed with HTTP ${response.status}`);
    }

    const payload = await response.json();
    if (!Array.isArray(payload)) {
      throw new Error('WooCommerce orders response must be a JSON array');
    }

    return {
      orders: payload as WooCommerceOrder[],
      page: input.page,
      perPage: input.perPage,
      total: parseHeaderNumber(response.headers.get('x-wp-total')),
      totalPages: parseHeaderNumber(response.headers.get('x-wp-totalpages'))
    };
  }

  async getOrder(input: WooCommerceOrderInput): Promise<WooCommerceOrder> {
    const orderId = assertWooCommerceOrderId(input.orderId);
    const url = new URL(`/wp-json/wc/v3/orders/${orderId}`, this.baseUrl);

    let response: Response;
    try {
      response = await this.sendRuntimeRequest(url);
    } catch (error) {
      if (isWooCommerceSafetyValidationError(error)) throw error;
      if (isWooCommerceOrderResponseSizeError(error)) throw error;
      throw new Error('WooCommerce order request failed before receiving a response', { cause: error });
    }

    if (response.status >= 300 && response.status < 400) {
      throw new Error('WooCommerce order redirects are not allowed');
    }
    if (!response.ok) {
      throw new Error(`WooCommerce order request failed with HTTP ${response.status}`);
    }

    const payload = await response.json();
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('WooCommerce order response must be a JSON object');
    }

    return payload as WooCommerceOrder;
  }

  private async sendRuntimeRequest(url: URL): Promise<Response> {
    const publicAddresses = await resolvePublicWooSiteAddresses(this.baseUrl, this.resolveHostAddresses);
    return this.sendHttpsRequest({
      headers: {
        Accept: 'application/json',
        Authorization: `Basic ${Buffer.from(`${this.options.consumerKey}:${this.options.consumerSecret}`).toString('base64')}`
      },
      lookup: createPinnedPublicLookup(publicAddresses),
      maxResponseBytes: this.maxResponseBytes,
      method: 'GET',
      servername: normalizeHostname(url.hostname),
      timeoutMs: this.timeoutMs,
      url
    });
  }
}

export function createWooCommerceOrderClientFromConnection(
  connection: Pick<DecryptedWooCommerceConnection, 'consumerKey' | 'consumerSecret' | 'siteUrl'>,
  input: {
    maxResponseBytes?: number;
    resolveHostAddresses?: ResolveHostAddresses;
    sendHttpsRequest?: SendWooCommerceOrderRequest;
    timeoutMs?: number;
  } = {}
): WooCommerceOrderClient {
  return new WooCommerceOrderClient({
    consumerKey: connection.consumerKey,
    consumerSecret: connection.consumerSecret,
    ...(input.maxResponseBytes === undefined ? {} : { maxResponseBytes: input.maxResponseBytes }),
    ...(input.resolveHostAddresses === undefined ? {} : { resolveHostAddresses: input.resolveHostAddresses }),
    ...(input.sendHttpsRequest === undefined ? {} : { sendHttpsRequest: input.sendHttpsRequest }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    siteUrl: connection.siteUrl
  });
}

function assertPositiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`WooCommerce ${name} must be a positive integer`);
  }
  return value;
}

function assertPerPage(value: number): number {
  assertPositiveInteger(value, 'perPage');
  if (value > 100) {
    throw new Error('WooCommerce perPage must be 100 or less');
  }
  return value;
}

function assertWooCommerceOrderId(value: number | string): string {
  const raw = typeof value === 'number' ? String(value) : value.trim();
  if (!/^[1-9]\d*$/u.test(raw)) {
    throw new Error('WooCommerce orderId must be a positive integer');
  }
  return raw;
}

function parseHeaderNumber(value: string | null): number | null {
  if (value === null || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeSiteUrl(value: string): string {
  const url = new URL(assertHttpsWooSiteUrl(value));
  url.pathname = url.pathname.replace(/\/+$/u, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/u, '');
}

async function resolveHostAddressesWithPolicy(hostname: string): Promise<string[]> {
  return resolvePublicWooSiteAddresses(`https://${hostname}`);
}

async function sendHttpsRequestWithPinnedLookup(input: WooCommerceOrderRequestInput): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = requestHttps(
      input.url,
      {
        headers: input.headers,
        lookup: input.lookup as RequestOptions['lookup'],
        method: input.method,
        servername: input.servername
      },
      (incoming: IncomingMessage) => {
        const chunks: Buffer[] = [];
        let receivedBytes = 0;
        let settled = false;
        const rejectOversizedResponse = () => {
          if (settled) return;
          settled = true;
          incoming.destroy();
          request.destroy();
          reject(new Error(RESPONSE_SIZE_LIMIT_MESSAGE));
        };
        incoming.on('data', (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          receivedBytes += buffer.byteLength;
          if (receivedBytes > input.maxResponseBytes) {
            rejectOversizedResponse();
            return;
          }
          chunks.push(buffer);
        });
        incoming.on('end', () => {
          if (settled) return;
          settled = true;
          resolve(
            new Response(Buffer.concat(chunks), {
              headers: headersFromIncomingMessage(incoming),
              status: incoming.statusCode ?? 500,
              statusText: incoming.statusMessage ?? ''
            })
          );
        });
        incoming.on('error', (error) => {
          if (settled) return;
          settled = true;
          reject(error);
        });
      }
    );
    request.on('error', reject);
    request.setTimeout(input.timeoutMs, () => request.destroy(new Error('WooCommerce order request timed out')));
    request.end();
  });
}

function headersFromIncomingMessage(incoming: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  return headers;
}

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\[/u, '').replace(/\]$/u, '').replace(/\.+$/u, '');
}

function isWooCommerceSafetyValidationError(error: unknown): error is Error {
  return error instanceof Error && error.message.startsWith('WooCommerce site URL must not ');
}

function isWooCommerceOrderResponseSizeError(error: unknown): error is Error {
  return error instanceof Error && error.message === RESPONSE_SIZE_LIMIT_MESSAGE;
}
