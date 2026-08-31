import type { Prisma } from '@prisma/client';

import { isEmail, normalizeCustomerEmailSettings, type CustomerEmailSignal } from './customer-email-settings.js';

type AutomaticFactClient = Pick<Prisma.TransactionClient, 'customerRouteNotificationFact' | 'deliveryStop' | 'shop'>;

export type AutomaticCustomerEmailDriverEvent = {
  deliveryStopId: string | null;
  driverEventId: string;
  eventType: string;
  occurredAt: Date;
  routePlanId: string | null;
  shopId: string;
};

const signalByEventType: Readonly<Record<string, CustomerEmailSignal | undefined>> = {
  ROUTE_STARTED: 'OUT_FOR_DELIVERY',
  STOP_ARRIVED: 'DRIVER_NEARBY',
  STOP_DELIVERED: 'DELIVERED',
  STOP_FAILED: 'MISSED_DELIVERY'
};

export async function persistAutomaticCustomerEmailFacts(
  prisma: AutomaticFactClient,
  input: AutomaticCustomerEmailDriverEvent
): Promise<number> {
  const signal = signalByEventType[input.eventType];
  if (signal === undefined || input.routePlanId === null) return 0;

  const shop = await prisma.shop.findUnique({
    select: { customerEmailSettings: true },
    where: { id: input.shopId }
  });
  if (shop === null) return 0;

  let settings;
  try {
    settings = normalizeCustomerEmailSettings(shop.customerEmailSettings);
  } catch {
    return 0;
  }
  if (!settings.automatic.enabled) return 0;

  const stops = await prisma.deliveryStop.findMany({
    orderBy: { id: 'asc' },
    select: {
      id: true,
      order: { select: { email: true, id: true } }
    },
    where: {
      ...(input.deliveryStopId === null ? {} : { id: input.deliveryStopId }),
      routePlanStops: { some: { routePlanId: input.routePlanId } },
      shopId: input.shopId
    }
  });
  if (stops.length === 0) return 0;

  const template = settings.templates[signal];
  const rows = stops.map((stop) => {
    const recipientEmail = stop.order.email?.trim().toLowerCase() ?? '';
    const errorCode = !template.enabled
      ? 'CUSTOMER_EMAIL_TEMPLATE_DISABLED'
      : !isEmail(recipientEmail)
        ? 'CUSTOMER_EMAIL_MISSING'
        : settings.senderEmail.trim() === ''
          ? 'CUSTOMER_EMAIL_SENDER_MISSING'
          : null;
    return {
      deliveryStopId: stop.id,
      errorCode,
      errorMessage: errorCode === null ? null : automaticSkipMessage(errorCode),
      idempotencyKey: `driver-event:${input.driverEventId}:${signal}:${stop.id}`,
      metadata: {
        driverEventId: input.driverEventId,
        signal,
        sourceEventType: input.eventType,
        templateVersion: template.version
      },
      nextAttemptAt: errorCode === null ? input.occurredAt : null,
      occurredAt: input.occurredAt,
      orderId: stop.order.id,
      recipientEmailSnapshot: errorCode === null ? recipientEmail : null,
      requestedUiStatus: requestedUiStatus(signal),
      routePlanId: input.routePlanId,
      shopId: input.shopId,
      source: 'DRIVER_EVENT',
      status: errorCode === null ? 'QUEUED' as const : 'SKIPPED' as const
    };
  });
  const result = await prisma.customerRouteNotificationFact.createMany({ data: rows, skipDuplicates: true });
  return result.count;
}

function requestedUiStatus(signal: CustomerEmailSignal): 'COMPLETED' | 'IN_PROGRESS' | 'READY' {
  if (signal === 'DELIVERY_SCHEDULED') return 'READY';
  if (signal === 'OUT_FOR_DELIVERY' || signal === 'DRIVER_NEARBY') return 'IN_PROGRESS';
  return 'COMPLETED';
}

function automaticSkipMessage(errorCode: string): string {
  if (errorCode === 'CUSTOMER_EMAIL_TEMPLATE_DISABLED') return 'Automatic customer email template is disabled.';
  if (errorCode === 'CUSTOMER_EMAIL_SENDER_MISSING') return 'Automatic customer email sender is not configured.';
  return 'Canonical order email is missing or invalid.';
}
