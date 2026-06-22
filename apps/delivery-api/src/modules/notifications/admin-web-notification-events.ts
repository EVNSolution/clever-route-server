import { createHash } from 'node:crypto';

import type { CreateAdminNotificationInput } from './admin-notification.repository.js';
import { WOO_ASSIGNED_ROUTE_ADDRESS_CHANGED_NOTIFICATION } from './admin-notification.repository.js';
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

export type AdminWebNotificationEvent = {
  existingStop: AssignedRouteAddressChangeStop | null;
  incomingStop: DeliveryStopAddressFields;
  orderId: string;
  orderName: string;
  shopId: string;
  type: 'woo.assigned_route_address_changed';
};

export function createAdminNotificationInputsForEvent(
  event: AdminWebNotificationEvent,
): CreateAdminNotificationInput[] {
  switch (event.type) {
    case 'woo.assigned_route_address_changed':
      return createAssignedRouteAddressChangeNotifications(event);
  }
}

function createAssignedRouteAddressChangeNotifications(
  event: AdminWebNotificationEvent,
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
