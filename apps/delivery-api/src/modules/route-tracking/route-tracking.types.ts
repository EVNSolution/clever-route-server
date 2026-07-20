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
  driverId: string;
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

export type RouteTrackingStatus = 'DELAYED' | 'LIVE' | 'NO_POSITION' | 'STALE';

export type RouteTrackingSnapshotV1 = {
  latestPosition: RouteTrackingPositionEventV1 | null;
  policy: RouteTrackingPolicy;
  progress: RouteTrackingProgressSnapshotV1;
  recentPositions: RouteTrackingPositionEventV1[];
  routePlanId: string;
  schemaVersion: 'route_tracking.v1';
  serverTime: string;
  status: RouteTrackingStatus;
};

export type RouteTrackingService = {
  getRouteTrackingSnapshot(input: {
    now?: Date;
    routePlanId: string;
  }): Promise<RouteTrackingSnapshotV1>;
};
