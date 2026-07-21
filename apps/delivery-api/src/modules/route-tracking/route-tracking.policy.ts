export const ROUTE_TRACKING_SCHEMA_VERSION = 'route_tracking.v1';

export const ROUTE_TRACKING_V1_POLICY = {
  captureIntervalMs: 30_000,
  delayedThresholdMs: 180_000,
  heartbeatMs: 15_000,
  liveThresholdMs: 60_000,
  geometrySimplificationToleranceMeters: 5,
  minDistanceMeters: 50,
  streamRetryMs: 3_000
} as const;

export type RouteTrackingPolicy = typeof ROUTE_TRACKING_V1_POLICY;
