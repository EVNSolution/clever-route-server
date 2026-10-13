import { customerEmailSignals, type CustomerEmailSignal } from './customer-email-settings.js';

// The office chooses at Dispatch which customers get which customer emails on one route.
// Automatic facts carry ROUTE_EMAIL_SELECTED_KEY in metadata; the outbox sends only those, so facts
// queued before a selection existed (or for stops nobody selected) never reach a customer.
export const ROUTE_EMAIL_SELECTION_KEY = 'customerEmailSelection';
export const ROUTE_EMAIL_SELECTED_KEY = 'routeEmailSelected';

export type RouteEmailSelection = {
  deliveryStopIds: string[];
  signals: CustomerEmailSignal[];
  updatedAt: string;
  updatedBy: string;
};

export function readRouteEmailSelection(constraints: unknown): RouteEmailSelection | null {
  const value = object(object(constraints)?.[ROUTE_EMAIL_SELECTION_KEY]);
  if (value === null || !Array.isArray(value.signals) || !Array.isArray(value.deliveryStopIds)) return null;
  return {
    deliveryStopIds: value.deliveryStopIds.filter((id): id is string => typeof id === 'string'),
    signals: value.signals.filter(isSignal),
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
    updatedBy: typeof value.updatedBy === 'string' ? value.updatedBy : ''
  };
}

export function isRouteEmailSelected(constraints: unknown, signal: CustomerEmailSignal, deliveryStopId: string): boolean {
  const selection = readRouteEmailSelection(constraints);
  return selection !== null && selection.signals.includes(signal) && selection.deliveryStopIds.includes(deliveryStopId);
}

export function parseRouteEmailSelectionPayload(body: unknown): { deliveryStopIds: string[]; signals: CustomerEmailSignal[] } | null {
  const value = object(body);
  if (value === null || !Array.isArray(value.signals) || !Array.isArray(value.deliveryStopIds)) return null;
  if (!value.signals.every(isSignal) || !value.deliveryStopIds.every((id) => typeof id === 'string' && id !== '')) return null;
  if (value.signals.length > customerEmailSignals.length || value.deliveryStopIds.length > 1_000) return null;
  return { deliveryStopIds: [...new Set(value.deliveryStopIds as string[])], signals: [...new Set(value.signals)] };
}

function isSignal(value: unknown): value is CustomerEmailSignal {
  return typeof value === 'string' && (customerEmailSignals as readonly string[]).includes(value);
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
