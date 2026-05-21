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

type FetchLike = typeof fetch;

export class WooCommerceOrderClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly options: {
      consumerKey: string;
      consumerSecret: string;
      fetchImpl?: FetchLike;
      siteUrl: string;
    }
  ) {
    this.baseUrl = normalizeSiteUrl(options.siteUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
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
      response = await this.fetchImpl(url, {
        headers: {
          Accept: 'application/json',
          Authorization: `Basic ${Buffer.from(`${this.options.consumerKey}:${this.options.consumerSecret}`).toString('base64')}`
        },
        method: 'GET'
      });
    } catch (error) {
      throw new Error('WooCommerce order request failed before receiving a response', { cause: error });
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

function parseHeaderNumber(value: string | null): number | null {
  if (value === null || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeSiteUrl(value: string): string {
  const trimmed = value.trim();
  const withProtocol = /^https?:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = new URL(withProtocol);
  url.pathname = url.pathname.replace(/\/+$/u, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/u, '');
}
