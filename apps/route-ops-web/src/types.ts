export type AppMode = 'internal-admin' | 'plugin';

export type MapProviderStatus = 'configured' | 'not_configured';

export type MapProviderMode = 'public_allowlisted' | 'self_hosted' | null;

export type BootstrapPayload = {
  appUrls: {
    dashboard: string;
    drivers: string;
    orders: string;
    routes: string;
    settings: string;
  };
  csrfToken: string;
  mapConfig: {
    allowedHosts: string[];
    attribution: string | null;
    disabledReason?: string;
    providerMode: MapProviderMode;
    status: MapProviderStatus;
    styleAudit: {
      endpoints: string[];
      externalHosts: string[];
    } | null;
    styleUrl: string | null;
  };
  mode: AppMode;
  routerConfig: {
    status: MapProviderStatus;
  };
  shopDomain: string | null;
};

export type CanonicalOrderDto = {
  blockerReasons: string[];
  coordinates: { latitude: number | null; longitude: number | null };
  deliveryArea: string | null;
  deliveryDate: string | null;
  deliverySession: string | null;
  deliveryStatus: string;
  health: string;
  orderId: string;
  orderName: string;
  phone: string | null;
  planningStatus: string;
  recipientName: string | null;
  routePlanId: string | null;
  routePlanName: string | null;
  sourceOrderId: string | null;
  sourceOrderNumber: string | null;
  sourcePlatform: string | null;
  status: string | null;
  stopId: string | null;
};

export type RoutePlanSummaryDto = {
  createdAt: string;
  deliveryAreas: string[];
  deliveryDate: string | null;
  depot: {
    latitude: number | null;
    longitude: number | null;
  };
  driverId: string | null;
  id: string;
  missingCoordinates: number;
  name: string;
  planDate: string;
  status: string;
  stopsCount: number;
  updatedAt: string;
};

export type RouteStopDto = {
  addressLabel: string;
  coordinates: { latitude: number | null; longitude: number | null };
  deliveryArea: string | null;
  deliveryStopId: string;
  orderId: string;
  orderName: string;
  recipientName: string | null;
  sequence: number;
  sourceOrderId: string;
  status: string;
};

export type RoutePlanDetailDto = {
  routeGeometry: { coordinates: Array<[number, number]>; type: 'LineString' } | null;
  routePlan: RoutePlanSummaryDto;
  routeStopPoints: Array<{
    deliveryStopId: string;
    inputCoordinates: [number, number] | null;
    name: string | null;
    sequence: number;
    sourceOrderId: string;
  }>;
  stops: RouteStopDto[];
};

export type DriverDto = {
  authStatus: string;
  displayName: string;
  id: string;
  lastSeenAt: string | null;
  phone: string | null;
  status: string;
};

export type StoreSettingsDto = {
  defaultDepotAddress: string | null;
  defaultDepotLatitude: number | null;
  defaultDepotLongitude: number | null;
  locale: string;
  shopDomain: string;
};

export type OrdersResponse = {
  orders: CanonicalOrderDto[];
  reviewBlockers: CanonicalOrderDto[];
};

export type RoutesResponse = {
  routePlans: RoutePlanSummaryDto[];
};

export type DriversResponse = {
  drivers: DriverDto[];
};

export type SettingsResponse = {
  settings: StoreSettingsDto | null;
};

export type ApiEnvelope<T> = {
  data: T | null;
  error: { code: string; message: string } | null;
};
