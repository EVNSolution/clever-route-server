import tzLookup from '@photostructure/tz-lookup';

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
