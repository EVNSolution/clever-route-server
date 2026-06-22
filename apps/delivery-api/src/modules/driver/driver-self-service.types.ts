export type DriverSelfServiceScopeInput = {
  driverId: string;
  shopDomain: string;
};

export type DriverRouteHistoryStatus = 'pending' | 'active' | 'completed';

export type ListDriverRoutesInput = DriverSelfServiceScopeInput & {
  cursor: string | null;
  from: Date | null;
  status: DriverRouteHistoryStatus | null;
  to: Date | null;
};

export type DriverRouteHistoryItem = {
  completedAt: string | null;
  completedStopCount: number;
  deliveryDate: string;
  failedStopCount: number;
  name: string;
  routePlanId: string;
  shopDomain: string;
  companyDisplayName: string;
  status: DriverRouteHistoryStatus;
  stopCount: number;
  timezone: string;
};

export type ListDriverRoutesResult = {
  routes: DriverRouteHistoryItem[];
  pageInfo: {
    endCursor: string | null;
    hasNextPage: boolean;
  };
};

export type SubmitDriverRouteFeedbackInput = DriverSelfServiceScopeInput & {
  reviewNote: string;
  routePlanId: string;
  submittedAt: Date;
};

export type SubmitDriverRouteFeedbackResult = {
  feedbackId: string;
  reviewNote: string;
  routePlanId: string;
  submittedAt: string;
};

export type DriverSelfProfile = {
  id: string;
  displayName: string;
  phone: string | null;
  status: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';
};

export type UpdateDriverProfileInput = DriverSelfServiceScopeInput & {
  displayName: string;
};

export type DriverAccountDeletionRequestInput = DriverSelfServiceScopeInput & {
  reason: string | null;
  requestedAt: Date;
};

export type DriverAccountDeletionRequestResult = {
  requestId: string;
  status: 'REQUESTED';
};

export type GetDriverEarningsInput = DriverSelfServiceScopeInput & {
  period: string;
};

export type DriverEarningsResult = {
  currency: string;
  items: [];
  period: string;
  summary: {
    adjustments: number;
    completedRoutes: number;
    completedStops: number;
    estimatedPayout: number;
    grossAmount: number;
  };
};

export class DriverRouteHistoryCursorError extends Error {}

export class DriverSelfServiceScopeError extends Error {}
