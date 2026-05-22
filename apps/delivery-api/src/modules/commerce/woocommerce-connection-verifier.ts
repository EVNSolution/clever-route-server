import { lookup as lookupDns } from 'node:dns/promises';
import { isIP } from 'node:net';

import { normalizeCommerceSiteUrl } from './commerce-connection.repository.js';

type FetchLike = typeof fetch;
type ResolveHostAddresses = (hostname: string) => Promise<string[]>;

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
  private readonly resolveHostAddresses: ResolveHostAddresses;
  private readonly timeoutMs: number;

  constructor(options: { fetchImpl?: FetchLike; resolveHostAddresses?: ResolveHostAddresses; timeoutMs?: number } = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.resolveHostAddresses = options.resolveHostAddresses ?? resolveHostAddressesWithDns;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async verify(input: WooCommerceConnectionVerifierInput): Promise<WooCommerceConnectionVerification> {
    const siteUrl = assertHttpsWooSiteUrl(input.siteUrl);
    await assertResolvedWooSiteHostIsPublic(siteUrl, this.resolveHostAddresses);
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
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch {
      throw new WooCommerceCredentialVerificationError(
        'WooCommerce REST API could not be reached with the supplied credentials',
        'WOOCOMMERCE_UNREACHABLE'
      );
    }

    if (response.status >= 300 && response.status < 400) {
      throw new WooCommerceCredentialVerificationError(
        'WooCommerce REST API verification redirects are not allowed',
        'WOOCOMMERCE_UNEXPECTED_RESPONSE'
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
  if (url.protocol !== 'https:') {
    throw new Error('WooCommerce site URL must use HTTPS');
  }
  if (isPrivateNetworkHostname(url.hostname)) {
    throw new Error('WooCommerce site URL must not target localhost or private network addresses');
  }
  return normalized;
}

export async function assertResolvedWooSiteHostIsPublic(
  siteUrl: string,
  resolveHostAddresses: ResolveHostAddresses = resolveHostAddressesWithDns
): Promise<void> {
  const hostname = normalizeHostname(new URL(siteUrl).hostname);
  if (isIP(hostname) !== 0) return;

  let addresses: string[];
  try {
    addresses = await resolveHostAddresses(hostname);
  } catch {
    throw new WooCommerceCredentialVerificationError(
      'WooCommerce REST API host could not be resolved',
      'WOOCOMMERCE_UNREACHABLE'
    );
  }
  if (addresses.length === 0) {
    throw new WooCommerceCredentialVerificationError(
      'WooCommerce REST API host could not be resolved',
      'WOOCOMMERCE_UNREACHABLE'
    );
  }
  if (addresses.some((address) => isPrivateNetworkHostname(address))) {
    throw new Error('WooCommerce site URL must not resolve to localhost or private network addresses');
  }
}

async function resolveHostAddressesWithDns(hostname: string): Promise<string[]> {
  const records = await lookupDns(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

function isPrivateNetworkHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return true;
  if (isPrivateIpv4Address(normalized)) return true;
  const mappedIpv4 = readIpv4MappedIpv6Address(normalized);
  if (mappedIpv4 !== null && isPrivateIpv4Address(mappedIpv4)) return true;
  return isPrivateIpv6Address(normalized);
}

function isPrivateIpv4Address(value: string): boolean {
  const octets = value.split('.').map((part) => Number.parseInt(part, 10));
  if (octets.length !== 4 || !octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)) {
    return false;
  }
  const [first = 0, second = 0] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function isPrivateIpv6Address(value: string): boolean {
  if (isIP(value) !== 6) return false;
  if (value === '::' || value === '::1') return true;
  const firstHextet = Number.parseInt(value.split(':')[0] ?? '', 16);
  if (!Number.isInteger(firstHextet)) return false;
  return (firstHextet & 0xfe00) === 0xfc00 || (firstHextet & 0xffc0) === 0xfe80;
}

function readIpv4MappedIpv6Address(value: string): string | null {
  if (!value.startsWith('::ffff:')) return null;
  const suffix = value.slice('::ffff:'.length);
  if (suffix.includes('.')) return suffix;
  const parts = suffix.split(':');
  if (parts.length !== 2) return null;
  const [high, low] = parts.map((part) => Number.parseInt(part, 16));
  if (
    high === undefined ||
    low === undefined ||
    !Number.isInteger(high) ||
    !Number.isInteger(low) ||
    high < 0 ||
    high > 0xffff ||
    low < 0 ||
    low > 0xffff
  ) {
    return null;
  }
  return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
}

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\[/u, '').replace(/\]$/u, '').replace(/\.+$/u, '');
}

function readRequiredSecret(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed === '') throw new Error(`${label} is required`);
  return trimmed;
}
