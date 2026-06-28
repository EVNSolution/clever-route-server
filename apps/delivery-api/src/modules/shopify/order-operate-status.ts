import type { CanonicalOrderRow } from './order-sync.mapper.js';

export const OPERATE_DELIVERY_STATUSES = ['preparing', 'ready', 'in_progress', 'completed'] as const;
export type OperateDeliveryStatus = (typeof OPERATE_DELIVERY_STATUSES)[number];

export const ORDER_HEALTH_FILTERS = ['normal', 'needs_review'] as const;
export type OrderHealth = (typeof ORDER_HEALTH_FILTERS)[number];

export function isOperateDeliveryStatus(value: string): value is OperateDeliveryStatus {
  return (OPERATE_DELIVERY_STATUSES as readonly string[]).includes(value);
}

export function isOrderHealth(value: string): value is OrderHealth {
  return (ORDER_HEALTH_FILTERS as readonly string[]).includes(value);
}

export function deriveOrderHealth(row: CanonicalOrderRow): OrderHealth {
  if (row.cancelledAt !== null || row.readiness !== 'READY_TO_PLAN' || row.reviewReasons.length > 0) {
    return 'needs_review';
  }
  return 'normal';
}

export function deriveOperateDeliveryStatus(row: CanonicalOrderRow): OperateDeliveryStatus {
  if (row.deliveryStopStatus === 'DELIVERED') {
    return 'completed';
  }

  if (hasPreparationBlocker(row)) {
    return 'preparing';
  }

  if (hasActiveRouteState(row)) {
    return 'in_progress';
  }

  if (row.readiness === 'READY_TO_PLAN' && row.planningStatus === 'UNPLANNED') {
    return 'ready';
  }

  return 'preparing';
}

function hasActiveRouteState(row: CanonicalOrderRow): boolean {
  return row.deliveryStopStatus === 'ASSIGNED' || row.deliveryStopStatus === 'EN_ROUTE' || row.deliveryStopStatus === 'ARRIVED';
}

function hasPreparationBlocker(row: CanonicalOrderRow): boolean {
  if (deriveOrderHealth(row) === 'needs_review') return true;
  if (row.deliveryDate === null || row.deliveryArea === null || row.routeScopeKey === null) return true;
  if (row.geocodeStatus === 'FAILED' || row.geocodeStatus === 'PENDING') return true;
  if (row.serviceType !== 'PICKUP' && !row.hasCoordinates) return true;
  return false;
}
