export type RoutePlanRouteScopeInput = {
  deliveryDate: string;
  deliverySession: 'DAY' | 'EVENING' | 'PICKUP';
  routeScopeKey: string;
  serviceType: 'DELIVERY' | 'EVENING_DELIVERY' | 'PICKUP';
  timeWindowEnd: string | null;
  timeWindowStart: string | null;
};

export type RoutePlanDepotInput = {
  address: string | null;
  latitude: number | null;
  longitude: number | null;
};

export type RoutePlanOrderAttributeInput = {
  key: string;
  value: string;
};

export type RoutePlanShippingAddressInput = {
  address1: string | null;
  address2: string | null;
  city: string | null;
  countryCode: string | null;
  postalCode: string | null;
  province: string | null;
};

export type RoutePlanOrderInput = {
  attributes: RoutePlanOrderAttributeInput[];
  currencyCode: string | null;
  deliveryArea: string | null;
  deliveryDate?: string | null | undefined;
  deliveryDay: string | null;
  deliverySession?: 'DAY' | 'EVENING' | 'PICKUP' | null | undefined;
  email: string | null;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  latitude: number | null;
  longitude: number | null;
  name: string;
  phone: string | null;
  planningGroupKey?: string | null | undefined;
  processedAt: Date | null;
  rawPayload: unknown;
  recipientName: string | null;
  routeScopeKey?: string | null | undefined;
  serviceType?: 'DELIVERY' | 'EVENING_DELIVERY' | 'PICKUP' | null | undefined;
  shippingAddress: RoutePlanShippingAddressInput;
  shopifyOrderGid: string;
  timeWindowEnd?: string | null | undefined;
  timeWindowStart?: string | null | undefined;
  totalPriceAmount: string | null;
};

export type CreateRoutePlanPayload = {
  depot: RoutePlanDepotInput;
  name: string;
  orders: RoutePlanOrderInput[];
  planDate: string;
  routeScope?: RoutePlanRouteScopeInput;
};

export type CreateRoutePlanInput = {
  createdBy: string;
  payload: CreateRoutePlanPayload;
  shopDomain: string;
};

export type CreateRoutePlanFromOrderIdsPayload = {
  depot: RoutePlanDepotInput;
  name: string;
  orderIds: string[];
  planDate: string;
};

export type CreateRoutePlanFromOrderIdsInput = {
  createdBy: string;
  payload: CreateRoutePlanFromOrderIdsPayload;
  shopDomain: string;
};

export type RoutePlanSummary = {
  createdAt: string;
  deliveryDate?: string | null;
  deliveryAreas: string[];
  deliveryDays: string[];
  depot: {
    latitude: number | null;
    longitude: number | null;
  };
  driver?: RoutePlanDriverSummary | null;
  driverId?: string | null;
  id: string;
  missingCoordinates: number;
  name: string;
  planDate: string;
  status: string;
  stopsCount: number;
  updatedAt: string;
};

export type ListRoutePlansInput = {
  deliveryDate?: string;
  shopDomain: string;
};

export type RoutePlanDriverSummary = {
  authStatus: 'APP_LINKED' | 'INVITE_PENDING';
  authSubject: 'present' | null;
  createdAt: string;
  displayName: string;
  id: string;
  lastSeenAt: string | null;
  phone: string | null;
  recentEventsCount: number;
  status: 'ACTIVE' | 'INACTIVE' | 'PENDING' | 'SUSPENDED';
  updatedAt: string;
};

export type RoutePlanDetailStop = {
  address: RoutePlanShippingAddressInput;
  attributes: RoutePlanOrderAttributeInput[];
  coordinates: {
    latitude: number | null;
    longitude: number | null;
  };
  deliveryArea: string | null;
  deliveryDay: string | null;
  deliveryStopId: string;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  orderId: string;
  orderName: string;
  paymentStatus: string | null;
  recipientName: string | null;
  sequence: number;
  shopifyOrderGid: string;
  status: string;
};

export type RoutePlanRouteGeometry = {
  coordinates: Array<[number, number]>;
  type: 'LineString';
};

export type RoutePlanRouteStopPoint = {
  deliveryStopId: string;
  inputCoordinates: [number, number] | null;
  name: string | null;
  sequence: number;
  shopifyOrderGid: string;
  snapDistanceMeters: number | null;
  snappedCoordinates: [number, number] | null;
};

export type RoutePlanRouteResult = {
  routeGeometry: RoutePlanRouteGeometry | null;
  routeStopPoints: RoutePlanRouteStopPoint[];
};

export type UpdateRoutePlanStopsPayload = {
  stops: Array<{
    deliveryStopId?: string | null | undefined;
    sequence: number;
    shopifyOrderGid: string;
  }>;
};

export type UpdateRoutePlanStopsInput = {
  routePlanId: string;
  shopDomain: string;
  payload: UpdateRoutePlanStopsPayload;
};

export type UpdateRoutePlanDriverPayload = {
  driverId: string | null;
};

export type UpdateRoutePlanDriverInput = {
  routePlanId: string;
  shopDomain: string;
  payload: UpdateRoutePlanDriverPayload;
};

export type RoutePlanDetail = {
  routePlan: RoutePlanSummary;
  routeGeometry: RoutePlanRouteGeometry | null;
  routeStopPoints: RoutePlanRouteStopPoint[];
  stops: RoutePlanDetailStop[];
};

export type RoutePlanService = {
  assignRoutePlanDriver(input: UpdateRoutePlanDriverInput): Promise<RoutePlanDetail | null>;
  createRoutePlan(input: CreateRoutePlanInput): Promise<RoutePlanSummary>;
  createRoutePlanFromOrderIds?(input: CreateRoutePlanFromOrderIdsInput): Promise<RoutePlanSummary>;
  deleteRoutePlan(input: { routePlanId: string; shopDomain: string }): Promise<{
    routePlanId: string;
    deleted: boolean;
  }>;
  getRoutePlanDetail(input: {
    routePlanId: string;
    shopDomain: string;
  }): Promise<RoutePlanDetail | null>;
  listRoutePlans(input: ListRoutePlansInput): Promise<RoutePlanSummary[]>;
  updateRoutePlanStops(input: UpdateRoutePlanStopsInput): Promise<RoutePlanDetail | null>;
};

export class RoutePlanOrderAlreadyPlannedError extends Error {
  readonly orderNames: string[];

  constructor(orderNames: string[] = []) {
    super('Route plan contains orders that are already assigned to a route plan.');
    this.name = 'RoutePlanOrderAlreadyPlannedError';
    this.orderNames = orderNames;
  }
}

export class RoutePlanStopUpdateInvalidError extends Error {
  readonly code = 'ROUTE_STOP_UPDATE_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'RoutePlanStopUpdateInvalidError';
  }
}

export class RoutePlanDriverAssignInvalidError extends Error {
  readonly code = 'ROUTE_DRIVER_ASSIGN_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'RoutePlanDriverAssignInvalidError';
  }
}

export class RoutePlanBatchInvalidError extends Error {
  readonly blockers: string[];
  readonly code = 'ROUTE_PLAN_BATCH_INVALID';

  constructor(blockers: string[]) {
    super(`Cannot create route from selected orders: ${blockers.join('; ')}`);
    this.name = 'RoutePlanBatchInvalidError';
    this.blockers = blockers;
  }
}
