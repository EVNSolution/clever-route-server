import { createHash } from 'node:crypto';

import type { CreateAdminNotificationInput } from './admin-notification.repository.js';
import {
  DRIVER_STOP_SKIPPED_ASSIGNMENT_ERROR_NOTIFICATION,
  DRIVER_STOP_SEQUENCE_DEVIATED_NOTIFICATION,
  WOO_ASSIGNED_ROUTE_ADDRESS_CHANGED_NOTIFICATION,
} from './admin-notification.repository.js';
import {
  addressFingerprint,
  addressFingerprintPayload,
  type DeliveryStopAddressFields,
} from '../shopify/order-address-fingerprint.js';

type AssignedRouteAddressChangeStop = DeliveryStopAddressFields & {
  routePlanStops?: Array<{
    routePlan?: {
      id: string;
      name: string;
      status: string;
    } | null;
  }>;
};

export type AssignedRouteAddressChangedEvent = {
  existingStop: AssignedRouteAddressChangeStop | null;
  incomingStop: DeliveryStopAddressFields;
  orderId: string;
  orderName: string;
  shopId: string;
  type: 'woo.assigned_route_address_changed';
};

type DriverStopSequenceDeviatedEvent = {
  createdAt: Date;
  driverId: string;
  eventId: string;
  eventType: string;
  expectedDeliveryStopId: string;
  expectedSequence: number;
  occurredAt: Date;
  routePlanId: string;
  selectedDeliveryStopId: string;
  selectedSequence: number;
  shopId: string;
  type: 'driver.stop_sequence_deviated';
};

type DriverStopSkippedAssignmentErrorEvent = {
  createdAt: Date;
  deliveryStopId: string;
  driverId: string;
  eventId: string;
  occurredAt: Date;
  routePlanId: string;
  shopId: string;
  type: 'driver.stop_skipped_assignment_error';
};

export type AdminWebNotificationEvent =
  | AssignedRouteAddressChangedEvent
  | DriverStopSkippedAssignmentErrorEvent
  | DriverStopSequenceDeviatedEvent;

export function createAdminNotificationInputsForEvent(
  event: AdminWebNotificationEvent,
): CreateAdminNotificationInput[] {
  switch (event.type) {
    case 'driver.stop_skipped_assignment_error':
      return [createDriverStopSkippedAssignmentErrorNotification(event)];
    case 'driver.stop_sequence_deviated':
      return [createDriverStopSequenceDeviationNotification(event)];
    case 'woo.assigned_route_address_changed':
      return createAssignedRouteAddressChangeNotifications(event);
  }
}

function createDriverStopSkippedAssignmentErrorNotification(
  event: DriverStopSkippedAssignmentErrorEvent,
): CreateAdminNotificationInput {
  return {
    body: 'A driver skipped a pickup order that was incorrectly included in this delivery route.',
    createdAt: event.createdAt,
    dedupeKey: `driver_stop_skipped_assignment_error:${event.routePlanId}:${event.deliveryStopId}`,
    href: `/admin/ui/app/routes/${event.routePlanId}`,
    payload: {
      deliveryStopId: event.deliveryStopId,
      driverId: event.driverId,
      eventId: event.eventId,
      occurredAt: event.occurredAt.toISOString(),
      version: 1,
    },
    routePlanId: event.routePlanId,
    severity: 'warning',
    shopId: event.shopId,
    title: 'Pickup stop skipped by driver',
    type: DRIVER_STOP_SKIPPED_ASSIGNMENT_ERROR_NOTIFICATION,
  };
}

function createDriverStopSequenceDeviationNotification(
  event: DriverStopSequenceDeviatedEvent,
): CreateAdminNotificationInput {
  return {
    body: `Stop ${event.selectedSequence} was handled before planned Stop ${event.expectedSequence}. Review the active route and updated ETAs.`,
    createdAt: event.createdAt,
    dedupeKey: `driver_stop_sequence_deviation:${event.routePlanId}:${event.selectedDeliveryStopId}`,
    href: `/admin/ui/app/routes/${event.routePlanId}`,
    payload: {
      driverId: event.driverId,
      eventId: event.eventId,
      eventType: event.eventType,
      expectedDeliveryStopId: event.expectedDeliveryStopId,
      expectedSequence: event.expectedSequence,
      occurredAt: event.occurredAt.toISOString(),
      selectedDeliveryStopId: event.selectedDeliveryStopId,
      selectedSequence: event.selectedSequence,
      version: 1,
    },
    routePlanId: event.routePlanId,
    severity: 'warning',
    shopId: event.shopId,
    title: 'Driver changed the planned stop order',
    type: DRIVER_STOP_SEQUENCE_DEVIATED_NOTIFICATION,
  };
}

function createAssignedRouteAddressChangeNotifications(
  event: AssignedRouteAddressChangedEvent,
): CreateAdminNotificationInput[] {
  const existingStop = event.existingStop;
  if (existingStop === null) return [];
  const routePlanStops = (existingStop.routePlanStops ?? []).filter(
    (routePlanStop): routePlanStop is {
      routePlan: { id: string; name: string; status: string };
    } =>
      routePlanStop.routePlan !== null && routePlanStop.routePlan !== undefined,
  );
  if (routePlanStops.length === 0) return [];

  const beforeFingerprint = addressFingerprint(existingStop);
  const afterFingerprint = addressFingerprint(event.incomingStop);
  if (
    beforeFingerprint === null ||
    afterFingerprint === null ||
    beforeFingerprint === afterFingerprint
  ) {
    return [];
  }

  const afterAddressHash = createHash('sha256')
    .update(afterFingerprint)
    .digest('hex')
    .slice(0, 32);
  const beforeAddress = addressFingerprintPayload(existingStop);
  const afterAddress = addressFingerprintPayload(event.incomingStop);

  return routePlanStops.map((routePlanStop) => {
    const routePlan = routePlanStop.routePlan;
    const dedupeKey = [
      'woo_address_changed_route_assigned',
      event.shopId,
      event.orderId,
      routePlan.id,
      afterAddressHash,
    ].join(':');
    return {
      body: `${event.orderName} address changed in WooCommerce after it was assigned to ${routePlan.name}. Review the route before dispatch.`,
      dedupeKey,
      href: `/admin/ui/app/routes/${routePlan.id}`,
      orderId: event.orderId,
      payload: {
        afterAddress,
        afterAddressHash,
        beforeAddress,
        orderName: event.orderName,
        routePlanName: routePlan.name,
        routePlanStatus: routePlan.status,
        version: 1,
      },
      routePlanId: routePlan.id,
      severity: 'critical',
      shopId: event.shopId,
      title: 'Route assigned order address changed',
      type: WOO_ASSIGNED_ROUTE_ADDRESS_CHANGED_NOTIFICATION,
    };
  });
}
