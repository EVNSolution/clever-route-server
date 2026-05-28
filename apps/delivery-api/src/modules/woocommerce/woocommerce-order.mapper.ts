import type {
  DeliveryDayParseStatus,
  DeliveryServiceType,
  DeliveryWeekday,
  SyncedDeliveryStopInput,
  SyncedOrderWithDeliveryStopInput,
  ShopifyOrderLineItem,
} from "../shopify/order-sync.mapper.js";
import {
  calculateDeliveryScope,
  parseDeliveryServiceRaw,
  parseDeliveryTimeWindow,
  verifyDeliveryDayRaw,
} from "../shopify/order-delivery-scope.js";
import type {
  DeliveryTimeWindowParseResult,
} from "../shopify/order-delivery-scope.js";
import type {
  WooCommerceAddress,
  WooCommerceLineItem,
  WooCommerceMetaData,
  WooCommerceOrder,
  WooCommerceShippingLine,
} from "./woocommerce-order.types.js";

const DELIVERY_DATE_KEYS = [
  "delivery date",
  "delivery_date",
  "deliverydate",
  "tomatono_delivery_date",
  "_delivery_date",
  "order_delivery_date",
  "jckwds_date",
];
const DELIVERY_DAY_KEYS = [
  "delivery day",
  "delivery_day",
  "deliveryday",
  "tomatono_delivery_day",
  "_delivery_day",
  "order_delivery_day",
  "jckwds_timeslot",
];
const DELIVERY_AREA_KEYS = [
  "delivery area",
  "delivery_area",
  "deliveryarea",
  "tomatono_delivery_area",
  "_delivery_area",
];
const TIME_WINDOW_KEYS = [
  "delivery time",
  "delivery_time",
  "delivery timeslot",
  "delivery_timeslot",
  "jckwds_timeslot",
  "time_slot",
  "timeslot",
];
const NORMALIZED_TIME_WINDOW_KEYS = new Set(
  TIME_WINDOW_KEYS.map(normalizeMetaKey).filter(
    (key): key is string => key !== null,
  ),
);

export type WooOrderMappingConfig = {
  areaPaths?: string[];
  datePaths?: string[];
  dayPaths?: string[];
  grouping?: "date_session" | "date_session_area";
  instructionPaths?: string[];
  pickupPaths?: string[];
  serviceMinutesDefault?: number;
  timeWindowPaths?: string[];
  version?: number;
};

export type MapWooCommerceOrderOptions = {
  connectionId?: string | null;
  mappingConfig?: WooOrderMappingConfig | null;
  siteUrl: string;
  shopTimezone?: string;
};

type NormalizedMetaData = {
  key: string;
  path: string;
  value: string;
};

type UnsupportedMetaValue = {
  key: string;
  path: string;
  type: string;
};

type CollectedMetaData = {
  key: string;
  path: string;
  unsupported?: UnsupportedMetaValue[];
  value: string | null;
};

type DeliveryMetadataCandidate = {
  deliverySession: "DAY" | "EVENING" | null;
  path: string;
  parseStatus: DeliveryDayParseStatus | "IGNORED";
  serviceType: Exclude<DeliveryServiceType, "PICKUP"> | null;
  source:
    | "configured"
    | "known_key"
    | "shipping_label"
    | "line_item_label"
    | "fallback";
  timeWindowEnd: string | null;
  timeWindowExpected: boolean;
  timeWindowStart: string | null;
  timeWindowAmbiguous: boolean;
  trust: "high" | "medium" | "low";
  value: string;
  valuePreview: string;
  weekday: DeliveryWeekday | null;
  weekdayAmbiguous: boolean;
};

type DeliveryDayArbitration = {
  ambiguous: boolean;
  candidates: DeliveryMetadataCandidate[];
  conflictTimeWindows: string[];
  conflictWeekdays: string[];
  rawDeliveryDay: string | null;
  rawDeliveryTimeWindow: string | null;
  scopeDeliveryDayRaw: string | null;
  selectedTimeWindow: DeliveryTimeWindowParseResult | null;
  timeWindowAmbiguous: boolean;
  timeWindowUnparsed: boolean;
  timeWindowPath: string | null;
  weekdayAmbiguous: boolean;
};

