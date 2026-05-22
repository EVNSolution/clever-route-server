import type { IncomingMessage } from 'node:http';
import { request as requestHttps, type RequestOptions } from 'node:https';
import { lookup as lookupDns } from 'node:dns/promises';
import { isIP } from 'node:net';

import { normalizeCommerceSiteUrl } from './commerce-connection.repository.js';

type ResolveHostAddresses = (hostname: string) => Promise<string[]>;
type LookupAddressFamily = 4 | 6;
type PinnedLookup = (
  hostname: string,
  options: { all?: boolean; family?: number },
  callback: (error: NodeJS.ErrnoException | null, address: string | Array<{ address: string; family: LookupAddressFamily }>, family?: LookupAddressFamily) => void
) => void;
export type WooCommerceHttpsRequestInput = {
  headers: Record<string, string>;
  lookup: PinnedLookup;
  method: 'GET';
  servername: string;
  timeoutMs: number;
  url: URL;
};

type SendHttpsRequest = (input: WooCommerceHttpsRequestInput) => Promise<{ status: number }>;

const NON_PUBLIC_TARGET_MESSAGE = 'WooCommerce site URL must not target localhost, private, or non-public network addresses';
const NON_PUBLIC_RESOLUTION_MESSAGE = 'WooCommerce site URL must not resolve to localhost, private, or non-public network addresses';

const NON_PUBLIC_IPV4_RANGES = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.31.196.0', 24],
  ['192.52.193.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['192.175.48.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
] as const;

const NON_PUBLIC_IPV6_RANGES = [
  ['::', 96],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['100:0:0:1::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8]
] as const;

const IPV6_GLOBAL_UNICAST_RANGE = ['2000::', 3] as const;

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
  private readonly resolveHostAddresses: ResolveHostAddresses;
  private readonly sendHttpsRequest: SendHttpsRequest;
  private readonly timeoutMs: number;

  constructor(options: { resolveHostAddresses?: ResolveHostAddresses; sendHttpsRequest?: SendHttpsRequest; timeoutMs?: number } = {}) {
    this.resolveHostAddresses = options.resolveHostAddresses ?? resolveHostAddressesWithDns;
    this.sendHttpsRequest = options.sendHttpsRequest ?? sendHttpsRequestWithPinnedLookup;
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

    let response: { status: number };
    try {
      const publicAddresses = await resolvePublicWooSiteAddresses(siteUrl, this.resolveHostAddresses);
      response = await this.sendHttpsRequest({
        headers: {
          Accept: 'application/json',
          Authorization: `Basic ${Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64')}`
        },
        lookup: createPinnedPublicLookup(publicAddresses),
        method: 'GET',
        servername: normalizeHostname(url.hostname),
        timeoutMs: this.timeoutMs,
        url
      });
    } catch (error) {
      if (error instanceof WooCommerceCredentialVerificationError) throw error;
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
    if (response.status < 200 || response.status >= 300) {
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
    throw new Error(NON_PUBLIC_TARGET_MESSAGE);
  }
  return normalized;
}

export async function assertResolvedWooSiteHostIsPublic(
  siteUrl: string,
  resolveHostAddresses: ResolveHostAddresses = resolveHostAddressesWithDns
): Promise<void> {
  await resolvePublicWooSiteAddresses(siteUrl, resolveHostAddresses);
}

export async function resolvePublicWooSiteAddresses(
  siteUrl: string,
  resolveHostAddresses: ResolveHostAddresses = resolveHostAddressesWithDns
): Promise<string[]> {
  const hostname = normalizeHostname(new URL(siteUrl).hostname);
  const addresses = isIP(hostname) === 0 ? await resolveHostAddressesForPolicy(hostname, resolveHostAddresses) : [hostname];
  const normalizedAddresses = addresses.map((address) => normalizeHostname(address));
  if (normalizedAddresses.some((address) => isPrivateNetworkHostname(address))) {
    throw new Error(NON_PUBLIC_RESOLUTION_MESSAGE);
  }
  return normalizedAddresses;
}

export function createPinnedPublicLookup(addresses: string[]): PinnedLookup {
  const publicAddresses = addresses.map((address) => normalizeHostname(address));
  if (publicAddresses.length === 0 || publicAddresses.some((address) => isPrivateNetworkHostname(address))) {
    throw new Error(NON_PUBLIC_RESOLUTION_MESSAGE);
  }

  return (_hostname, options, callback) => {
    const requestedFamily = options.family === 4 || options.family === 6 ? options.family : undefined;
    const selectedAddresses =
      requestedFamily === undefined ? publicAddresses : publicAddresses.filter((address) => isIP(address) === requestedFamily);
    const usableAddresses = selectedAddresses.length > 0 ? selectedAddresses : publicAddresses;
    if (options.all === true) {
      callback(
        null,
        usableAddresses.map((address) => ({ address, family: readAddressFamily(address) }))
      );
      return;
    }
    const address = usableAddresses[0];
    if (address === undefined) {
      callback(Object.assign(new Error('No vetted WooCommerce host address available'), { code: 'ENOTFOUND' }), '', 4);
      return;
    }
    callback(null, address, readAddressFamily(address));
  };
}

async function resolveHostAddressesForPolicy(hostname: string, resolveHostAddresses: ResolveHostAddresses): Promise<string[]> {
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
  return addresses;
}

async function resolveHostAddressesWithDns(hostname: string): Promise<string[]> {
  const records = await lookupDns(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

async function sendHttpsRequestWithPinnedLookup(input: WooCommerceHttpsRequestInput): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const request = requestHttps(
      input.url,
      {
        headers: input.headers,
        lookup: input.lookup as RequestOptions['lookup'],
        method: input.method,
        servername: input.servername
      },
      (response: IncomingMessage) => {
        const status = response.statusCode ?? 0;
        response.resume();
        response.on('end', () => resolve({ status }));
      }
    );
    request.on('error', reject);
    request.setTimeout(input.timeoutMs, () => request.destroy(new Error('WooCommerce REST API verification timed out')));
    request.end();
  });
}

function isPrivateNetworkHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return true;
  if (isIP(normalized) === 4) return isNonPublicIpv4Address(normalized);
  if (isIP(normalized) === 6) return isNonPublicIpv6Address(normalized);
  return false;
}

