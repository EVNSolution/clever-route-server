import type { MapProviderStatus } from '../types';

export type MapReadiness = 'interactive_map' | 'provider_not_configured';

export function mapReadiness(input: { mapStatus: MapProviderStatus }): MapReadiness {
  if (input.mapStatus === 'not_configured') return 'provider_not_configured';
  return 'interactive_map';
}
