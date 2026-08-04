import { describe, expect, test, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import { defaultCustomerEmailSettings } from '../src/modules/customer-email/customer-email-settings.js';
import type { AdminCustomerEmailDependencies } from '../src/routes/admin-customer-email.routes.js';

describe('admin customer email routes', () => {
  test('rejects settings reads without a Shopify admin bearer token', async () => {
    const { dependencies, service } = createHarness();
    const app = await buildApp({ adminCustomerEmail: dependencies });

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/admin/customer-email/settings',
      });

      expect(response.statusCode).toBe(401);
      expect(service.getSettings).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('gets and saves settings with authenticated shop/app scope', async () => {
    const { dependencies, service } = createHarness();
    const app = await buildApp({ adminCustomerEmail: dependencies });
    const settings = { ...defaultCustomerEmailSettings(), senderEmail: 'sender@example.com' };
    service.getSettings.mockResolvedValue(settings);
    service.saveSettings.mockResolvedValue(settings);

    try {
      const getResponse = await app.inject({
        headers: { authorization: 'Bearer session-token', 'x-clever-app-id': 'custom-app' },
        method: 'GET',
        url: '/admin/customer-email/settings',
      });
      const patchResponse = await app.inject({
        headers: { authorization: 'Bearer session-token', 'x-clever-app-id': 'custom-app' },
        method: 'PATCH',
        payload: settings,
        url: '/admin/customer-email/settings',
      });

      expect(getResponse.statusCode).toBe(200);
      expect(getResponse.json()).toEqual({ data: { customerEmailSettings: settings }, error: null });
      expect(patchResponse.statusCode).toBe(200);
      expect(service.getSettings).toHaveBeenCalledWith({
        appId: 'custom-app',
        shopDomain: 'example.myshopify.com',
        status: 'authenticated',
        subject: 'shopify-user-id',
      });
      expect(service.saveSettings).toHaveBeenCalledWith(expect.objectContaining({
        appId: 'custom-app',
        payload: settings,
        shopDomain: 'example.myshopify.com',
      }));
    } finally {
      await app.close();
    }
  });

  test('previews and sends with requested route-plan contract', async () => {
    const { dependencies, service } = createHarness();
    const app = await buildApp({ adminCustomerEmail: dependencies });
    service.preview.mockResolvedValue({
      counts: { eligible: 1, rendered: 1, skipped: 0, totalStops: 1 },
      recipients: [{
        deliveryStopId: 'stop-1',
        email: 'customer@example.com',
        orderId: 'order-1',
        orderNumber: '#1',
        rendered: { body: 'Body', subject: 'Subject' },
        sequence: 1,
      }],
      skipped: [],
    });
    service.send.mockResolvedValue({
      commandId: 'command-1',
      counts: { duplicate: 0, failed: 0, sent: 1, skipped: 0 },
      dispatchId: 'dispatch-id',
      duplicate: false,
      results: [{
        deliveryStopId: 'stop-1',
        email: 'customer@example.com',
        errorCode: null,
        errorMessage: null,
        orderId: 'order-1',
        provider: 'brevo',
        providerMessageId: 'message-id',
        status: 'SENT',
      }],
    });

    try {
      const previewResponse = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'POST',
        payload: { deliveryStopIds: ['stop-1'], signal: 'DELIVERY_SCHEDULED' },
        url: '/admin/route-plans/route-id/customer-email/preview',
      });
      const sendResponse = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'POST',
        payload: {
          commandId: 'command-1',
          confirmed: true,
          deliveryStopIds: ['stop-1'],
          signal: 'DELIVERY_SCHEDULED',
        },
        url: '/admin/route-plans/route-id/customer-email/send',
      });

      expect(previewResponse.statusCode).toBe(200);
      expect(previewResponse.json()).toMatchObject({ data: { preview: { counts: { rendered: 1 } } }, error: null });
      expect(sendResponse.statusCode).toBe(202);
      expect(sendResponse.json()).toMatchObject({ data: { dispatch: { counts: { sent: 1 } } }, error: null });
      expect(service.preview).toHaveBeenCalledWith({
        appId: 'clever',
        deliveryStopIds: ['stop-1'],
        routePlanId: 'route-id',
        shopDomain: 'example.myshopify.com',
        signal: 'DELIVERY_SCHEDULED',
        status: 'authenticated',
        subject: 'shopify-user-id',
      });
      expect(service.send).toHaveBeenCalledWith({
        actor: 'shopify-user-id',
        appId: 'clever',
        commandId: 'command-1',
        confirmed: true,
        deliveryStopIds: ['stop-1'],
        routePlanId: 'route-id',
        shopDomain: 'example.myshopify.com',
        signal: 'DELIVERY_SCHEDULED',
        status: 'authenticated',
        subject: 'shopify-user-id',
      });
    } finally {
      await app.close();
    }
  });

  test('returns the caller correlation id when a test email is accepted', async () => {
    const { dependencies, service } = createHarness();
    const app = await buildApp({ adminCustomerEmail: dependencies });
    service.sendTest.mockResolvedValue({
      messageId: 'provider-message-id',
      provider: 'brevo',
      recipientEmail: 'customer@example.com',
      sentAt: '2026-08-04T00:00:00.000Z',
    });

    try {
      const response = await app.inject({
        headers: {
          authorization: 'Bearer session-token',
          'x-correlation-id': 'attempt-123',
        },
        method: 'POST',
        payload: {
          recipientEmail: 'customer@example.com',
          signal: 'DELIVERY_SCHEDULED',
        },
        url: '/admin/customer-email/test',
      });

      expect(response.statusCode).toBe(202);
      expect(response.json()).toMatchObject({
        data: {
          correlationId: 'attempt-123',
          test: { messageId: 'provider-message-id', provider: 'brevo' },
        },
        error: null,
      });
    } finally {
      await app.close();
    }
  });
});

function createHarness() {
  const service = {
    getSettings: vi.fn(),
    preview: vi.fn(),
    saveSettings: vi.fn(),
    send: vi.fn(),
    sendTest: vi.fn(),
  };
  const dependencies: AdminCustomerEmailDependencies = {
    customerEmailService: service as never,
    sessionTokenVerifier: {
      verify: vi.fn().mockReturnValue({
        appId: undefined,
        shopDomain: 'example.myshopify.com',
        subject: 'shopify-user-id',
      }),
    },
  };
  return { dependencies, service };
}
