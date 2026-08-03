import { describe, expect, test, vi } from 'vitest';

import { CustomerEmailService } from '../src/modules/customer-email/customer-email.service.js';
import { defaultCustomerEmailSettings } from '../src/modules/customer-email/customer-email-settings.js';
import { BrevoCustomerEmailTransport } from '../src/modules/customer-email/customer-email-transport.js';

describe('CustomerEmailService', () => {
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
});

describe('BrevoCustomerEmailTransport', () => {
  test('sends escaped HTML, sender, replyTo, tags, idempotency, and timeout', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ messageId: 'brevo-id' }), { status: 201 }));
    const transport = new BrevoCustomerEmailTransport({
      apiKey: 'secret',
      fetchImpl,
      timeoutMs: 1234,
    });

    await expect(transport.send({
      body: 'Hello <customer>',
      commandId: 'command-1:stop-1',
      recipientEmail: 'customer@example.com',
      replyTo: 'reply@example.com',
      senderEmail: 'sender@example.com',
      senderName: 'CLEVER',
      signal: 'DELIVERY_SCHEDULED',
      subject: 'Subject',
      tags: ['customer-delivery-email', 'delivery_scheduled'],
    })).resolves.toEqual({ provider: 'brevo', providerMessageId: 'brevo-id' });

    const [, request] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(request.headers).toMatchObject({ 'api-key': 'secret' });
    expect(JSON.parse(request.body as string)).toMatchObject({
      headers: { 'Idempotency-Key': 'customer-email:command-1:stop-1' },
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      htmlContent: expect.stringContaining('&lt;customer&gt;'),
      replyTo: { email: 'reply@example.com' },
      sender: { email: 'sender@example.com', name: 'CLEVER' },
      tags: ['customer-delivery-email', 'delivery_scheduled'],
      textContent: 'Hello <customer>',
    });
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
