import { describe, expect, test, vi } from 'vitest';

import { CustomerEmailService } from '../src/modules/customer-email/customer-email.service.js';
import { defaultCustomerEmailSettings } from '../src/modules/customer-email/customer-email-settings.js';
import { BrevoCustomerEmailTransport } from '../src/modules/customer-email/customer-email-transport.js';

describe('CustomerEmailService', () => {
  test('activates automatic delivery only through the consent-scoped command', async () => {
    const { prisma, service } = createHarness();
    const updatedAt = new Date('2026-08-31T07:00:00.000Z');
    prisma.shop.findUnique.mockResolvedValue({
      customerEmailSettings: defaultCustomerEmailSettings(), id: 'shop-id', updatedAt
    });
    prisma.shop.updateMany.mockResolvedValue({ count: 1 });

    const activation = await service.setAutomaticActivation({
      acceptedBy: 'operator-id', confirmed: true, enabled: true,
      noticeVersion: 'customer-email-automatic-v1', shopDomain: 'example.myshopify.com'
    });

    expect(activation).toMatchObject({
      consent: {
        acceptedBy: 'operator-id', noticeVersion: 'customer-email-automatic-v1', settingsVersion: expect.stringContaining('v3:g1') as unknown
      },
      enabled: true
    });
    expect(prisma.shop.updateMany).toHaveBeenCalledWith({
      data: { customerEmailSettings: expect.objectContaining({ automatic: expect.objectContaining({ enabled: true }) as unknown }) as unknown },
      where: { id: 'shop-id', updatedAt }
    });
  });

  test('rejects unconfirmed automatic activation', async () => {
    const { service } = createHarness();
    await expect(service.setAutomaticActivation({
      acceptedBy: 'operator-id', confirmed: false, enabled: true, shopDomain: 'example.myshopify.com'
    })).rejects.toMatchObject({ code: 'CUSTOMER_EMAIL_BAD_REQUEST' });
  });

  test('migrates a v1 settings write to v3 during a rolling app deployment', async () => {
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
      automatic: { enabled: false },
      branding: current.branding,
      compatibility: { nearbyStopsThreshold: 4 },
      senderName: 'Legacy Sender',
      version: 3,
    });
    expect(prisma.shop.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { customerEmailSettings: expect.objectContaining({ version: 3 }) as unknown },
      where: { id: 'shop-id' },
    }));
  });

  test('allows only legacy full settings migration and rejects V3 full writes', async () => {
    const { prisma, service } = createHarness();
    const current = defaultCustomerEmailSettings();
    const v2Settings = {
      ...current,
      automatic: undefined,
      compatibility: undefined,
      nearbyStopsThreshold: 5,
      version: 2,
    };
    prisma.shop.findUnique.mockResolvedValue({ id: 'shop-id' });

    await expect(service.saveSettings({
      payload: v2Settings,
      shopDomain: 'example.myshopify.com',
    })).resolves.toMatchObject({
      automatic: { enabled: false },
      compatibility: { nearbyStopsThreshold: 5 },
      version: 3,
    });
    await expect(service.saveSettings({
      payload: {
        ...current,
        automatic: { ...current.automatic, enabled: true },
      },
      shopDomain: 'example.myshopify.com',
    })).rejects.toMatchObject({
      code: 'CUSTOMER_EMAIL_BAD_REQUEST',
      message: expect.stringContaining('V3 full settings writes are not allowed') as unknown,
    });
  });

  test('saves global settings only when globalVersion matches and preserves templates and automatic off', async () => {
    const { prisma, service } = createHarness();
    const updatedAt = new Date('2026-08-05T00:00:00.000Z');
    const current = {
      ...defaultCustomerEmailSettings(),
      automatic: {
        consent: {
          acceptedAt: null,
          acceptedBy: null,
          noticeVersion: null,
          settingsVersion: null,
        },
        enabled: false,
      },
      globalVersion: 3,
      senderEmail: 'old@example.com',
      templates: {
        ...defaultCustomerEmailSettings().templates,
        DELIVERY_SCHEDULED: {
          body: 'Original {{orderNumber}}',
          enabled: true,
          subject: 'Original subject',
          version: 9,
        },
      },
    };
    prisma.shop.findUnique.mockResolvedValue({ customerEmailSettings: current, id: 'shop-id', updatedAt });
    prisma.shop.updateMany.mockResolvedValue({ count: 1 });

    await expect(service.saveGlobalSettings({
      payload: {
        branding: {
          businessName: 'New Brand',
          note: 'New footer note',
        },
        expectedVersion: 3,
        replyTo: 'reply@example.com',
        senderEmail: 'new@example.com',
        senderName: 'New Sender',
      },
      shopDomain: 'example.myshopify.com',
    })).resolves.toMatchObject({
      automatic: { enabled: false },
      globalVersion: 4,
      replyTo: 'reply@example.com',
      senderEmail: 'new@example.com',
      senderName: 'New Sender',
      branding: {
        accentColor: current.branding.accentColor,
        backgroundColor: current.branding.backgroundColor,
        businessName: 'New Brand',
        note: 'New footer note',
        surfaceColor: current.branding.surfaceColor,
        textColor: current.branding.textColor,
      },
      templates: {
        DELIVERY_SCHEDULED: {
          body: 'Original {{orderNumber}}',
          subject: 'Original subject',
          version: 9,
        },
      },
    });
    expect(prisma.shop.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: {
        customerEmailSettings: expect.objectContaining({
          automatic: expect.objectContaining({ enabled: false }) as unknown,
          globalVersion: 4,
          templates: expect.objectContaining({
            DELIVERY_SCHEDULED: expect.objectContaining({ version: 9 }) as unknown,
          }) as unknown,
        }) as unknown,
      },
      where: { id: 'shop-id', updatedAt },
    }));
  });

  test('rejects stale global settings saves without updating', async () => {
    const { prisma, service } = createHarness();
    const current = { ...defaultCustomerEmailSettings(), globalVersion: 3 };
    prisma.shop.findUnique.mockResolvedValue({ customerEmailSettings: current, id: 'shop-id', updatedAt: new Date('2026-08-05T00:00:00.000Z') });

    await expect(service.saveGlobalSettings({
      payload: {
        branding: current.branding,
        expectedVersion: 2,
        replyTo: null,
        senderEmail: 'new@example.com',
        senderName: 'New Sender',
      },
      shopDomain: 'example.myshopify.com',
    })).rejects.toMatchObject({ code: 'SETTINGS_VERSION_CONFLICT' });
    expect(prisma.shop.updateMany).not.toHaveBeenCalled();
  });

  test('detects concurrent global settings writes against the same updatedAt snapshot', async () => {
    const { prisma, service } = createHarness();
    const updatedAt = new Date('2026-08-05T00:00:00.000Z');
    const current = { ...defaultCustomerEmailSettings(), globalVersion: 1, senderEmail: 'old@example.com' };
    prisma.shop.findUnique.mockResolvedValue({ customerEmailSettings: current, id: 'shop-id', updatedAt });
    prisma.shop.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    const payload = {
      branding: current.branding,
      expectedVersion: 1,
      replyTo: null,
      senderEmail: 'new@example.com',
      senderName: 'New Sender',
    };

    await expect(service.saveGlobalSettings({
      payload,
      shopDomain: 'example.myshopify.com',
    })).resolves.toMatchObject({ globalVersion: 2 });
    await expect(service.saveGlobalSettings({
      payload,
      shopDomain: 'example.myshopify.com',
    })).rejects.toMatchObject({ code: 'SETTINGS_VERSION_CONFLICT' });

    expect(prisma.shop.updateMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: { id: 'shop-id', updatedAt },
    }));
    expect(prisma.shop.updateMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: { id: 'shop-id', updatedAt },
    }));
  });

  test('saves one template version and preserves global fields and other templates', async () => {
    const { prisma, service } = createHarness();
    const current = {
      ...defaultCustomerEmailSettings(),
      globalVersion: 5,
      senderEmail: 'sender@example.com',
      templates: {
        ...defaultCustomerEmailSettings().templates,
        OUT_FOR_DELIVERY: {
          body: 'Old body',
          enabled: false,
          subject: 'Old subject',
          version: 4,
        },
        DELIVERED: {
          body: 'Delivered body',
          enabled: true,
          subject: 'Delivered subject',
          version: 8,
        },
      },
    };
    const updatedAt = new Date('2026-08-05T00:00:00.000Z');
    prisma.shop.findUnique.mockResolvedValue({ customerEmailSettings: current, id: 'shop-id', updatedAt });
    prisma.shop.updateMany.mockResolvedValue({ count: 1 });

    await expect(service.saveTemplateSettings({
      payload: {
        body: 'New body {{inventoryList}}',
        enabled: true,
        expectedVersion: 4,
        subject: 'New subject {{deliveryWeekday}}',
      },
      shopDomain: 'example.myshopify.com',
      signal: 'OUT_FOR_DELIVERY',
    })).resolves.toMatchObject({
      automatic: { enabled: false },
      globalVersion: 5,
      senderEmail: 'sender@example.com',
      templates: {
        OUT_FOR_DELIVERY: {
          body: 'New body {{inventoryList}}',
          enabled: true,
          subject: 'New subject {{deliveryWeekday}}',
          version: 5,
        },
        DELIVERED: {
          body: 'Delivered body',
          version: 8,
        },
      },
    });
  });

  test('rejects stale or invalid template saves without updating', async () => {
    const { prisma, service } = createHarness();
    const current = { ...defaultCustomerEmailSettings(), senderEmail: 'sender@example.com' };
    prisma.shop.findUnique.mockResolvedValue({ customerEmailSettings: current, id: 'shop-id', updatedAt: new Date('2026-08-05T00:00:00.000Z') });

    await expect(service.saveTemplateSettings({
      payload: {
        body: 'New body',
        enabled: true,
        expectedVersion: 999,
        subject: 'New subject',
      },
      shopDomain: 'example.myshopify.com',
      signal: 'DELIVERY_SCHEDULED',
    })).rejects.toMatchObject({ code: 'TEMPLATE_VERSION_CONFLICT' });
    await expect(service.saveTemplateSettings({
      payload: {
        body: '<strong>Raw HTML</strong> {{notAllowed}}',
        enabled: true,
        expectedVersion: 1,
        subject: 'New subject',
      },
      shopDomain: 'example.myshopify.com',
      signal: 'DELIVERY_SCHEDULED',
    })).rejects.toMatchObject({ code: 'CUSTOMER_EMAIL_BAD_REQUEST' });
    expect(prisma.shop.updateMany).not.toHaveBeenCalled();
  });

  test('detects concurrent template writes against the same updatedAt snapshot', async () => {
    const { prisma, service } = createHarness();
    const updatedAt = new Date('2026-08-05T00:00:00.000Z');
    const current = { ...defaultCustomerEmailSettings(), senderEmail: 'sender@example.com' };
    prisma.shop.findUnique.mockResolvedValue({ customerEmailSettings: current, id: 'shop-id', updatedAt });
    prisma.shop.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    const payload = {
      body: 'New body',
      enabled: true,
      expectedVersion: 1,
      subject: 'New subject',
    };

    await expect(service.saveTemplateSettings({
      payload,
      shopDomain: 'example.myshopify.com',
      signal: 'DELIVERY_SCHEDULED',
    })).resolves.toMatchObject({
      templates: { DELIVERY_SCHEDULED: { version: 2 } },
    });
    await expect(service.saveTemplateSettings({
      payload,
      shopDomain: 'example.myshopify.com',
      signal: 'DELIVERY_SCHEDULED',
    })).rejects.toMatchObject({ code: 'TEMPLATE_VERSION_CONFLICT' });

    expect(prisma.shop.updateMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: { id: 'shop-id', updatedAt },
    }));
    expect(prisma.shop.updateMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: { id: 'shop-id', updatedAt },
    }));
  });

  test('previews eligible recipients and reports missing canonical order email', async () => {
    const { prisma, service } = createHarness();
    const settings = defaultCustomerEmailSettings();
    prisma.routePlan.findFirst.mockResolvedValue(routePlanRow({
      customerEmailSettings: {
        ...settings,
        templates: {
          ...settings.templates,
          DELIVERY_SCHEDULED: {
            body: 'Order {{orderNumber}}\nWeekday {{deliveryWeekday}}\nItems:\n{{inventoryList}}',
            enabled: true,
            subject: 'Scheduled {{deliveryDate}}',
            version: 2,
          },
        },
      },
      stops: [
        stopRow({
          deliveryWeekday: 'TUESDAY',
          email: 'customer@example.com',
          id: 'stop-1',
          items: [
            { lineIndex: 0, name: 'Kimchi', options: [{ name: 'Size', value: 'Large' }], quantity: 2 },
            { lineIndex: 1, name: 'Rice', options: [], quantity: 1 },
          ],
          sequence: 1,
          status: 'PENDING',
        }),
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
          body: expect.stringContaining('2 x Kimchi (Size: Large)\n1 x Rice'),
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          subject: expect.stringContaining('Scheduled'),
        },
      }],
      skipped: [{ code: 'CUSTOMER_EMAIL_MISSING', deliveryStopId: 'stop-2' }],
    });
  });

  test('adds manual send history summaries with one content-free recipient query', async () => {
    const { prisma, service } = createHarness();
    prisma.routePlan.findFirst.mockResolvedValue(routePlanRow({
      stops: [stopRow({ email: 'customer@example.com', id: 'stop-1', sequence: 1, status: 'PENDING' })],
    }));
    prisma.customerEmailManualDispatchRecipient.findMany.mockResolvedValue([
      {
        createdAt: new Date('2026-08-05T12:00:00.000Z'),
        deliveryStopId: 'stop-1',
        providerEventAt: new Date('2026-08-05T12:00:02.000Z'),
        providerStatus: 'HARD_BOUNCE',
        sentAt: null,
        status: 'FAILED',
      },
      {
        createdAt: new Date('2026-08-05T11:00:00.000Z'),
        deliveryStopId: 'stop-1',
        providerEventAt: new Date('2026-08-05T11:01:02.000Z'),
        providerStatus: 'DELIVERED',
        sentAt: new Date('2026-08-05T11:01:00.000Z'),
        status: 'SENT',
      },
    ]);

    await expect(service.preview({
      routePlanId: 'route-id',
      shopDomain: 'example.myshopify.com',
      signal: 'DELIVERY_SCHEDULED',
    })).resolves.toMatchObject({
      recipients: [{
        deliveryStopId: 'stop-1',
        history: {
          lastProviderEventAt: '2026-08-05T12:00:02.000Z',
          lastProviderStatus: 'HARD_BOUNCE',
          lastSentAt: '2026-08-05T11:01:00.000Z',
          lastStatus: 'FAILED',
          sendCount: 1,
        },
      }],
    });

    expect(prisma.customerEmailManualDispatchRecipient.findMany).toHaveBeenCalledWith({
      orderBy: { createdAt: 'desc' },
      select: {
        createdAt: true,
        deliveryStopId: true,
        providerEventAt: true,
        providerStatus: true,
        sentAt: true,
        status: true,
      },
      where: {
        deliveryStopId: { in: ['stop-1'] },
        dispatch: { signal: 'DELIVERY_SCHEDULED' },
        routePlanId: 'route-id',
        shopId: 'shop-id',
      },
    });
  });

  test('renders missing non-email template values blank and returns diagnostics while preserving missing email skips', async () => {
    const { prisma, service } = createHarness();
    const settings = defaultCustomerEmailSettings();
    prisma.routePlan.findFirst.mockResolvedValue(routePlanRow({
      customerEmailSettings: {
        ...settings,
        templates: {
          ...settings.templates,
          DELIVERY_SCHEDULED: {
            body: 'Hello {{customerName}} ETA {{eta}} Items {{inventoryList}}',
            enabled: true,
            subject: 'Weekday {{deliveryWeekday}}',
            version: 1,
          },
        },
      },
      stops: [
        stopRow({
          email: 'customer@example.com',
          estimatedArrivalAt: null,
          id: 'stop-1',
          items: [],
          recipientName: null,
          sequence: 1,
          status: 'PENDING',
        }),
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
        diagnostics: {
          body: [
            { code: 'MISSING_TEMPLATE_VALUE', key: 'customerName' },
            { code: 'MISSING_TEMPLATE_VALUE', key: 'eta' },
            { code: 'MISSING_TEMPLATE_VALUE', key: 'inventoryList' },
          ],
          subject: [{ code: 'MISSING_TEMPLATE_VALUE', key: 'deliveryWeekday' }],
        },
        rendered: {
          body: 'Hello  ETA  Items ',
          subject: 'Weekday ',
        },
      }],
      skipped: [{ code: 'CUSTOMER_EMAIL_MISSING', deliveryStopId: 'stop-2' }],
    });
  });

  test('blocks manual send with missing template diagnostics until missing values are confirmed', async () => {
    const { prisma, service, transport } = createHarness();
    const settings = defaultCustomerEmailSettings();
    prisma.routePlan.findFirst.mockResolvedValue(routePlanRow({
      customerEmailSettings: {
        ...settings,
        senderEmail: 'sender@example.com',
        templates: {
          ...settings.templates,
          DELIVERY_SCHEDULED: {
            body: 'Hello {{customerName}} ETA {{eta}} Items {{inventoryList}}',
            enabled: true,
            subject: 'Weekday {{deliveryWeekday}}',
            version: 1,
          },
        },
      },
      stops: [stopRow({
        email: 'customer@example.com',
        estimatedArrivalAt: null,
        id: 'stop-1',
        items: [],
        recipientName: null,
        sequence: 1,
        status: 'PENDING',
      })],
    }));

    await expect(service.send({
      actor: 'admin-user',
      commandId: 'command-1',
      confirmed: true,
      routePlanId: 'route-id',
      shopDomain: 'example.myshopify.com',
      signal: 'DELIVERY_SCHEDULED',
    })).rejects.toMatchObject({ code: 'MISSING_TEMPLATE_VALUES_CONFIRMATION_REQUIRED' });
    expect(prisma.customerEmailManualDispatch.create).not.toHaveBeenCalled();
    expect(transport.send).not.toHaveBeenCalled();

    prisma.customerEmailManualDispatch.create.mockResolvedValue({ id: 'dispatch-id' });
    transport.send.mockResolvedValue({ provider: 'brevo', providerMessageId: 'message-id' });
    await expect(service.send({
      actor: 'admin-user',
      commandId: 'command-1',
      confirmed: true,
      missingValuesConfirmed: true,
      routePlanId: 'route-id',
      shopDomain: 'example.myshopify.com',
      signal: 'DELIVERY_SCHEDULED',
    })).resolves.toMatchObject({
      counts: { duplicate: 0, failed: 0, sent: 1, skipped: 0 },
      results: [{ status: 'SENT' }],
    });
    expect(transport.send).toHaveBeenCalledWith(expect.objectContaining({
      body: 'Hello  ETA  Items ',
      subject: 'Weekday ',
    }));
  });

  test('blocks manual resend after a prior same-signal SENT until resend is confirmed', async () => {
    const { prisma, service, transport } = createHarness();
    prisma.routePlan.findFirst.mockResolvedValue(routePlanRow({
      stops: [stopRow({ email: 'customer@example.com', id: 'stop-1', sequence: 1, status: 'PENDING' })],
    }));
    prisma.customerEmailManualDispatchRecipient.findMany.mockResolvedValue([{
      createdAt: new Date('2026-08-05T12:00:00.000Z'),
      deliveryStopId: 'stop-1',
      sentAt: new Date('2026-08-05T12:00:01.000Z'),
      status: 'SENT',
    }]);

    await expect(service.send({
      actor: 'admin-user',
      commandId: 'command-1',
      confirmed: true,
      routePlanId: 'route-id',
      shopDomain: 'example.myshopify.com',
      signal: 'DELIVERY_SCHEDULED',
    })).rejects.toMatchObject({ code: 'RESEND_CONFIRMATION_REQUIRED' });
    expect(prisma.customerEmailManualDispatch.create).not.toHaveBeenCalled();
    expect(transport.send).not.toHaveBeenCalled();

    prisma.customerEmailManualDispatch.create.mockResolvedValue({ id: 'dispatch-id' });
    transport.send.mockResolvedValue({ provider: 'brevo', providerMessageId: 'message-id' });
    await expect(service.send({
      actor: 'admin-user',
      commandId: 'command-2',
      confirmed: true,
      resendConfirmed: true,
      routePlanId: 'route-id',
      shopDomain: 'example.myshopify.com',
      signal: 'DELIVERY_SCHEDULED',
    })).resolves.toMatchObject({
      counts: { duplicate: 0, failed: 0, sent: 1, skipped: 0 },
      results: [{ deliveryStopId: 'stop-1', status: 'SENT' }],
    });
    expect(transport.send).toHaveBeenCalledOnce();
  });

  test('does not treat another signal history as resend and combines resend with missing-value confirmation', async () => {
    const { prisma, service, transport } = createHarness();
    const settings = defaultCustomerEmailSettings();
    prisma.routePlan.findFirst.mockResolvedValue(routePlanRow({
      customerEmailSettings: {
        ...settings,
        senderEmail: 'sender@example.com',
        templates: {
          ...settings.templates,
          DELIVERY_SCHEDULED: {
            body: 'Hello {{customerName}}',
            enabled: true,
            subject: 'Subject',
            version: 1,
          },
        },
      },
      stops: [stopRow({
        email: 'customer@example.com',
        id: 'stop-1',
        recipientName: null,
        sequence: 1,
        status: 'PENDING',
      })],
    }));
    prisma.customerEmailManualDispatchRecipient.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValue([{
        createdAt: new Date('2026-08-05T12:00:00.000Z'),
        deliveryStopId: 'stop-1',
        sentAt: new Date('2026-08-05T12:00:01.000Z'),
        status: 'SENT',
      }]);
    prisma.customerEmailManualDispatch.create.mockResolvedValue({ id: 'dispatch-id' });
    transport.send.mockResolvedValue({ provider: 'brevo', providerMessageId: 'message-id' });

    await expect(service.send({
      actor: 'admin-user',
      commandId: 'other-signal-command',
      confirmed: true,
      missingValuesConfirmed: true,
      routePlanId: 'route-id',
      shopDomain: 'example.myshopify.com',
      signal: 'DELIVERY_SCHEDULED',
    })).resolves.toMatchObject({ counts: { sent: 1 } });
    expect(prisma.customerEmailManualDispatchRecipient.findMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: expect.objectContaining({ dispatch: { signal: 'DELIVERY_SCHEDULED' } }) as unknown,
    }));

    await expect(service.send({
      actor: 'admin-user',
      commandId: 'missing-confirm-only',
      confirmed: true,
      missingValuesConfirmed: true,
      routePlanId: 'route-id',
      shopDomain: 'example.myshopify.com',
      signal: 'DELIVERY_SCHEDULED',
    })).rejects.toMatchObject({ code: 'RESEND_CONFIRMATION_REQUIRED' });

    await expect(service.send({
      actor: 'admin-user',
      commandId: 'both-confirms',
      confirmed: true,
      missingValuesConfirmed: true,
      resendConfirmed: true,
      routePlanId: 'route-id',
      shopDomain: 'example.myshopify.com',
      signal: 'DELIVERY_SCHEDULED',
    })).resolves.toMatchObject({ counts: { sent: 1 } });
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

  test('uses Route Ops nearby threshold instead of legacy customer email compatibility for DRIVER_NEARBY only', async () => {
    const { prisma, service } = createHarness();
    prisma.routePlan.findFirst.mockResolvedValue(routePlanRow({
      customerEmailSettings: {
        ...defaultCustomerEmailSettings(),
        compatibility: { nearbyStopsThreshold: 1 },
        senderEmail: 'sender@example.com',
      },
      routeOpsUiSettings: {
        nearbyStopsThreshold: 3,
        version: 1,
      },
      stops: [
        stopRow({ id: 'stop-1', sequence: 1, status: 'EN_ROUTE' }),
        stopRow({ id: 'stop-2', sequence: 2, status: 'PENDING' }),
        stopRow({ id: 'stop-3', sequence: 3, status: 'PENDING' }),
        stopRow({ id: 'stop-4', sequence: 4, status: 'PENDING' }),
      ],
    }));

    await expect(service.preview({
      routePlanId: 'route-id',
      shopDomain: 'example.myshopify.com',
      signal: 'DRIVER_NEARBY',
    })).resolves.toMatchObject({
      recipients: [{ deliveryStopId: 'stop-4' }],
    });
    await expect(service.preview({
      routePlanId: 'route-id',
      shopDomain: 'example.myshopify.com',
      signal: 'OUT_FOR_DELIVERY',
    })).resolves.toMatchObject({
      recipients: [
        { deliveryStopId: 'stop-1' },
        { deliveryStopId: 'stop-2' },
        { deliveryStopId: 'stop-3' },
        { deliveryStopId: 'stop-4' },
      ],
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
      data: expect.objectContaining({ providerMessageId: 'message-id', providerStatus: 'ACCEPTED', status: 'SENT' }),
    }));
    expect('customerRouteNotificationFact' in prisma).toBe(false);
  });

  test('keeps a provider-confirmed manual recipient SENT when attempt settlement fails', async () => {
    const attempts = {
      settle: vi.fn(() => Promise.reject(new Error('attempt database unavailable'))),
      startManual: vi.fn(() => Promise.resolve({ attemptId: 'attempt-id', correlationId: 'correlation-id' }))
    };
    const { prisma, service, transport } = createHarness(attempts);
    prisma.routePlan.findFirst.mockResolvedValue(routePlanRow({
      stops: [stopRow({ email: 'customer@example.com', id: 'stop-1', sequence: 1, status: 'PENDING' })],
    }));
    prisma.customerEmailManualDispatch.create.mockResolvedValue({ id: 'dispatch-id' });
    prisma.customerEmailManualDispatchRecipient.findFirstOrThrow.mockResolvedValue({ id: 'recipient-id' });
    transport.send.mockResolvedValue({ provider: 'brevo', providerMessageId: 'message-id' });

    await expect(service.send({
      actor: 'admin-user',
      commandId: 'command-settle-gap',
      confirmed: true,
      routePlanId: 'route-id',
      shopDomain: 'example.myshopify.com',
      signal: 'DELIVERY_SCHEDULED',
    })).resolves.toMatchObject({
      counts: { duplicate: 0, failed: 0, sent: 1, skipped: 0 },
      results: [{ providerMessageId: 'message-id', status: 'SENT' }],
    });
    expect(prisma.customerEmailManualDispatchRecipient.updateMany).toHaveBeenCalledOnce();
    expect(prisma.customerEmailManualDispatchRecipient.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'SENT' }) as unknown,
    }));
    expect(attempts.settle).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'SENT' }));
    expect(transport.send).toHaveBeenCalledOnce();

    prisma.customerEmailManualDispatch.create.mockRejectedValueOnce({ code: 'P2002' });
    prisma.customerEmailManualDispatch.findUnique.mockResolvedValueOnce({ id: 'dispatch-id' });
    prisma.customerEmailManualDispatch.findUniqueOrThrow.mockResolvedValueOnce({
      commandId: 'command-settle-gap',
      id: 'dispatch-id',
      recipients: [{
        deliveryStopId: 'stop-1', errorCode: null, errorMessage: null, orderId: 'order-1',
        provider: 'brevo', providerMessageId: 'message-id', recipientEmail: 'customer@example.com', status: 'SENT'
      }]
    });
    await expect(service.send({
      actor: 'admin-user', commandId: 'command-settle-gap', confirmed: true, routePlanId: 'route-id',
      shopDomain: 'example.myshopify.com', signal: 'DELIVERY_SCHEDULED'
    })).resolves.toMatchObject({ duplicate: true, results: [{ status: 'DUPLICATE' }] });
    expect(transport.send).toHaveBeenCalledOnce();
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
          note: 'Footer',
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
        note: 'Footer',
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
        businessName: 'Sender & Co',
        contactEmail: 'hello@example.com',
        footerText: 'Footer <script>alert(1)</script>',
        logoAltText: 'User controlled <Logo>',
        logoLinkUrl: 'https://example.com/email',
        logoMode: 'image',
        logoUrl: 'https://example.com/logo.png',
        note: 'Footer <script>alert(1)</script>',
        phone: '+1 555 0100',
        previewText: 'Preview <hidden>',
        showPoweredByClever: true,
        surfaceColor: '#223344',
        textColor: '#334455',
        websiteUrl: 'https://example.com',
      },
      body: 'Hello <customer>\n\nItems:\nFresh kimchi × 2\nKorean pear × 1',
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
      textContent: 'Hello <customer>\n\nItems:\nFresh kimchi × 2\nKorean pear × 1\n\n--\nSender & Co\n+1 555 0100\nhello@example.com\nhttps://example.com\nFooter <script>alert(1)</script>',
    });
    const parsedBody = JSON.parse(request.body as string) as { htmlContent: string; textContent: string };
    expect(parsedBody.htmlContent).toContain('<meta name="color-scheme" content="light dark">');
    expect(parsedBody.htmlContent).toContain('<meta name="supported-color-schemes" content="light dark">');
    expect(parsedBody.htmlContent).toMatch(/<h1[^>]*>Subject &lt;urgent&gt;<\/h1>[\s\S]*Hello &lt;customer&gt;<br \/><br \/>Items:<br \/>Fresh kimchi × 2<br \/>Korean pear × 1[\s\S]*<hr/u);
    expect(parsedBody.htmlContent).toContain('overflow-wrap:anywhere');
    expect(parsedBody.htmlContent).not.toContain('white-space:pre-wrap');
    expect(parsedBody.htmlContent).toContain('Footer &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(parsedBody.htmlContent).toContain('+1 555 0100');
    expect(parsedBody.htmlContent).toContain('mailto:hello@example.com');
    expect(parsedBody.htmlContent).toContain('alt="Sender &amp; Co Team"');
    expect(parsedBody.htmlContent).toContain('<td valign="top" width="160" style="padding:0 16px 0 0;width:160px">');
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
    expect(parsedBody.textContent).toBe('Hello <customer>\n\nItems:\nFresh kimchi × 2\nKorean pear × 1\n\n--\nSender & Co\n+1 555 0100\nhello@example.com\nhttps://example.com\nFooter <script>alert(1)</script>');
    expect(request.signal).toBeDefined();
  });

  test('omits the boxed footer when footer fields and logo are empty even with a sender name', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ messageId: 'brevo-id' }), { status: 201 }));
    const transport = new BrevoCustomerEmailTransport({ apiKey: 'secret', fetchImpl });

    await transport.send({
      branding: {
        ...defaultCustomerEmailSettings().branding,
        businessName: '',
      },
      body: 'Body',
      commandId: 'command-2',
      recipientEmail: 'customer@example.com',
      replyTo: null,
      senderEmail: 'sender@example.com',
      senderName: 'Sender Name',
      signal: 'TEST',
      subject: 'Subject',
      tags: ['customer-delivery-email', 'test'],
    });

    const [, request] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const parsedBody = JSON.parse(request.body as string) as { htmlContent: string; textContent: string };
    expect(parsedBody.htmlContent).not.toContain('border:1px solid #d0d7de;border-radius:8px;padding:18px');
    expect(parsedBody.htmlContent).not.toContain('Sender Name');
    expect(parsedBody.textContent).toBe('Body');
  });
});

