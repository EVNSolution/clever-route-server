import type {
  RoutePlanRouteGeometry,
  RoutePlanRouteMetrics
} from '../route-plans/route-plan.types.js';
import type { NormalizedPaymentStatus } from '../payments/normalized-payment-status.js';

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
  normalizedPaymentStatus: NormalizedPaymentStatus | null;
  orderName: string;
  phone: string | null;
  recipientName: string | null;
  sequence: number;
  status: string;
};

export type DriverAssignedRouteStopPoint = {
  deliveryStopId: string;
  inputCoordinates: [number, number] | null;
  name: string | null;
  sequence: number;
  snapDistanceMeters: number | null;
  snappedCoordinates: [number, number] | null;
};

export type DriverAssignedRouteResult =
  | { status: 'NO_ASSIGNED_ROUTE' }
  | {
      status: 'ASSIGNED_ROUTE';
      route: {
        deliveryDate: string;
        id: string;
        name: string;
        routeGeometry: RoutePlanRouteGeometry | null;
        routeMetrics: RoutePlanRouteMetrics | null;
        routeStopPoints: DriverAssignedRouteStopPoint[];
        shopDomain: string;
        stops: DriverAssignedRouteStop[];
        timezone: string;
      };
    };

export type DriverAssignedRouteServiceContract = {
  getAssignedRoute(input: DriverAssignedRouteInput): Promise<DriverAssignedRouteResult>;
};
