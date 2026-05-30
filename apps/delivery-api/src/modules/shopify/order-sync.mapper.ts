import type {
  DeliveryDateSource,
  DeliverySession,
} from "./order-delivery-scope.js";
import { calculateDeliveryScope } from "./order-delivery-scope.js";

export type ShopifyOrderAttribute = {
  key: string;
  value: string;
};

export type ShopifyOrderLineItem = {
  name?: string | null;
  quantity?: number | null;
  sku?: string | null;
  title: string | null;
  variantTitle?: string | null;
};

export type ShopifyOrderNode = {
  cancelledAt?: string | null;
  createdAt?: string | null;
  currentTotalPriceSet: {
    shopMoney: {
      amount: string;
      currencyCode: string;
    };
  } | null;
  customAttributes?: ShopifyOrderAttribute[] | null;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
  email: string | null;
  id: string;
  legacyResourceId: string;
  lineItems?:
    | {
        edges?: Array<{ node: ShopifyOrderLineItem }> | null;
        nodes?: ShopifyOrderLineItem[] | null;
      }
    | null
    | undefined;
  name: string;
  note?: string | null;
  phone: string | null;
  processedAt: string | null;
  shippingAddress: ShopifyShippingAddress | null;
  updatedAt: string;
};

type ShopifyShippingAddress = {
  address1: string | null;
  address2: string | null;
  city: string | null;
  countryCodeV2: string | null;
  latitude: number | null;
  longitude: number | null;
  name: string | null;
  phone: string | null;
  province: string | null;
  provinceCode?: string | null;
  zip: string | null;
};

export type DeliveryWeekday =
  | "SUNDAY"
  | "MONDAY"
  | "TUESDAY"
  | "WEDNESDAY"
  | "THURSDAY"
  | "FRIDAY"
  | "SATURDAY";
export type DeliveryServiceType = "DELIVERY" | "EVENING_DELIVERY" | "PICKUP";
export type CanonicalOrderReadiness =
  | "READY_TO_PLAN"
  | "NEEDS_REVIEW"
  | "SKIPPED";
export type CommerceSourcePlatform = "SHOPIFY" | "WOOCOMMERCE";
export type DeliveryDayParseStatus =
  | "NOT_PROVIDED"
  | "PARSED"
  | "UNPARSED"
  | "UNVERIFIED";
export type PlanningStatus = "UNPLANNED" | "PLANNED";

