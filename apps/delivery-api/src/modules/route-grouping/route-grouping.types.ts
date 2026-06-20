import type { OrderItemDto } from '../order-items/order-items.js';
import type { RoutePlanSummary } from '../route-plans/route-plan.types.js';

export type RouteGroupingDisplayStatus = 'DRAFT' | 'NEEDS_ASSIGNMENT' | 'READY' | 'PUBLISHED' | 'CHANGED' | 'CANCELLED';
export type RouteGroupingChildDisplayStatus = 'DRAFT' | 'PUBLISHED' | 'NEEDS_REPUBLISH' | 'SUPERSEDED';
export type RouteGroupingNotificationStatus = 'NOT_REQUIRED' | 'PENDING' | 'SENT' | 'FAILED';

export type RouteGroupingAssignmentDto = {
  assignedDriverId: string | null;
  assignedPolygonId: string | null;
  assignmentStatus: 'UNASSIGNED' | 'ASSIGNED' | 'OVERLAP' | 'EXCLUDED';
  coordinates: { latitude: number | null; longitude: number | null };
  deliveryStopId: string;
  orderId: string;
  orderName: string;
  items: OrderItemDto[];
  sourceOrderId: string;
  sourceSequence: number;
};

export type RouteGroupingPolygonDto = {
  closed: boolean;
  color: string | null;
  drawOrder: number;
  driverId: string | null;
  id: string;
  label: string;
  geometry: unknown;
};

export type RouteGroupingChildDto = {
  childVersion: number;
  displayStatus: RouteGroupingChildDisplayStatus;
  driverId: string | null;
  driverName: string | null;
  notificationStatus: RouteGroupingNotificationStatus;
  routePlan: RoutePlanSummary | null;
  routePlanId: string | null;
  stopsCount: number;
};

export type RouteGroupingWarningDto = {
  code: 'DRIVER_ASSIGNED' | 'DRIVER_NOTIFICATION_SENT' | 'CUSTOMER_NOTIFICATION_SENT_OR_QUEUED';
  message: string;
  orderIds?: string[];
  routePlanIds?: string[];
};

export type RouteGroupingSummaryDto = {
  children: RouteGroupingChildDto[];
  currentVersion: number;
  displayStatus: RouteGroupingDisplayStatus;
  id: string;
  name: string;
  planDate: string;
  status: string;
  totalOrders: number;
  unresolvedOrders: number;
  warningState: RouteGroupingWarningDto[];
};

export type RouteGroupingDetailDto = RouteGroupingSummaryDto & {
  assignments: RouteGroupingAssignmentDto[];
  polygons: RouteGroupingPolygonDto[];
};

export type CreateRouteGroupingInput = {
  createdBy: string;
  name: string;
  orderIds: string[];
  planDate: string;
  shopDomain: string;
};

export type SaveRouteGroupingPolygonsInput = {
  groupingId: string;
  polygons: Array<{
    closed: boolean;
    color?: string | null;
    driverId?: string | null;
    geometry: unknown;
    label: string;
  }>;
  shopDomain: string;
};

export type ResolveRouteGroupingAssignmentsInput = {
  assignments: Array<{ assignedDriverId: string; orderId: string }>;
  groupingId: string;
  shopDomain: string;
};

export type GenerateChildRoutesInput = {
  actor: string;
  confirmRisk?: boolean;
  groupingId: string;
  shopDomain: string;
};

export type RollbackRouteGroupingInput = {
  actor: string;
  groupingId: string;
  shopDomain: string;
  version: number;
};

export type RouteGroupingService = {
  createGrouping(input: CreateRouteGroupingInput): Promise<RouteGroupingDetailDto>;
  getGrouping(input: { groupingId: string; shopDomain: string }): Promise<RouteGroupingDetailDto | null>;
  listGroupings(input: { deliveryDate?: string; shopDomain: string }): Promise<RouteGroupingSummaryDto[]>;
  savePolygons(input: SaveRouteGroupingPolygonsInput): Promise<RouteGroupingDetailDto | null>;
  resolveAssignments(input: ResolveRouteGroupingAssignmentsInput): Promise<RouteGroupingDetailDto | null>;
  generateChildRoutes(input: GenerateChildRoutesInput): Promise<RouteGroupingDetailDto | null>;
  rollback(input: RollbackRouteGroupingInput): Promise<RouteGroupingDetailDto | null>;
  recordChildRoutePublished(input: { routePlanId: string; shopDomain: string }): Promise<void>;
};

export class RouteGroupingValidationError extends Error {
  readonly code = 'ROUTE_GROUPING_INVALID';
  constructor(readonly blockers: string[]) {
    super(`Route grouping is invalid: ${blockers.join('; ')}`);
    this.name = 'RouteGroupingValidationError';
  }
}

export class RouteGroupingUnresolvedAssignmentsError extends Error {
  readonly code = 'ROUTE_GROUPING_UNRESOLVED_ASSIGNMENTS';
  constructor(readonly unresolvedCount: number) {
    super('Resolve all unassigned or overlapping orders before generating child routes.');
    this.name = 'RouteGroupingUnresolvedAssignmentsError';
  }
}

export class RouteGroupingRiskConfirmationRequiredError extends Error {
  readonly code = 'ROUTE_GROUPING_RISK_CONFIRMATION_REQUIRED';
  constructor(readonly warnings: RouteGroupingWarningDto[]) {
    super('Confirm actual published/notification risks before replacing current child routes.');
    this.name = 'RouteGroupingRiskConfirmationRequiredError';
  }
}
