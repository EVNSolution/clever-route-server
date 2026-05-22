import { normalizeCommerceSiteUrl } from './commerce-connection.repository.js';

type FetchLike = typeof fetch;

export type WooCommerceConnectionVerifierInput = {
  consumerKey: string;
  consumerSecret: string;
  siteUrl: string;
};

export type WooCommerceConnectionVerification = {
  checkedAt: Date;
  status: 'VERIFIED';
};

export class WooCommerceCredentialVerificationError extends Error {
  constructor(
    message: string,
    readonly code: 'WOOCOMMERCE_UNAUTHORIZED' | 'WOOCOMMERCE_UNREACHABLE' | 'WOOCOMMERCE_UNEXPECTED_RESPONSE'
  ) {
    super(message);
    this.name = 'WooCommerceCredentialVerificationError';
  }
}

export class WooCommerceConnectionVerifier {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: { fetchImpl?: FetchLike; timeoutMs?: number } = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async verify(input: WooCommerceConnectionVerifierInput): Promise<WooCommerceConnectionVerification> {
    const siteUrl = assertHttpsWooSiteUrl(input.siteUrl);
    const consumerKey = readRequiredSecret(input.consumerKey, 'WooCommerce consumer key');
    const consumerSecret = readRequiredSecret(input.consumerSecret, 'WooCommerce consumer secret');
    const url = new URL('/wp-json/wc/v3/orders', siteUrl);
    url.searchParams.set('page', '1');
    url.searchParams.set('per_page', '1');
    url.searchParams.set('orderby', 'date');
    url.searchParams.set('order', 'desc');

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: {
          Accept: 'application/json',
          Authorization: `Basic ${Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64')}`
        },
        method: 'GET',
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch {
      throw new WooCommerceCredentialVerificationError(
        'WooCommerce REST API could not be reached with the supplied credentials',
        'WOOCOMMERCE_UNREACHABLE'
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw new WooCommerceCredentialVerificationError(
        'WooCommerce REST API rejected the supplied credentials',
        'WOOCOMMERCE_UNAUTHORIZED'
      );
    }
    if (!response.ok) {
      throw new WooCommerceCredentialVerificationError(
        `WooCommerce REST API verification failed with HTTP ${response.status}`,
        'WOOCOMMERCE_UNEXPECTED_RESPONSE'
      );
    }

    return { checkedAt: new Date(), status: 'VERIFIED' };
  }
}

export function assertHttpsWooSiteUrl(value: string): string {
  const normalized = normalizeCommerceSiteUrl(value);
  const url = new URL(normalized);
  if (url.protocol !== 'https:' && !isLocalHttpUrl(url)) {
    throw new Error('WooCommerce site URL must use HTTPS');
  }
  return normalized;
}

function isLocalHttpUrl(url: URL): boolean {
  if (url.protocol !== 'http:') return false;
  return ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
}

function readRequiredSecret(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed === '') throw new Error(`${label} is required`);
  return trimmed;
}