export function mapWooCommerceOrderToDeliveryInputs(
  order: WooCommerceOrder,
  options: MapWooCommerceOrderOptions,
): SyncedOrderWithDeliveryStopInput {
  const siteUrl = normalizeSiteUrl(options.siteUrl);
  const host = new URL(siteUrl).host;
  const metadata = collectMetaData(order);
  const deliveryDateMatch = readMappedMeta(
    metadata.items,
    options.mappingConfig?.datePaths,
    DELIVERY_DATE_KEYS,
  );
  const deliveryDayMatch = readMappedMeta(
    metadata.items,
    options.mappingConfig?.dayPaths,
    DELIVERY_DAY_KEYS,
  );
  const deliveryTimeWindowMatch = readMappedMeta(
    metadata.items,
    options.mappingConfig?.timeWindowPaths,
    TIME_WINDOW_KEYS,
  );
  const deliveryAreaMatch = readMappedMeta(
    metadata.items,
    options.mappingConfig?.areaPaths,
    DELIVERY_AREA_KEYS,
  );
  const deliveryDateRaw = deliveryDateMatch.value;
  const dayArbitration = arbitrateDeliveryDayCandidates({
    configuredDayPaths: options.mappingConfig?.dayPaths,
    configuredTimeWindowPaths: options.mappingConfig?.timeWindowPaths,
    deliveryDayMatch,
    deliveryTimeWindowMatch,
    items: metadata.items,
  });
  const deliveryDayRaw = dayArbitration.rawDeliveryDay;
  const deliveryArea =
    deliveryAreaMatch.value ??
    normalizeString(order.shipping?.city) ??
    normalizeString(order.billing?.city);
  const lineItems = normalizeLineItems(order.line_items ?? []);
  const createdAt = readWooDate(order.date_created_gmt, order.date_created);
  const modifiedAt =
    readWooDate(order.date_modified_gmt, order.date_modified) ??
    createdAt ??
    new Date(0);
  const scope = calculateDeliveryScope({
    createdAt: createdAt?.toISOString() ?? null,
    deliveryArea,
    deliveryDateRaw,
    deliveryDayRaw: dayArbitration.scopeDeliveryDayRaw,
    deliveryTimeWindow: dayArbitration.selectedTimeWindow,
    lineItems,
    pickupDayRaw: null,
    processedAt: createdAt?.toISOString() ?? null,
    weekdayFallbackPolicy: "ORDER_WEEK",
    ...(options.shopTimezone === undefined
      ? {}
      : { shopTimezone: options.shopTimezone }),
  });
  const dayVerification = verifyDeliveryDayRaw(deliveryDayRaw, {
    pickup: false,
  });
  const deliveryDayParseStatus: DeliveryDayParseStatus =
    deliveryDayRaw === null
      ? "NOT_PROVIDED"
      : dayArbitration.ambiguous ||
          dayArbitration.timeWindowAmbiguous ||
          dayVerification.ambiguous
        ? "UNVERIFIED"
        : dayVerification.verified
          ? "PARSED"
          : "UNPARSED";
  const deliveryDateWeekdayVerified =
    deliveryDayRaw !== null &&
    dayVerification.verified &&
    scope.deliveryDateWeekday !== null;
  const shippingAddress = selectAddress(
    order.shipping ?? null,
    order.billing ?? null,
  );
  const hasAddressValue =
    shippingAddress !== null && hasAddress(shippingAddress);
  const reviewReasons = buildReviewReasons({
    deliveryArea,
    deliveryDate: scope.deliveryDate,
    deliveryDateSource: scope.deliveryDateSource,
    deliveryDayAmbiguous:
      dayArbitration.weekdayAmbiguous || dayVerification.weekdayAmbiguous,
    deliveryDayParseStatus,
    deliveryDateWeekdayMismatch: scope.deliveryDateWeekdayMismatch,
    deliveryTimeWindowAmbiguous: dayArbitration.timeWindowAmbiguous,
    deliveryTimeWindowUnparsed: dayArbitration.timeWindowUnparsed,
    hasAddress: hasAddressValue,
    orderCreatedAt: scope.orderCreatedAt,
    routeScopeKey: scope.routeScopeKey,
    status: normalizeString(order.status),
    serviceType: scope.serviceType,
  });
  const readiness =
    scope.deliveryDate === null ||
    scope.routeScopeKey === null ||
    reviewReasons.length > 0
      ? "NEEDS_REVIEW"
      : "READY_TO_PLAN";
  const phone =
    normalizeString(order.billing?.phone) ??
    normalizeString(order.shipping?.phone) ??
    null;
  const recipientName =
    shippingAddress === null ? null : formatAddressName(shippingAddress);
  const orderNumber = normalizeString(order.number) ?? String(order.id);
  const syntheticGid = `woocommerce://${host}/orders/${order.id}`;
  const rawPayload = buildRawPayload({
    deliveryArea,
    deliveryDateRaw,
    deliveryDayRaw,
    deliveryDayParseStatus,
    deliveryDayUnparsedReason:
      deliveryDayParseStatus === "UNPARSED"
        ? "unrecognized_woo_delivery_day_or_time"
        : null,
    deliveryDateWeekdayVerified,
    deliveryTimeWindowRaw: dayArbitration.rawDeliveryTimeWindow,
    lineItems,
    mappingDiagnostics: buildMappingDiagnostics(metadata, dayArbitration),
    matchedMappingPaths: {
      deliveryArea: deliveryAreaMatch.path,
      deliveryDate: deliveryDateMatch.path,
      deliveryDay: deliveryDayMatch.path,
      deliveryTimeWindow: dayArbitration.timeWindowPath,
    },
    metadataKeys: metadata.items.map((item) => item.key),
    order,
    readiness,
    reviewReasons,
    scope,
    shippingAddress,
  });

  return {
    deliveryFact: {
      batchEligible: readiness === "READY_TO_PLAN",
      commerceConnectionId: options.connectionId ?? null,
      deliveryArea,
      deliveryDate: scope.deliveryDate,
      deliveryDateWeekday: scope.deliveryDateWeekday,
      deliveryDateWeekdayMismatch: scope.deliveryDateWeekdayMismatch,
      deliveryDateWeekdayVerified,
      deliveryDayParseStatus,
      deliveryDayUnparsedReason:
        deliveryDayParseStatus === "UNPARSED"
          ? "unrecognized_woo_delivery_day_or_time"
          : null,
      deliverySession: scope.deliverySession,
      deliveryWeekday: scope.deliveryWeekday,
      geocodeStatus: "PENDING",
      mappingDiagnostics: buildMappingDiagnostics(metadata, dayArbitration),
      matchedMappingPaths: {
        deliveryArea: deliveryAreaMatch.path,
        deliveryDate: deliveryDateMatch.path,
        deliveryDay: deliveryDayMatch.path,
        deliveryTimeWindow: dayArbitration.timeWindowPath,
      },
      planningGroupKey: scope.planningGroupKey,
      rawDeliveryArea: deliveryAreaMatch.value,
      rawDeliveryDate: deliveryDateRaw,
      rawDeliveryDay: deliveryDayRaw,
      rawDeliveryTimeWindow: dayArbitration.rawDeliveryTimeWindow,
      rawPickupDay: null,
      readiness,
      reviewReasons,
      routeScopeKey: scope.routeScopeKey,
      serviceType: scope.serviceType,
      sourceOrderId: String(order.id),
      sourceOrderNumber: orderNumber,
      sourcePlatform: "WOOCOMMERCE",
      sourceSiteUrl: siteUrl,
      sourceUpdatedAt: modifiedAt,
      timeWindowEnd: scope.timeWindowEnd,
      timeWindowStart: scope.timeWindowStart,
    },
    deliveryStop:
      shippingAddress === null
        ? null
        : mapAddressToDeliveryStop({
            address: shippingAddress,
            deliveryDate: scope.deliveryDate,
            instructions: normalizeString(order.customer_note),
            phone,
            recipientName,
            timeWindowEnd: scope.timeWindowEnd,
            timeWindowStart: scope.timeWindowStart,
          }),
    order: {
      cancelledAt: isCancelledLike(order.status) ? modifiedAt : null,
      currencyCode: normalizeString(order.currency),
      deliveryArea,
      deliveryBatchEndDate: scope.deliveryBatchEndDate,
      deliveryBatchStartDate: scope.deliveryBatchStartDate,
      deliveryDate: scope.deliveryDate,
      deliveryDateSource: scope.deliveryDateSource,
      deliveryDayRaw,
      deliverySession: scope.deliverySession,
      deliveryWeekday: scope.deliveryWeekday,
      email: normalizeString(order.billing?.email),
      financialStatus:
        normalizeString(order.payment_method_title) ??
        normalizeString(order.payment_method),
      fulfillmentStatus: normalizeString(order.status)?.toUpperCase() ?? null,
      name: `#${orderNumber.replace(/^#/u, "")}`,
      orderCreatedAt: scope.orderCreatedAt,
      orderDateLocal: scope.orderDateLocal,
      phone,
      pickup: false,
      planningGroupKey: scope.planningGroupKey,
      processedAt: createdAt,
      rawPayload,
      readiness,
      reviewReasons,
      routeScopeKey: scope.routeScopeKey,
      serviceType: scope.serviceType,
      shopifyOrderGid: syntheticGid,
      shopifyOrderLegacyId: null,
      sourceOrderId: String(order.id),
      sourceOrderNumber: orderNumber,
      sourcePlatform: "WOOCOMMERCE",
      sourceSiteUrl: siteUrl,
      sourceUpdatedAt: modifiedAt,
      timeWindowEnd: scope.timeWindowEnd,
      timeWindowStart: scope.timeWindowStart,
      totalPriceAmount: normalizeString(order.total),
      updatedAtShopify: modifiedAt,
    },
  } satisfies SyncedOrderWithDeliveryStopInput;
}

