import { describe, expect, test, vi } from 'vitest';

import {
  HttpCustomerDeliveryNotificationSender,
  loadCustomerDeliveryNotificationSender
} from '../src/modules/route-plans/customer-delivery-notification.sender.js';

const message = {
  deliveryStopId: 'stop-1',
  idempotencyKey: 'admin-stop-key:customer-notification',
  orderId: 'order-1',
  recipientEmail: 'customer@example.com',
  routePlanId: 'route-plan-id',
  shopDomain: 'example.myshopify.com',
  status: 'COMPLETED' as const
};

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
      status: 'FAILED'
    });
    expect(result.errorMessage).not.toContain('super-secret-token');
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
