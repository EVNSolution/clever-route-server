import { describe, expect, test, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildApp } from '../src/app.js';
import { defaultCustomerEmailSettings } from '../src/modules/customer-email/customer-email-settings.js';
import type { AdminCustomerEmailDependencies } from '../src/routes/admin-customer-email.routes.js';

const pngBytes = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d,
]);

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

  test('rejects oversized test subject and body overrides before sending', async () => {
    const { dependencies, service } = createHarness();
    const app = await buildApp({ adminCustomerEmail: dependencies });

    try {
      for (const payload of [
        { recipientEmail: 'customer@example.com', subject: 's'.repeat(201) },
        { body: 'b'.repeat(10_001), recipientEmail: 'customer@example.com' },
      ]) {
        const response = await app.inject({
          headers: { authorization: 'Bearer session-token' },
          method: 'POST',
          payload,
          url: '/admin/customer-email/test',
        });

        expect(response.statusCode).toBe(400);
      }
      expect(service.sendTest).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('stores authenticated customer email logo uploads as content-addressed public assets', async () => {
    const assetsDirectory = await mkdtemp(join(tmpdir(), 'customer-email-assets-'));
    const { dependencies } = createHarness({
      assetsDirectory,
      publicBaseUrl: 'https://clever-route-api.example.com/root/',
    });
    const app = await buildApp({ adminCustomerEmail: dependencies });

    try {
      const upload = multipartLogoRequest({ bytes: pngBytes, contentType: 'image/png', filename: 'logo.png' });
      const uploadResponse = await app.inject({
        ...upload,
        headers: {
          ...upload.headers,
          authorization: 'Bearer session-token',
        },
        method: 'POST',
        url: '/admin/customer-email/logo',
      });

      expect(uploadResponse.statusCode).toBe(201);
      expect(uploadResponse.json()).toEqual({
        data: {
          logoAsset: {
            contentType: 'image/png',
            sizeBytes: pngBytes.byteLength,
            url: expect.stringMatching(/^https:\/\/clever-route-api\.example\.com\/root\/customer-email\/assets\/[a-f0-9]{64}\.png$/u) as unknown,
          },
        },
        error: null,
      });

      const uploadBody = uploadResponse.json<{ data: { logoAsset: { url: string } } }>();
      const fileName = new URL(uploadBody.data.logoAsset.url).pathname.split('/').at(-1);
      expect(fileName).toBeDefined();
      await expect(readFile(join(assetsDirectory, fileName as string))).resolves.toEqual(pngBytes);

      const publicResponse = await app.inject({
        method: 'GET',
        url: `/customer-email/assets/${fileName}`,
      });
      expect(publicResponse.statusCode).toBe(200);
      expect(publicResponse.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      expect(publicResponse.headers['x-content-type-options']).toBe('nosniff');
      expect(publicResponse.headers['content-type']).toContain('image/png');
      expect(publicResponse.rawPayload).toEqual(pngBytes);
    } finally {
      await app.close();
      await rm(assetsDirectory, { force: true, recursive: true });
    }
  });

  test('rejects customer email logo uploads without authentication', async () => {
    const assetsDirectory = await mkdtemp(join(tmpdir(), 'customer-email-assets-'));
    const { dependencies } = createHarness({ assetsDirectory });
    const app = await buildApp({ adminCustomerEmail: dependencies });

    try {
      const response = await app.inject({
        ...multipartLogoRequest({ bytes: pngBytes, contentType: 'image/png', filename: 'logo.png' }),
        method: 'POST',
        url: '/admin/customer-email/logo',
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        data: null,
        error: { code: 'UNAUTHORIZED', message: 'Missing bearer session token' },
      });
    } finally {
      await app.close();
      await rm(assetsDirectory, { force: true, recursive: true });
    }
  });

  test('keeps existing customer email routes available when logo storage is not configured', async () => {
    const { dependencies, service } = createHarness({ assetsConfigured: false });
    const app = await buildApp({ adminCustomerEmail: dependencies });
    const settings = defaultCustomerEmailSettings();
    service.getSettings.mockResolvedValue(settings);

    try {
      const settingsResponse = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'GET',
        url: '/admin/customer-email/settings',
      });
      const upload = multipartLogoRequest({ bytes: pngBytes, contentType: 'image/png', filename: 'logo.png' });
      const uploadResponse = await app.inject({
        ...upload,
        headers: { ...upload.headers, authorization: 'Bearer session-token' },
        method: 'POST',
        url: '/admin/customer-email/logo',
      });

      expect(settingsResponse.statusCode).toBe(200);
      expect(uploadResponse.statusCode).toBe(503);
      expect(uploadResponse.json()).toEqual({
        data: null,
        error: {
          code: 'CUSTOMER_EMAIL_ASSET_STORAGE_NOT_CONFIGURED',
          message: 'Customer email logo storage is not configured.',
        },
      });
    } finally {
      await app.close();
    }
  });

  test('rejects customer email logo uploads with mismatched magic bytes', async () => {
    const assetsDirectory = await mkdtemp(join(tmpdir(), 'customer-email-assets-'));
    const { dependencies } = createHarness({ assetsDirectory });
    const app = await buildApp({ adminCustomerEmail: dependencies });
    const upload = multipartLogoRequest({
      bytes: Buffer.from('not-a-png'),
      contentType: 'image/png',
      filename: 'logo.png',
    });

    try {
      const response = await app.inject({
        ...upload,
        headers: { ...upload.headers, authorization: 'Bearer session-token' },
        method: 'POST',
        url: '/admin/customer-email/logo',
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        data: null,
        error: { code: 'BAD_REQUEST', message: 'Logo must be a PNG, JPEG, or WebP image.' },
      });
    } finally {
      await app.close();
      await rm(assetsDirectory, { force: true, recursive: true });
    }
  });

  test('rejects customer email logo uploads over one MiB', async () => {
    const assetsDirectory = await mkdtemp(join(tmpdir(), 'customer-email-assets-'));
    const { dependencies } = createHarness({ assetsDirectory });
    const app = await buildApp({ adminCustomerEmail: dependencies });
    const upload = multipartLogoRequest({
      bytes: Buffer.concat([pngBytes, Buffer.alloc(1024 * 1024)]),
      contentType: 'image/png',
      filename: 'logo.png',
    });

    try {
      const response = await app.inject({
        ...upload,
        headers: { ...upload.headers, authorization: 'Bearer session-token' },
        method: 'POST',
        url: '/admin/customer-email/logo',
      });

      expect(response.statusCode).toBe(413);
      expect(response.json()).toEqual({
        data: null,
        error: { code: 'PAYLOAD_TOO_LARGE', message: 'Logo must be at most 1 MiB.' },
      });
    } finally {
      await app.close();
      await rm(assetsDirectory, { force: true, recursive: true });
    }
  });

  test('does not serve invalid customer email asset names', async () => {
    const assetsDirectory = await mkdtemp(join(tmpdir(), 'customer-email-assets-'));
    const { dependencies } = createHarness({ assetsDirectory });
    const app = await buildApp({ adminCustomerEmail: dependencies });

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/customer-email/assets/not-a-content-address.png',
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        data: null,
        error: { code: 'NOT_FOUND', message: 'Customer email asset not found' },
      });
    } finally {
      await app.close();
      await rm(assetsDirectory, { force: true, recursive: true });
    }
  });
});

function createHarness(input: { assetsConfigured?: boolean; assetsDirectory?: string; publicBaseUrl?: string } = {}) {
  const service = {
    getSettings: vi.fn(),
    preview: vi.fn(),
    saveSettings: vi.fn(),
    send: vi.fn(),
    sendTest: vi.fn(),
  };
  const logoAssets = {
    directory: input.assetsDirectory ?? join(tmpdir(), 'customer-email-assets-test'),
    publicBaseUrl: input.publicBaseUrl ?? 'https://clever-route-api.example.com',
  };
  const dependencies: AdminCustomerEmailDependencies = {
    customerEmailService: service as never,
    ...(input.assetsConfigured === false ? {} : { logoAssets }),
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

function multipartLogoRequest(input: { bytes: Buffer; contentType: string; filename: string }): {
  headers: Record<string, string>;
  payload: Buffer;
} {
  const boundary = 'customer-email-logo-boundary';
  return {
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="logo"; filename="${input.filename}"\r\n` +
          `Content-Type: ${input.contentType}\r\n\r\n`,
        'utf8',
      ),
      input.bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
    ]),
  };
}