function buildRawPayload(input: {
  deliveryArea: string | null;
  deliveryDateRaw: string | null;
  deliveryDayRaw: string | null;
  deliveryDayParseStatus: DeliveryDayParseStatus;
  deliveryDayUnparsedReason: string | null;
  deliveryDateWeekdayVerified: boolean;
  deliveryTimeWindowRaw: string | null;
  lineItems: ShopifyOrderLineItem[];
  mappingDiagnostics: Record<string, unknown>;
  matchedMappingPaths: Record<string, string | null>;
  metadataKeys: string[];
  order: WooCommerceOrder;
  readiness: "READY_TO_PLAN" | "NEEDS_REVIEW" | "SKIPPED";
  reviewReasons: string[];
  scope: ReturnType<typeof calculateDeliveryScope>;
  shippingAddress: WooCommerceAddress | null;
}): Record<string, unknown> {
  return {
    ...input.order,
    deliveryArea: input.deliveryArea,
    deliveryBatchEndDate: input.scope.deliveryBatchEndDate,
    deliveryBatchStartDate: input.scope.deliveryBatchStartDate,
    deliveryDate: input.scope.deliveryDate,
    deliveryDateRaw: input.deliveryDateRaw,
    deliveryDateSource: input.scope.deliveryDateSource,
    deliveryDateWeekday: input.scope.deliveryDateWeekday,
    deliveryDateWeekdayMismatch: input.scope.deliveryDateWeekdayMismatch,
    deliveryDateWeekdayVerified: input.deliveryDateWeekdayVerified,
    deliveryDayParseStatus: input.deliveryDayParseStatus,
    deliveryDayRaw: input.deliveryDayRaw,
    deliveryDayUnparsedReason: input.deliveryDayUnparsedReason,
    deliverySession: input.scope.deliverySession,
    deliveryTimeWindowRaw: input.deliveryTimeWindowRaw,
    deliveryWeekday: input.scope.deliveryWeekday,
    lineItems: input.lineItems,
    mappingDiagnostics: input.mappingDiagnostics,
    matchedMappingPaths: input.matchedMappingPaths,
    metadataKeys: input.metadataKeys,
    orderCreatedAt: input.scope.orderCreatedAt,
    orderDateLocal: input.scope.orderDateLocal,
    pickup: false,
    planningGroupKey: input.scope.planningGroupKey,
    readiness: input.readiness,
    reviewReasons: input.reviewReasons,
    routeScopeKey: input.scope.routeScopeKey,
    serviceType: input.scope.serviceType,
    shippingAddress:
      input.shippingAddress === null
        ? null
        : toCanonicalShippingAddress(input.shippingAddress),
    sourcePlatform: "WOOCOMMERCE",
    timeWindowEnd: input.scope.timeWindowEnd,
    timeWindowStart: input.scope.timeWindowStart,
  };
}

