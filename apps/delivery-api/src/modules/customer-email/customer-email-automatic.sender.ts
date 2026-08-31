import type { PrismaClient } from '@prisma/client';

import { CustomerEmailService } from './customer-email.service.js';
import type { CustomerEmailSignal } from './customer-email-settings.js';
import type { CustomerEmailTransport } from './customer-email-transport.js';
import type {
  CustomerDeliveryNotificationMessage,
  CustomerDeliveryNotificationSender,
  CustomerDeliveryNotificationSendResult
} from '../route-plans/customer-delivery-notification.sender.js';

export class PrismaCustomerEmailAutomaticSender implements CustomerDeliveryNotificationSender {
  readonly providerName: string;
  private readonly service: CustomerEmailService;

  constructor(
    prisma: PrismaClient,
    transport: CustomerEmailTransport,
    private readonly legacySender?: CustomerDeliveryNotificationSender
  ) {
    this.providerName = transport.providerName;
    this.service = new CustomerEmailService(prisma, transport);
  }

  async send(message: CustomerDeliveryNotificationMessage): Promise<CustomerDeliveryNotificationSendResult> {
    if ('kind' in message) {
      if (this.legacySender !== undefined) return this.legacySender.send(message);
      return {
        errorCode: 'CUSTOMER_MESSAGE_SENDER_NOT_CONFIGURED',
        errorMessage: 'Customer memo sender is not configured.',
        provider: this.providerName,
        retryable: false,
        status: 'FAILED'
      };
    }
    const result = await this.service.sendAutomatic({
      appId: message.appId,
      deliveryStopIds: [message.deliveryStopId],
      idempotencyKey: message.idempotencyKey,
      recipientEmail: message.recipientEmail,
      routePlanId: message.routePlanId,
      shopDomain: message.shopDomain,
      signal: message.signal ?? signalForLegacyStatus(message.status)
    });
    return result.status === 'SENT'
      ? {
          provider: result.provider,
          providerMessageId: result.providerMessageId,
          status: 'SENT'
        }
      : {
          errorCode: result.errorCode,
          errorMessage: result.errorMessage,
          provider: this.providerName,
          retryable: false,
          status: 'FAILED'
        };
  }
}

function signalForLegacyStatus(status: 'COMPLETED' | 'IN_PROGRESS' | 'READY'): CustomerEmailSignal {
  if (status === 'READY') return 'DELIVERY_SCHEDULED';
  if (status === 'IN_PROGRESS') return 'OUT_FOR_DELIVERY';
  return 'DELIVERED';
}
