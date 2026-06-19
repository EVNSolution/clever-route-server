import {
  redactDiagnosticPath,
  redactDiagnosticValue,
} from "../security/diagnostic-redaction.js";
import type {
  WooCommerceLineItem,
  WooCommerceMetaData,
  WooCommerceShippingLine,
} from "../woocommerce/woocommerce-order.types.js";

export const RAW_INTAKE_MESSAGE_MAX_LENGTH = 160;
export const RAW_INTAKE_METADATA_MAX_DEPTH = 3;
export const RAW_INTAKE_METADATA_MAX_KEYS = 12;
export const RAW_INTAKE_METADATA_MAX_ARRAY_ITEMS = 8;

export const RAW_INTAKE_SOURCE_LINES = {
  SHOPIFY_LEGACY: "SHOPIFY_LEGACY",
  UNKNOWN_SOURCE_LINE: "UNKNOWN_SOURCE_LINE",
  WOOCOMMERCE: "WOOCOMMERCE",
} as const;

export const RAW_INTAKE_STAGES = {
  PROCESSING: "processing",
  RAW_SHAPE: "raw_shape",
  SOURCE_LINE: "source_line",
  WOO_METADATA: "woo_metadata",
  WOO_STATUS: "woo_status",
} as const;

export const RAW_INTAKE_DECISIONS = {
  PROCESS_CANONICAL: "PROCESS_CANONICAL",
  REJECT_PRE_INGEST: "REJECT_PRE_INGEST",
  REVIEW_CANONICAL: "REVIEW_CANONICAL",
  SKIP_RAW: "SKIP_RAW",
} as const;

export const RAW_INTAKE_SEVERITIES = {
  INFO: "info",
  WARNING: "warning",
} as const;

export const RAW_INTAKE_CODES = {
  CANONICAL_DECISION_PROCESS: "CANONICAL_DECISION_PROCESS",
  PROCESSING_CANONICAL_SKIPPED: "PROCESSING_CANONICAL_SKIPPED",
  PROCESSING_STALE_SOURCE_SNAPSHOT: "PROCESSING_STALE_SOURCE_SNAPSHOT",
  RAW_SHAPE_EMPTY_LINE_ITEMS: "RAW_SHAPE_EMPTY_LINE_ITEMS",
  RAW_SHAPE_INVALID_ORDER: "RAW_SHAPE_INVALID_ORDER",
  RAW_SHAPE_MISSING_ORDER_ID: "RAW_SHAPE_MISSING_ORDER_ID",
  SOURCE_LINE_SHOPIFY_LEGACY_BYPASS: "SOURCE_LINE_SHOPIFY_LEGACY_BYPASS",
  SOURCE_LINE_TRUSTED_SIGNAL_CONFLICT: "SOURCE_LINE_TRUSTED_SIGNAL_CONFLICT",
  SOURCE_LINE_UNKNOWN: "SOURCE_LINE_UNKNOWN",
  WOO_METADATA_MISSING_DELIVERY_SCOPE: "WOO_METADATA_MISSING_DELIVERY_SCOPE",
  WOO_STATUS_AUTO_DRAFT: "WOO_STATUS_AUTO_DRAFT",
  WOO_STATUS_CANCELLED: "WOO_STATUS_CANCELLED",
  WOO_STATUS_CHECKOUT_DRAFT: "WOO_STATUS_CHECKOUT_DRAFT",
  WOO_STATUS_DRAFT: "WOO_STATUS_DRAFT",
  WOO_STATUS_FAILED: "WOO_STATUS_FAILED",
  WOO_STATUS_REFUNDED: "WOO_STATUS_REFUNDED",
  WOO_STATUS_TRASH: "WOO_STATUS_TRASH",
} as const;

const WOO_HARD_SKIP_STATUS_CODES: Readonly<Record<string, RawIntakeCode>> = {
  "auto-draft": RAW_INTAKE_CODES.WOO_STATUS_AUTO_DRAFT,
  cancelled: RAW_INTAKE_CODES.WOO_STATUS_CANCELLED,
  "checkout-draft": RAW_INTAKE_CODES.WOO_STATUS_CHECKOUT_DRAFT,
  draft: RAW_INTAKE_CODES.WOO_STATUS_DRAFT,
  failed: RAW_INTAKE_CODES.WOO_STATUS_FAILED,
  refunded: RAW_INTAKE_CODES.WOO_STATUS_REFUNDED,
  trash: RAW_INTAKE_CODES.WOO_STATUS_TRASH,
};