function mapAddressToDeliveryStop(input: {
  address: WooCommerceAddress;
  deliveryDate: string | null;
  instructions: string | null;
  phone: string | null;
  recipientName: string | null;
  timeWindowEnd: string | null;
  timeWindowStart: string | null;
}): SyncedDeliveryStopInput {
  return {
    address1: normalizeString(input.address.address_1),
    address2: normalizeString(input.address.address_2),
    city: normalizeString(input.address.city),
    countryCode: normalizeString(input.address.country),
    deliveryDate: input.deliveryDate,
    geocodeStatus: "PENDING",
    instructions: input.instructions,
    latitude: null,
    longitude: null,
    phone: input.phone,
    postalCode: normalizeString(input.address.postcode),
    province: normalizeString(input.address.state),
    recipientName: input.recipientName,
    timeWindowEnd: input.timeWindowEnd,
    timeWindowStart: input.timeWindowStart,
  };
}

function selectAddress(
  shipping: WooCommerceAddress | null,
  billing: WooCommerceAddress | null,
): WooCommerceAddress | null {
  if (shipping !== null && hasAddress(shipping)) return shipping;
  if (billing !== null && hasAddress(billing)) return billing;
  return shipping ?? billing;
}

function hasAddress(address: WooCommerceAddress): boolean {
  return [
    address.address_1,
    address.city,
    address.postcode,
    address.country,
  ].some((value) => normalizeString(value) !== null);
}

function toCanonicalShippingAddress(
  address: WooCommerceAddress,
): Record<string, string | null> {
  return {
    address1: normalizeString(address.address_1),
    address2: normalizeString(address.address_2),
    city: normalizeString(address.city),
    countryCode: normalizeString(address.country),
    postalCode: normalizeString(address.postcode),
    province: normalizeString(address.state),
  };
}

function formatAddressName(address: WooCommerceAddress): string | null {
  const firstName = normalizeString(address.first_name);
  const lastName = normalizeString(address.last_name);
  const joined = [firstName, lastName]
    .flatMap((value) => (value === null ? [] : [value]))
    .join(" ")
    .trim();
  return joined === "" ? normalizeString(address.company) : joined;
}

