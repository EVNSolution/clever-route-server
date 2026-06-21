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
  driverApp: {
    installUrl: string | null;
  };
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

export type NormalizedPaymentStatus =
  | "PAID_CONFIRMED"
  | "CASH_COLLECT_REQUIRED"
  | "TRANSFER_CHECK_PENDING"
  | "ONLINE_PAYMENT_PENDING_OR_FAILED"
  | "NOT_DELIVERABLE_OR_EXCEPTION"
  | "UNKNOWN_REVIEW";

export type AdminNotificationSeverity =
  | "critical"
  | "info"
  | "success"
  | "warning";

export type AdminNotificationDto = {
  body: string | null;
  createdAt: string;
  href: string | null;
  id: string;
  orderId: string | null;
  payload:
    | Record<string, unknown>
    | unknown[]
    | string
    | number
    | boolean
    | null;
  readAt: string | null;
  routePlanId: string | null;
  severity: AdminNotificationSeverity;
  title: string;
  type: string;
};

export type CanonicalOrderDto = {
  blockerReasons: string[];
  coordinates: { latitude: number | null; longitude: number | null };
  customerNote?: string | null;
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
  items?: OrderItemDto[];
  metadataResolved?: boolean;
  normalizedPaymentReason?: string | null;
  normalizedPaymentStatus?: NormalizedPaymentStatus | null;
  orderId: string;
  orderName: string;
  paidAt?: string | null;
  paymentMethodFamily?: string | null;
  paymentMethodId?: string | null;
  paymentMethodTitle?: string | null;
  paymentReviewReason?: string | null;
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
  transactionId?: string | null;
  wooOrderStatus?: string | null;
};

export type OrderItemOptionDto = {
  key: string;
  value: string;
};

export type OrderItemDto = {
  name: string;
  options: OrderItemOptionDto[];
  productId: number;
  quantity: number;
  sku: string | null;
  variationId: number;
};

export type RouteItemSummaryDto = {
  changedSincePublish: boolean;
  fingerprint: string;
  itemTypes: number;
  items: OrderItemDto[];
  totalQuantity: number;
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
  itemSummary?: RouteItemSummaryDto;
  missingCoordinates: number;
  name: string;
  planDate: string;
  routeEndMode: "END_AT_LAST_STOP" | "RETURN_TO_DEPOT";
  routeGroupingChild?: {
    groupingId: string;
    status: string;
    version: number;
  } | null;
  status: string;
  stopsCount: number;
  updatedAt: string;
};

export type RouteStopDto = {
  addressLabel: string;
  customerNoteContext?: {
    adminMemo: string | null;
    customerNote: string | null;
    deliveryCustomerProfileId: string | null;
    matchReasons: unknown;
    matchStatus: string | null;
  };
  coordinates: { latitude: number | null; longitude: number | null };
  deliveryArea: string | null;
  deliveryStopId: string;
  items: OrderItemDto[];
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
  routeGeometryGeneratedAt?: string | null;
  routeGeometrySource?: string | null;
  routeGeometryStatus?: "fresh" | "missing" | "stale" | "unavailable";
  routeShapeSignature?: string;
  routePlan: RoutePlanSummaryDto;
  routeStopPoints: Array<{
    deliveryStopId: string;
    items: OrderItemDto[];
    inputCoordinates: [number, number] | null;
    name: string | null;
    sequence: number;
    snapDistanceMeters: number | null;
    snappedCoordinates: [number, number] | null;
    sourceOrderId: string;
  }>;
  stops: RouteStopDto[];
};


export type RouteGroupingChildDto = {
  childVersion: number;
  displayStatus: "DRAFT" | "PUBLISHED" | "NEEDS_REPUBLISH" | "SUPERSEDED";
  driverId: string | null;
  driverName: string | null;
  notificationStatus: "NOT_REQUIRED" | "PENDING" | "SENT" | "FAILED";
  routePlan: RoutePlanSummaryDto | null;
  routePlanId: string | null;
  stopsCount: number;
};

export type RouteGroupingAssignmentDto = {
  assignedDriverId: string | null;
  assignedPolygonId: string | null;
  assignmentStatus: "UNASSIGNED" | "ASSIGNED" | "OVERLAP" | "EXCLUDED";
  coordinates: { latitude: number | null; longitude: number | null };
  deliveryStopId: string;
  orderId: string;
  orderName: string;
  items: OrderItemDto[];
  sourceOrderId: string;
  sourceSequence: number;
};

