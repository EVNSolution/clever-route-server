import { describe, expect, test, vi } from 'vitest';

import { CustomerEmailService } from '../src/modules/customer-email/customer-email.service.js';
import { defaultCustomerEmailSettings } from '../src/modules/customer-email/customer-email-settings.js';
import { BrevoCustomerEmailTransport } from '../src/modules/customer-email/customer-email-transport.js';

describe('CustomerEmailService', () => {
  test('migrates a v1 settings write to v2 during a rolling app deployment', async () => {
    const { prisma, service } = createHarness();
    const current = defaultCustomerEmailSettings();
    const v1Settings = {
      nearbyStopsThreshold: 4,
      replyTo: 'reply@example.com',
      senderEmail: 'sender@example.com',
      senderName: 'Legacy Sender',
      templates: current.templates,
      version: 1,
    };
    prisma.shop.findUnique.mockResolvedValue({ id: 'shop-id' });

    await expect(service.saveSettings({
      payload: v1Settings,
      shopDomain: 'example.myshopify.com',
    })).resolves.toMatchObject({
      branding: current.branding,
      nearbyStopsThreshold: 4,
      senderName: 'Legacy Sender',
      version: 2,
    });
    expect(prisma.shop.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { customerEmailSettings: expect.objectContaining({ version: 2 }) as unknown },
      where: { id: 'shop-id' },
    }));
  });

  test('previews eligible recipients and reports missing canonical order email', async () => {
    const { prisma, service } = createHarness();
    prisma.routePlan.findFirst.mockResolvedValue(routePlanRow({
      stops: [
        stopRow({ email: 'customer@example.com', id: 'stop-1', sequence: 1, status: 'PENDING' }),
        stopRow({ email: null, id: 'stop-2', sequence: 2, status: 'PENDING' }),
      ],
    }));

    const preview = await service.preview({
      routePlanId: 'route-id',
      shopDomain: 'example.myshopify.com',
      signal: 'DELIVERY_SCHEDULED',
    });

    expect(preview).toMatchObject({
      counts: { eligible: 2, rendered: 1, skipped: 1, totalStops: 2 },
      recipients: [{
        deliveryStopId: 'stop-1',
        email: 'customer@example.com',
        rendered: {
          // Vitest asymmetric matchers are intentionally typed as any inside object literals.
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          body: expect.stringContaining('Order #1'),
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          subject: expect.stringContaining('scheduled'),
        },
      }],
      skipped: [{ code: 'CUSTOMER_EMAIL_MISSING', deliveryStopId: 'stop-2' }],
    });
  });

  test('computes signal eligibility from stop status and nearby route progress', async () => {
    const { prisma, service } = createHarness();
    prisma.routePlan.findFirst.mockResolvedValue(routePlanRow({
      stops: [
        stopRow({ id: 'stop-1', sequence: 1, status: 'DELIVERED' }),
        stopRow({ id: 'stop-2', sequence: 2, status: 'EN_ROUTE' }),
        stopRow({ id: 'stop-3', sequence: 3, status: 'PENDING' }),
        stopRow({ id: 'stop-4', sequence: 4, status: 'PENDING' }),
        stopRow({ id: 'stop-5', sequence: 5, status: 'PENDING' }),
      ],
    }));

    await expect(service.preview({
      routePlanId: 'route-id',
      shopDomain: 'example.myshopify.com',
      signal: 'OUT_FOR_DELIVERY',
    })).resolves.toMatchObject({
      recipients: [
        { deliveryStopId: 'stop-2' },
        { deliveryStopId: 'stop-3' },
        { deliveryStopId: 'stop-4' },
        { deliveryStopId: 'stop-5' },
      ],
    });

    await expect(service.preview({
      routePlanId: 'route-id',
      shopDomain: 'example.myshopify.com',
      signal: 'DELIVERED',
    })).resolves.toMatchObject({ recipients: [{ deliveryStopId: 'stop-1' }] });

    await expect(service.preview({
      routePlanId: 'route-id',
      shopDomain: 'example.myshopify.com',
      signal: 'DRIVER_NEARBY',
    })).resolves.toMatchObject({
      recipients: [{ deliveryStopId: 'stop-5' }],
    });
  });

  test('manual send persists separate audit rows and never touches automatic notification facts', async () => {
    const { prisma, service, transport } = createHarness();
    prisma.routePlan.findFirst.mockResolvedValue(routePlanRow({
      stops: [stopRow({ email: 'customer@example.com', id: 'stop-1', sequence: 1, status: 'PENDING' })],
    }));
    prisma.customerEmailManualDispatch.create.mockResolvedValue({ id: 'dispatch-id' });
    transport.send.mockResolvedValue({ provider: 'brevo', providerMessageId: 'message-id' });

    const dispatch = await service.send({
      actor: 'admin-user',
      commandId: 'command-1',
      confirmed: true,
      routePlanId: 'route-id',
      shopDomain: 'example.myshopify.com',
      signal: 'DELIVERY_SCHEDULED',
    });

    expect(dispatch).toMatchObject({
      counts: { duplicate: 0, failed: 0, sent: 1, skipped: 0 },
      results: [{ providerMessageId: 'message-id', status: 'SENT' }],
    });
    expect(transport.send).toHaveBeenCalledWith(expect.objectContaining({
      branding: expect.objectContaining({ showPoweredByClever: true }) as unknown,
    }));
    expect(prisma.customerEmailManualDispatch.create).toHaveBeenCalledOnce();
    expect(prisma.customerEmailManualDispatchRecipient.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      data: expect.objectContaining({ providerMessageId: 'message-id', status: 'SENT' }),
    }));
    expect('customerRouteNotificationFact' in prisma).toBe(false);
  });

  test('idempotency duplicate returns stored results without sending again', async () => {
    const { prisma, service, transport } = createHarness();
    prisma.routePlan.findFirst.mockResolvedValue(routePlanRow({
      stops: [stopRow({ email: 'customer@example.com', id: 'stop-1', sequence: 1, status: 'PENDING' })],
    }));
    prisma.customerEmailManualDispatch.create.mockRejectedValue({ code: 'P2002' });
    prisma.customerEmailManualDispatch.findUnique.mockResolvedValueOnce({ id: 'dispatch-id' });
    prisma.customerEmailManualDispatch.findUniqueOrThrow.mockResolvedValue({
      commandId: 'command-1',
      id: 'dispatch-id',
      recipients: [{
        deliveryStopId: 'stop-1',
        errorCode: null,
        errorMessage: null,
        orderId: 'order-1',
        provider: 'brevo',
        providerMessageId: 'message-id',
        recipientEmail: 'customer@example.com',
        status: 'SENT',
      }],
    });

    await expect(service.send({
      actor: 'admin-user',
      commandId: 'command-1',
      confirmed: true,
      routePlanId: 'route-id',
      shopDomain: 'example.myshopify.com',
      signal: 'DELIVERY_SCHEDULED',
    })).resolves.toMatchObject({
      counts: { duplicate: 1, failed: 0, sent: 0, skipped: 0 },
      duplicate: true,
      results: [{ status: 'DUPLICATE' }],
    });
    expect(transport.send).not.toHaveBeenCalled();
  });

  test('test sends include normalized branding', async () => {
    const { prisma, service, transport } = createHarness();
    prisma.shop.findUnique.mockResolvedValue({
      customerEmailSettings: {
        ...defaultCustomerEmailSettings(),
        branding: {
          ...defaultCustomerEmailSettings().branding,
          accentColor: '#0055aa',
          footerText: 'Footer',
          previewText: 'Preview',
        },
        senderEmail: 'sender@example.com',
      },
    });
    transport.send.mockResolvedValue({ provider: 'brevo', providerMessageId: 'message-id' });

    await expect(service.sendTest({
      recipientEmail: 'customer@example.com',
      shopDomain: 'example.myshopify.com',
    })).resolves.toMatchObject({
      messageId: 'message-id',
      provider: 'brevo',
    });

    expect(transport.send).toHaveBeenCalledWith(expect.objectContaining({
      branding: expect.objectContaining({
        accentColor: '#0055aa',
        footerText: 'Footer',
        previewText: 'Preview',
      }) as unknown,
      signal: 'TEST',
    }));
  });
});