const DELIVERY_METADATA_KEYS = new Set([
  "delivery date",
  "delivery_date",
  "deliverydate",
  "tomatono_delivery_date",
  "_tomatono_delivery_date",
  "_delivery_date",
  "order_delivery_date",
  "jckwds_date",
  "delivery day",
  "delivery_day",
  "deliveryday",
  "tomatono_delivery_day",
  "_tomatono_delivery_day",
  "_delivery_day",
  "order_delivery_day",
  "jckwds_timeslot",
  "delivery time",
  "delivery_time",
  "delivery timeslot",
  "delivery_timeslot",
  "time_slot",
  "timeslot",
]);

export type RawIntakeSourceLine =
  (typeof RAW_INTAKE_SOURCE_LINES)[keyof typeof RAW_INTAKE_SOURCE_LINES];
export type RawIntakeStage =
  (typeof RAW_INTAKE_STAGES)[keyof typeof RAW_INTAKE_STAGES];
export type RawIntakeDecisionKind =
  (typeof RAW_INTAKE_DECISIONS)[keyof typeof RAW_INTAKE_DECISIONS];
export type RawIntakeSeverity =
  (typeof RAW_INTAKE_SEVERITIES)[keyof typeof RAW_INTAKE_SEVERITIES];
export type RawIntakeCode =
  (typeof RAW_INTAKE_CODES)[keyof typeof RAW_INTAKE_CODES];

export type RawIntakeTrustedSignal =
  | "SHOPIFY_LEGACY"
  | "UNKNOWN"
  | "WOOCOMMERCE";

export type RawIntakeSourceContext = {
  connectionPlatform?: RawIntakeTrustedSignal | null;
  routeSource?:
    | "shopify_legacy"
    | "unknown"
    | "woocommerce_rest"
    | "wordpress_plugin_raw_push"
    | null;
};

export type RawIntakeSourceClassification = {
  reason: string;
  sourceLine: RawIntakeSourceLine;
  trustedSignalCount: number;
};

export type RawIntakeDecision = {
  code: RawIntakeCode;
  decision: RawIntakeDecisionKind;
  message: string;
  metadata: Record<string, unknown>;
  severity: RawIntakeSeverity;
  sourceLine: RawIntakeSourceLine;
  stage: RawIntakeStage;
};

export function classifyRawIntakeSource(input: {
  context?: RawIntakeSourceContext;
  rawPayload?: unknown;
}): RawIntakeSourceClassification {
  const trustedSignals = collectTrustedSignals(input.context);
  const distinctTrusted = new Set(trustedSignals);
  if (distinctTrusted.size > 1) {
    return {
      reason: "conflicting_trusted_source_signals",
      sourceLine: RAW_INTAKE_SOURCE_LINES.UNKNOWN_SOURCE_LINE,
      trustedSignalCount: trustedSignals.length,
    };
  }

  const trusted = trustedSignals[0];
  if (trusted !== undefined) {
    return {
      reason: "trusted_source_context",
      sourceLine: trusted,
      trustedSignalCount: trustedSignals.length,
    };
  }

  const payload = objectOrNull(input.rawPayload);
  if (payload !== null && looksLikeWooOrder(payload)) {
    return {
      reason: "payload_shape_woocommerce",
      sourceLine: RAW_INTAKE_SOURCE_LINES.WOOCOMMERCE,
      trustedSignalCount: 0,
    };
  }
  if (payload !== null && looksLikeShopifyOrder(payload)) {
    return {
      reason: "payload_shape_shopify_legacy",
      sourceLine: RAW_INTAKE_SOURCE_LINES.SHOPIFY_LEGACY,
      trustedSignalCount: 0,
    };
  }

  return {
    reason: "no_trusted_or_known_payload_shape",
    sourceLine: RAW_INTAKE_SOURCE_LINES.UNKNOWN_SOURCE_LINE,
    trustedSignalCount: 0,
  };
}

