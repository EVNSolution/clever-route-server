import { afterEach, describe, expect, test, vi } from 'vitest';

import { PrismaCustomerEmailAutomaticSender } from '../src/modules/customer-email/customer-email-automatic.sender.js';
import { CustomerEmailService } from '../src/modules/customer-email/customer-email.service.js';

afterEach(() => vi.restoreAllMocks());

describe('PrismaCustomerEmailAutomaticSender', () => {
  test('renders the durable signal through the canonical customer email service', async () => {
    const sendAutomatic = vi.spyOn(CustomerEmailService.prototype, 'sendAutomatic').mockResolvedValue({
      provider: 'brevo', providerMessageId: 'provider-id', status: 'SENT'
    });
    const sender = new PrismaCustomerEmailAutomaticSender({} as never, {
      configured: true, providerName: 'brevo', send: vi.fn()
    });

    await expect(sender.send({
      appId: 'clever-kfood', deliveryStopId: 'stop-id', idempotencyKey: 'fact-key', orderId: 'order-id',
      recipientEmail: 'customer@example.test', routePlanId: 'route-id', shopDomain: 'shop.example',
      signal: 'MISSED_DELIVERY', status: 'COMPLETED'
    })).resolves.toEqual({ provider: 'brevo', providerMessageId: 'provider-id', status: 'SENT' });

    expect(sendAutomatic).toHaveBeenCalledWith(expect.objectContaining({
      appId: 'clever-kfood', deliveryStopIds: ['stop-id'], idempotencyKey: 'fact-key', signal: 'MISSED_DELIVERY'
    }));
  });

  test('fails closed when a legacy customer memo has no configured sender', async () => {
    const sender = new PrismaCustomerEmailAutomaticSender({} as never, {
      configured: true, providerName: 'brevo', send: vi.fn()
    });
    await expect(sender.send({
      appId: 'clever-kfood', body: 'memo', idempotencyKey: 'memo-key', kind: 'CUSTOMER_MESSAGE', orderId: 'order-id',
      orderMessageId: 'message-id', recipientEmail: 'customer@example.test', shopDomain: 'shop.example'
    })).resolves.toMatchObject({ errorCode: 'CUSTOMER_MESSAGE_SENDER_NOT_CONFIGURED', retryable: false, status: 'FAILED' });
  });
});
