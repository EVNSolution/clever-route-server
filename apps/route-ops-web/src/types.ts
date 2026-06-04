export type AppMode = "internal-admin" | "plugin";

export type AppLocale = "en-CA" | "ko-KR";

export type MapProviderStatus = "configured" | "not_configured";

export type MapProviderMode = "public_allowlisted" | "self_hosted" | null;

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
  locale?: AppLocale;
  routerConfig: {
    coverage?: string | null;
    provider?: "osrm" | null;
    status: MapProviderStatus;
  };
  shopDomain: string | null;
};

export type DeliveryMetadataDiagnosticsDto = {
  candidates: Array<{
    parseStatus: string;
    path: string;
    source?: string;
    timeWindowEnd?: string | null;
    timeWindowStart?: string | null;
    trust?: string;
    valuePreview: string;
    weekday?: string | null;
  }>;
  conflictTimeWindows: string[];
  conflictWeekdays: string[];
  current: {
    deliveryDate: string | null;
    deliveryDateWeekday: string | null;
    deliveryDayParseStatus: string | null;
    deliveryWeekday: string | null;
    rawDeliveryDatePreview: string | null;
    rawDeliveryDayPreview: string | null;
    rawDeliveryTimeWindowPreview: string | null;
    reviewReasons: string[];
    routeScopeKey: string | null;
    serviceType: string | null;
    timeWindowEnd: string | null;
    timeWindowStart: string | null;
  };
  matchedMappingPaths: Record<string, string | null>;
  status: string;
  unsupportedValueCounts: Record<string, number>;
};

export type CanonicalOrderDto = {
  blockerReasons: string[];
  coordinates: { latitude: number | null; longitude: number | null };
  deliveryArea: string | null;
  deliveryDate: string | null;
  deliverySession: string | null;
  deliveryStatus: string;
  geocodeStatus: "PENDING" | "RESOLVED" | "FAILED" | "NOT_REQUIRED";
  geocodeDiagnostics?: {
    attemptCount: number | null;
    code: string | null;
    messageKey: string | null;
    ok: boolean | null;
    provider: string | null;
    queryShapes: string[];
    source: string | null;
    transient: boolean | null;
    updatedAt: string | null;
  } | null;
  health: string;
  metadataResolved?: boolean;
  orderId: string;
  orderName: string;
  phone: string | null;
  planningStatus: string;
  recipientName: string | null;
  routeEligible?: boolean;
  routePlanId: string | null;
  routePlanName: string | null;
  serviceType: string | null;
  shippingAddress: {
    address1: string | null;
    address2: string | null;
    city: string | null;
    countryCode: string | null;
    postalCode: string | null;
    province: string | null;
  };
  sourceOrderId: string | null;
  sourceOrderNumber: string | null;
  sourceCreatedAt: string | null;
  sourceCreatedDate: string | null;
  sourcePlatform: string | null;
  sourceUpdatedAt: string | null;
  sourceUpdatedDate: string | null;
  status: string | null;
  stopId: string | null;
  timeWindowEnd: string | null;
  timeWindowStart: string | null;
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
  routeEndMode: "END_AT_LAST_STOP" | "RETURN_TO_DEPOT";
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
  routeGeometry: {
    coordinates: Array<[number, number]>;
    type: "LineString";
  } | null;
  routePlan: RoutePlanSummaryDto;
  routeStopPoints: Array<{
    deliveryStopId: string;
    inputCoordinates: [number, number] | null;
    name: string | null;
    sequence: number;
    snapDistanceMeters: number | null;
    snappedCoordinates: [number, number] | null;
    sourceOrderId: string;
  }>;
  stops: RouteStopDto[];
};

export type DriverDto = {
  appLinked: boolean;
  authStatus: string;
  createdAt: string;
  displayName: string;
  id: string;
  inviteCode: string | null;
  inviteCodeExpiresAt: string | null;
  lastSeenAt: string | null;
  phone: string | null;
  recentEventsCount: number;
  status: string;
  updatedAt: string;
};

export type StoreSettingsDto = {
  defaultDepotAddress: string | null;
  defaultDepotLatitude: number | null;
  defaultDepotLongitude: number | null;
  locale: AppLocale;
  routeScopeConfig: RouteScopeConfigDto;
  shopDomain: string;
};

export type RouteScopeValueDto = {
  builtIn: boolean;
  description: string | null;
  enabled: boolean;
  example: string | null;
  label: string;
  value: string;
};

export type RouteScopeConfigDto = {
  deliverySessions: RouteScopeValueDto[];
  serviceTypes: RouteScopeValueDto[];
  timeWindow: {
    endExample: string;
    helpText: string;
    startExample: string;
  };
  version: 1;
};

export type GeocodeOrderResponse = {
  geocode: {
    cached: boolean;
    ok: true;
    result: {
      addressLabel: string;
      latitude: number;
      longitude: number;
      provider: string;
      providerPlaceId: string | null;
      rawLabel?: string | null;
    };
  };
  order?: CanonicalOrderDto;
};

export type BulkGeocodeJobDto = {
  completedAt: string | null;
  counts: {
    attempted: number;
    failed: number;
    matched: number;
    noAddress: number;
    skippedAlreadyGeocoded: number;
    skippedByPolicy: number;
    succeeded: number;
  };
  createdAt: string;
  error: string | null;
  jobId: string;
  policyLimit?: {
    active: boolean;
    attemptedLimit: number | null;
    reached: boolean;
  };
  results: Array<Record<string, unknown>>;
  status: "accepted" | "completed" | "failed" | "running";
  updatedAt: string;
};

export type BulkGeocodeOrdersResponse = {
  geocode: BulkGeocodeJobDto;
};

export type WooSyncRunDto = {
  acceptedAt: string;
  completedAt: string | null;
  errorMessage: string | null;
  request: {
    modifiedAfter: string | null;
    pageSize: number;
    status: string | null;
  };
  result: {
    geocode: {
      failed: number;
      notRequired: number;
      pending: number;
      resolved: number;
    };
    pagesRead: number;
    sync: {
      created: number;
      needsReview: number;
      readyToPlan: number;
      received: number;
      skipped: number;
      unchanged: number;
      updated: number;
    };
    warnings: string[];
  } | null;
  startedAt: string | null;
  status: "FAILED" | "QUEUED" | "RUNNING" | "SUCCEEDED";
  syncRunId: string;
};

export type WooSyncResponse = {
  alreadyRunning: boolean;
  message: string;
  syncRun: WooSyncRunDto;
};

export type WooSyncStatusResponse = {
  syncRun: WooSyncRunDto | null;
};

export type GeocodeSettingsResponse = {
  geocode: {
    cached: boolean;
    ok: true;
    result: {
      addressLabel: string;
      latitude: number;
      longitude: number;
      provider: string;
      providerPlaceId: string | null;
      rawLabel?: string | null;
    };
  };
  settings: StoreSettingsDto;
};

export type OrderMutationResponse = {
  order: CanonicalOrderDto;
};

export type OrderMetadataDiagnosticsResponse = {
  diagnostics: DeliveryMetadataDiagnosticsDto | null;
  order: CanonicalOrderDto;
};

export type OrdersResponse = {
  orders: CanonicalOrderDto[];
  reviewBlockers: CanonicalOrderDto[];
};

export type RoutesResponse = {
  routePlans: RoutePlanSummaryDto[];
};

export type RouteDeleteResponse = {
  deleted: boolean;
  routePlanId: string;
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