function buildReviewReasons(input: {
  deliveryArea: string | null;
  deliveryDate: string | null;
  deliveryDateSource: string;
  deliveryDayAmbiguous: boolean;
  deliveryDayParseStatus: DeliveryDayParseStatus;
  deliveryDateWeekdayMismatch: boolean;
  deliveryTimeWindowAmbiguous: boolean;
  deliveryTimeWindowUnparsed: boolean;
  hasAddress: boolean;
  orderCreatedAt: string | null;
  routeScopeKey: string | null;
  serviceType: string | null;
  status: string | null;
}): string[] {
  const reasons: string[] = [];
  if (!input.hasAddress) reasons.push("missing_address");
  if (input.deliveryArea === null) reasons.push("missing_delivery_area");
  if (
    input.orderCreatedAt === null &&
    input.deliveryDateSource !== "EXPLICIT_ATTRIBUTE"
  )
    reasons.push("missing_order_date");
  if (input.deliveryDate === null) reasons.push("missing_delivery_date");
  if (input.deliveryDayParseStatus === "UNPARSED")
    reasons.push("delivery_day_unparsed");
  if (input.deliveryDayParseStatus === "UNVERIFIED")
    reasons.push(
      input.deliveryDayAmbiguous
        ? "ambiguous_delivery_day"
        : "delivery_date_weekday_unverified",
    );
  if (input.deliveryDateWeekdayMismatch)
    reasons.push("delivery_date_weekday_mismatch");
  if (input.deliveryTimeWindowAmbiguous)
    reasons.push("ambiguous_delivery_time_window");
  if (input.deliveryTimeWindowUnparsed)
    reasons.push("delivery_time_window_unparsed");
  if (input.routeScopeKey === null || input.serviceType === null)
    reasons.push("missing_route_scope");
  if (isNonDeliverableStatus(input.status))
    reasons.push(`non_deliverable_status:${input.status}`);
  return reasons;
}

function isCancelledLike(status: string | null | undefined): boolean {
  const normalized = normalizeString(status)?.toLowerCase() ?? null;
  return (
    normalized === "cancelled" ||
    normalized === "refunded" ||
    normalized === "failed" ||
    normalized === "trash"
  );
}

function isNonDeliverableStatus(status: string | null): boolean {
  return (
    status === "cancelled" ||
    status === "refunded" ||
    status === "failed" ||
    status === "trash"
  );
}

function normalizeLineItems(
  items: WooCommerceLineItem[],
): ShopifyOrderLineItem[] {
  return items.map((item) => ({
    name: normalizeString(item.name),
    quantity:
      typeof item.quantity === "number" && Number.isFinite(item.quantity)
        ? item.quantity
        : null,
    sku: normalizeString(item.sku),
    title: normalizeString(item.name),
    variantTitle: null,
  }));
}

function collectMetaData(order: WooCommerceOrder): {
  items: NormalizedMetaData[];
  unsupported: UnsupportedMetaValue[];
} {
  const collected = [
    ...flattenMetaData(order.meta_data ?? [], "meta_data"),
    ...flattenLineItemMetaData(order.line_items ?? []),
    ...flattenShippingLineMetaData(order.shipping_lines ?? []),
  ];
  return {
    items: collected.flatMap((item) =>
      item.value === null
        ? []
        : [{ key: item.key, path: item.path, value: item.value }],
    ),
    unsupported: collected.flatMap((item) => item.unsupported ?? []),
  };
}

function flattenLineItemMetaData(
  items: WooCommerceLineItem[],
): CollectedMetaData[] {
  return items.flatMap((item, index) => [
    ...flattenMetaData(item.meta_data ?? [], `line_items[${index}].meta_data`),
    ...flattenLiteralMetaCandidates(
      [{ key: "name", value: item.name }],
      `line_items[${index}]`,
    ),
  ]);
}

function flattenShippingLineMetaData(
  lines: WooCommerceShippingLine[],
): CollectedMetaData[] {
  return lines.flatMap((line, index) => [
    ...flattenMetaData(
      line.meta_data ?? [],
      `shipping_lines[${index}].meta_data`,
    ),
    ...flattenLiteralMetaCandidates(
      [
        { key: "method_id", value: line.method_id },
        { key: "method_title", value: line.method_title },
      ],
      `shipping_lines[${index}]`,
    ),
  ]);
}

function flattenLiteralMetaCandidates(
  items: Array<{ key: string; value: unknown }>,
  basePath: string,
): CollectedMetaData[] {
  return items.flatMap<CollectedMetaData>((item) => {
    const key = normalizeMetaKey(item.key);
    if (key === null) return [];
    const normalizedValue = normalizeMetaValue(item.value);
    if (normalizedValue === null) return [];
    return [{ key, path: `${basePath}.${key}`, value: normalizedValue }];
  });
}

function flattenMetaData(
  items: WooCommerceMetaData[],
  basePath: string,
): CollectedMetaData[] {
  return items.flatMap<CollectedMetaData>((item) => {
    const key = normalizeMetaKey(item.key);
    if (key === null) return [];
    const path = `${basePath}.${key}`;
    const value = normalizeMetaValue(item.value);
    if (value !== null)
      return [{ key, path, value } satisfies CollectedMetaData];
    if (item.value === null || item.value === undefined) return [];
    return [
      {
        key,
        path,
        unsupported: [
          {
            key,
            path,
            type: Array.isArray(item.value) ? "array" : typeof item.value,
          },
        ],
        value: null,
      } satisfies CollectedMetaData,
    ];
  });
}

