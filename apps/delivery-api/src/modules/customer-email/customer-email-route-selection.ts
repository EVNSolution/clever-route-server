import { customerEmailSignals, type CustomerEmailSignal } from './customer-email-settings.js';

// The office chooses at Dispatch which customers get which customer emails on one route.
// Automatic facts carry ROUTE_EMAIL_SELECTED_KEY in metadata; the outbox sends only those, so facts
// queued before a selection existed (or for stops nobody selected) never reach a customer.
export const ROUTE_EMAIL_SELECTION_KEY = 'customerEmailSelection';
export const ROUTE_EMAIL_SELECTED_KEY = 'routeEmailSelected';
export const routeEmailSelectionModes = ['EXPLICIT', 'ALL_ELIGIBLE'] as const;
export type RouteEmailSelectionMode = (typeof routeEmailSelectionModes)[number];

export type RouteEmailSelection = {
  deliveryStopIds: string[];
  mode: RouteEmailSelectionMode;
  signals: CustomerEmailSignal[];
  updatedAt: string;
  updatedBy: string;
};

export function readRouteEmailSelection(constraints: unknown): RouteEmailSelection | null {
  const value = object(object(constraints)?.[ROUTE_EMAIL_SELECTION_KEY]);
  if (value === null || !Array.isArray(value.signals) || !Array.isArray(value.deliveryStopIds)) return null;
  return {
    deliveryStopIds: value.deliveryStopIds.filter((id): id is string => typeof id === 'string'),
    mode: isMode(value.mode) ? value.mode : 'EXPLICIT',
    signals: value.signals.filter(isSignal),
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
    updatedBy: typeof value.updatedBy === 'string' ? value.updatedBy : ''
  };
}

export function isRouteEmailSelected(constraints: unknown, signal: CustomerEmailSignal, deliveryStopId: string): boolean {
  const selection = readRouteEmailSelection(constraints);
  return selection !== null
    && selection.signals.includes(signal)
    && (selection.mode === 'ALL_ELIGIBLE' || selection.deliveryStopIds.includes(deliveryStopId));
}

export function parseRouteEmailSelectionPayload(body: unknown): {
  deliveryStopIds: string[];
  mode: RouteEmailSelectionMode;
  signals: CustomerEmailSignal[];
} | null {
  const value = object(body);
  if (value === null || !Array.isArray(value.signals) || !Array.isArray(value.deliveryStopIds)) return null;
  const mode = value.mode === undefined ? 'EXPLICIT' : value.mode;
  if (!isMode(mode)) return null;
  if (!value.signals.every(isSignal) || !value.deliveryStopIds.every((id) => typeof id === 'string' && id !== '')) return null;
  if (value.signals.length > customerEmailSignals.length || value.deliveryStopIds.length > 1_000) return null;
  return { deliveryStopIds: [...new Set(value.deliveryStopIds as string[])], mode, signals: [...new Set(value.signals)] };
}

function isMode(value: unknown): value is RouteEmailSelectionMode {
  return typeof value === 'string' && (routeEmailSelectionModes as readonly string[]).includes(value);
}

function isSignal(value: unknown): value is CustomerEmailSignal {
  return typeof value === 'string' && (customerEmailSignals as readonly string[]).includes(value);
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
