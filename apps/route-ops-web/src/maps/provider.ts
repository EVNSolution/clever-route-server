import type { BootstrapPayload, MapProviderMode, MapProviderStatus } from '../types';

export type MapReadiness = 'interactive_map' | 'no_coordinates' | 'provider_not_configured';

export function mapReadiness(input: { coordinatesCount: number; mapStatus: MapProviderStatus }): MapReadiness {
  if (input.coordinatesCount === 0) return 'no_coordinates';
  if (input.mapStatus === 'not_configured') return 'provider_not_configured';
  return 'interactive_map';
}

export function providerModeLabel(mode: MapProviderMode): string {
  if (mode === 'self_hosted') return 'Self-hosted map';
  if (mode === 'public_allowlisted') return 'Public map provider allowlisted';
  return 'Map provider not configured';
}

export function providerStatusLabel(mapConfig: BootstrapPayload['mapConfig']): string {
  if (mapConfig.status === 'not_configured') return mapConfig.disabledReason ?? 'not_configured';
  return providerModeLabel(mapConfig.providerMode);
}

export function extractStyleEndpointUrls(manifest: unknown): string[] {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) return [];
  const record = manifest as Record<string, unknown>;
  const endpoints: string[] = [];
  collectStringEndpoint(record.sprite, endpoints);
  collectStringEndpoint(record.glyphs, endpoints);
  const sources = record.sources;
  if (sources !== null && typeof sources === 'object' && !Array.isArray(sources)) {
    for (const source of Object.values(sources as Record<string, unknown>)) {
      if (source === null || typeof source !== 'object' || Array.isArray(source)) continue;
      const sourceRecord = source as Record<string, unknown>;
      collectStringEndpoint(sourceRecord.url, endpoints);
      const tiles = sourceRecord.tiles;
      if (Array.isArray(tiles)) {
        for (const tile of tiles) collectStringEndpoint(tile, endpoints);
      }
    }
  }
  return [...new Set(endpoints)];
}

export function auditStyleEndpoints(endpoints: string[], allowedHosts: readonly string[]): {
  externalHosts: string[];
  isAllowed: boolean;
  providerMode: 'public_allowlisted' | 'self_hosted';
} {
  const externalHosts = [...new Set(endpoints.map(endpointHost).filter((host): host is string => host !== null))].sort();
  return {
    externalHosts,
    isAllowed: externalHosts.every((host) => allowedHosts.includes(host)),
    providerMode: externalHosts.length === 0 ? 'self_hosted' : 'public_allowlisted'
  };
}

function collectStringEndpoint(value: unknown, endpoints: string[]): void {
  if (typeof value !== 'string' || value.trim() === '') return;
  const endpoint = value.trim();
  endpoints.push(endpoint);
  if (endpoint.startsWith('pmtiles://')) {
    const nested = endpoint.slice('pmtiles://'.length);
    if (nested !== '') endpoints.push(nested);
  }
}

function endpointHost(endpoint: string): string | null {
  const normalized = endpoint.startsWith('pmtiles://') ? endpoint.slice('pmtiles://'.length) : endpoint;
  if (!/^https?:\/\//iu.test(normalized)) return null;
  try {
    return new URL(normalized).host.toLowerCase();
  } catch {
    return null;
  }
}