function readMappedMeta(
  items: NormalizedMetaData[],
  configuredPaths: string[] | undefined,
  fallbackKeys: string[],
): { path: string | null; value: string | null } {
  const normalizedPaths = (configuredPaths ?? [])
    .map(normalizeMappingPath)
    .filter((path): path is string => path !== null);
  for (const configuredPath of normalizedPaths) {
    const match = items.find(
      (item) =>
        normalizeMappingPath(item.path) === configuredPath ||
        normalizeMetaKey(item.key) === configuredPath,
    );
    if (match !== undefined) return { path: match.path, value: match.value };
  }

  const wanted = new Set(
    fallbackKeys
      .map(normalizeMetaKey)
      .filter((key): key is string => key !== null),
  );
  const fallback = items.find((item) =>
    wanted.has(normalizeMetaKey(item.key) ?? ""),
  );
  return fallback === undefined
    ? { path: null, value: null }
    : { path: fallback.path, value: fallback.value };
}

function arbitrateDeliveryDayCandidates(input: {
  configuredDayPaths: string[] | undefined;
  configuredTimeWindowPaths: string[] | undefined;
  deliveryDayMatch: { path: string | null; value: string | null };
  deliveryTimeWindowMatch: { path: string | null; value: string | null };
  items: NormalizedMetaData[];
}): DeliveryDayArbitration {
  const configuredDayPaths = new Set(
    (input.configuredDayPaths ?? [])
      .map(normalizeMappingPath)
      .filter((path): path is string => path !== null),
  );
  const configuredTimeWindowPaths = new Set(
    (input.configuredTimeWindowPaths ?? [])
      .map(normalizeMappingPath)
      .filter((path): path is string => path !== null),
  );
  const configuredPaths = new Set([
    ...configuredDayPaths,
    ...configuredTimeWindowPaths,
  ]);
  const knownKeys = new Set(
    [...DELIVERY_DAY_KEYS, ...TIME_WINDOW_KEYS]
      .map(normalizeMetaKey)
      .filter((key): key is string => key !== null),
  );
  const excludedDateOrAreaKeys = new Set(
    [...DELIVERY_DATE_KEYS, ...DELIVERY_AREA_KEYS]
      .map(normalizeMetaKey)
      .filter((key): key is string => key !== null),
  );
  const candidates = input.items.flatMap<DeliveryMetadataCandidate>((item) => {
    const normalizedPath = normalizeMappingPath(item.path);
    const normalizedKey = normalizeMetaKey(item.key);
    if (normalizedKey !== null && excludedDateOrAreaKeys.has(normalizedKey))
      return [];
    const pathConfigured =
      (normalizedPath !== null && configuredPaths.has(normalizedPath)) ||
      (normalizedKey !== null && configuredPaths.has(normalizedKey));
    const timeWindowConfigured =
      (normalizedPath !== null &&
        configuredTimeWindowPaths.has(normalizedPath)) ||
      (normalizedKey !== null && configuredTimeWindowPaths.has(normalizedKey));
    const knownKey = normalizedKey !== null && knownKeys.has(normalizedKey);
    const timeWindowKnownKey =
      normalizedKey !== null && NORMALIZED_TIME_WINDOW_KEYS.has(normalizedKey);
    const deliveryTimeWindowMatchPath =
      input.deliveryTimeWindowMatch.path !== null &&
      item.path === input.deliveryTimeWindowMatch.path;
    const labelSource =
      item.path.includes("shipping_lines[") &&
      /^shipping_lines\[\d+\]\.(?:method_title|method_id)$/u.test(item.path)
        ? "shipping_label"
        : item.path.includes("line_items[") &&
            /^line_items\[\d+\]\.name$/u.test(item.path)
          ? "line_item_label"
          : null;
    const deliveryLooking =
      pathConfigured ||
      knownKey ||
      labelSource !== null ||
      containsDeliverySignal(item.value);
    if (!deliveryLooking) return [];

    const parsed = parseDeliveryServiceRaw(item.value, false);
    const timeWindow = parseDeliveryTimeWindow(item.value);
    const parseStatus: DeliveryMetadataCandidate["parseStatus"] =
      parsed.ambiguous
        ? "UNVERIFIED"
        : parsed.deliveryWeekday !== null ||
            (timeWindow.timeWindowStart !== null &&
              timeWindow.timeWindowEnd !== null)
          ? "PARSED"
          : containsDeliverySignal(item.value) || pathConfigured || knownKey
            ? "UNPARSED"
            : "IGNORED";
    if (parseStatus === "IGNORED") return [];
    const source: DeliveryMetadataCandidate["source"] = pathConfigured
      ? "configured"
      : knownKey
        ? "known_key"
        : (labelSource ?? "fallback");
    const trust: DeliveryMetadataCandidate["trust"] =
      source === "configured" || source === "known_key"
        ? "high"
        : source === "fallback"
          ? "medium"
          : "low";
    return [
      {
        deliverySession: timeWindow.deliverySession,
        path: item.path,
        parseStatus,
        serviceType: timeWindow.serviceType,
        source,
        timeWindowAmbiguous: timeWindow.ambiguous,
        timeWindowEnd: timeWindow.timeWindowEnd,
        timeWindowExpected:
          timeWindowConfigured ||
          timeWindowKnownKey ||
          deliveryTimeWindowMatchPath,
        timeWindowStart: timeWindow.timeWindowStart,
        trust,
        value: item.value,
        valuePreview: redactCandidateValue(item.value, item.path),
        weekday: parsed.deliveryWeekday,
        weekdayAmbiguous: parsed.weekdayAmbiguous,
      },
    ];
  });

  const parsedCandidates = candidates.filter(
    (candidate) => candidate.weekday !== null,
  );
  const parsedTimeCandidates = candidates.filter(
    (candidate) =>
      candidate.timeWindowStart !== null && candidate.timeWindowEnd !== null,
  );
  const conflictWeekdays = [
    ...new Set(
      parsedCandidates
        .map((candidate) => candidate.weekday)
        .filter((weekday): weekday is DeliveryWeekday => weekday !== null),
    ),
  ];
  const conflictTimeWindows = [
    ...new Set(
      parsedTimeCandidates.flatMap((candidate) =>
        candidate.timeWindowStart === null || candidate.timeWindowEnd === null
          ? []
          : [`${candidate.timeWindowStart}|${candidate.timeWindowEnd}`],
      ),
    ),
  ];
  const weekdayAmbiguous =
    conflictWeekdays.length > 1 ||
    candidates.some((candidate) => candidate.weekdayAmbiguous);
  const timeWindowAmbiguous =
    conflictTimeWindows.length > 1 ||
    candidates.some((candidate) => candidate.timeWindowAmbiguous);
  const timeWindowUnparsed = candidates.some(
    (candidate) =>
      candidate.timeWindowExpected && candidate.parseStatus === "UNPARSED",
  );
  const ambiguous = weekdayAmbiguous || timeWindowAmbiguous;
  const selected = selectBestDeliveryDayCandidate(
    parsedCandidates,
    input.deliveryDayMatch.path,
  );
  const selectedTimeWindow = selectBestDeliveryTimeWindowCandidate(
    parsedTimeCandidates,
    input.deliveryTimeWindowMatch.path,
  );
  const fallbackUnparsed =
    candidates.find((candidate) => candidate.parseStatus === "UNPARSED") ??
    null;
  const rawDeliveryDay =
    input.deliveryDayMatch.value ??
    selected?.value ??
    fallbackUnparsed?.value ??
    null;
  const rawDeliveryTimeWindow =
    input.deliveryTimeWindowMatch.value ?? selectedTimeWindow?.value ?? null;
  return {
    ambiguous,
    candidates,
    conflictTimeWindows,
    conflictWeekdays,
    rawDeliveryDay,
    rawDeliveryTimeWindow,
    scopeDeliveryDayRaw: ambiguous ? null : rawDeliveryDay,
    selectedTimeWindow:
      timeWindowAmbiguous || selectedTimeWindow === null
        ? null
        : {
            ambiguous: false,
            deliverySession: selectedTimeWindow.deliverySession,
            serviceType: selectedTimeWindow.serviceType,
            timeWindowEnd: selectedTimeWindow.timeWindowEnd,
            timeWindowStart: selectedTimeWindow.timeWindowStart,
          },
    timeWindowAmbiguous,
    timeWindowUnparsed,
    timeWindowPath:
      selectedTimeWindow?.path ?? input.deliveryTimeWindowMatch.path,
    weekdayAmbiguous,
  };
}

