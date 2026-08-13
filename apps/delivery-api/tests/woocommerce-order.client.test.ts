import { PassThrough } from 'node:stream';

import { describe, expect, test, vi } from 'vitest';

type MockFunction = ReturnType<typeof vi.fn>;
type MockHttpsRequestOptions = {
  headers?: unknown;
  lookup?: unknown;
  method?: string;
  servername?: string;
};
type MockIncomingMessage = PassThrough & {
  destroy: MockFunction;
  headers: Record<string, string>;
  statusCode: number;
  statusMessage: string;
};
type MockHttpsRequest = {
  destroy: MockFunction;
  end: MockFunction;
  incoming?: MockIncomingMessage;
  on: MockFunction;
  options: MockHttpsRequestOptions;
  setTimeout: MockFunction;
  url: URL;
};

const httpsMock = vi.hoisted(() => ({
  requests: [] as MockHttpsRequest[],
  responses: [] as Array<{
    chunks: Buffer[];
    headers?: Record<string, string>;
    statusCode?: number;
    statusMessage?: string;
  }>
}));

vi.mock('node:https', () => ({
  request: vi.fn((url: URL, options: MockHttpsRequestOptions, callback: (incoming: PassThrough) => void) => {
    const request: MockHttpsRequest = {
      destroy: vi.fn(),
      end: vi.fn(() => {
        const response = httpsMock.responses.shift() ?? { chunks: [Buffer.from('[]')], statusCode: 200 };
        const incoming = new PassThrough() as MockIncomingMessage;
        incoming.headers = response.headers ?? {};
        incoming.statusCode = response.statusCode ?? 200;
        incoming.statusMessage = response.statusMessage ?? 'OK';
        const destroyIncoming = incoming.destroy.bind(incoming);
        incoming.destroy = vi.fn((error?: Error) => destroyIncoming(error));
        request.incoming = incoming;
        callback(incoming);
        for (const chunk of response.chunks) incoming.write(chunk);
        incoming.end();
      }),
      on: vi.fn(() => request),
      options,
      setTimeout: vi.fn(),
      url
    };
    httpsMock.requests.push(request);
    return request;
  })
}));

import {
  createWooCommerceOrderClientFromConnection,
  type WooCommerceOrderRequestInput,
  WooCommerceOrderClient
} from '../src/modules/woocommerce/woocommerce-order.client.js';

