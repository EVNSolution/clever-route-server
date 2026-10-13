import { buildUvisVehicleDailyRoute } from './uvis-vehicle-daily-route.js';
import { distanceMeters } from './uvis-vehicle-trail-evidence.js';
import type { UvisVehicleTrailDocumentV1 } from './uvis-vehicle-trail-materializer.js';

type QualitySample = Parameters<typeof buildUvisVehicleDailyRoute>[0][number];

export type UvisTrailQuality = {
  bridgesByReason: Record<string, number>;
  routedGapMisses: number;
  routedGaps: number;
  tunnels: number;
  unresolvedByDistance: { under50: number; from50To200: number; from200To500: number; atLeast500: number };
  unresolvedMaxMeters: number;
  unresolvedTotalMeters: number;
};

/**
 * Counts what a viewer of the daily line still sees as a break. A routed gap is drawn as road and leaves no
 * bridge; a tunnel keeps its IMPLAUSIBLE_JUMP reason with an inferred line, so it is counted apart from the
 * unresolved bridges. Distances are the raw chord between the two fixes.
 */
export function summarizeUvisTrailQuality(
  samples: QualitySample[],
  document: UvisVehicleTrailDocumentV1 | null,
): UvisTrailQuality {
  const quality: UvisTrailQuality = {
    bridgesByReason: {},
    routedGapMisses: document?.routedGapMisses?.length ?? 0,
    routedGaps: document?.routedGaps?.length ?? 0,
    tunnels: 0,
    unresolvedByDistance: { under50: 0, from50To200: 0, from200To500: 0, atLeast500: 0 },
    unresolvedMaxMeters: 0,
    unresolvedTotalMeters: 0,
  };
  const route = buildUvisVehicleDailyRoute(samples, document);
  const byObservedAt = new Map(samples.map((sample) => [sample.observedAt, sample]));
  for (const bridge of route?.bridges ?? []) {
    quality.bridgesByReason[bridge.reason] = (quality.bridgesByReason[bridge.reason] ?? 0) + 1;
    if (bridge.inferredTunnel !== undefined) {
      quality.tunnels += 1;
      continue;
    }
    const from = byObservedAt.get(bridge.fromObservedAt);
    const to = byObservedAt.get(bridge.toObservedAt);
    if (from === undefined || to === undefined) continue;
    const meters = Math.round(distanceMeters(from, to));
    const buckets = quality.unresolvedByDistance;
    // Under 50 m is stop jitter nobody sees on the map; it is counted but kept out of the distance totals.
    if (meters < 50) {
      buckets.under50 += 1;
      continue;
    }
    if (meters < 200) buckets.from50To200 += 1;
    else if (meters < 500) buckets.from200To500 += 1;
    else buckets.atLeast500 += 1;
    quality.unresolvedTotalMeters += meters;
    quality.unresolvedMaxMeters = Math.max(quality.unresolvedMaxMeters, meters);
  }
  return quality;
}
