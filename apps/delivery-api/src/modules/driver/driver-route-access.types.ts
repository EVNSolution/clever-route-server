export type DriverRouteAccessLookupInput = {
  accountId: string;
  routeContext: string | null;
};

export type DriverRouteAccessCompanyGuidance = {
  companyDisplayName: string;
  deliveryDate: string;
  driverInstructions: string[];
  executionStatus: 'IN_PROGRESS' | 'READY';
  operatorSupportContact: string | null;
  pickupGuidance: string | null;
  routeName: string;
  shopDomain: string;
  timezone: string | null;
};

export type DriverRouteAccessAmbiguousMatch = {
  companyDisplayName: string;
  deliveryDate: string;
  operatorSupportContact: string | null;
  pickupGuidance: string | null;
  routeName: string;
  shopDomain: string;
  timezone: string | null;
};

export type DriverRouteAccessInvitedRoute = {
  driverContext: {
    accountId: string;
    routePlanId: string;
    tokenVersion: number;
  };
  status: 'INVITED';
  routeAccess: {
    assignmentGeneration: string;
    driverContractVersion: 2;
    expectedRouteVersionId: string;
    nextState: 'consent_required';
    routeContext: string;
    routePlanId: string;
  };
  companyGuidance: DriverRouteAccessCompanyGuidance;
};

export type DriverRouteAccessLookupResult =
  | DriverRouteAccessInvitedRoute
  | {
      status: 'ROUTES_FOUND';
      routes: DriverRouteAccessInvitedRoute[];
    }
  | {
      status: 'MULTIPLE_MATCHES';
      matches: DriverRouteAccessAmbiguousMatch[];
      resolutionHint: string;
    }
  | { status: 'BLOCKED' | 'DISABLED' | 'NOT_FOUND' | 'VEHICLE_REQUIRED' };
