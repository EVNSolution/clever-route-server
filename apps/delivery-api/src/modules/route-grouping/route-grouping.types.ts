import type { RoutePlanSummary } from '../route-plans/route-plan.types.js';

export type RouteGroupingDisplayStatus = 'DRAFT' | 'NEEDS_ASSIGNMENT' | 'READY' | 'PUBLISHED' | 'CHANGED' | 'CANCELLED';
export type RouteGroupingChildDisplayStatus = 'DRAFT' | 'PUBLISHED' | 'NEEDS_REPUBLISH' | 'SUPERSEDED';
export type RouteGroupingNotificationStatus = 'NOT_REQUIRED' | 'PENDING' | 'SENT' | 'FAILED';

export type RouteGroupingBranchDto = {
  createdAt: string;
  driverId: string | null;
  driverName: string | null;
  id: string;
  label: string | null;
  orderIds: string[];
  ordersCount: number;
  updatedAt: string;
};

export type RouteGroupingAssignmentDto = {
  assignedDriverId: string | null;
  assignedPolygonId: string | null;
  assignmentStatus: 'UNASSIGNED' | 'ASSIGNED' | 'OVERLAP' | 'EXCLUDED';
  coordinates: { latitude: number | null; longitude: number | null };
  deliveryStopId: string;
  orderId: string;
  orderName: string;
  recipientName: string | null;
  addressLabel: string;
  phone: string | null;
  email: string | null;
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
  dateRangeEnd: string;
  dateRangeStart: string;
  displayStatus: RouteGroupingDisplayStatus;
  id: string;
  name: string;
  planDate: string;
  status: string;
  totalOrders: number;
  unresolvedOrders: number;
  updatedAt: string;
  warningState: RouteGroupingWarningDto[];
};

export type RouteGroupingDetailDto = RouteGroupingSummaryDto & {
  assignments: RouteGroupingAssignmentDto[];
  branches: RouteGroupingBranchDto[];
  polygons: RouteGroupingPolygonDto[];
};

export type CreateRouteGroupingInput = {
  appId?: string | undefined;
  createdBy: string;
  dateRangeEnd?: string;
  dateRangeStart?: string;
  name: string;
  orderIds: string[];
  planDate?: string;
  shopDomain: string;
};

export type SaveRouteGroupingPolygonsInput = {
  appId?: string | undefined;
  groupingId: string;
  deletePolygonIds?: string[];
  expectedUpdatedAt: string;
  polygons: Array<{
    closed: boolean;
    color?: string | null;
    driverId?: string | null;
    geometry: unknown;
    id?: string | null;
    label: string;
  }>;
  shopDomain: string;
};

export type ResolveRouteGroupingAssignmentsInput = {
  appId?: string | undefined;
  assignments: Array<{ assignedDriverId: string; orderId: string }>;
  groupingId: string;
  shopDomain: string;
};

export type GenerateChildRoutesInput = {
  appId?: string | undefined;
  actor: string;
  confirmRisk?: boolean;
  groupingId: string;
  shopDomain: string;
};

export type RollbackRouteGroupingInput = {
  appId?: string | undefined;
  actor: string;
  groupingId: string;
  shopDomain: string;
  version: number;
};

export type UpdateRouteGroupingOrdersInput = {
  addOrderIds?: string[];
  appId?: string | undefined;
  expectedUpdatedAt?: string;
  groupingId: string;
  removeOrderIds?: string[];
  shopDomain: string;
};

export type CreateRouteGroupingBranchInput = {
  actor: string;
  appId?: string | undefined;
  driverId?: string | null;
  groupingId: string;
  label?: string | null;
  orderIds?: string[];
  shopDomain: string;
};

export type UpdateRouteGroupingBranchOrdersInput = {
  addOrderIds?: string[];
  appId?: string | undefined;
  branchId: string;
  groupingId: string;
  removeOrderIds?: string[];
  shopDomain: string;
};

export type DeleteRouteGroupingResult = { deleted: boolean; deletedChildRoutePlanCount: number; groupingId: string };

export type RouteGroupingService = {
  createBranch(input: CreateRouteGroupingBranchInput): Promise<RouteGroupingDetailDto | null>;
  createGrouping(input: CreateRouteGroupingInput): Promise<RouteGroupingDetailDto>;
  deleteBranch(input: { appId?: string | undefined; branchId: string; groupingId: string; shopDomain: string }): Promise<RouteGroupingDetailDto | null>;
  deleteGrouping(input: { appId?: string | undefined; groupingId: string; shopDomain: string }): Promise<DeleteRouteGroupingResult>;
  getGrouping(input: { appId?: string | undefined; groupingId: string; shopDomain: string }): Promise<RouteGroupingDetailDto | null>;
  listGroupings(input: { appId?: string | undefined; dateRangeEnd?: string; dateRangeStart?: string; deliveryDate?: string; shopDomain: string }): Promise<RouteGroupingSummaryDto[]>;
  updateBranchOrders(input: UpdateRouteGroupingBranchOrdersInput): Promise<RouteGroupingDetailDto | null>;
  updateGroupingOrders(input: UpdateRouteGroupingOrdersInput): Promise<RouteGroupingDetailDto | null>;
  savePolygons(input: SaveRouteGroupingPolygonsInput): Promise<RouteGroupingDetailDto | null>;
  resolveAssignments(input: ResolveRouteGroupingAssignmentsInput): Promise<RouteGroupingDetailDto | null>;
  generateChildRoutes(input: GenerateChildRoutesInput): Promise<RouteGroupingDetailDto | null>;
  rollback(input: RollbackRouteGroupingInput): Promise<RouteGroupingDetailDto | null>;
  recordChildRoutePublished(input: { routePlanId: string; shopDomain: string }): Promise<void>;
};

export class RouteGroupingConflictError extends Error {
  readonly code = 'ROUTE_GROUPING_STALE_WRITE';
  constructor(message = 'Route grouping was changed by another save. Refresh and try again.') {
    super(message);
    this.name = 'RouteGroupingConflictError';
  }
}

export class RouteGroupingBranchLockConflictError extends Error {
  readonly code = 'ROUTE_GROUPING_BRANCH_LOCK_CONFLICT';
  constructor(readonly orderIds: string[]) {
    super('One or more orders already belong to another branch.');
    this.name = 'RouteGroupingBranchLockConflictError';
  }
}

export class RouteGroupingDeleteBlockedError extends Error {
  readonly code = 'ROUTE_GROUPING_DELETE_BLOCKED';
  constructor(readonly blockers: string[]) {
    super(`Route grouping delete blocked: ${blockers.join('; ')}`);
    this.name = 'RouteGroupingDeleteBlockedError';
  }
}

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
