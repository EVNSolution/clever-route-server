import tzLookup from '@photostructure/tz-lookup';

import { isIanaTimezone } from '../driver/driver-route-timezone.js';

/** IANA timezone of the tenant center, derived from its coordinates. Null when there are no usable coordinates. */
export function centerTimezoneFromCoordinates(
  latitude: number | null,
  longitude: number | null
): string | null {
  if (latitude === null || longitude === null) return null;
  try {
    return tzLookup(latitude, longitude);
  } catch {
    return null;
  }
}

/**
 * The one place that decides which timezone a route belongs to.
 * The tenant (shop) center timezone, saved with the center settings, wins. The route and connection values
 * are legacy fallbacks for tenants whose center has not been saved yet. Null means unknown: callers choose
 * their own safe behaviour and must not invent a city.
 */
export function resolveRouteTimezone(input: {
  centerTimezone?: string | null | undefined;
  commerceConnections?: ReadonlyArray<{ timezone: string | null }> | undefined;
  constraints?: unknown;
}): string | null {
  const constraints = objectOrNull(input.constraints);
  const routeScope = objectOrNull(constraints?.routeScope);
  const own = [
    input.centerTimezone,
    stringOrNull(constraints?.timezone),
    stringOrNull(routeScope?.timezone),
    stringOrNull(constraints?.scheduledStartTimeZone)
  ].map((value) => value?.trim() ?? '').find((value) => value !== '' && isIanaTimezone(value));
  if (own !== undefined) return own;

  const connectionTimezones = [...new Set((input.commerceConnections ?? [])
    .map((connection) => connection.timezone?.trim() ?? '')
    .filter((value) => value !== '' && isIanaTimezone(value)))];
  return connectionTimezones.length === 1 ? connectionTimezones[0] ?? null : null;
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
