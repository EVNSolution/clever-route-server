import { describe, expect, test, vi } from 'vitest';

import {
  assertHttpsWooSiteUrl,
  assertResolvedWooSiteHostIsPublic,
  WooCommerceConnectionVerifier
} from '../src/modules/commerce/woocommerce-connection-verifier.js';

const publicResolver = vi.fn(() => Promise.resolve(['93.184.216.34']));

describe('WooCommerceConnectionVerifier', () => {
  test('uses Basic auth headers and never puts Woo credentials in the URL query string', async () => {
    const calls: Array<{ init: RequestInit | undefined; url: URL }> = [];
    const fetchImpl = vi.fn((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (!(input instanceof URL)) {
        throw new Error('Expected URL input');
      }
      calls.push({ init, url: input });
      return Promise.resolve(new Response('[]', { status: 200 }));
    }) as unknown as typeof fetch;
    const verifier = new WooCommerceConnectionVerifier({
      fetchImpl,
      resolveHostAddresses: publicResolver,
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
      throw new Error('Expected verifier fetch call');
    }
    expect(call.url.toString()).toBe('https://woo.example.test/wp-json/wc/v3/orders?page=1&per_page=1&orderby=date&order=desc');
    expect(call.url.searchParams.has('consumer_key')).toBe(false);
    expect(call.url.searchParams.has('consumer_secret')).toBe(false);
    const headers = call.init?.headers;
    if (headers === undefined || Array.isArray(headers) || headers instanceof Headers) {
      throw new Error('Expected plain verifier headers');
    }
    expect(headers.Authorization).toBe(`Basic ${Buffer.from('ck_verify_value:cs_verify_value').toString('base64')}`);
    expect(call.init?.method).toBe('GET');
    expect(call.init?.redirect).toBe('manual');
  });

  test('sanitizes rejected credential errors', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('Forbidden ck_verify_value cs_verify_value', { status: 403 }))) as unknown as typeof fetch;
    const verifier = new WooCommerceConnectionVerifier({ fetchImpl, resolveHostAddresses: publicResolver });

    await expect(
      verifier.verify({
        consumerKey: 'ck_verify_value',
        consumerSecret: 'cs_verify_value',
        siteUrl: 'https://woo.example.test'
      })
    ).rejects.toThrow('WooCommerce REST API rejected the supplied credentials');
  });

  test('rejects verifier redirects instead of following them', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response(null, { headers: { Location: 'https://127.0.0.1/admin' }, status: 302 }))
    ) as unknown as typeof fetch;
    const verifier = new WooCommerceConnectionVerifier({ fetchImpl, resolveHostAddresses: publicResolver });

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
    expect(() => assertHttpsWooSiteUrl('https://localhost.')).toThrow(
      'WooCommerce site URL must not target localhost or private network addresses'
    );
    expect(() => assertHttpsWooSiteUrl('https://foo.localhost.')).toThrow(
      'WooCommerce site URL must not target localhost or private network addresses'
    );
    expect(() => assertHttpsWooSiteUrl('https://127.0.0.1:8443')).toThrow(
      'WooCommerce site URL must not target localhost or private network addresses'
    );
    expect(() => assertHttpsWooSiteUrl('https://10.0.0.5')).toThrow(
      'WooCommerce site URL must not target localhost or private network addresses'
    );
    expect(() => assertHttpsWooSiteUrl('https://[::ffff:127.0.0.1]')).toThrow(
      'WooCommerce site URL must not target localhost or private network addresses'
    );
    expect(assertHttpsWooSiteUrl('woo.example.test')).toBe('https://woo.example.test');
  });

  test('rejects DNS results that resolve to private or loopback addresses', async () => {
    await expect(
      assertResolvedWooSiteHostIsPublic('https://woo.example.test', () => Promise.resolve(['192.168.1.10']))
    ).rejects.toThrow('WooCommerce site URL must not resolve to localhost or private network addresses');
    await expect(
      assertResolvedWooSiteHostIsPublic('https://woo.example.test', () => Promise.resolve(['::ffff:7f00:1']))
    ).rejects.toThrow('WooCommerce site URL must not resolve to localhost or private network addresses');
    await expect(assertResolvedWooSiteHostIsPublic('https://woo.example.test', () => Promise.resolve(['93.184.216.34']))).resolves.toBeUndefined();
  });
});