export type DeliveryMetadataDiagnostics = {
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

export type CanonicalOrderRow = {
  cancelledAt: string | null;
  currencyCode: string | null;
  deliveryArea: string | null;
  deliveryBatchEndDate: string | null;
  deliveryBatchStartDate: string | null;
  deliveryDate: string | null;
  deliveryDateSource: DeliveryDateSource | null;
  deliveryDayRaw: string | null;
  deliverySession: string | null;
  deliveryMetadataDiagnostics?: DeliveryMetadataDiagnostics | null;
  deliveryStopId: string | null;
  deliveryStopStatus: string | null;
  deliveryWeekday: DeliveryWeekday | null;
  email: string | null;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  geocodeStatus: "PENDING" | "RESOLVED" | "FAILED" | "NOT_REQUIRED";
  hasCoordinates: boolean;
  latitude: number | null;
  longitude: number | null;
  name: string;
  orderCreatedAt: string | null;
  orderDateLocal: string | null;
  metadataResolved?: boolean;
  orderId: string;
  phone: string | null;
  pickup: boolean;
  planningGroupKey: string | null;
  planningStatus: PlanningStatus;
  processedAt: string | null;
  readiness: CanonicalOrderReadiness;
  recipientName: string | null;
  reviewReasons: string[];
  routePlanId: string | null;
  routePlanName: string | null;
  routeEligible?: boolean;
  routePlanStatus: string | null;
  routeScopeKey: string | null;
  serviceType: string | null;
  shippingAddress: {
    address1: string | null;
    address2: string | null;
    city: string | null;
    countryCode: string | null;
    postalCode: string | null;
    province: string | null;
  };
  shopifyOrderGid: string;
  shopifyOrderLegacyId: string | null;
  sourceOrderId?: string | null;
  sourceOrderNumber?: string | null;
  sourcePlatform?: CommerceSourcePlatform;
  sourceSiteUrl?: string | null;
  sourceUpdatedAt?: string | null;
  timeWindowEnd: string | null;
  timeWindowStart: string | null;
  totalPriceAmount: string | null;
  updatedAtShopify: string | null;
};

export type SyncedOrderInput = {
  cancelledAt: Date | null;
  currencyCode: string | null;
  deliveryArea: string | null;
  deliveryBatchEndDate: string | null;
  deliveryBatchStartDate: string | null;
  deliveryDate: string | null;
  deliveryDateSource: DeliveryDateSource | null;
  deliveryDayRaw: string | null;
  deliverySession: DeliverySession | null;
  deliveryWeekday: DeliveryWeekday | null;
  email: string | null;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  name: string;
  orderCreatedAt: string | null;
  orderDateLocal: string | null;
  phone: string | null;
  pickup: boolean;
  planningGroupKey: string | null;
  processedAt: Date | null;
  rawPayload: Record<string, unknown>;
  readiness: CanonicalOrderReadiness;
  reviewReasons: string[];
  routeScopeKey: string | null;
  serviceType: DeliveryServiceType | null;
  shopifyOrderGid: string;
  shopifyOrderLegacyId: bigint | null;
  sourceOrderId?: string | null;
  sourceOrderNumber?: string | null;
  sourcePlatform?: CommerceSourcePlatform;
  sourceSiteUrl?: string | null;
  sourceUpdatedAt?: Date | null;
  timeWindowEnd: string | null;
  timeWindowStart: string | null;
  totalPriceAmount: string | null;
  updatedAtShopify: Date;
};

export type SyncedDeliveryStopInput = {
  address1: string | null;
  address2: string | null;
  city: string | null;
  countryCode: string | null;
  deliveryDate: string | null;
  geocodeStatus: "PENDING" | "RESOLVED";
  instructions: string | null;
  timeWindowEnd: string | null;
  timeWindowStart: string | null;
  latitude: string | null;
  longitude: string | null;
  phone: string | null;
  postalCode: string | null;
  province: string | null;
  recipientName: string | null;
};

export type SyncedOrderDeliveryFactInput = {
  batchEligible: boolean;
  commerceConnectionId?: string | null;
  computedAt?: Date | null;
  deliveryArea: string | null;
  deliveryDate: string | null;
  deliveryDateWeekday: DeliveryWeekday | null;
  deliveryDateWeekdayMismatch: boolean;
  deliveryDateWeekdayVerified: boolean;
  deliveryDayParseStatus: DeliveryDayParseStatus;
  deliveryDayUnparsedReason: string | null;
  deliverySession: DeliverySession | null;
  deliveryWeekday: DeliveryWeekday | null;
  geocodeStatus: "PENDING" | "RESOLVED" | "FAILED" | "NOT_REQUIRED";
  mappingDiagnostics?: Record<string, unknown> | null;
  matchedMappingPaths: Record<string, string | null>;
  planningGroupKey: string | null;
  rawDeliveryArea: string | null;
  rawDeliveryDate: string | null;
  rawDeliveryDay: string | null;
  rawDeliveryTimeWindow: string | null;
  rawPickupDay: string | null;
  readiness: CanonicalOrderReadiness;
  reviewReasons: string[];
  routeScopeKey: string | null;
  serviceType: DeliveryServiceType | null;
  sourceOrderId: string | null;
  sourceOrderNumber: string | null;
  sourcePlatform: CommerceSourcePlatform;
  sourceSiteUrl: string | null;
  sourceUpdatedAt: Date | null;
  timeWindowEnd: string | null;
  timeWindowStart: string | null;
};

export type SyncedOrderWithDeliveryStopInput = {
  deliveryFact?: SyncedOrderDeliveryFactInput | null;
  deliveryStop: SyncedDeliveryStopInput | null;
  order: SyncedOrderInput;
};

export function mapShopifyOrderNodeToDeliveryInputs(
  node: ShopifyOrderNode,
): SyncedOrderWithDeliveryStopInput {
  const attributes = normalizeAttributes(node.customAttributes ?? []);
  const deliveryArea = readAttribute(attributes, "Delivery Area");
  const deliveryDateRaw = readDeliveryDateAttribute(attributes);
  const deliveryDayRaw = readAttribute(attributes, "Delivery Day");
  const pickupDay = readAttribute(attributes, "Pickup Day");
  const pickup = pickupDay !== null;
  const canonicalDayRaw = deliveryDayRaw ?? pickupDay;
  const lineItems = normalizeLineItems(node.lineItems);
  const scope = calculateDeliveryScope({
    createdAt: node.createdAt ?? null,
    deliveryArea,
    deliveryDateRaw,
    deliveryDayRaw,
    lineItems,
    pickupDayRaw: pickupDay,
    processedAt: node.processedAt,
  });
  const hasShippingAddress =
    node.shippingAddress !== null && hasAddress(node.shippingAddress);
  const hasCoordinates =
    node.shippingAddress?.latitude !== null &&
    node.shippingAddress?.latitude !== undefined &&
    node.shippingAddress.longitude !== null &&
    node.shippingAddress.longitude !== undefined;
  const cancelledAt = parseOptionalDate(node.cancelledAt ?? null);
  const reviewReasons = buildReviewReasons({
    cancelledAt,
    deliveryArea,
    deliveryDate: scope.deliveryDate,
    deliveryDateSource: scope.deliveryDateSource,
    deliveryDayRaw: canonicalDayRaw,
    hasCoordinates,
    hasShippingAddress,
    orderCreatedAt: scope.orderCreatedAt,
    routeScopeKey: scope.routeScopeKey,
    serviceType: scope.serviceType,
    deliveryWeekday: scope.deliveryWeekday,
  });
  const readiness: CanonicalOrderReadiness =
    cancelledAt !== null ||
    scope.deliveryDate === null ||
    scope.routeScopeKey === null ||
    reviewReasons.length > 0
      ? "NEEDS_REVIEW"
      : "READY_TO_PLAN";

  return {
    deliveryStop:
      node.shippingAddress === null
        ? null
        : mapShippingAddressToDeliveryStop(
            node.shippingAddress,
            node.note ?? null,
            hasCoordinates,
            scope.deliveryDate,
            scope.timeWindowStart,
            scope.timeWindowEnd,
          ),
    order: {
      cancelledAt,
      currencyCode: node.currentTotalPriceSet?.shopMoney.currencyCode ?? null,
      deliveryArea,
      deliveryBatchEndDate: scope.deliveryBatchEndDate,
      deliveryBatchStartDate: scope.deliveryBatchStartDate,
      deliveryDate: scope.deliveryDate,
      deliveryDateSource: scope.deliveryDateSource,
      deliveryDayRaw: canonicalDayRaw,
      deliverySession: scope.deliverySession,
      deliveryWeekday: scope.deliveryWeekday,
      email: node.email,
      financialStatus: node.displayFinancialStatus,
      fulfillmentStatus: node.displayFulfillmentStatus,
      name: node.name,
      orderCreatedAt: scope.orderCreatedAt,
      orderDateLocal: scope.orderDateLocal,
      phone: node.phone,
      pickup,
      planningGroupKey: scope.planningGroupKey,
      processedAt: parseOptionalDate(node.processedAt),
      rawPayload: {
        ...node,
        attributes,
        deliveryArea,
        deliveryBatchEndDate: scope.deliveryBatchEndDate,
        deliveryBatchStartDate: scope.deliveryBatchStartDate,
        deliveryDateRaw,
        deliveryDate: scope.deliveryDate,
        deliveryDateSource: scope.deliveryDateSource,
        deliveryDayRaw: canonicalDayRaw,
        deliverySession: scope.deliverySession,
        deliveryWeekday: scope.deliveryWeekday,
        lineItems,
        orderCreatedAt: scope.orderCreatedAt,
        orderDateLocal: scope.orderDateLocal,
        pickup,
        pickupDayRaw: pickupDay,
        planningGroupKey: scope.planningGroupKey,
        readiness,
        reviewReasons,
        routeScopeKey: scope.routeScopeKey,
        serviceType: scope.serviceType,
        timeWindowEnd: scope.timeWindowEnd,
        timeWindowStart: scope.timeWindowStart,
      },
      readiness,
      reviewReasons,
      routeScopeKey: scope.routeScopeKey,
      serviceType: scope.serviceType,
      shopifyOrderGid: node.id,
      shopifyOrderLegacyId: parseLegacyResourceId(node.legacyResourceId),
      sourceOrderId: node.id,
      sourceOrderNumber: node.name,
      sourcePlatform: "SHOPIFY",
      sourceSiteUrl: null,
      sourceUpdatedAt: parseRequiredDate(node.updatedAt),
      timeWindowEnd: scope.timeWindowEnd,
      timeWindowStart: scope.timeWindowStart,
      totalPriceAmount: node.currentTotalPriceSet?.shopMoney.amount ?? null,
      updatedAtShopify: parseRequiredDate(node.updatedAt),
    },
  };
}

function mapShippingAddressToDeliveryStop(
  address: ShopifyShippingAddress,
  note: string | null,
  hasCoordinates: boolean,
  deliveryDate: string | null,
  timeWindowStart: string | null,
  timeWindowEnd: string | null,
): SyncedDeliveryStopInput {
  return {
    address1: address.address1,
    address2: address.address2,
    city: address.city,
    countryCode: address.countryCodeV2,
    deliveryDate,
    geocodeStatus: hasCoordinates ? "RESOLVED" : "PENDING",
    instructions: normalizeOptionalString(note),
    latitude: address.latitude === null ? null : String(address.latitude),
    longitude: address.longitude === null ? null : String(address.longitude),
    phone: address.phone,
    postalCode: address.zip,
    province: address.province,
    recipientName: address.name,
    timeWindowEnd,
    timeWindowStart,
  };
}

function buildReviewReasons(input: {
  cancelledAt: Date | null;
  deliveryArea: string | null;
  deliveryDate: string | null;
  deliveryDateSource: DeliveryDateSource;
  deliveryDayRaw: string | null;
  deliveryWeekday: DeliveryWeekday | null;
  hasCoordinates: boolean;
  hasShippingAddress: boolean;
  orderCreatedAt: string | null;
  routeScopeKey: string | null;
  serviceType: DeliveryServiceType | null;
}): string[] {
  const reasons: string[] = [];
  if (!input.hasShippingAddress) reasons.push("missing_address");
  if (input.deliveryArea === null) reasons.push("missing_delivery_area");
  if (input.deliveryDayRaw === null && input.deliveryDate === null)
    reasons.push("missing_delivery_day");
  if (
    input.deliveryDayRaw !== null &&
    (input.deliveryWeekday === null || input.serviceType === null)
  ) {
    reasons.push("delivery_day_parse_failed");
  }
  if (
    input.orderCreatedAt === null &&
    input.deliveryDateSource !== "EXPLICIT_ATTRIBUTE"
  )
    reasons.push("missing_order_date");
  if (input.deliveryDate === null) {
    reasons.push(
      input.deliveryDateSource === "MISSING"
        ? "missing_delivery_date"
        : "delivery_date_parse_failed",
    );
  }
  if (input.routeScopeKey === null) reasons.push("missing_route_scope");
  if (!input.hasCoordinates) reasons.push("missing_coordinates");
  if (input.cancelledAt !== null) reasons.push("cancelled_order");
  return reasons;
}

function normalizeLineItems(
  value: ShopifyOrderNode["lineItems"],
): ShopifyOrderLineItem[] {
  const nodes = value?.nodes ?? null;
  if (Array.isArray(nodes)) return nodes.map(normalizeLineItem);
  const edges = value?.edges ?? null;
  if (Array.isArray(edges))
    return edges.map((edge) => normalizeLineItem(edge.node));
  return [];
}

function normalizeLineItem(value: ShopifyOrderLineItem): ShopifyOrderLineItem {
  return {
    name: normalizeOptionalString(value.name),
    quantity:
      typeof value.quantity === "number" && Number.isFinite(value.quantity)
        ? value.quantity
        : null,
    sku: normalizeOptionalString(value.sku),
    title: normalizeOptionalString(value.title),
    variantTitle: normalizeOptionalString(value.variantTitle),
  };
}

function hasAddress(address: ShopifyShippingAddress): boolean {
  return [
    address.address1,
    address.city,
    address.zip,
    address.countryCodeV2,
  ].some((value) => normalizeOptionalString(value) !== null);
}

function normalizeAttributes(
  value: ShopifyOrderAttribute[],
): ShopifyOrderAttribute[] {
  return value.flatMap((attribute) => {
    const key = normalizeOptionalString(attribute.key);
    const attributeValue = normalizeOptionalString(attribute.value);
    if (key === null || attributeValue === null) {
      return [];
    }
    return [{ key, value: attributeValue }];
  });
}

function readAttribute(
  attributes: ShopifyOrderAttribute[],
  key: string,
): string | null {
  return (
    attributes.find(
      (attribute) => attribute.key.toLowerCase() === key.toLowerCase(),
    )?.value ?? null
  );
}

function readDeliveryDateAttribute(
  attributes: ShopifyOrderAttribute[],
): string | null {
  return (
    readAttribute(attributes, "Delivery Date") ??
    readAttribute(attributes, "deliveryDate") ??
    readAttribute(attributes, "delivery_date") ??
    readAttribute(attributes, "tomatono_delivery_date")
  );
}

function normalizeOptionalString(
  value: string | null | undefined,
): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function parseLegacyResourceId(value: string): bigint | null {
  if (!/^\d+$/u.test(value)) {
    return null;
  }

  return BigInt(value);
}

function parseOptionalDate(value: string | null): Date | null {
  if (value === null) {
    return null;
  }

  return parseRequiredDate(value);
}

function parseRequiredDate(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid Shopify order timestamp: ${value}`);
  }

  return date;
}
