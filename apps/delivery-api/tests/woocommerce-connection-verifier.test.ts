import { describe, expect, test, vi } from 'vitest';
import type { Mock } from 'vitest';

import {
  assertHttpsWooSiteUrl,
  assertResolvedWooSiteHostIsPublic,
  createPinnedPublicLookup,
  WooCommerceConnectionVerifier,
  type WooCommerceHttpsRequestInput
} from '../src/modules/commerce/woocommerce-connection-verifier.js';

const publicResolver = vi.fn(() => Promise.resolve(['93.184.216.34']));
const nonPublicTargetMessage = 'WooCommerce site URL must not target localhost, private, or non-public network addresses';
const nonPublicResolutionMessage = 'WooCommerce site URL must not resolve to localhost, private, or non-public network addresses';

describe('WooCommerceConnectionVerifier', () => {
  test('uses Basic auth headers and pins the outbound lookup to vetted public DNS results', async () => {
    const calls: Array<{
      headers: Record<string, string>;
      lookupAddress: string;
      method: string;
      servername: string;
      url: URL;
    }> = [];
    const sendHttpsRequest = vi.fn((input: WooCommerceHttpsRequestInput) => {
      input.lookup(input.url.hostname, { family: 4 }, (error, address) => {
        if (error !== null) throw error;
        if (Array.isArray(address)) throw new Error('Expected single pinned address');
        calls.push({
          headers: input.headers,
          lookupAddress: address,
          method: input.method,
          servername: input.servername,
          url: input.url
        });
      });
      return Promise.resolve({ status: 200 });
    });
    const verifier = new WooCommerceConnectionVerifier({
      resolveHostAddresses: publicResolver,
      sendHttpsRequest,
      timeoutMs: 1_000
    });

    const result = await verifier.verify({
      consumerKey: 'ck_verify_value',
      consumerSecret: 'cs_verify_value',
      siteUrl: 'https://woo.example.test/'
    });
    expect(result.checkedAt).toBeInstanceOf(Date);
    expect(result.status).toBe('VERIFIED');

    const call = calls[0];
    if (call === undefined) {
      throw new Error('Expected verifier request call');
    }
    expect(call.url.toString()).toBe('https://woo.example.test/wp-json/wc/v3/orders?page=1&per_page=1&orderby=date&order=desc');
    expect(call.url.searchParams.has('consumer_key')).toBe(false);
    expect(call.url.searchParams.has('consumer_secret')).toBe(false);
    expect(call.headers.Authorization).toBe(`Basic ${Buffer.from('ck_verify_value:cs_verify_value').toString('base64')}`);
    expect(call.method).toBe('GET');
    expect(call.servername).toBe('woo.example.test');
    expect(call.lookupAddress).toBe('93.184.216.34');
  });

  test('sanitizes rejected credential errors', async () => {
    const sendHttpsRequest: Mock<(input: WooCommerceHttpsRequestInput) => Promise<{ status: number }>> = vi.fn(() => Promise.resolve({ status: 403 }));
    const verifier = new WooCommerceConnectionVerifier({ resolveHostAddresses: publicResolver, sendHttpsRequest });

    await expect(
      verifier.verify({
        consumerKey: 'ck_verify_value',
        consumerSecret: 'cs_verify_value',
        siteUrl: 'https://woo.example.test'
      })
    ).rejects.toThrow('WooCommerce REST API rejected the supplied credentials');
  });

  test('rejects verifier redirects instead of following them', async () => {
    const sendHttpsRequest: Mock<(input: WooCommerceHttpsRequestInput) => Promise<{ status: number }>> = vi.fn(() => Promise.resolve({ status: 302 }));
    const verifier = new WooCommerceConnectionVerifier({ resolveHostAddresses: publicResolver, sendHttpsRequest });

    await expect(
      verifier.verify({
        consumerKey: 'ck_verify_value',
        consumerSecret: 'cs_verify_value',
        siteUrl: 'https://woo.example.test'
      })
    ).rejects.toThrow('WooCommerce REST API verification redirects are not allowed');
  });

  test('rejects non-HTTPS and direct private-network Woo site URLs by default', () => {
    expect(() => assertHttpsWooSiteUrl('http://woo.example.test')).toThrow('WooCommerce site URL must use HTTPS');
    expect(() => assertHttpsWooSiteUrl('http://localhost:8080')).toThrow('WooCommerce site URL must use HTTPS');
    expect(() => assertHttpsWooSiteUrl('https://localhost.')).toThrow(nonPublicTargetMessage);
    expect(() => assertHttpsWooSiteUrl('https://foo.localhost.')).toThrow(nonPublicTargetMessage);
    expect(() => assertHttpsWooSiteUrl('https://127.0.0.1:8443')).toThrow(nonPublicTargetMessage);
    expect(() => assertHttpsWooSiteUrl('https://10.0.0.5')).toThrow(nonPublicTargetMessage);
    expect(() => assertHttpsWooSiteUrl('https://100.64.0.1')).toThrow(nonPublicTargetMessage);
    expect(() => assertHttpsWooSiteUrl('https://198.18.0.1')).toThrow(nonPublicTargetMessage);
    expect(() => assertHttpsWooSiteUrl('https://224.0.0.1')).toThrow(nonPublicTargetMessage);
    expect(() => assertHttpsWooSiteUrl('https://240.0.0.1')).toThrow(nonPublicTargetMessage);
    expect(() => assertHttpsWooSiteUrl('https://[::ffff:127.0.0.1]')).toThrow(nonPublicTargetMessage);
    expect(() => assertHttpsWooSiteUrl('https://[0:0:0:0:0:0:0:1]')).toThrow(nonPublicTargetMessage);
    expect(() => assertHttpsWooSiteUrl('https://[2001:db8::1]')).toThrow(nonPublicTargetMessage);
    expect(() => assertHttpsWooSiteUrl('https://[100:0:0:1::1]')).toThrow(nonPublicTargetMessage);
    expect(() => assertHttpsWooSiteUrl('https://[3fff::1]')).toThrow(nonPublicTargetMessage);
    expect(() => assertHttpsWooSiteUrl('https://[5f00::1]')).toThrow(nonPublicTargetMessage);
    expect(() => assertHttpsWooSiteUrl('https://[4000::1]')).toThrow(nonPublicTargetMessage);
    expect(() => assertHttpsWooSiteUrl('https://[fec0::1]')).toThrow(nonPublicTargetMessage);
    expect(() => assertHttpsWooSiteUrl('https://[fe00::1]')).toThrow(nonPublicTargetMessage);
    expect(assertHttpsWooSiteUrl('woo.example.test')).toBe('https://woo.example.test');
    expect(assertHttpsWooSiteUrl('https://[2001:4860:4860::8888]')).toBe('https://[2001:4860:4860::8888]');
  });

  test('rejects DNS results that resolve to private, loopback, or otherwise non-public addresses', async () => {
    const nonPublicDnsAddresses = [
      '192.168.1.10',
      '100.64.0.1',
      '198.18.0.1',
      '224.0.0.1',
      '240.0.0.1',
      '0:0:0:0:0:0:0:1',
      '0:0:0:0:0:0:0:0',
      '0:0:0:0:0:ffff:7f00:1',
      '::ffff:7f00:1',
      '2001:db8::1',
      '100:0:0:1::1',
      '3fff::1',
      '5f00::1',
      '4000::1',
      'fec0::1',
      'fe00::1',
      'fc00::1',
      'fe80::1',
      'ff02::1'
    ];

    for (const address of nonPublicDnsAddresses) {
      await expect(assertResolvedWooSiteHostIsPublic('https://woo.example.test', () => Promise.resolve([address]))).rejects.toThrow(
        nonPublicResolutionMessage
      );
    }

    await expect(assertResolvedWooSiteHostIsPublic('https://woo.example.test', () => Promise.resolve(['93.184.216.34']))).resolves.toBeUndefined();
    await expect(
      assertResolvedWooSiteHostIsPublic('https://woo.example.test', () => Promise.resolve(['2001:4860:4860::8888']))
    ).resolves.toBeUndefined();
    expect(() => createPinnedPublicLookup(['93.184.216.34', '127.0.0.1'])).toThrow(nonPublicResolutionMessage);
    expect(() => createPinnedPublicLookup(['2001:4860:4860::8888', '3fff::1'])).toThrow(nonPublicResolutionMessage);
  });
});
