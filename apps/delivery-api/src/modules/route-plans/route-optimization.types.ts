import type { RoutePlanDetail } from './route-plan.types.js';

export type RouteOptimizationStopSequence = {
  deliveryStopId: string;
  sequence: number;
  shopifyOrderGid: string;
};

export type RouteOptimizationResult = {
  missingCoordinateStops: number;
  source: 'vroom';
  stops: RouteOptimizationStopSequence[];
};

export type RouteOptimizationFailureCode =
  | 'fallback_not_applied'
  | 'graph_not_ready'
  | 'invalid_engine_payload'
  | 'invalid_input'
  | 'network_error'
  | 'optimizer_unavailable'
  | 'solver_timeout';

export type RouteOptimizationFailure = {
  code: RouteOptimizationFailureCode;
  elapsedMs: number;
  httpStatus?: number | undefined;
  message: string;
};

export type RouteOptimizationOutcome =
  | { failure: RouteOptimizationFailure; ok: false }
  | { ok: true; result: RouteOptimizationResult };

export type RouteOptimizationInput = {
  detail: RoutePlanDetail;
  shopDomain: string;
};

export type RouteOptimizationService = {
  optimizeStopOrder(input: RouteOptimizationInput): Promise<RouteOptimizationResult | null>;
  optimizeStopOrderWithDiagnostics?(input: RouteOptimizationInput): Promise<RouteOptimizationOutcome>;
};
