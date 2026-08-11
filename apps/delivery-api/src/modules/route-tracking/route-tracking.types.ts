import type { RouteTrackingPolicy } from './route-tracking.policy.js';

export type RouteTrackingPositionEventV1 = {
  driverId: string;
  eventId: string;
  latitude: number;
  longitude: number;
  occurredAt: string;
  receivedAt: string;
  routePlanId: string;
  schemaVersion: 'route_tracking.v1';
};

export type RouteTrackingProgressEventType =
  | 'ROUTE_COMPLETED'
  | 'ROUTE_PAUSED'
  | 'ROUTE_STARTED'
  | 'STOP_ARRIVED'
  | 'STOP_DELIVERED'
  | 'STOP_FAILED';

export type RouteTrackingProgressEventV1 = {
  deliveryStopId: string | null;
  driverId: string | null;
  eventId: string;
  eventType: RouteTrackingProgressEventType;
  occurredAt: string;
  receivedAt: string;
  routePlanId: string;
  schemaVersion: 'route_tracking.v1';
};

export type RouteTrackingDriverStage = 'AT_STOP' | 'COMPLETED' | 'DRIVING' | 'PAUSED' | 'READY';

export type RouteTrackingProgressSnapshotV1 = {
  completedStopIds: string[];
  currentStage: RouteTrackingDriverStage;
  currentStopId: string | null;
  failedStopIds: string[];
  latestEvent: RouteTrackingProgressEventV1 | null;
};

export type RouteTrackingStopArrivalV1 = {
  deliveryStopId: string;
  driverId: string;
  eventId: string;
  latitude: number | null;
  longitude: number | null;
  occurredAt: string;
  positionAgeMs: number | null;
  positionSource: 'event' | 'nearest_location' | 'unavailable';
  receivedAt: string;
  routePlanId: string;
  schemaVersion: 'route_tracking_arrival.v1';
  stopSequence: number;
};

export type RouteTrackingStatus = 'DELAYED' | 'LIVE' | 'NO_POSITION' | 'STALE';

export type RouteTrackingRecordedPathV1 = {
  firstOccurredAt: string;
  geometry: {
    coordinates: Array<[number, number]>;
    type: 'LineString';
  } | null;
  geometryPointCount: number;
  lastOccurredAt: string;
  lastReceivedAt: string;
  samples: Array<{
    driverId: string | null;
    eventId: string;
    occurredAt: string;
    receivedAt: string;
  }>;
  schemaVersion: 'route_tracking_geometry.v1';
  sourcePointCount: number;
};

export type RouteTrackingRoadMatchedGeometryV1 = {
  anchors?: Array<{
    observedAt: string;
    lineIndex: number;
    coordinateIndex: number;
  }>;
  coordinates: Array<Array<[number, number]>>;
  type: 'MultiLineString';
};

export type RouteTrackingRoadMatchedPathV1 = {
  coverage: 'korea' | 'ontario';
  inputPointCount: number;
  lastInputOccurredAt: string;
  lastMatchedPosition: {
    latitude: number;
    longitude: number;
    occurredAt: string;
  } | null;
  matchedGeometry: RouteTrackingRoadMatchedGeometryV1 | null;
  matchedPointCount: number;
  schemaVersion: 'route_tracking_road_match.v1';
  uncertainGeometry: RouteTrackingRoadMatchedGeometryV1 | null;
  watermark: string;
};

export type RouteTrackingSnapshotV1 = {
  latestPosition: RouteTrackingPositionEventV1 | null;
  policy: RouteTrackingPolicy;
  progress: RouteTrackingProgressSnapshotV1;
  recordedPath?: RouteTrackingRecordedPathV1 | null;
  roadMatchedPath?: RouteTrackingRoadMatchedPathV1 | null;
  recentPositions: RouteTrackingPositionEventV1[];
  routePlanId: string;
  schemaVersion: 'route_tracking.v1';
  serverTime: string;
  status: RouteTrackingStatus;
  stopArrivals?: RouteTrackingStopArrivalV1[];
};

export type RouteTrackingService = {
  getRouteTrackingSnapshot(input: {
    now?: Date;
    routePlanId: string;
  }): Promise<RouteTrackingSnapshotV1>;
};