export function decideRawOrderIntake(input: {
  context?: RawIntakeSourceContext;
  rawPayload: unknown;
}): RawIntakeDecision {
  const classification = classifyRawIntakeSource({
    ...(input.context === undefined ? {} : { context: input.context }),
    rawPayload: input.rawPayload,
  });
  if (
    classification.sourceLine === RAW_INTAKE_SOURCE_LINES.UNKNOWN_SOURCE_LINE
  ) {
    return makeDecision({
      code:
        classification.reason === "conflicting_trusted_source_signals"
          ? RAW_INTAKE_CODES.SOURCE_LINE_TRUSTED_SIGNAL_CONFLICT
          : RAW_INTAKE_CODES.SOURCE_LINE_UNKNOWN,
      decision: RAW_INTAKE_DECISIONS.REJECT_PRE_INGEST,
      message:
        "Order source line could not be trusted; canonical import was not attempted.",
      metadata: { reason: classification.reason },
      severity: RAW_INTAKE_SEVERITIES.WARNING,
      sourceLine: RAW_INTAKE_SOURCE_LINES.UNKNOWN_SOURCE_LINE,
      stage: RAW_INTAKE_STAGES.SOURCE_LINE,
    });
  }

  if (classification.sourceLine === RAW_INTAKE_SOURCE_LINES.SHOPIFY_LEGACY) {
    return makeDecision({
      code: RAW_INTAKE_CODES.SOURCE_LINE_SHOPIFY_LEGACY_BYPASS,
      decision: RAW_INTAKE_DECISIONS.PROCESS_CANONICAL,
      message: "Shopify legacy input bypassed WooCommerce-only raw filters.",
      metadata: { reason: classification.reason },
      severity: RAW_INTAKE_SEVERITIES.INFO,
      sourceLine: RAW_INTAKE_SOURCE_LINES.SHOPIFY_LEGACY,
      stage: RAW_INTAKE_STAGES.SOURCE_LINE,
    });
  }

  return decideWooRawOrder(input.rawPayload, classification);
}