describe('WooCommerceOrderClient', () => {
  test('default runtime transport invokes the pinned lookup and preserves host SNI without external network', async () => {
    httpsMock.requests.length = 0;
    httpsMock.responses.push({
      chunks: [Buffer.from(JSON.stringify([{ id: 1, number: '1' }]))],
      headers: { 'x-wp-total': '1', 'x-wp-totalpages': '1' },
      statusCode: 200
    });
    const client = new WooCommerceOrderClient({
      consumerKey: 'ck_test',
      consumerSecret: 'cs_test',
      resolveHostAddresses: () => Promise.resolve(['93.184.216.34']),
      siteUrl: 'https://woo.example.test'
    });

    const result = await client.listOrdersPage({ page: 1, perPage: 10 });

    expect(result.orders).toEqual([{ id: 1, number: '1' }]);
    const request = httpsMock.requests[0];
    if (request === undefined) throw new Error('Expected mocked HTTPS request');
    expect(request.url.toString()).toBe(
      'https://woo.example.test/wp-json/wc/v3/orders?page=1&per_page=10&orderby=modified&order=asc&dates_are_gmt=true'
    );
    expect(request.options.servername).toBe('woo.example.test');
    expect(request.options.method).toBe('GET');
    expect(request.options.lookup).toEqual(expect.any(Function));

    const pinnedAddress = await new Promise<string>((resolve, reject) => {
      const lookup = request.options.lookup as WooCommerceOrderRequestInput['lookup'];
      lookup('woo.example.test', { family: 4 }, (error, address) => {
        if (error !== null) {
          reject(error);
          return;
        }
        if (Array.isArray(address)) {
          reject(new Error('Expected single pinned address'));
          return;
        }
        resolve(address);
      });
    });
    expect(pinnedAddress).toBe('93.184.216.34');
  });

  test('default runtime transport rejects oversized responses and destroys the request', async () => {
    httpsMock.requests.length = 0;
    httpsMock.responses.push({
      chunks: [Buffer.from('[{"id":'), Buffer.from('"oversized"}]')],
      statusCode: 200
    });
    const client = new WooCommerceOrderClient({
      consumerKey: 'ck_test',
      consumerSecret: 'cs_test',
      maxResponseBytes: 8,
      resolveHostAddresses: () => Promise.resolve(['93.184.216.34']),
      siteUrl: 'https://woo.example.test'
    });

    await expect(client.listOrdersPage({ page: 1, perPage: 10 })).rejects.toThrow(
      'WooCommerce order response exceeded the maximum allowed size'
    );
    expect(httpsMock.requests[0]?.destroy).toHaveBeenCalled();
    expect(httpsMock.requests[0]?.incoming?.destroy).toHaveBeenCalled();
  });

  test('requests paginated modified orders with HTTPS Basic Auth and reads total headers', async () => {
    const sendHttpsRequest = vi.fn((input: WooCommerceOrderRequestInput): ReturnType<typeof fetch> => {
      void input;
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
      resolveHostAddresses: () => Promise.resolve(['93.184.216.34']),
      sendHttpsRequest,
      siteUrl: 'https://example.test/'
    });

    const result = await client.listOrdersPage({
      modifiedAfter: new Date('2026-05-21T00:00:00.000Z'),
      page: 2,
      perPage: 50,
      status: 'processing'
    });

    expect(result).toEqual({ orders: [{ id: 1, number: '1' }], page: 2, perPage: 50, total: 25, totalPages: 3 });
    const [request] = sendHttpsRequest.mock.calls[0] ?? [undefined];
    const url = request?.url;
    expect(url).toBeInstanceOf(URL);
    expect((url as URL).toString()).toBe(
      'https://example.test/wp-json/wc/v3/orders?page=2&per_page=50&orderby=modified&order=asc&dates_are_gmt=true&modified_after=2026-05-21T00%3A00%3A00.000Z&status=processing'
    );
    expect(request?.headers).toEqual(
      expect.objectContaining({ Authorization: `Basic ${Buffer.from('ck_test:cs_test').toString('base64')}` })
    );
    expect(request?.servername).toBe('example.test');
    expect(request?.maxResponseBytes).toBe(2 * 1024 * 1024);
    expect(request?.timeoutMs).toBe(10_000);
  });

  test('throws sanitized HTTP errors without exposing credentials', async () => {
    const sendHttpsRequest = vi.fn((input: WooCommerceOrderRequestInput): ReturnType<typeof fetch> => {
      void input;
      return Promise.resolve(new Response('Forbidden', { status: 403 }));
    });
    const client = new WooCommerceOrderClient({
      consumerKey: 'ck_secret_value',
      consumerSecret: 'cs_secret_value',
      resolveHostAddresses: () => Promise.resolve(['93.184.216.34']),
      sendHttpsRequest,
      siteUrl: 'https://example.test'
    });

    await expect(client.listOrdersPage({ page: 1, perPage: 10 })).rejects.toThrow(
      'WooCommerce order request failed with HTTP 403'
    );
    await expect(client.listOrdersPage({ page: 1, perPage: 10 })).rejects.not.toThrow('ck_secret_value');
  });

  test('requests a single order by WooCommerce id', async () => {
    const sendHttpsRequest = vi.fn((input: WooCommerceOrderRequestInput): ReturnType<typeof fetch> => {
      void input;
      return Promise.resolve(new Response(JSON.stringify({ id: 11432, number: '11432' }), { status: 200 }));
    });
    const client = new WooCommerceOrderClient({
      consumerKey: 'ck_test',
      consumerSecret: 'cs_test',
      resolveHostAddresses: () => Promise.resolve(['93.184.216.34']),
      sendHttpsRequest,
      siteUrl: 'https://example.test/'
    });

    const result = await client.getOrder({ orderId: '11432' });

    expect(result).toEqual({ id: 11432, number: '11432' });
    const [request] = sendHttpsRequest.mock.calls[0] ?? [undefined];
    const url = request?.url;
    expect(url).toBeInstanceOf(URL);
    expect((url as URL).toString()).toBe('https://example.test/wp-json/wc/v3/orders/11432');
    expect(request?.headers).toEqual(
      expect.objectContaining({ Authorization: `Basic ${Buffer.from('ck_test:cs_test').toString('base64')}` })
    );
  });

  test('rejects perPage values outside WooCommerce limits before making a request', async () => {
    const sendHttpsRequest = vi.fn((input: WooCommerceOrderRequestInput): ReturnType<typeof fetch> => {
      void input;
      return Promise.resolve(new Response('[]', { status: 200 }));
    });
    const client = new WooCommerceOrderClient({
      consumerKey: 'ck_test',
      consumerSecret: 'cs_test',
      resolveHostAddresses: () => Promise.resolve(['93.184.216.34']),
      sendHttpsRequest,
      siteUrl: 'https://example.test'
    });

    await expect(client.listOrdersPage({ page: 1, perPage: 101 })).rejects.toThrow(
      'WooCommerce perPage must be 100 or less'
    );
    expect(sendHttpsRequest).not.toHaveBeenCalled();
  });

  test('rejects invalid single order ids before making a request', async () => {
    const sendHttpsRequest = vi.fn((input: WooCommerceOrderRequestInput): ReturnType<typeof fetch> => {
      void input;
      return Promise.resolve(new Response('{}', { status: 200 }));
    });
    const client = new WooCommerceOrderClient({
      consumerKey: 'ck_test',
      consumerSecret: 'cs_test',
      resolveHostAddresses: () => Promise.resolve(['93.184.216.34']),
      sendHttpsRequest,
      siteUrl: 'https://example.test'
    });

    await expect(client.getOrder({ orderId: '../11432' })).rejects.toThrow(
      'WooCommerce orderId must be a positive integer'
    );
    expect(sendHttpsRequest).not.toHaveBeenCalled();
  });

  test('can be constructed from decrypted DB connection credentials', async () => {
    const sendHttpsRequest = vi.fn((input: WooCommerceOrderRequestInput): ReturnType<typeof fetch> => {
      void input;
      return Promise.resolve(new Response(JSON.stringify([{ id: 7, number: '7' }]), { status: 200 }));
    });
    const client = createWooCommerceOrderClientFromConnection(
      {
        consumerKey: 'ck_from_db',
        consumerSecret: 'cs_from_db',
        siteUrl: 'https://woo.example.test'
      },
      { resolveHostAddresses: () => Promise.resolve(['93.184.216.34']), sendHttpsRequest }
    );

    await client.listOrdersPage({ page: 1, perPage: 10 });

    const [request] = sendHttpsRequest.mock.calls[0] ?? [undefined];
    expect(request?.headers).toEqual(
      expect.objectContaining({
        Authorization: `Basic ${Buffer.from('ck_from_db:cs_from_db').toString('base64')}`
      })
    );
  });

  test('revalidates DNS for runtime requests and rejects private rebinding before transport', async () => {
    const sendHttpsRequest = vi.fn((input: WooCommerceOrderRequestInput): ReturnType<typeof fetch> => {
      void input;
      return Promise.resolve(new Response('[]', { status: 200 }));
    });
    const client = new WooCommerceOrderClient({
      consumerKey: 'ck_test',
      consumerSecret: 'cs_test',
      resolveHostAddresses: () => Promise.resolve(['10.0.0.5']),
      sendHttpsRequest,
      siteUrl: 'https://woo.example.test'
    });

    await expect(client.listOrdersPage({ page: 1, perPage: 10 })).rejects.toThrow(
      'WooCommerce site URL must not resolve to localhost, private, or non-public network addresses'
    );
    expect(sendHttpsRequest).not.toHaveBeenCalled();
  });

  test('pins runtime HTTPS lookup to vetted public addresses while preserving Host and SNI', async () => {
    const pinnedAddresses: string[] = [];
    const sendHttpsRequest = vi.fn((input: WooCommerceOrderRequestInput): ReturnType<typeof fetch> => {
      input.lookup(input.url.hostname, { family: 4 }, (error, address) => {
        if (error !== null) throw error;
        if (Array.isArray(address)) throw new Error('Expected single pinned address');
        pinnedAddresses.push(address);
      });
      return Promise.resolve(new Response(JSON.stringify([{ id: 1 }]), { status: 200 }));
    });
    const client = new WooCommerceOrderClient({
      consumerKey: 'ck_test',
      consumerSecret: 'cs_test',
      resolveHostAddresses: () => Promise.resolve(['93.184.216.34', '93.184.216.35']),
      sendHttpsRequest,
      siteUrl: 'https://woo.example.test'
    });

    await client.listOrdersPage({ page: 1, perPage: 10 });

    const [request] = sendHttpsRequest.mock.calls[0] ?? [undefined];
    expect(pinnedAddresses).toEqual(['93.184.216.34']);
    expect(request?.url.hostname).toBe('woo.example.test');
    expect(request?.servername).toBe('woo.example.test');
  });

  test('rejects runtime redirects instead of following them to an unvetted target', async () => {
    const sendHttpsRequest = vi.fn((input: WooCommerceOrderRequestInput): ReturnType<typeof fetch> => {
      void input;
      return Promise.resolve(new Response(null, { headers: { location: 'https://127.0.0.1/admin' }, status: 302 }));
    });
    const client = new WooCommerceOrderClient({
      consumerKey: 'ck_test',
      consumerSecret: 'cs_test',
      resolveHostAddresses: () => Promise.resolve(['93.184.216.34']),
      sendHttpsRequest,
      siteUrl: 'https://woo.example.test'
    });

    await expect(client.listOrdersPage({ page: 1, perPage: 10 })).rejects.toThrow(
      'WooCommerce order redirects are not allowed'
    );
  });
});
