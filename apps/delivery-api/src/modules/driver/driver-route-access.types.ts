export type DriverRouteAccessLookupInput = {
  phoneE164: string;
  routeContext: string | null;
};

export type DriverRouteAccessCompanyGuidance = {
  companyDisplayName: string;
  deliveryDate: string;
  driverInstructions: string[];
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
    driverId: string;
    shopDomain: string;
    tokenVersion: number;
  };
  status: 'INVITED';
  routeAccess: {
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
  | { status: 'BLOCKED' | 'DISABLED' | 'NOT_FOUND' };

export type DriverRouteAccessServiceContract = {
  lookupRouteAccess(input: DriverRouteAccessLookupInput): Promise<DriverRouteAccessLookupResult>;
};