export function decideWooRawOrder(
  rawPayload: unknown,
  classification: RawIntakeSourceClassification = {
    reason: "trusted_source_context",
    sourceLine: RAW_INTAKE_SOURCE_LINES.WOOCOMMERCE,
    trustedSignalCount: 1,
  },
): RawIntakeDecision {
  const order = objectOrNull(rawPayload);
  if (order === null) {
    return makeDecision({
      code: RAW_INTAKE_CODES.RAW_SHAPE_INVALID_ORDER,
      decision: RAW_INTAKE_DECISIONS.REJECT_PRE_INGEST,
      message:
        "WooCommerce raw order payload was not an object; canonical import was not attempted.",
      metadata: {
        classificationReason: classification.reason,
        payloadType: typeof rawPayload,
      },
      severity: RAW_INTAKE_SEVERITIES.WARNING,
      sourceLine: RAW_INTAKE_SOURCE_LINES.WOOCOMMERCE,
      stage: RAW_INTAKE_STAGES.RAW_SHAPE,
    });
  }

  const sourceOrderId = readWooOrderId(order);
  if (sourceOrderId === null) {
    return makeDecision({
      code: RAW_INTAKE_CODES.RAW_SHAPE_MISSING_ORDER_ID,
      decision: RAW_INTAKE_DECISIONS.REJECT_PRE_INGEST,
      message:
        "WooCommerce raw order did not include a source order id; canonical import was not attempted.",
      metadata: {
        classificationReason: classification.reason,
        keys: Object.keys(order).slice(0, RAW_INTAKE_METADATA_MAX_ARRAY_ITEMS),
      },
      severity: RAW_INTAKE_SEVERITIES.WARNING,
      sourceLine: RAW_INTAKE_SOURCE_LINES.WOOCOMMERCE,
      stage: RAW_INTAKE_STAGES.RAW_SHAPE,
    });
  }

  const status = readWooStatus(order);
  const hardSkipCode =
    status === null ? undefined : WOO_HARD_SKIP_STATUS_CODES[status];
  if (hardSkipCode !== undefined) {
    return makeDecision({
      code: hardSkipCode,
      decision: RAW_INTAKE_DECISIONS.SKIP_RAW,
      message: `WooCommerce order ${sourceOrderId} has status ${status}; canonical import was skipped.`,
      metadata: {
        classificationReason: classification.reason,
        sourceOrderId,
        status,
      },
      severity: RAW_INTAKE_SEVERITIES.INFO,
      sourceLine: RAW_INTAKE_SOURCE_LINES.WOOCOMMERCE,
      stage: RAW_INTAKE_STAGES.WOO_STATUS,
    });
  }

  if (!hasNonEmptyLineItems(order.line_items)) {
    return makeDecision({
      code: RAW_INTAKE_CODES.RAW_SHAPE_EMPTY_LINE_ITEMS,
      decision: RAW_INTAKE_DECISIONS.SKIP_RAW,
      message: `WooCommerce order ${sourceOrderId} has no line items; canonical import was skipped.`,
      metadata: {
        classificationReason: classification.reason,
        sourceOrderId,
        status,
      },
      severity: RAW_INTAKE_SEVERITIES.WARNING,
      sourceLine: RAW_INTAKE_SOURCE_LINES.WOOCOMMERCE,
      stage: RAW_INTAKE_STAGES.RAW_SHAPE,
    });
  }

  if (!hasWooDeliveryMetadata(order)) {
    return makeDecision({
      code: RAW_INTAKE_CODES.WOO_METADATA_MISSING_DELIVERY_SCOPE,
      decision: RAW_INTAKE_DECISIONS.REVIEW_CANONICAL,
      message: `WooCommerce order ${sourceOrderId} is active but has no delivery metadata; import as review only.`,
      metadata: {
        classificationReason: classification.reason,
        sourceOrderId,
        status,
      },
      severity: RAW_INTAKE_SEVERITIES.WARNING,
      sourceLine: RAW_INTAKE_SOURCE_LINES.WOOCOMMERCE,
      stage: RAW_INTAKE_STAGES.WOO_METADATA,
    });
  }

  return makeDecision({
    code: RAW_INTAKE_CODES.CANONICAL_DECISION_PROCESS,
    decision: RAW_INTAKE_DECISIONS.PROCESS_CANONICAL,
    message: `WooCommerce order ${sourceOrderId} passed raw intake guard.`,
    metadata: {
      classificationReason: classification.reason,
      sourceOrderId,
      status,
    },
    severity: RAW_INTAKE_SEVERITIES.INFO,
    sourceLine: RAW_INTAKE_SOURCE_LINES.WOOCOMMERCE,
    stage: RAW_INTAKE_STAGES.WOO_METADATA,
  });
}

export function sanitizeRawIntakeMessage(message: string): string {
  const redacted = redactDiagnosticValue(message, null) ?? "";
  return redacted.length > RAW_INTAKE_MESSAGE_MAX_LENGTH
    ? `${redacted.slice(0, RAW_INTAKE_MESSAGE_MAX_LENGTH - 3)}...`
    : redacted;
}

export function sanitizeRawIntakeMetadata(
  value: unknown,
): Record<string, unknown> {
  const sanitized = sanitizeMetadataValue(value, 0);
  return objectOrNull(sanitized) ?? {};
}

function makeDecision(input: RawIntakeDecision): RawIntakeDecision {
  return {
    ...input,
    message: sanitizeRawIntakeMessage(input.message),
    metadata: sanitizeRawIntakeMetadata(input.metadata),
  };
}

function collectTrustedSignals(
  context: RawIntakeSourceContext | undefined,
): RawIntakeSourceLine[] {
  if (context === undefined) return [];
  const signals: RawIntakeSourceLine[] = [];
  if (
    context.routeSource === "wordpress_plugin_raw_push" ||
    context.routeSource === "woocommerce_rest"
  ) {
    signals.push(RAW_INTAKE_SOURCE_LINES.WOOCOMMERCE);
  } else if (context.routeSource === "shopify_legacy") {
    signals.push(RAW_INTAKE_SOURCE_LINES.SHOPIFY_LEGACY);
  } else if (context.routeSource === "unknown") {
    signals.push(RAW_INTAKE_SOURCE_LINES.UNKNOWN_SOURCE_LINE);
  }
  if (context.connectionPlatform === "WOOCOMMERCE")
    signals.push(RAW_INTAKE_SOURCE_LINES.WOOCOMMERCE);
  else if (context.connectionPlatform === "SHOPIFY_LEGACY")
    signals.push(RAW_INTAKE_SOURCE_LINES.SHOPIFY_LEGACY);
  else if (context.connectionPlatform === "UNKNOWN")
    signals.push(RAW_INTAKE_SOURCE_LINES.UNKNOWN_SOURCE_LINE);
  return signals;
}