function selectBestDeliveryDayCandidate(
  candidates: DeliveryMetadataCandidate[],
  preferredPath: string | null,
): DeliveryMetadataCandidate | null {
  if (preferredPath !== null) {
    const preferred = candidates.find(
      (candidate) => candidate.path === preferredPath,
    );
    if (preferred !== undefined) return preferred;
  }
  const rank = { high: 0, medium: 1, low: 2 } satisfies Record<
    DeliveryMetadataCandidate["trust"],
    number
  >;
  return (
    [...candidates].sort(
      (left, right) => rank[left.trust] - rank[right.trust],
    )[0] ?? null
  );
}

function selectBestDeliveryTimeWindowCandidate(
  candidates: DeliveryMetadataCandidate[],
  preferredPath: string | null,
): DeliveryMetadataCandidate | null {
  if (preferredPath !== null) {
    const preferred = candidates.find(
      (candidate) => candidate.path === preferredPath,
    );
    if (preferred !== undefined) return preferred;
  }
  const rank = { high: 0, medium: 1, low: 2 } satisfies Record<
    DeliveryMetadataCandidate["trust"],
    number
  >;
  return (
    [...candidates].sort(
      (left, right) => rank[left.trust] - rank[right.trust],
    )[0] ?? null
  );
}

function buildMappingDiagnostics(
  metadata: {
    items: NormalizedMetaData[];
    unsupported: UnsupportedMetaValue[];
  },
  dayArbitration: DeliveryDayArbitration,
): Record<string, unknown> {
  const discoveredPathStats = metadata.items.reduce<Record<string, number>>(
    (stats, item) => {
      stats[item.path] = (stats[item.path] ?? 0) + 1;
      return stats;
    },
    {},
  );
  const hasParsedCandidate = dayArbitration.candidates.some(
    (candidate) => candidate.parseStatus === "PARSED",
  );
  const hasReviewCandidate = dayArbitration.candidates.some(
    (candidate) =>
      candidate.parseStatus === "UNPARSED" ||
      candidate.parseStatus === "UNVERIFIED",
  );
  const status = dayArbitration.ambiguous
    ? "NEEDS_REVIEW"
    : hasReviewCandidate
      ? "NEEDS_REVIEW"
      : hasParsedCandidate
        ? "RESOLVED"
        : "NOT_PROVIDED";

  return {
    deliveryMetadata: {
      candidateCount: dayArbitration.candidates.length,
      candidates: dayArbitration.candidates.slice(0, 25).map((candidate) => ({
        parseStatus: candidate.parseStatus,
        path: candidate.path,
        source: candidate.source,
        timeWindowEnd: candidate.timeWindowEnd,
        timeWindowStart: candidate.timeWindowStart,
        trust: candidate.trust,
        valuePreview: candidate.valuePreview,
        weekday: candidate.weekday,
      })),
      conflictTimeWindows: dayArbitration.conflictTimeWindows,
      conflictWeekdays: dayArbitration.conflictWeekdays,
      status,
    },
    discoveredPathStats,
    unsupportedValues: metadata.unsupported.slice(0, 25),
  };
}