function isNonPublicIpv4Address(value: string): boolean {
  const address = readIpv4AddressAsNumber(value);
  if (address === null) return false;
  return NON_PUBLIC_IPV4_RANGES.some(([base, prefixLength]) => {
    const baseAddress = readIpv4AddressAsNumber(base);
    return baseAddress !== null && isIpv4AddressInRange(address, baseAddress, prefixLength);
  });
}

function isNonPublicIpv6Address(value: string): boolean {
  const address = readIpv6AddressAsBigInt(value);
  if (address === null) return true;
  const globalUnicastBaseAddress = readIpv6AddressAsBigInt(IPV6_GLOBAL_UNICAST_RANGE[0]);
  if (globalUnicastBaseAddress === null || !isIpv6AddressInRange(address, globalUnicastBaseAddress, IPV6_GLOBAL_UNICAST_RANGE[1])) {
    return true;
  }
  return NON_PUBLIC_IPV6_RANGES.some(([base, prefixLength]) => {
    const baseAddress = readIpv6AddressAsBigInt(base);
    return baseAddress !== null && isIpv6AddressInRange(address, baseAddress, prefixLength);
  });
}

function readIpv4AddressAsNumber(value: string): number | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/u.test(part)) return null;
    const octet = Number.parseInt(part, 10);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    octets.push(octet);
  }
  const [first, second, third, fourth] = octets;
  if (first === undefined || second === undefined || third === undefined || fourth === undefined) return null;
  return (((first * 256 + second) * 256 + third) * 256 + fourth) >>> 0;
}

function isIpv4AddressInRange(address: number, baseAddress: number, prefixLength: number): boolean {
  const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
  return ((address & mask) >>> 0) === ((baseAddress & mask) >>> 0);
}

function readIpv6AddressAsBigInt(value: string): bigint | null {
  const normalized = normalizeHostname(value);
  if (isIP(normalized) !== 6) return null;
  const parts = normalized.split('::');
  if (parts.length > 2) return null;

  const head = readIpv6Hextets(parts[0] ?? '');
  const tail = readIpv6Hextets(parts[1] ?? '');
  if (head === null || tail === null) return null;

  const hasCompression = parts.length === 2;
  const missingHextets = 8 - head.length - tail.length;
  const hextets = hasCompression
    ? missingHextets >= 1
      ? [...head, ...Array.from({ length: missingHextets }, () => 0), ...tail]
      : []
    : head;
  if (hextets.length !== 8) return null;

  return hextets.reduce((address, hextet) => (address << 16n) + BigInt(hextet), 0n);
}

function readIpv6Hextets(value: string): number[] | null {
  if (value === '') return [];
  const segments = value.split(':');
  const hextets: number[] = [];
  for (const [index, segment] of segments.entries()) {
    if (segment === '') return null;
    if (segment.includes('.')) {
      if (index !== segments.length - 1) return null;
      const ipv4Address = readIpv4AddressAsNumber(segment);
      if (ipv4Address === null) return null;
      hextets.push((ipv4Address >>> 16) & 0xffff, ipv4Address & 0xffff);
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/u.test(segment)) return null;
    hextets.push(Number.parseInt(segment, 16));
  }
  return hextets;
}

function isIpv6AddressInRange(address: bigint, baseAddress: bigint, prefixLength: number): boolean {
  const hostBits = 128n - BigInt(prefixLength);
  const mask = prefixLength === 0 ? 0n : ((1n << 128n) - 1n) ^ ((1n << hostBits) - 1n);
  return (address & mask) === (baseAddress & mask);
}

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\[/u, '').replace(/\]$/u, '').replace(/\.+$/u, '');
}

function readAddressFamily(address: string): LookupAddressFamily {
  return isIP(address) === 6 ? 6 : 4;
}

function readRequiredSecret(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed === '') throw new Error(`${label} is required`);
  return trimmed;
}
