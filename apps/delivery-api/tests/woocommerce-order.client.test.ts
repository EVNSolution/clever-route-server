import { describe, expect, test, vi } from 'vitest';

import {
  createWooCommerceOrderClientFromConnection,
  WooCommerceOrderClient
} from '../src/modules/woocommerce/woocommerce-order.client.js';

describe('WooCommerceOrderClient', () => {
  test('requests paginated modified orders with HTTPS Basic Auth and reads total headers', async () => {
    const fetchImpl = vi.fn((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): ReturnType<typeof fetch> => {
      void input;
      void init;
      return Promise.resolve(
        new Response(JSON.stringify([{ id: 1, number: '1' }]), {
          headers: { 'x-wp-total': '25', 'x-wp-totalpages': '3' },
          status: 200
        })
      );
    });
    const client = new WooCommerceOrderClient({
      consumerKey: 'ck_test',
      consumerSecret: 'cs_test',
      fetchImpl,
      siteUrl: 'https://example.test/'
    });

    const result = await client.listOrdersPage({
      modifiedAfter: new Date('2026-05-21T00:00:00.000Z'),
      page: 2,
      perPage: 50,
      status: 'processing'
    });

    expect(result).toEqual({ orders: [{ id: 1, number: '1' }], page: 2, perPage: 50, total: 25, totalPages: 3 });
    const [url, init] = fetchImpl.mock.calls[0] ?? [undefined, undefined];
    expect(url).toBeInstanceOf(URL);
    expect((url as URL).toString()).toBe(
      'https://example.test/wp-json/wc/v3/orders?page=2&per_page=50&orderby=modified&order=asc&dates_are_gmt=true&modified_after=2026-05-21T00%3A00%3A00.000Z&status=processing'
    );
    expect(init?.headers).toEqual(
      expect.objectContaining({ Authorization: `Basic ${Buffer.from('ck_test:cs_test').toString('base64')}` })
    );
  });

  test('throws sanitized HTTP errors without exposing credentials', async () => {
    const fetchImpl = vi.fn((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): ReturnType<typeof fetch> => {
      void input;
      void init;
      return Promise.resolve(new Response('Forbidden', { status: 403 }));
    });
    const client = new WooCommerceOrderClient({
      consumerKey: 'ck_secret_value',
      consumerSecret: 'cs_secret_value',
      fetchImpl,
      siteUrl: 'https://example.test'
    });

    await expect(client.listOrdersPage({ page: 1, perPage: 10 })).rejects.toThrow(
      'WooCommerce order request failed with HTTP 403'
    );
    await expect(client.listOrdersPage({ page: 1, perPage: 10 })).rejects.not.toThrow('ck_secret_value');
  });

  test('requests a single order by WooCommerce id', async () => {
    const fetchImpl = vi.fn((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): ReturnType<typeof fetch> => {
      void input;
      void init;
      return Promise.resolve(new Response(JSON.stringify({ id: 11432, number: '11432' }), { status: 200 }));
    });
    const client = new WooCommerceOrderClient({
      consumerKey: 'ck_test',
      consumerSecret: 'cs_test',
      fetchImpl,
      siteUrl: 'https://example.test/'
    });

    const result = await client.getOrder({ orderId: '11432' });

    expect(result).toEqual({ id: 11432, number: '11432' });
    const [url, init] = fetchImpl.mock.calls[0] ?? [undefined, undefined];
    expect(url).toBeInstanceOf(URL);
    expect((url as URL).toString()).toBe('https://example.test/wp-json/wc/v3/orders/11432');
    expect(init?.headers).toEqual(
      expect.objectContaining({ Authorization: `Basic ${Buffer.from('ck_test:cs_test').toString('base64')}` })
    );
  });

  test('rejects perPage values outside WooCommerce limits before making a request', async () => {
    const fetchImpl = vi.fn((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): ReturnType<typeof fetch> => {
      void input;
      void init;
      return Promise.resolve(new Response('[]', { status: 200 }));
    });
    const client = new WooCommerceOrderClient({
      consumerKey: 'ck_test',
      consumerSecret: 'cs_test',
      fetchImpl,
      siteUrl: 'https://example.test'
    });

    await expect(client.listOrdersPage({ page: 1, perPage: 101 })).rejects.toThrow(
      'WooCommerce perPage must be 100 or less'
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('rejects invalid single order ids before making a request', async () => {
    const fetchImpl = vi.fn((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): ReturnType<typeof fetch> => {
      void input;
      void init;
      return Promise.resolve(new Response('{}', { status: 200 }));
    });
    const client = new WooCommerceOrderClient({
      consumerKey: 'ck_test',
      consumerSecret: 'cs_test',
      fetchImpl,
      siteUrl: 'https://example.test'
    });

    await expect(client.getOrder({ orderId: '../11432' })).rejects.toThrow(
      'WooCommerce orderId must be a positive integer'
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('can be constructed from decrypted DB connection credentials', async () => {
    const fetchImpl = vi.fn((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): ReturnType<typeof fetch> => {
      void input;
      void init;
      return Promise.resolve(new Response(JSON.stringify([{ id: 7, number: '7' }]), { status: 200 }));
    });
    const client = createWooCommerceOrderClientFromConnection(
      {
        consumerKey: 'ck_from_db',
        consumerSecret: 'cs_from_db',
        siteUrl: 'https://woo.example.test'
      },
      { fetchImpl }
    );

    await client.listOrdersPage({ page: 1, perPage: 10 });

    const [, init] = fetchImpl.mock.calls[0] ?? [undefined, undefined];
    expect(init?.headers).toEqual(
      expect.objectContaining({
        Authorization: `Basic ${Buffer.from('ck_from_db:cs_from_db').toString('base64')}`
      })
    );
  });
});