function looksLikeWooOrder(payload: Record<string, unknown>): boolean {
  return (
    "line_items" in payload &&
    ("status" in payload ||
      "number" in payload ||
      "date_modified_gmt" in payload)
  );
}

function looksLikeShopifyOrder(payload: Record<string, unknown>): boolean {
  return (
    "admin_graphql_api_id" in payload ||
    "shopifyOrderGid" in payload ||
    ("shipping_address" in payload && "line_items" in payload)
  );
}

function readWooOrderId(payload: Record<string, unknown>): string | null {
  const id = payload.id;
  if (typeof id === "number" && Number.isFinite(id)) return String(id);
  if (typeof id === "string" && id.trim() !== "") return id.trim();
  return null;
}

function readWooStatus(payload: Record<string, unknown>): string | null {
  const status = payload.status;
  return typeof status === "string" && status.trim() !== ""
    ? status.trim().toLowerCase()
    : null;
}

function hasNonEmptyLineItems(value: unknown): value is WooCommerceLineItem[] {
  return Array.isArray(value) && value.length > 0;
}

function hasWooDeliveryMetadata(order: Record<string, unknown>): boolean {
  return (
    metadataListHasDeliveryValue(order.meta_data) ||
    lineItemsHaveDeliveryValue(order.line_items) ||
    shippingLinesHaveDeliveryValue(order.shipping_lines)
  );
}

function lineItemsHaveDeliveryValue(items: unknown): boolean {
  return (
    Array.isArray(items) &&
    items.some((item: WooCommerceLineItem) =>
      metadataListHasDeliveryValue(item.meta_data),
    )
  );
}

function shippingLinesHaveDeliveryValue(lines: unknown): boolean {
  return (
    Array.isArray(lines) &&
    lines.some((line: WooCommerceShippingLine) =>
      metadataListHasDeliveryValue(line.meta_data),
    )
  );
}

function metadataListHasDeliveryValue(items: unknown): boolean {
  if (!Array.isArray(items)) return false;
  return items.some((item: WooCommerceMetaData) => {
    const key = normalizeMetadataKey(item.key);
    if (key === null || !DELIVERY_METADATA_KEYS.has(key)) return false;
    if (item.value === null || item.value === undefined) return false;
    if (typeof item.value === "string") return item.value.trim() !== "";
    return typeof item.value === "number" || typeof item.value === "boolean";
  });
}

function normalizeMetadataKey(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^_+|_+$/gu, "");
  return normalized === "" ? null : normalized;
}

function sanitizeMetadataValue(value: unknown, depth: number): unknown {
  if (depth >= RAW_INTAKE_METADATA_MAX_DEPTH) return "[truncated-depth]";
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return redactDiagnosticValue(value, null);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const items = value
      .slice(0, RAW_INTAKE_METADATA_MAX_ARRAY_ITEMS)
      .map((item) => sanitizeMetadataValue(item, depth + 1));
    if (value.length > RAW_INTAKE_METADATA_MAX_ARRAY_ITEMS)
      items.push("[truncated-array]");
    return items;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.entries(record).slice(
      0,
      RAW_INTAKE_METADATA_MAX_KEYS,
    );
    const sanitized: Record<string, unknown> = {};
    for (const [key, item] of entries) {
      const safeKey = redactDiagnosticPath(key);
      sanitized[safeKey] =
        safeKey === "[redacted-sensitive-path]"
          ? "[redacted-secret]"
          : sanitizeMetadataValue(item, depth + 1);
    }
    if (Object.keys(record).length > RAW_INTAKE_METADATA_MAX_KEYS) {
      sanitized.__truncated = true;
    }
    return sanitized;
  }
  return `[${typeof value}]`;
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
