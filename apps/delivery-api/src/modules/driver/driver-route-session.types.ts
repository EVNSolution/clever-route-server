import type { DriverAssignedRoute } from './driver-assigned-route.types.js';

export type DriverRouteSessionRestoreInput = {
  driverId: string;
  routePlanId: string;
  shopDomain: string;
  shopId: string;
};

export type DriverRouteSessionRestoreResult =
  | { status: 'NO_ACTIVE_SESSION' }
  | {
      status: 'ACTIVE_SESSION';
      session: DriverRouteSessionRestoreSession;
      route: DriverAssignedRoute;
    };

export type DriverRouteSessionRestoreSession = {
  currentDeliveryStopId: string | null;
  currentRoutePlanStopId: string | null;
  lastEventId: string | null;
  lastResumedAt: string | null;
  navigationStepIndex: number;
  routePlanId: string;
  sessionId: string | null;
  source: 'BEST_EFFORT_ROUTE_STATE';
  startedAt: string | null;
  status: 'ACTIVE';
};

export class DriverRouteSessionScopeError extends Error {}