function containsDeliverySignal(value: string): boolean {
  const normalized = value.toLowerCase();
  const timeWindow = parseDeliveryTimeWindow(value);
  if (
    timeWindow.ambiguous ||
    (timeWindow.timeWindowStart !== null && timeWindow.timeWindowEnd !== null)
  )
    return true;
  if (
    /\b(?:delivery|deliver|weekday|timeslot|time slot|pickup|shipping)\b/iu.test(
      normalized,
    )
  )
    return true;
  if (
    /\b(?:sun|mon|tue|wed|thu|thur|thurs|fri|sat)(?:day)?\b/iu.test(normalized)
  )
    return true;
  if (/[월화수목금토일](?:요일)?/u.test(normalized)) return true;
  return false;
}

function redactCandidateValue(value: string, path?: string | null): string {
  if (isSensitiveDiagnosticPath(path)) return "[redacted-secret]";
  const redacted = value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, "[redacted-email]")
    .replace(/\+?\d[\d\s().-]{7,}\d/gu, "[redacted-phone]")
    .replace(
      /\b(?:consumer_secret|consumer_key|webhook_secret|token|cookie|password)\s*[:=]\s*\S+/giu,
      "[redacted-secret]",
    );
  return redacted.length > 96 ? `${redacted.slice(0, 93)}...` : redacted;
}

function isSensitiveDiagnosticPath(value: string | null | undefined): boolean {
  const normalized = normalizeString(value)?.toLowerCase() ?? "";
  return /(?:consumer[_-]?secret|consumer[_-]?key|webhook[_-]?secret|access[_-]?token|refresh[_-]?token|api[_-]?key|private[_-]?key|secret|password|cookie|authorization|auth[_-]?token)/u.test(
    normalized,
  );
}

function normalizeMappingPath(value: string | null | undefined): string | null {
  const normalized =
    normalizeString(value)
      ?.toLowerCase()
      .replace(/\[\d+\]/gu, "[]")
      .replace(/[\s-]+/gu, "_") ?? null;
  if (normalized === null) return null;
  return normalized
    .replace(/^order\./u, "")
    .replace(/\.meta_data\./gu, ".meta_data.")
    .replace(/^line_items\.meta_data\./u, "line_items[].meta_data.")
    .replace(/^shipping_lines\.meta_data\./u, "shipping_lines[].meta_data.")
    .replace(/^shipping_lines\./u, "shipping_lines[].");
}

function normalizeMetaKey(value: string | null | undefined): string | null {
  return (
    normalizeString(value)
      ?.toLowerCase()
      .replace(/[\s-]+/gu, "_") ?? null
  );
}

function normalizeMetaValue(value: unknown): string | null {
  if (typeof value === "string") return normalizeString(value);
  if (
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean"
  )
    return String(value);
  return null;
}

function readWooDate(
  gmt: string | null | undefined,
  local: string | null | undefined,
): Date | null {
  const preferred = normalizeString(gmt) ?? normalizeString(local);
  if (preferred === null) return null;
  const withZone = preferred.includes("T")
    ? preferred
    : preferred.replace(" ", "T");
  const normalized = /(?:z|[+-]\d{2}:?\d{2})$/iu.test(withZone)
    ? withZone
    : `${withZone}Z`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeSiteUrl(value: string): string {
  const trimmed = value.trim();
  const withProtocol = /^https?:\/\//iu.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  const url = new URL(withProtocol);
  url.pathname = url.pathname.replace(/\/+$/u, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/u, "");
}

function normalizeString(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}
