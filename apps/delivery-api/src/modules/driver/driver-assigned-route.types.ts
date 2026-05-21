export type DriverAssignedRouteInput = {
  driverId: string;
  routeContext: string | null;
  shopDomain: string;
};

export type DriverAssignedRouteStop = {
  address: {
    address1: string | null;
    address2: string | null;
    city: string | null;
    countryCode: string | null;
    postalCode: string | null;
    province: string | null;
  };
  coordinates: {
    latitude: number | null;
    longitude: number | null;
  };
  deliveryStopId: string;
  orderName: string;
  phone: string | null;
  recipientName: string | null;
  sequence: number;
  status: string;
};

export type DriverAssignedRouteResult =
  | { status: 'NO_ASSIGNED_ROUTE' }
  | {
      status: 'ASSIGNED_ROUTE';
      route: {
        deliveryDate: string;
        id: string;
        name: string;
        shopDomain: string;
        stops: DriverAssignedRouteStop[];
        timezone: string;
      };
    };

export type DriverAssignedRouteServiceContract = {
  getAssignedRoute(input: DriverAssignedRouteInput): Promise<DriverAssignedRouteResult>;
};
