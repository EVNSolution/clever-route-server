import type {
  RoutePlanRouteGeometry,
  RoutePlanRouteMetrics
} from '../route-plans/route-plan.types.js';
import type { OrderItemDto } from '../order-items/order-items.js';
import type { NormalizedPaymentStatus } from '../payments/normalized-payment-status.js';
import type { DriverRouteEtaSnapshot } from './driver-route-eta.js';

export type DriverAssignedRouteInput = {
  driverId: string;
  routeContext: string | null;
  shopDomain: string;
  shopId: string;
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
  currencyCode: string | null;
  customerNote: string | null;
  deliverySession?: string | null;
  deliveryStopId: string;
  destinationId: string | null;
  distanceFromPreviousMeters?: number | null;
  durationFromPreviousSeconds?: number | null;
  driverMessages: Array<{
    body: string;
    createdAt: string;
    messageId: string;
    readAt: string | null;
  }>;
  estimatedArrivalAt?: string | null;
  conditionCode: string | null;
  items: OrderItemDto[];
  normalizedPaymentStatus: NormalizedPaymentStatus | null;
  orderName: string;
  paymentMethodTitle: string | null;
  phone: string | null;
  recipientName: string | null;
  sequence: number;
  serviceType?: string | null;
  sellerOrderKey: string | null;
  shippedBoxes: number | null;
  specialInstructionNote: string | null;
  status: string;
  routeConstraintStatus?: 'NOT_APPLICABLE' | 'UNCONFIRMED' | 'PENDING_RECALCULATION' | 'NOT_EVALUATED';
  pendingTimeConstraintChange?: {
    pendingChangeId: string;
    requestedAt: string;
    status: 'PENDING_ACK';
    type: 'TIME_CONSTRAINT_CHANGE';
    timeWindow: {
      end: string;
      start: string;
    } | null;
  } | null | undefined;
  timeConstraintAcknowledgement: {
    acknowledgedAt: string;
    eventId: string;
  } | null;
  timeWindow: {
    end: string;
    start: string;
  } | null;
  timeWindowEnd: string | null;
  timeWindowStart: string | null;
  totalPriceAmount: string | null;
};

export type DriverAssignedRouteStopPoint = {
  deliveryStopId: string;
  inputCoordinates: [number, number] | null;
  name: string | null;
  sequence: number;
  snapDistanceMeters: number | null;
  snappedCoordinates: [number, number] | null;
};

export type DriverRouteMapPreview = {
  altText: string;
  contentType: 'image/png';
  expiresAt: string;
  generatedAt: string;
  height: number;
  imageUrl: string;
  kind: 'static_route_map';
  routeSequenceChecksum: string;
  width: number;
};

export type DriverAssignedRoute = {
  deliveryDate: string;
  depot: {
    latitude: number | null;
    longitude: number | null;
  };
  etaSnapshot: DriverRouteEtaSnapshot;
  id: string;
  name: string;
  routeGeometry: RoutePlanRouteGeometry | null;
  routeMapPreview: DriverRouteMapPreview | null;
  routeMetrics: RoutePlanRouteMetrics | null;
  routeStopPoints: DriverAssignedRouteStopPoint[];
  scheduledStartAt: string | null;
  shopDomain: string;
  stops: DriverAssignedRouteStop[];
  timezone: string;
};

export type DriverAssignedRouteResult =
  | { status: 'NO_ASSIGNED_ROUTE' }
  | {
      status: 'ASSIGNED_ROUTE';
      route: DriverAssignedRoute;
    };

export type DriverAssignedRouteServiceContract = {
  getAssignedRoute(input: DriverAssignedRouteInput): Promise<DriverAssignedRouteResult>;
};
