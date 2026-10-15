import type { Prisma } from '@prisma/client';

import { isRouteEmailSelected, ROUTE_EMAIL_SELECTED_KEY } from './customer-email-route-selection.js';
import { isEmail, normalizeCustomerEmailSettings, type CustomerEmailSignal } from './customer-email-settings.js';
import { normalizeRouteOpsUiSettings } from '../route-ops/route-ops-ui-settings.js';

type AutomaticFactClient = Pick<Prisma.TransactionClient, 'customerRouteNotificationFact' | 'routePlan' | 'shop'>;

export type AutomaticCustomerEmailDriverEvent = {
  deliveryStopId: string | null;
  driverEventId: string;
  eventType: string;
  occurredAt: Date;
  routePlanId: string | null;
  shopId: string;
};

type RouteStop = {
  deliveryStop: {
    id: string;
    order: { email: string | null; id: string };
    status: string;
  };
  sequence: number;
};

const directSignalByEventType: Readonly<Record<string, CustomerEmailSignal | undefined>> = {
  ROUTE_STARTED: 'OUT_FOR_DELIVERY',
  STOP_DELIVERED: 'DELIVERED',
  STOP_FAILED: 'MISSED_DELIVERY'
};
const nearbyProgressEventTypes = new Set(['ROUTE_STARTED', 'STOP_ARRIVED', 'STOP_DELIVERED', 'STOP_FAILED']);
const terminalStopStatuses = new Set(['CANCELLED', 'DELIVERED', 'FAILED', 'SKIPPED']);
const outForDeliveryStatuses = new Set(['ARRIVED', 'ASSIGNED', 'EN_ROUTE', 'PENDING']);
const nearbyPendingStatuses = new Set(['ASSIGNED', 'EN_ROUTE', 'PENDING']);

export async function persistAutomaticCustomerEmailFacts(
  prisma: AutomaticFactClient,
  input: AutomaticCustomerEmailDriverEvent,
  options: { nearbyOnly?: boolean } = {}
): Promise<number> {
  if (input.routePlanId === null) return 0;
  const directSignal = directSignalByEventType[input.eventType];
  if (directSignal === undefined && !nearbyProgressEventTypes.has(input.eventType)) return 0;

  const shop = await prisma.shop.findUnique({
    select: { customerEmailSettings: true, routeOpsUiSettings: true },
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

  const routePlan = await prisma.routePlan.findFirst({
    select: {
      constraints: true,
      driverEvents: { select: { id: true }, take: 1, where: { eventType: 'ROUTE_STARTED' } },
      routeStops: {
        orderBy: { sequence: 'asc' },
        select: {
          deliveryStop: {
            select: {
              id: true,
              order: { select: { email: true, id: true } },
              status: true
            }
          },
          sequence: true
        }
      }
    },
    where: { id: input.routePlanId, shopId: input.shopId }
  });
  if (routePlan === null) return 0;

  const routeStops = routePlan.routeStops as RouteStop[];
  const targets: Array<{ idempotencyKey: string; signal: CustomerEmailSignal; stop: RouteStop }> = [];
  if (options.nearbyOnly !== true && directSignal !== undefined && directSignal !== 'DELIVERY_SCHEDULED') {
    const directStops = directSignal === 'OUT_FOR_DELIVERY'
      ? routeStops.filter((stop) => outForDeliveryStatuses.has(stop.deliveryStop.status))
      : routeStops.filter((stop) => stop.deliveryStop.id === input.deliveryStopId);
    for (const stop of directStops) {
      targets.push({
        idempotencyKey: `driver-event:${input.driverEventId}:${directSignal}:${stop.deliveryStop.id}`,
        signal: directSignal,
        stop
      });
    }
  }

  // Route start already sends Out for delivery to every stop, so the first stops get no Nearby at that moment.
  const routeStarted = input.eventType === 'ROUTE_STARTED' || routePlan.driverEvents.length > 0;
  if (routeStarted && nearbyProgressEventTypes.has(input.eventType) && input.eventType !== 'ROUTE_STARTED') {
    const threshold = normalizeRouteOpsUiSettings(shop.routeOpsUiSettings).nearbyStopsThreshold;
    const progressSequence = routeStops.find((stop) => stop.deliveryStop.id === input.deliveryStopId)?.sequence;
    const remaining = progressSequence === undefined ? [] : routeStops.filter((stop) =>
      stop.sequence > progressSequence
      && !terminalStopStatuses.has(stop.deliveryStop.status)
      && nearbyPendingStatuses.has(stop.deliveryStop.status)
    );
    const nearbyStops = threshold > 0 ? remaining.slice(0, threshold) : [];
    for (const nearbyStop of nearbyStops) {
      targets.push({
        idempotencyKey: `route-progress:${input.routePlanId}:DRIVER_NEARBY:${nearbyStop.deliveryStop.id}`,
        signal: 'DRIVER_NEARBY',
        stop: nearbyStop
      });
    }
  }

  const selectedTargets = targets.filter(({ signal, stop }) =>
    signal !== 'DELIVERY_SCHEDULED'
    && isRouteEmailSelected(routePlan.constraints, signal, stop.deliveryStop.id)
  );
  if (selectedTargets.length === 0) return 0;

  const rows = selectedTargets.map(({ idempotencyKey, signal, stop }) => {
    const template = settings.templates[signal];
    const recipientEmail = stop.deliveryStop.order.email?.trim().toLowerCase() ?? '';
    const errorCode = !template.enabled
      ? 'CUSTOMER_EMAIL_TEMPLATE_DISABLED'
      : !isEmail(recipientEmail)
        ? 'CUSTOMER_EMAIL_MISSING'
        : settings.senderEmail.trim() === ''
          ? 'CUSTOMER_EMAIL_SENDER_MISSING'
          : null;
    return {
      deliveryStopId: stop.deliveryStop.id,
      errorCode,
      errorMessage: errorCode === null ? null : automaticSkipMessage(errorCode),
      idempotencyKey,
      metadata: {
        driverEventId: input.driverEventId,
        [ROUTE_EMAIL_SELECTED_KEY]: true,
        signal,
        sourceEventType: input.eventType,
        templateVersion: template.version
      },
      nextAttemptAt: errorCode === null ? input.occurredAt : null,
      occurredAt: input.occurredAt,
      orderId: stop.deliveryStop.order.id,
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
