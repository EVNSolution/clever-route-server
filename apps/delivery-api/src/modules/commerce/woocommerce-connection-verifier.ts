import { normalizeCommerceSiteUrl } from './commerce-connection.repository.js';

type FetchLike = typeof fetch;

type WooCommerceSiteUrlPolicy = {
  allowLocalHttp?: boolean;
  allowPrivateNetworkUrls?: boolean;
};

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
  private readonly siteUrlPolicy: WooCommerceSiteUrlPolicy;
  private readonly timeoutMs: number;

  constructor(options: { allowLocalHttp?: boolean; allowPrivateNetworkUrls?: boolean; fetchImpl?: FetchLike; timeoutMs?: number } = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.siteUrlPolicy = {
      ...(options.allowLocalHttp === undefined ? {} : { allowLocalHttp: options.allowLocalHttp }),
      ...(options.allowPrivateNetworkUrls === undefined ? {} : { allowPrivateNetworkUrls: options.allowPrivateNetworkUrls })
    };
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async verify(input: WooCommerceConnectionVerifierInput): Promise<WooCommerceConnectionVerification> {
    const siteUrl = assertHttpsWooSiteUrl(input.siteUrl, this.siteUrlPolicy);
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

export function assertHttpsWooSiteUrl(value: string, policy: WooCommerceSiteUrlPolicy = {}): string {
  const normalized = normalizeCommerceSiteUrl(value);
  const url = new URL(normalized);
  const allowLocalHttp = policy.allowLocalHttp === true && isLocalHostname(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && allowLocalHttp)) {
    throw new Error('WooCommerce site URL must use HTTPS');
  }
  if (policy.allowPrivateNetworkUrls !== true && isPrivateNetworkHostname(url.hostname)) {
    throw new Error('WooCommerce site URL must not target localhost or private network addresses');
  }
  return normalized;
}

function isLocalHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function isPrivateNetworkHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  if (normalized === 'localhost' || normalized === '::1') return true;
  const octets = normalized.split('.').map((value) => Number.parseInt(value, 10));
  if (octets.length === 4 && octets.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)) {
    const [first = 0, second = 0] = octets;
    return (
      first === 10 ||
      first === 127 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 169 && second === 254) ||
      (first === 0 && second === 0)
    );
  }
  return normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:');
}

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\[/u, '').replace(/\]$/u, '');
}

function readRequiredSecret(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed === '') throw new Error(`${label} is required`);
  return trimmed;
}
