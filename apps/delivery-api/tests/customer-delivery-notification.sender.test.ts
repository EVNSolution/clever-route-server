import { describe, expect, test, vi } from 'vitest';

import {
  HttpCustomerDeliveryNotificationSender,
  loadCustomerDeliveryNotificationSender
} from '../src/modules/route-plans/customer-delivery-notification.sender.js';

const message = {
  appId: 'clever-kfood',
  deliveryStopId: 'stop-1',
  idempotencyKey: 'admin-stop-key:customer-notification',
  orderId: 'order-1',
  recipientEmail: 'customer@example.com',
  routePlanId: 'route-plan-id',
  shopDomain: 'example.myshopify.com',
  status: 'COMPLETED' as const
};

function readRequestIdempotencyKey(requestInit: RequestInit | undefined): string | undefined {
  if (typeof requestInit?.body !== 'string') return undefined;
  const parsed: unknown = JSON.parse(requestInit.body);
  if (parsed === null || typeof parsed !== 'object' || !('idempotencyKey' in parsed)) return undefined;
  const idempotencyKey = (parsed as { idempotencyKey?: unknown }).idempotencyKey;
  return typeof idempotencyKey === 'string' ? idempotencyKey : undefined;
}

describe('customer delivery notification sender', () => {
  test('is unwired when CUSTOMER_DELIVERY_NOTIFICATION_URL is absent', () => {
    expect(loadCustomerDeliveryNotificationSender({})).toBeUndefined();
  });

  test('configured HTTP sender posts the idempotent customer notification payload', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ providerMessageId: 'provider-message-id' }),
      { headers: { 'Content-Type': 'application/json' }, status: 202 }
    ));
    const sender = new HttpCustomerDeliveryNotificationSender({
      bearerToken: 'super-secret-token',
      fetchImpl,
      url: 'https://notifications.example.com/customer-delivery'
    });

    await expect(sender.send(message)).resolves.toEqual({
      provider: 'http',
      providerMessageId: 'provider-message-id',
      status: 'SENT'
    });
    const [url, requestInit] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe('https://notifications.example.com/customer-delivery');
    expect(requestInit).toMatchObject({
      body: JSON.stringify(message),
      headers: {
        Authorization: 'Bearer super-secret-token',
        'Content-Type': 'application/json'
      },
      method: 'POST'
    });
    expect(requestInit?.signal).toBeInstanceOf(AbortSignal);
  });

  test('configured HTTP sender posts customer memo payload without route fields', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ providerMessageId: 'provider-message-id' }),
      { headers: { 'Content-Type': 'application/json' }, status: 202 }
    ));
    const sender = new HttpCustomerDeliveryNotificationSender({
      fetchImpl,
      url: 'https://notifications.example.com/customer-delivery'
    });

    await expect(sender.send({
      appId: 'clever-kfood',
      body: 'Customer-visible memo',
      idempotencyKey: 'memo-command:customer-message-email',
      kind: 'CUSTOMER_MESSAGE',
      orderId: 'order-1',
      orderMessageId: 'message-id',
      recipientEmail: 'customer@example.com',
      shopDomain: 'example.myshopify.com'
    })).resolves.toEqual({
      provider: 'http',
      providerMessageId: 'provider-message-id',
      status: 'SENT'
    });
    const [, requestInit] = fetchImpl.mock.calls[0] ?? [];
    expect(requestInit?.body).toBe(JSON.stringify({
      appId: 'clever-kfood',
      body: 'Customer-visible memo',
      idempotencyKey: 'memo-command:customer-message-email',
      kind: 'CUSTOMER_MESSAGE',
      orderId: 'order-1',
      orderMessageId: 'message-id',
      recipientEmail: 'customer@example.com',
      shopDomain: 'example.myshopify.com'
    }));
  });

  test('configured HTTP sender reports failure without leaking bearer token', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('nope', { status: 500 }));
    const sender = new HttpCustomerDeliveryNotificationSender({
      bearerToken: 'super-secret-token',
      fetchImpl,
      url: 'https://notifications.example.com/customer-delivery'
    });

    const result = await sender.send(message);
    expect(result).toEqual({
      errorCode: 'HTTP_CUSTOMER_NOTIFICATION_FAILED',
      errorMessage: 'Customer notification sender returned HTTP 500.',
      provider: 'http',
      retryable: true,
      status: 'FAILED'
    });
    expect(result.errorMessage).not.toContain('super-secret-token');
  });

  test('configured HTTP sender retries transient failures with the same idempotency key', async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    const fetchImpl = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('socket hang up'))
      .mockResolvedValueOnce(new Response('busy', { status: 429 }))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ providerMessageId: 'provider-message-id' }),
        { headers: { 'Content-Type': 'application/json' }, status: 202 }
      ));
    const sender = new HttpCustomerDeliveryNotificationSender({
      fetchImpl,
      sleep,
      url: 'https://notifications.example.com/customer-delivery'
    });

    await expect(sender.send(message)).resolves.toEqual({
      provider: 'http',
      providerMessageId: 'provider-message-id',
      status: 'SENT'
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.map(([, requestInit]) => readRequestIdempotencyKey(requestInit)))
      .toEqual([
        'admin-stop-key:customer-notification',
        'admin-stop-key:customer-notification',
        'admin-stop-key:customer-notification'
      ]);
  });

  test('configured HTTP sender stops retrying transient HTTP failures after three attempts', async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('unavailable', { status: 503 }));
    const sender = new HttpCustomerDeliveryNotificationSender({
      fetchImpl,
      sleep,
      url: 'https://notifications.example.com/customer-delivery'
    });

    await expect(sender.send(message)).resolves.toEqual({
      errorCode: 'HTTP_CUSTOMER_NOTIFICATION_FAILED',
      errorMessage: 'Customer notification sender returned HTTP 503.',
      provider: 'http',
      retryable: true,
      status: 'FAILED'
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls.map(([delayMs]) => delayMs)).toEqual([100, 200]);
  });

  test('configured HTTP sender bounds each timed out attempt', async () => {
    vi.useFakeTimers();
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    const fetchImpl = vi.fn<typeof fetch>((_url, requestInit) => new Promise((_resolve, reject) => {
      requestInit?.signal?.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      }, { once: true });
    }));
    const sender = new HttpCustomerDeliveryNotificationSender({
      fetchImpl,
      sleep,
      timeoutMs: 10,
      url: 'https://notifications.example.com/customer-delivery'
    });

    try {
      const resultPromise = sender.send(message);
      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(10);
      await expect(resultPromise).resolves.toEqual({
        errorCode: 'HTTP_CUSTOMER_NOTIFICATION_TIMEOUT',
        errorMessage: 'The operation was aborted.',
        provider: 'http',
        retryable: true,
        status: 'FAILED'
      });
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  test('configured HTTP sender does not retry non-429 client failures', async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('bad request', { status: 400 }));
    const sender = new HttpCustomerDeliveryNotificationSender({
      fetchImpl,
      sleep,
      url: 'https://notifications.example.com/customer-delivery'
    });

    await expect(sender.send(message)).resolves.toEqual({
      errorCode: 'HTTP_CUSTOMER_NOTIFICATION_FAILED',
      errorMessage: 'Customer notification sender returned HTTP 400.',
      provider: 'http',
      retryable: false,
      status: 'FAILED'
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  test('loader accepts HTTPS and localhost smoke URLs only', () => {
    expect(loadCustomerDeliveryNotificationSender({
      CUSTOMER_DELIVERY_NOTIFICATION_URL: 'https://notifications.example.com/customer-delivery'
    })).toBeDefined();
    expect(loadCustomerDeliveryNotificationSender({
      CUSTOMER_DELIVERY_NOTIFICATION_URL: 'http://localhost:8080/customer-delivery'
    })).toBeDefined();
    expect(() => loadCustomerDeliveryNotificationSender({
      CUSTOMER_DELIVERY_NOTIFICATION_URL: 'http://notifications.example.com/customer-delivery'
    })).toThrow('CUSTOMER_DELIVERY_NOTIFICATION_URL must use HTTPS except localhost smoke targets.');
  });
});