describe('BrevoCustomerEmailTransport', () => {
  test('sends escaped neutral HTML with subject heading, body, divider, and boxed footer', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ messageId: 'brevo-id' }), { status: 201 }));
    const transport = new BrevoCustomerEmailTransport({
      apiKey: 'secret',
      fetchImpl,
      timeoutMs: 1234,
    });

    await expect(transport.send({
      branding: {
        ...defaultCustomerEmailSettings().branding,
        accentColor: '#0055aa',
        backgroundColor: '#112233',
        footerText: 'Footer <script>alert(1)</script>',
        logoAltText: 'User controlled <Logo>',
        logoLinkUrl: 'https://example.com/email',
        logoMode: 'image',
        logoUrl: 'https://example.com/logo.png',
        previewText: 'Preview <hidden>',
        showPoweredByClever: true,
        surfaceColor: '#223344',
        textColor: '#334455',
      },
      body: 'Hello <customer>',
      commandId: 'command-1:stop-1',
      recipientEmail: 'customer@example.com',
      replyTo: 'reply@example.com',
      senderEmail: 'sender@example.com',
      senderName: 'Sender & Co <Team>',
      signal: 'DELIVERY_SCHEDULED',
      subject: 'Subject <urgent>',
      tags: ['customer-delivery-email', 'delivery_scheduled'],
    })).resolves.toEqual({ provider: 'brevo', providerMessageId: 'brevo-id' });

    const [, request] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(request.headers).toMatchObject({ 'api-key': 'secret' });
    expect(JSON.parse(request.body as string)).toMatchObject({
      headers: { 'Idempotency-Key': 'customer-email:command-1:stop-1' },
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      htmlContent: expect.stringContaining('&lt;customer&gt;'),
      replyTo: { email: 'reply@example.com' },
      sender: { email: 'sender@example.com', name: 'Sender & Co <Team>' },
      tags: ['customer-delivery-email', 'delivery_scheduled'],
      textContent: 'Hello <customer>',
    });
    const parsedBody = JSON.parse(request.body as string) as { htmlContent: string; textContent: string };
    expect(parsedBody.htmlContent).toContain('<meta name="color-scheme" content="light dark">');
    expect(parsedBody.htmlContent).toContain('<meta name="supported-color-schemes" content="light dark">');
    expect(parsedBody.htmlContent).toMatch(/<h1[^>]*>Subject &lt;urgent&gt;<\/h1>[\s\S]*Hello &lt;customer&gt;[\s\S]*<hr/u);
    expect(parsedBody.htmlContent).toContain('Footer &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(parsedBody.htmlContent).toContain('alt="Sender &amp; Co Team"');
    expect(parsedBody.htmlContent).toMatch(/<td[^>]*border:1px solid #d0d7de[^>]*>[\s\S]*<table role="presentation"[\s\S]*alt="Sender &amp; Co Team"[\s\S]*Footer &lt;script&gt;alert\(1\)&lt;\/script&gt;/u);
    expect(parsedBody.htmlContent).not.toContain('Preview &lt;hidden&gt;');
    expect(parsedBody.htmlContent).not.toContain('display:none');
    expect(parsedBody.htmlContent).not.toContain('User controlled');
    expect(parsedBody.htmlContent).not.toContain('#0055aa');
    expect(parsedBody.htmlContent).not.toContain('#112233');
    expect(parsedBody.htmlContent).not.toContain('#223344');
    expect(parsedBody.htmlContent).not.toContain('#334455');
    expect(parsedBody.htmlContent).not.toContain('<customer>');
    expect(parsedBody.htmlContent).not.toContain('<script>');
    expect(parsedBody.htmlContent).not.toContain('<urgent>');
    expect(parsedBody.htmlContent).not.toContain('Powered by CLEVER');
    expect(parsedBody.textContent).toBe('Hello <customer>');
    expect(request.signal).toBeDefined();
  });
});