export type RouteGroupingPolygonDto = {
  closed: boolean;
  color: string | null;
  drawOrder: number;
  driverId: string | null;
  geometry: unknown;
  id: string;
  label: string;
};

export type RouteGroupingWarningDto = {
  code: "DRIVER_ASSIGNED" | "DRIVER_NOTIFICATION_SENT" | "CUSTOMER_NOTIFICATION_SENT_OR_QUEUED";
  message: string;
  orderIds?: string[];
  routePlanIds?: string[];
};

export type RouteGroupingSummaryDto = {
  children: RouteGroupingChildDto[];
  currentVersion: number;
  displayStatus: "DRAFT" | "NEEDS_ASSIGNMENT" | "READY" | "PUBLISHED" | "CHANGED" | "CANCELLED";
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
  polygons: RouteGroupingPolygonDto[];
};

export type RouteSaveOperationDto = {
  name: "driver" | "options" | "publish" | "stops";
  reason: string;
  status: "applied" | "skipped";
};

export type RouteSaveResponse = RoutePlanDetailDto & {
  saveOperations?: RouteSaveOperationDto[];
};

export type RouteOptimizationJobStatus =
  | "APPLIED"
  | "CANCELLED"
  | "FAILED"
  | "QUEUED"
  | "RUNNING"
  | "TIMEOUT";

export type RouteOptimizationJobStep =
  | "APPLYING_RESULT"
  | "CALLING_ENGINE"
  | "COMPLETED"
  | "QUEUED";

export type RouteOptimizationJobDto = {
  appliedAt: string | null;
  createdAt: string;
  createdBy: string | null;
  currentStep: RouteOptimizationJobStep;
  elapsedMs: number | null;
  engineResultSequence: unknown;
  errorCode: string | null;
  errorMessage: string | null;
  finishedAt: string | null;
  id: string;
  invalidatedReason: string | null;
  routePlanId: string;
  shopId: string;
  startedAt: string | null;
  status: RouteOptimizationJobStatus;
  timeoutBudgetMs: number;
  traceId: string;
  updatedAt: string;
};

export type RouteOptimizationJobResponse = {
  job: RouteOptimizationJobDto | null;
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

export type RouteOpsUiReminderPlanDto = {
  daysBefore: number;
  id: string;
  timeOfDay: string;
};

export type RouteOpsUiSettingsDto = {
  destinationDwellMinutes: number | null;
  emailNotifications: {
    enabled: boolean;
    reminderPlans: RouteOpsUiReminderPlanDto[];
    template: {
      body: string;
      subject: string;
    };
  };
  version: 1;
};

export type StoreSettingsDto = {
  defaultDepotAddress: string | null;
  defaultDepotLatitude: number | null;
  defaultDepotLongitude: number | null;
  locale: AppLocale;
  routeOpsUiSettings: RouteOpsUiSettingsDto;
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
    alreadyHasCoordinates: number;
    attempted: number;
    failed: number;
    matched: number;
    noAddress: number;
    succeeded: number;
  };
  createdAt: string;
  error: string | null;
  jobId: string;
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


export type OrderCustomerNoteContextDto = {
  customerNote: string | null;
  deliveryCustomer: {
    adminMemo: string | null;
    matchReasons: string[];
    matchStatus: "AUTO_MATCHED" | "CREATED_NEW";
    profileId: string;
  } | null;
  orderId: string;
};

export type OrderCustomerNoteContextResponse = OrderCustomerNoteContextDto;

export type DeliveryCustomerAdminMemoResponse = {
  deliveryCustomer: {
    adminMemo: string | null;
    profileId: string;
  };
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

export type NotificationsResponse = {
  notifications: AdminNotificationDto[];
  unreadCount: number;
};

export type NotificationMutationResponse = {
  notification: AdminNotificationDto;
};

export type RoutesResponse = {
  routeGroups?: RouteGroupingSummaryDto[];
  routePlans: RoutePlanSummaryDto[];
  standaloneRoutes?: RoutePlanSummaryDto[];
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