function createHarness(attempts?: {
  settle(input: unknown): Promise<void>;
  startManual(input: unknown): Promise<{ attemptId: string; correlationId: string }>;
}) {
  const prisma = {
    customerEmailManualDispatch: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
    },
    customerEmailManualDispatchRecipient: {
      findFirstOrThrow: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn(),
    },
    routePlan: {
      findFirst: vi.fn(),
    },
    shop: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  };
  const transport = {
    configured: true,
    providerName: 'brevo',
    send: vi.fn(),
  };
  return {
    prisma,
    service: new CustomerEmailService(prisma as never, transport, attempts as never),
    transport,
  };
}

function routePlanRow(input: { customerEmailSettings?: unknown; routeOpsUiSettings?: unknown; stops: ReturnType<typeof stopRow>[] }) {
  return {
    id: 'route-id',
    name: 'Route A',
    planDate: new Date('2026-08-03T00:00:00.000Z'),
    routeStops: input.stops,
    shop: {
      customerEmailSettings: input.customerEmailSettings ?? {
        ...defaultCustomerEmailSettings(),
        senderEmail: 'sender@example.com',
      },
      id: 'shop-id',
      routeOpsUiSettings: input.routeOpsUiSettings ?? null,
      shopDomain: 'example.myshopify.com',
    },
  };
}

function stopRow(input: {
  deliveryWeekday?: string | null;
  email?: string | null;
  estimatedArrivalAt?: Date | null;
  id: string;
  items?: Array<{ lineIndex: number; name: string; options: unknown; quantity: number }>;
  recipientName?: string | null;
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
        deliveryFacts: [{ deliveryWeekday: input.deliveryWeekday ?? null }],
        email: input.email === undefined ? `${input.id}@example.com` : input.email,
        id: `order-${input.sequence}`,
        name: `Order #${input.sequence}`,
        orderItems: input.items ?? [],
      },
      orderId: `order-${input.sequence}`,
      postalCode: 'M1M 1M1',
      province: 'ON',
      recipientName: input.recipientName === undefined ? 'Jane Customer' : input.recipientName,
      status: input.status,
    },
    estimatedArrivalAt: input.estimatedArrivalAt === undefined ? new Date('2026-08-04T10:00:00.000Z') : input.estimatedArrivalAt,
    sequence: input.sequence,
  };
}