function createHarness() {
  const prisma = {
    customerEmailManualDispatch: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
    },
    customerEmailManualDispatchRecipient: {
      updateMany: vi.fn(),
    },
    routePlan: {
      findFirst: vi.fn(),
    },
    shop: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  };
  const transport = {
    configured: true,
    providerName: 'brevo',
    send: vi.fn(),
  };
  return {
    prisma,
    service: new CustomerEmailService(prisma as never, transport),
    transport,
  };
}

function routePlanRow(input: { stops: ReturnType<typeof stopRow>[] }) {
  return {
    id: 'route-id',
    name: 'Route A',
    planDate: new Date('2026-08-03T00:00:00.000Z'),
    routeStops: input.stops,
    shop: {
      customerEmailSettings: {
        ...defaultCustomerEmailSettings(),
        senderEmail: 'sender@example.com',
      },
      id: 'shop-id',
      shopDomain: 'example.myshopify.com',
    },
  };
}

function stopRow(input: {
  email?: string | null;
  id: string;
  sequence: number;
  status: string;
}) {
  return {
    deliveryStop: {
      address1: '1 Main St',
      address2: null,
      city: 'Toronto',
      countryCode: 'CA',
      deliveryDate: new Date('2026-08-04T00:00:00.000Z'),
      id: input.id,
      order: {
        email: input.email === undefined ? `${input.id}@example.com` : input.email,
        id: `order-${input.sequence}`,
        name: `Order #${input.sequence}`,
      },
      orderId: `order-${input.sequence}`,
      postalCode: 'M1M 1M1',
      province: 'ON',
      recipientName: 'Jane Customer',
      status: input.status,
    },
    estimatedArrivalAt: new Date('2026-08-04T10:00:00.000Z'),
    sequence: input.sequence,
  };
}
