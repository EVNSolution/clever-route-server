import type { GeocodingResult } from './geocoding.types.js';

export type GeocodeDiagnosticSource =
  | 'bulk_geocode'
  | 'server_pre_persist'
  | 'single_order_geocode';

export function summarizeGeocodeDiagnostic(
  geocode: GeocodingResult,
  source: GeocodeDiagnosticSource,
): Record<string, unknown> {
  const attemptedAt = new Date().toISOString();
  if (!geocode.ok) {
    return compactDiagnostic({
      attemptCount: geocode.attemptCount ?? 0,
      attemptedAt,
      code: geocode.code,
      messageKey: geocode.code,
      ok: false,
      queryShapes: geocode.queryShapes ?? [],
      source,
      transient: geocode.transient === true,
    });
  }
  return compactDiagnostic({
    attemptCount: geocode.attemptCount ?? 0,
    attemptedAt,
    cached: geocode.cached,
    code: 'RESOLVED',
    ok: true,
    provider: geocode.result.provider,
    providerPlaceId: geocode.result.providerPlaceId,
    queryShapes: geocode.queryShapes ?? [],
    source,
  });
}

function compactDiagnostic(input: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    next[key] = value;
  }
  return next;
}
